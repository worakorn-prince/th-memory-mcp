// Ph-6 A4: enforced-mode `export_memory` may not emit another identity's
// users / entities / relations / memory_links (v3.0.0 leaked all four), while
// legacy mode (MEMORY_AUTH off) must stay byte-identical to v3.0.0.
//
// The legacy assertion compares the parsed payload arrays against an oracle
// built from the exact v3.0.0 (pre-change) SQL, so "byte-identical" is checked
// against the previous query set rather than against the new code's own output.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const workDir = mkdtempSync(join(tmpdir(), "th-auth-p6-export-scope-"));
const dbPath = join(workDir, "export-scope.db");

process.env.MEMORY_DB_PATH = dbPath;
process.env.MEMORY_BACKUP_ON_MIGRATE = "0";
delete process.env.MEMORY_AUTH;
delete process.env.MEMORY_AUTH_TOKEN;
delete process.env.MEMORY_AUTH_TOKEN_FILE;
delete process.env.MEMORY_CAPTURE_USER;

const { db } = await import("../dist/db/index.js");
const { ensureUser } = await import("../dist/db/repositories/users.js");
const { createMemory, getMemoryById } = await import(
  "../dist/db/repositories/memories.js"
);
const { setIdentity } = await import("../dist/auth/identity.js");
const { bindScopeToIdentity, runWithScope } = await import(
  "../dist/auth/scope-resolver.js"
);
const { exportMemoryHandler } = await import("../dist/tools/export_memory.js");
const { rememberHandler } = await import("../dist/tools/remember.js");
const { saveLessonHandler } = await import("../dist/tools/lesson.js");
const { VERSION } = await import("../dist/lib/config.js");
const { createEntity, addRelation, linkMemories } = await import(
  "../dist/core/graph-engine.js"
);

const aliceUid = ensureUser("alice");
const bobUid = ensureUser("bob");
// carol owns nothing: her users row must never appear in an enforced export.
ensureUser("carol");

const LEGACY = { mode: "legacy", roles: [] };
const enforcedAlice = { mode: "enforced", userId: "alice", uid: aliceUid, roles: ["owner"] };
const enforcedBob = { mode: "enforced", userId: "bob", uid: bobUid, roles: ["owner"] };

const insertInteractionStmt = db.prepare(
  "INSERT INTO interactions (ts, session_id, kind, content, user_id) VALUES (?, ?, 'prompt', ?, ?)"
);
const insertInteraction = (ts, sessionId, content, userId) =>
  insertInteractionStmt.run(ts, sessionId, content, userId);

// ------------------------------------------------------------------ seed data ---

setIdentity(LEGACY);

// Shared (GLOBAL / NULL-owner) fixture.
const sharedPref = await rememberHandler({
  category: "coding",
  key: "p6_shared_pref",
  value: "shared pref value probe",
});
const sharedLesson = await saveLessonHandler({
  situation: "p6 shared lesson",
  mistake: "none",
  correction: "shared lesson correction probe",
});
const globalMemory = createMemory({ type: "FACT", content: "p6 global memory probe" });
const globalMemory2 = createMemory({ type: "FACT", content: "p6 global memory probe 2" });
linkMemories(globalMemory, globalMemory2, "related_to");
const sharedEntityA = createEntity({ name: "P6SharedAlpha", type: "concept" });
const sharedEntityB = createEntity({ name: "P6SharedBeta", type: "concept" });
addRelation({
  subjectId: sharedEntityA,
  predicate: "related_to",
  objectId: sharedEntityB,
  confidence: 0.9,
});
insertInteraction("2026-04-01T00:00:00.000Z", "sess-shared", "p6 shared interaction probe", null);

// Alice's own fixture (written under her bound scope so user_id is set).
const alicePref = await runWithScope(
  bindScopeToIdentity(enforcedAlice, {}, "remember").scope,
  () =>
    rememberHandler({
      category: "coding",
      key: "p6_alice_pref",
      value: "alice pref value probe",
    })
);
const aliceLesson = await runWithScope(
  bindScopeToIdentity(enforcedAlice, {}, "save_lesson").scope,
  () =>
    saveLessonHandler({
      situation: "p6 alice lesson",
      mistake: "none",
      correction: "alice lesson correction probe",
    })
);
const aliceMemory = createMemory({
  type: "FACT",
  content: "p6 alice memory probe",
  userId: "alice",
});
const aliceMemory2 = createMemory({
  type: "FACT",
  content: "p6 alice memory probe 2",
  userId: "alice",
});
linkMemories(aliceMemory, aliceMemory2, "related_to");
insertInteraction("2026-04-01T00:00:01.000Z", "sess-alice", "p6 alice interaction probe", aliceUid);

