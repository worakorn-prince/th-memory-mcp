import { buildGraphDataset } from "../datasets/smoke.mjs";
import { recallAtK, precisionAtK, mrr, ndcgAtK, mean } from "../lib/metrics.mjs";

export function runGraphSuite(mods, opts = {}) {
  const { createMemory, getContext, linkMemoryHandler } = mods;
  const scenarios = opts.scenarios ?? 100;
  const K = opts.k ?? 10;
  const seed = opts.seed ?? 42;
  const ds = buildGraphDataset({ scenarios, seed });
  const chainIdsList = [];
  const allRelevantIds = [];
  for (const sc of ds.scenarios) {
    const ids = [];
    for (let h = 0; h < sc.chain.length; h++) {
      const name = sc.chain[h];
      const id = createMemory({
        type: "FACT",
        content: `${name} decision for scenario ${sc.id} hop ${h}: context about ${name} and its dependency`,
        importance: 0.85,
        confidence: 0.9,
      });
      ids.push(id);
      allRelevantIds.push(id);
    }
    for (let i = 1; i < ids.length; i++) {
      try {
        linkMemoryHandler({ sourceId: ids[i - 1], targetId: ids[i], relation: sc.relations[i - 1] });
      } catch {}
    }
    chainIdsList.push({ sc, ids });
  }
  for (let d = 0; d < 100; d++) {
    createMemory({
      type: "FACT",
      content: `Graph distractor ${d} unrelated filler about something else`,
      importance: 0.2,
      confidence: 0.3,
    });
  }
  const r1 = [], r3 = [], r5 = [], r10 = [], p1 = [], p3 = [], p5 = [], p10 = [], mrrs = [], n5 = [], n10 = [];
  const hop1 = [], hop2 = [], hop3 = [];
  let noiseSum = 0;
  for (const { sc, ids } of chainIdsList) {
    const relevant = new Set(ids);
    const query = sc.query;
    const res = getContext({ query, limit: K, maxTokens: 2048, includeGraph: true });
    const retrieved = res.memories.map((m) => m.id);
    r1.push(recallAtK(retrieved, relevant, 1));
    r3.push(recallAtK(retrieved, relevant, 3));
    r5.push(recallAtK(retrieved, relevant, 5));
    r10.push(recallAtK(retrieved, relevant, 10));
    p1.push(precisionAtK(retrieved, relevant, 1));
    p3.push(precisionAtK(retrieved, relevant, 3));
    p5.push(precisionAtK(retrieved, relevant, 5));
    p10.push(precisionAtK(retrieved, relevant, 10));
    mrrs.push(mrr(retrieved, relevant));
    n5.push(ndcgAtK(retrieved, relevant, 5));
    n10.push(ndcgAtK(retrieved, relevant, 10));
    const noise = retrieved.length ? (retrieved.length - retrieved.filter((id) => relevant.has(id)).length) / retrieved.length : 0;
    noiseSum += noise;
    if (ids.length > 1) hop1.push(retrieved.includes(ids[1]) ? 1 : 0);
    if (ids.length > 2) hop2.push(retrieved.includes(ids[2]) ? 1 : 0);
    if (ids.length > 3) hop3.push(retrieved.includes(ids[3]) ? 1 : 0);
  }
  return {
    metrics: {
      scenarios,
      recallAt1: mean(r1),
      recallAt3: mean(r3),
      recallAt5: mean(r5),
      recallAt10: mean(r10),
      precisionAt1: mean(p1),
      precisionAt3: mean(p3),
      precisionAt5: mean(p5),
      precisionAt10: mean(p10),
      mrr: mean(mrrs),
      ndcgAt5: mean(n5),
      ndcgAt10: mean(n10),
      hop1Accuracy: hop1.length ? mean(hop1) : 0,
      hop2Accuracy: hop2.length ? mean(hop2) : 0,
      hop3Accuracy: hop3.length ? mean(hop3) : 0,
      graphNoiseRatio: noiseSum / chainIdsList.length,
    },
    notes: `graph §10 (§15-17 v2.3): ${scenarios} scenarios 5-20 nodes 1-3 hops over 7 relations, via get_context with graph expansion`,
  };
}
