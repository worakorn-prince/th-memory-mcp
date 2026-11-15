// Ph-6 C3/C4 — backup generations, verification and the restore drill.
//
// Covers: verifyEncryptedBackup on good/zero-byte/truncated/corrupt copies,
// the out/out.1 generation rotation (including an interrupted backup), the
// `db restore` CLI (fresh target, refusal without --force, live-DB refusal)
// and the `db drill` report.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
  copyFileSync,
  readdirSync,
  truncateSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

import Database from "better-sqlite3-multiple-ciphers";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const CLI = join(root, "dist", "cli.js");

const {
  openEncryptedDB,
  migrateIfNeeded,
  backupEncryptedDB,
  verifyEncryptedBackup,
  isEncrypted,
  isPlaintextDB,
  WRONG_KEY_ERROR,
} = await import("../dist/db/encryption.js");
const { writeBackup } = await import("../dist/db/migrations.js");

const workDir = mkdtempSync(join(tmpdir(), "th-p6-backup-"));
const oldKey = new Uint8Array(32).fill(11);
const oldB64 = Buffer.from(oldKey).toString("base64");

const children = new Set();
after(() => {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  rmSync(workDir, { recursive: true, force: true });
});

function appEnv(dbPath, extra = {}) {
  const env = { ...process.env, MEMORY_DB_PATH: dbPath };
  delete env.MEMORY_AUTH;
  delete env.MEMORY_AUTH_TOKEN;
  delete env.MEMORY_AUTH_TOKEN_FILE;
  delete env.MEMORY_ENCRYPTION;
  delete env.MEMORY_ENCRYPTION_KEY;
  delete env.MEMORY_BACKUP_ON_MIGRATE;
  return { ...env, ...extra };
}

const cli = (args, dbPath, extra = {}) =>
  spawnSync(process.execPath, [CLI, ...args], {
    cwd: root,
    env: appEnv(dbPath, extra),
    encoding: "utf8",
    timeout: 120000,
  });

// ------------------------------------------------ fixture: real-shape DB ---
const fixturePlain = join(workDir, "fixture-plain.db");
const fixtureEnc = join(workDir, "fixture-enc.db");

{
  const script = [
    `const app = await import(${JSON.stringify(
      new URL("../dist/db/index.js", import.meta.url).href
    )});`,
    "const db = app.getDb();",
    "const now = new Date().toISOString();",
    `db.prepare("INSERT INTO preferences (category,key,value,confidence,source,user_id,updated_at) VALUES (?,?,?,0.5,'explicit',NULL,?)").run('coding','backup_probe','pnpm',now);`,
    `db.prepare("INSERT INTO lessons (situation,mistake,correction,user_id,created_at) VALUES (?,?,?,NULL,?)").run('backup lesson','m','use pnpm',now);`,
    `db.prepare("INSERT INTO interactions (ts,session_id,kind,content,user_id) VALUES (?,?,?,?,NULL)").run(now,'s','prompt','backup interaction probe');`,
    "db.exec('WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i < 600)' +",
    '  " INSERT INTO embeddings (ref_table, ref_id, vec) SELECT \'bulk\', i, zeroblob(4096) FROM seq");',
    "db.pragma('wal_checkpoint(TRUNCATE)');",
    "console.log('SEEDED');",
  ].join("\n");
  const seeded = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    env: appEnv(fixturePlain, { MEMORY_ENCRYPTION: "off" }),
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(seeded.status, 0, `fixture seed failed: ${seeded.stderr}${seeded.stdout}`);
  assert.match(seeded.stdout, /SEEDED/);
}

