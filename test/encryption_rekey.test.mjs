// Ph-6 S4a / C1 — key rotation (rekeyDatabase + `th-memory db rekey`).
//
// The fixture is a real-shape encrypted DB (memories/preferences/lessons,
// search_index + search_index_loose FTS5, embeddings) built by the app itself
// in a child process. Every rekey assertion is a post-condition on the file:
// the old key must be dead, the new key must read the same rows, FTS MATCH and
// embedding bytes must be identical, and `.enc.bak`/`.rekey.tmp` must be gone.
//
// Crash safety: a child is SIGKILLed at three delays and at two progress-driven
// moments (.rekey.tmp appears, .enc.bak appears). Afterwards the live DB must
// open with the OLD key or the NEW key — never neither — with the original rows.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  copyFileSync,
  writeFileSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const {
  openEncryptedDB,
  isEncrypted,
  isPlaintextDB,
  migrateIfNeeded,
  recoverEncryptionState,
  rekeyDatabase,
  WRONG_KEY_ERROR,
} = await import("../dist/db/encryption.js");

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const APP_URL = new URL("../dist/db/index.js", import.meta.url).href;
const ENCRYPTION_URL = new URL("../dist/db/encryption.js", import.meta.url).href;

const workDir = mkdtempSync(join(tmpdir(), "th-encryption-rekey-"));
const oldKey = new Uint8Array(32).fill(41);
const newKey = new Uint8Array(32).fill(42);
const oldB64 = Buffer.from(oldKey).toString("base64");
const newB64 = Buffer.from(newKey).toString("base64");
const oldHex = Array.from(oldKey)
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");
const newHex = Array.from(newKey)
  .map((b) => b.toString(16).padStart(2, "0"))
  .join("");
const children = new Set();

const COUNTED = ["memories", "preferences", "lessons", "search_index", "search_index_loose", "embeddings"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function appEnv(dbPath, extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith("MEMORY_")) delete env[name];
  }
  return { ...env, MEMORY_DB_PATH: dbPath, ...extra };
}

function assertNoKeyMaterial(text) {
  for (const needle of [oldB64, newB64, oldHex, newHex]) {
    assert.equal(text.includes(needle), false, "key material leaked into CLI output");
  }
}

/** Remove stale sidecars so a fixture copy is a single self-contained file. */
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

/** Row counts, FTS MATCH parity and a structural digest of every embedding. */
function snapshot(path, key) {
  const db = openEncryptedDB(path, key);
  try {
    const counts = {};
    for (const table of COUNTED) {
      counts[table] = db.prepare(`SELECT count(*) AS c FROM ${table}`).get().c;
    }
    const matchIndex = db.prepare("SELECT count(*) AS c FROM search_index WHERE search_index MATCH ?").get("sqlcipher").c;
    const matchLoose = db
      .prepare("SELECT count(*) AS c FROM search_index_loose WHERE search_index_loose MATCH ?")
      .get("sqlcipher").c;
    const embeddings = db
      .prepare(
        "SELECT ref_table, ref_id, length(vec) AS len, substr(vec, 1, 24) AS head FROM embeddings ORDER BY ref_table, ref_id"
      )
      .all();
    return {
      counts,
      matchIndex,
      matchLoose,
      embDigest: createHash("sha256").update(JSON.stringify(embeddings)).digest("hex"),
      integrity: db.pragma("integrity_check", { simple: true }),
    };
  } finally {
    db.close();
  }
}

function inspectAnyKey(path, keys) {
  for (const [label, key] of Object.entries(keys)) {
    if (isEncrypted(path, key)) return { label, key };
  }
  return null;
}

// --- fixture: real-shape plaintext DB, built by the app in a child process ---
const fixturePlain = join(workDir, "fixture-plain.db");
const fixtureEncrypted = join(workDir, "fixture-encrypted.db");
const fixtureCounts = {};

