export function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = (sortedArr.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (idx - lo);
}

export function summarizeLatencies(arrMs) {
  const s = [...arrMs].sort((a, b) => a - b);
  const sum = s.reduce((a, b) => a + b, 0);
  return {
    min: s[0],
    mean: sum / s.length,
    median: percentile(s, 0.5),
    p50: percentile(s, 0.5),
    p95: percentile(s, 0.95),
    p99: percentile(s, 0.99),
    max: s[s.length - 1],
    n: s.length,
  };
}

export function recallAtK(retrievedIds, relevantSet, k) {
  const top = retrievedIds.slice(0, k);
  const rel = top.filter((id) => relevantSet.has(id)).length;
  return relevantSet.size === 0 ? 0 : rel / relevantSet.size;
}

export function precisionAtK(retrievedIds, relevantSet, k) {
  const top = retrievedIds.slice(0, k);
  const rel = top.filter((id) => relevantSet.has(id)).length;
  return k === 0 ? 0 : rel / k;
}

export function mrr(retrievedIds, relevantSet) {
  for (let rank = 0; rank < retrievedIds.length; rank++) {
    if (relevantSet.has(retrievedIds[rank])) return 1 / (rank + 1);
  }
  return 0;
}

export function ndcgAtK(retrievedIds, relevantSet, k) {
  const top = retrievedIds.slice(0, k);
  let dcg = 0;
  for (let i = 0; i < top.length; i++) {
    const rel = relevantSet.has(top[i]) ? 1 : 0;
    dcg += rel / Math.log2(i + 2);
  }
  const ideal = Math.min(k, relevantSet.size);
  let idcg = 0;
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

export function tokenEstimate(text) {
  return Math.max(1, Math.ceil((text || "").length / 4));
}

export function mean(nums) {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