test("C3 fixture: plaintext fixture migrates and reports its row counts", () => {
  copyFileSync(fixturePlain, fixtureEnc);
  assert.equal(migrateIfNeeded(fixtureEnc, oldKey), true);
  assert.equal(isEncrypted(fixtureEnc, oldKey), true);
  const result = verifyEncryptedBackup(fixtureEnc, oldKey);
  assert.equal(result.exists, true);
  assert.equal(result.encrypted, true);
  assert.equal(result.integrityOk, true);
  assert.ok(result.size > 1024 * 1024, `fixture too small: ${result.size}`);
  assert.ok(result.tables.preferences >= 1, JSON.stringify(result.tables));
  assert.ok(result.tables.embeddings >= 600, JSON.stringify(result.tables));
});

// ---------------------------------------------------- verifyEncryptedBackup ---
test("C3 verify: a good backup verifies and matches the source counts", () => {
  const src = join(workDir, "verify-src.db");
  const out = join(workDir, "verify-good.db");
  copyFileSync(fixtureEnc, src);
  const db = openEncryptedDB(src, oldKey);
  backupEncryptedDB(db, out);
  db.close();

  const result = verifyEncryptedBackup(out, oldKey);
  assert.equal(result.exists, true);
  assert.equal(result.encrypted, true);
  assert.equal(result.integrityOk, true);
  const srcCounts = verifyEncryptedBackup(src, oldKey).tables;
  for (const [table, n] of Object.entries(srcCounts)) {
    assert.equal(result.tables[table], n, `row count mismatch for ${table}`);
  }
});

test("C3 verify: zero-byte, truncated and corrupted copies are reported, not thrown", () => {
  const zero = join(workDir, "verify-zero.db");
  writeFileSync(zero, Buffer.alloc(0));
  const zeroResult = verifyEncryptedBackup(zero, oldKey);
  assert.equal(zeroResult.exists, true);
  assert.equal(zeroResult.encrypted, false);
  assert.equal(zeroResult.integrityOk, false);

  const truncated = join(workDir, "verify-truncated.db");
  copyFileSync(fixtureEnc, truncated);
  truncateSync(truncated, 4096);
  const truncResult = verifyEncryptedBackup(truncated, oldKey);
  assert.equal(truncResult.integrityOk, false);

  const corrupt = join(workDir, "verify-corrupt.db");
  copyFileSync(fixtureEnc, corrupt);
  const fd = readFileSync(corrupt);
  for (let i = 8192; i < 12288 && i < fd.length; i++) fd[i] = 0xff;
  writeFileSync(corrupt, fd);
  const corruptResult = verifyEncryptedBackup(corrupt, oldKey);
  assert.equal(
    corruptResult.integrityOk === true && corruptResult.encrypted === true,
    false,
    "a corrupted page must not verify as a healthy backup"
  );

  const missing = verifyEncryptedBackup(join(workDir, "does-not-exist.db"), oldKey);
  assert.equal(missing.exists, false);
  assert.equal(missing.integrityOk, false);
});

test("C3 verify: a wrong key is reported as not encrypted (never as ok)", () => {
  const wrong = new Uint8Array(32).fill(12);
  const result = verifyEncryptedBackup(fixtureEnc, wrong);
  assert.equal(result.integrityOk, false);
});

test("C3 verify: a plaintext file is reported as not encrypted", () => {
  const result = verifyEncryptedBackup(fixturePlain, oldKey);
  assert.equal(result.encrypted, false);
  assert.equal(result.integrityOk, false);
});

// ------------------------------------------------------- backup generations ---
test("C3 generations: a second backup rotates the previous one to out.1", () => {
  const src = join(workDir, "gen-src.db");
  const out = join(workDir, "gen-out.db");
  copyFileSync(fixtureEnc, src);

  const db = openEncryptedDB(src, oldKey);
  backupEncryptedDB(db, out);
  const first = verifyEncryptedBackup(out, oldKey);
  assert.equal(first.integrityOk, true);
  assert.equal(existsSync(`${out}.1`), false, "no generation exists after the first backup");

  // Change the source so the second backup is distinguishable.
  db.prepare(
    "INSERT INTO preferences (category,key,value,confidence,source,user_id,updated_at) VALUES (?,?,?,0.5,'explicit',NULL,?)"
  ).run("coding", "generation_probe", "npm", new Date().toISOString());
  backupEncryptedDB(db, out);
  db.close();

  assert.equal(existsSync(`${out}.1`), true, "the previous backup must be kept as out.1");
  const second = verifyEncryptedBackup(out, oldKey);
  const previous = verifyEncryptedBackup(`${out}.1`, oldKey);
  assert.equal(second.integrityOk, true);
  assert.equal(previous.integrityOk, true);
  assert.ok(
    second.tables.preferences > previous.tables.preferences,
    `the new backup must contain the extra row (${second.tables.preferences} vs ${previous.tables.preferences})`
  );
});

