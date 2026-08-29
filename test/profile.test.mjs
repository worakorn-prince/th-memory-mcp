import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const dbPath = join(tmpdir(), `th-mem-profile-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { createMemory } = await import("../dist/db/repositories/memories.js");
const { getProfileHandler } = await import("../dist/tools/profile.js");
const { db } = await import("../dist/db/index.js");

function textOf(r) {
  return r.content[0].text;
}

test("get_profile auto-projects top memories from the unified store", async () => {
  createMemory({
    type: "PROJECT",
    content: "Use pnpm as the package manager for this project",
    importance: 0.95,
    confidence: 0.9,
  });
  createMemory({
    type: "FACT",
    content: "Low-signal trivia that should not surface",
    importance: 0.1,
    confidence: 0.2,
  });

  const r = await getProfileHandler();
  assert.ok(!textOf(r).startsWith("error:"), `get_profile: ${textOf(r)}`);
  assert.ok(
    textOf(r).includes("Use pnpm as the package manager"),
    `profile should auto-project the high-importance memory: ${textOf(r)}`
  );
  assert.ok(
    textOf(r).includes("[memories]"),
    `profile should contain an auto-projected [memories] section: ${textOf(r)}`
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
