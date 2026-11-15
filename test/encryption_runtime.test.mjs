import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import Database from "better-sqlite3-multiple-ciphers";
import { migrateIfNeeded, openEncryptedDB, isEncrypted, isPlaintextDB, backupEncryptedDB } from "../dist/db/encryption.js";

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

const workDir = mkdtempSync(join(tmpdir(), "th-enc-runtime-"));
const key = new Uint8Array(32).fill(1);
const keyBase64 = Buffer.from(key).toString("base64");

console.log("Work dir:", workDir);
console.log("Key (base64):", keyBase64);

const dbPath = join(workDir, "runtime.db");

// Create plaintext DB with test data
{
  const plainDb = new Database(dbPath);
  plainDb.exec(`
    CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT);
    CREATE INDEX idx_test_value ON test(value);
    CREATE TRIGGER test_trigger AFTER INSERT ON test BEGIN
      UPDATE test SET value = 'triggered' WHERE id = NEW.id AND NEW.value = 'trigger_me';
    END;
  `);
  plainDb.exec("INSERT INTO test (value) VALUES ('hello'), ('world'), ('trigger_me');");
  plainDb.close();
}

console.log("Plaintext DB created with test data, indexes, triggers");

// --- Test 1: Migration ---
{
  const migrated = migrateIfNeeded(dbPath, new Uint8Array(32).fill(1));
  check("Migration runs", () => assert.equal(migrated, true));
  check("DB is now encrypted", () => assert.ok(isEncrypted(dbPath, new Uint8Array(32).fill(1))));
  check("DB is no longer plaintext", () => assert.equal(isPlaintextDB(dbPath), false));
}

// --- Test 2: Open encrypted DB and verify data ---
{
  const key = new Uint8Array(32).fill(1);
  const db = openEncryptedDB(dbPath, key);

  // Check data
  const rows = db.prepare("SELECT id, value FROM test ORDER BY id").all();
  check("Data rows count = 3", () => assert.equal(rows.length, 3));
  check("Row 1 value = 'hello'", () => assert.equal(rows[0].value, "hello"));
  check("Row 2 value = 'world'", () => assert.equal(rows[1].value, "world"));
  check("Row 3 value = 'triggered' (trigger fired)", () => assert.equal(rows[2].value, "triggered"));

  // Check index exists
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_test_value'").all();
  check("Index idx_test_value exists", () => assert.equal(indexes.length, 1));

  // Check trigger exists
  const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'test_trigger'").all();
  check("Trigger test_trigger exists", () => assert.equal(triggers.length, 1));

  db.close();
}

// --- Test 3: WAL mode works ---
{
  const key = new Uint8Array(32).fill(1);
  const db = openEncryptedDB(dbPath, key);
  const walPath = dbPath + "-wal";
  const shmPath = dbPath + "-shm";

  // Do some writes to trigger WAL
  for (let i = 0; i < 10; i++) {
    db.prepare("INSERT INTO test (value) VALUES (?)").run(`wal_test_${i}`);
  }

  check("WAL file exists after writes", () => assert.ok(existsSync(walPath)));
  check("SHM file exists after writes", () => assert.ok(existsSync(shmPath)));

  // Verify data
  const count = db.prepare("SELECT COUNT(*) as c FROM test WHERE value LIKE 'wal_test_%'").get();
  check("WAL writes persisted (10 rows)", () => assert.equal(count.c, 10));

  db.close();
}

// --- Test 4: FTS5 search on encrypted DB ---
{
  const key = new Uint8Array(32).fill(1);
  const db = openEncryptedDB(dbPath, key);

  // Create FTS5 table
  db.exec(`
    CREATE VIRTUAL TABLE fts_test USING fts5(content);
    INSERT INTO fts_test (content) VALUES ('hello world'), ('foo bar'), ('hello foo');
  `);

  // Search
  const results = db.prepare("SELECT content FROM fts_test WHERE fts_test MATCH 'hello'").all();
  check("FTS5 search returns 2 results for 'hello'", () => assert.equal(results.length, 2));
  check("Results contain 'hello world'", () => assert.ok(results.some(r => r.content.includes("hello world"))));
  check("Results contain 'hello foo'", () => assert.ok(results.some(r => r.content.includes("hello foo"))));

  db.close();
}

// --- Test 5: Vector embeddings (simulated - just verify table works) ---
{
  const key = new Uint8Array(32).fill(1);
  const db = openEncryptedDB(dbPath, key);

  // Create embeddings-like table
  db.exec(`
    CREATE TABLE embeddings_test (id INTEGER PRIMARY KEY, vec BLOB);
    INSERT INTO embeddings_test (vec) VALUES (x'01020304'), (x'05060708');
  `);

  const rows = db.prepare("SELECT vec FROM embeddings_test").all();
  check("Embeddings table works", () => assert.equal(rows.length, 2));
  check("BLOB data preserved", () => assert.ok(rows[0].vec instanceof Buffer && rows[0].vec.length === 4));

  db.close();
}

// --- Test 6: Concurrent readers (simulated) ---
{
  const key = new Uint8Array(32).fill(1);
  const db1 = openEncryptedDB(dbPath, key);
  const db2 = openEncryptedDB(dbPath, key);

  const count1 = db1.prepare("SELECT COUNT(*) as c FROM test").get();
  const count2 = db2.prepare("SELECT COUNT(*) as c FROM test").get();
  check("Both readers see same count", () => assert.equal(count1.c, count2.c));

  // Write from db1
  db1.prepare("INSERT INTO test (value) VALUES (?)").run("concurrent_write");

  // db2 should see the new row (WAL allows readers to see committed writes)
  const count1_after = db1.prepare("SELECT COUNT(*) as c FROM test").get();
  const count2_after = db2.prepare("SELECT COUNT(*) as c FROM test").get();
  check("Both readers see new count after write", () => assert.equal(count1_after.c, count2_after.c));

  db1.close();
  db2.close();
}

// --- Test 7: Backup via VACUUM INTO ---
{
  const key = new Uint8Array(32).fill(1);
  const db = openEncryptedDB(dbPath, key);
  const backupPath = join(dirname(dbPath), "runtime_backup.db");

  backupEncryptedDB(db, backupPath);
  db.close();

  // Verify backup is encrypted and readable
  const backupDb = openEncryptedDB(backupPath, new Uint8Array(32).fill(1));
  const count = backupDb.prepare("SELECT COUNT(*) as c FROM test").get();
  check("Backup has same row count", () => assert.equal(count.c, 14)); // 3 original + 10 WAL + 1 concurrent
  backupDb.close();
}

// --- Test 9: Wrong key cannot open ---
{
  const wrongKey = new Uint8Array(32).fill(2);
  check("Wrong key cannot open encrypted DB", () => {
    assert.throws(
      () => openEncryptedDB(dbPath, new Uint8Array(32).fill(2)),
      /cannot open encrypted database: wrong key or corrupted file|wrong key|not a database/
    );
  });
}

// --- Test 10: Legacy mode (MEMORY_ENCRYPTION off) - byte identical ---
// This is tested by the full suite with MEMORY_ENCRYPTION unset

// Cleanup
try {
  rmSync(workDir, { recursive: true, force: true });
} catch { /* ignore */ }

console.log(`\n--- Summary: ${step} checks, ${failures} failures ---`);
if (failures > 0) process.exit(1);