// P6 S2 (A5) — adversarial scope isolation.
//
// Each case asserts the denial AND that nothing changed. Fixtures are written
// in legacy mode, then every call runs under an explicitly bound identity with
// the real tool handlers (no server spawn), matching test/scope_isolation.mjs.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const workDir = mkdtempSync(join(tmpdir(), "th-p6-adversarial-"));
const dbPath = join(workDir, "adversarial.db");

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
const { bindScopeToIdentity, runWithScope } = await import(
  "../dist/auth/scope-resolver.js"
);
const { withAuth } = await import("../dist/auth/guard.js");
const { recallHandler } = await import("../dist/tools/recall.js");
const { contextHandler } = await import("../dist/tools/context.js");
const { exportMemoryHandler } = await import("../dist/tools/export_memory.js");
const { updateMemoryHandler } = await import("../dist/tools/update_memory.js");
const { forgetHandler } = await import("../dist/tools/forget.js");
const { linkMemoryHandler } = await import("../dist/tools/link_memory.js");
const { mergeMemoryHandler } = await import("../dist/tools/merge_memory.js");
const { importMemoryHandler } = await import("../dist/tools/import_memory.js");
const { consolidateHandler } = await import("../dist/tools/consolidate.js");
const { extractMemoriesHandler } = await import(
  "../dist/tools/extract_memories.js"
);
const { searchHistoryHandler } = await import("../dist/tools/history.js");
const { getRecentInteractionsHandler } = await import(
  "../dist/tools/recent_interactions.js"
);

const aliceUid = ensureUser("alice");
const bobUid = ensureUser("bob");

test.after(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  rmSync(workDir, { recursive: true, force: true });
});

const ALICE = { mode: "enforced", userId: "alice", uid: aliceUid, roles: ["owner"] };
const BOB = { mode: "enforced", userId: "bob", uid: bobUid, roles: ["owner"] };

function runAs(identity, tool, args, fn) {
  setIdentity(identity);
  const bound = bindScopeToIdentity(identity, args, tool);
  assert.equal(bound.ok, true, `bind ${tool} failed: ${JSON.stringify(bound)}`);
  return runWithScope(bound.scope, fn);
}
const textOf = (r) => (r?.content ?? []).map((c) => c.text).join("\n");
const memoryRow = (id) => getMemoryById(id);

// ------------------------------------------------------------------ fixtures ---
setIdentity({ mode: "legacy", roles: [] });

const aliceMemory = createMemory({
  type: "FACT",
  content: "alice adversarial own row",
  userId: "alice",
});
const bobMemory = createMemory({
  type: "FACT",
  content: "bob adversarial private row",
  userId: "bob",
});

// A corrupt legacy row: USER scope with no owner. Must be invisible everywhere.
const now = new Date().toISOString();
const corruptId = Number(
  db
    .prepare(
      "INSERT INTO memories (type, content, scope, user_id, created_at, updated_at) VALUES ('FACT', ?, 'USER', NULL, ?, ?)"
    )
    .run("corrupt user scope row with no owner", now, now).lastInsertRowid
);

const insPref = db.prepare(
  "INSERT INTO preferences (category, key, value, confidence, source, user_id, updated_at) VALUES ('coding', ?, ?, 0.5, 'explicit', ?, ?)"
);
insPref.run("alice_key", "alice pref value", aliceUid, now);
insPref.run("bob_key", "bob secret pref value", bobUid, now);

const insLesson = db.prepare(
  "INSERT INTO lessons (situation, mistake, correction, user_id, created_at) VALUES (?, 'm', ?, ?, ?)"
);
insLesson.run("alice lesson situation", "alice correction", aliceUid, now);
insLesson.run("bob lesson situation", "bob secret correction", bobUid, now);

const insInteraction = db.prepare(
  "INSERT INTO interactions (ts, session_id, kind, content, user_id) VALUES (?, ?, 'prompt', ?, ?)"
);
insInteraction.run(now, "sess-alice", "i prefer pnpm for installs", aliceUid);
insInteraction.run(now, "sess-bob", "i prefer yarn classic for installs", bobUid);
insInteraction.run(now, "sess-shared", "i prefer tabs over spaces", null);

