import { buildSemanticHardDataset } from "../datasets/smoke.mjs";
import { recallAtK, precisionAtK, mrr, ndcgAtK, mean } from "../lib/metrics.mjs";

export function runSemanticHardSuite(mods, opts = {}) {
  const { createMemory, retrieve } = mods;
  const topics = opts.topics ?? 100;
  const distractorsPerTopic = opts.distractors ?? 100;
  const K = opts.k ?? 10;
  const seed = opts.seed ?? 42;
  const ds = buildSemanticHardDataset({ topics, distractors: distractorsPerTopic, seed });
  const N = ds.topics.length;
  const relevantByQuery = [];
  for (const t of ds.topics) {
    const ids = [];
    for (let v = 0; v < 5; v++) {
      const content = `${t.memoryTemplate} variant ${v}`;
      const id = createMemory({
        type: "FACT",
        content,
        importance: 0.8,
        confidence: 0.9,
      });
      ids.push(id);
    }
    relevantByQuery.push({ query: t.query, category: t.category, relevant: new Set(ids), id: t.id });
  }
  const totalDistractors = N * distractorsPerTopic;
  for (let d = 0; d < totalDistractors; d++) {
    createMemory({
      type: "FACT",
      content: `Distractor filler ${d} about unrelated topic ${(d * 997) % 10000}`,
      importance: 0.2,
      confidence: 0.3,
    });
  }
  const byCategory = {};
  for (const c of ds.categories) byCategory[c] = { r1: [], r3: [], r5: [], r10: [], p1: [], p3: [], p5: [], p10: [], mrrs: [], n5: [], n10: [] };
  const all = { r1: [], r3: [], r5: [], r10: [], p1: [], p3: [], p5: [], p10: [], mrrs: [], n5: [], n10: [] };
  for (const { query, relevant, category } of relevantByQuery) {
    const res = retrieve(query, { limit: K });
    const ids = res.map((r) => r.id);
    const vals = {
      r1: recallAtK(ids, relevant, 1),
      r3: recallAtK(ids, relevant, 3),
      r5: recallAtK(ids, relevant, 5),
      r10: recallAtK(ids, relevant, 10),
      p1: precisionAtK(ids, relevant, 1),
      p3: precisionAtK(ids, relevant, 3),
      p5: precisionAtK(ids, relevant, 5),
      p10: precisionAtK(ids, relevant, 10),
      m: mrr(ids, relevant),
      n5: ndcgAtK(ids, relevant, 5),
      n10: ndcgAtK(ids, relevant, 10),
    };
    all.r1.push(vals.r1); all.r3.push(vals.r3); all.r5.push(vals.r5); all.r10.push(vals.r10);
    all.p1.push(vals.p1); all.p3.push(vals.p3); all.p5.push(vals.p5); all.p10.push(vals.p10);
    all.mrrs.push(vals.m); all.n5.push(vals.n5); all.n10.push(vals.n10);
    const cat = byCategory[category];
    cat.r1.push(vals.r1); cat.r3.push(vals.r3); cat.r5.push(vals.r5); cat.r10.push(vals.r10);
    cat.p1.push(vals.p1); cat.p3.push(vals.p3); cat.p5.push(vals.p5); cat.p10.push(vals.p10);
    cat.mrrs.push(vals.m); cat.n5.push(vals.n5); cat.n10.push(vals.n10);
  }
  const agg = {
    dataset: N * 5 + totalDistractors,
    topics: N,
    distractorsPerTopic,
    totalDistractors,
    recallAt1: mean(all.r1),
    recallAt3: mean(all.r3),
    recallAt5: mean(all.r5),
    recallAt10: mean(all.r10),
    precisionAt1: mean(all.p1),
    precisionAt3: mean(all.p3),
    precisionAt5: mean(all.p5),
    precisionAt10: mean(all.p10),
    mrr: mean(all.mrrs),
    ndcgAt5: mean(all.n5),
    ndcgAt10: mean(all.n10),
  };
  const byCatMetrics = {};
  for (const [cat, v] of Object.entries(byCategory)) {
    if (v.r1.length === 0) continue;
    byCatMetrics[cat] = {
      count: v.r1.length,
      recallAt1: mean(v.r1),
      recallAt3: mean(v.r3),
      recallAt5: mean(v.r5),
      recallAt10: mean(v.r10),
      precisionAt1: mean(v.p1),
      precisionAt5: mean(v.p5),
      mrr: mean(v.mrrs),
      ndcgAt5: mean(v.n5),
      ndcgAt10: mean(v.n10),
    };
  }
  return {
    metrics: agg,
    byCategory: byCatMetrics,
    notes: `semantic-hard §7-9: ${N} topics ×5 relevant + ${totalDistractors} distractors (${distractorsPerTopic}/topic) over 8 categories`,
  };
}
