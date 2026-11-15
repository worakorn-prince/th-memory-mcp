// Ph-6 B4 — graph scope isolation (entity / relation / memory_link) and trust
// propagation into derived memories.
//
// Fixtures are written in legacy mode; every tool call runs under an explicitly
// bound identity (bindScopeToIdentity + runWithScope) with the real handlers,
// matching test/scope_adversarial.test.mjs. Each case asserts the tool output
// AND the stored rows, so a leak cannot hide behind a formatting change.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";

const workDir = mkdtempSync(join(tmpdir(), "th-p6-graph-scope-"));
const dbPath = join(workDir, "graph-scope.db");

process.env.MEMORY_DB_PATH = dbPath;
process.env.MEMORY_BACKUP_ON_MIGRATE = "0";
delete process.env.MEMORY_ENCRYPTION;
delete process.env.MEMORY_ENCRYPTION_KEY;
delete process.env.MEMORY_AUTH;
delete process.env.MEMORY_AUTH_TOKEN;
delete process.env.MEMORY_AUTH_TOKEN_FILE;

const { db, upsertEmbedding } = await import("../dist/db/index.js");
const { embed } = await import("../dist/lib/embed.js");
const { isUntrustedMetadata } = await import("../dist/lib/memory-format.js");
const { ensureUser } = await import("../dist/db/repositories/users.js");
const { createMemory, getMemoryById } = await import(
  "../dist/db/repositories/memories.js"
);
const { createEntity, addRelation, linkMemories } = await import(
  "../dist/core/graph-engine.js"
);
const { setIdentity } = await import("../dist/auth/identity.js");
const { bindScopeToIdentity, runWithScope } = await import(
  "../dist/auth/scope-resolver.js"
);
const { contextHandler } = await import("../dist/tools/context.js");
const { consolidateHandler } = await import("../dist/tools/consolidate.js");
const { linkMemoryHandler } = await import("../dist/tools/link_memory.js");

const aliceUid = ensureUser("alice");
const bobUid = ensureUser("bob");

const ALICE = { mode: "enforced", userId: "alice", uid: aliceUid, roles: ["owner"] };
const BOB = { mode: "enforced", userId: "bob", uid: bobUid, roles: ["owner"] };

const textOf = (r) => (r?.content ?? []).map((c) => c.text).join("\n");
const maxMemoryId = () =>
  db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM memories").get().n;

function runAs(identity, tool, args, fn) {
  setIdentity(identity);
  const bound = bindScopeToIdentity(identity, args, tool);
  assert.equal(bound.ok, true, `bind ${tool} failed: ${JSON.stringify(bound)}`);
  return runWithScope(bound.scope, fn);
}

after(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  rmSync(workDir, { recursive: true, force: true });
});

