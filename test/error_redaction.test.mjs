import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { after, test } from "node:test";
import assert from "node:assert/strict";

const dbPath = join(tmpdir(), `th-error-redact-${process.pid}-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { db, err } = await import("../dist/db/index.js");
const { exportMemoryHandler } = await import("../dist/tools/export_memory.js");
// The plugin is a standalone file excluded from the tsc build; Node's native
// type stripping loads the .ts source directly (skipped if unavailable).

const OPENAI_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";

after(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`, { force: true });
    } catch {
      /* ignore */
    }
  }
});

test("P2: central err() redacts secrets", () => {
  const res = err(`failed for ${OPENAI_KEY}`);
  assert.equal(res.isError, true);
  assert.ok(!res.content[0].text.includes(OPENAI_KEY));
});

test("P2: tool error text does not echo a secret-bearing filename", async () => {
  const res = await exportMemoryHandler({ filename: `../${OPENAI_KEY}.json` });
  assert.equal(res.isError, true);
  assert.ok(!res.content[0].text.includes(OPENAI_KEY), res.content[0].text);
});

test("P2: plugin buildRow redacts content and meta", async (t) => {
  let buildRow;
  try {
    ({ buildRow } = await import("../src/plugin/learning-capture.ts"));
  } catch (e) {
    t.skip(`TypeScript source import unavailable: ${e.message}`);
    return;
  }
  const row = buildRow("tool_call", `ran with ${OPENAI_KEY}`, {
    sessionId: "s-1",
    meta: { headers: { authorization: OPENAI_KEY }, note: "plain" },
  });
  assert.ok(!row.content.includes(OPENAI_KEY));
  assert.ok(!String(row.meta).includes(OPENAI_KEY));
});
