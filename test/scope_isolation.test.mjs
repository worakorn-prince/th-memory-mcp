import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const workDir = mkdtempSync(join(tmpdir(), "th-auth-p3-isolation-"));
const dbPath = join(workDir, "isolation.db");

process.env.MEMORY_DB_PATH = dbPath;
process.env.MEMORY_BACKUP_ON_MIGRATE = "0";
delete process.env.MEMORY_AUTH;
delete process.env.MEMORY_AUTH_TOKEN;
delete process.env.MEMORY_AUTH_TOKEN_FILE;

const { db } = await import("../dist/db/index.js");
const { ensureUser } = await import("../dist/db/repositories/users.js");
const { addGrant, removeGrant } = await import(
  "../dist/db/repositories/scope_grants.js"
);
const { createMemory, getMemoryById } = await import(
  "../dist/db/repositories/memories.js"
);
const { setIdentity } = await import("../dist/auth/identity.js");
const {
  bindScopeToIdentity,
  canAccessPersonalRow,
  canAccessRow,
  getEffectiveScope,
  runWithScope,
} = await import("../dist/auth/scope-resolver.js");
const { forgetHandler } = await import("../dist/tools/forget.js");
const { updateMemoryHandler } = await import("../dist/tools/update_memory.js");
const { linkMemoryHandler } = await import("../dist/tools/link_memory.js");
const { mergeMemoryHandler } = await import("../dist/tools/merge_memory.js");
const { importMemoryHandler } = await import("../dist/tools/import_memory.js");
const { rememberHandler } = await import("../dist/tools/remember.js");
const { saveLessonHandler } = await import("../dist/tools/lesson.js");
const { consolidateHandler } = await import("../dist/tools/consolidate.js");
const { extractMemoriesHandler } = await import(
  "../dist/tools/extract_memories.js"
);

const aliceUid = ensureUser("alice");
const bobUid = ensureUser("bob");

// Fixtures are written in legacy mode so no bound scope is in force.
setIdentity({ mode: "legacy", roles: [] });

const aliceOwnId = createMemory({
  type: "FACT",
  content: "alice own scope probe",
  userId: "alice",
});
const bobMemoryId = createMemory({
  type: "FACT",
  content: "bob private scope probe",
  userId: "bob",
});
const globalMemoryId = createMemory({
  type: "FACT",
  content: "global shared scope probe",
});
const aliceMergeTargetId = createMemory({
  type: "FACT",
  content: "alice merge target probe",
  userId: "alice",
});
const aliceLinkTargetId = createMemory({
  type: "FACT",
  content: "alice link target probe",
  userId: "alice",
});

test.after(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  rmSync(workDir, { recursive: true, force: true });
});

const LEGACY = { mode: "legacy", roles: [] };

function enforced(roles = ["owner"], externalId = "alice", uid = aliceUid) {
  return { mode: "enforced", userId: externalId, uid, roles };
}

function bind(identity, args, toolName) {
  const result = bindScopeToIdentity(identity, args, toolName);
  assert.equal(result.ok, true, `bind ${toolName} must succeed: ${JSON.stringify(result)}`);
  return result.scope;
}

/** Run `fn` under the scope the guard would bind for this identity/tool. */
function asScoped(identity, toolName, fn, args = {}) {
  const scope = bind(identity, args, toolName);
  return runWithScope(scope, fn);
}

const textOf = (result) =>
  (result?.content ?? []).map((c) => c.text).join("\n");

const countMemories = () =>
  db.prepare("SELECT COUNT(*) AS n FROM memories").get().n;
const countUsers = () => db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
const countLinks = () => db.prepare("SELECT COUNT(*) AS n FROM memory_links").get().n;

// -------------------------------------------------- canAccessRow unit matrix ---

test("canAccessRow: GLOBAL and own USER rows are writable, foreign USER is not", () => {
  const alice = enforced();
  assert.equal(canAccessRow(alice, { scope: "GLOBAL" }, "write"), true);
  assert.equal(canAccessRow(alice, { scope: "GLOBAL" }, "read"), true);
  assert.equal(
    canAccessRow(alice, { scope: "USER", user_id: aliceUid }, "write"),
    true,
    "own USER row"
  );
  assert.equal(
    canAccessRow(alice, { scope: "USER", user_id: bobUid }, "write"),
    false,
    "foreign USER row without a grant"
  );
  assert.equal(
    canAccessRow(alice, { scope: "USER", user_id: null }, "write"),
    false,
    "USER row with no resolvable owner fails closed"
  );
});

