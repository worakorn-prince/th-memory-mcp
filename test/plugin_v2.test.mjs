import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const dir = mkdtempSync(join(tmpdir(), "mcp-plugin-v2-"));
const dbPath = join(dir, "memory.db");
process.env.MEMORY_DB_PATH = dbPath;

const seed = new DatabaseSync(dbPath);
seed.exec("CREATE TABLE IF NOT EXISTS profile (section TEXT, content TEXT)");
seed.exec(
  "CREATE TABLE IF NOT EXISTS preferences (category TEXT, key TEXT, value TEXT, confidence REAL)"
);
seed.exec(
  "CREATE TABLE IF NOT EXISTS lessons (situation TEXT, mistake TEXT, correction TEXT, created_at TEXT)"
);
seed
  .prepare("INSERT INTO profile (section, content) VALUES (?, ?)")
  .run("identity", "prefers pnpm and Thai");
seed.close();

const { default: plugin, LearningCapture, closeCaptureStore } = await import(
  new URL("../src/plugin/learning-capture.ts", import.meta.url).href
);

const sessionHooks = new Map();
const toolHooks = new Map();
let subscribeOpts;

const ctx = {
  session: {
    hook: async (name, cb) => {
      sessionHooks.set(name, cb);
      return { dispose() {} };
    },
  },
  tool: {
    hook: async (name, cb) => {
      toolHooks.set(name, cb);
      return { dispose() {} };
    },
  },
  event: {
    subscribe: (opts) => {
      subscribeOpts = opts;
      return (async function* () {
        yield {
          type: "session.execution.failed",
          data: {
            sessionID: "s1",
            error: { type: "provider", message: "boom token=secret-value" },
          },
        };
      })();
    },
  },
};

function rows() {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT kind, session_id, content, meta FROM interactions ORDER BY id").all();
  } finally {
    db.close();
  }
}

async function waitForRow(predicate, label, attempts = 50, delayMs = 20) {
  for (let i = 0; i < attempts; i++) {
    const match = rows().find(predicate);
    if (match) return match;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  assert.fail(`${label}: timed out after ${attempts * delayMs}ms`);
}

test("plugin_v2: dual-mode entrypoints", () => {
  assert.equal(plugin.id, "learning-capture");
  assert.equal(typeof plugin.setup, "function");
  assert.equal(typeof plugin.server, "function");
  assert.equal(typeof LearningCapture, "function");
});

test("plugin_v2: captures prompt/tool/error and injects memory on compaction", async () => {
  try {
    const cleanup = await plugin.setup(ctx);

    assert.equal(typeof cleanup, "function");
    assert.equal(typeof sessionHooks.get("prompt"), "function");
    assert.equal(typeof sessionHooks.get("compaction"), "function");
    assert.equal(typeof toolHooks.get("execute.after"), "function");
    assert.deepEqual(subscribeOpts.types, ["session.execution.failed"]);
    assert.ok(subscribeOpts.signal instanceof AbortSignal);

    await sessionHooks.get("prompt")({
      sessionID: "s1",
      messageID: "m1",
      prompt: { text: "hello\nAPI_KEY=secret-value" },
    });

    await toolHooks.get("execute.after")({
      tool: "bash",
      sessionID: "s1",
      agent: "build",
      messageID: "a1",
      id: "c1",
      input: { command: "ls" },
      status: "completed",
      result: { output: "ok" },
    });

    await toolHooks.get("execute.after")({
      tool: "read",
      sessionID: "s1",
      agent: "build",
      messageID: "a1",
      id: "c2",
      input: { path: "x" },
      status: "error",
      error: { message: "nope" },
    });

    await sessionHooks.get("prompt")({
      sessionID: "s1",
      messageID: "m1",
      prompt: { text: "hello\nAPI_KEY=secret-value" },
    });

    const errorRow = await waitForRow(
      (r) => r.kind === "error",
      "missing error row (session.execution.failed)"
    );

    const compaction = { system: [] };
    await sessionHooks.get("compaction")(compaction);

    const captured = rows();
    assert.equal(captured.length, 4, `expected 4 rows, got ${captured.length}`);

    const promptRow = captured.find((r) => r.kind === "prompt");
    assert.ok(promptRow, "missing prompt row");
    assert.equal(promptRow.session_id, "s1");
    assert.ok(promptRow.content.includes("hello"));
    assert.ok(!promptRow.content.includes("secret-value"), "prompt leaked secret");

    const toolRows = captured.filter((r) => r.kind === "tool_call");
    assert.equal(toolRows.length, 2);
    assert.ok(toolRows[0].content.includes("tool=bash status=completed"));
    assert.ok(toolRows[1].content.includes("tool=read status=error"));
    assert.equal(JSON.parse(toolRows[0].meta).callID, "c1");
    assert.equal(JSON.parse(toolRows[1].meta).status, "error");

    assert.equal(errorRow.session_id, "s1");
    assert.ok(errorRow.content.includes("boom"));
    assert.ok(
      !errorRow.content.includes("secret-value"),
      "error message leaked secret"
    );
    assert.ok(
      errorRow.content.includes("[REDACTED]"),
      "error message secret was not redacted"
    );

    assert.equal(compaction.system.length, 1);
    assert.equal(compaction.system[0].type, "text");
    assert.ok(compaction.system[0].text.includes("<memory-reference>"));
    assert.ok(compaction.system[0].text.includes("prefers pnpm"));

    cleanup();
    assert.equal(subscribeOpts.signal.aborted, true);
  } finally {
    await closeCaptureStore();
    rmSync(dir, { recursive: true, force: true });
  }
});
