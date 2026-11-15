// Ph-6 B1 — migration matrix: a database at any supported version migrates to
// head without losing a row and stays idempotent.
//
// For each cut point N (the DB has exactly MIGRATIONS[0..N-1] applied, each with
// its `schema_meta` marker) this builds a fresh DB from the v1 base schema,
// seeds version-appropriate rows, runs the real `runMigrations()` and asserts:
//   * every migration id is recorded in schema_meta,
//   * PRAGMA integrity_check = ok,
//   * the seeded rows are byte-for-byte unchanged,
//   * a second run is a no-op (marker set + data unchanged),
//   * `encryption_migrated` is never written (encryption never ran).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3-multiple-ciphers";

const { MIGRATIONS, runMigrations } = await import("../dist/db/migrations.js");
const { embed, serialize } = await import("../dist/lib/embed.js");
const { looseForm } = await import("../dist/lib/thai-segment.js");
const { SEARCH_INDEX_DDL, SEARCH_INDEX_LOOSE_DDL } = await import(
  "../dist/db/search-index-schema.js"
);

const workDir = mkdtempSync(join(tmpdir(), "th-migration-matrix-"));
after(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const TS = "2026-01-02T03:04:05.000Z";

// The v1 base schema that db/index.ts creates before runMigrations() runs.
// schema_meta and search_index_keys are NOT here: M001 and M015 own them.
const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  meta TEXT
);

CREATE TABLE IF NOT EXISTS preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence REAL DEFAULT 0.5,
  source TEXT DEFAULT 'explicit',
  updated_at TEXT NOT NULL,
  UNIQUE(category, key)
);

CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  situation TEXT NOT NULL,
  mistake TEXT NOT NULL,
  correction TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profile (
  section TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

${SEARCH_INDEX_DDL}

${SEARCH_INDEX_LOOSE_DDL}

CREATE TABLE IF NOT EXISTS embeddings (
  ref_table TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  vec BLOB NOT NULL,
  PRIMARY KEY (ref_table, ref_id)
);
`;

const SEEDED_TABLES = [
  "memories",
  "preferences",
  "lessons",
  "profile",
  "interactions",
  "search_index",
  "search_index_loose",
  "search_index_keys",
  "embeddings",
  "users",
];

function tableExists(db, name) {
  return (
    db
      .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
      .get(name).c > 0
  );
}

function columnsOf(db, name) {
  return db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);
}

function insertRow(db, table, row) {
  const cols = Object.keys(row);
  const info = db
    .prepare(
      `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`
    )
    .run(...cols.map((c) => row[c]));
  return Number(info.lastInsertRowid);
}

function lastRowid(db) {
  return Number(db.prepare("SELECT last_insert_rowid() AS id").get().id);
}

function integrity(db) {
  return db.pragma("integrity_check", { simple: true });
}

/** Apply the first `cut` migrations exactly the way runMigrations() does. */
function buildPartialDb(dbPath, cut) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(BASE_SCHEMA);
  for (const migration of MIGRATIONS.slice(0, cut)) {
    db.transaction(() => {
      migration.up(db);
      db.prepare("INSERT INTO schema_meta (key, value) VALUES (?, '1')").run(migration.id);
    })();
  }
  return db;
}

/**
 * Seed rows whose shape matches the version: memories.scope needs 006,
 * memories.user_id needs 007, users needs 007, interactions/preferences/lessons
 * .user_id need 017 (M017 adds those owner columns), search_index_loose needs
 * 013, search_index_keys needs 015.
 */
function seed(db, label) {
  const memCols = new Set(columnsOf(db, "memories"));
  const userId = insertRow(db, "users", {
    external_id: `seed-user-${label}`,
    name: `Seed User ${label}`,
    created_at: TS,
  });

  const memoryRow = {
    type: "FACT",
    content: `seed memory ${label} sqlcipher migration matrix`,
    summary: `seed summary ${label}`,
    status: "active",
    source: "explicit",
    confidence: 0.75,
    importance: 0.6,
    salience: 0.4,
    project_id: `proj-${label}`,
    session_id: null,
    created_at: TS,
    updated_at: TS,
    access_count: 3,
  };
  if (memCols.has("scope")) memoryRow.scope = "PROJECT";
  if (memCols.has("user_id")) memoryRow.user_id = userId;
  const memoryId = insertRow(db, "memories", memoryRow);

  const secondMemoryId = insertRow(db, "memories", {
    ...memoryRow,
    type: "DECISION",
    content: `seed decision ${label} keep wal checkpoint before rename`,
    summary: null,
    project_id: null,
    session_id: `session-${label}`,
    ...(memCols.has("scope") ? { scope: "SESSION" } : {}),
  });

  const prefRow = {
    category: `coding_pref_${label}`,
    key: "package_manager",
    value: "pnpm",
    confidence: 0.9,
    source: "explicit",
    updated_at: TS,
  };
  if (columnsOf(db, "preferences").includes("user_id")) prefRow.user_id = userId;
  const prefId = insertRow(db, "preferences", prefRow);

  const lessonRow = {
    situation: `seed situation ${label}`,
    mistake: "copied fts5 shadow ddl",
    correction: "recreate the virtual table and copy rows",
    created_at: TS,
  };
  if (columnsOf(db, "lessons").includes("user_id")) lessonRow.user_id = userId;
  const lessonId = insertRow(db, "lessons", lessonRow);

  insertRow(db, "profile", {
    section: `identity_${label}`,
    content: "seed profile content",
    updated_at: TS,
  });

  const interactionRow = {
    ts: TS,
    session_id: `session-${label}`,
    kind: "user_message",
    content: `seed interaction ${label}`,
    meta: null,
  };
  if (columnsOf(db, "interactions").includes("user_id")) interactionRow.user_id = userId;
  const interactionId = insertRow(db, "interactions", interactionRow);

  const strictId = insertRow(db, "search_index", {
    ref_table: "memories",
    ref_id: memoryId,
    title: `seed memory ${label}`,
    body: `seed memory ${label} sqlcipher migration matrix`,
  });
  const strictTitle = `seed memory ${label}`;
  const strictBody = `seed memory ${label} sqlcipher migration matrix`;
  const looseId = insertRow(db, "search_index_loose", {
    ref_table: "memories",
    ref_id: memoryId,
    title: looseForm(strictTitle),
    body: looseForm(strictBody),
  });

  if (tableExists(db, "search_index_keys")) {
    insertRow(db, "search_index_keys", {
      ref_table: "memories",
      ref_id: memoryId,
      strict_rowid: strictId,
      loose_rowid: looseId,
    });
  }

  insertRow(db, "embeddings", {
    ref_table: "memories",
    ref_id: memoryId,
    vec: serialize(embed(`seed memory ${label} sqlcipher migration matrix`)),
  });
  insertRow(db, "embeddings", {
    ref_table: "preferences",
    ref_id: prefId,
    vec: serialize(embed(`coding_pref_${label} package_manager pnpm`)),
  });
  insertRow(db, "embeddings", {
    ref_table: "lessons",
    ref_id: lessonId,
    vec: serialize(embed(`seed situation ${label} copied fts5 shadow ddl`)),
  });

  return {
    memoryId,
    secondMemoryId,
    prefId,
    lessonId,
    interactionId,
    strictId,
    looseId,
    userId,
    // Column set as it existed at seed time: later migrations add owner columns
    // (M017), so projections must never widen between the two snapshots.
    shape: {
      memories: columnsOf(db, "memories"),
      preferences: columnsOf(db, "preferences"),
      lessons: columnsOf(db, "lessons"),
      interactions: columnsOf(db, "interactions"),
    },
  };
}

/** Row projections of everything seed() wrote, using only columns it targeted. */
function snapshot(db, seeded) {
  const project = (table, id, cols) => {
    const all = new Set(seeded.shape[table] ?? columnsOf(db, table));
    const list = cols.filter((c) => all.has(c));
    return db.prepare(`SELECT ${list.join(", ")} FROM ${table} WHERE id = ?`).get(id);
  };

  const counts = {};
  for (const table of SEEDED_TABLES) {
    counts[table] = tableExists(db, table)
      ? db.prepare(`SELECT count(*) AS c FROM ${table}`).get().c
      : null;
  }

  return {
    integrity: integrity(db),
    counts,
    markers: db
      .prepare("SELECT key, value FROM schema_meta ORDER BY key")
      .all()
      .filter((r) => MIGRATIONS.some((m) => m.id === r.key)),
    memories: [
      project("memories", seeded.memoryId, [
        "id",
        "type",
        "content",
        "summary",
        "status",
        "source",
        "confidence",
        "importance",
        "salience",
        "project_id",
        "session_id",
        "created_at",
        "updated_at",
        "access_count",
        "scope",
        "user_id",
      ]),
      project("memories", seeded.secondMemoryId, ["id", "content", "scope", "session_id"]),
    ],
    preference: project("preferences", seeded.prefId, [
      "id",
      "category",
      "key",
      "value",
      "confidence",
      "source",
      "updated_at",
      "user_id",
    ]),
    lesson: project("lessons", seeded.lessonId, [
      "id",
      "situation",
      "mistake",
      "correction",
      "created_at",
      "user_id",
    ]),
    interaction: project("interactions", seeded.interactionId, [
      "id",
      "ts",
      "session_id",
      "kind",
      "content",
      "meta",
      "user_id",
    ]),
    profile: db
      .prepare("SELECT section, content, updated_at FROM profile ORDER BY section")
      .all(),
    users: db.prepare("SELECT id, external_id, name FROM users ORDER BY id").all(),
    searchIndexRows: db
      .prepare("SELECT rowid AS rid, ref_table, ref_id, title, body FROM search_index ORDER BY rid")
      .all(),
    looseIndexRows: db
      .prepare(
        "SELECT rowid AS rid, ref_table, ref_id, title, body FROM search_index_loose ORDER BY rid"
      )
      .all(),
    keyRows: tableExists(db, "search_index_keys")
      ? db
          .prepare(
            "SELECT ref_table, ref_id, strict_rowid, loose_rowid FROM search_index_keys ORDER BY ref_table, ref_id"
          )
          .all()
      : [],
    embeddingRows: db
      .prepare("SELECT ref_table, ref_id, hex(vec) AS v FROM embeddings ORDER BY ref_table, ref_id")
      .all(),
  };
}

function markerKeys(db) {
  return db
    .prepare("SELECT key FROM schema_meta ORDER BY key")
    .all()
    .map((r) => r.key);
}

for (const cut of [13, 14, 15, 16, 17]) {
  const version = MIGRATIONS[cut - 1].id;
  test(`B1 cut ${cut} (${version}) migrates to head without data loss`, () => {
    const dbPath = join(workDir, `cut-${cut}.db`);
    const db = buildPartialDb(dbPath, cut);
    try {
      assert.equal(integrity(db), "ok", "partial DB must be structurally sound");

      const present = MIGRATIONS.slice(0, cut).map((m) => m.id);
      assert.deepEqual(markerKeys(db).filter((k) => present.includes(k)), present);
      const pending = MIGRATIONS.slice(cut).map((m) => m.id);
      for (const id of pending) {
        assert.ok(!markerKeys(db).includes(id), `${id} must still be pending at cut ${cut}`);
      }

      const seeded = seed(db, `cut${cut}`);
      const before = snapshot(db, seeded);
      assert.equal(before.integrity, "ok");
      assert.ok(!before.markers.some((r) => r.key === "encryption_migrated"));

      // Version-specific shape before the upgrade.
      if (cut < 17) {
        assert.equal(tableExists(db, "scope_grants"), false);
        assert.equal(tableExists(db, "audit_log"), false);
        assert.equal(columnsOf(db, "interactions").includes("user_id"), false);
      }

      runMigrations(db);

      const afterHead = snapshot(db, seeded);
      const markersAfter = markerKeys(db);
      for (const migration of MIGRATIONS) {
        assert.ok(markersAfter.includes(migration.id), `${migration.id} missing from schema_meta`);
      }
      assert.ok(
        !markersAfter.includes("encryption_migrated"),
        "encryption must never run during a schema migration"
      );
      assert.equal(afterHead.integrity, "ok");
      assert.deepEqual(afterHead.memories, before.memories);
      assert.deepEqual(afterHead.preference, before.preference);
      assert.deepEqual(afterHead.lesson, before.lesson);
      assert.deepEqual(afterHead.interaction, before.interaction);
      assert.deepEqual(afterHead.profile, before.profile);
      assert.deepEqual(afterHead.users, before.users);
      assert.deepEqual(afterHead.embeddingRows, before.embeddingRows);
      assert.deepEqual(afterHead.searchIndexRows, before.searchIndexRows);
      assert.deepEqual(afterHead.looseIndexRows, before.looseIndexRows);
      for (const table of ["memories", "preferences", "lessons", "interactions", "profile"]) {
        assert.equal(
          afterHead.counts[table],
          before.counts[table],
          `row count changed for ${table}`
        );
      }
      // 015 builds the mapping table when the version predates it; from cut 15
      // on the seeded mapping survives untouched.
      if (cut >= 15) {
        assert.deepEqual(afterHead.keyRows, before.keyRows);
      } else {
        assert.deepEqual(
          afterHead.keyRows,
          [
            {
              ref_table: "memories",
              ref_id: seeded.memoryId,
              strict_rowid: seeded.strictId,
              loose_rowid: seeded.looseId,
            },
          ],
          "M015 must backfill the mapping for rows seeded before it ran"
        );
      }

      if (cut < 17) {
        assert.equal(tableExists(db, "scope_grants"), true);
        assert.equal(tableExists(db, "audit_log"), true);
        for (const table of ["interactions", "preferences", "lessons"]) {
          assert.equal(columnsOf(db, table).includes("user_id"), true, `${table}.user_id missing`);
        }
      }

      // Idempotent second run: same markers, same bytes, still healthy.
      const markersBeforeSecondRun = markerKeys(db);
      runMigrations(db);
      const afterSecond = snapshot(db, seeded);
      assert.deepEqual(markerKeys(db), markersBeforeSecondRun);
      assert.deepEqual(afterSecond.memories, before.memories);
      assert.deepEqual(afterSecond.preference, before.preference);
      assert.deepEqual(afterSecond.lesson, before.lesson);
      assert.deepEqual(afterSecond.interaction, before.interaction);
      assert.deepEqual(afterSecond.profile, before.profile);
      assert.deepEqual(afterSecond.users, before.users);
      assert.deepEqual(afterSecond.embeddingRows, before.embeddingRows);
      assert.deepEqual(afterSecond.searchIndexRows, before.searchIndexRows);
      assert.deepEqual(afterSecond.looseIndexRows, before.looseIndexRows);
      assert.equal(afterSecond.integrity, "ok");
    } finally {
      db.close();
    }
  });
}

test("B1 full head: runMigrations is a no-op", () => {
  const dbPath = join(workDir, "head.db");
  const db = buildPartialDb(dbPath, MIGRATIONS.length);
  try {
    const seeded = seed(db, "head");
    const before = snapshot(db, seeded);
    const markersBefore = markerKeys(db);
    const filesBefore = readdirSync(workDir).filter((n) => n.startsWith("head.db"));

    runMigrations(db);

    assert.deepEqual(markerKeys(db), markersBefore);
    const afterRun = snapshot(db, seeded);
    assert.equal(afterRun.integrity, "ok");
    assert.deepEqual(afterRun.memories, before.memories);
    assert.deepEqual(afterRun.preference, before.preference);
    assert.deepEqual(afterRun.lesson, before.lesson);
    assert.deepEqual(afterRun.interaction, before.interaction);
    assert.deepEqual(afterRun.profile, before.profile);
    assert.deepEqual(afterRun.users, before.users);
    assert.deepEqual(afterRun.embeddingRows, before.embeddingRows);
    assert.deepEqual(afterRun.searchIndexRows, before.searchIndexRows);
    assert.deepEqual(afterRun.looseIndexRows, before.looseIndexRows);
    assert.deepEqual(afterRun.keyRows, before.keyRows);
    const filesAfter = readdirSync(workDir).filter((n) => n.startsWith("head.db"));
    assert.deepEqual(
      filesAfter.sort(),
      filesBefore.sort(),
      "a no-op run must not create a migration backup"
    );
    assert.ok(!markerKeys(db).includes("encryption_migrated"));
  } finally {
    db.close();
  }
});