test("canAccessRow: a write grant allows a foreign USER row; a read grant never does", () => {
  const alice = enforced();
  const bobRow = { scope: "USER", user_id: bobUid };

  addGrant(aliceUid, "USER", "bob", "write");
  assert.equal(canAccessRow(alice, bobRow, "write"), true, "write grant");
  assert.equal(canAccessRow(alice, bobRow, "read"), true, "write implies read");
  removeGrant(aliceUid, "USER", "bob", "write");
  assert.equal(canAccessRow(alice, bobRow, "write"), false, "grant removed");

  addGrant(aliceUid, "USER", "bob", "read");
  assert.equal(canAccessRow(alice, bobRow, "read"), true, "read grant");
  assert.equal(canAccessRow(alice, bobRow, "write"), false, "read never implies write");
  removeGrant(aliceUid, "USER", "bob", "read");
  assert.equal(canAccessRow(alice, bobRow, "read"), false);
});

test("canAccessRow: PROJECT and SESSION rows are denied until granted", () => {
  const alice = enforced();
  const projectRow = { scope: "PROJECT", project_id: "proj-p3" };
  const sessionRow = { scope: "SESSION", session_id: "sess-p3" };

  assert.equal(canAccessRow(alice, projectRow, "write"), false);
  assert.equal(canAccessRow(alice, sessionRow, "write"), false);

  addGrant(aliceUid, "PROJECT", "proj-p3", "write");
  assert.equal(canAccessRow(alice, projectRow, "write"), true);
  removeGrant(aliceUid, "PROJECT", "proj-p3", "write");
  assert.equal(canAccessRow(alice, projectRow, "write"), false);

  addGrant(aliceUid, "SESSION", "sess-p3", "write");
  assert.equal(canAccessRow(alice, sessionRow, "write"), true);
  removeGrant(aliceUid, "SESSION", "sess-p3", "write");
  assert.equal(canAccessRow(alice, sessionRow, "write"), false);

  // A grant on the wrong target does not transfer.
  addGrant(aliceUid, "PROJECT", "proj-other", "write");
  assert.equal(canAccessRow(alice, projectRow, "write"), false);
  removeGrant(aliceUid, "PROJECT", "proj-other", "write");
});

test("canAccessRow: unknown scope and legacy identity", () => {
  const alice = enforced();
  assert.equal(canAccessRow(alice, { scope: "UNKNOWN" }, "write"), false);
  assert.equal(canAccessRow(alice, { scope: "unknown" }, "read"), false);
  assert.equal(canAccessRow({ mode: "enforced", roles: ["owner"] }, { scope: "USER" }, "write"), false, "identity without uid fails closed");

  const legacy = { mode: "legacy", roles: [] };
  assert.equal(canAccessRow(legacy, { scope: "USER", user_id: bobUid }, "write"), true);
  assert.equal(canAccessRow(legacy, { scope: "UNKNOWN" }, "write"), true);
});

test("canAccessPersonalRow: shared NULL, own uid, foreign uid, legacy", () => {
  const alice = enforced();
  assert.equal(canAccessPersonalRow(alice, null), true, "NULL rows are shared");
  assert.equal(canAccessPersonalRow(alice, aliceUid), true, "own row");
  assert.equal(canAccessPersonalRow(alice, bobUid), false, "foreign row");

  const legacy = { mode: "legacy", roles: [] };
  assert.equal(canAccessPersonalRow(legacy, bobUid), true);
  assert.equal(canAccessPersonalRow(legacy, null), true);
});

// ------------------------------------------------- by-id tools: foreign rows ---

test("forget: alice (owner) cannot delete bob's USER memory (no side effect)", async () => {
  setIdentity(enforced(["owner"]));
  const linksBefore = countLinks();
  const result = await asScoped(enforced(["owner"]), "forget", () =>
    forgetHandler({ target_id: bobMemoryId, type: "memory" })
  );

  assert.equal(result.isError, true, textOf(result));
  assert.match(textOf(result), /denied: forget target out of scope \(auth enforced\)$/);
  assert.ok(getMemoryById(bobMemoryId), "bob's memory must survive the denied forget");
  assert.equal(countLinks(), linksBefore, "no link may be removed");
});

