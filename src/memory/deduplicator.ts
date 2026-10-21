import { embed, cosine, deserialize, EMBED_DIM } from "../lib/embed.js";
import { db } from "../db/index.js";
import { buildScopeClause } from "../lib/scope.js";

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

// SEC-09: dedup is scoped. Default (all null) is fail-closed: only GLOBAL
// memories are considered. Callers pass the effective item/caller scope.
export interface DedupScope {
  resolvedUid?: number | null;
  sessionId?: string | null;
  projectId?: string | null;
}

// Exact / normalized match on content within the same type and visible scope.
export function findExactMatch(
  type: string,
  content: string,
  scope: DedupScope = {}
): number | undefined {
  const norm = normalizeText(content);
  const clause = buildScopeClause("m", scope);
  const rows = db
    .prepare(
      `SELECT m.id AS id, m.content AS content
       FROM memories m
       WHERE m.type = @type AND m.status != 'deleted' AND ${clause.sql}`
    )
    .all({ type, ...clause.params }) as Array<{ id: number; content: string }>;
  for (const r of rows) {
    if (normalizeText(r.content) === norm) return r.id;
  }
  return undefined;
}

// Semantic similarity against existing memories of the same type and scope.
// Single-query JOIN (no N+1): type/status/scope filtering happens in SQL,
// then an in-memory candidate prefilter skips corrupt/empty vectors
// before the expensive deserialize+cosine comparison.
export function findSimilar(
  type: string,
  content: string,
  threshold = 0.82,
  scope: DedupScope = {}
): { id: number; score: number } | undefined {
  const vec = embed(content);
  const clause = buildScopeClause("m", scope);
  const rows = db
    .prepare(
      `SELECT e.ref_id AS ref_id, e.vec AS vec
       FROM embeddings e
       JOIN memories m ON m.id = e.ref_id
       WHERE e.ref_table = 'memories'
         AND m.type = @type
         AND m.status != 'deleted'
         AND ${clause.sql}`
    )
    .all({ type, ...clause.params }) as Array<{ ref_id: number; vec: Buffer }>;
  // Candidate prefilter (in-memory, cheap): drop rows whose vector blob
  // cannot be a valid EMBED_DIM float32 vector before deserialize/cosine.
  const expectedBytes = EMBED_DIM * 4;
  const candidates = rows.filter((r) => {
    const buf = r.vec as unknown as { byteLength?: number; length?: number };
    const len =
      typeof buf?.byteLength === "number"
        ? buf.byteLength
        : typeof buf?.length === "number"
          ? buf.length
          : 0;
    return len === expectedBytes;
  });
  let best: { id: number; score: number } | undefined;
  for (const r of candidates) {
    const score = cosine(vec, deserialize(r.vec));
    if (score >= threshold && (!best || score > best.score)) {
      best = { id: r.ref_id, score };
    }
  }
  return best;
}

export function deduplicate(
  type: string,
  content: string,
  scope: DedupScope = {}
): DupResult {
  const exact = findExactMatch(type, content, scope);
  if (exact !== undefined)
    return { verdict: "duplicate", existingId: exact, score: 1 };
  const sim = findSimilar(type, content, 0.82, scope);
  if (sim) return { verdict: "duplicate", existingId: sim.id, score: sim.score };
  return { verdict: "distinct", score: 0 };
}
