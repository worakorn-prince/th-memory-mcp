// Ph-6 review fixes — atomic backups on the real boot path (F2), fail-closed
// backup verification (F5) and the "never destroy the destination" restore
// behaviour (F1 lives in backup_verify_restore.test.mjs).
//
// F2: `backupDatabase()` runs at boot before migrations. A kill mid-VACUUM must
// never leave a partial `<db>.backup-*` that looks like a usable backup.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import Database from "better-sqlite3-multiple-ciphers";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const {
  openEncryptedDB,
  migrateIfNeeded,
  backupEncryptedDB,
  verifyEncryptedBackup,
  BACKUP_STAGING_RE,
} = await import("../dist/db/encryption.js");
const { backupDatabase } = await import("../dist/db/migrations.js");

const workDir = mkdtempSync(join(tmpdir(), "th-p6-backup-atomic-"));
const key = new Uint8Array(32).fill(21);
const keyB64 = Buffer.from(key).toString("base64");
const children = new Set();

after(() => {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }
  try {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    /* best effort */
  }
});

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function appEnv(dbPath, extra = {}) {
  const env = { ...process.env, MEMORY_DB_PATH: dbPath };
  for (const name of Object.keys(env)) {
    if (name.startsWith("MEMORY_") && name !== "MEMORY_DB_PATH") delete env[name];
  }
  return { ...env, ...extra };
}

/** A plaintext DB big enough that VACUUM INTO takes a measurable time. */
function makeBigPlaintext(path) {
  const script = `
const Database = (await import("better-sqlite3-multiple-ciphers")).default;
const db = new Database(process.env.P);
db.exec("CREATE TABLE IF NOT EXISTS blob_store (id INTEGER PRIMARY KEY, payload BLOB)");
db.exec("WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i < 2500)" +
  " INSERT INTO blob_store (payload) SELECT zeroblob(4096) FROM seq");
db.pragma("wal_checkpoint(TRUNCATE)");
db.close();
process.stdout.write("OK\\n");
`;
  const seeded = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    env: { ...process.env, P: path },
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(seeded.status, 0, `seed failed: ${seeded.stderr}`);
}

const BACKUP_WORKER = `
const Database = (await import("better-sqlite3-multiple-ciphers")).default;
const { backupDatabase } = await import(${JSON.stringify(
  new URL("../dist/db/migrations.js", import.meta.url).href
)});
const db = new Database(process.env.P);
process.stdout.write("OPENED\\n");
const out = backupDatabase(db, process.env.P);
process.stdout.write("DONE " + out + "\\n");
db.close();
`;

test("F2 backupDatabase: a killed VACUUM never leaves a partial backup file", async () => {
  const dbPath = join(workDir, "boot.db");
  makeBigPlaintext(dbPath);
  const sourceHash = sha256(dbPath);

  for (const delay of [120, 300, 600]) {
    const before = new Set(readdirSync(workDir));
    const child = spawn(process.execPath, ["--input-type=module", "-e", BACKUP_WORKER], {
      cwd: root,
      env: appEnv(dbPath, { P: dbPath }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }, delay);
    await new Promise((resolve) => child.on("exit", resolve));
    clearTimeout(timer);
    children.delete(child);

    assert.equal(sha256(dbPath), sourceHash, `source changed after a kill at ${delay} ms`);

    const backups = readdirSync(workDir).filter(
      (f) => f.startsWith("boot.db.backup-") && !f.includes(".tmp-")
    );
    for (const name of backups) {
      const full = join(workDir, name);
      const check = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `const Database=(await import("better-sqlite3-multiple-ciphers")).default;
           const db=new Database(process.env.B,{readonly:true});
           const r=db.pragma("integrity_check",{simple:true});
           const n=db.prepare("SELECT count(*) AS c FROM sqlite_master").get().c;
           db.close();
           if(r!=="ok"||n<=0){process.exit(3)}`,
        ],
        { cwd: root, env: { ...process.env, B: full }, encoding: "utf8", timeout: 60000 }
      );
      assert.equal(
        check.status,
        0,
        `a partial backup survived the kill at ${delay} ms: ${name} (${check.stderr})`
      );
    }

    // Any staging file must be hidden and non-authoritative.
    const staging = readdirSync(workDir).filter((f) => f.includes(".tmp-"));
    for (const name of staging) {
      assert.ok(name.startsWith("."), `staging file is not hidden: ${name}`);
      assert.ok(
        /\.tmp-\d+-\d+(-journal|-wal|-shm)?$/.test(name),
        `unexpected staging name: ${name}`
      );
    }
    for (const name of readdirSync(workDir)) {
      if (!before.has(name) && name.startsWith("boot.db.backup-") && !name.includes(".tmp-")) {
        assert.ok(existsSync(join(workDir, name)));
      }
    }
  }
});