// Bob's own fixture, including graph rows sourced from his memory.
const bobMemory = createMemory({
  type: "FACT",
  content: "p6 bob memory probe",
  userId: "bob",
});
const bobMemory2 = createMemory({
  type: "FACT",
  content: "p6 bob memory probe 2",
  userId: "bob",
});
linkMemories(bobMemory, bobMemory2, "related_to");
const bobEntityA = createEntity({ name: "P6BobSecretAlpha", type: "concept" });
const bobEntityB = createEntity({ name: "P6BobSecretBeta", type: "concept" });
addRelation({
  subjectId: bobEntityA,
  predicate: "related_to",
  objectId: bobEntityB,
  confidence: 0.9,
  sourceMemoryId: bobMemory,
});
const bobPref = await runWithScope(
  bindScopeToIdentity(enforcedBob, {}, "remember").scope,
  () =>
    rememberHandler({
      category: "coding",
      key: "p6_bob_pref",
      value: "bob pref value probe",
    })
);
const bobLesson = await runWithScope(
  bindScopeToIdentity(enforcedBob, {}, "save_lesson").scope,
  () =>
    saveLessonHandler({
      situation: "p6 bob lesson",
      mistake: "none",
      correction: "bob lesson correction probe",
    })
);
insertInteraction("2026-04-01T00:00:02.000Z", "sess-bob", "p6 bob interaction probe", bobUid);

// A legacy cross-owner link (created before scoping existed): alice -> bob.
linkMemories(aliceMemory, bobMemory, "related_to");
// An entity no relation references: graph-internal, not exported in enforced mode.
createEntity({ name: "P6OrphanEntity", type: "concept" });

setIdentity(LEGACY);

test.after(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  rmSync(workDir, { recursive: true, force: true });
});

// -------------------------------------------------------------------- helpers ---

const textOf = (result) =>
  (result?.content ?? []).map((c) => c.text).join("\n");

async function exportAs(identity, args, filename) {
  setIdentity(identity);
  const payloadArgs = { ...args, filename };
  const run = identity.mode === "legacy"
    ? exportMemoryHandler(payloadArgs)
    : (() => {
        const bound = bindScopeToIdentity(identity, payloadArgs, "export_memory");
        assert.equal(
          bound.ok,
          true,
          `bind export_memory must succeed: ${JSON.stringify(bound)}`
        );
        return runWithScope(bound.scope, () => exportMemoryHandler(payloadArgs));
      })();
  const result = await run;
  assert.notEqual(result.isError, true, textOf(result));
  const filePath = textOf(result).match(/exported: (.+)\r?\nsize:/);
  assert.ok(filePath, `export path must be printed: ${textOf(result)}`);
  return JSON.parse(readFileSync(filePath[1].trim(), "utf8"));
}

const parseMeta = (raw) => {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
};

/**
 * The v3.0.0 (pre-change) export query set, verbatim. Used as the oracle for
 * "legacy mode is byte-identical": every array the handler emits must equal the
 * rows these unscoped statements return for the same fixture.
 */
