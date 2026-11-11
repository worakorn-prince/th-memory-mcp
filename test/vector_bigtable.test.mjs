// TASK-PERF-MATRIX review (S2/S1): a table larger than one bucket's capacity
// cap must stay exact and warm. The matrix is capped at 3/4 of the budget, so a
// 3,000-row table under a 4 MB budget can hold only 1,536 rows; the remaining
// 1,464 must be scored from the vectors the miss fill fetched — not dropped and
// not re-fetched into a fresh matrix on every query.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { test, after } from "node:test";
import assert from "node:assert/strict";

const dbPath = join(tmpdir(), `th-mem-vector-bigtable-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;
process.env.MEMORY_BACKUP_ON_MIGRATE = "0";

const { db, upsertEmbedding } = await import("../dist/db/index.js");
const { vectorSearch } = await import("../dist/retrieval/vector.js");
const { recallHandler } = await import("../dist/tools/recall.js");
const { embed, EMBED_DIM } = await import("../dist/lib/embed.js");
const cache = await import("../dist/retrieval/vector-cache.js");

const VECTOR_BYTES = EMBED_DIM * 4;
// Mirrors MAX_BUCKET_BUDGET_SHARE in src/retrieval/vector-cache.ts.
const MAX_BUCKET_SHARE = 0.75;
const ROWS = 3000;
const TOPIC = "pnpm typescript deployment server";

const insertMemory = db.prepare(
  "INSERT INTO memories (type, content, created_at, updated_at) VALUES (?, ?, ?, ?)"
);
const ts = new Date().toISOString();
const seed = db.transaction(() => {
  for (let i = 0; i < ROWS; i++) {
    const content = `row ${i} pnpm typescript deployment server group ${i % 9}`;
    const id = Number(insertMemory.run("FACT", content, ts, ts).lastInsertRowid);
    upsertEmbedding("memories", id, embed(content));
  }
});
seed();

after(() => {
  try {
    db.close();
  } catch {}
  for (const s of ["", "-wal", "-shm"]) rmSync(`${dbPath}${s}`, { force: true });
});

test("a 3,000-row table over the 4 MB cap returns cache-off results and stays warm", () => {
  cache.setVectorCacheBudgetMb(0);
  const off = vectorSearch(TOPIC, { limit: 50 });
  assert.equal(off.length, 50);

  cache.setVectorCacheBudgetMb(4);
  try {
    const cap = Math.floor(
      (cache.getVectorCacheBudgetBytes() * MAX_BUCKET_SHARE) / VECTOR_BYTES
    );
    assert.equal(cap, 1536);
    assert.ok(ROWS > cap, "the fixture must exceed the cap");

    const first = vectorSearch(TOPIC, { limit: 50 });
    assert.deepStrictEqual(first, off, "rows past the cap must still be scored");
    const afterFirst = cache.vectorCacheStats();
    assert.equal(
      afterFirst.entries,
      cap,
      "the cold fill must cache exactly the rows that fit the cap"
    );
    assert.equal(afterFirst.hits, 0, "the first query starts cold");
    assert.equal(
      afterFirst.bytes,
      cap * VECTOR_BYTES,
      "the matrix must stop at the cap, not the row count"
    );
    assert.ok(afterFirst.bytes <= afterFirst.budgetBytes);

    const second = vectorSearch(TOPIC, { limit: 50 });
    assert.deepStrictEqual(second, off, "the second query must be exact too");
    const afterSecond = cache.vectorCacheStats();
    assert.ok(
      afterSecond.hits >= afterFirst.hits + cap,
      "every resident row must be a hit on the second query"
    );
    assert.equal(
      afterSecond.bytes,
      afterFirst.bytes,
      "the matrix must not be reallocated (or evicted) per query"
    );
    assert.ok(afterSecond.bytes <= afterSecond.budgetBytes);
  } finally {
    cache.setVectorCacheBudgetMb(64);
  }
});

test("recall on the over-cap table is identical to cache-off", async () => {
  const textOf = (r) => r.content[0].text;
  cache.setVectorCacheBudgetMb(0);
  const referenceText = textOf(await recallHandler({ topic: TOPIC, limit: 5 }));

  cache.setVectorCacheBudgetMb(4);
  try {
    const cachedText = textOf(await recallHandler({ topic: TOPIC, limit: 5 }));
    assert.equal(cachedText, referenceText);
    assert.ok(cache.vectorCacheStats().bytes <= cache.getVectorCacheBudgetBytes());
  } finally {
    cache.setVectorCacheBudgetMb(64);
  }
});