test("update_memory: alice (owner) cannot update bob's USER memory", async () => {
  setIdentity(enforced(["owner"]));
  const before = getMemoryById(bobMemoryId);

  const result = await asScoped(enforced(["owner"]), "update_memory", () =>
    updateMemoryHandler({ id: bobMemoryId, summary: "hijacked summary" })
  );

  assert.equal(result.isError, true, textOf(result));
  assert.match(
    textOf(result),
    /denied: update_memory target out of scope \(auth enforced\)$/
  );
  const after = getMemoryById(bobMemoryId);
  assert.equal(after.content, before.content);
  assert.equal(after.summary, before.summary);
  assert.equal(after.updated_at, before.updated_at);
});

test("link_memory: a cross-owner link is denied before any link row exists", async () => {
  setIdentity(enforced(["owner"]));
  const linksBefore = countLinks();

  const result = await asScoped(enforced(["owner"]), "link_memory", () =>
    linkMemoryHandler({
      sourceId: bobMemoryId,
      targetId: aliceLinkTargetId,
      relation: "related_to",
    })
  );

  assert.equal(result.isError, true, textOf(result));
  assert.match(
    textOf(result),
    /denied: link_memory target out of scope \(auth enforced\)$/
  );
  assert.equal(countLinks(), linksBefore, "no memory_links row may be added");
});

test("merge_memory: alice cannot merge bob's memory into her own", async () => {
  setIdentity(enforced(["owner"]));
  const srcBefore = getMemoryById(bobMemoryId);
  const tgtBefore = getMemoryById(aliceMergeTargetId);

  const result = await asScoped(enforced(["owner"]), "merge_memory", () =>
    mergeMemoryHandler({ sourceId: bobMemoryId, targetId: aliceMergeTargetId })
  );

  assert.equal(result.isError, true, textOf(result));
  assert.match(
    textOf(result),
    /denied: merge_memory target out of scope \(auth enforced\)$/
  );
  const srcAfter = getMemoryById(bobMemoryId);
  const tgtAfter = getMemoryById(aliceMergeTargetId);
  assert.equal(srcAfter.status, srcBefore.status, "source status unchanged");
  assert.equal(srcAfter.supersedes_id, srcBefore.supersedes_id);
  assert.equal(tgtAfter.metadata, tgtBefore.metadata, "no merged_from provenance");
});

// ------------------------------------------------------- grants / own scope ---

test("update_memory: alice can update her own and a GLOBAL memory", async () => {
  setIdentity(enforced(["owner"]));
  const alice = enforced(["owner"]);

  const own = await asScoped(alice, "update_memory", () =>
    updateMemoryHandler({ id: aliceOwnId, summary: "alice own summary" })
  );
  assert.notEqual(own.isError, true, textOf(own));
  assert.equal(getMemoryById(aliceOwnId).summary, "alice own summary");

  const global = await asScoped(alice, "update_memory", () =>
    updateMemoryHandler({ id: globalMemoryId, summary: "global summary" })
  );
  assert.notEqual(global.isError, true, textOf(global));
  assert.equal(getMemoryById(globalMemoryId).summary, "global summary");
});

test("update_memory: a write grant on bob's USER scope allows the update", async () => {
  setIdentity(enforced(["owner"]));
  addGrant(aliceUid, "USER", "bob", "write");
  try {
    const result = await asScoped(enforced(["owner"]), "update_memory", () =>
      updateMemoryHandler({ id: bobMemoryId, summary: "granted summary" })
    );
    assert.notEqual(result.isError, true, textOf(result));
    assert.equal(getMemoryById(bobMemoryId).summary, "granted summary");
  } finally {
    removeGrant(aliceUid, "USER", "bob", "write");
  }

  // Without the grant the same call is denied again (no residual authority).
  const again = await asScoped(enforced(["owner"]), "update_memory", () =>
    updateMemoryHandler({ id: bobMemoryId, summary: "after revoke" })
  );
  assert.equal(again.isError, true, textOf(again));
});

// ------------------------------------------------------------ import_memory ---

test("import_memory: a per-row foreign userId denies the whole import (rollback)", async () => {
  setIdentity(enforced(["owner"]));
  const memoriesBefore = countMemories();
  const usersBefore = countUsers();

  const payload = JSON.stringify({
    memories: [
      { type: "FACT", content: "foreign import probe", userId: "bob" },
      { type: "FACT", content: "alice mixed import probe", userId: "alice" },
    ],
  });
  const result = await asScoped(enforced(["owner"]), "import_memory", () =>
    importMemoryHandler({ json: payload, apply: true })
  );

  assert.equal(result.isError, true, textOf(result));
  assert.match(
    textOf(result),
    /denied: import_memory row owner out of scope \(auth enforced\)$/
  );
  assert.equal(countMemories(), memoriesBefore, "no memory row may be written");
  assert.equal(countUsers(), usersBefore, "no user row may be written");
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS n FROM memories WHERE content LIKE '%import probe%'")
      .get().n,
    0,
    "not even the own-row of the mixed payload may land"
  );
});

