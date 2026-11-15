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

// Cleanup
try {
  rmSync(workDir, { recursive: true, force: true });
} catch { /* ignore */ }

console.log(`\n--- Summary: ${step} checks, ${failures} failures ---`);
if (failures > 0) process.exit(1);