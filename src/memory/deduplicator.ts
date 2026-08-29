import { embed, cosine, deserialize } from "../lib/embed.js";
import { db } from "../db/index.js";

export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .trim();
}

export type DupVerdict = "duplicate" | "distinct";

export interface DupResult {
  verdict: DupVerdict;
  existingId?: number;
  score: number;
}

// Exact / normalized match on content within the same type.
export function findExactMatch(
  type: string,
  content: string
): number | undefined {
  const norm = normalizeText(content);
  const rows = db
    .prepare(
      "SELECT id, content FROM memories WHERE type = ? AND status != 'deleted'"
    )
    .all(type) as Array<{ id: number; content: string }>;
  for (const r of rows) {
    if (normalizeText(r.content) === norm) return r.id;
  }
  return undefined;
}

// Semantic similarity against existing memories of the same type.
export function findSimilar(
  type: string,
  content: string,
  threshold = 0.82
): { id: number; score: number } | undefined {
  const vec = embed(content);
  const rows = db
    .prepare("SELECT ref_id, vec FROM embeddings WHERE ref_table = 'memories'")
    .all() as Array<{ ref_id: number; vec: Buffer }>;
  let best: { id: number; score: number } | undefined;
  for (const r of rows) {
    const m = db
      .prepare("SELECT type, status FROM memories WHERE id = ?")
      .get(r.ref_id) as { type: string; status: string } | undefined;
    if (!m || m.type !== type || m.status === "deleted") continue;
    const score = cosine(vec, deserialize(r.vec));
    if (score >= threshold && (!best || score > best.score)) {
      best = { id: r.ref_id, score };
    }
  }
  return best;
}

export function deduplicate(type: string, content: string): DupResult {
  const exact = findExactMatch(type, content);
  if (exact !== undefined)
    return { verdict: "duplicate", existingId: exact, score: 1 };
  const sim = findSimilar(type, content);
  if (sim) return { verdict: "duplicate", existingId: sim.id, score: sim.score };
  return { verdict: "distinct", score: 0 };
}
