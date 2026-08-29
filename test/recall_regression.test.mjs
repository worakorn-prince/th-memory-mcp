import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const dbPath = join(tmpdir(), `th-mem-recall-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { rememberHandler } = await import("../dist/tools/remember.js");
const { recallHandler } = await import("../dist/tools/recall.js");
const { db } = await import("../dist/db/index.js");

function textOf(r) {
  return r.content[0].text;
}

test("recall surfaces stored preference via FTS (regression for datatype mismatch)", async () => {
  const r1 = await rememberHandler({
    category: "coding_pref",
    key: "recall_reg",
    value: "use 2-space indent",
  });
  assert.ok(!textOf(r1).startsWith("error:"), `remember: ${textOf(r1)}`);

  const r2 = await recallHandler({ topic: "recall_reg indent" });
  assert.ok(!textOf(r2).startsWith("error:"), `recall errored: ${textOf(r2)}`);
  assert.ok(
    textOf(r2).includes("recall_reg"),
    `recall should surface stored preference: ${textOf(r2)}`
  );

  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await import("node:fs").then((fs) =>
        fs.rmSync(`${dbPath}${suffix}`, { force: true })
      );
    } catch {}
  }
});
