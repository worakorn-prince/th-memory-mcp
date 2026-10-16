import { db } from "../db/index.js";
import { embed, cosine, deserialize } from "../lib/embed.js";
import { resolveUserId } from "../db/repositories/users.js";
import { buildScopeClause } from "../lib/scope.js";

export function vectorSearch(
  query: string,
  opts: {
    limit?: number;
    projectId?: string | null;
    sessionId?: string | null;
    userId?: string | null;
    includeArchived?: boolean;
    floor?: number;
  } = {}
): Array<{ id: number; score: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const floor = opts.floor ?? 0.15;
  const topicVec = embed(query);
  const uid = opts.userId ? resolveUserId(opts.userId) : null;
  // Scope predicate lives INSIDE SQL (canonical form shared with fts.ts and
  // getScopedEmbeds via lib/scope), so out-of-scope embeddings never enter
  // scoring. All bindings are named parameters — no positional `?` mixing.
  const scope = buildScopeClause("m", {
    resolvedUid: uid,
    sessionId: opts.sessionId,
    projectId: opts.projectId,
  });
  const rows = db
    .prepare(
      `SELECT e.ref_id as id, e.vec as vec
       FROM embeddings e
       JOIN memories m ON m.id = e.ref_id
       WHERE e.ref_table = 'memories'
         AND (@includeArchived OR m.status NOT IN ('deleted','archived','superseded'))
         AND ${scope.sql}`
    )
    .all({
      includeArchived: opts.includeArchived ? 1 : 0,
      ...scope.params,
    }) as Array<{
    id: number;
    vec: Buffer;
  }>;
  return rows
    .map((r) => ({ id: r.id, score: cosine(topicVec, deserialize(r.vec)) }))
    .filter((r) => r.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