{
  const builder = join(workDir, "build-fixture.mjs");
  const urls = {
    app: APP_URL,
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
      "    content: `rekey fixture memory ${i} sqlcipher fts5 shadow table copy`,",
      "  });",
      "}",
      "for (let i = 0; i < 4; i++) {",
      "  await rememberHandler({ category: 'coding_pref', key: `pref_${i}`, value: `pnpm_${i}` });",
      "}",
      "for (let i = 0; i < 3; i++) {",
      "  await saveLessonHandler({",
      "    situation: `rekey situation ${i}`,",
      "    mistake: `rekey mistake ${i}`,",
      "    correction: `rekey correction ${i}`,",
      "  });",
      "}",
      "const db = app.getDb();",
      // ~12 MB of pages so the snapshot / rekey has a measurable kill window.
      "db.exec('WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM seq WHERE i < 3000)' +",
      "  \" INSERT INTO embeddings (ref_table, ref_id, vec) SELECT 'bulk', i, zeroblob(4096) FROM seq\");",
      "db.pragma('wal_checkpoint(TRUNCATE)');",
      `const counted = ${JSON.stringify(COUNTED)};`,
      "const counts = {};",
      "for (const t of counted) counts[t] = db.prepare(`SELECT count(*) AS c FROM ${t}`).get().c;",
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
  assert.ok(match, `fixture builder produced no counts: ${run.stdout}${run.stderr}`);
  Object.assign(fixtureCounts, JSON.parse(match[1]));
  normalize(fixturePlain);
}

const fixtureFts = { index: 0, loose: 0 };

{
  copyFixture(fixturePlain, fixtureEncrypted);
  assert.equal(migrateIfNeeded(fixtureEncrypted, oldKey), true, "fixture migration did not run");
  const state = snapshot(fixtureEncrypted, oldKey);
  assert.equal(state.integrity, "ok");
  for (const table of COUNTED) assert.equal(state.counts[table], fixtureCounts[table], `fixture lost ${table}`);
  assert.ok(fixtureCounts.memories >= 40);
  assert.ok(fixtureCounts.search_index >= 40);
  assert.ok(fixtureCounts.search_index_loose >= 40);
  assert.ok(fixtureCounts.embeddings >= 3000);
  assert.ok(state.matchIndex > 0, "fixture has no FTS MATCH hits to compare");
  fixtureFts.index = state.matchIndex;
  fixtureFts.loose = state.matchLoose;
}

// --- C1: the rotation itself ------------------------------------------------
test("C1 fixture: real-shape encrypted DB (FTS5 + embeddings) opens with the old key", () => {
  assert.equal(existsSync(fixtureEncrypted), true);
  assert.equal(isPlaintextDB(fixtureEncrypted), false);
  assert.equal(isEncrypted(fixtureEncrypted, oldKey), true);
  assert.equal(isEncrypted(fixtureEncrypted, newKey), false);
  assert.ok(statSync(fixtureEncrypted).size > 8 * 1024 * 1024, "fixture too small to interrupt");
});

test("C1 rekey: old key dies, new key reads the same rows, FTS and embeddings unchanged", () => {
  const dbPath = join(workDir, "rekey-happy.db");
  copyFixture(fixtureEncrypted, dbPath);
  const before = snapshot(dbPath, oldKey);
  const bytesBefore = sha256(dbPath);

  assert.deepEqual(rekeyDatabase(dbPath, oldKey, newKey), { rotated: true });

  assert.notEqual(sha256(dbPath), bytesBefore, "rekey did not rewrite the file");
  assert.throws(() => openEncryptedDB(dbPath, oldKey), (e) => e.message === WRONG_KEY_ERROR);
  assert.equal(isEncrypted(dbPath, oldKey), false, "the old key still opens the database");
  assert.equal(isEncrypted(dbPath, newKey), true, "the new key does not open the database");

  const after = snapshot(dbPath, newKey);
  assert.equal(after.integrity, "ok");
  assert.deepEqual(after.counts, before.counts, "row counts changed during rekey");
  assert.equal(after.matchIndex, before.matchIndex, "FTS MATCH parity changed (search_index)");
  assert.equal(after.matchLoose, before.matchLoose, "FTS MATCH parity changed (search_index_loose)");
  assert.equal(after.embDigest, before.embDigest, "embedding bytes changed during rekey");

  assert.equal(existsSync(`${dbPath}.enc.bak`), false, "`.enc.bak` left behind");
  assert.equal(existsSync(`${dbPath}.rekey.tmp`), false, "`.rekey.tmp` left behind");
  assert.deepEqual(recoverEncryptionState(dbPath, newKey), [], "recovery found work to do after a clean rekey");
});

test("C1 rekey: refuses the same key and leaves the file byte-identical", () => {
  const dbPath = join(workDir, "rekey-same.db");
  copyFixture(fixtureEncrypted, dbPath);
  const bytesBefore = sha256(dbPath);
  assert.throws(
    () => rekeyDatabase(dbPath, oldKey, new Uint8Array(oldKey)),
    /identical to the current key/
  );
  assert.equal(sha256(dbPath), bytesBefore, "refusal rewrote the database");
  assert.equal(isEncrypted(dbPath, oldKey), true);
});

test("C1 rekey: refuses a wrong old key with the bounded wrong-key message", () => {
  const dbPath = join(workDir, "rekey-wrong-old.db");
  copyFixture(fixtureEncrypted, dbPath);
  const bytesBefore = sha256(dbPath);
  const wrong = new Uint8Array(32).fill(43);
  assert.throws(() => rekeyDatabase(dbPath, wrong, newKey), (e) => e.message === WRONG_KEY_ERROR);
  assert.equal(sha256(dbPath), bytesBefore, "refusal rewrote the database");
  assert.equal(existsSync(`${dbPath}.rekey.tmp`), false);
  assert.equal(isEncrypted(dbPath, oldKey), true);
});

test("C1 rekey: refuses a plaintext database", () => {
  const dbPath = join(workDir, "rekey-plaintext.db");
  copyFixture(fixturePlain, dbPath);
  const bytesBefore = sha256(dbPath);
  assert.equal(isPlaintextDB(dbPath), true);
  assert.throws(() => rekeyDatabase(dbPath, oldKey, newKey), /plaintext/);
  assert.equal(sha256(dbPath), bytesBefore, "refusal rewrote a plaintext database");
});

// --- C1: crash safety -------------------------------------------------------
const REKEY_WORKER = `
const { rekeyDatabase } = await import(${JSON.stringify(ENCRYPTION_URL)});
const key = (b64) => new Uint8Array(Buffer.from(b64, "base64"));
rekeyDatabase(process.env.CRASH_DB, key(process.env.CRASH_KEY), key(process.env.CRASH_NEW_KEY));
process.stdout.write("REKEYED true\\n");
`;

async function waitFor(predicate, timeoutMs, stepMs = 5) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}