test("F2 backupDatabase: a completed backup is a valid standalone database", () => {
  const dbPath = join(workDir, "boot-done.db");
  makeBigPlaintext(dbPath);
  const db = new Database(dbPath);
  const out = backupDatabase(db, dbPath);
  db.close();

  assert.equal(existsSync(out), true, `backup missing: ${out}`);
  assert.ok(statSync(out).size > 0);
  const check = new Database(out, { readonly: true });
  try {
    assert.equal(check.pragma("integrity_check", { simple: true }), "ok");
    const n = check.prepare("SELECT count(*) AS c FROM blob_store").get().c;
    assert.ok(n >= 2500, `backup lost rows: ${n}`);
  } finally {
    check.close();
  }
});

test("F2 backupDatabase: an encrypted DB backs up through the verified path", () => {
  const plain = join(workDir, "enc-src-plain.db");
  makeBigPlaintext(plain);
  const encPath = join(workDir, "enc-src.db");
  copyFileSync(plain, encPath);
  assert.equal(migrateIfNeeded(encPath, key), true);

  const db = openEncryptedDB(encPath, key);
  const out = backupDatabase(db, encPath);
  db.close();

  const result = verifyEncryptedBackup(out, key);
  assert.equal(result.integrityOk, true, `encrypted backup failed verification: ${out}`);
  assert.ok(result.tables.blob_store >= 2500, JSON.stringify(result.tables));
});

test("F5 backupEncryptedDB: a connection this module did not open is rejected", () => {
  const plain = join(workDir, "raw-src-plain.db");
  makeBigPlaintext(plain);
  const src = join(workDir, "raw-src.db");
  copyFileSync(plain, src);
  assert.equal(migrateIfNeeded(src, key), true);
  const out = join(workDir, "raw-out.db");

  // A raw handle with the key set: the data is readable, but the module has no
  // record of the key, so it must refuse rather than silently skip verification.
  const raw = new Database(src);
  const keyHex = Buffer.from(key).toString("hex");
  raw.pragma(`key = "x'${keyHex}'"`);
  raw.pragma("kdf_iter = 256000");
  raw.pragma("page_size = 4096");
  assert.ok(raw.prepare("SELECT count(*) AS c FROM blob_store").get().c >= 2500);

  try {
    assert.throws(
      () => backupEncryptedDB(raw, out),
      /cannot verify a backup copy without the database key/i
    );
    assert.equal(existsSync(out), false, "no backup may be promoted without verification");
  } finally {
    raw.close();
  }
});

test("F2 boot path: MEMORY_BACKUP_ON_MIGRATE leaves a usable backup beside the DB", () => {
  const dbPath = join(workDir, "boot-migrate.db");
  makeBigPlaintext(dbPath);
  // Remove the migration marker so the next open has a pending migration and
  // therefore takes a pre-migration backup.
  const raw = new Database(dbPath);
  raw.exec("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  raw.prepare("DELETE FROM schema_meta WHERE key = ?").run("001_schema_meta");
  raw.close();

  const run = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", 'const app=await import("./dist/db/index.js"); app.getDb(); process.stdout.write("READY\\n");'],
    { cwd: root, env: appEnv(dbPath, { MEMORY_BACKUP_ON_MIGRATE: "1" }), encoding: "utf8", timeout: 120000 }
  );
  assert.equal(run.status, 0, `boot failed: ${run.stderr}`);

  const backups = readdirSync(workDir).filter(
    (f) => f.startsWith("boot-migrate.db.backup-") && !f.includes(".tmp-")
  );
  assert.ok(backups.length >= 1, "the boot path must leave a backup");
  for (const name of backups) {
    const check = new Database(join(workDir, name), { readonly: true });
    try {
      assert.equal(check.pragma("integrity_check", { simple: true }), "ok", `${name} is not usable`);
    } finally {
      check.close();
    }
  }
});

// Regression (Ph-6 review): the public `db` export is a Proxy over the real
// handle, and `runMigrations()` is exported too. Under MEMORY_ENCRYPTION=on the
// pre-migration backup used to look the key up by handle identity (WeakMap), so
// passing the proxy aborted the migration with
// "cannot verify a backup copy without the database key".
// The key is now resolved from config, so the public API behaves identically
// with encryption off and on. The child owns its key/DB env: this must not leak
// into the in-process environment of the other tests in this file.
const PROXY_MIGRATE_WORKER = `
const { db } = await import("./dist/db/index.js");
const { runMigrations } = await import("./dist/db/migrations.js");
const { readdirSync } = await import("node:fs");
const { basename, dirname } = await import("node:path");
const dir = dirname(process.env.MEMORY_DB_PATH);
const prefix = basename(process.env.MEMORY_DB_PATH) + ".backup-";
const list = function () {
  return readdirSync(dir).filter(function (n) {
    return n.indexOf(prefix) === 0 && n.indexOf(".tmp-") === -1;
  });
};
db.prepare("SELECT count(*) AS c FROM sqlite_master").get();
const before = list();
db.prepare("DELETE FROM schema_meta WHERE key = ?").run("017_scope");
runMigrations(db);
const after = list();
process.stdout.write(
  JSON.stringify({ dir: dir, before: before, after: after }) + "\\n"
);
`;

