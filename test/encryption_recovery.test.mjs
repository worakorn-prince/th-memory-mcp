// Ph-6 A2/A3 — crash recovery for an interrupted plaintext→encrypted migration
// and fail-fast behaviour for a wrong key / corrupted file.
//
//   A2 states: tmp only, bak only, bak+db (good db), bak+db (corrupt db), tmp+db
//   A2 end-to-end: recovery also runs from createRawDb() (spawned app process)
//   A3: wrong key and truncated file throw one clear message, fast
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  copyFileSync,
  truncateSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import Database from "better-sqlite3-multiple-ciphers";
import {
  migrateIfNeeded,
  openEncryptedDB,
  isEncrypted,
  isPlaintextDB,
  recoverEncryptionState,
  WRONG_KEY_ERROR,
} from "../dist/db/encryption.js";

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

const workDir = mkdtempSync(join(tmpdir(), "th-enc-recovery-"));
const key = new Uint8Array(32).fill(3);
const wrongKey = new Uint8Array(32).fill(4);
const keyBase64 = Buffer.from(key).toString("base64");

console.log("Work dir:", workDir);

/** Small plaintext DB with an FTS5 table, a secondary index and rows. */
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

function countItems(dbPath, encrypted) {
  const db = encrypted ? openEncryptedDB(dbPath, key) : new Database(dbPath, { readonly: true });
  try {
    return db.prepare("SELECT count(*) AS c FROM items").get().c;
  } finally {
    db.close();
  }
}

// Fixtures: a real plaintext DB, and the real encrypted bytes a completed
// migration produces (used as the content of a "crash left a tmp behind" state).
const fixturePlain = join(workDir, "fixture-plain.db");
makePlaintext(fixturePlain);
check("fixture: plaintext DB has 5 rows", () => assert.equal(countItems(fixturePlain, false), 5));

const encryptedFixture = join(workDir, "fixture-encrypted.db");
check("fixture: real migration produces an encrypted DB", () => {
  makePlaintext(encryptedFixture);
  assert.equal(migrateIfNeeded(encryptedFixture, key), true);
  assert.equal(isEncrypted(encryptedFixture, key), true);
  assert.equal(countItems(encryptedFixture, true), 5);
});

// --- A2 state 1: tmp exists, db missing (crash after step 2) ---
{
  const dir = join(workDir, "state-tmp-only");
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "app.db");
  copyFileSync(encryptedFixture, `${dbPath}.enc.tmp`);

  check("A2 tmp-only: pre-state is db missing + tmp present", () => {
    assert.equal(existsSync(dbPath), false);
    assert.equal(existsSync(`${dbPath}.enc.tmp`), true);
  });

  let actions = [];
  check("A2 tmp-only: recovery promotes the verified tmp", () => {
    actions = recoverEncryptionState(dbPath, key);
    assert.equal(actions.length, 1);
    assert.match(actions[0], /promoted/);
    assert.equal(existsSync(dbPath), true);
    assert.equal(existsSync(`${dbPath}.enc.tmp`), false);
  });
  check("A2 tmp-only: promoted DB opens with the key, no data loss", () => {
    assert.equal(isEncrypted(dbPath, key), true);
    assert.equal(countItems(dbPath, true), 5);
  });
  check("A2 tmp-only: recovery is idempotent", () =>
    assert.deepEqual(recoverEncryptionState(dbPath, key), []));
}

// --- A2 state 2: bak exists, db missing (crash between the two renames) ---
{
  const dir = join(workDir, "state-bak-only");
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "app.db");
  makePlaintext(dbPath);
  copyFileSync(dbPath, `${dbPath}.enc.bak`);
  rmSync(dbPath);

  check("A2 bak-only: restore brings the original plaintext DB back", () => {
    const actions = recoverEncryptionState(dbPath, key);
    assert.equal(actions.length, 1);
    assert.match(actions[0], /restored/);
    assert.equal(existsSync(`${dbPath}.enc.bak`), false);
    assert.equal(isPlaintextDB(dbPath), true);
    assert.equal(countItems(dbPath, false), 5);
  });
  check("A2 bak-only: restored DB can then migrate normally", () => {
    assert.equal(migrateIfNeeded(dbPath, key), true);
    assert.equal(countItems(dbPath, true), 5);
  });
  check("A2 bak-only: recovery is idempotent after recovery", () =>
    assert.deepEqual(recoverEncryptionState(dbPath, key), []));
}

// --- A2 state 3a: bak + db, db is good ---
{
  const dir = join(workDir, "state-bak-db-good");
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "app.db");
  makePlaintext(dbPath);
  copyFileSync(dbPath, `${dbPath}.enc.bak`);

  check("A2 bak+good-db: db is kept and the bak is removed", () => {
    const actions = recoverEncryptionState(dbPath, key);
    assert.equal(actions.length, 1);
    assert.match(actions[0], /removed \.enc\.bak/);
    assert.equal(existsSync(`${dbPath}.enc.bak`), false);
    assert.equal(countItems(dbPath, false), 5);
  });
}

// --- A2 state 3b: bak + db, db is unreadable ---
{
  const dir = join(workDir, "state-bak-db-bad");
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "app.db");
  makePlaintext(dbPath);
  copyFileSync(dbPath, `${dbPath}.enc.bak`);
  // Corrupt the "new" db: a full page of NUL bytes neither opens as plaintext
  // nor as an encrypted SQLCipher file.
  writeFileSync(dbPath, Buffer.alloc(8192, 0));

  check("A2 bak+unreadable-db: both files are left untouched (cannot inspect)", () => {
    const before = statSync(dbPath).size;
    const actions = recoverEncryptionState(dbPath, key);
    assert.equal(actions.length, 1);
    assert.match(actions[0], /cannot inspect/);
    assert.ok(
      existsSync(`${dbPath}.enc.bak`),
      "the backup must be kept when the live file cannot be inspected"
    );
    assert.equal(existsSync(`${dbPath}.corrupt`), false);
    assert.equal(statSync(dbPath).size, before, "the unreadable file must not be replaced");
  });
}