test("C3 generations: an interrupted backup leaves the previous generation intact", async () => {
  const src = join(workDir, "gen-kill-src.db");
  const out = join(workDir, "gen-kill-out.db");
  copyFileSync(fixtureEnc, src);

  const db = openEncryptedDB(src, oldKey);
  backupEncryptedDB(db, out);
  db.close();
  const baseline = verifyEncryptedBackup(out, oldKey);
  assert.equal(baseline.integrityOk, true);

  // Kill a child mid-VACUUM on a fresh destination: out must stay untouched.
  const script = `
const { openEncryptedDB, backupEncryptedDB } = await import(${JSON.stringify(
    new URL("../dist/db/encryption.js", import.meta.url).href
  )});
const key = new Uint8Array(Buffer.from(process.env.K, "base64"));
const db = openEncryptedDB(process.env.SRC, key);
process.stdout.write("OPEN\\n");
backupEncryptedDB(db, process.env.OUT);
process.stdout.write("DONE\\n");
`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    env: appEnv(src, { SRC: src, OUT: out, K: oldB64 }),
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
  }, 350);
  await new Promise((resolve) => child.on("exit", resolve));
  clearTimeout(timer);
  children.delete(child);

  const completed = stdout.includes("DONE");
  const result = verifyEncryptedBackup(out, oldKey);
  assert.equal(result.integrityOk, true, `out must stay valid (completed=${completed})`);
  assert.ok(
    result.tables.preferences >= baseline.tables.preferences,
    "the surviving backup must not lose rows"
  );
  const strays = readdirSync(workDir).filter((f) => f.includes(".staging-") || f.includes(".tmp-"));
  for (const stray of strays) {
    // A killed VACUUM may leave a staging file plus its journal/WAL sidecars.
    // It does not have to be hidden, but it must match the staging shape so
    // newestBackup()/pruneOldBackups() never treat it as a backup.
    assert.ok(
      /\.(staging|tmp)-\d+-\d+(-journal|-wal|-shm)?$/.test(stray),
      `unexpected stray next to the backup: ${stray}`
    );
  }
  assert.equal(verifyEncryptedBackup(out, oldKey).integrityOk, true);
  if (existsSync(`${out}.1`)) {
    assert.equal(verifyEncryptedBackup(`${out}.1`, oldKey).integrityOk, true);
  }
});

// ------------------------------------------------------------------ restore ---
test("C4 restore: writes a verified copy to a fresh target", () => {
  const target = join(workDir, "restore-fresh.db");
  const result = cli(
    ["db", "restore", fixtureEnc, "--to", target],
    fixtureEnc,
    { MEMORY_ENCRYPTION: "on", MEMORY_ENCRYPTION_KEY: oldB64 }
  );
  assert.equal(result.status, 0, `restore failed: ${result.stderr}`);
  assert.equal(existsSync(target), true);
  const verified = verifyEncryptedBackup(target, oldKey);
  assert.equal(verified.integrityOk, true);
  assert.equal(verified.tables.memories, verifyEncryptedBackup(fixtureEnc, oldKey).tables.memories);
});

