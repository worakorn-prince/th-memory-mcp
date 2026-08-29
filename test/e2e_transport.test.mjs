import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED_TOOLS = [
  "consolidate",
  "export_memory",
  "extract_memories",
  "forget",
  "get_context",
  "get_profile",
  "get_recent_interactions",
  "import_memory",
  "link_memory",
  "memory_stats",
  "merge_memory",
  "recall",
  "remember",
  "save_lesson",
  "search_history",
  "update_memory",
];

function textOf(result) {
  return result.content[0].text;
}

function assertOk(result, label) {
  const t = textOf(result);
  assert.ok(
    result.isError !== true &&
      !t.startsWith("error:") &&
      !t.startsWith("MCP error"),
    `${label} failed: ${t}`
  );
}

test(
  "MCP transport E2E: server works over real stdio",
  { timeout: 30000 },
  async () => {
    const db = path.join(os.tmpdir(), `th-mem-e2e-${Date.now()}.db`);
    const transport = new StdioClientTransport({
      command: "node",
      args: ["dist/index.js"],
      env: { ...process.env, MEMORY_DB_PATH: db, NODE_ENV: "test" },
    });
    const client = new Client({ name: "e2e-test", version: "1.0.0" });

    try {
      await client.connect(transport);

      const { tools } = await client.listTools();
      assert.equal(tools.length, EXPECTED_TOOLS.length, "tool count over stdio");
      assert.deepEqual(
        tools.map((t) => t.name).sort(),
        EXPECTED_TOOLS,
        "tool names over stdio"
      );

      const r1 = await client.callTool({
        name: "remember",
        arguments: {
          category: "coding_pref",
          key: "e2e_demo",
          value: "agent should use numeric options 1-4",
        },
      });
      assertOk(r1, "remember");

      const r2 = await client.callTool({
        name: "recall",
        arguments: { topic: "E2E demo numeric options" },
      });
      assertOk(r2, "recall");
      assert.ok(
        textOf(r2).includes("e2e_demo"),
        `recall should surface stored memory: ${textOf(r2)}`
      );

      const r3 = await client.callTool({ name: "memory_stats", arguments: {} });
      assertOk(r3, "memory_stats");
      assert.ok(
        textOf(r3).includes("preferences"),
        `memory_stats should report preferences: ${textOf(r3)}`
      );

      const r4 = await client.callTool({
        name: "get_context",
        arguments: { query: "E2E demo", maxTokens: 500 },
      });
      assertOk(r4, "get_context");
    } finally {
      await client.close().catch(() => {});
      transport.process?.kill("SIGKILL");
      fs.rmSync(db, { force: true });
    }
  }
);