// -------------------------------------------------- 1. corrupt legacy USER row ---
test("1. a USER row with user_id NULL is invisible and immutable", async () => {
  const recall = await runAs(ALICE, "recall", { topic: "corrupt" }, () =>
    recallHandler({ topic: "corrupt", limit: 20 })
  );
  assert.equal(
    textOf(recall).includes("corrupt user scope row"),
    false,
    "recall must hide a USER row with no owner"
  );

  const ctx = await runAs(ALICE, "get_context", { query: "corrupt" }, () =>
    contextHandler({ query: "corrupt" })
  );
  assert.equal(
    textOf(ctx).includes("corrupt user scope row"),
    false,
    "get_context must hide it too"
  );

  const update = await runAs(ALICE, "update_memory", {}, () =>
    updateMemoryHandler({ id: corruptId, importance: 0.9 })
  );
  assert.equal(update.isError, true, "update on an ownerless USER row must be denied");
  assert.equal(
    memoryRow(corruptId).importance,
    0.5,
    "a denied update must not change the row"
  );
});

// ------------------------------------------------------- 2. grant escalation ---
test("2. a read grant never upgrades to write; a write grant does", async () => {
  const before = memoryRow(bobMemory).importance;

  const deniedUpdate = await runAs(ALICE, "update_memory", {}, () =>
    updateMemoryHandler({ id: bobMemory, importance: 0.95 })
  );
  assert.equal(deniedUpdate.isError, true);

  addGrant(aliceUid, "USER", "bob", "read");
  const stillDenied = await runAs(ALICE, "update_memory", {}, () =>
    updateMemoryHandler({ id: bobMemory, importance: 0.95 })
  );
  assert.equal(
    stillDenied.isError,
    true,
    "a read grant must not authorize a write"
  );
  assert.equal(memoryRow(bobMemory).importance, before, "no side effect");

  const deniedForget = await runAs(ALICE, "forget", {}, () =>
    forgetHandler({ target_id: bobMemory, type: "memory" })
  );
  assert.equal(deniedForget.isError, true, "forget needs a write grant");
  assert.ok(memoryRow(bobMemory), "row still exists");

  addGrant(aliceUid, "USER", "bob", "write");
  const allowed = await runAs(ALICE, "update_memory", {}, () =>
    updateMemoryHandler({ id: bobMemory, importance: 0.93 })
  );
  assert.notEqual(allowed.isError, true, `write grant must allow: ${textOf(allowed)}`);
  assert.equal(memoryRow(bobMemory).importance, 0.93);

  removeGrant(aliceUid, "USER", "bob", "write");
  removeGrant(aliceUid, "USER", "bob", "read");
});

// --------------------------------------------- 3. session filter cannot bypass ---
test("3. a sessionId filter never widens past the bound user", async () => {
  const history = await runAs(
    ALICE,
    "search_history",
    { query: "yarn", sessionId: "sess-bob" },
    () => searchHistoryHandler({ query: "yarn", limit: 20, sessionId: "sess-bob" })
  );
  assert.equal(
    textOf(history).includes("yarn classic"),
    false,
    "bob's session rows stay hidden even when the filter names his session"
  );

  const recent = await runAs(
    ALICE,
    "get_recent_interactions",
    { limit: 50, sessionId: "sess-bob" },
    () => getRecentInteractionsHandler({ limit: 50, sessionId: "sess-bob" })
  );
  assert.equal(textOf(recent).includes("yarn classic"), false);
  assert.equal(
    textOf(recent).includes("no interactions found"),
    true,
    "the filter matches nothing rather than leaking another user's session"
  );
});

// ------------------------------------------------------- 4. export leakage ---
test("4. export never emits another identity's rows", async () => {
  const result = await runAs(ALICE, "export_memory", {}, () =>
    exportMemoryHandler({ includeInteractions: true })
  );
  assert.notEqual(result.isError, true, textOf(result));
  const path = textOf(result).match(/exported: (.+)\nsize:/)[1].trim();
  const payload = JSON.parse(readFileSync(path, "utf8"));
  const serialized = JSON.stringify(payload);

  for (const needle of [
    "bob adversarial private row",
    "bob secret pref value",
    "bob secret correction",
    "yarn classic",
    "bob_key",
  ]) {
    assert.equal(serialized.includes(needle), false, `export leaked: ${needle}`);
  }
  assert.deepEqual(
    payload.users.map((u) => u.externalId),
    ["alice"],
    "only the caller's user row is exported"
  );
});

