process.env.MEMORY_DB_PATH = path.join(
  os.tmpdir(),
  `th-mem-rb-${Date.now()}.db`
);

import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Retrieval quality benchmark (spec §26).
// Baseline dataset: >=500 memories, each topic has 5 relevant memories (canonical,
// duplicate, contradiction, temporal-expired, related note) sharing a unique token,
// plus 100 unrelated distractors. Measures Recall@5 / Precision@5 / MRR against the
// §26 acceptance targets (Recall@5 >= 0.90, Precision@5 >= 0.85, MRR >= 0.85).

test(
  "retrieval quality benchmark meets §26 targets",
  { timeout: 60000 },
  async () => {
    const { createMemory } = await import(
      "../dist/db/repositories/memories.js"
    );
    const { retrieve } = await import("../dist/core/retrieval-engine.js");

    const N_TOPICS = 120;
    const K5 = 5;
    const K10 = 10;
    const relevant = [];

    for (let i = 0; i < N_TOPICS; i++) {
      const tk = `TK${i}`;
      const ids = [
        createMemory({
          type: "PREFERENCE",
          content: `${tk} recommended approach is option A with flag enabled`,
          importance: 0.8,
          confidence: 0.9,
        }),
        createMemory({
          type: "PREFERENCE",
          content: `${tk} recommended approach is option A with flag enabled`,
          importance: 0.7,
          confidence: 0.8,
        }),
        createMemory({
          type: "PREFERENCE",
          content: `${tk} recommended approach is option B not A`,
          importance: 0.6,
          confidence: 0.7,
        }),
        createMemory({
          type: "PREFERENCE",
          content: `${tk} legacy approach was option C`,
          validUntil: "2020-01-01T00:00:00Z",
          importance: 0.5,
          confidence: 0.6,
        }),
        createMemory({
          type: "FACT",
          content: `${tk} note: team agreed on approach A`,
          importance: 0.7,
          confidence: 0.8,
        }),
      ];
      relevant.push({ query: `${tk} approach`, ids: new Set(ids) });
    }

    for (let d = 0; d < 100; d++) {
      createMemory({
        type: "FACT",
        content: `Distractor note ${d} about an unrelated subject matter`,
        importance: 0.3,
        confidence: 0.4,
      });
    }

    let recall5 = 0;
    let recall10 = 0;
    let prec5num = 0;
    let mrrSum = 0;
    const N = relevant.length;

    for (const { query, ids } of relevant) {
      const res = retrieve(query, { limit: K10 });
      const top5 = res.slice(0, K5).map((r) => r.id);
      const top10 = res.map((r) => r.id);
      const rel5 = top5.filter((id) => ids.has(id)).length;
      const rel10 = top10.filter((id) => ids.has(id)).length;
      if (rel5 > 0) recall5++;
      if (rel10 > 0) recall10++;
      prec5num += rel5;
      let firstRank = Infinity;
      for (let rank = 0; rank < top10.length; rank++) {
        if (ids.has(top10[rank])) {
          firstRank = rank + 1;
          break;
        }
      }
      mrrSum += firstRank === Infinity ? 0 : 1 / firstRank;
    }

    const R5 = recall5 / N;
    const R10 = recall10 / N;
    const P5 = prec5num / (K5 * N);
    const MRR = mrrSum / N;
    console.error(
      `[retrieval-bench] dataset=${N_TOPICS * 5 + 100} memories | Recall@5=${R5.toFixed(
        3
      )} Recall@10=${R10.toFixed(3)} Precision@5=${P5.toFixed(3)} MRR=${MRR.toFixed(3)}`
    );

    assert.ok(R5 >= 0.9, `Recall@5 ${R5.toFixed(3)} < 0.90`);
    assert.ok(P5 >= 0.85, `Precision@5 ${P5.toFixed(3)} < 0.85`);
    assert.ok(MRR >= 0.85, `MRR ${MRR.toFixed(3)} < 0.85`);

    const { db } = await import("../dist/db/index.js");
    db.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.rmSync(`${process.env.MEMORY_DB_PATH}${suffix}`, { force: true });
      } catch {}
    }
  }
);
