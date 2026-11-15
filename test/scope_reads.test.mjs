import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const workDir = mkdtempSync(join(tmpdir(), "th-auth-p3-reads-"));
const dbPath = join(workDir, "reads.db");

process.env.MEMORY_DB_PATH = dbPath;
process.env.MEMORY_BACKUP_ON_MIGRATE = "0";
delete process.env.MEMORY_AUTH;
delete process.env.MEMORY_AUTH_TOKEN;
delete process.env.MEMORY_AUTH_TOKEN_FILE;
delete process.env.MEMORY_CAPTURE_USER;

const { db } = await import("../dist/db/index.js");
const { ensureUser } = await import("../dist/db/repositories/users.js");
const { addGrant, removeGrant } = await import(
  "../dist/db/repositories/scope_grants.js"
);
const { createMemory } = await import("../dist/db/repositories/memories.js");
const { setIdentity } = await import("../dist/auth/identity.js");
const {
  bindScopeToIdentity,
  getEffectiveScope,
  runWithScope,
} = await import("../dist/auth/scope-resolver.js");
const { getProfileHandler } = await import("../dist/tools/profile.js");
const { recallHandler } = await import("../dist/tools/recall.js");
const { memoryStatsHandler } = await import("../dist/tools/memory_stats.js");
const { searchHistoryHandler } = await import("../dist/tools/history.js");
const { getRecentInteractionsHandler } = await import(
  "../dist/tools/recent_interactions.js"
);
const { exportMemoryHandler } = await import("../dist/tools/export_memory.js");
const { saveLessonHandler } = await import("../dist/tools/lesson.js");
const { rememberHandler } = await import("../dist/tools/remember.js");

const aliceUid = ensureUser("alice");
const bobUid = ensureUser("bob");
const carolUid = ensureUser("carol");

setIdentity({ mode: "legacy", roles: [] });

// Seed data using handlers where FTS indexing is needed
// Alice's data in legacy mode (user_id = NULL)
await rememberHandler({ category: "coding", key: "alice_pref", value: "alice owns this" });
await rememberHandler({ category: "coding", key: "shared_pref", value: "everyone sees this" });
await saveLessonHandler({ situation: "alice lesson", mistake: "none", correction: "alice correction" });
await saveLessonHandler({ situation: "shared lesson", mistake: "none", correction: "shared correction" });

// Bob's data in enforced mode as bob (user_id = bobUid)
setIdentity({ mode: "enforced", userId: "bob", uid: bobUid, roles: ["writer"] });
const bobScope = bindScopeToIdentity({ mode: "enforced", userId: "bob", uid: bobUid, roles: ["writer"] }, {}, "remember");
await runWithScope(bobScope.scope, async () => {
  await rememberHandler({ category: "coding", key: "bob_pref", value: "bob owns this" });
  await saveLessonHandler({ situation: "bob lesson", mistake: "none", correction: "bob correction" });
});

setIdentity({ mode: "legacy", roles: [] });

const insertInteraction = db.prepare(
  "INSERT INTO interactions (ts, session_id, kind, content, user_id) VALUES (?, ?, ?, ?, ?)"
);
insertInteraction.run(
  "2026-01-01T00:00:00.000Z",
  "sess-alice",
  "prompt",
  "alice interaction",
  aliceUid
);
insertInteraction.run(
  "2026-01-01T00:00:01.000Z",
  "sess-bob",
  "prompt",
  "bob interaction",
  bobUid
);
insertInteraction.run(
  "2026-01-01T00:00:02.000Z",
  "sess-shared",
  "prompt",
  "shared interaction",
  null
);
insertInteraction.run(
  "2026-01-01T00:00:03.000Z",
  "sess-alice",
  "tool_call",
  "alice tool call",
  aliceUid
);