test("C4 restore: refuses an existing target without --force, accepts with it", () => {
  const target = join(workDir, "restore-existing.db");
  writeFileSync(target, "not a database");
  const refused = cli(
    ["db", "restore", fixtureEnc, "--to", target],
    fixtureEnc,
    { MEMORY_ENCRYPTION: "on", MEMORY_ENCRYPTION_KEY: oldB64 }
  );
  assert.equal(refused.status, 2, `expected refusal: ${refused.stdout}${refused.stderr}`);
  assert.equal(readFileSync(target, "utf8"), "not a database", "refusal must not touch the target");

  const forced = cli(
    ["db", "restore", fixtureEnc, "--to", target, "--force"],
    fixtureEnc,
    { MEMORY_ENCRYPTION: "on", MEMORY_ENCRYPTION_KEY: oldB64 }
  );
  assert.equal(forced.status, 0, `forced restore failed: ${forced.stderr}`);
  assert.equal(verifyEncryptedBackup(target, oldKey).integrityOk, true);
});

test("C4 restore: refuses the live database without --force and requires it explicitly", () => {
  const live = join(workDir, "restore-live.db");
  copyFileSync(fixtureEnc, live);
  const before = readFileSync(live);

  const refused = cli(["db", "restore", fixtureEnc, "--to", live], live, {
    MEMORY_ENCRYPTION: "on",
    MEMORY_ENCRYPTION_KEY: oldB64,
  });
  assert.equal(refused.status, 2, `the live DB must need --force: ${refused.stdout}`);
  assert.deepEqual(readFileSync(live), before, "a refusal must not touch the live DB");

  // With an explicit --force the operator has opted in (server must be stopped).
  const forced = cli(["db", "restore", fixtureEnc, "--to", live, "--force"], live, {
    MEMORY_ENCRYPTION: "on",
    MEMORY_ENCRYPTION_KEY: oldB64,
  });
  assert.equal(forced.status, 0, `forced restore failed: ${forced.stdout}${forced.stderr}`);
  assert.equal(verifyEncryptedBackup(live, oldKey).integrityOk, true);
});

test("C4 drill: reports a passing drill on a good backup and fails on a corrupt one", () => {
  const src = join(workDir, "drill-live.db");
  copyFileSync(fixtureEnc, src);
  const out = join(workDir, "drill-backup.db");
  const db = openEncryptedDB(src, oldKey);
  backupEncryptedDB(db, out);
  db.close();

  const ok = cli(["db", "drill", "--backup", out], src, {
    MEMORY_ENCRYPTION: "on",
    MEMORY_ENCRYPTION_KEY: oldB64,
  });
  assert.equal(ok.status, 0, `drill failed: ${ok.stdout}${ok.stderr}`);
  assert.match(ok.stdout, /drill|PASS|ok/i);

  const corrupt = join(workDir, "drill-corrupt.db");
  copyFileSync(out, corrupt);
  truncateSync(corrupt, 1024);
  const bad = cli(["db", "drill", "--backup", corrupt], src, {
    MEMORY_ENCRYPTION: "on",
    MEMORY_ENCRYPTION_KEY: oldB64,
  });
  assert.notEqual(bad.status, 0, "a corrupt backup must fail the drill");
});

test("C4 restore --force: a failed promote leaves the original target intact", () => {
  const target = join(workDir, "restore-fail-promote.db");
  const original = join(workDir, "restore-fail-original.db");
  copyFileSync(fixtureEnc, original);
  copyFileSync(fixtureEnc, target);
  const before = readFileSync(target);

  // Occupy the backup slot with a non-empty directory so the first rename
  // (target -> target.bak) must fail on Windows.
  const bakDir = `${target}.bak`;
  rmSync(bakDir, { recursive: true, force: true });
  mkdirSync(bakDir, { recursive: true });
  writeFileSync(join(bakDir, "blocker"), "x");

  const result = cli(
    ["db", "restore", original, "--to", target, "--force"],
    target,
    { MEMORY_ENCRYPTION: "on", MEMORY_ENCRYPTION_KEY: oldB64 }
  );

  assert.notEqual(result.status, 0, `a failed promote must not report success: ${result.stdout}`);
  assert.deepEqual(
    readFileSync(target),
    before,
    "the original target must survive a failed promote"
  );

  rmSync(bakDir, { recursive: true, force: true });
});

