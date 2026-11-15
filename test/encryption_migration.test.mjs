import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3-multiple-ciphers";
import { migrateIfNeeded, isEncrypted, isPlaintextDB, openEncryptedDB, backupEncryptedDB, getEncryptionStatus } from "../dist/db/encryption.js";

let failures = 0;
let step = 0;
function report(ok, name, detail = "") {
  const tag = ok ? "PASS" : "FAIL";
  console.log(`${tag.padEnd(4)} ${(step++ + "").padStart(2)} | ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
function check(name, fn) {
  try {
    fn();
    report(true, name);
  } catch (e) {
    report(false, name, e instanceof Error ? e.message : String(e));
  }
}

const workDir = mkdtempSync(join(tmpdir(), "th-enc-migration-"));
const dbPath = join(workDir, "test.db");
const key = new Uint8Array(32).fill(1); // 32 bytes of 0x01
const keyBase64 = Buffer.from(key).toString("base64");

console.log("Work dir:", workDir);
console.log("Key (base64):", keyBase64);

// --- Test 1: New DB (no existing file) ---
{
  const dbPath = join(workDir, "new.db");
  const migrated = migrateIfNeeded(dbPath, key);
  check("migrateIfNeeded: new DB returns false (no migration)", () => assert.equal(migrated, false));
  // DB doesn't exist yet, so status shows exists=false
  const status = getEncryptionStatus(dbPath, key);
  check("getEncryptionStatus: non-existent DB shows exists=false", () => {
    assert.equal(status.exists, false);
    assert.equal(status.encrypted, false);
    assert.equal(status.migrated, false);
    assert.equal(status.plaintext, false);
  });
}

// --- Test 2: Plaintext -> Encrypted migration ---
{
  const dbPath = join(workDir, "migrate.db");
  // Create plaintext DB
  const plainDb = new Database(dbPath);
  plainDb.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT);");
  plainDb.exec("INSERT INTO test (value) VALUES ('hello');");
  plainDb.close();

  check("isPlaintextDB: detects plaintext DB", () => assert.equal(isPlaintextDB(dbPath), true));
  check("isEncrypted: returns false for plaintext DB", () => assert.equal(isEncrypted(dbPath, key), false));

  const migrated = migrateIfNeeded(dbPath, key);
  check("migrateIfNeeded: plaintext -> encrypted returns true", () => assert.equal(migrated, true));
  check("isEncrypted: returns true after migration", () => assert.equal(isEncrypted(dbPath, key), true));
  check("isPlaintextDB: returns false after migration", () => assert.equal(isPlaintextDB(dbPath), false));

  const status = getEncryptionStatus(dbPath, key);
  check("getEncryptionStatus: migrated DB shows encrypted=true, migrated=true", () => {
    assert.equal(status.exists, true);
    assert.equal(status.encrypted, true);
    assert.equal(status.migrated, true);
    assert.equal(status.plaintext, false);
  });

  // Verify data survived migration
  const db = openEncryptedDB(dbPath, key);
  const row = db.prepare("SELECT value FROM test").get();
  check("Data survives migration", () => assert.equal(row?.value, "hello"));
  db.close();
}

// --- Test 3: Idempotency - re-running migration on already encrypted DB ---
{
  const dbPath = join(workDir, "idempotent.db");
  // Create plaintext, migrate once
  const plainDb = new Database(dbPath);
  plainDb.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT);");
  plainDb.exec("INSERT INTO test (value) VALUES ('idempotent');");
  plainDb.close();

  migrateIfNeeded(dbPath, key);
  const migrated2 = migrateIfNeeded(dbPath, key);
  check("migrateIfNeeded: second run returns false (idempotent)", () => assert.equal(migrated2, false));

  const db = openEncryptedDB(dbPath, key);
  const row = db.prepare("SELECT value FROM test").get();
  check("Data intact after second migration call", () => assert.equal(row?.value, "idempotent"));
  db.close();
}

// --- Test 4: Wrong key on plaintext DB (migration succeeds but creates DB with wrong key) ---
{
  const wrongKey = new Uint8Array(32).fill(2);
  const dbPath = join(workDir, "wrongkey.db");
  const plainDb = new Database(dbPath);
  plainDb.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT);");
  plainDb.exec("INSERT INTO test (value) VALUES ('test data');");
  plainDb.close();

  // Migration should succeed (creates encrypted DB with wrongKey)
  // But the resulting DB can only be opened with wrongKey
  const migrated = migrateIfNeeded(dbPath, wrongKey);
  check("migrateIfNeeded: wrong key on plaintext DB succeeds (creates DB with that key)", () => assert.equal(migrated, true));

  // Verify it can be opened with wrongKey but not with correct key
  const dbWrong = openEncryptedDB(dbPath, wrongKey);
  const tables = dbWrong.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  console.log('[DEBUG] Tables in wrong-key DB:', JSON.stringify(tables));
  const rowCount = dbWrong.prepare("SELECT COUNT(*) as c FROM test").get();
  console.log('[DEBUG] Row count in test table:', JSON.stringify(rowCount));
  const row = dbWrong.prepare("SELECT * FROM test").get();
  console.log('[DEBUG] Row data:', JSON.stringify(row));
  check("DB openable with wrong key used for migration", () => assert.ok(row));
  check("Migrated data preserved with wrong key", () => assert.equal(row?.value, "test data"));
  dbWrong.close();

  // Correct key should fail
  const correctKey = new Uint8Array(32).fill(1);
  check("Correct key cannot open DB migrated with wrong key", () => {
    assert.throws(() => openEncryptedDB(dbPath, correctKey), /file is not a database|not a database|cipher|key|decrypt|unable/i);
  });
}

// --- Test 5: Migration marker idempotency (schema_meta) ---
{
  const dbPath = join(workDir, "marker.db");
  const plainDb = new Database(dbPath);
  plainDb.exec("CREATE TABLE test (id INTEGER PRIMARY KEY);");
  plainDb.close();

  migrateIfNeeded(dbPath, key);

  // Open with key and check marker
  const db = openEncryptedDB(dbPath, key);
  const marker = db.prepare("SELECT value FROM schema_meta WHERE key = ?").get("encryption_migrated");
  check("Migration marker written to schema_meta", () => assert.equal(marker?.value, "1"));
  db.close();

  // Re-run migration - should not re-migrate
  const migratedAgain = migrateIfNeeded(dbPath, key);
  check("Marker prevents re-migration", () => assert.equal(migratedAgain, false));
}

// --- Test 6: Backup via VACUUM INTO ---
{
  const dbPath = join(workDir, "backup.db");
  const plainDb = new Database(dbPath);
  plainDb.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT);");
  plainDb.exec("INSERT INTO test (value) VALUES ('backup test');");
  plainDb.close();

  migrateIfNeeded(dbPath, key);

  const backupPath = join(workDir, "backup_copy.db");
  const db = openEncryptedDB(dbPath, key);
  const { backupEncryptedDB } = await import("../dist/db/encryption.js");
  backupEncryptedDB(db, backupPath);
  db.close();

  check("Backup file exists", () => assert.ok(existsSync(backupPath)));

  // Verify backup is encrypted and readable with same key
  const backupDb = openEncryptedDB(backupPath, key);
  const row = backupDb.prepare("SELECT value FROM test").get();
  check("Backup readable with same key", () => assert.equal(row?.value, "backup test"));
  check("Backup is encrypted", () => assert.ok(isEncrypted(backupPath, key)));
  backupDb.close();
}

// --- Test 7: openEncryptedDB with wrong key throws ---
{
  const dbPath = join(workDir, "open_wrong.db");
  const plainDb = new Database(dbPath);
  plainDb.exec("CREATE TABLE test (id INTEGER PRIMARY KEY);");
  plainDb.close();

  migrateIfNeeded(dbPath, key);

  const wrongKey = new Uint8Array(32).fill(2);
  check("openEncryptedDB with wrong key throws", () => {
    assert.throws(() => openEncryptedDB(dbPath, new Uint8Array(32).fill(2)), /file is not a database|not a database|cipher|key|decrypt|unable/i);
  });
}

// --- Test 8: migrateIfNeeded on plaintext DB (covers runMigration internally) ---
{
  const dbPath = join(workDir, "migrate_direct.db");
  const plainDb = new Database(dbPath);
  plainDb.exec("CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT);");
  plainDb.exec("INSERT INTO test (value) VALUES ('direct');");
  plainDb.close();

  const result = migrateIfNeeded(dbPath, key);
  check("migrateIfNeeded returns true for plaintext DB", () => assert.equal(result, true));

  const db = openEncryptedDB(dbPath, key);
  const row = db.prepare("SELECT value FROM test").get();
  check("Direct migration preserves data", () => assert.equal(row?.value, "direct"));
  db.close();
}

// --- Test 9 (Ph-6 A1): real-shape app DB — FTS5 + shadows + embeddings + graph + users ---
// Built through the app path in a child process (createMemory, rememberHandler,
// saveLessonHandler, link_memory + a user and an interaction) so the database
// looks exactly like a live one, including search_index/_loose shadow tables.
const SHADOW_SUFFIXES = ["_data", "_idx", "_content", "_docsize", "_config"];

function childEnv(dbPath) {
  const env = { ...process.env, MEMORY_DB_PATH: dbPath };
  for (const name of Object.keys(env)) {
    if (name.startsWith("MEMORY_") && name !== "MEMORY_DB_PATH") delete env[name];
  }
  return env;
}

function shapeSnapshot(dbPath, encrypted) {
  const db = encrypted ? openEncryptedDB(dbPath, key) : new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all();
    const virtual = rows.filter((r) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(r.sql ?? "")).map((r) => r.name);
    const shadows = new Set(virtual.flatMap((n) => SHADOW_SUFFIXES.map((s) => n + s)));
    const ordinary = rows.filter((r) => !virtual.includes(r.name) && !shadows.has(r.name)).map((r) => r.name);
    const counts = {};
    for (const name of ordinary) {
      counts[name] = db.prepare(`SELECT count(*) AS c FROM "${name}"`).get().c;
    }
    for (const name of virtual) {
      counts[name] = db.prepare(`SELECT count(*) AS c FROM "${name}"`).get().c;
    }
    const shadowCounts = {};
    for (const name of shadows) {
      shadowCounts[name] = db.prepare(`SELECT count(*) AS c FROM "${name}"`).get().c;
    }
    return {
      virtual,
      shadows: [...shadows],
      ordinary,
      counts,
      shadowCounts,
      strictRefs: db
        .prepare("SELECT ref_table, ref_id FROM search_index WHERE search_index MATCH ? ORDER BY ref_id")
        .all("sqlcipher"),
      looseRefs: db
        .prepare("SELECT ref_table, ref_id FROM search_index_loose WHERE search_index_loose MATCH ? ORDER BY ref_id")
        .all("sqlcipher"),
      embeddings: db
        .prepare("SELECT ref_table, ref_id, hex(vec) AS h FROM embeddings ORDER BY ref_table, ref_id")
        .all(),
      integrity: db.pragma("integrity_check")[0]?.integrity_check,
      marker: db
        .prepare("SELECT value FROM schema_meta WHERE key = 'encryption_migrated'")
        .get(),
    };
  } finally {
    db.close();
  }
}

{
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");

  const appDir = join(workDir, "app-shape");
  mkdirSync(appDir, { recursive: true });
  const appDbPath = join(appDir, "app.db");
  const builderPath = join(appDir, "build-app-db.mjs");
  const urls = {
    db: new URL("../dist/db/index.js", import.meta.url).href,
    memories: new URL("../dist/db/repositories/memories.js", import.meta.url).href,
    remember: new URL("../dist/tools/remember.js", import.meta.url).href,
    lesson: new URL("../dist/tools/lesson.js", import.meta.url).href,
    link: new URL("../dist/tools/link_memory.js", import.meta.url).href,
  };
  writeFileSync(
    builderPath,
    [
      "process.env.MEMORY_DB_PATH = process.env.PROBE_DB;",
      `const app = await import(${JSON.stringify(urls.db)});`,
      `const { createMemory } = await import(${JSON.stringify(urls.memories)});`,
      `const { rememberHandler } = await import(${JSON.stringify(urls.remember)});`,
      `const { saveLessonHandler } = await import(${JSON.stringify(urls.lesson)});`,
      `const { linkMemoryHandler } = await import(${JSON.stringify(urls.link)});`,
      "const a = createMemory({ type: 'FACT', content: 'ซ้อมติดตั้ง sqlcipher บน windows ด้วย pnpm' });",
      "const b = createMemory({ type: 'DECISION', content: 'chose wal checkpoint strategy for encryption migration' });",
      "await rememberHandler({ category: 'coding_pref', key: 'package_manager', value: 'pnpm' });",
      "await saveLessonHandler({ situation: 'fts5 shadow table copy failed', mistake: 'copied shadow ddl', correction: 'skip shadows and copy virtual rows' });",
      "linkMemoryHandler({ sourceId: a, targetId: b, relation: 'related_to' });",
      "app.db.prepare('INSERT OR IGNORE INTO users (external_id, name, created_at) VALUES (?,?,?)').run('probe-user', 'Probe User', new Date().toISOString());",
      "app.db.prepare('INSERT INTO interactions (ts, session_id, kind, content) VALUES (?,?,?,?)').run(new Date().toISOString(), 'probe-session', 'user_message', 'probe interaction row');",
      "process.stdout.write('BUILT ' + a + ' ' + b + '\\n');",
    ].join("\n")
  );

  execFileSync(process.execPath, [builderPath], {
    env: { ...childEnv(appDbPath), PROBE_DB: appDbPath },
    stdio: "pipe",
  });

  check("A1 real-shape: app DB is plaintext before migration", () => assert.equal(isPlaintextDB(appDbPath), true));

  const before = shapeSnapshot(appDbPath, false);
  check("A1 real-shape: DB has both FTS5 virtual tables", () =>
    assert.deepEqual([...before.virtual].sort(), ["search_index", "search_index_loose"]));
  check("A1 real-shape: all FTS5 shadow tables present before migration", () => {
    for (const vt of before.virtual) {
      for (const suffix of SHADOW_SUFFIXES) {
        assert.ok(before.shadows.includes(vt + suffix), `missing ${vt}${suffix}`);
      }
    }
  });
  check("A1 real-shape: DB has embeddings, graph and users rows", () => {
    assert.ok(before.counts.memories >= 2);
    assert.ok(before.counts.embeddings >= 3);
    assert.ok(before.counts.memory_links >= 1);
    assert.ok(before.counts.users >= 1);
    assert.ok(before.counts.interactions >= 1);
    assert.ok(before.counts.lessons >= 1);
    assert.ok(before.counts.preferences >= 1);
  });
  check("A1 real-shape: source MATCH returns refs on both FTS channels", () => {
    assert.ok(before.strictRefs.length > 0);
    assert.ok(before.looseRefs.length > 0);
  });

  let migrated = false;
  check("A1 real-shape: migrateIfNeeded succeeds on a DB with FTS5 shadows", () => {
    migrated = migrateIfNeeded(appDbPath, key);
    assert.equal(migrated, true);
  });
  check("A1 real-shape: DB is encrypted after migration", () => {
    assert.equal(isEncrypted(appDbPath, key), true);
    assert.equal(isPlaintextDB(appDbPath), false);
  });

  const after = shapeSnapshot(appDbPath, key);
  check("A1 real-shape: integrity_check is ok", () => assert.equal(after.integrity, "ok"));
  check("A1 real-shape: migration marker written", () => assert.equal(after.marker?.value, "1"));
  check("A1 real-shape: same virtual + ordinary tables after migration", () => {
    assert.deepEqual([...after.virtual].sort(), [...before.virtual].sort());
    assert.deepEqual([...after.ordinary].sort(), [...before.ordinary].sort());
    assert.deepEqual([...after.shadows].sort(), [...before.shadows].sort());
  });
  check("A1 real-shape: every user table keeps its row count", () => {
    for (const name of before.ordinary) {
      if (name === "schema_meta") continue; // +1 migration marker, asserted below
      assert.equal(after.counts[name], before.counts[name], `row count changed for ${name}`);
    }
    assert.equal(after.counts.schema_meta, before.counts.schema_meta + 1);
  });
  check("A1 real-shape: FTS5 shadow tables are rebuilt, not copied verbatim", () => {
    for (const name of after.shadows) assert.ok(typeof after.shadowCounts[name] === "number");
    assert.ok(after.shadowCounts["search_index_data"] > 0);
    assert.ok(after.shadowCounts["search_index_loose_data"] > 0);
  });
  check("A1 real-shape: search_index MATCH returns the same refs", () =>
    assert.deepEqual(after.strictRefs, before.strictRefs));
  check("A1 real-shape: search_index_loose MATCH returns the same refs", () =>
    assert.deepEqual(after.looseRefs, before.looseRefs));
  check("A1 real-shape: embeddings BLOBs round-trip byte-identically", () => {
    assert.ok(before.embeddings.length > 0);
    assert.deepEqual(after.embeddings, before.embeddings);
  });
  check("A1 real-shape: no .enc.tmp/.enc.bak left behind", () => {
    assert.equal(existsSync(`${appDbPath}.enc.tmp`), false);
    assert.equal(existsSync(`${appDbPath}.enc.bak`), false);
  });

  // --- Test 10 (A1): idempotency on the real-shape DB ---
  check("A1 idempotency: second migrateIfNeeded returns false", () =>
    assert.equal(migrateIfNeeded(appDbPath, key), false));
  const again = shapeSnapshot(appDbPath, key);
  check("A1 idempotency: data unchanged after the second call", () => {
    assert.deepEqual(again.counts, after.counts);
    assert.deepEqual(again.embeddings, after.embeddings);
    assert.deepEqual(again.strictRefs, after.strictRefs);
  });
}

// --- Test 11 (A2): a failed migration leaves the original DB untouched ---
{
  const badPath = join(workDir, "checksum.db");
  const plainDb = new Database(badPath);
  plainDb.exec("CREATE TABLE chk (x INTEGER CHECK (x > 0));");
  plainDb.pragma("ignore_check_constraints = ON");
  plainDb.exec("INSERT INTO chk (x) VALUES (-5);");
  plainDb.close();

  check("A2 failure: migration with an uncopyable row throws", () =>
    assert.throws(() => migrateIfNeeded(badPath, key)));
  check("A2 failure: original DB is still plaintext and intact", () => {
    assert.equal(isPlaintextDB(badPath), true);
    const db = new Database(badPath, { readonly: true });
    try {
      assert.equal(db.prepare("SELECT x FROM chk").get().x, -5);
    } finally {
      db.close();
    }
  });
  check("A2 failure: no .enc.tmp/.enc.bak left behind", () => {
    assert.equal(existsSync(`${badPath}.enc.tmp`), false);
    assert.equal(existsSync(`${badPath}.enc.bak`), false);
  });
}

// Cleanup
try {
  rmSync(workDir, { recursive: true, force: true });
} catch { /* ignore */ }

console.log(`\n--- Summary: ${step} checks, ${failures} failures ---`);
if (failures > 0) process.exit(1);