function preChangeSnapshot() {
  return {
    memories: db
      .prepare(
        `SELECT m.id, m.type, m.content, m.summary, m.status, m.source,
                m.confidence, m.importance, m.salience, m.project_id AS projectId,
                m.session_id AS sessionId, u.external_id AS userId,
                m.valid_from AS validFrom, m.valid_until AS validUntil, m.metadata
         FROM memories m
         LEFT JOIN users u ON u.id = m.user_id
         WHERE m.status <> 'deleted'
         ORDER BY m.id`
      )
      .all()
      .map((m) => ({ ...m, metadata: parseMeta(m.metadata) })),
    memoryLinks: db
      .prepare(
        `SELECT l.source_memory_id AS sourceId, l.relation,
                l.target_memory_id AS targetId, l.confidence, l.created_at AS createdAt
         FROM memory_links l
         JOIN memories s ON s.id = l.source_memory_id AND s.status <> 'deleted'
         JOIN memories t ON t.id = l.target_memory_id AND t.status <> 'deleted'
         ORDER BY l.source_memory_id, l.target_memory_id`
      )
      .all(),
    users: db
      .prepare(
        "SELECT id, external_id AS externalId, name, created_at AS createdAt FROM users ORDER BY id"
      )
      .all(),
    entities: db
      .prepare(
        "SELECT id, name, canonical_name AS canonicalName, type, metadata FROM entities ORDER BY id"
      )
      .all()
      .map((e) => ({ ...e, metadata: parseMeta(e.metadata) })),
    relations: db
      .prepare(
        `SELECT r.id, r.source_entity_id AS sourceEntityId, r.relation,
                r.target_entity_id AS targetEntityId, r.confidence,
                r.valid_from AS validFrom, r.valid_until AS validUntil,
                r.source_memory_id AS sourceMemoryId, r.metadata
         FROM relations r
         LEFT JOIN memories m ON m.id = r.source_memory_id
         WHERE r.source_memory_id IS NULL OR m.status <> 'deleted'
         ORDER BY r.id`
      )
      .all()
      .map((r) => ({ ...r, metadata: parseMeta(r.metadata) })),
    preferences: db
      .prepare(
        "SELECT id, category, key, value, confidence, source, updated_at FROM preferences ORDER BY id"
      )
      .all(),
    lessons: db
      .prepare(
        "SELECT id, situation, mistake, correction, created_at FROM lessons ORDER BY id"
      )
      .all(),
    profile: db
      .prepare("SELECT section, content, updated_at FROM profile ORDER BY section")
      .all(),
    interactions: db
      .prepare(
        "SELECT id, ts, session_id, kind, content, meta FROM interactions ORDER BY id"
      )
      .all(),
  };
}

const json = (value) => JSON.stringify(value);

// ------------------------------------------------- enforced: no foreign rows ---

test("A4: alice's enforced export contains none of bob's rows (users/entities/relations/links)", async () => {
  const payload = await exportAs(
    enforcedAlice,
    { includeInteractions: true, userId: "alice" },
    "p6-enforced-alice.json"
  );

  assert.deepEqual(
    payload.memories.map((m) => m.id).filter((id) => id === bobMemory || id === bobMemory2),
    [],
    "bob's memories must not be exported"
  );
  assert.ok(
    !json(payload.memories).includes("p6 bob memory probe"),
    "no bob memory content"
  );

  assert.deepEqual(payload.users.map((u) => u.externalId), ["alice"], "own users row only");
  assert.deepEqual(payload.users.map((u) => u.id), [aliceUid]);
  assert.ok(!json(payload.users).includes("carol"), "unrelated user must not appear");
  assert.ok(!json(payload.users).includes("bob"), "bob's users row must not appear");

  const entityNames = payload.entities.map((e) => e.name);
  assert.ok(!entityNames.includes("P6BobSecretAlpha"), "bob's entity must not be exported");
  assert.ok(!entityNames.includes("P6BobSecretBeta"), "bob's entity must not be exported");
  assert.ok(!json(payload.entities).includes("P6BobSecret"), "no bob entity name anywhere");

  assert.equal(
    payload.relations.some((r) => r.sourceMemoryId === bobMemory),
    false,
    "a relation sourced from bob's memory must not be exported"
  );
  assert.equal(
    payload.relations.some((r) => r.sourceEntityId === bobEntityA || r.targetEntityId === bobEntityA),
    false,
    "no relation pointing at bob's entities"
  );

  assert.equal(
    payload.memoryLinks.some(
      (l) =>
        l.sourceId === bobMemory ||
        l.targetId === bobMemory ||
        l.sourceId === bobMemory2 ||
        l.targetId === bobMemory2
    ),
    false,
    "no link may have a bob endpoint"
  );
  assert.equal(
    payload.memoryLinks.some((l) => l.sourceId === aliceMemory && l.targetId === bobMemory),
    false,
    "a cross-owner link must be dropped (target not exported)"
  );

  const prefs = payload.preferences.map((p) => p.key);
  assert.equal(prefs.includes("p6_bob_pref"), false, "bob's preference must not be exported");
  assert.equal(
    payload.lessons.some((l) => l.situation === "p6 bob lesson"),
    false,
    "bob's lesson must not be exported"
  );
  assert.equal(
    payload.interactions.rows.some((r) => r.content.includes("p6 bob interaction")),
    false,
    "bob's interaction must not be exported"
  );

  // Catch-all: the literal string "bob" appears nowhere in alice's payload.
  assert.equal(json(payload).includes("bob"), false, "no trace of bob in the payload");
});

