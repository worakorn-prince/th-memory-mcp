import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  existsSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { after, test } from "node:test";
import assert from "node:assert/strict";

const dbPath = join(tmpdir(), `th-path-sandbox-${process.pid}-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { db, DB_PATH } = await import("../dist/db/index.js");
const { createMemory } = await import("../dist/db/repositories/memories.js");
const { exportMemoryHandler } = await import("../dist/tools/export_memory.js");

const EXPORT_DIR = join(dirname(DB_PATH), "exports");

after(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`, { force: true });
    } catch {
      /* ignore */
    }
  }
  try {
    rmSync(EXPORT_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test("P2: export writes atomically and leaves no temp file", async () => {
  createMemory({ type: "FACT", content: "sandbox export row" });
  const res = await exportMemoryHandler({ filename: "sandbox.json" });
  assert.ok(res?.isError !== true, JSON.stringify(res));
  const filePath = res.content[0].text.match(/exported:\s*(\S+\.json)/)?.[1];
  assert.ok(filePath && existsSync(filePath));
  const payload = JSON.parse(readFileSync(filePath, "utf8"));
  assert.equal(payload.format, "th-memory-mcp/v2");

  const leftovers = readdirSync(EXPORT_DIR).filter((f) => f.includes(".tmp-"));
  assert.deepEqual(leftovers, [], "no temp files left behind");
});

test("P2: export refuses to follow a symlink at the destination", async (t) => {
  const victim = join(EXPORT_DIR, "victim.txt");
  const link = join(EXPORT_DIR, "link.json");
  try {
    writeFileSync(victim, "do not overwrite", "utf8");
    symlinkSync(victim, link, "file");
  } catch (e) {
    if (e?.code === "EPERM" || e?.code === "EACCES") {
      t.skip("symlink creation not permitted on this platform");
      return;
    }
    throw e;
  }

  const res = await exportMemoryHandler({ filename: "link.json" });
  assert.ok(res?.isError === true, "export must fail on symlink target");
  assert.match(res.content[0].text, /must not be a symlink/);
  assert.equal(readFileSync(victim, "utf8"), "do not overwrite");
});
