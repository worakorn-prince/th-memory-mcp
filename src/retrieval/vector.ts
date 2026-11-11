import type BetterSqlite3 from "better-sqlite3";
import { db, getEmbeddingsByKeys, withVectorSnapshot } from "../db/index.js";
import { embed, cosine, deserialize } from "../lib/embed.js";
import { resolveUserId } from "../db/repositories/users.js";
import { buildScopeClause } from "../lib/scope.js";
import {
  getVector,
  isVectorCacheEnabled,
  vectorKey,
} from "./vector-cache.js";

// One SQL body, two projections: the full-BLOB read (cache disabled) and the
// ids-only read must return the same rows in the same order. The scoring sort
// is stable, so equally-scored rows keep read order and a tie at the `limit`
// boundary picks whoever came first. Row order must therefore be explicit:
// after ANALYZE, SQLite may satisfy these predicates with a covering-index
// SEARCH in ref_id order or a SCAN in rowid order, and (ref_table, ref_id) is
// the primary key, so `ORDER BY e.ref_id` is both deterministic and free for
// the ids-only statement.
const VECTOR_ROWS_SQL = (projection: string): string => `
  SELECT ${projection}
    FROM embeddings e
    JOIN memories m ON m.id = e.ref_id
   WHERE e.ref_table = 'memories'
     AND (@includeArchived OR m.status NOT IN ('deleted','archived','superseded'))
     AND ${buildScopeClause("m").sql}
   ORDER BY e.ref_id`;

let _allVectors: BetterSqlite3.Statement | null = null;
function getAllVectors(): BetterSqlite3.Statement {
  return (_allVectors ??= db.prepare(
    VECTOR_ROWS_SQL("e.ref_id as id, e.vec as vec")
  ));
}
let _vectorIds: BetterSqlite3.Statement | null = null;
function getVectorIds(): BetterSqlite3.Statement {
  return (_vectorIds ??= db.prepare(VECTOR_ROWS_SQL("e.ref_id as id")));
}

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
  const params = {
    includeArchived: opts.includeArchived ? 1 : 0,
    ...scope.params,
  };

  // TASK-PERF-READ: cache disabled -> the historical read shape (BLOB per row,
  // token-by-token decode) so the opt-out path is byte-for-byte today's code.
  if (!isVectorCacheEnabled()) {
    const rows = getAllVectors().all(params) as Array<{
      id: number;
      vec: Buffer;
    }>;
    return rows
      .map((r) => ({ id: r.id, score: cosine(topicVec, deserialize(r.vec)) }))
      .filter((r) => r.score >= floor)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  // Cached path: ids only, then resolve decoded vectors; misses are filled by
  // one batched point-read (chunks of EMBED_FETCH_CHUNK). Row order is the same
  // SQL order as before, so the stable sort keeps the same tie order. The
  // fetched map is also the fallback for entries the cache had to evict (a
  // budget below one vector must still score every row).
  //
  // The ids read and the miss fill are two statements, so they run inside one
  // deferred snapshot: another process writing the same DB file between them
  // could otherwise delete an id after it was listed (the row is silently
  // skipped) or reuse its rowid for a new ref (the wrong vector is scored).
  const { entries, kept, fetched } = withVectorSnapshot(() => {
    const rows = getVectorIds().all(params) as Array<{ id: number }>;
    // Build each key once per row and resolve the cached vector in the same
    // pass: re-deriving the key in the scoring pass (and touching the Map
    // twice) was most of the per-row overhead at 20k rows. A hit is held by
    // reference, so an eviction during the batched fill cannot change what
    // gets scored.
    const entries = rows.map((r) => ({
      id: r.id,
      key: vectorKey("memories", r.id),
    }));
    const kept = entries.map((e) => getVector(e.key));
    const missing: number[] = [];
    for (let i = 0; i < entries.length; i++) {
      if (!kept[i]) missing.push(entries[i]!.id);
    }
    const fetched =
      missing.length > 0
        ? getEmbeddingsByKeys(
            missing.map((id) => ({ ref_table: "memories", ref_id: id }))
          )
        : null;
    return { entries, kept, fetched };
  });
  const scored: Array<{ id: number; score: number }> = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const vec = kept[i] ?? fetched?.get(e.key);
    if (!vec) continue;
    scored.push({ id: e.id, score: cosine(topicVec, vec) });
  }
  return scored
    .filter((r) => r.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
