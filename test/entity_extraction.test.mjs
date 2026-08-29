import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const dbPath = join(tmpdir(), `th-mem-entity-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { createMemory } = await import("../dist/db/repositories/memories.js");
const {
  extractEntities,
  linkEntitiesForMemory,
  linkMemoriesBySharedEntities,
} = await import("../dist/core/entity-extractor.js");
const { db } = await import("../dist/db/index.js");

test("auto entity extraction links memories that share an entity", async () => {
  const c1 = "Use pnpm as the package manager for this project";
  const c2 = "pnpm is faster than npm for builds";
  const m1 = createMemory({ type: "PROJECT", content: c1, importance: 0.8 });
  const m2 = createMemory({ type: "PROJECT", content: c2, importance: 0.8 });

  assert.ok(
    extractEntities(c1).includes("pnpm"),
    `extractEntities should catch pnpm: ${extractEntities(c1)}`
  );

  linkEntitiesForMemory(m1, c1);
  linkEntitiesForMemory(m2, c2);
  linkMemoriesBySharedEntities([m1, m2]);

  const entity = db
    .prepare("SELECT id FROM entities WHERE canonical_name = ?")
    .get("pnpm");
  assert.ok(entity, "entity 'pnpm' should be persisted");

  const link = db
    .prepare(
      `SELECT * FROM memory_links
       WHERE ((source_memory_id = ? AND target_memory_id = ?) OR (source_memory_id = ? AND target_memory_id = ?))
         AND relation = 'shares_entity'`
    )
    .get(m1, m2, m2, m1);
  assert.ok(link, "memories sharing 'pnpm' should be linked via shares_entity");

  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await import("node:fs").then((fs) =>
        fs.rmSync(`${dbPath}${suffix}`, { force: true })
      );
    } catch {}
  }
});
