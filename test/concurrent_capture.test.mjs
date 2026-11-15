// Ph-6 B5 — concurrent capture: the plugin's own raw connection writing
// `interactions` while the MCP server path writes memories/preferences.
//
// The plugin opens its OWN handle (WAL + busy_timeout 5000) and inserts rows
// one statement at a time; the server path runs the app's immediate
// transactions (FTS sync + embeddings) on the same file. Both run for the same
// ~2 s window and are started with an explicit stdin handshake, so the overlap
// does not depend on process start-up timing.
//
// Post-conditions are read back from a fresh connection after both writers
// closed: no lost rows, no SQLITE_BUSY, integrity ok, still WAL, no hot journal.
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { test, after } from "node:test";
import assert from "node:assert/strict";

import Database from "better-sqlite3-multiple-ciphers";

const workDir = mkdtempSync(join(tmpdir(), "th-p6-concurrent-"));
const plainDb = join(workDir, "concurrent-plain.db");

process.env.MEMORY_DB_PATH = plainDb;
process.env.MEMORY_BACKUP_ON_MIGRATE = "0";
delete process.env.MEMORY_ENCRYPTION;
delete process.env.MEMORY_ENCRYPTION_KEY;
delete process.env.MEMORY_AUTH;
delete process.env.MEMORY_AUTH_TOKEN;
delete process.env.MEMORY_AUTH_TOKEN_FILE;

const { db } = await import("../dist/db/index.js");
const { createMemory } = await import("../dist/db/repositories/memories.js");
const { rememberHandler } = await import("../dist/tools/remember.js");
const { openEncryptedDB, isEncrypted } = await import("../dist/db/encryption.js");

const appUrl = new URL("../dist/db/index.js", import.meta.url).href;
const memoriesUrl = new URL("../dist/db/repositories/memories.js", import.meta.url).href;
const rememberUrl = new URL("../dist/tools/remember.js", import.meta.url).href;
const encryptionUrl = new URL("../dist/db/encryption.js", import.meta.url).href;
const driverUrl = import.meta.resolve("better-sqlite3-multiple-ciphers");

const WINDOW_MS = 2000;
const key = new Uint8Array(32).fill(7);
const keyBase64 = Buffer.from(key).toString("base64");

const textOf = (r) => (r?.content ?? []).map((c) => c.text).join("\n");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    db.close();
  } catch {
    /* already closed */
  }
  rmSync(workDir, { recursive: true, force: true });
});

/** Fresh env for a child: never inherit another case's MEMORY_* settings. */
function childEnv(extra = {}) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("MEMORY_")) continue;
    env[name] = value;
  }
  return { ...env, ...extra };
}

const CHILD_COMMON = `
const write = (line) => process.stdout.write(line + "\\n");
const waitForGo = () => new Promise((resolve) => {
  process.stdin.setEncoding("utf8");
  process.stdin.once("data", () => { try { process.stdin.pause(); } catch {} resolve(); });
  process.stdin.resume();
  setTimeout(resolve, 20000).unref();
});
`;

const COUNT_LOOP = `
const deadline = Date.now() + Number(process.env.WRITER_MS);
let written = 0;
const errors = [];
while (Date.now() < deadline) {
  try {
    stmt.run(new Date().toISOString(), process.env.WRITER_SID, "prompt", "concurrent capture row " + written, null, null);
    written++;
  } catch (e) {
    errors.push(String((e && e.message) || e));
    if (errors.length >= 5) break;
  }
}
try { db.pragma("wal_checkpoint(PASSIVE)"); } catch {}
db.close();
write("WROTE " + written);
write("ERRORS " + errors.length + " " + JSON.stringify(errors));
`;

