// Ph-6 B2 — crash safety for the plaintext→encrypted migration and for an
// encrypted backup.
//
// A real-shape plaintext DB is built through the app path in a child process
// (createMemory + rememberHandler + saveLessonHandler + a bulk embeddings
// table so the copy takes long enough to interrupt). Then:
//
//   * migrateIfNeeded() is SIGKILLed at several fixed delays and at
//     progress-driven moments (.enc.tmp appears, .enc.bak appears),
//   * recoverEncryptionState() + a fresh app start (MEMORY_ENCRYPTION=on in a
//     child) must repair the state with zero data loss,
//   * backupEncryptedDB() is SIGKILLed mid-write; the source must be untouched,
//     `out` must be either absent or a complete backup (never a partial file),
//     and a retry after the kill must produce a good backup.
//
// Every assertion is a post-condition, not a timing assumption: a trial whose
// child finished before the kill takes the "completed" branch.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import Database from "better-sqlite3-multiple-ciphers";

const {
  openEncryptedDB,
  isEncrypted,
  isPlaintextDB,
  recoverEncryptionState,
  migrateIfNeeded,
  backupEncryptedDB,
} = await import("../dist/db/encryption.js");

const workDir = mkdtempSync(join(tmpdir(), "th-encryption-crash-"));
const key = new Uint8Array(32).fill(9);
const keyBase64 = Buffer.from(key).toString("base64");
const children = new Set();

