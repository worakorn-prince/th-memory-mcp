import { buildRetrievalDataset } from "../datasets/smoke.mjs";
import {
  recallAtK,
  precisionAtK,
  mrr,
  ndcgAtK,
  mean,
} from "../lib/metrics.mjs";

export function runRetrievalSuite(mods, opts = {}) {
  const { createMemory, retrieve } = mods;
  const ds = buildRetrievalDataset(opts);
  const N_TOPICS = ds.topics.length;
  const K = opts.k || 10;

  const relevantByQuery = [];

  for (const t of ds.topics) {
    const tk = t.token;
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
    relevantByQuery.push({ query: t.query, relevant: new Set(ids) });
  }

  for (let d = 0; d < ds.distractors; d++) {
    createMemory({
      type: "FACT",
      content: `Distractor note ${d} about an unrelated subject matter`,
      importance: 0.3,
      confidence: 0.4,
    });
  }

  const r1 = [],
    r3 = [],
    r5 = [],
    r10 = [];
  const p1 = [],
    p3 = [],
    p5 = [],
    p10 = [];
  const mrrs = [];
  const n5 = [],
    n10 = [];

  for (const { query, relevant } of relevantByQuery) {
    const res = retrieve(query, { limit: K });
    const ids = res.map((r) => r.id);
    r1.push(recallAtK(ids, relevant, 1));
    r3.push(recallAtK(ids, relevant, 3));
    r5.push(recallAtK(ids, relevant, 5));
    r10.push(recallAtK(ids, relevant, 10));
    p1.push(precisionAtK(ids, relevant, 1));
    p3.push(precisionAtK(ids, relevant, 3));
    p5.push(precisionAtK(ids, relevant, 5));
    p10.push(precisionAtK(ids, relevant, 10));
    mrrs.push(mrr(ids, relevant));
    n5.push(ndcgAtK(ids, relevant, 5));
    n10.push(ndcgAtK(ids, relevant, 10));
  }

  const metrics = {
    dataset: N_TOPICS * 5 + ds.distractors,
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
  };

  return {
    metrics,
    notes: `Recall@K/Precision@K/MRR/NDCG over ${N_TOPICS} topics (5 relevant + ${ds.distractors} distractors)`,
  };
}