// The plugin's shape: own handle, WAL, busy_timeout, prepared INSERT.
const PLAIN_WRITER = `${CHILD_COMMON}
const Database = (await import(${JSON.stringify(driverUrl)})).default;
const db = new Database(process.env.WRITER_DB);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.exec("CREATE TABLE IF NOT EXISTS interactions (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, session_id TEXT, kind TEXT NOT NULL, content TEXT NOT NULL, meta TEXT, user_id INTEGER)");
const stmt = db.prepare("INSERT INTO interactions (ts, session_id, kind, content, meta, user_id) VALUES (?, ?, ?, ?, ?, ?)");
write("READY");
await waitForGo();
${COUNT_LOOP}`;

// Same shape, but the file is SQLCipher-encrypted: the plugin path has to come
// through openEncryptedDB with the shared key.
const ENCRYPTED_WRITER = `${CHILD_COMMON}
const { openEncryptedDB } = await import(${JSON.stringify(encryptionUrl)});
const key = new Uint8Array(Buffer.from(process.env.CHILD_KEY, "base64"));
const db = openEncryptedDB(process.env.WRITER_DB, key);
const stmt = db.prepare("INSERT INTO interactions (ts, session_id, kind, content, meta, user_id) VALUES (?, ?, ?, ?, ?, ?)");
write("READY");
await waitForGo();
${COUNT_LOOP}`;

// The server path in a child (encrypted run): the app's own handle.
const ENCRYPTED_SERVER = `${CHILD_COMMON}
const app = await import(${JSON.stringify(appUrl)});
const { createMemory } = await import(${JSON.stringify(memoriesUrl)});
const { rememberHandler } = await import(${JSON.stringify(rememberUrl)});
app.getDb();
write("READY");
await waitForGo();
const deadline = Date.now() + Number(process.env.WRITER_MS);
let memories = 0;
let preferences = 0;
const errors = [];
while (Date.now() < deadline) {
  try {
    createMemory({ type: "FACT", content: "encrypted server concurrent memory " + memories });
    memories++;
    const res = await rememberHandler({ category: "coding_pref", key: "enc_" + preferences, value: "enc_value_" + preferences });
    if (res && res.isError) {
      errors.push(String(res.content && res.content[0] && res.content[0].text));
      break;
    }
    preferences++;
  } catch (e) {
    errors.push(String((e && e.message) || e));
    if (errors.length >= 5) break;
  }
  await new Promise((resolve) => setTimeout(resolve, 1));
}
try { app.getDb().pragma("wal_checkpoint(PASSIVE)"); } catch {}
write("MEMORIES " + memories);
write("PREFERENCES " + preferences);
write("ERRORS " + errors.length + " " + JSON.stringify(errors));
`;

function spawnChild(label, script, env) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: workDir,
    env: childEnv(env),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.label = label;
  child.stdoutText = "";
  child.stderrText = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (child.stdoutText += chunk));
  child.stderr.on("data", (chunk) => (child.stderrText += chunk));
  child.exited = new Promise((resolve) =>
    child.on("exit", (code, signal) => resolve({ code, signal }))
  );
  children.add(child);
  return child;
}

async function waitForReady(child, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.stdoutText.includes("READY")) return true;
    if (child.exitCode !== null) return false;
    await sleep(10);
  }
  return child.stdoutText.includes("READY");
}

function startWriters(...kids) {
  for (const child of kids) {
    try {
      child.stdin.write("GO\n");
      child.stdin.end();
    } catch {
      /* a child that already died is reported by its exit code */
    }
  }
}

async function awaitExit(child, timeoutMs = 120000) {
  const result = await Promise.race([
    child.exited,
    sleep(timeoutMs).then(() => ({ code: null, signal: "hung" })),
  ]);
  if (result.signal === "hung") {
    child.kill("SIGKILL");
    return { ...(await child.exited), hung: true };
  }
  children.delete(child);
  return result;
}

function assertNoBusy(child) {
  const combined = `${child.stdoutText}\n${child.stderrText}`;
  assert.doesNotMatch(
    combined,
    /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i,
    `${child.label} hit a busy/locked error:\n${combined}`
  );
  const errors = /ERRORS (\d+)/.exec(child.stdoutText);
  assert.ok(errors, `${child.label} reported no ERRORS line:\n${child.stdoutText}`);
  assert.equal(Number(errors[1]), 0, `${child.label} swallowed write errors:\n${child.stdoutText}`);
}

