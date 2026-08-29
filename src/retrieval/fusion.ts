export interface Ranked {
  id: number;
  rank: number;
}

// Reciprocal Rank Fusion (spec §13.1): RRF(m) = Σ 1 / (k + rank_i(m))
export function rrfFuse(lists: Ranked[][], k = 60): Map<number, number> {
  const scores = new Map<number, number>();
  for (const list of lists) {
    for (const item of list) {
      const rrf = 1 / (k + item.rank);
      scores.set(item.id, (scores.get(item.id) ?? 0) + rrf);
    }
  }
  return scores;
}