// --------------------------------------------------- 5. import owner spoofing ---
test("5. import with a foreign row owner is denied atomically", async () => {
  const memoriesBefore = db.prepare("SELECT count(*) AS n FROM memories").get().n;
  const usersBefore = db.prepare("SELECT count(*) AS n FROM users").get().n;

  const payload = JSON.stringify({
    format: "th-memory-mcp/v2",
    exported_at: now,
    memories: [
      {
        id: 1,
        type: "FACT",
        content: "spoofed import row claiming bob",
        status: "active",
        source: "imported",
        confidence: 0.6,
        importance: 0.6,
        salience: 0.6,
        userId: "bob",
      },
    ],
  });

  const result = await runAs(ALICE, "import_memory", {}, () =>
    importMemoryHandler({ json: payload, apply: true })
  );
  assert.equal(result.isError, true, "foreign row owner must be denied");
  assert.match(textOf(result), /denied|out of scope/i);
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM memories").get().n,
    memoriesBefore,
    "nothing was imported"
  );
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM users").get().n,
    usersBefore,
    "no user was minted"
  );
});

// ------------------------------------------------------- 6. audit injection ---
test("6. a hostile scope ref cannot forge or bloat an audit row", async () => {
  const hostile = `sess\r\n${"x".repeat(5000)}`;
  const wrapped = withAuth("recall", () => ({ content: [{ type: "text", text: "ran" }] }));

  setIdentity({ mode: "enforced", userId: "alice", uid: aliceUid, roles: [] });
  const denied = wrapped({ sessionId: hostile });
  assert.equal(denied.isError, true, "an identity with no roles is denied");

  const row = db
    .prepare("SELECT user_id, tool, decision, reason, scope_kind, scope_ref FROM audit_log ORDER BY id DESC LIMIT 1")
    .get();
  assert.equal(row.decision, "deny");
  assert.equal(row.reason, "role");
  assert.equal(row.tool, "recall");
  assert.ok(row.scope_ref.length <= 120, `scope_ref length ${row.scope_ref.length}`);
  assert.equal(/[\r\n]/.test(row.scope_ref), false, "CR/LF must be flattened");
  assert.equal(
    row.scope_ref.includes("x".repeat(200)),
    false,
    "the hostile payload must be truncated before storage"
  );
  assert.ok(
    JSON.stringify(row).length < 500,
    `audit row is not bounded: ${JSON.stringify(row).length} chars`
  );
});

// ------------------------------------------------- 7. consolidate cross-scope ---
test("7. consolidate never clusters across the identity boundary", async () => {
  createMemory({ type: "FACT", content: "identical cluster probe alpha", userId: "alice" });
  createMemory({ type: "FACT", content: "identical cluster probe alpha", userId: "bob" });
  const maxBefore = db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM memories").get().n;

  const result = await runAs(ALICE, "consolidate", {}, () =>
    consolidateHandler({ threshold: 0.5, derive: true })
  );
  assert.notEqual(result.isError, true, textOf(result));

  const created = db
    .prepare("SELECT id, user_id, scope, content FROM memories WHERE id > ?")
    .all(maxBefore);
  for (const row of created) {
    assert.equal(
      row.user_id === bobUid,
      false,
      `a derived row was written into bob's scope: ${row.content}`
    );
  }
});

// --------------------------------------------- 8. extract_memories cross-scope ---
test("8. extract_memories only reads the bound identity's interactions", async () => {
  const maxBefore = db.prepare("SELECT COALESCE(MAX(id), 0) AS n FROM memories").get().n;

  const result = await runAs(ALICE, "extract_memories", {}, () =>
    extractMemoriesHandler({ kind: "prompt", apply: true })
  );
  assert.notEqual(result.isError, true, textOf(result));

  const created = db
    .prepare("SELECT id, user_id, content FROM memories WHERE id > ?")
    .all(maxBefore);
  for (const row of created) {
    assert.equal(row.user_id, aliceUid, `derived row must belong to alice: ${row.content}`);
    assert.equal(
      row.content.includes("yarn classic"),
      false,
      "bob's interaction must not become alice's memory"
    );
  }
});
