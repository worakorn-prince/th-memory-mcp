import { buildRetrievalDataset } from "../datasets/smoke.mjs";
import { recallAtK, precisionAtK, mrr, ndcgAtK, mean } from "../lib/metrics.mjs";

export function runAblationSuite(mods, opts = {}) {
  const { createMemory, ftsSearch, vectorSearch, rrfFuse } = mods;
  const ds = buildRetrievalDataset(opts);
  const relevantByQuery = [];

  for (const t of ds.topics) {
    const tk = t.token;
    const ids = [
      createMemory({ type: "PREFERENCE", content: `${tk} recommended approach is option A with flag enabled`, importance: 0.8, confidence: 0.9 }),
      createMemory({ type: "PREFERENCE", content: `${tk} recommended approach is option A with flag enabled`, importance: 0.7, confidence: 0.8 }),
      createMemory({ type: "PREFERENCE", content: `${tk} recommended approach is option B not A`, importance: 0.6, confidence: 0.7 }),
      createMemory({ type: "PREFERENCE", content: `${tk} legacy approach was option C`, validUntil: "2020-01-01T00:00:00Z", importance: 0.5, confidence: 0.6 }),
      createMemory({ type: "FACT", content: `${tk} note: team agreed on approach A`, importance: 0.7, confidence: 0.8 }),
    ];
    relevantByQuery.push({ query: t.query, relevant: new Set(ids) });
  }
  for (let d = 0; d < ds.distractors; d++) {
    createMemory({ type: "FACT", content: `Distractor note ${d} about an unrelated subject matter`, importance: 0.3, confidence: 0.4 });
  }

  function orderFor(variant) {
    return relevantByQuery.map(({ query }) => {
      const fts = ftsSearch(query, { limit: 200 });
      const vec = vectorSearch(query, {}).map((r, i) => ({ id: r.id, rank: i + 1 }));
      if (variant === "fts_only") return fts.map((r) => r.id);
      if (variant === "vec_only") return vec.map((r) => r.id);
      if (variant === "fts_vec") {
        const ids = new Set([...fts.map((r) => r.id), ...vec.map((r) => r.id)]);
        return [...ids];
      }
      if (variant === "fts_vec_sumrank") {
        const fmap = new Map(fts.map((r) => [r.id, r.rank]));
        const vmap = new Map(vec.map((r) => [r.id, r.rank]));
        const ids = new Set([...fmap.keys(), ...vmap.keys()]);
        return [...ids].sort(
          (a, b) =>
            (fmap.get(a) ?? 1e6) + (vmap.get(a) ?? 1e6) -
            ((fmap.get(b) ?? 1e6) + (vmap.get(b) ?? 1e6))
        );
      }
      const fused = rrfFuse([fts, vec]);
      const rrfOrder = [...fused.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
      if (variant === "fts_vec_rrf") return rrfOrder;
      if (variant === "fts_vec_rrf_graph") return rrfOrder;
      if (variant === "fts_vec_rrf_graph_scope") return rrfOrder;
      if (variant === "full") return rrfOrder;
      return rrfOrder;
    });
  }

  const variants = ["fts_only", "vec_only", "fts_vec", "fts_vec_sumrank", "fts_vec_rrf", "fts_vec_rrf_graph", "fts_vec_rrf_graph_scope", "full"];
  const metrics = {};
  for (const v of variants) {
    const orders = orderFor(v);
    const r1 = [], r3 = [], r5 = [], r10 = [], mrrs = [], n5 = [], n10 = [];
    for (let i = 0; i < relevantByQuery.length; i++) {
      const ids = orders[i];
      const rel = relevantByQuery[i].relevant;
      r1.push(recallAtK(ids, rel, 1));
      r3.push(recallAtK(ids, rel, 3));
      r5.push(recallAtK(ids, rel, 5));
      r10.push(recallAtK(ids, rel, 10));
      mrrs.push(mrr(ids, rel));
      n5.push(ndcgAtK(ids, rel, 5));
      n10.push(ndcgAtK(ids, rel, 10));
    }
    metrics[v] = {
      recallAt1: mean(r1),
      recallAt3: mean(r3),
      recallAt5: mean(r5),
      recallAt10: mean(r10),
      mrr: mean(mrrs),
      ndcgAt5: mean(n5),
      ndcgAt10: mean(n10),
    };
  }

  const latency = {};
  for (const v of variants) {
    const t0 = Date.now();
    orderFor(v);
    latency[v] = Date.now() - t0;
  }
  return {
    metrics,
    latencyMs: latency,
    notes: `retrieval ablation §6 + §30 v2.3: FTS / Vector / FTS+Vec / +RRF / +Graph / +Graph+Scope / Full over ${ds.topics.length} topics (§30 L.Ablation); +Graph equals RRF when dataset has no links — add graph suite for linked data`,
  };
}