test("A4: alice's enforced export keeps her own and GLOBAL rows (positive coverage)", async () => {
  const payload = await exportAs(
    enforcedAlice,
    { includeInteractions: true, userId: "alice" },
    "p6-enforced-alice-positive.json"
  );

  const memoryIds = payload.memories.map((m) => m.id);
  assert.ok(memoryIds.includes(aliceMemory) && memoryIds.includes(aliceMemory2), "own USER memories");
  assert.ok(memoryIds.includes(globalMemory) && memoryIds.includes(globalMemory2), "GLOBAL memories");

  assert.ok(
    payload.memoryLinks.some(
      (l) => l.sourceId === aliceMemory && l.targetId === aliceMemory2
    ),
    "own link (both endpoints exported) is kept"
  );
  assert.ok(
    payload.memoryLinks.some(
      (l) => l.sourceId === globalMemory && l.targetId === globalMemory2
    ),
    "GLOBAL link is kept"
  );

  const entityNames = payload.entities.map((e) => e.name);
  assert.ok(entityNames.includes("P6SharedAlpha"), "entities of a shared (NULL-source) relation are kept");
  assert.ok(entityNames.includes("P6SharedBeta"));
  assert.equal(
    entityNames.includes("P6OrphanEntity"),
    false,
    "an entity no exported relation references is not exported in enforced mode"
  );

  assert.equal(payload.relations.length, 1, "only the shared relation is exported");
  assert.equal(payload.relations[0].sourceMemoryId, null);
  assert.equal(payload.relations[0].sourceEntityId, sharedEntityA);

  const prefKeys = payload.preferences.map((p) => p.key);
  assert.ok(prefKeys.includes("p6_alice_pref"), "own preference");
  assert.ok(prefKeys.includes("p6_shared_pref"), "shared (NULL-owner) preference");
  assert.ok(
    payload.lessons.some((l) => l.situation === "p6 alice lesson"),
    "own lesson"
  );
  assert.ok(
    payload.lessons.some((l) => l.situation === "p6 shared lesson"),
    "shared lesson"
  );
  const interactionContents = payload.interactions.rows.map((r) => r.content);
  assert.ok(interactionContents.includes("p6 alice interaction probe"), "own interaction");
  assert.ok(
    interactionContents.includes("p6 shared interaction probe"),
    "owner sees NULL-owner interactions"
  );
  assert.equal(payload.interactions.count, payload.interactions.rows.length);
  assert.ok(Array.isArray(payload.profile), "profile stays shared by design");

  // Nobody else's memory content can appear through a graph row either.
  assert.equal(
    json(payload.entities).includes("P6BobSecret"),
    false,
    "graph rows cannot smuggle a foreign entity name"
  );
});

test("A4: the no-args enforced export stays GLOBAL-only and leaks no foreign graph", async () => {
  const payload = await exportAs(
    enforcedAlice,
    {},
    "p6-enforced-alice-global.json"
  );

  assert.deepEqual(
    payload.memories.map((m) => m.id),
    [globalMemory, globalMemory2],
    "no userId requested -> GLOBAL memories only"
  );
  assert.deepEqual(payload.users.map((u) => u.id), [aliceUid]);
  assert.deepEqual(
    payload.memoryLinks.map((l) => [l.sourceId, l.targetId]),
    [[globalMemory, globalMemory2]],
    "only the GLOBAL->GLOBAL link is exported"
  );
  assert.deepEqual(payload.relations.map((r) => r.sourceMemoryId), [null]);
  assert.deepEqual(
    payload.entities.map((e) => e.name).sort(),
    ["P6SharedAlpha", "P6SharedBeta"]
  );
  assert.equal(json(payload).includes("bob"), false);
});

test("A4: bob's enforced export is symmetric (no alice rows)", async () => {
  const payload = await exportAs(
    enforcedBob,
    { includeInteractions: true, userId: "bob" },
    "p6-enforced-bob.json"
  );

  assert.deepEqual(payload.users.map((u) => u.externalId), ["bob"]);
  assert.ok(
    payload.memories.some((m) => m.id === bobMemory),
    "bob keeps his own memory"
  );
  assert.equal(
    payload.memories.some((m) => m.id === aliceMemory || m.id === aliceMemory2),
    false,
    "alice's memories are not exported"
  );
  assert.equal(
    payload.memoryLinks.some(
      (l) =>
        l.sourceId === aliceMemory ||
        l.targetId === aliceMemory ||
        l.sourceId === aliceMemory2 ||
        l.targetId === aliceMemory2
    ),
    false,
    "no link may have an alice endpoint"
  );
  // The NULL-source relation and its entities are shared by design, so bob does
  // see them — but nothing alice owns.
  assert.ok(payload.entities.some((e) => e.name === "P6SharedAlpha"), "shared graph is shared");
  assert.equal(json(payload).includes("p6 alice"), false, "no alice-owned content");
  assert.equal(json(payload).includes("acme"), false);
});