test("F2 boot path: runMigrations(db) on the exported proxy backs up an encrypted DB", () => {
  const dbPath = join(workDir, "proxy-migrate.db");
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", PROXY_MIGRATE_WORKER], {
    cwd: root,
    env: appEnv(dbPath, { MEMORY_ENCRYPTION: "on", MEMORY_ENCRYPTION_KEY: keyB64 }),
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(
    run.status,
    0,
    `runMigrations(db proxy) must complete under encryption: ${run.stderr}`
  );

  const lines = run.stdout.trim().split(/\r?\n/);
  const parsed = JSON.parse(lines[lines.length - 1]);
  const written = parsed.after.filter((n) => !parsed.before.includes(n));
  assert.equal(
    written.length,
    1,
    `runMigrations(db proxy) must write exactly one pre-migration backup, got ${JSON.stringify(written)}`
  );

  const full = join(parsed.dir, written[0]);
  assert.ok(existsSync(full), `backup missing: ${full}`);
  const result = verifyEncryptedBackup(full, key);
  assert.equal(result.encrypted, true, `${written[0]} is not encrypted`);
  assert.equal(result.integrityOk, true, `${written[0]} does not open with the database key`);
  assert.ok(result.tables.schema_meta > 0, `${written[0]} is not a snapshot of the migrated schema`);
  assert.equal(typeof result.tables.memories, "number", `${written[0]} is missing the memories table`);
});

test("F2 prune: staging files are never counted as backup generations", () => {
  const dbPath = join(workDir, "prune.db");
  makeBigPlaintext(dbPath);

  // Five real generations plus two staging files (one hidden, one legacy shape).
  for (let i = 0; i < 5; i++) {
    copyFileSync(dbPath, `${dbPath}.backup-17000000000${i}0`);
  }
  writeFileSync(join(workDir, `.${basename(dbPath)}.staging-999-0`), "partial");
  writeFileSync(`${dbPath}.backup-1700000000099.tmp-999-1`, "partial");

  // Force a pending migration so the boot path takes (and prunes) a backup.
  const raw = new Database(dbPath);
  raw.exec("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  raw.prepare("DELETE FROM schema_meta WHERE key = ?").run("001_schema_meta");
  raw.close();

  const run = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", 'const app=await import("./dist/db/index.js"); app.getDb(); process.stdout.write("READY\\n");'],
    { cwd: root, env: appEnv(dbPath, { MEMORY_BACKUP_ON_MIGRATE: "1" }), encoding: "utf8", timeout: 120000 }
  );
  assert.equal(run.status, 0, `boot failed: ${run.stderr}`);

  const real = readdirSync(workDir).filter(
    (f) => f.startsWith("prune.db.backup-") && !f.includes(".staging-") && !f.includes(".tmp-")
  );
  assert.equal(
    real.length,
    5,
    `pruning must keep five real generations, got ${real.length}: ${real.join(", ")}`
  );
});

test("F2 staging predicate: BACKUP_STAGING_RE excludes staging, never a real generation", () => {
  const dbPath = join(workDir, "boot-stage.db");
  makeBigPlaintext(dbPath);

  // The current hidden staging name and the legacy prefixed one, plus a real
  // generation for the same stem.
  const hidden = `.${basename(dbPath)}.backup-200001010000.staging-${process.pid}-0`;
  const prefixed = `${basename(dbPath)}.backup-200001010001.staging-${process.pid}-1`;
  const real = `${basename(dbPath)}.backup-200001010002`;
  writeFileSync(join(workDir, hidden), "partial");
  writeFileSync(join(workDir, prefixed), "partial");
  copyFileSync(dbPath, join(workDir, real));

  assert.equal(BACKUP_STAGING_RE.test(hidden), true, `${hidden} must be recognised as staging`);
  assert.equal(BACKUP_STAGING_RE.test(prefixed), true, `${prefixed} must be recognised as staging`);
  assert.equal(BACKUP_STAGING_RE.test(real), false, "a real backup name must never match");

  // The scanner predicate used by pruneOldBackups()/newestBackup(): the
  // prefixed staging file shares the generation prefix, so dropping the regex
  // filter would count it as a backup.
  const prefix = `${basename(dbPath)}.backup-`;
  const generations = readdirSync(workDir).filter(
    (n) => n.startsWith(prefix) && !BACKUP_STAGING_RE.test(n)
  );
  assert.deepEqual(generations, [real]);
});
