import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const pluginPath = join(root, "src", "plugin", "learning-capture.ts");
const plugin = readFileSync(pluginPath, "utf8");

test("learning-capture plugin has no static bun:sqlite import", () => {
  assert.doesNotMatch(
    plugin,
    /^\s*import\s+.*from\s+["']bun:sqlite["']/m,
    "static bun:sqlite import fails in OpenCode Desktop's Node ESM loader"
  );
});

test("learning-capture plugin resolves node:sqlite before bun:sqlite", () => {
  const nodeImport = plugin.indexOf('import("node:sqlite")');
  const bunImport = plugin.indexOf('import("bun:sqlite")');
  assert.ok(nodeImport >= 0, "missing node:sqlite dynamic import");
  assert.ok(bunImport >= 0, "missing bun:sqlite fallback");
  assert.ok(nodeImport < bunImport, "node:sqlite must be the primary driver");
});

const [major, minor] = process.versions.node.split(".").map(Number);
const nodeCanStripTypes = major > 22 || (major === 22 && minor >= 6);

test(
  "learning-capture plugin exposes both V2 (id/setup) and V1 (server) entrypoints",
  { skip: !nodeCanStripTypes },
  async () => {
    const mod = await import(pathToFileURL(pluginPath).href);
    assert.equal(mod.default.id, "learning-capture");
    assert.equal(typeof mod.default.setup, "function");
    assert.equal(typeof mod.default.server, "function");
    assert.equal(typeof mod.LearningCapture, "function");
    assert.equal(mod.default.server, mod.LearningCapture);
  }
);

test(
  "learning-capture plugin loads and captures a prompt under Node",
  { skip: !nodeCanStripTypes },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-plugin-"));
    const dbPath = join(dir, "memory.db");
    const scriptPath = join(dir, "load-plugin.mjs");
    const pluginUrl = pathToFileURL(pluginPath).href;

    writeFileSync(
      scriptPath,
      `const { LearningCapture } = await import(process.env.PLUGIN_URL);
const hooks = await LearningCapture();
await hooks.event({
  event: {
    type: "message.updated",
    properties: {
      info: {
        role: "user",
        id: "msg-plugin-runtime-1",
        sessionID: "sess-plugin-runtime-1",
        parts: [{ text: "plugin runtime smoke test" }],
      },
    },
  },
});
const { DatabaseSync } = await import("node:sqlite");
const db = new DatabaseSync(process.env.MEMORY_DB_PATH, { readOnly: true });
const row = db.prepare("SELECT kind, content FROM interactions").get();
console.log(JSON.stringify(row));
db.close();
`
    );

    try {
      const result = spawnSync(
        process.execPath,
        ["--experimental-strip-types", "--no-warnings", scriptPath],
        {
          cwd: root,
          env: {
            ...process.env,
            MEMORY_DB_PATH: dbPath,
            PLUGIN_URL: pluginUrl,
          },
          encoding: "utf8",
        }
      );
      assert.equal(
        result.status,
        0,
        `plugin failed to load:\n${result.stdout}\n${result.stderr}`
      );
      assert.match(result.stdout, /"kind":"prompt"/);
      assert.match(result.stdout, /plugin runtime smoke test/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
);