test("C4 restore --force: the displaced target takes its -wal/-shm sidecars to .bak", () => {
  const target = join(workDir, "restore-sidecar.db");
  copyFileSync(fixtureEnc, target);
  // Stale siblings of the file about to be displaced.
  writeFileSync(`${target}-wal`, "stale wal");
  writeFileSync(`${target}-shm`, "stale shm");

  const result = cli(
    ["db", "restore", fixtureEnc, "--to", target, "--force"],
    target,
    { MEMORY_ENCRYPTION: "on", MEMORY_ENCRYPTION_KEY: oldB64 }
  );
  assert.equal(result.status, 0, `forced restore failed: ${result.stdout}${result.stderr}`);

  // The old target's sidecars moved with it and are gone with the promoted
  // file: no stale -wal/-shm is left beside the restored database. Asserted
  // before opening the restored file (opening a WAL-mode DB creates its own).
  assert.equal(existsSync(`${target}-wal`), false, "a stale -wal must not survive the restore");
  assert.equal(existsSync(`${target}-shm`), false, "a stale -shm must not survive the restore");
  assert.equal(existsSync(`${target}.bak`), false, "the displaced copy is removed after success");
  assert.equal(existsSync(`${target}.bak-wal`), false);

  assert.equal(verifyEncryptedBackup(target, oldKey).integrityOk, true);
});

test("C3 CLI: verify-backup exits 0 on a good file and 1 on a corrupted one", () => {
  const good = join(workDir, "cli-verify-good.db");
  copyFileSync(fixtureEnc, good);
  const ok = cli(["db", "verify-backup", good], good, {
    MEMORY_ENCRYPTION: "on",
    MEMORY_ENCRYPTION_KEY: oldB64,
  });
  assert.equal(ok.status, 0, `verify-backup failed: ${ok.stderr}${ok.stdout}`);
  assert.ok(!ok.stdout.includes(oldB64), "the key must never be printed");

  const bad = join(workDir, "cli-verify-bad.db");
  copyFileSync(fixtureEnc, bad);
  truncateSync(bad, 2048);
  const failed = cli(["db", "verify-backup", bad], bad, {
    MEMORY_ENCRYPTION: "on",
    MEMORY_ENCRYPTION_KEY: oldB64,
  });
  assert.notEqual(failed.status, 0);
});

test("C3 CLI: verify-backup refuses without the encryption key", () => {
  const result = cli(["db", "verify-backup", fixtureEnc], fixtureEnc, {
    MEMORY_ENCRYPTION: "on",
  });
  assert.equal(result.status, 2, `expected a refusal: ${result.stdout}${result.stderr}`);
});

// ------------------------------------------- B1/B2: `db backup` end to end ---
/** The CLI wraps the command's own JSON string: { ok, data: "<json>" }. */
function backupData(result) {
  const lines = result.stdout.trim().split(/\r?\n/);
  const outer = JSON.parse(lines[lines.length - 1]);
  assert.equal(outer.ok, true, `backup reported failure: ${result.stdout}${result.stderr}`);
  return JSON.parse(outer.data);
}

const encEnv = { MEMORY_ENCRYPTION: "on", MEMORY_ENCRYPTION_KEY: oldB64 };

test("B1/B2: `db backup --out <path>` writes exactly that path and verifies", () => {
  const live = join(workDir, "b1-live.db");
  const out = join(workDir, "b1-out.db");
  copyFileSync(fixtureEnc, live);

  const result = cli(["db", "backup", "--out", out, "--json"], live, encEnv);
  assert.equal(
    result.status,
    0,
    `db backup --out must be an accepted option: ${result.stdout}${result.stderr}`
  );
  const data = backupData(result);
  assert.equal(data.to, out);
  assert.equal(data.encrypted, true);
  assert.equal(existsSync(out), true, "the documented path must exist");
  assert.ok(!result.stdout.includes(oldB64), "the key must never be printed");

  const verified = verifyEncryptedBackup(out, oldKey);
  assert.equal(verified.integrityOk, true);
  assert.equal(verified.tables.memories, verifyEncryptedBackup(fixtureEnc, oldKey).tables.memories);
});

