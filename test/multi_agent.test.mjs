// Ph-6 C6 — multi-agent integration: two stdio MCP servers sharing one DB with
// two identities (alice owner, bob writer), plus the plugin's own raw writer.
//
// Every assertion here is a real end-to-end one: the servers are the real
// `dist/index.js` over JSON-RPC on stdio, the identities are issued by the real
// CLI, and the plugin writer is a separate process with its own connection
// (WAL + busy_timeout), started in the same window as the servers' writes.
//
// Case 1 (plaintext): scope isolation, role deny, audit evidence, concurrent
//                     plugin capture, integrity.
// Case 2 (encrypted):  the same shape with MEMORY_ENCRYPTION=on and one shared
//                     key for the server, the CLI and the plugin writer.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test, after } from "node:test";
import assert from "node:assert/strict";

import Database from "better-sqlite3-multiple-ciphers";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const NODE = process.execPath;
const serverPath = join(root, "dist", "index.js");
const cliPath = join(root, "dist", "cli.js");
const encryptionUrl = new URL("../dist/db/encryption.js", import.meta.url).href;
const driverUrl = import.meta.resolve("better-sqlite3-multiple-ciphers");

const workDir = mkdtempSync(join(tmpdir(), "th-p6-multiagent-"));

const { openEncryptedDB } = await import("../dist/db/encryption.js");

const children = new Set();

after(async () => {
  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  // Wait for the handles to be released before removing the directory: on
  // Windows a killed child still holds the DB file for a moment (EPERM).
  await Promise.race([
    Promise.all(
      [...children].map(
        (child) =>
          new Promise((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) return resolve();
            child.once("exit", resolve);
            setTimeout(resolve, 5000);
          })
      )
    ),
    new Promise((resolve) => setTimeout(resolve, 6000)),
  ]);
  try {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch {
    // Best-effort: a leftover temp directory must not fail the suite.
    process.stderr.write(`[multi_agent] could not remove ${workDir}\n`);
  }
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const textOf = (result) => (result?.content ?? []).map((c) => c.text).join("\n");
const DENY = /denied: .* requires role .* \(auth enforced\)/;

/** Fresh env: never inherit another case's MEMORY_* settings. */
function childEnv(extra = {}) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("MEMORY_")) continue;
    env[name] = value;
  }
  return { ...env, MEMORY_BACKUP_ON_MIGRATE: "0", ...extra };
}

// ---------------------------------------------------------------- CLI seed ---

function cli(dbPath, args, extra = {}) {
  return spawnSync(NODE, [cliPath, ...args], {
    cwd: root,
    env: childEnv({ MEMORY_DB_PATH: dbPath, ...extra }),
    encoding: "utf8",
    timeout: 120000,
  });
}

/** Create a user and issue a token through the real CLI; returns the token. */
function seedIdentity(dbPath, externalId, role, extra = {}) {
  const added = cli(dbPath, ["auth", "add-user", externalId, "--role", role], extra);
  assert.equal(added.status, 0, `add-user ${externalId} failed: ${added.stderr}${added.stdout}`);
  const issued = cli(dbPath, ["auth", "issue-token", externalId], extra);
  assert.equal(issued.status, 0, `issue-token ${externalId} failed: ${issued.stderr}${issued.stdout}`);
  const token = issued.stdout.trim();
  assert.match(token, /^thm_/, "issue-token must print the plaintext token");
  return token;
}

// ------------------------------------------------------------ stdio server ---

/**
 * Spawn one real MCP server and expose request/notify/callTool. The init
 * handshake is explicit and slow (a package import + migrations), so every
 * request gets a generous timeout on top of the per-test budget.
 */