// --- A2 state 4: tmp + db (db is authoritative) ---
{
  const dir = join(workDir, "state-tmp-db");
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "app.db");
  makePlaintext(dbPath);
  copyFileSync(encryptedFixture, `${dbPath}.enc.tmp`);

  check("A2 tmp+db: tmp is discarded, db untouched", () => {
    const actions = recoverEncryptionState(dbPath, key);
    assert.equal(actions.length, 1);
    assert.match(actions[0], /discarded stale \.enc\.tmp/);
    assert.equal(existsSync(`${dbPath}.enc.tmp`), false);
    assert.equal(isPlaintextDB(dbPath), true);
    assert.equal(countItems(dbPath, false), 5);
  });
}

// --- A2 no-op: nothing to recover ---
{
  const dir = join(workDir, "state-clean");
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "app.db");
  makePlaintext(dbPath);
  check("A2 clean: recovery is a silent no-op", () => {
    assert.deepEqual(recoverEncryptionState(dbPath, key), []);
    assert.deepEqual(recoverEncryptionState(dbPath, key), []);
    assert.equal(countItems(dbPath, false), 5);
  });
}

// --- A2 end-to-end: recovery runs from createRawDb() on the app path ---
{
  const dir = join(workDir, "state-app-startup");
  mkdirSync(dir, { recursive: true });
  const dbPath = join(dir, "app.db");
  copyFileSync(encryptedFixture, `${dbPath}.enc.tmp`);

  const launcher = join(dir, "start.mjs");
  const dbUrl = new URL("../dist/db/index.js", import.meta.url).href;
  writeFileSync(
    launcher,
    [
      `const app = await import(${JSON.stringify(dbUrl)});`,
      "const db = app.getDb();",
      "process.stdout.write('ROWS ' + db.prepare('SELECT count(*) AS c FROM items').get().c + '\\n');",
    ].join("\n")
  );

  const env = { ...process.env, MEMORY_DB_PATH: dbPath, MEMORY_ENCRYPTION: "on", MEMORY_ENCRYPTION_KEY: keyBase64 };
  for (const name of Object.keys(env)) {
    if (name.startsWith("MEMORY_") && name !== "MEMORY_DB_PATH" && name !== "MEMORY_ENCRYPTION" && name !== "MEMORY_ENCRYPTION_KEY") {
      delete env[name];
    }
  }
  // spawnSync (not execFileSync) so stderr is captured on success too.
  const run = spawnSync(process.execPath, [launcher], {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = run.stdout ?? "";
  const stderr = run.stderr ?? "";
  const threw = run.status === 0 ? null : new Error(`exit ${run.status}`);

  check("A2 createRawDb: app starts on a crash-left tmp and recovers", () => {
    assert.equal(threw, null, `child failed: ${stderr || (threw && threw.message)}`);
    assert.match(stdout, /ROWS 5/);
    assert.equal(existsSync(dbPath), true);
    assert.equal(existsSync(`${dbPath}.enc.tmp`), false);
  });
  check("A2 createRawDb: exactly one bounded recovery line on stderr", () => {
    const lines = stderr.split(/\r?\n/).filter((l) => l.includes("encryption recovery:"));
    assert.equal(lines.length, 1, `stderr: ${stderr}`);
    assert.ok(!stderr.includes(keyBase64), "key material must never be logged");
  });
}

// --- A3: wrong key fails fast with one clear message ---
{
  const wrongKeyPath = join(workDir, "wrong-key-copy.db");
  copyFileSync(encryptedFixture, wrongKeyPath);

  check("A3 wrong key: opening throws the clear message", () => {
    let message = null;
    try {
      openEncryptedDB(wrongKeyPath, wrongKey);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    assert.equal(message, WRONG_KEY_ERROR);
  });
  check("A3 wrong key: isEncrypted returns false, file is untouched", () => {
    assert.equal(isEncrypted(wrongKeyPath, wrongKey), false);
    assert.equal(isEncrypted(wrongKeyPath, key), true);
  });
  check("A3 wrong key: a plaintext DB is untouched by the failed open", () => {
    const plainPath = join(workDir, "plain-untouched.db");
    makePlaintext(plainPath);
    assert.throws(() => openEncryptedDB(plainPath, key), (e) => e.message === WRONG_KEY_ERROR);
    assert.equal(isPlaintextDB(plainPath), true);
    assert.equal(countItems(plainPath, false), 5);
  });
}

// --- A3: truncated/corrupted encrypted file fails fast, no hang ---
{
  const truncatedPath = join(workDir, "truncated.db");
  copyFileSync(encryptedFixture, truncatedPath);
  truncateSync(truncatedPath, 100);

  check("A3 truncated file: throws the clear message quickly", () => {
    const started = Date.now();
    let message = null;
    try {
      openEncryptedDB(truncatedPath, key);
    } catch (e) {
      message = e instanceof Error ? e.message : String(e);
    }
    const elapsed = Date.now() - started;
    assert.equal(message, WRONG_KEY_ERROR);
    assert.ok(elapsed < 5000, `open took ${elapsed}ms`);
  });
  check("A3 truncated file: not reported as plaintext", () => assert.equal(isPlaintextDB(truncatedPath), false));
}

// Cleanup
try {
  rmSync(workDir, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log(`\n--- Summary: ${step} checks, ${failures} failures ---`);
if (failures > 0) process.exit(1);