/** Spawn the rekey worker and SIGKILL it at the requested moment. */
async function runAndKill(script, env, { delayMs = 0, waitForFile = null, extraMs = 0 } = {}) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));

  if (delayMs > 0) {
    await sleep(delayMs);
  } else if (waitForFile !== null) {
    const seen = await waitFor(() => existsSync(waitForFile), 20000);
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
  return { ...result, killed, stdout, stderr };
}

const rekeyTrials = [
  { name: "delay 30ms", options: { delayMs: 30 } },
  { name: "delay 90ms", options: { delayMs: 90 } },
  { name: "delay 200ms", options: { delayMs: 200 } },
  { name: "kill when .rekey.tmp appears +120ms", options: { waitForFile: "tmp", extraMs: 120 } },
  { name: "kill when .enc.bak appears", options: { waitForFile: "bak" } },
  { name: "no kill (rekey completes)", options: {} },
];

for (const trial of rekeyTrials) {
  test(`C1 interrupted rekey — ${trial.name}`, { timeout: 180000 }, async () => {
    const dbPath = join(workDir, `rekey-${trial.name.replace(/[^a-z0-9]+/gi, "-")}.db`);
    copyFixture(fixtureEncrypted, dbPath);
    const bytesBefore = sha256(dbPath);

    const options = { ...trial.options };
    if (options.waitForFile === "tmp") options.waitForFile = `${dbPath}.rekey.tmp`;
    if (options.waitForFile === "bak") options.waitForFile = `${dbPath}.enc.bak`;

    const result = await runAndKill(
      REKEY_WORKER,
      appEnv(dbPath, { CRASH_DB: dbPath, CRASH_KEY: oldB64, CRASH_NEW_KEY: newB64 }),
      options
    );
    const completed = result.code === 0 && /REKEYED/.test(result.stdout ?? "");
    if (!completed) {
      assert.ok(result.killed, `child was neither killed nor successful: ${JSON.stringify(result)}`);
    }

    // Promote window: `db` is renamed to `.enc.bak` before the new file lands.
    if (!existsSync(dbPath)) {
      assert.equal(existsSync(`${dbPath}.enc.bak`), true, "no database and no `.enc.bak`");
      assert.equal(isEncrypted(`${dbPath}.enc.bak`, oldKey), true, "`.enc.bak` does not open with the old key");
      recoverEncryptionState(dbPath, oldKey);
    }
    assert.ok(existsSync(dbPath), "the database file disappeared");

    // Never neither: the surviving file opens with the old key or the new one.
    const survivor = inspectAnyKey(dbPath, { old: oldKey, new: newKey });
    assert.notEqual(survivor, null, "the live DB opens with neither the old nor the new key");
    if (completed) {
      assert.equal(survivor.label, "new", "a completed rekey must leave the new key in place");
      assert.notEqual(sha256(dbPath), bytesBefore, "rekey reported success without rewriting the file");
    }

    const state = snapshot(dbPath, survivor.key);
    assert.equal(state.integrity, "ok");
    for (const table of COUNTED) {
      assert.equal(state.counts[table], fixtureCounts[table], `data lost in ${table}`);
    }
    assert.deepEqual(
      { index: state.matchIndex, loose: state.matchLoose },
      { index: fixtureFts.index, loose: fixtureFts.loose },
      "FTS MATCH parity changed across the interrupted rekey"
    );

    // Recovery (what an app start runs) must not need to restore or discard.
    const leftovers = recoverEncryptionState(dbPath, survivor.key);
    assert.ok(
      !leftovers.some((line) => /unreadable|restored/.test(line)),
      `unexpected recovery after a rekey: ${leftovers}`
    );
    assert.equal(existsSync(`${dbPath}.rekey.tmp`), false, "`.rekey.tmp` survived recovery");
    assert.equal(existsSync(`${dbPath}.enc.bak`), false, "`.enc.bak` survived recovery");
  });
}