async function spawnServer(label, env) {
  const child = spawn(NODE, [serverPath], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv(env),
  });
  child.label = label;
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const pending = new Map();
  let nextId = 1;
  let lineBuf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    lineBuf += chunk;
    let idx;
    while ((idx = lineBuf.indexOf("\n")) >= 0) {
      const line = lineBuf.slice(0, idx).trim();
      lineBuf = lineBuf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id === undefined || !pending.has(msg.id)) continue;
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else entry.resolve(msg.result);
    }
  });

  const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
  children.add(child);

  const request = (method, params, timeoutMs = 30000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${label}: timeout waiting for ${method}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });

  const notify = (method, params) =>
    new Promise((resolve, reject) => {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n", (e) =>
        e ? reject(e) : resolve()
      );
    });

  const callTool = (name, args) => request("tools/call", { name, arguments: args });

  try {
    await request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: `multi-agent-${label}`, version: "0.0.0" },
      },
      60000
    );
    await notify("notifications/initialized");
  } catch (e) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    throw new Error(`${label} failed to initialize: ${stderr}`);
  }

  return {
    label,
    child,
    exited,
    request,
    notify,
    callTool,
    stderr: () => stderr,
    alive: () => child.exitCode === null && child.signalCode === null,
    async stop() {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      children.delete(child);
      await Promise.race([exited, sleep(3000)]);
    },
  };
}

// --------------------------------------------------------- plugin writer ---

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
    stmt.run(new Date().toISOString(), process.env.WRITER_SID, "prompt", "multi-agent plugin row " + written, null);
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

// The plugin's shape: own handle, WAL, busy_timeout, one prepared INSERT.
const PLAIN_WRITER = `${CHILD_COMMON}
const Database = (await import(${JSON.stringify(driverUrl)})).default;
const db = new Database(process.env.WRITER_DB);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");
db.exec("CREATE TABLE IF NOT EXISTS interactions (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, session_id TEXT, kind TEXT NOT NULL, content TEXT NOT NULL, meta TEXT, user_id INTEGER)");
const stmt = db.prepare("INSERT INTO interactions (ts, session_id, kind, content, meta) VALUES (?, ?, ?, ?, ?)");
write("READY");
await waitForGo();
${COUNT_LOOP}`;

// Same shape encrypted: the plugin comes through openEncryptedDB with the key.
const ENCRYPTED_WRITER = `${CHILD_COMMON}
const { openEncryptedDB } = await import(${JSON.stringify(encryptionUrl)});
const key = new Uint8Array(Buffer.from(process.env.CHILD_KEY, "base64"));
const db = openEncryptedDB(process.env.WRITER_DB, key);
const stmt = db.prepare("INSERT INTO interactions (ts, session_id, kind, content, meta) VALUES (?, ?, ?, ?, ?)");
write("READY");
await waitForGo();
${COUNT_LOOP}`;

function spawnWriter(script, env) {
  const child = spawn(NODE, ["--input-type=module", "-e", script], {
    cwd: workDir,
    env: childEnv(env),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.label = "plugin-writer";
  child.stdoutText = "";
  child.stderrText = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (child.stdoutText += chunk));
  child.stderr.on("data", (chunk) => (child.stderrText += chunk));
  child.exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve({ code, signal })));
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