test("B2: `db backup` with no --out prints a path that exists and verifies", () => {
  const encryptedLive = join(workDir, "b2-enc-live.db");
  copyFileSync(fixtureEnc, encryptedLive);
  const enc = cli(["db", "backup", "--json"], encryptedLive, encEnv);
  assert.equal(enc.status, 0, `encrypted db backup failed: ${enc.stdout}${enc.stderr}`);
  const encData = backupData(enc);
  assert.match(basename(encData.to), /^b2-enc-live\.db\.backup-\d+/);
  assert.equal(existsSync(encData.to), true, `the printed path must exist: ${encData.to}`);
  assert.equal(verifyEncryptedBackup(encData.to, oldKey).integrityOk, true);

  // Legacy/plaintext mode keeps working byte-for-byte (MEMORY_ENCRYPTION unset).
  const plainLive = join(workDir, "b2-plain-live.db");
  copyFileSync(fixturePlain, plainLive);
  const plain = cli(["db", "backup", "--json"], plainLive);
  assert.equal(plain.status, 0, `plaintext db backup failed: ${plain.stdout}${plain.stderr}`);
  const plainData = backupData(plain);
  assert.equal(plainData.encrypted, false);
  assert.equal(existsSync(plainData.to), true);
  const copy = new Database(plainData.to, { readonly: true });
  try {
    assert.equal(copy.pragma("integrity_check", { simple: true }), "ok");
    const rows = copy.prepare("SELECT count(*) AS c FROM preferences").get().c;
    assert.ok(rows >= 1, "the plaintext copy must carry the source rows");
  } finally {
    copy.close();
  }
});

test("B2: an existing destination is kept as the previous generation, never clobbered", () => {
  const live = join(workDir, "b2-collide-live.db");
  const out = join(workDir, "b2-collide-out.db");
  copyFileSync(fixtureEnc, live);

  const first = cli(["db", "backup", "--out", out, "--json"], live, encEnv);
  assert.equal(first.status, 0, `first backup failed: ${first.stdout}${first.stderr}`);
  const firstData = backupData(first);

  // A second run onto the same name must rotate, not truncate.
  const second = cli(["db", "backup", "--out", out, "--json"], live, encEnv);
  assert.equal(second.status, 0, `re-run over an existing backup failed: ${second.stdout}${second.stderr}`);
  const secondData = backupData(second);
  assert.equal(secondData.to, out);
  assert.ok(secondData.size > 0);

  assert.equal(existsSync(`${out}.1`), true, "the previous backup must be kept as <out>.1");
  const current = verifyEncryptedBackup(out, oldKey);
  const previous = verifyEncryptedBackup(`${out}.1`, oldKey);
  assert.equal(current.integrityOk, true);
  assert.equal(previous.integrityOk, true);
  assert.equal(previous.size, firstData.size, "the kept generation must be the first backup, intact");
});

