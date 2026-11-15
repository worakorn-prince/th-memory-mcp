import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const workDir = mkdtempSync(join(tmpdir(), "th-auth-p3-interactions-"));
const dbPath = join(workDir, "interactions.db");

process.env.MEMORY_DB_PATH = dbPath;
process.env.MEMORY_BACKUP_ON_MIGRATE = "0";
delete process.env.MEMORY_AUTH;
delete process.env.MEMORY_AUTH_TOKEN;
delete process.env.MEMORY_AUTH_TOKEN_FILE;
delete process.env.MEMORY_CAPTURE_USER;

const { db } = await import("../dist/db/index.js");
const { ensureUser, getUserByExternalId } = await import("../dist/db/repositories/users.js");
const { setIdentity } = await import("../dist/auth/identity.js");
const {
  bindScopeToIdentity,
  getEffectiveScope,
  runWithScope,
} = await import("../dist/auth/scope-resolver.js");
const { searchHistoryHandler } = await import("../dist/tools/history.js");
const { getRecentInteractionsHandler } = await import("../dist/tools/recent_interactions.js");
const { recallHandler } = await import("../dist/tools/recall.js");
const { buildRow, INSERT_SQL, resolveCaptureUserId, resetCaptureUserId } = await import("../dist/lib/capture-core.js");

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

const LEGACY = { mode: "legacy", roles: [] };

function enforced(roles = ["owner"], externalId = "alice", uid = aliceUid) {
  return { mode: "enforced", userId: externalId, uid, roles };
}

function bind(identity, args, toolName) {
  const result = bindScopeToIdentity(identity, args, toolName);
  assert.equal(result.ok, true, `bind ${toolName} must succeed: ${JSON.stringify(result)}`);
  return result.scope;
}

function asScoped(identity, toolName, fn, args = {}) {
  const scope = bind(identity, args, toolName);
  return runWithScope(scope, fn);
}

const textOf = (result) =>
  (result?.content ?? []).map((c) => c.text).join("\n");