test("import_memory: an own-row import succeeds and is owned by the bound user", async () => {
  setIdentity(enforced(["owner"]));
  const memoriesBefore = countMemories();

  const payload = JSON.stringify({
    memories: [{ type: "FACT", content: "alice own import probe", userId: "alice" }],
  });
  const result = await asScoped(enforced(["owner"]), "import_memory", () =>
    importMemoryHandler({ json: payload, apply: true })
  );

  assert.notEqual(result.isError, true, textOf(result));
  assert.equal(countMemories(), memoriesBefore + 1);
  const row = db
    .prepare("SELECT user_id, scope FROM memories WHERE content = 'alice own import probe'")
    .get();
  assert.equal(row.user_id, aliceUid);
  assert.equal(row.scope, "USER");
});

test("import_memory: a row scoped outside the bound project rolls back atomically", async () => {
  setIdentity(enforced(["owner"]));
  const memoriesBefore = countMemories();

  const payload = JSON.stringify({
    memories: [
      { type: "FACT", content: "outside project import probe", projectId: "proj-outside" },
    ],
  });
  const result = await asScoped(enforced(["owner"]), "import_memory", () =>
    importMemoryHandler({ json: payload, apply: true })
  );

  assert.equal(result.isError, true, textOf(result));
  assert.match(textOf(result), /scope mismatch \(auth enforced\)/);
  assert.match(textOf(result), /rolled back/);
  assert.equal(countMemories(), memoriesBefore, "the transaction must roll back");
});

// ------------------------------------------------ remember / save_lesson owner ---

test("remember: enforced writes user_id = alice.uid, legacy writes NULL", async () => {
  setIdentity(LEGACY);
  const legacyResult = await rememberHandler({
    category: "coding_pref",
    key: "scope_isolation_remember_legacy",
    value: "legacy-value",
  });
  assert.notEqual(legacyResult.isError, true, textOf(legacyResult));
  const legacyRow = db
    .prepare(
      "SELECT user_id FROM preferences WHERE category = 'coding_pref' AND key = 'scope_isolation_remember_legacy'"
    )
    .get();
  assert.equal(legacyRow.user_id, null, "legacy preferences stay shared (NULL owner)");

  setIdentity(enforced(["writer"]));
  const enforcedResult = await asScoped(enforced(["writer"]), "remember", () =>
    rememberHandler({
      category: "coding_pref",
      key: "scope_isolation_remember_enforced",
      value: "enforced-value",
    })
  );
  assert.notEqual(enforcedResult.isError, true, textOf(enforcedResult));
  const enforcedRow = db
    .prepare(
      "SELECT user_id FROM preferences WHERE category = 'coding_pref' AND key = 'scope_isolation_remember_enforced'"
    )
    .get();
  assert.equal(enforcedRow.user_id, aliceUid);
});

test("save_lesson: enforced writes user_id = alice.uid, legacy writes NULL", async () => {
  setIdentity(LEGACY);
  const legacyResult = await saveLessonHandler({
    situation: "scope isolation legacy lesson",
    mistake: "none",
    correction: "none",
  });
  assert.notEqual(legacyResult.isError, true, textOf(legacyResult));
  const legacyRow = db
    .prepare("SELECT user_id FROM lessons WHERE situation = 'scope isolation legacy lesson'")
    .get();
  assert.equal(legacyRow.user_id, null);

  setIdentity(enforced(["writer"]));
  const enforcedResult = await asScoped(enforced(["writer"]), "save_lesson", () =>
    saveLessonHandler({
      situation: "scope isolation enforced lesson",
      mistake: "none",
      correction: "none",
    })
  );
  assert.notEqual(enforcedResult.isError, true, textOf(enforcedResult));
  const enforcedRow = db
    .prepare("SELECT user_id FROM lessons WHERE situation = 'scope isolation enforced lesson'")
    .get();
  assert.equal(enforcedRow.user_id, aliceUid);
});

// ------------------------------------------- consolidate / extract_memory scope ---