/** Drop every memory/graph row so each case starts from a known cluster set. */
function resetRows() {
  const wipe = db.transaction(() => {
    for (const table of [
      "memory_links",
      "relations",
      "entities",
      "memories",
      "embeddings",
      "search_index_keys",
      "search_index",
      "search_index_loose",
    ]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
  });
  wipe();
}

/** Insert a memory the way a pre-redaction/importer writer would (raw SQL). */
function insertRawMemory({ content, metadata, userId }) {
  const now = new Date().toISOString();
  const id = Number(
    db
      .prepare(
        `INSERT INTO memories (type, content, status, source, confidence, importance, salience,
           user_id, scope, created_at, updated_at, metadata)
         VALUES ('FACT', ?, 'active', 'imported', 0.5, 0.5, 0.5, ?, 'USER', ?, ?, ?)`
      )
      .run(content, userId, now, now, metadata).lastInsertRowid
  );
  upsertEmbedding("memories", id, embed(content));
  return id;
}

const derivedCreatedAfter = (maxId) =>
  db
    .prepare("SELECT id, content, metadata, user_id FROM memories WHERE type = 'DERIVED' AND id > ? ORDER BY id")
    .all(maxId);
const sourcesOf = (derivedId) =>
  db
    .prepare(
      "SELECT source_memory_id FROM memory_links WHERE target_memory_id = ? AND relation = 'derived_from'"
    )
    .all(derivedId)
    .map((r) => r.source_memory_id);
const metadataTrusted = (raw) => {
  if (raw == null) return "absent";
  const parsed = JSON.parse(raw);
  return Object.hasOwn(parsed, "trusted") ? parsed.trusted : "absent";
};

// ---------------------------------------------------------------- fixtures ---
setIdentity({ mode: "legacy", roles: [] });

const BOB_ENTITY = "NebulaOtter42";
const BOB_MARKER = "bob-private-otter";
const BOB_CONTENT = `${BOB_MARKER} note: ${BOB_ENTITY} deployment rotation belongs to bob`;

const aliceMemory = createMemory({
  type: "FACT",
  content: "alice nebula otter tracking note",
  userId: "alice",
});
const bobMemory = createMemory({
  type: "FACT",
  content: BOB_CONTENT,
  userId: "bob",
});
const globalMemory = createMemory({
  type: "FACT",
  content: "shared global nebula otter glossary",
});

// bob's graph: an entity mentioned by his memory + a relation sourced from it.
const bobEntityId = createEntity({ name: BOB_ENTITY, type: "project" });
const bobOtherEntityId = createEntity({ name: "BobRotationGroup", type: "concept" });
addRelation({
  subjectId: bobEntityId,
  predicate: "owned_by",
  objectId: bobOtherEntityId,
  sourceMemoryId: bobMemory,
});
// bob's own memory_link onto a GLOBAL memory (visible target, private source).
linkMemories(bobMemory, globalMemory, "related_to");
// A pre-auth style cross-scope edge alice must not be able to traverse. This is
// the graph row "sourced from bob's memory" the isolation assertions target.
linkMemories(aliceMemory, bobMemory, "supports");

// Two identical twins per owner: if scope filtering were broken these four
// would form ONE cluster with mixed owners, which cannot be attributed to a
// single owner — so the derived row for alice proves bob's rows were excluded.
createMemory({ type: "FACT", content: "identical cluster probe omega", userId: "alice" });
createMemory({ type: "FACT", content: "identical cluster probe omega", userId: "alice" });
createMemory({ type: "FACT", content: "identical cluster probe omega", userId: "bob" });
createMemory({ type: "FACT", content: "identical cluster probe omega", userId: "bob" });

// ------------------------------------------ 1. graph isolation under alice ---
test("B4.1 get_context never surfaces bob's memory, entity or graph edge", async () => {
  assert.ok(getMemoryById(bobMemory), "bob's fixture memory exists");
  assert.equal(
    db
      .prepare("SELECT count(*) AS c FROM relations WHERE source_memory_id = ?")
      .get(bobMemory).c,
    1,
    "bob's relation is sourced from his memory"
  );

  const scoped = await runAs(
    ALICE,
    "get_context",
    { query: "nebula otter", userId: "alice" },
    () =>
      contextHandler({
        query: "nebula otter",
        userId: "alice",
        limit: 20,
        maxTokens: 8000,
        includeGraph: true,
      })
  );
  const scopedText = textOf(scoped);

  assert.notEqual(scoped.isError, true, scopedText);
  assert.match(scopedText, /alice nebula otter tracking note/, "alice's own USER row is visible");
  assert.match(scopedText, /shared global nebula otter glossary/, "GLOBAL rows stay shared");
  assert.equal(
    scopedText.includes(BOB_MARKER),
    false,
    `bob's memory leaked through get_context:\n${scopedText}`
  );
  assert.equal(
    scopedText.includes(BOB_ENTITY),
    false,
    `bob's entity name leaked through get_context:\n${scopedText}`
  );
  assert.equal(
    scopedText.includes("owned_by"),
    false,
    "bob's relation predicate never renders"
  );

  // The GLOBAL-only form (no userId requested) must hide bob too.
  const globalOnly = await runAs(ALICE, "get_context", { query: "nebula otter" }, () =>
    contextHandler({ query: "nebula otter", limit: 20, maxTokens: 8000, includeGraph: true })
  );
  assert.equal(textOf(globalOnly).includes(BOB_MARKER), false);
  assert.equal(textOf(globalOnly).includes(BOB_ENTITY), false);
});

test("B4.1 consolidate never clusters bob's graph rows into alice's derived rows", async () => {
  const before = maxMemoryId();
  const result = await runAs(ALICE, "consolidate", {}, () =>
    consolidateHandler({ threshold: 0.5, minClusterSize: 2, derive: true })
  );
  const text = textOf(result);
  assert.notEqual(result.isError, true, text);

  const created = db
    .prepare("SELECT id, type, content, user_id FROM memories WHERE id > ? ORDER BY id")
    .all(before);
  for (const row of created) {
    assert.notEqual(
      row.user_id,
      bobUid,
      `a row was written into bob's scope: ${row.content}`
    );
    assert.equal(
      row.content.includes(BOB_MARKER),
      false,
      `bob's content reached a derived row: ${row.content}`
    );
  }

  const derived = derivedCreatedAfter(before);
  assert.ok(
    derived.length > 0,
    `alice's twin memories must still derive (mixed-owner cluster would be skipped):\n${text}`
  );
  for (const row of derived) {
    assert.equal(row.user_id, aliceUid, `derived row must belong to alice: ${row.content}`);
    const sources = sourcesOf(row.id);
    assert.equal(
      sources.includes(bobMemory),
      false,
      `derived row ${row.id} absorbed bob's memory`
    );
  }
});

test("B4.1 link_memory across the identity boundary is denied and writes nothing", async () => {
  const countLinks = () =>
    db
      .prepare(
        "SELECT count(*) AS c FROM memory_links WHERE source_memory_id = ? AND target_memory_id = ? AND relation = 'related_to'"
      )
      .get(aliceMemory, bobMemory).c;
  assert.equal(countLinks(), 0, "no alice->bob related_to link before the call");

  const denied = await runAs(ALICE, "link_memory", {}, () =>
    linkMemoryHandler({ sourceId: aliceMemory, targetId: bobMemory, relation: "related_to" })
  );
  assert.equal(denied.isError, true, textOf(denied));
  assert.match(textOf(denied), /denied/);
  assert.equal(countLinks(), 0, "a denied link_memory must not write a row");

  // The legitimate direction (both rows writable by alice) still works, so the
  // deny is about bob's row, not about linking in general.
  const alicePeer = createMemory({
    type: "FACT",
    content: "alice nebula otter follow-up note",
    userId: "alice",
  });
  const allowed = await runAs(ALICE, "link_memory", {}, () =>
    linkMemoryHandler({ sourceId: aliceMemory, targetId: alicePeer, relation: "related_to" })
  );
  assert.notEqual(allowed.isError, true, textOf(allowed));
  assert.equal(
    db
      .prepare(
        "SELECT count(*) AS c FROM memory_links WHERE source_memory_id = ? AND target_memory_id = ? AND relation = 'related_to'"
      )
      .get(aliceMemory, alicePeer).c,
    1
  );
});

// ----------------------------------------------------- 2. trust propagation ---
test("B4.2 a derived row inherits untrusted metadata from its sources", async () => {
  resetRows();

  const untrusted = createMemory({
    type: "FACT",
    content: "alice imported budget note quarterly forecast",
    userId: "alice",
    metadata: { trusted: false, origin: "import" },
  });
  createMemory({
    type: "FACT",
    content: "alice imported budget note quarterly forecast",
    userId: "alice",
  });
  assert.ok(isUntrustedMetadata(getMemoryById(untrusted).metadata));

  const before = maxMemoryId();
  const result = await runAs(ALICE, "consolidate", {}, () =>
    consolidateHandler({ threshold: 0.5, minClusterSize: 2, derive: true })
  );
  const text = textOf(result);
  assert.notEqual(result.isError, true, text);
  assert.match(text, /\[untrusted-import\]/, `output must label the cluster:\n${text}`);

  const derived = derivedCreatedAfter(before);
  const mine = derived.filter((row) => sourcesOf(row.id).includes(untrusted));
  assert.equal(mine.length, 1, `exactly one derived row from the untrusted cluster:\n${text}`);
  assert.equal(
    metadataTrusted(mine[0].metadata),
    false,
    `derived row metadata must carry trusted=false: ${mine[0].metadata}`
  );
  assert.match(
    text,
    new RegExp(`derived memory id=${mine[0].id} \\[untrusted-import\\]`),
    `the derived line must be labelled:\n${text}`
  );
  assert.equal(mine[0].user_id, aliceUid, "trust propagation does not change ownership");

  // The invariant, checked against every derived row this call produced.
  for (const row of derived) {
    const sources = sourcesOf(row.id);
    const anyUntrusted = sources.some((id) => {
      const src = db.prepare("SELECT metadata FROM memories WHERE id = ?").get(id);
      return src ? isUntrustedMetadata(src.metadata) : false;
    });
    if (anyUntrusted) {
      assert.equal(
        metadataTrusted(row.metadata),
        false,
        `derived row ${row.id} has an untrusted source but no trusted=false flag`
      );
    }
  }
});

test("B4.2 a trusted-only cluster stays unlabelled", async () => {
  resetRows();

  createMemory({
    type: "FACT",
    content: "alice clean budget note annual forecast",
    userId: "alice",
  });
  createMemory({
    type: "FACT",
    content: "alice clean budget note annual forecast",
    userId: "alice",
  });

  const before = maxMemoryId();
  const result = await runAs(ALICE, "consolidate", {}, () =>
    consolidateHandler({ threshold: 0.5, minClusterSize: 2, derive: true })
  );
  const text = textOf(result);
  assert.notEqual(result.isError, true, text);

  const derived = derivedCreatedAfter(before);
  assert.equal(derived.length, 1, text);
  assert.notEqual(metadataTrusted(derived[0].metadata), false);
  assert.doesNotMatch(
    text,
    new RegExp(`derived memory id=${derived[0].id} \\[untrusted-import\\]`)
  );
});

// ------------------------------------------ 3. malformed metadata fails shut ---
test("B4.3 malformed metadata ('not json') is treated as untrusted", async () => {
  resetRows();

  const garbage = insertRawMemory({
    content: "alice legacy budget note march forecast",
    metadata: "not json",
    userId: aliceUid,
  });
  createMemory({
    type: "FACT",
    content: "alice legacy budget note march forecast",
    userId: "alice",
  });
  assert.equal(isUntrustedMetadata("not json"), true);

  const before = maxMemoryId();
  const result = await runAs(ALICE, "consolidate", {}, () =>
    consolidateHandler({ threshold: 0.5, minClusterSize: 2, derive: true })
  );
  const text = textOf(result);
  assert.notEqual(result.isError, true, text);
  assert.match(text, /\[untrusted-import\]/, `output must label the cluster:\n${text}`);

  const derived = derivedCreatedAfter(before);
  const mine = derived.filter((row) => sourcesOf(row.id).includes(garbage));
  assert.equal(mine.length, 1, `malformed-metadata row must cluster:\n${text}`);
  assert.equal(
    metadataTrusted(mine[0].metadata),
    false,
    `fail closed: ${mine[0].metadata}`
  );
  assert.match(
    text,
    new RegExp(`derived memory id=${mine[0].id} \\[untrusted-import\\]`)
  );
});
