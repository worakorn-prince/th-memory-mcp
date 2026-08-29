import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const dbPath = join(tmpdir(), `th-mcp-perf-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { createMemory } = await import("../dist/db/repositories/memories.js");
const { retrieve } = await import("../dist/core/retrieval-engine.js");
const { rememberHandler } = await import("../dist/tools/remember.js");
const { recallHandler } = await import("../dist/tools/recall.js");
const { contextHandler } = await import("../dist/tools/context.js");
const { getProfileHandler } = await import("../dist/tools/profile.js");
const { searchHistoryHandler } = await import("../dist/tools/history.js");
const { db } = await import("../dist/db/index.js");

// Performance benchmark (spec §29). Measures warm-cache latency per operation and
// asserts the §29 engineering targets. Runs as a node:test suite so it executes in CI.

function minLatency(fn, iterations = 7) {
  let best = Infinity;
  for (let i = 0; i < iterations; i++) {
    const t0 = Date.now();
    fn();
    const dt = Date.now() - t0;
    if (dt < best) best = dt;
  }
  return best;
}

test(
  "performance targets (§29) on 300 memories",
  { timeout: 60000 },
  async () => {
    const N = 300;
    for (let i = 0; i < N; i++) {
      createMemory({
        type: "FACT",
        content: `benchmark memory number ${i} about topic ${i % 20}`,
        source: "explicit",
      });
    }

    const retrieveDt = minLatency(() => retrieve("benchmark memory topic", { limit: 10 }));
    assert.ok(retrieveDt < 2000, `retrieve over 300 memories ${retrieveDt}ms >= 2000ms`);

    const rememberDt = minLatency(() =>
      rememberHandler({ category: "other", key: `perf_${Date.now()}`, value: "x" })
    );
    assert.ok(rememberDt < 20, `remember ${rememberDt}ms >= 20ms`);

    const recallDt = minLatency(() => recallHandler({ topic: "benchmark memory topic" }));
    assert.ok(recallDt < 50, `recall ${recallDt}ms >= 50ms`);

    const ctxDt = minLatency(() =>
      contextHandler({ query: "benchmark memory topic", maxTokens: 500 })
    );
    assert.ok(ctxDt < 100, `get_context ${ctxDt}ms >= 100ms`);

    const profDt = minLatency(() => getProfileHandler());
    assert.ok(profDt < 20, `get_profile ${profDt}ms >= 20ms`);

    const histDt = minLatency(() => searchHistoryHandler({ query: "benchmark" }));
    assert.ok(histDt < 30, `search_history ${histDt}ms >= 30ms`);

    console.error(
      `[perf-bench] retrieve=${retrieveDt}ms remember=${rememberDt}ms recall=${recallDt}ms ` +
        `get_context=${ctxDt}ms get_profile=${profDt}ms search_history=${histDt}ms`
    );

    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await import("node:fs").then((fs) =>
          fs.rmSync(`${dbPath}${suffix}`, { force: true })
        );
      } catch {}
    }
  }
);