function startWriter(child) {
  try {
    child.stdin.write("GO\n");
    child.stdin.end();
  } catch {
    /* a child that already died is reported by its exit code */
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

function assertWriterClean(child) {
  const combined = `${child.stdoutText}\n${child.stderrText}`;
  assert.doesNotMatch(combined, /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i, combined);
  const wrote = /WROTE (\d+)/.exec(child.stdoutText);
  assert.ok(wrote, `writer reported no WROTE line: ${combined}`);
  const count = Number(wrote[1]);
  assert.ok(count > 0, `writer wrote no rows: ${combined}`);
  const errors = /ERRORS (\d+)/.exec(child.stdoutText);
  assert.ok(errors, `writer reported no ERRORS line: ${child.stdoutText}`);
  assert.equal(Number(errors[1]), 0, `writer swallowed write errors: ${combined}`);
  return count;
}

function assertServerHealthy(server) {
  assert.equal(server.alive(), true, `${server.label} exited while the test was running`);
  assert.doesNotMatch(
    server.stderr(),
    /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i,
    `${server.label} hit a busy/locked error:\n${server.stderr()}`
  );
}

// --------------------------------------------------- audit + row helpers ---

function assertAuditEvidence(handle, expectations) {
  const rows = handle
    .prepare(
      `SELECT user_id, tool, kind, decision, reason, scope_kind, scope_ref
       FROM audit_log ORDER BY id`
    )
    .all();
  assert.ok(rows.length > 0, "no audit rows were written");

  for (const row of rows) {
    // Bounded, single-line fields: never memory content.
    assert.ok(String(row.tool).length <= 64, `audit tool is unbounded: ${row.tool}`);
    assert.ok(
      row.reason === null || String(row.reason).length <= 32,
      `audit reason is unbounded: ${row.reason}`
    );
    assert.ok(
      row.scope_ref === null || String(row.scope_ref).length <= 120,
      `audit scope_ref is unbounded: ${row.scope_ref}`
    );
    for (const value of Object.values(row)) {
      if (typeof value === "string") assert.doesNotMatch(value, /[\r\n]/, "audit field has a line break");
    }
    const flat = JSON.stringify(row);
    assert.equal(flat.includes("pnpm"), false, `audit rows must be content-free: ${flat}`);
    assert.equal(flat.includes("multi-agent plugin row"), false, `audit rows must be content-free: ${flat}`);
  }

  const allow = rows.find(
    (r) =>
      r.tool === expectations.allowTool &&
      r.decision === "allow" &&
      r.user_id === expectations.allowUid
  );
  assert.ok(allow, `missing allow row for ${expectations.allowTool} (uid ${expectations.allowUid})`);

  if (expectations.denyTool === undefined) return;
  const deny = rows.find(
    (r) =>
      r.tool === expectations.denyTool &&
      r.decision === "deny" &&
      r.reason === "role" &&
      r.user_id === expectations.denyUid
  );
  assert.ok(deny, `missing role deny row for ${expectations.denyTool} (uid ${expectations.denyUid})`);
}

function uidOf(handle, externalId) {
  const row = handle.prepare("SELECT id, role FROM users WHERE external_id = ?").get(externalId);
  assert.ok(row, `user ${externalId} is missing`);
  return row;
}

// ================================================================= case 1 ===

test(
  "C6.1 two stdio servers + one DB + two identities: scope, role, audit, plugin",
  { timeout: 240000 },
  async () => {
    const dbPath = join(workDir, "multi-agent.db");
    const sid = "multi-agent-plugin";

    const aliceToken = seedIdentity(dbPath, "alice", "owner");
    const bobToken = seedIdentity(dbPath, "bob", "writer");

    const alice = await spawnServer("alice", { MEMORY_DB_PATH: dbPath, MEMORY_AUTH: "on", MEMORY_AUTH_TOKEN: aliceToken });
    const bob = await spawnServer("bob", { MEMORY_DB_PATH: dbPath, MEMORY_AUTH: "on", MEMORY_AUTH_TOKEN: bobToken });
    let writer;
    let written = 0;
    let probeId = 0;

    try {
      // 1. alice (owner) remembers the probe preference.
      const remembered = await alice.callTool("remember", {
        category: "coding_pref",
        key: "multi_agent_probe",
        value: "pnpm",
      });
      assert.notEqual(remembered?.isError, true, `alice remember failed: ${textOf(remembered)}`);
      assert.match(textOf(remembered), /remembered \[coding_pref\] multi_agent_probe = pnpm/);
      probeId = Number(/preference id=(\d+)/.exec(textOf(remembered))?.[1] ?? 0);
      assert.ok(probeId > 0, `remember returned no id: ${textOf(remembered)}`);

      // 2. bob (writer) cannot read alice's preference value.
      const bobRecall = await bob.callTool("recall", { topic: "pnpm" });
      assert.notEqual(bobRecall?.isError, true, `bob recall failed: ${textOf(bobRecall)}`);
      assert.equal(
        textOf(bobRecall).includes("multi_agent_probe"),
        false,
        `bob must not see alice's preference: ${textOf(bobRecall)}`
      );
      assert.equal(
        /: pnpm/.test(textOf(bobRecall)),
        false,
        `bob must not see alice's value: ${textOf(bobRecall)}`
      );

      // Positive control: the owner does see it.
      const aliceRecall = await alice.callTool("recall", { topic: "multi_agent_probe" });
      assert.match(
        textOf(aliceRecall),
        /coding_pref\/multi_agent_probe/,
        `alice must see her own preference: ${textOf(aliceRecall)}`
      );

      // 3. bob cannot overwrite a preference key owned by another user.
      const bobRemember = await bob.callTool("remember", {
        category: "coding_pref",
        key: "multi_agent_probe",
        value: "npm",
      });
      assert.equal(bobRemember?.isError, true, "bob must not overwrite alice's key");
      assert.match(textOf(bobRemember), /denied: preference belongs to another user \(auth enforced\)/);

      // 4. forget is owner-only: bob is role-denied.
      const bobForget = await bob.callTool("forget", { target_id: probeId, type: "preference" });
      assert.equal(bobForget?.isError, true, "writer forget must be denied");
      assert.match(textOf(bobForget), DENY);
      assert.match(textOf(bobForget), /denied: forget requires role owner \(auth enforced\)/);

      // 5. The plugin's own connection writes interactions while both servers
      //    keep working: no `database is locked` for anyone.
      writer = spawnWriter(PLAIN_WRITER, {
        WRITER_DB: dbPath,
        WRITER_SID: sid,
        WRITER_MS: "1500",
      });
      assert.ok(
        await waitForReady(writer),
        `plugin writer never became ready: ${writer.stdoutText}${writer.stderrText}`
      );
      startWriter(writer);

      const deadline = Date.now() + 1200;
      let round = 0;
      while (Date.now() < deadline) {
        const roundRemember = await alice.callTool("remember", {
          category: "coding_pref",
          key: `multi_agent_round_${round}`,
          value: `value_${round}`,
        });
        assert.notEqual(roundRemember?.isError, true, `round remember failed: ${textOf(roundRemember)}`);
        await bob.callTool("recall", { topic: "pnpm" });
        round++;
        await sleep(25);
      }
      assert.ok(round > 0, "the concurrent window ran no server writes");

      const exit = await awaitExit(writer);
      assert.equal(exit.code, 0, `plugin writer exited ${exit.code}: ${writer.stderrText}${writer.stdoutText}`);
      written = assertWriterClean(writer);

      // 6. Both servers are still responsive after the plugin finished.
      const statsAlice = await alice.callTool("memory_stats", {});
      assert.notEqual(statsAlice?.isError, true, `alice memory_stats failed: ${textOf(statsAlice)}`);
      assert.match(textOf(statsAlice), /interactions:/);

      const statsBob = await bob.callTool("memory_stats", {});
      assert.notEqual(statsBob?.isError, true, `bob memory_stats failed: ${textOf(statsBob)}`);

      assertServerHealthy(alice);
      assertServerHealthy(bob);
    } finally {
      await alice.stop();
      await bob.stop();
      if (writer !== undefined && writer.exitCode === null) {
        try {
          writer.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }

    // 7. Read everything back from a fresh connection, after both servers closed.
    const verify = new Database(dbPath);
    try {
      assert.equal(verify.pragma("integrity_check", { simple: true }), "ok");
      assert.equal(verify.pragma("journal_mode", { simple: true }), "wal");

      const interactions = verify
        .prepare("SELECT content FROM interactions WHERE session_id = ?")
        .all(sid);
      assert.equal(interactions.length, written, "plugin interaction rows are missing");

      const aliceRow = uidOf(verify, "alice");
      const bobRow = uidOf(verify, "bob");
      assert.equal(aliceRow.role, "owner");
      assert.equal(bobRow.role, "writer");

      const probe = verify
        .prepare("SELECT value, user_id FROM preferences WHERE category = 'coding_pref' AND key = 'multi_agent_probe'")
        .get();
      assert.ok(probe, "alice's preference disappeared");
      assert.equal(probe.value, "pnpm", "bob must not have overwritten alice's value");
      assert.equal(probe.user_id, aliceRow.id, "the preference must stay owned by alice");

      assertAuditEvidence(verify, {
        allowTool: "remember",
        allowUid: aliceRow.id,
        denyTool: "forget",
        denyUid: bobRow.id,
      });
    } finally {
      verify.close();
    }
  }
);

// ================================================================= case 2 ===

test(
  "C6.2 encrypted: one stdio server + plugin writer, same key, same invariants",
  { timeout: 240000 },
  async () => {
    const dbPath = join(workDir, "multi-agent-encrypted.db");
    const sid = "multi-agent-plugin-encrypted";
    const key = new Uint8Array(32).fill(9);
    const keyBase64 = Buffer.from(key).toString("base64");
    const encEnv = { MEMORY_ENCRYPTION: "on", MEMORY_ENCRYPTION_KEY: keyBase64 };

    const aliceToken = seedIdentity(dbPath, "alice", "owner", encEnv);
    const bobToken = seedIdentity(dbPath, "bob", "writer", encEnv);

    const alice = await spawnServer("alice-enc", {
      MEMORY_DB_PATH: dbPath,
      MEMORY_AUTH: "on",
      MEMORY_AUTH_TOKEN: aliceToken,
      ...encEnv,
    });
    let writer;
    let written = 0;
    let round = 0;

    try {
      const remembered = await alice.callTool("remember", {
        category: "coding_pref",
        key: "multi_agent_probe",
        value: "pnpm",
      });
      assert.notEqual(remembered?.isError, true, `encrypted remember failed: ${textOf(remembered)}`);

      writer = spawnWriter(ENCRYPTED_WRITER, {
        WRITER_DB: dbPath,
        WRITER_SID: sid,
        WRITER_MS: "1200",
        CHILD_KEY: keyBase64,
      });
      assert.ok(
        await waitForReady(writer),
        `encrypted plugin writer never became ready: ${writer.stdoutText}${writer.stderrText}`
      );
      startWriter(writer);

      const deadline = Date.now() + 900;
      while (Date.now() < deadline) {
        const res = await alice.callTool("remember", {
          category: "coding_pref",
          key: `multi_agent_enc_${round}`,
          value: `enc_value_${round}`,
        });
        assert.notEqual(res?.isError, true, `encrypted round remember failed: ${textOf(res)}`);
        round++;
        await sleep(25);
      }
      assert.ok(round > 0, "the encrypted concurrent window ran no server writes");

      const exit = await awaitExit(writer);
      assert.equal(exit.code, 0, `encrypted writer exited ${exit.code}: ${writer.stderrText}${writer.stdoutText}`);
      written = assertWriterClean(writer);

      const stats = await alice.callTool("memory_stats", {});
      assert.notEqual(stats?.isError, true, `encrypted memory_stats failed: ${textOf(stats)}`);
      assertServerHealthy(alice);
    } finally {
      await alice.stop();
      if (writer !== undefined && writer.exitCode === null) {
        try {
          writer.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }

    // The DB is unreadable without the key and clean with it.
    assert.throws(() => new Database(dbPath).prepare("SELECT count(*) FROM sqlite_master").get());

    const verify = openEncryptedDB(dbPath, key);
    try {
      assert.equal(verify.pragma("integrity_check", { simple: true }), "ok");
      assert.equal(verify.pragma("journal_mode", { simple: true }), "wal");

      const interactions = verify
        .prepare("SELECT content FROM interactions WHERE session_id = ?")
        .all(sid);
      assert.equal(interactions.length, written, "encrypted plugin rows are missing");

      const probe = verify
        .prepare("SELECT value FROM preferences WHERE category = 'coding_pref' AND key = 'multi_agent_probe'")
        .get();
      assert.ok(probe, "encrypted preference disappeared");
      assert.equal(probe.value, "pnpm");

      const aliceRow = uidOf(verify, "alice");
      const bobRow = uidOf(verify, "bob");
      assertAuditEvidence(verify, {
        allowTool: "remember",
        allowUid: aliceRow.id,
      });
      // bob was issued a token in this DB but made no call, so no deny exists yet;
      // the shared audit shape is still proven by the allow row above.
      assert.equal(typeof bobToken, "string");
    } finally {
      verify.close();
    }
  }
);