function assertWrote(child) {
  const wrote = /WROTE (\d+)/.exec(child.stdoutText);
  assert.ok(wrote, `${child.label} reported no WROTE line:\n${child.stdoutText}`);
  const count = Number(wrote[1]);
  assert.ok(count > 0, `${child.label} wrote no rows`);
  return count;
}

function assertNoHotJournal(path, label) {
  assert.equal(existsSync(`${path}-journal`), false, `${label}: a -journal file was left behind`);
}

// --------------------------------------------------- 1. plaintext (parent) ---
test(
  "B5.1 plugin capture + server writes: no lost rows, no SQLITE_BUSY (plaintext)",
  { timeout: 180000 },
  async () => {
    const sid = "capture-child-plain";
    const writer = spawnChild("writer", PLAIN_WRITER, {
      WRITER_DB: plainDb,
      WRITER_SID: sid,
      WRITER_MS: String(WINDOW_MS),
    });
    assert.ok(
      await waitForReady(writer),
      `writer never became ready: ${writer.stdoutText}${writer.stderrText}`
    );

    startWriters(writer);

    // The server path in this process, for the same window.
    let parentMemories = 0;
    let parentPreferences = 0;
    const deadline = Date.now() + WINDOW_MS;
    while (Date.now() < deadline) {
      createMemory({ type: "FACT", content: `parent concurrent memory ${parentMemories}` });
      parentMemories++;
      const res = await rememberHandler({
        category: "coding_pref",
        key: `plain_pref_${parentPreferences}`,
        value: `plain_value_${parentPreferences}`,
      });
      assert.notEqual(res.isError, true, `remember failed: ${textOf(res)}`);
      parentPreferences++;
      await sleep(1);
    }
    assert.ok(parentMemories > 0 && parentPreferences > 0, "parent wrote nothing");

    const exit = await awaitExit(writer);
    assert.equal(exit.code, 0, `writer exited ${exit.code}: ${writer.stderrText}${writer.stdoutText}`);
    assertNoBusy(writer);
    const written = assertWrote(writer);

    // Read everything back from a fresh connection: the app handle must be
    // closed for the sidecar files to settle.
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();

    assertNoHotJournal(plainDb, "plaintext");
    const verify = new Database(plainDb);
    try {
      assert.equal(verify.pragma("integrity_check", { simple: true }), "ok");
      assert.equal(verify.pragma("journal_mode", { simple: true }), "wal");

      const childRows = verify
        .prepare("SELECT count(*) AS c FROM interactions WHERE session_id = ?")
        .get(sid).c;
      assert.equal(childRows, written, "child rows are missing from the DB");
      assert.ok(childRows > 0, "the plugin wrote no interactions");

      const memories = verify
        .prepare("SELECT count(*) AS c FROM memories WHERE content LIKE 'parent concurrent memory %'")
        .get().c;
      assert.equal(memories, parentMemories, "server-written memories are missing");

      const preferences = verify
        .prepare("SELECT count(*) AS c FROM preferences WHERE key LIKE 'plain_pref_%'")
        .get().c;
      assert.equal(preferences, parentPreferences, "server-written preferences are missing");

      // Nothing in either table was corrupted or orphaned by the race.
      const orphans = verify
        .prepare(
          "SELECT count(*) AS c FROM embeddings e LEFT JOIN memories m ON m.id = e.ref_id WHERE e.ref_table = 'memories' AND m.id IS NULL"
        )
        .get().c;
      assert.equal(orphans, 0, "the concurrent writes left orphan embedding rows");
    } finally {
      verify.close();
    }
    assertNoHotJournal(plainDb, "plaintext after verification");
  }
);