test("consolidate: enforced mode clusters the bound scope and derives a bound-scope row", async () => {
  setIdentity(LEGACY);
  const g1 = createMemory({
    type: "FACT",
    content: "scope isolation consolidation probe",
  });
  const g2 = createMemory({
    type: "FACT",
    content: "scope isolation consolidation probe",
  });

  setIdentity(enforced(["owner"]));
  const result = await asScoped(enforced(["owner"]), "consolidate", () =>
    consolidateHandler({ threshold: 0.98, derive: true })
  );
  const text = textOf(result);

  assert.notEqual(result.isError, true, text);
  assert.ok(text.includes(`[${g1}]`) && text.includes(`[${g2}]`), text);
  assert.equal(
    text.includes("bob private scope probe"),
    false,
    "a foreign USER memory must never be clustered or reported"
  );

  const derived = db
    .prepare("SELECT scope, user_id FROM memories WHERE type = 'DERIVED' ORDER BY id DESC LIMIT 1")
    .get();
  assert.equal(derived.scope, "USER", "derived row takes the bound USER scope");
  assert.equal(derived.user_id, aliceUid);
});

test("extract_memories: enforced mode reads own + NULL (owner) interactions only", async () => {
  const insertInteraction = db.prepare(
    "INSERT INTO interactions (ts, session_id, kind, content, user_id) VALUES (?, ?, 'prompt', ?, ?)"
  );
  insertInteraction.run("2026-03-01T00:00:00.000Z", "sess-scope", "remember that alice likes dark mode", aliceUid);
  insertInteraction.run("2026-03-01T00:00:01.000Z", "sess-scope", "remember that bob likes light mode", bobUid);
  insertInteraction.run("2026-03-01T00:00:02.000Z", "sess-scope", "remember that the shared team uses pnpm", null);

  setIdentity(enforced(["owner"]));
  const alice = enforced(["owner"]);

  const preview = await asScoped(alice, "extract_memories", () =>
    extractMemoriesHandler({ kind: "prompt" })
  );
  const previewText = textOf(preview);
  assert.notEqual(preview.isError, true, previewText);
  assert.ok(previewText.includes("alice likes dark mode"), previewText);
  assert.equal(previewText.includes("bob likes light mode"), false, "bob's row is out of scope");
  assert.ok(previewText.includes("the shared team uses pnpm"), "owner may read NULL rows");

  const applied = await asScoped(alice, "extract_memories", () =>
    extractMemoriesHandler({ kind: "prompt", apply: true })
  );
  assert.notEqual(applied.isError, true, textOf(applied));

  const ownRow = db
    .prepare("SELECT user_id, scope FROM memories WHERE content = 'alice likes dark mode'")
    .get();
  assert.equal(ownRow.user_id, aliceUid);
  assert.equal(ownRow.scope, "USER");
  const nullRow = db
    .prepare("SELECT user_id, scope FROM memories WHERE content = 'the shared team uses pnpm'")
    .get();
  assert.equal(nullRow.user_id, aliceUid, "derived memory takes the bound owner, not the raw row owner");
  assert.equal(
    db.prepare("SELECT 1 FROM memories WHERE content = 'bob likes light mode'").get(),
    undefined,
    "bob's interaction must not produce a memory"
  );
});

// ---------------------------------------------------- createMemory hardening ---

test("createMemory: a row outside the bound scope throws scope mismatch", () => {
  setIdentity(enforced(["owner"]));
  const before = countMemories();

  assert.throws(
    () =>
      asScoped(enforced(["owner"]), "remember", () =>
        createMemory({ type: "FACT", content: "escaped scope probe", userId: "bob" })
      ),
    /scope mismatch \(auth enforced\)/
  );
  assert.equal(countMemories(), before, "the failed insert must not land");

  // The bound owner is still writable.
  const id = asScoped(enforced(["owner"]), "remember", () =>
    createMemory({ type: "FACT", content: "bound owner probe", userId: "alice" })
  );
  assert.ok(id > 0);
  assert.equal(getMemoryById(id).user_id, aliceUid);
});

test("getEffectiveScope: null outside the guard, bound inside", async () => {
  setIdentity(enforced(["owner"]));
  assert.equal(getEffectiveScope(), null);
  const seen = await asScoped(enforced(["owner"]), "remember", async () => {
    await Promise.resolve();
    return getEffectiveScope();
  });
  assert.equal(seen?.mode, "enforced");
  assert.equal(seen?.userId, "alice");
  assert.equal(getEffectiveScope(), null, "the scope must not leak out");
});