function insertInteraction(ts, sessionId, kind, content, userId) {
  db.prepare(
    "INSERT INTO interactions (ts, session_id, kind, content, meta, user_id) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(ts, sessionId, kind, content, null, userId);
}

// -------------------------------------------------- capture-core: resolveCaptureUserId ---

test("resolveCaptureUserId: no MEMORY_CAPTURE_USER returns null", async () => {
  delete process.env.MEMORY_CAPTURE_USER;
  resetCaptureUserId();
  assert.equal(await resolveCaptureUserId(), null);
});

test("resolveCaptureUserId: unknown MEMORY_CAPTURE_USER returns null", async () => {
  process.env.MEMORY_CAPTURE_USER = "unknown_user_123";
  resetCaptureUserId();
  assert.equal(await resolveCaptureUserId(), null);
});

test("resolveCaptureUserId: known MEMORY_CAPTURE_USER returns internal uid", async () => {
  process.env.MEMORY_CAPTURE_USER = "alice";
  resetCaptureUserId();
  assert.equal(await resolveCaptureUserId(), aliceUid);
});

test("resolveCaptureUserId: caches result", async () => {
  process.env.MEMORY_CAPTURE_USER = "alice";
  resetCaptureUserId();
  const first = await resolveCaptureUserId();
  const second = await resolveCaptureUserId();
  assert.equal(first, aliceUid);
  assert.equal(second, aliceUid);
});

test("resetCaptureUserId: clears cache", async () => {
  process.env.MEMORY_CAPTURE_USER = "alice";
  resetCaptureUserId();
  assert.equal(await resolveCaptureUserId(), aliceUid);
  delete process.env.MEMORY_CAPTURE_USER;
  resetCaptureUserId();
  assert.equal(await resolveCaptureUserId(), null);
});

// -------------------------------------------------- buildRow / INSERT_SQL ---

test("buildRow: includes user_id from opts", () => {
  const row = buildRow("prompt", "test content", { sessionId: "sess-1", userId: aliceUid });
  assert.equal(row.user_id, aliceUid);
});

test("buildRow: user_id defaults to null", () => {
  const row = buildRow("prompt", "test content", { sessionId: "sess-1" });
  assert.equal(row.user_id, null);
});

test("INSERT_SQL: includes user_id column", () => {
  assert.ok(INSERT_SQL.includes("user_id"), "INSERT_SQL must include user_id column");
  assert.ok(INSERT_SQL.includes("VALUES (?, ?, ?, ?, ?, ?)"), "INSERT_SQL must have 6 placeholders");
});

// -------------------------------------------------- Enforcement + MEMORY_CAPTURE_USER=alice ---

test("enforcement + MEMORY_CAPTURE_USER=alice: interaction has user_id=aliceUid; visible to alice, hidden from bob; owner sees NULL rows", async () => {
  process.env.MEMORY_CAPTURE_USER = "alice";
  resetCaptureUserId();

  // Resolve the capture user id (simulating what the plugin does)
  const captureUserId = await resolveCaptureUserId();
  assert.equal(captureUserId, aliceUid);

  // Insert interaction using buildRow + INSERT_SQL (simulating capture path)
  const row = buildRow("prompt", "alice captured interaction", { sessionId: "sess-capture", userId: captureUserId });
  db.prepare(INSERT_SQL).run(row.ts, row.session_id, row.kind, row.content, row.meta, row.user_id);

  // Also insert a NULL interaction (legacy/anonymous)
  insertInteraction("2026-01-01T00:00:00.000Z", "sess-anon", "prompt", "anonymous interaction", null);

  // Also insert a bob interaction
  insertInteraction("2026-01-01T00:00:01.000Z", "sess-bob", "prompt", "bob interaction", bobUid);

  // Debug: check what's in the DB
  const allInteractions = db.prepare("SELECT id, content, user_id, session_id FROM interactions").all();
  console.log('[DEBUG TEST] All interactions:', JSON.stringify(allInteractions, null, 2));

  // Alice (owner) searches
  setIdentity(enforced(["owner"]));
  const aliceSearch = await asScoped(enforced(["owner"]), "search_history", () =>
    searchHistoryHandler({ query: "interaction", limit: 10 })
  );
  const aliceText = textOf(aliceSearch);
  console.log('[DEBUG TEST] alice search_history:', aliceText);
  assert.ok(aliceText.includes("alice captured interaction"), "alice sees her captured interaction");
  assert.ok(aliceText.includes("anonymous interaction"), "owner sees NULL interaction");
  assert.equal(aliceText.includes("bob interaction"), false, "alice does NOT see bob's interaction");

  // Bob (writer) searches
  setIdentity(enforced(["writer"], "bob", bobUid));
  const bobSearch = await asScoped(enforced(["writer"], "bob", bobUid), "search_history", () =>
    searchHistoryHandler({ query: "interaction", limit: 10 })
  );
  const bobText = textOf(bobSearch);
  console.log('[DEBUG TEST] bob search_history:', bobText);
  assert.equal(bobText.includes("alice captured interaction"), false, "bob does NOT see alice's interaction");
  assert.equal(bobText.includes("anonymous interaction"), false, "writer does NOT see NULL interaction");
  assert.ok(bobText.includes("bob interaction"), "bob sees his own interaction");

  // Reset to alice (owner) for get_recent_interactions
  setIdentity(enforced(["owner"]));

  // get_recent_interactions: alice (owner)
  const aliceRecent = await asScoped(enforced(["owner"]), "get_recent_interactions", () =>
    getRecentInteractionsHandler({ limit: 20 })
  );
  const aliceRecentText = textOf(aliceRecent);
  console.log('[DEBUG TEST] alice recent:', aliceRecentText);

  // Debug: run the raw query
  const uid = aliceUid;
  const ownerFlag = 1;
  const sessionId = null;
  const limit = 20;
  const rawRows = db.prepare(
    "SELECT id, ts, kind, content, user_id FROM interactions WHERE (? IS NULL OR session_id = ?) AND (user_id = ? OR (? = 1 AND user_id IS NULL)) ORDER BY id DESC LIMIT ?"
  ).all(sessionId, sessionId, uid, ownerFlag, limit);
  console.log('[DEBUG TEST] raw query rows:', JSON.stringify(rawRows, null, 2));

  assert.ok(aliceRecentText.includes("alice captured interaction"));
  assert.ok(aliceRecentText.includes("anonymous interaction"));
  assert.equal(aliceRecentText.includes("bob interaction"), false);

  // get_recent_interactions: bob (writer)
  setIdentity(enforced(["writer"], "bob", bobUid));
  const bobRecent = await asScoped(enforced(["writer"], "bob", bobUid), "get_recent_interactions", () =>
    getRecentInteractionsHandler({ limit: 20 })
  );
  const bobRecentText = textOf(bobRecent);
  console.log('[DEBUG TEST] bob recent:', bobRecentText);
  assert.equal(bobRecentText.includes("alice captured interaction"), false);
  assert.equal(bobRecentText.includes("anonymous interaction"), false);
  assert.ok(bobRecentText.includes("bob interaction"));

  // recall: alice (owner)
  setIdentity(enforced(["owner"]));
  const aliceRecall = await asScoped(enforced(["owner"]), "recall", () =>
    recallHandler({ topic: "interaction", limit: 20 })
  );
  const aliceRecallText = textOf(aliceRecall);
  console.log('[DEBUG TEST] alice recall:', aliceRecallText);
  assert.ok(aliceRecallText.includes("alice captured interaction"));
  assert.ok(aliceRecallText.includes("anonymous interaction"));
  assert.equal(aliceRecallText.includes("bob interaction"), false);

  // recall: bob (writer)
  setIdentity(enforced(["writer"], "bob", bobUid));
  const bobRecall = await asScoped(enforced(["writer"], "bob", bobUid), "recall", () =>
    recallHandler({ topic: "interaction", limit: 20 })
  );
  const bobRecallText = textOf(bobRecall);
  console.log('[DEBUG TEST] bob recall:', bobRecallText);
  assert.equal(bobRecallText.includes("alice captured interaction"), false);
  assert.equal(bobRecallText.includes("anonymous interaction"), false);
  assert.ok(bobRecallText.includes("bob interaction"));
});

// -------------------------------------------------- Enforcement + MEMORY_CAPTURE_USER=unknown ---

test("enforcement + MEMORY_CAPTURE_USER=unknown: interaction has user_id=NULL; owner sees it, writer does not", async () => {
  process.env.MEMORY_CAPTURE_USER = "unknown_user_456";
  resetCaptureUserId();

  const row = buildRow("prompt", "unknown user captured interaction", { sessionId: "sess-unknown" });
  db.prepare(INSERT_SQL).run(row.ts, row.session_id, row.kind, row.content, row.meta, row.user_id);

  // Verify the row was inserted with user_id = NULL
  const inserted = db.prepare("SELECT user_id FROM interactions WHERE content = 'unknown user captured interaction'").get();
  assert.equal(inserted.user_id, null, "unknown user interaction must have user_id = NULL");

  // Owner sees it
  setIdentity(enforced(["owner"]));
  const ownerSearch = await asScoped(enforced(["owner"]), "search_history", () =>
    searchHistoryHandler({ query: "unknown user", limit: 10 })
  );
  const ownerText = textOf(ownerSearch);
  assert.ok(ownerText.includes("unknown user captured interaction"), "owner sees NULL interaction");

  // Writer does NOT see it
  setIdentity(enforced(["writer"], "alice", aliceUid));
  const writerSearch = await asScoped(enforced(["writer"], "alice", aliceUid), "search_history", () =>
    searchHistoryHandler({ query: "unknown user", limit: 10 })
  );
  const writerText = textOf(writerSearch);
  assert.equal(writerText.includes("unknown user captured interaction"), false, "writer does NOT see NULL interaction");
});

// -------------------------------------------------- Enforcement + no MEMORY_CAPTURE_USER ---

test("enforcement + no MEMORY_CAPTURE_USER: interaction has user_id=NULL (anonymous)", async () => {
  delete process.env.MEMORY_CAPTURE_USER;
  resetCaptureUserId();

  const row = buildRow("prompt", "anonymous captured interaction", { sessionId: "sess-anon2" });
  db.prepare(INSERT_SQL).run(row.ts, row.session_id, row.kind, row.content, row.meta, row.user_id);

  // Verify the row was inserted with user_id = NULL
  const inserted = db.prepare("SELECT user_id FROM interactions WHERE content = 'anonymous captured interaction'").get();
  assert.equal(inserted.user_id, null, "anonymous interaction must have user_id = NULL");

  // Owner sees it
  setIdentity(enforced(["owner"]));
  const ownerSearch = await asScoped(enforced(["owner"]), "search_history", () =>
    searchHistoryHandler({ query: "anonymous captured", limit: 10 })
  );
  const ownerText = textOf(ownerSearch);
  assert.ok(ownerText.includes("anonymous captured interaction"), "owner sees NULL interaction");

  // Writer does NOT see it
  setIdentity(enforced(["writer"], "alice", aliceUid));
  const writerSearch = await asScoped(enforced(["writer"], "alice", aliceUid), "search_history", () =>
    searchHistoryHandler({ query: "anonymous captured", limit: 10 })
  );
  const writerText = textOf(writerSearch);
  assert.equal(writerText.includes("anonymous captured interaction"), false, "writer does NOT see NULL interaction");
});

// -------------------------------------------------- Legacy mode (MEMORY_AUTH unset) ---

test("legacy mode (MEMORY_AUTH unset): all interactions visible regardless of MEMORY_CAPTURE_USER", async () => {
  // Set MEMORY_CAPTURE_USER but keep MEMORY_AUTH unset
  process.env.MEMORY_CAPTURE_USER = "alice";
  resetCaptureUserId();

  const row = buildRow("prompt", "legacy mode interaction", { sessionId: "sess-legacy" });
  db.prepare(INSERT_SQL).run(row.ts, row.session_id, row.kind, row.content, row.meta, row.user_id);

  // Also insert bob and NULL interactions
  insertInteraction("2026-01-01T00:00:00.000Z", "sess-bob2", "prompt", "bob legacy interaction", bobUid);
  insertInteraction("2026-01-01T00:00:01.000Z", "sess-anon3", "prompt", "anon legacy interaction", null);

  // In legacy mode, identity is legacy
  setIdentity(LEGACY);

  const search = await searchHistoryHandler({ query: "legacy", limit: 20 });
  const text = textOf(search);
  assert.ok(text.includes("legacy mode interaction"), "legacy sees alice's interaction");
  assert.ok(text.includes("bob legacy interaction"), "legacy sees bob's interaction");
  assert.ok(text.includes("anon legacy interaction"), "legacy sees NULL interaction");

  const recent = await getRecentInteractionsHandler({ limit: 20 });
  const recentText = textOf(recent);
  assert.ok(recentText.includes("legacy mode interaction"));
  assert.ok(recentText.includes("bob legacy interaction"));
  assert.ok(recentText.includes("anon legacy interaction"));

  const recall = await recallHandler({ topic: "interaction", limit: 20 });
  const recallText = textOf(recall);
  assert.ok(recallText.includes("legacy mode interaction"));
  assert.ok(recallText.includes("bob legacy interaction"));
  assert.ok(recallText.includes("anon legacy interaction"));
});

// -------------------------------------------------- Sync guard ---

test("sync guard: scripts/check-capture-sync.mjs passes (14 patterns match)", async () => {
  // This test verifies the sync check passes by importing and running it
  const { runCaptureSyncChecks } = await import("../scripts/check-capture-sync.mjs");
  const { checks, summary } = runCaptureSyncChecks();
  const failed = checks.filter((c) => !c.ok);
  assert.equal(failed.length, 0, `Sync checks failed: ${failed.map(f => f.name + ": " + f.detail).join("; ")}`);
  assert.equal(summary.secretPatternCount, 14, "Must have 14 SECRET_PATTERNS");
  assert.deepEqual(summary.limits, { prompt: 4000, tool_call: 500, error: 500 });
});