test("B2: a plaintext backup rotates the previous generation to <out>.1", () => {
  const live = join(workDir, "b2-plain-live.db");
  const out = join(workDir, "b2-plain-out.db");
  copyFileSync(fixturePlain, live);

  const db = new Database(live);
  try {
    writeBackup(db, live, out);
    assert.equal(existsSync(`${out}.1`), false, "the first backup has no previous generation");
    const firstSize = statSync(out).size;

    writeBackup(db, live, out);
    assert.equal(existsSync(`${out}.1`), true, "the previous backup must be kept as <out>.1");
    assert.equal(statSync(`${out}.1`).size, firstSize, "the kept generation must be the first backup");
    assert.equal(verifyPlaintextCopy(`${out}.1`), "ok", "<out>.1 must stay a standalone database");
    assert.equal(verifyPlaintextCopy(out), "ok", "the new generation must be a standalone database");

    // A stale <out>.1 is replaced, not appended to, and the destination's -wal
    // is moved with the generation so no stale plaintext WAL sits beside the
    // new file.
    writeFileSync(`${out}.1-wal`, "stale generation wal");
    writeFileSync(`${out}-wal`, "destination wal");
    writeBackup(db, live, out);
    assert.equal(existsSync(`${out}-wal`), false, "the destination must not inherit a stale -wal");
    assert.equal(existsSync(`${out}.1-wal`), true, "the -wal must travel with the displaced generation");
    assert.equal(statSync(`${out}.1`).size, firstSize, "the stale <out>.1 content must be replaced");
  } finally {
    db.close();
  }
});

/** integrity_check of a plaintext copy through its own handle. */
function verifyPlaintextCopy(path) {
  const copy = new Database(path, { readonly: true });
  try {
    return copy.pragma("integrity_check", { simple: true });
  } finally {
    copy.close();
  }
}

test("B2: writeBackup is fail-closed without a key and writes nothing", () => {
  const plain = join(workDir, "b2-nokey-plain.db");
  const encrypted = join(workDir, "b2-nokey-enc.db");
  const out = join(workDir, "b2-nokey-out.db");
  copyFileSync(fixturePlain, plain);
  copyFileSync(fixtureEnc, encrypted);
  const before = new Set(readdirSync(workDir));

  // Encryption on, no key provider: the encrypted-source branch must refuse.
  const script = `
const Database = (await import("better-sqlite3-multiple-ciphers")).default;
const { writeBackup } = await import(${JSON.stringify(
    new URL("../dist/db/migrations.js", import.meta.url).href
  )});
const db = new Database(process.env.P);
try {
  writeBackup(db, process.env.ENC, process.env.OUT);
  process.stdout.write("NO-THROW\\n");
} catch (e) {
  process.stdout.write("ERR " + e.message + "\\n");
}
db.close();
`;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: root,
    env: appEnv(plain, { MEMORY_ENCRYPTION: "on", P: plain, ENC: encrypted, OUT: out }),
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(run.status, 0, `fail-closed probe crashed: ${run.stderr}`);
  assert.match(
    run.stdout,
    /cannot verify a backup copy without the database key/,
    `expected the bounded fail-closed error, got: ${run.stdout}${run.stderr}`
  );
  assert.equal(run.stdout.includes("NO-THROW"), false, "writeBackup must not succeed without a key");
  assert.equal(existsSync(out), false, "no backup may be promoted without verification");
  for (const name of readdirSync(workDir)) {
    if (before.has(name)) continue;
    assert.equal(
      name.startsWith(basename(out)) || name.startsWith(`.${basename(out)}`),
      false,
      `a refused backup left an artifact behind: ${name}`
    );
  }
});

test("B3 seeding: sqlite_sequence counters survive the plaintext → encrypted copy", () => {
  const src = join(workDir, "seq-src.db");
  copyFileSync(fixturePlain, src);

  const plain = new Database(src);
  let removedId = 0;
  try {
    const now = new Date().toISOString();
    const ins = plain.prepare(
      "INSERT INTO memories (type, content, status, source, confidence, created_at, updated_at) VALUES ('FACT', ?, 'active', 'explicit', 0.5, ?, ?)"
    );
    for (let i = 0; i < 3; i++) removedId = Number(ins.run(`sequence probe ${i}`, now, now).lastInsertRowid);
    plain.prepare("DELETE FROM memories WHERE id = ?").run(removedId);
  } finally {
    plain.close();
  }

  const sourceCounter = (() => {
    const db = new Database(src, { readonly: true });
    try {
      return db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'memories'").get().seq;
    } finally {
      db.close();
    }
  })();
  const sourceMax = (() => {
    const db = new Database(src, { readonly: true });
    try {
      return db.prepare("SELECT MAX(id) AS m FROM memories").get().m;
    } finally {
      db.close();
    }
  })();
  assert.ok(
    sourceCounter > sourceMax,
    `the fixture must prove the counter matters (seq=${sourceCounter}, max=${sourceMax})`
  );

  const enc = join(workDir, "seq-enc.db");
  copyFileSync(src, enc);
  assert.equal(migrateIfNeeded(enc, oldKey), true);
  const migrated = openEncryptedDB(enc, oldKey);
  try {
    const row = migrated.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'memories'").get();
    assert.equal(
      row?.seq,
      sourceCounter,
      "the AUTOINCREMENT counter must not roll back to max(id)"
    );
  } finally {
    migrated.close();
  }
});