createMemory({
  type: "FACT",
  content: "alice user memory",
  userId: "alice",
});
createMemory({
  type: "FACT",
  content: "bob user memory",
  userId: "bob",
});
createMemory({
  type: "FACT",
  content: "global shared memory",
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
  console.log('[DEBUG bind] identity:', JSON.stringify(identity));
  console.log('[DEBUG bind] args:', JSON.stringify(args));
  console.log('[DEBUG bind] toolName:', toolName);
  const result = bindScopeToIdentity(identity, args, toolName);
  console.log('[DEBUG bind] result:', JSON.stringify(result));
  assert.equal(result.ok, true, `bind ${toolName} must succeed: ${JSON.stringify(result)}`);
  return result.scope;
}

function asScoped(identity, toolName, fn, args = {}) {
  const scope = bind(identity, args, toolName);
  return runWithScope(scope, fn);
}

const textOf = (result) =>
  (result?.content ?? []).map((c) => c.text).join("\n");

// ---------------------------------------------------- get_profile no args -> GLOBAL-only ---

test("get_profile: enforced with no args returns GLOBAL-only memories (plan §9.2)", async () => {
  setIdentity(enforced(["owner"]));
  const result = await asScoped(enforced(["owner"]), "get_profile", () =>
    getProfileHandler({})
  );
  const text = textOf(result);
  assert.notEqual(result.isError, true, text);
  assert.ok(text.includes("global shared memory"), "GLOBAL memory must appear");
  assert.equal(
    text.includes("alice user memory"),
    false,
    "own USER memory must NOT appear without userId arg"
  );
  assert.equal(
    text.includes("bob user memory"),
    false,
    "foreign USER memory must NOT appear"
  );
});

test("get_profile: enforced with own userId includes own USER rows", async () => {
  setIdentity(enforced(["owner"]));
  // Debug: check what memories are in the DB
  const allMems = db.prepare("SELECT id, content, scope, user_id FROM memories").all();
  console.log('[DEBUG TEST] All memories:', JSON.stringify(allMems, null, 2));
  
  const result = await asScoped(enforced(["owner"]), "get_profile", () =>
    getProfileHandler({ userId: "alice" })
  , { userId: "alice" });
  const text = textOf(result);
  assert.notEqual(result.isError, true, text);
  console.log('[DEBUG TEST] getProfile output:', text);
  assert.ok(text.includes("global shared memory"), "GLOBAL memory must appear");
  assert.ok(text.includes("alice user memory"), "own USER memory must appear");
  assert.equal(
    text.includes("bob user memory"),
    false,
    "foreign USER memory must NOT appear"
  );
});

// ---------------------------------------------------------- recall isolation ---

test("recall: enforced returns own + NULL prefs/lessons, never another user's", async () => {
  setIdentity(enforced(["owner"]));
  const result = await asScoped(enforced(["owner"]), "recall", () =>
    recallHandler({ topic: "pref", limit: 20 })
  );
  const text = textOf(result);
  assert.notEqual(result.isError, true, text);
  assert.ok(text.includes("shared_pref"), "NULL/shared pref must appear");
  assert.ok(text.includes("alice owns this"), "own pref must appear");
  assert.equal(
    text.includes("bob owns this"),
    false,
    "foreign pref must NOT appear"
  );
});

test("recall: enforced returns own + NULL lessons, never another user's", async () => {
  setIdentity(enforced(["owner"]));
  const result = await asScoped(enforced(["owner"]), "recall", () =>
    recallHandler({ topic: "lesson", limit: 20 })
  );
  const text = textOf(result);
  assert.notEqual(result.isError, true, text);
  assert.ok(text.includes("shared lesson"), "NULL/shared lesson must appear");
  assert.ok(text.includes("alice correction"), "own lesson must appear");
  assert.equal(
    text.includes("bob correction"),
    false,
    "foreign lesson must NOT appear"
  );
});

test("recall: owner sees NULL interactions, non-owner does not", async () => {
  setIdentity(enforced(["owner"]));
  const ownerResult = await asScoped(enforced(["owner"]), "recall", () =>
    recallHandler({ topic: "interaction", limit: 20 })
  );
  const ownerText = textOf(ownerResult);
  assert.ok(ownerText.includes("shared interaction"), "owner sees NULL interaction");

  setIdentity(enforced(["writer"], "alice", aliceUid));
  const writerResult = await asScoped(enforced(["writer"]), "recall", () =>
    recallHandler({ topic: "interaction", limit: 20 })
  );
  const writerText = textOf(writerResult);
  assert.equal(
    writerText.includes("shared interaction"),
    false,
    "writer does NOT see NULL interaction"
  );
});

// --------------------------------------------------------- memory_stats isolation ---

test("memory_stats: enforced counts only visible interactions/prefs/lessons", async () => {
  setIdentity(enforced(["owner"]));
  const result = await asScoped(enforced(["owner"]), "memory_stats", () =>
    memoryStatsHandler()
  );
  const text = textOf(result);
  assert.notEqual(result.isError, true, text);
  // owner: alice(2) + NULL(1) = 3 interactions (bob's hidden)
  assert.ok(text.includes("interactions: 3 total"), `expected 'interactions: 3 total' in: ${text}`);
  // owner sees NULL prefs/lessons (alice's legacy prefs are NULL, not own with user_id=aliceUid)
  assert.ok(text.includes("preferences: 2"), `expected 'preferences: 2' in: ${text}`);
  assert.ok(text.includes("lessons: 2"), `expected 'lessons: 2' in: ${text}`);

  setIdentity(enforced(["writer"], "alice", aliceUid));
  const writerResult = await asScoped(enforced(["writer"]), "memory_stats", () =>
    memoryStatsHandler()
  );
  const writerText = textOf(writerResult);
  // writer: alice(2) = 2 interactions (NULL hidden for non-owner, bob's hidden)
  assert.ok(writerText.includes("interactions: 2 total"), `expected 'interactions: 2 total' in: ${writerText}`);
  // writer sees NULL prefs/lessons (shared) but no own prefs with user_id=aliceUid
  assert.ok(writerText.includes("preferences: 2"), `expected 'preferences: 2' in: ${writerText}`);
  assert.ok(writerText.includes("lessons: 2"), `expected 'lessons: 2' in: ${writerText}`);
});

// --------------------------------------------------- search_history / recent_interactions ---

test("search_history: enforced returns own rows, hides foreign, NULL only for owner", async () => {
  setIdentity(enforced(["owner"]));
  const ownerResult = await asScoped(enforced(["owner"]), "search_history", () =>
    searchHistoryHandler({ query: "interaction", limit: 10 })
  );
  const ownerText = textOf(ownerResult);
  assert.ok(ownerText.includes("alice interaction"), "own row");
  assert.equal(ownerText.includes("bob interaction"), false, "foreign row hidden");
  assert.ok(ownerText.includes("shared interaction"), "owner sees NULL");

  setIdentity(enforced(["writer"], "alice", aliceUid));
  const writerResult = await asScoped(enforced(["writer"]), "search_history", () =>
    searchHistoryHandler({ query: "interaction", limit: 10 })
  );
  const writerText = textOf(writerResult);
  assert.ok(writerText.includes("alice interaction"));
  assert.equal(writerText.includes("bob interaction"), false);
  assert.equal(writerText.includes("shared interaction"), false, "writer does NOT see NULL");
});

test("get_recent_interactions: enforced returns own rows, hides foreign, NULL only for owner", async () => {
  setIdentity(enforced(["owner"]));
  const ownerResult = await asScoped(enforced(["owner"]), "get_recent_interactions", () =>
    getRecentInteractionsHandler({ limit: 20 })
  );
  const ownerText = textOf(ownerResult);
  assert.ok(ownerText.includes("alice interaction"));
  assert.equal(ownerText.includes("bob interaction"), false);
  assert.ok(ownerText.includes("shared interaction"));

  setIdentity(enforced(["writer"], "alice", aliceUid));
  const writerResult = await asScoped(enforced(["writer"]), "get_recent_interactions", () =>
    getRecentInteractionsHandler({ limit: 20 })
  );
  const writerText = textOf(writerResult);
  assert.ok(writerText.includes("alice interaction"));
  assert.equal(writerText.includes("bob interaction"), false);
  assert.equal(writerText.includes("shared interaction"), false);
});

test("search_history / get_recent_interactions: sessionId filter works WITHOUT a grant (filter-only rule)", async () => {
  // Alice has no SESSION grant on "sess-alice" but the tool is in FILTER_ONLY_SCOPE_TOOLS
  // so a sessionId filter should work (it narrows, never widens).
  setIdentity(enforced(["writer"], "alice", aliceUid));
  const searchResult = await asScoped(
    enforced(["writer"]),
    "search_history",
    () => searchHistoryHandler({ query: "alice", limit: 10, sessionId: "sess-alice" }),
    { query: "alice", limit: 10, sessionId: "sess-alice" }
  );
  const searchText = textOf(searchResult);
  assert.ok(searchText.includes("alice interaction"), "session filter works without grant");

  const recentResult = await asScoped(
    enforced(["writer"]),
    "get_recent_interactions",
    () => getRecentInteractionsHandler({ limit: 20, sessionId: "sess-alice" }),
    { limit: 20, sessionId: "sess-alice" }
  );
  const recentText = textOf(recentResult);
  assert.ok(recentText.includes("alice interaction"));
  assert.equal(recentText.includes("alice tool call"), true, "same session, different kind");
  assert.equal(recentText.includes("bob interaction"), false, "other session excluded");
});

// ----------------------------------------------------------- export_memory ---

test("export_memory: enforced with no args exports GLOBAL-only memories (per requested flags)", async () => {
  setIdentity(enforced(["owner"]));
  const result = await asScoped(enforced(["owner"]), "export_memory", () =>
    exportMemoryHandler({ includeInteractions: true })
  );
  const text = textOf(result);
  assert.notEqual(result.isError, true, text);
  assert.ok(text.includes("exported:"), text);

  const filePathMatch = text.match(/exported: (.+)\nsize:/);
  assert.ok(filePathMatch, "export path must be in output");
  const filePath = filePathMatch[1].trim();
  const exported = JSON.parse(
    await import("node:fs").then((fs) => fs.promises.readFile(filePath, "utf8"))
  );

  // Memories: only GLOBAL (no userId requested)
  const memoryContents = exported.memories.map((m) => m.content);
  assert.equal(
    memoryContents.includes("alice user memory"),
    false,
    "own USER memory excluded without userId arg"
  );
  assert.ok(memoryContents.includes("global shared memory"), "GLOBAL memory exported");
  assert.equal(
    memoryContents.includes("bob user memory"),
    false,
    "foreign USER memory excluded"
  );
});

test("export_memory: enforced with own userId exports own USER + GLOBAL memories", async () => {
  setIdentity(enforced(["owner"]));
  const result = await asScoped(enforced(["owner"]), "export_memory", () =>
    exportMemoryHandler({ includeInteractions: true, userId: "alice" })
  , { includeInteractions: true, userId: "alice" });
  const text = textOf(result);
  assert.notEqual(result.isError, true, text);

  const filePathMatch = text.match(/exported: (.+)\nsize:/);
  assert.ok(filePathMatch);
  const filePath = filePathMatch[1].trim();
  const exported = JSON.parse(
    await import("node:fs").then((fs) => fs.promises.readFile(filePath, "utf8"))
  );

  const memoryContents = exported.memories.map((m) => m.content);
  assert.ok(memoryContents.includes("alice user memory"), "own USER memory exported");
  assert.ok(memoryContents.includes("global shared memory"), "GLOBAL memory exported");
  assert.equal(
    memoryContents.includes("bob user memory"),
    false,
    "foreign USER memory excluded"
  );

  // Preferences: only alice's + NULL/shared (bob's excluded)
  const prefKeys = exported.preferences.map((p) => p.key);
  assert.ok(prefKeys.includes("alice_pref"), "own pref exported");
  assert.ok(prefKeys.includes("shared_pref"), "shared pref exported");
  assert.equal(
    prefKeys.includes("bob_pref"),
    false,
    "foreign pref excluded"
  );

  // Lessons: only alice's + NULL/shared (bob's excluded)
  const lessonSituations = exported.lessons.map((l) => l.situation);
  assert.ok(lessonSituations.includes("alice lesson"), "own lesson exported");
  assert.ok(lessonSituations.includes("shared lesson"), "shared lesson exported");
  assert.equal(
    lessonSituations.includes("bob lesson"),
    false,
    "foreign lesson excluded"
  );

  // Interactions: only alice's + NULL (owner) (bob's excluded)
  const interactionContents = exported.interactions.rows.map((r) => r.content);
  assert.ok(interactionContents.includes("alice interaction"), "own interaction exported");
  assert.ok(interactionContents.includes("shared interaction"), "owner sees NULL interaction");
  assert.equal(
    interactionContents.includes("bob interaction"),
    false,
    "foreign interaction excluded"
  );

  // Users/Entities/Relations/Links/Profile: unchanged (shared)
  assert.ok(exported.users.length >= 3, "users exported (shared)");
  assert.ok(exported.entities.length >= 0, "entities exported");
  assert.ok(exported.relations.length >= 0, "relations exported");
  assert.ok(exported.memoryLinks.length >= 0, "links exported");
  assert.ok(exported.profile.length >= 0, "profile exported");
});

// ----------------------------------------------------------- legacy mode unchanged ---

test("legacy mode: get_profile/recall/memory_stats/search_history/recent_interactions/export_memory return everything", async () => {
  setIdentity(LEGACY);

  const profile = await getProfileHandler({});
  const recall = await recallHandler({ topic: "pref", limit: 20 });
  const stats = await memoryStatsHandler();
  const search = await searchHistoryHandler({ query: "interaction", limit: 10 });
  const recent = await getRecentInteractionsHandler({ limit: 20 });
  const exportRes = await exportMemoryHandler({ includeInteractions: true });

  assert.notEqual(profile.isError, true, textOf(profile));
  assert.notEqual(recall.isError, true, textOf(recall));
  assert.notEqual(stats.isError, true, textOf(stats));
  assert.notEqual(search.isError, true, textOf(search));
  assert.notEqual(recent.isError, true, textOf(recent));
  assert.notEqual(exportRes.isError, true, textOf(exportRes));

  const statsText = textOf(stats);
  // Legacy counts everything
  assert.ok(statsText.includes("interactions: 4 total"));
  assert.ok(statsText.includes("preferences: 3"));
  assert.ok(statsText.includes("lessons: 3"));

  const recallText = textOf(recall);
  assert.ok(recallText.includes("bob owns this"), "legacy sees foreign prefs");

  const searchText = textOf(search);
  assert.ok(searchText.includes("bob interaction"), "legacy sees foreign interactions");

  const exportText = textOf(exportRes);
  const exportFile = exportText.match(/exported: (.+)\nsize:/)[1].trim();
  const exported = JSON.parse(
    await import("node:fs").then((fs) => fs.promises.readFile(exportFile, "utf8"))
  );
  assert.ok(
    exported.memories.some((m) => m.content === "bob user memory"),
    "legacy exports foreign memories"
  );
  assert.ok(
    exported.preferences.some((p) => p.key === "bob_pref"),
    "legacy exports foreign prefs"
  );
});

// ------------------------------------------------------------ resolver unit: requested flags ---

test("resolver: requested flags are false when no scope args supplied", () => {
  const scope = bind(enforced(["reader"]), {}, "recall");
  assert.equal(scope.requested.userId, false);
  assert.equal(scope.requested.sessionId, false);
  assert.equal(scope.requested.projectId, false);
});

test("resolver: requested flags are true for supplied dims on tools that accept them", () => {
  // get_profile accepts userId, sessionId, projectId
  const scope1 = bind(enforced(["reader"]), { userId: "alice" }, "get_profile");
  assert.equal(scope1.requested.userId, true);
  assert.equal(scope1.requested.sessionId, false);
  assert.equal(scope1.requested.projectId, false);

  // get_profile requires a grant for sessionId (not a filter-only tool)
  addGrant(aliceUid, "SESSION", "sess-1", "read");
  const scope2 = bind(enforced(["reader"]), { sessionId: "sess-1" }, "get_profile");
  assert.equal(scope2.requested.userId, false);
  assert.equal(scope2.requested.sessionId, true);
  assert.equal(scope2.requested.projectId, false);
  removeGrant(aliceUid, "SESSION", "sess-1", "read");

  // get_context requires a grant for projectId
  addGrant(aliceUid, "PROJECT", "proj-1", "read");
  const scope3 = bind(enforced(["reader"]), { projectId: "proj-1" }, "get_context");
  assert.equal(scope3.requested.userId, false);
  assert.equal(scope3.requested.sessionId, false);
  assert.equal(scope3.requested.projectId, true);
  removeGrant(aliceUid, "PROJECT", "proj-1", "read");

  // get_profile with all three dims needs grants for sessionId and projectId
  addGrant(aliceUid, "SESSION", "s-1", "read");
  addGrant(aliceUid, "PROJECT", "p-1", "read");
  const scope4 = bind(enforced(["reader"]), { userId: "alice", sessionId: "s-1", projectId: "p-1" }, "get_profile");
  assert.equal(scope4.requested.userId, true);
  assert.equal(scope4.requested.sessionId, true);
  assert.equal(scope4.requested.projectId, true);
  removeGrant(aliceUid, "SESSION", "s-1", "read");
  removeGrant(aliceUid, "PROJECT", "p-1", "read");

  // search_history accepts sessionId (filter-only, no grant needed)
  const scope5 = bind(enforced(["reader"]), { sessionId: "sess-1" }, "search_history");
  assert.equal(scope5.requested.sessionId, true);

  // get_recent_interactions accepts sessionId (filter-only, no grant needed)
  const scope6 = bind(enforced(["reader"]), { sessionId: "sess-1" }, "get_recent_interactions");
  assert.equal(scope6.requested.sessionId, true);
});