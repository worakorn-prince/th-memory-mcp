// Ph-6 B3 — failure modes of the encryption layer.
//
//   * wrong key            -> one bounded message, no key material, file intact
//   * corrupt middle pages -> clear error (or failing integrity_check), no new DB
//   * encrypted DB + MEMORY_ENCRYPTION unset -> child fails, bytes byte-identical
//   * plaintext DB + MEMORY_ENCRYPTION=on    -> migrates, then opens with the key
//   * truncated file       -> clear error, bytes unchanged
//
// Every case is a post-condition on the file: a failed open must never rewrite,
// truncate or replace the database it refused to read.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  copyFileSync,
  readFileSync,
  statSync,
  truncateSync,
  openSync,
  writeSync,
  closeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import Database from "better-sqlite3-multiple-ciphers";

const {
  migrateIfNeeded,
  openEncryptedDB,
  isEncrypted,
  isPlaintextDB,
  WRONG_KEY_ERROR,
} = await import("../dist/db/encryption.js");

const workDir = mkdtempSync(join(tmpdir(), "th-encryption-failures-"));
const key = new Uint8Array(32).fill(11);
const wrongKey = new Uint8Array(32).fill(12);
const keyBase64 = Buffer.from(key).toString("base64");
const keyHex = Array.from(key)
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");

after(() => {
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const APP_URL = new URL("../dist/db/index.js", import.meta.url).href;

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Minimal plaintext DB: one ordinary table with a secondary index, plus FTS5. */
function makePlaintext(dbPath) {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL);
      CREATE INDEX idx_items_label ON items(label);
      CREATE VIRTUAL TABLE note_fts USING fts5(label, body);
    `);
    const insert = db.prepare("INSERT INTO items (label) VALUES (?)");
    for (let i = 1; i <= 5; i++) insert.run(`item ${i}`);
    db.exec("INSERT INTO note_fts (label, body) VALUES ('a', 'alpha bravo'), ('b', 'charlie delta')");
  } finally {
    db.close();
  }
}

/** Copy the encrypted fixture away from the shared one before damaging it. */
function damagedCopy(name) {
  const path = join(workDir, name);
  copyFileSync(fixtureEncrypted, path);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (existsSync(path + suffix)) rmSync(path + suffix, { force: true });
  }
  return path;
}

/**
 * Child environment: no inherited MEMORY_* at all, then exactly what the case
 * needs. This is what makes "MEMORY_ENCRYPTION unset" a real unset.
 */
function childEnv(dbPath, extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("MEMORY_")) delete env[name];
  }
  return { ...env, MEMORY_DB_PATH: dbPath, ...extra };
}

const APP_OPEN_WORKER = `
const app = await import(${JSON.stringify(APP_URL)});
const db = app.getDb();
process.stdout.write("ROWS " + db.prepare("SELECT count(*) AS c FROM items").get().c + "\\n");
`;

function runApp(dbPath, extra) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", APP_OPEN_WORKER], {
    env: childEnv(dbPath, extra),
    encoding: "utf8",
    timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function assertNoKeyMaterial(text) {
  assert.ok(!text.includes(keyBase64), "key material (base64) leaked into a message");
  assert.ok(!text.includes(keyHex), "key material (hex) leaked into a message");
}

function countItems(dbPath) {
  const db = openEncryptedDB(dbPath, key);
  try {
    return db.prepare("SELECT count(*) AS c FROM items").get().c;
  } finally {
    db.close();
  }
}

// --- fixtures ---------------------------------------------------------------
const fixturePlain = join(workDir, "fixture-plain.db");
makePlaintext(fixturePlain);

const fixtureEncrypted = join(workDir, "fixture-encrypted.db");
makePlaintext(fixtureEncrypted);
migrateIfNeeded(fixtureEncrypted, key);

test("B3 fixture: encrypted copy holds the plaintext rows", () => {
  assert.equal(isEncrypted(fixtureEncrypted, key), true);
  assert.equal(countItems(fixtureEncrypted), 5);
});

// --- 1. wrong key -----------------------------------------------------------
test("B3 wrong key: one bounded error, no key material, file untouched", () => {
  const path = damagedCopy("wrong-key.db");
  const before = sha256(path);

  let message = null;
  try {
    openEncryptedDB(path, wrongKey);
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }
  assert.equal(message, WRONG_KEY_ERROR);
  assert.ok(message.length < 200, `error message is not bounded: ${message}`);
  assertNoKeyMaterial(message);

  assert.equal(sha256(path), before, "a failed open rewrote the file");
  assert.equal(isEncrypted(path, key), true, "the file no longer opens with the real key");
  assert.equal(countItems(path), 5);
});

// --- 2. corrupt middle pages ------------------------------------------------
test("B3 corrupt middle pages: clear error, no silently created database", () => {
  const path = damagedCopy("corrupt-middle.db");
  const sizeBefore = statSync(path).size;

  // 4096 bytes of 0xFF at offset 8192 — page 3, well inside the file and far
  // from the header the canary reads.
  const fd = openSync(path, "r+");
  try {
    writeSync(fd, Buffer.alloc(4096, 0xff), 0, 4096, 8192);
  } finally {
    closeSync(fd);
  }

  let message = null;
  let integrity = null;
  try {
    const db = openEncryptedDB(path, key);
    try {
      integrity = db.pragma("integrity_check", { simple: true });
    } catch (e) {
      integrity = `integrity_check threw: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      db.close();
    }
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
  }

  assert.ok(
    message !== null || integrity !== "ok",
    "a database with overwritten pages must not look healthy"
  );
  if (message !== null) {
    assert.equal(message, WRONG_KEY_ERROR);
    assertNoKeyMaterial(message);
  }

  assert.equal(existsSync(path), true, "the corrupt file must not be removed");
  assert.equal(statSync(path).size, sizeBefore, "the corrupt file was resized");
  assert.equal(isPlaintextDB(path), false, "the corrupt file must never read as a fresh plaintext DB");
});