after(() => {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const COUNTED = ["memories", "preferences", "lessons", "search_index"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sha256(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function appEnv(dbPath, extra = {}) {
  const env = { ...process.env, ...extra, MEMORY_DB_PATH: dbPath };
  for (const name of Object.keys(env)) {
    if (name.startsWith("MEMORY_") && name !== "MEMORY_DB_PATH") delete env[name];
  }
  return { ...env, ...extra, MEMORY_DB_PATH: dbPath };
}

/** Remove stale sidecars and return the DB to a single-file state. */
function normalize(dbPath) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const target = dbPath + suffix;
    if (!existsSync(target)) continue;
    if (statSync(target).size === 0) {
      try {
        unlinkSync(target);
      } catch {
        /* ignore */
      }
    }
  }
}

function copyFixture(source, dest) {
  normalize(source);
  copyFileSync(source, dest);
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    try {
      if (existsSync(dest + suffix)) unlinkSync(dest + suffix);
    } catch {
      /* ignore */
    }
  }
  return dest;
}

/** Row counts + integrity of the surviving copy, opening it the right way. */
function inspect(dbPath) {
  assert.ok(existsSync(dbPath), `database file missing: ${dbPath}`);
  const encrypted = isEncrypted(dbPath, key);
  const plaintext = encrypted ? false : isPlaintextDB(dbPath);
  assert.notEqual(encrypted, plaintext, "the DB must be either encrypted or plaintext, never both");
  assert.ok(encrypted || plaintext, "the surviving copy must be a readable database");

  const db = encrypted ? openEncryptedDB(dbPath, key) : new Database(dbPath);
  try {
    const counts = {};
    for (const table of COUNTED) {
      counts[table] = db.prepare(`SELECT count(*) AS c FROM ${table}`).get().c;
    }
    return {
      encrypted,
      plaintext,
      counts,
      integrity: db.pragma("integrity_check", { simple: true }),
      marker: db
        .prepare("SELECT value FROM schema_meta WHERE key = 'encryption_migrated'")
        .get(),
    };
  } finally {
    db.close();
  }
}

function assertNoDataLoss(dbPath, baseline, label) {
  const state = inspect(dbPath);
  assert.equal(state.integrity, "ok", `${label}: integrity_check failed`);
  for (const table of COUNTED) {
    assert.equal(state.counts[table], baseline[table], `${label}: row count changed for ${table}`);
  }
  return state;
}

// --- fixture: real-shape plaintext DB, built by the app in a child process ---
const fixturePlain = join(workDir, "fixture-plain.db");
const fixtureCounts = {};

{
  const builder = join(workDir, "build-fixture.mjs");
  const urls = {
    app: new URL("../dist/db/index.js", import.meta.url).href,
    memories: new URL("../dist/db/repositories/memories.js", import.meta.url).href,
    remember: new URL("../dist/tools/remember.js", import.meta.url).href,
    lesson: new URL("../dist/tools/lesson.js", import.meta.url).href,
  };
  writeFileSync(
    builder,
    [
      `const app = await import(${JSON.stringify(urls.app)});`,
      `const { createMemory } = await import(${JSON.stringify(urls.memories)});`,
      `const { rememberHandler } = await import(${JSON.stringify(urls.remember)});`,
      `const { saveLessonHandler } = await import(${JSON.stringify(urls.lesson)});`,
      "for (let i = 0; i < 40; i++) {",
      "  createMemory({",
      "    type: i % 3 === 0 ? 'DECISION' : 'FACT',",
      "    content: `crash fixture memory ${i} sqlcipher fts5 shadow table copy`,",
      "  });",
      "}",
      "for (let i = 0; i < 4; i++) {",
      "  await rememberHandler({ category: 'coding_pref', key: `pref_${i}`, value: `pnpm_${i}` });",
      "}",
      "for (let i = 0; i < 3; i++) {",
      "  await saveLessonHandler({",
      "    situation: `crash situation ${i}`,",
      "    mistake: `crash mistake ${i}`,",
      "    correction: `crash correction ${i}`,",
      "  });",
      "}",
      "const db = app.getDb();",
      // ~12 MB of pages so the copy / vacuum has a measurable window on any host.
      "db.exec('WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < 3000)' +",
      "  \" INSERT INTO embeddings (ref_table, ref_id, vec) SELECT 'bulk', i, zeroblob(4096) FROM seq\");",
      "db.pragma('wal_checkpoint(TRUNCATE)');",
      "const counts = {};",
      "for (const t of ['memories', 'preferences', 'lessons', 'search_index']) {",
      "  counts[t] = db.prepare(`SELECT count(*) AS c FROM ${t}`).get().c;",
      "}",
      "process.stdout.write('COUNTS ' + JSON.stringify(counts) + '\\n');",
    ].join("\n")
  );

  const run = spawnSync(process.execPath, [builder], {
    env: appEnv(fixturePlain, { MEMORY_BACKUP_ON_MIGRATE: "0" }),
    encoding: "utf8",
    timeout: 180000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(run.status, 0, `fixture builder failed: ${run.stderr}`);
  const match = /COUNTS (\{.*\})/.exec(run.stdout ?? "");
  assert.ok(match, `fixture builder produced no counts: ${run.stdout}`);
  Object.assign(fixtureCounts, JSON.parse(match[1]));
  normalize(fixturePlain);
}

test("B2 fixture: real-shape plaintext DB is larger than one page", () => {
  assert.equal(isPlaintextDB(fixturePlain), true);
  assert.ok(statSync(fixturePlain).size > 8 * 1024 * 1024, "fixture too small to interrupt");
  const state = assertNoDataLoss(fixturePlain, fixtureCounts, "fixture");
  assert.equal(state.encrypted, false);
  assert.ok(fixtureCounts.memories >= 40);
  assert.ok(fixtureCounts.preferences >= 4);
  assert.ok(fixtureCounts.lessons >= 3);
  assert.ok(fixtureCounts.search_index >= 40);
});

const MIGRATE_WORKER = `
const { migrateIfNeeded } = await import(${JSON.stringify(
  new URL("../dist/db/encryption.js", import.meta.url).href
)});
const key = new Uint8Array(Buffer.from(process.env.CRASH_KEY, "base64"));
const ran = migrateIfNeeded(process.env.CRASH_DB, key);
process.stdout.write("MIGRATED " + ran + "\\n");
`;

const APP_OPEN_WORKER = `
const app = await import(${JSON.stringify(new URL("../dist/db/index.js", import.meta.url).href)});
const db = app.getDb();
const counts = {};
for (const t of ${JSON.stringify(COUNTED)}) {
  counts[t] = db.prepare(\`SELECT count(*) AS c FROM \${t}\`).get().c;
}
const integrity = db.pragma("integrity_check", { simple: true });
process.stdout.write("COUNTS " + JSON.stringify({ counts, integrity }) + "\\n");
`;

async function waitFor(predicate, timeoutMs, stepMs = 5) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}

/**
 * Spawn a worker and SIGKILL it either after `delayMs`, once `waitForFile`
 * exists, or once `waitForFn()` is true (plus `extraMs`). The exit promise is
 * created before the kill so a child that already finished resolves instead of
 * hanging.
 */
async function runAndKill(script, env, { delayMs = 0, waitForFile = null, waitForFn = null, extraMs = 0 } = {}) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal }))
  );

  let observed = "none";
  if (delayMs > 0) {
    await sleep(delayMs);
    observed = `delay ${delayMs}ms`;
  } else if (waitForFile !== null) {
    const seen = await waitFor(() => existsSync(waitForFile), 20000);
    observed = seen ? "file appeared" : "file never appeared";
    if (seen && extraMs > 0) await sleep(extraMs);
  } else if (waitForFn !== null) {
    const seen = await waitFor(waitForFn, 20000);
    observed = seen ? "condition met" : "condition never met";
    if (seen && extraMs > 0) await sleep(extraMs);
  }

  let killed = false;
  if (child.exitCode === null && child.signalCode === null) killed = child.kill("SIGKILL");
  let result = await Promise.race([exited, sleep(20000).then(() => ({ code: null, signal: "hung" }))]);
  if (result.signal === "hung") {
    child.kill("SIGKILL");
    result = await exited;
  }
  children.delete(child);
  return { ...result, killed, stdout, stderr, observed };
}

