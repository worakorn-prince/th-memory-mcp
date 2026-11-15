import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const serverPath = join(root, "dist", "index.js");
const cliPath = join(root, "dist", "cli.js");

const workDir = mkdtempSync(join(tmpdir(), "th-auth-p2-"));
const dbPath = join(workDir, "authz.db");

// Default mode for the whole file: MEMORY_AUTH off (v2.5.2 behaviour).
process.env.MEMORY_DB_PATH = dbPath;
delete process.env.MEMORY_AUTH;
delete process.env.MEMORY_AUTH_TOKEN;
delete process.env.MEMORY_AUTH_TOKEN_FILE;

const { withAuth } = await import("../dist/auth/guard.js");
const { setIdentity } = await import("../dist/auth/identity.js");
const { db } = await import("../dist/db/index.js");

test.after(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  rmSync(workDir, { recursive: true, force: true });
});

function enforced(roles, userId = "alice") {
  return { mode: "enforced", userId, uid: 1, roles };
}

async function captureStderr(fn) {
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const value = await fn();
    return { value, stderr: chunks.join("") };
  } finally {
    process.stderr.write = original;
  }
}

const textOf = (result) => (result?.content ?? []).map((c) => c.text).join("\n");

// ------------------------------------------------------- legacy passthrough ---

test("legacy mode: withAuth calls the handler once and returns its result unchanged", async () => {
  setIdentity({ mode: "legacy", roles: [] });

  const sentinel = { content: [{ type: "text", text: "pong" }] };
  let calls = 0;
  let seenArgs;
  const wrapped = withAuth("forget", (args) => {
    calls++;
    seenArgs = args;
    return sentinel;
  });

  const args = { target_id: 1, type: "preference" };
  const result = await wrapped(args);

  assert.equal(calls, 1, "handler must run exactly once");
  assert.equal(seenArgs, args, "args must be forwarded untouched");
  assert.equal(result, sentinel, "result must be identical (no wrapping)");
});

test("legacy mode: async handler results pass straight through", async () => {
  setIdentity({ mode: "legacy", roles: [] });
  const sentinel = { content: [{ type: "text", text: "async-pong" }] };
  const wrapped = withAuth("memory_stats", async () => sentinel);
  assert.equal(await wrapped(), sentinel);
});

// ------------------------------------------- structural default-deny at boot ---

test("registration-time: a tool with no policy entry throws", () => {
  assert.throws(
    () => withAuth("unpoliced_tool", () => ({ content: [] })),
    /no TOOL_POLICY entry for "unpoliced_tool": refusing to register an unpoliced tool/
  );
  assert.throws(() => withAuth("", () => ({ content: [] })), /no TOOL_POLICY entry for ""/);
});

test("registration-time: every policed tool registers without throwing", () => {
  const tools = [
    "recall",
    "get_profile",
    "get_context",
    "memory_stats",
    "search_history",
    "get_recent_interactions",
    "remember",
    "save_lesson",
    "update_memory",
    "link_memory",
    "forget",
    "merge_memory",
    "consolidate",
    "export_memory",
    "import_memory",
    "extract_memories",
  ];
  for (const name of tools) assert.equal(typeof withAuth(name, () => ({ content: [] })), "function");
});

// ------------------------------------------------------------- deny semantics ---

test("deny: bounded isError result, handler not called, no role echo", async () => {
  setIdentity(enforced(["reader"]));

  let calls = 0;
  const wrapped = withAuth("forget", () => {
    calls++;
    return { content: [{ type: "text", text: "should not happen" }] };
  });

  const { value, stderr } = await captureStderr(() => wrapped({ target_id: 7 }));

  assert.equal(calls, 0, "a denied call must not reach the handler");
  assert.equal(value.isError, true, "deny must be a tool error result");
  const text = textOf(value);
  assert.match(text, /denied: forget requires role owner \(auth enforced\)/);
  assert.equal(text.includes("reader"), false, "the caller's own roles must not be echoed");
  assert.equal(text.length <= 300, true, "deny text stays bounded");
  assert.equal(
    stderr,
    '[th-memory-mcp] authz: deny forget user=alice needs=owner\n',
    "one bounded stderr deny line"
  );
});

test("deny: enforced identity with no roles is denied on every tool", async () => {
  setIdentity(enforced([]));
  for (const name of ["recall", "remember", "forget", "memory_stats"]) {
    let calls = 0;
    const { value } = await captureStderr(() =>
      withAuth(name, () => {
        calls++;
        return { content: [{ type: "text", text: "ran" }] };
      })({})
    );
    assert.equal(calls, 0, `${name} must not run with roles=[]`);
    assert.equal(value.isError, true, `${name} must be denied`);
  }
});

test("allow: a permitted role reaches the handler with args intact", async () => {
  setIdentity(enforced(["writer"]));
  const args = { category: "coding_pref", key: "package_manager", value: "pnpm" };
  let seenArgs;
  const sentinel = { content: [{ type: "text", text: "id=1" }] };
  const result = await withAuth("remember", (received) => {
    seenArgs = received;
    return sentinel;
  })(args);
  assert.equal(seenArgs, args);
  assert.equal(result, sentinel);
});