// --- C1: the CLI surface ----------------------------------------------------
test("C1 CLI: db rekey --new-key-file rotates the key and prints no key material", () => {
  const dbPath = join(workDir, "cli-rekey.db");
  copyFixture(fixtureEncrypted, dbPath);
  const keyFile = join(workDir, "cli-rekey.key");
  writeFileSync(keyFile, `${newB64}\n`, { mode: 0o600 });

  const run = spawnSync(process.execPath, [CLI, "db", "rekey", "--new-key-file", keyFile], {
    env: appEnv(dbPath, { MEMORY_ENCRYPTION: "on", MEMORY_ENCRYPTION_KEY: oldB64 }),
    encoding: "utf8",
    timeout: 180000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const text = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  assert.equal(run.status, 0, `db rekey failed: ${text}`);
  assert.match(run.stdout ?? "", /db rekey: ok/);
  assertNoKeyMaterial(text);
  assert.equal(isEncrypted(dbPath, oldKey), false, "the old key still opens the database");
  assert.equal(isEncrypted(dbPath, newKey), true, "the new key does not open the database");

  const state = snapshot(dbPath, newKey);
  assert.equal(state.integrity, "ok");
  for (const table of COUNTED) assert.equal(state.counts[table], fixtureCounts[table], `CLI rekey lost ${table}`);

  // And back again, through the inline form.
  const back = spawnSync(process.execPath, [CLI, "db", "rekey", "--new-key", oldB64], {
    env: appEnv(dbPath, { MEMORY_ENCRYPTION: "on", MEMORY_ENCRYPTION_KEY: newB64 }),
    encoding: "utf8",
    timeout: 180000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const backText = `${back.stdout ?? ""}${back.stderr ?? ""}`;
  assert.equal(back.status, 0, `db rekey --new-key failed: ${backText}`);
  assertNoKeyMaterial(backText);
  assert.equal(isEncrypted(dbPath, oldKey), true, "the rotated-back key does not open the database");
});

test("C1 CLI: refusals exit 2 (same key, plaintext DB, encryption off, no key)", () => {
  const samePath = join(workDir, "cli-rekey-same.db");
  copyFixture(fixtureEncrypted, samePath);
  const sameFile = join(workDir, "cli-rekey-same.key");
  writeFileSync(sameFile, oldB64, { mode: 0o600 });
  const same = spawnSync(process.execPath, [CLI, "db", "rekey", "--new-key-file", sameFile], {
    env: appEnv(samePath, { MEMORY_ENCRYPTION: "on", MEMORY_ENCRYPTION_KEY: oldB64 }),
    encoding: "utf8",
    timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(same.status, 2, `${same.stdout ?? ""}${same.stderr ?? ""}`);
  assert.match(`${same.stdout ?? ""}${same.stderr ?? ""}`, /identical to the current key/);
  assertNoKeyMaterial(`${same.stdout ?? ""}${same.stderr ?? ""}`);

  const plainPath = join(workDir, "cli-rekey-plaintext.db");
  copyFixture(fixturePlain, plainPath);
  const plain = spawnSync(process.execPath, [CLI, "db", "rekey", "--new-key-file", sameFile], {
    env: appEnv(plainPath, { MEMORY_ENCRYPTION: "on", MEMORY_ENCRYPTION_KEY: oldB64 }),
    encoding: "utf8",
    timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(plain.status, 2, `${plain.stdout ?? ""}${plain.stderr ?? ""}`);
  assert.match(`${plain.stdout ?? ""}${plain.stderr ?? ""}`, /plaintext/);

  const off = spawnSync(process.execPath, [CLI, "db", "rekey", "--new-key-file", sameFile], {
    env: appEnv(samePath, { MEMORY_ENCRYPTION_KEY: oldB64 }),
    encoding: "utf8",
    timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(off.status, 2, `${off.stdout ?? ""}${off.stderr ?? ""}`);
  assert.match(`${off.stdout ?? ""}${off.stderr ?? ""}`, /MEMORY_ENCRYPTION=on/);

  const noKey = spawnSync(process.execPath, [CLI, "db", "rekey", "--new-key-file", sameFile], {
    env: appEnv(samePath, { MEMORY_ENCRYPTION: "on" }),
    encoding: "utf8",
    timeout: 120000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(noKey.status, 2, `${noKey.stdout ?? ""}${noKey.stderr ?? ""}`);
  assert.match(`${noKey.stdout ?? ""}${noKey.stderr ?? ""}`, /MEMORY_ENCRYPTION_KEY/);
});