const migrationTrials = [
  { name: "delay 20ms", options: { delayMs: 20 } },
  { name: "delay 40ms", options: { delayMs: 40 } },
  { name: "delay 80ms", options: { delayMs: 80 } },
  { name: "delay 150ms", options: { delayMs: 150 } },
  { name: "kill when .enc.tmp appears", options: { waitForFile: "tmp" } },
  { name: ".enc.tmp + 300ms", options: { waitForFile: "tmp", extraMs: 300 } },
  { name: "kill when .enc.bak appears", options: { waitForFile: "bak" } },
  { name: "no kill (migration completes)", options: {} },
];

for (const trial of migrationTrials) {
  test(`B2 interrupted migration — ${trial.name}`, { timeout: 120000 }, async () => {
    const dbPath = join(workDir, `crash-${trial.name.replace(/[^a-z0-9]+/gi, "-")}.db`);
    copyFixture(fixturePlain, dbPath);

    const options = { ...trial.options };
    if (options.waitForFile === "tmp") options.waitForFile = `${dbPath}.enc.tmp`;
    if (options.waitForFile === "bak") options.waitForFile = `${dbPath}.enc.bak`;

    const result = await runAndKill(
      MIGRATE_WORKER,
      appEnv(dbPath, { MEMORY_BACKUP_ON_MIGRATE: "0", CRASH_DB: dbPath, CRASH_KEY: keyBase64 }),
      options
    );

    const completed = result.code === 0 && /MIGRATED (true|false)/.test(result.stdout);
    if (!completed) {
      assert.ok(result.killed, `child was neither killed nor successful: ${JSON.stringify(result)}`);
    }

    const leftTmp = existsSync(`${dbPath}.enc.tmp`);
    const leftBak = existsSync(`${dbPath}.enc.bak`);

    // Recovery is exactly what the app does on startup.
    const recovered = recoverEncryptionState(dbPath, key);
    assert.ok(!recovered.some((line) => /discarded unreadable/.test(line)), `unexpected recovery: ${recovered}`);

    // Surviving copy is either the encrypted DB (with our key) or the original
    // plaintext DB; never both, never neither.
    const beforeApp = inspect(dbPath);
    assert.equal(beforeApp.integrity, "ok");
    for (const table of COUNTED) {
      assert.equal(beforeApp.counts[table], fixtureCounts[table], `data lost in ${table}`);
    }
    assert.equal(existsSync(`${dbPath}.enc.tmp`), false, ".enc.tmp survived recovery");

    if (beforeApp.encrypted) {
      assert.equal(migrateIfNeeded(dbPath, key), false, "encrypted DB must not re-migrate");
    } else {
      // Plaintext survived (crash before the renames): the app start migrates.
      const app = spawnSync(process.execPath, ["--input-type=module", "-e", APP_OPEN_WORKER], {
        env: appEnv(dbPath, {
          MEMORY_ENCRYPTION: "on",
          MEMORY_ENCRYPTION_KEY: keyBase64,
          MEMORY_BACKUP_ON_MIGRATE: "0",
        }),
        encoding: "utf8",
        timeout: 120000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      assert.equal(app.status, 0, `app start failed after recovery: ${app.stderr}`);
      const screen = /COUNTS (\{.*\})/.exec(app.stdout ?? "");
      assert.ok(screen, `app start produced no counts: ${app.stdout}|${app.stderr}`);
      const payload = JSON.parse(screen[1]);
      assert.equal(payload.integrity, "ok");
      for (const table of COUNTED) {
        assert.equal(payload.counts[table], fixtureCounts[table], `app start lost rows in ${table}`);
      }
    }

    // Post-conditions on the final, promoted copy.
    const finalState = assertNoDataLoss(dbPath, fixtureCounts, trial.name);
    assert.equal(finalState.encrypted, true, "after recovery + app start the DB must be encrypted");
    assert.equal(finalState.marker?.value, "1");
    assert.equal(existsSync(`${dbPath}.enc.tmp`), false, ".enc.tmp left behind");
    if (existsSync(`${dbPath}.enc.bak`)) {
      assert.equal(
        isEncrypted(`${dbPath}.enc.bak`, key) || isPlaintextDB(`${dbPath}.enc.bak`),
        true,
        ".enc.bak is not a readable database"
      );
    }
    if (!completed) {
      // The interrupted child must not have left a half-written DB in place.
      assert.ok(leftTmp || leftBak || result.killed, "kill did not land during the migration");
    }
  });
}

// --- interrupted backup -----------------------------------------------------
const fixtureEncrypted = join(workDir, "fixture-encrypted.db");

test("B2 fixture: encrypted copy for the backup trials", { timeout: 120000 }, () => {
  copyFixture(fixturePlain, fixtureEncrypted);
  const ran = migrateIfNeeded(fixtureEncrypted, key);
  assert.equal(ran, true);
  const state = assertNoDataLoss(fixtureEncrypted, fixtureCounts, "encrypted fixture");
  assert.equal(state.encrypted, true);
  assert.equal(state.marker?.value, "1");
});

const BACKUP_WORKER = `
const { openEncryptedDB, backupEncryptedDB } = await import(${JSON.stringify(
  new URL("../dist/db/encryption.js", import.meta.url).href
)});
const key = new Uint8Array(Buffer.from(process.env.CRASH_KEY, "base64"));
const db = openEncryptedDB(process.env.CRASH_DB, key);
process.stdout.write("OPENED\\n");
backupEncryptedDB(db, process.env.CRASH_OUT);
process.stdout.write("DONE\\n");
`;

function tryOpenBackup(outPath) {
  const copy = `${outPath}.probe-copy`;
  try {
    copyFileSync(outPath, copy);
    const db = openEncryptedDB(copy, key);
    try {
      const counts = {};
      for (const table of COUNTED) {
        counts[table] = db.prepare(`SELECT count(*) AS c FROM ${table}`).get().c;
      }
      return { opens: true, counts, integrity: db.pragma("integrity_check", { simple: true }) };
    } finally {
      db.close();
    }
  } catch (e) {
    return { opens: false, message: e instanceof Error ? e.message : String(e) };
  } finally {
    try {
      if (existsSync(copy)) unlinkSync(copy);
    } catch {
      /* ignore */
    }
  }
}

/** Sibling temp copies backupEncryptedDB writes before promoting them. */
function backupTemps(out) {
  const prefix = `${basename(out)}.tmp-`;
  return readdirSync(workDir).filter((name) => name.startsWith(prefix));
}

const backupTrials = [
  { name: "kill when the temp appears", options: { waitForTemps: true } },
  { name: "temp + 120ms", options: { waitForTemps: true, extraMs: 120 } },
  { name: "temp + 350ms", options: { waitForTemps: true, extraMs: 350 } },
  { name: "kill when out appears", options: { waitForOut: true } },
  { name: "no kill (backup completes)", options: {} },
];

for (const trial of backupTrials) {
  test(`B2 interrupted backup — ${trial.name}`, { timeout: 120000 }, async () => {
    const sourceDb = join(workDir, `backup-src-${trial.name.replace(/[^a-z0-9]+/gi, "-")}.db`);
    const out = join(workDir, `backup-out-${trial.name.replace(/[^a-z0-9]+/gi, "-")}.db`);
    copyFixture(fixtureEncrypted, sourceDb);
    const sourceHashBefore = sha256(sourceDb);

    const options = { ...trial.options };
    if (options.waitForTemps) {
      delete options.waitForTemps;
      options.waitForFn = () => backupTemps(out).length > 0;
    }
    if (options.waitForOut) {
      delete options.waitForOut;
      options.waitForFn = () => existsSync(out);
    }

    const result = await runAndKill(
      BACKUP_WORKER,
      appEnv(sourceDb, { CRASH_DB: sourceDb, CRASH_KEY: keyBase64, CRASH_OUT: out }),
      options
    );

    const completed = result.code === 0 && result.stdout.includes("DONE");
    if (!completed) assert.ok(result.killed, `backup child neither finished nor was killed: ${JSON.stringify(result)}`);

    // The source is never harmed by an interrupted backup.
    const source = assertNoDataLoss(sourceDb, fixtureCounts, `${trial.name} source`);
    assert.equal(source.encrypted, true);
    assert.equal(sha256(sourceDb), sourceHashBefore, "source DB bytes changed during VACUUM INTO");

    // A migration artifact must never appear because of a backup.
    assert.equal(existsSync(`${sourceDb}.enc.tmp`), false, "backup created a .enc.tmp");
    assert.equal(existsSync(`${sourceDb}.enc.bak`), false, "backup created a .enc.bak");

    // Atomic promotion: `out` is absent or a complete snapshot. A partial file
    // at `out` — the old in-place VACUUM INTO behaviour — fails here.
    if (existsSync(out)) {
      const backup = tryOpenBackup(out);
      assert.equal(backup.opens, true, `out exists but does not open with the key: ${JSON.stringify(backup)}`);
      assert.equal(backup.integrity, "ok", "out exists but is not integrity-clean");
      for (const table of COUNTED) {
        assert.equal(backup.counts[table], fixtureCounts[table], `out is a partial backup (${table})`);
      }
    }
    if (completed) {
      assert.equal(existsSync(out), true, "a completed backup must produce its output file");
      assert.deepEqual(backupTemps(out), [], "a completed backup left a temp copy behind");
      return;
    }

    // A leftover `<out>.tmp-*` is allowed only because it can never be mistaken
    // for a backup: nothing promotes a temp but a verified rename, `out` itself
    // is clean (asserted above), and the leftover is a distinct path.
    const leftovers = backupTemps(out);
    for (const name of leftovers) {
      const stale = join(workDir, name);
      assert.notEqual(stale, out, "a temp copy took the backup path");
      assert.match(name, /\.tmp-\d+-\d+(-wal|-shm|-journal)?$/, `unexpected temp name: ${name}`);
      assert.ok(existsSync(stale), `stale temp vanished: ${stale}`);
      unlinkSync(stale);
    }

    // A retry after a kill must succeed and produce a snapshot of the source.
    const retry = spawnSync(process.execPath, ["--input-type=module", "-e", BACKUP_WORKER], {
      env: appEnv(sourceDb, { CRASH_DB: sourceDb, CRASH_KEY: keyBase64, CRASH_OUT: out }),
      encoding: "utf8",
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(retry.status, 0, `retry after a kill failed: ${(retry.stderr ?? "") + (retry.stdout ?? "")}`);
    assert.match(retry.stdout ?? "", /DONE/, `retry produced no DONE: ${retry.stdout}${retry.stderr}`);
    const retried = tryOpenBackup(out);
    assert.equal(retried.opens, true, `retry left an unopenable backup: ${JSON.stringify(retried)}`);
    assert.equal(retried.integrity, "ok", "retry left a backup that fails integrity_check");
    for (const table of COUNTED) {
      assert.equal(retried.counts[table], fixtureCounts[table], `retry backup row count mismatch for ${table}`);
    }
    assertNoDataLoss(sourceDb, fixtureCounts, `${trial.name} source after retry`);
    assert.equal(sha256(sourceDb), sourceHashBefore, "source DB bytes changed during the retry");
  });
}

test("B2 backup: a completed backup verifies against the source", { timeout: 120000 }, () => {
  const sourceDb = join(workDir, "backup-verify-src.db");
  const out = join(workDir, "backup-verify-out.db");
  copyFixture(fixtureEncrypted, sourceDb);
  const db = openEncryptedDB(sourceDb, key);
  try {
    backupEncryptedDB(db, out);
  } finally {
    db.close();
  }
  const backup = tryOpenBackup(out);
  assert.equal(backup.opens, true);
  assert.equal(backup.integrity, "ok");
  for (const table of COUNTED) {
    assert.equal(backup.counts[table], fixtureCounts[table], `backup row count mismatch for ${table}`);
  }
  assert.equal(isEncrypted(out, key), true);
  assert.equal(isPlaintextDB(out), false);
  assertNoDataLoss(sourceDb, fixtureCounts, "backup verify source");

  // Replacing an existing destination goes through the same verify-then-rename
  // path: even a garbage file at `out` is replaced by a good backup, and the
  // destination is never the vacuum target.
  writeFileSync(out, "not a database");
  const again = openEncryptedDB(sourceDb, key);
  try {
    backupEncryptedDB(again, out);
  } finally {
    again.close();
  }
  const replaced = tryOpenBackup(out);
  assert.equal(replaced.opens, true, `replaced backup does not open: ${JSON.stringify(replaced)}`);
  assert.equal(replaced.integrity, "ok");
  for (const table of COUNTED) {
    assert.equal(replaced.counts[table], fixtureCounts[table], `replaced backup row count mismatch for ${table}`);
  }
  assert.deepEqual(backupTemps(out), [], "a completed backup left a temp copy behind");
});