test("deny trail: single line, newline-stripped and capped at 240 chars", async () => {
  const hostile = `bad\nuser\r${"x".repeat(400)}`;
  setIdentity(enforced(["reader"], hostile));
  const { stderr } = await captureStderr(() =>
    withAuth("consolidate", () => ({ content: [] }))({})
  );
  const lines = stderr.split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, 1, "exactly one line on stderr");
  assert.equal(lines[0].includes("\r"), false);
  assert.equal(lines[0].length <= 240, true, `line length ${lines[0].length}`);
});

// -------------------------------------------------------- registration pairing ---

test("every registerTool site in dist/index.js is wrapped by withAuth with the same name", () => {
  const src = readFileSync(serverPath, "utf8");
  const names = (pattern) =>
    [...src.matchAll(pattern)].map((m) => m[1]).sort();

  const registered = names(/registerTool\(\s*"([^"]+)"/g);
  const guarded = names(/withAuth\(\s*"([^"]+)"/g);

  assert.equal(registered.length, 16, `registerTool sites: ${registered.join(", ")}`);
  assert.equal(guarded.length, 16, `withAuth sites: ${guarded.join(", ")}`);
  assert.deepEqual(guarded, registered, "withAuth(name) must match registerTool(name)");
  assert.equal(new Set(registered).size, 16, "tool names must be unique");
});

// ------------------------------------------------------- E2E over stdio JSON-RPC ---

function cli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    env: { ...process.env, MEMORY_DB_PATH: dbPath },
    encoding: "utf8",
  });
}

function seedIdentity(externalId, role) {
  const added = cli(["auth", "add-user", externalId, "--role", role]);
  assert.equal(added.status, 0, `add-user ${externalId} failed: ${added.stderr}`);
  const issued = cli(["auth", "issue-token", externalId]);
  assert.equal(issued.status, 0, `issue-token ${externalId} failed: ${issued.stderr}`);
  const token = issued.stdout.trim();
  assert.match(token, /^thm_/, "issue-token must print the plaintext token");
  return token;
}

async function withServer(env, fn) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MEMORY_DB_PATH: dbPath, ...env },
  });

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

  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }, 10000);
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

  const watchdog = setTimeout(() => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  }, 20000);

  try {
    await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "authz-e2e", version: "0.0.0" },
    });
    await notify("notifications/initialized");
    return await fn({ callTool, request, stderr: () => stderr });
  } finally {
    clearTimeout(watchdog);
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
  }
}

const DENY = /denied: .* requires role .* \(auth enforced\)/;

test("E2E enforced: reader may recall but not remember", async () => {
  const token = seedIdentity("p2-reader", "reader");
  await withServer({ MEMORY_AUTH: "on", MEMORY_AUTH_TOKEN: token }, async ({ callTool }) => {
    const recall = await callTool("recall", { topic: "anything" });
    assert.notEqual(recall?.isError, true, `reader recall must pass: ${textOf(recall)}`);

    const remember = await callTool("remember", {
      category: "coding_pref",
      key: "p2_reader_blocked",
      value: "should never be stored",
    });
    assert.equal(remember?.isError, true, "reader remember must be denied");
    assert.match(textOf(remember), DENY);
    assert.match(textOf(remember), /denied: remember requires role writer \(auth enforced\)/);
  });
});

test("E2E enforced: writer may remember but not forget", async () => {
  const token = seedIdentity("p2-writer", "writer");
  await withServer({ MEMORY_AUTH: "on", MEMORY_AUTH_TOKEN: token }, async ({ callTool }) => {
    const remember = await callTool("remember", {
      category: "coding_pref",
      key: "p2_writer_package_manager",
      value: "pnpm",
    });
    assert.notEqual(remember?.isError, true, `writer remember must pass: ${textOf(remember)}`);

    const forget = await callTool("forget", { target_id: 999999, type: "preference" });
    assert.equal(forget?.isError, true, "writer forget must be denied");
    assert.match(textOf(forget), /denied: forget requires role owner \(auth enforced\)/);
  });
});

test("E2E enforced: owner reaches forget (not a deny)", async () => {
  const token = seedIdentity("p2-owner", "owner");
  await withServer({ MEMORY_AUTH: "on", MEMORY_AUTH_TOKEN: token }, async ({ callTool }) => {
    const forget = await callTool("forget", { target_id: 999999, type: "preference" });
    assert.doesNotMatch(textOf(forget), DENY, `owner must not be denied: ${textOf(forget)}`);

    const remember = await callTool("remember", {
      category: "coding_pref",
      key: "p2_owner_package_manager",
      value: "npm",
    });
    assert.notEqual(remember?.isError, true, "owner remember must pass");
  });
});

test("E2E legacy (MEMORY_AUTH unset): forget is not denied", async () => {
  await withServer({ MEMORY_AUTH: "", MEMORY_AUTH_TOKEN: "" }, async ({ callTool }) => {
    const forget = await callTool("forget", { target_id: 999999, type: "preference" });
    assert.doesNotMatch(textOf(forget), DENY, `legacy must not deny: ${textOf(forget)}`);
  });
});