// ------------------------------------- B3: staging is invisible to the tools ---
test("B3 staging: drill ignores staging artifacts and reports 'no backup'", () => {
  const live = join(workDir, "b3-nobackup-live.db");
  copyFileSync(fixtureEnc, live);

  // Both the current staging name and the legacy one, for the same target stem.
  writeFileSync(join(workDir, `.${basename(live)}.backup-200001010000.staging-1-0`), "partial");
  writeFileSync(`${live}.backup-200001010001.staging-1-1`, "partial");
  writeFileSync(`${live}.backup-200001010002.tmp-1-2`, "partial");
  writeFileSync(`${live}.backup-200001010003.staging-1-3-wal`, "partial");

  const drill = cli(["db", "drill"], live, encEnv);
  const text = `${drill.stdout}${drill.stderr}`;
  assert.notEqual(drill.status, 0, `a staging file must not satisfy a drill: ${text}`);
  assert.match(text, /no backup found/i);
  assert.doesNotMatch(text, /corrupt|failed verification/i, `staging was treated as a backup: ${text}`);
});

test("B3 staging: a killed encrypted backup never becomes the newest backup", async () => {
  const live = join(workDir, "b3-kill-live.db");
  copyFileSync(fixtureEnc, live);
  {
    // Make the VACUUM slow enough to be killed mid-write.
    const db = openEncryptedDB(live, oldKey);
    try {
      db.exec("CREATE TABLE IF NOT EXISTS bulk (id INTEGER PRIMARY KEY, payload BLOB)");
      db.exec(
        "WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i < 4000)" +
          " INSERT INTO bulk (payload) SELECT zeroblob(4096) FROM seq"
      );
      db.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
  }

  // A real backup from an earlier run, in the <db>.backup-* namespace.
  const real = `${live}.backup-1000000000000`;
  copyFileSync(fixtureEnc, real);
  const target = `${live}.backup-${Date.now()}`;

  const child = spawn(process.execPath, [CLI, "db", "backup", "--out", target], {
    cwd: root,
    env: appEnv(live, encEnv),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let childOut = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c) => {
    childOut += c;
  });
  child.stderr.on("data", (c) => {
    childOut += c;
  });
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }, 300);
  await new Promise((resolve) => child.on("exit", resolve));
  clearTimeout(timer);
  children.delete(child);
  const completed = childOut.includes("backup: ok");

  for (const name of readdirSync(workDir)) {
    if (name.includes(".staging-") || name.includes(".tmp-")) {
      assert.ok(
        /\.(staging|tmp)-\d+-\d+(-journal|-wal|-shm)?$/.test(name),
        `unexpected stray: ${name}`
      );
    }
  }

  const drill = cli(["db", "drill"], live, encEnv);
  const text = `${drill.stdout}${drill.stderr}`;
  assert.equal(drill.status, 0, `the drill must use a real backup (completed=${completed}): ${text}`);
  assert.doesNotMatch(text, /corrupt|failed verification/i);

  if (!completed) {
    assert.equal(existsSync(target), false, "a killed backup must not appear at its target");
    assert.match(
      drill.stdout,
      new RegExp(basename(real).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `the drill must pick the real backup, not a staging file: ${text}`
    );
  }
});