// --- 3. encrypted DB opened with MEMORY_ENCRYPTION unset --------------------
test("B3 encrypted DB with MEMORY_ENCRYPTION unset: child fails, bytes unchanged", () => {
  const path = damagedCopy("no-encryption.db");
  const before = sha256(path);

  const run = runApp(path, {});
  assert.notEqual(run.status, 0, `child must fail without MEMORY_ENCRYPTION: ${run.stdout}`);

  const text = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  assert.match(text, /not a database|malformed|encrypted|SQLITE_NOTADB/i, `unexpected child output: ${text}`);
  assert.ok(text.length < 8000, `child error output is not bounded: ${text.length} bytes`);
  assertNoKeyMaterial(text);

  assert.equal(sha256(path), before, "the failed run modified the encrypted file");
  assert.equal(isEncrypted(path, key), true);
  assert.equal(countItems(path), 5, "the encrypted file lost rows after the failed run");
});

// --- 4. plaintext DB opened with MEMORY_ENCRYPTION=on + correct key ---------
test("B3 plaintext DB with MEMORY_ENCRYPTION=on: migrates, then opens with the key", () => {
  const path = join(workDir, "plaintext-to-encrypted.db");
  makePlaintext(path);
  assert.equal(isPlaintextDB(path), true);

  const run = runApp(path, {
    MEMORY_ENCRYPTION: "on",
    MEMORY_ENCRYPTION_KEY: keyBase64,
    MEMORY_BACKUP_ON_MIGRATE: "0",
  });
  assert.equal(run.status, 0, `migrating app start failed: ${run.stderr}`);
  assert.match(run.stdout ?? "", /ROWS 5/, `app start returned no rows: ${run.stdout}${run.stderr}`);

  assert.equal(isEncrypted(path, key), true, "the DB was not encrypted after the app start");
  assert.equal(isPlaintextDB(path), false);
  assert.equal(countItems(path), 5);

  const db = openEncryptedDB(path, key);
  try {
    const marker = db.prepare("SELECT value FROM schema_meta WHERE key = 'encryption_migrated'").get();
    assert.equal(marker?.value, "1", "the migration marker is missing");
    assert.equal(db.pragma("integrity_check", { simple: true }), "ok");
  } finally {
    db.close();
  }
  assert.equal(existsSync(`${path}.enc.tmp`), false, ".enc.tmp left behind");
  assert.equal(existsSync(`${path}.enc.bak`), false, ".enc.bak left behind");
});

// --- 5. truncated file ------------------------------------------------------
test("B3 truncated file: clear error, bytes unchanged", () => {
  const path = damagedCopy("truncated.db");
  truncateSync(path, 100);
  const before = sha256(path);

  assert.throws(
    () => openEncryptedDB(path, key),
    (e) => e.message === WRONG_KEY_ERROR,
    "a truncated file must throw the clear error"
  );

  assert.equal(sha256(path), before, "a failed open rewrote the truncated file");
  assert.equal(statSync(path).size, 100);
  assert.equal(isPlaintextDB(path), false);
});