// --------------------------------------------------------- legacy unchanged ---

test("A4: legacy export deep-equals the pre-change (v3.0.0) query set", async () => {
  const oracle = preChangeSnapshot();
  const payload = await exportAs(
    LEGACY,
    { includeInteractions: true },
    "p6-legacy.json"
  );

  assert.deepEqual(payload.memories, oracle.memories, "memories array identical to v3.0.0");
  assert.deepEqual(payload.memoryLinks, oracle.memoryLinks, "memoryLinks identical to v3.0.0");
  assert.deepEqual(payload.users, oracle.users, "users identical to v3.0.0");
  assert.deepEqual(payload.entities, oracle.entities, "entities identical to v3.0.0");
  assert.deepEqual(payload.relations, oracle.relations, "relations identical to v3.0.0");
  assert.deepEqual(payload.preferences, oracle.preferences);
  assert.deepEqual(payload.lessons, oracle.lessons);
  assert.deepEqual(payload.profile, oracle.profile);
  assert.deepEqual(payload.interactions.rows, oracle.interactions);
  assert.equal(payload.interactions.included, true);
  assert.equal(payload.interactions.count, oracle.interactions.length);

  // Legacy mode is unscoped: everything is present.
  const userExt = payload.users.map((u) => u.externalId);
  assert.ok(userExt.includes("alice") && userExt.includes("bob") && userExt.includes("carol"));
  assert.ok(payload.entities.some((e) => e.name === "P6BobSecretAlpha"));
  assert.ok(payload.entities.some((e) => e.name === "P6OrphanEntity"));
  assert.ok(payload.relations.some((r) => r.sourceMemoryId === bobMemory));
  assert.ok(
    payload.memoryLinks.some((l) => l.sourceId === aliceMemory && l.targetId === bobMemory),
    "legacy keeps the cross-owner link"
  );
  assert.ok(payload.memories.some((m) => m.id === bobMemory));
  assert.ok(payload.preferences.some((p) => p.key === "p6_bob_pref"));
  assert.ok(payload.lessons.some((l) => l.situation === "p6 bob lesson"));
  assert.ok(payload.interactions.rows.some((r) => r.content.includes("p6 bob interaction")));
});

test("A4: legacy export without interactions keeps included=false and no rows", async () => {
  const oracle = preChangeSnapshot();
  const payload = await exportAs(LEGACY, {}, "p6-legacy-no-interactions.json");
  assert.deepEqual(payload.interactions, { included: false, count: 0 });
  assert.deepEqual(payload.memories, oracle.memories);
  assert.deepEqual(payload.users, oracle.users);
  assert.deepEqual(payload.memoryLinks, oracle.memoryLinks);
});

// -------------------------------------------------------- payload shape/format ---

test("A4: payload keys, key order and format are unchanged in both modes", async () => {
  const expectedKeys = [
    "exported_at",
    "version",
    "format",
    "memories",
    "memoryLinks",
    "users",
    "entities",
    "relations",
    "preferences",
    "lessons",
    "profile",
    "interactions",
  ];

  const legacy = await exportAs(LEGACY, { includeInteractions: true }, "p6-shape-legacy.json");
  const enforced = await exportAs(
    enforcedAlice,
    { includeInteractions: true, userId: "alice" },
    "p6-shape-enforced.json"
  );

  for (const payload of [legacy, enforced]) {
    assert.deepEqual(Object.keys(payload), expectedKeys, "payload keys and order");
    assert.equal(payload.format, "th-memory-mcp/v2");
    assert.equal(payload.version, VERSION, "payload version follows the package version");
    assert.equal(typeof payload.exported_at, "string");
    assert.ok(Array.isArray(payload.memories));
    assert.ok(Array.isArray(payload.memoryLinks));
    assert.ok(Array.isArray(payload.users));
    assert.ok(Array.isArray(payload.entities));
    assert.ok(Array.isArray(payload.relations));
    assert.ok(Array.isArray(payload.preferences));
    assert.ok(Array.isArray(payload.lessons));
    assert.ok(Array.isArray(payload.profile));
    assert.deepEqual(Object.keys(payload.interactions), ["included", "count", "rows"]);
  }
});