// -------------------------------------------------- 2. encrypted (children) ---
test(
  "B5.2 plugin capture + server writes: both processes use the key (encrypted)",
  { timeout: 180000 },
  async () => {
    const encDb = join(workDir, "concurrent-encrypted.db");

    // Bootstrap: the app path creates the encrypted DB + schema once.
    const bootstrap = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const app = await import(${JSON.stringify(appUrl)}); app.getDb().close();`,
      ],
      {
        cwd: workDir,
        env: childEnv({
          MEMORY_DB_PATH: encDb,
          MEMORY_ENCRYPTION: "on",
          MEMORY_ENCRYPTION_KEY: keyBase64,
          MEMORY_BACKUP_ON_MIGRATE: "0",
        }),
        encoding: "utf8",
        timeout: 120000,
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    assert.equal(bootstrap.status, 0, `encrypted bootstrap failed: ${bootstrap.stderr}`);
    assert.equal(isEncrypted(encDb, key), true, "bootstrap did not produce an encrypted DB");

    const sid = "capture-child-encrypted";
    const writer = spawnChild("writer", ENCRYPTED_WRITER, {
      WRITER_DB: encDb,
      WRITER_SID: sid,
      WRITER_MS: String(WINDOW_MS),
      CHILD_KEY: keyBase64,
    });
    const server = spawnChild("server", ENCRYPTED_SERVER, {
      MEMORY_DB_PATH: encDb,
      MEMORY_ENCRYPTION: "on",
      MEMORY_ENCRYPTION_KEY: keyBase64,
      MEMORY_BACKUP_ON_MIGRATE: "0",
      WRITER_MS: String(WINDOW_MS),
    });

    assert.ok(
      await waitForReady(writer),
      `encrypted writer never became ready: ${writer.stdoutText}${writer.stderrText}`
    );
    assert.ok(
      await waitForReady(server),
      `encrypted server never became ready: ${server.stdoutText}${server.stderrText}`
    );

    startWriters(writer, server);

    const [writerExit, serverExit] = await Promise.all([
      awaitExit(writer),
      awaitExit(server),
    ]);
    assert.equal(
      writerExit.code,
      0,
      `encrypted writer exited ${writerExit.code}: ${writer.stderrText}${writer.stdoutText}`
    );
    assert.equal(
      serverExit.code,
      0,
      `encrypted server exited ${serverExit.code}: ${server.stderrText}${server.stdoutText}`
    );
    assertNoBusy(writer);
    assertNoBusy(server);
    const written = assertWrote(writer);
    const serverMemories = Number(/MEMORIES (\d+)/.exec(server.stdoutText)?.[1] ?? -1);
    const serverPreferences = Number(/PREFERENCES (\d+)/.exec(server.stdoutText)?.[1] ?? -1);
    assert.ok(serverMemories > 0, `encrypted server wrote no memories: ${server.stdoutText}`);
    assert.ok(
      serverPreferences > 0,
      `encrypted server wrote no preferences: ${server.stdoutText}`
    );

    assertNoHotJournal(encDb, "encrypted");
    const verify = openEncryptedDB(encDb, key);
    try {
      assert.equal(verify.pragma("integrity_check", { simple: true }), "ok");
      assert.equal(verify.pragma("journal_mode", { simple: true }), "wal");

      const childRows = verify
        .prepare("SELECT count(*) AS c FROM interactions WHERE session_id = ?")
        .get(sid).c;
      assert.equal(childRows, written, "encrypted child rows are missing");

      const memories = verify
        .prepare(
          "SELECT count(*) AS c FROM memories WHERE content LIKE 'encrypted server concurrent memory %'"
        )
        .get().c;
      assert.equal(memories, serverMemories, "encrypted server memories are missing");

      const preferences = verify
        .prepare("SELECT count(*) AS c FROM preferences WHERE key LIKE 'enc_%'")
        .get().c;
      assert.equal(preferences, serverPreferences, "encrypted server preferences are missing");
    } finally {
      verify.close();
    }
    assertNoHotJournal(encDb, "encrypted after verification");
    assert.equal(isEncrypted(encDb, key), true, "the DB stopped being encrypted");
  }
);
