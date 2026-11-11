import type BetterSqlite3 from "better-sqlite3";
import {
  db,
  getEmbeddingsByKeys,
  withVectorSnapshot,
  type EmbeddingKey,
} from "../db/index.js";
import { embed, cosine, deserialize } from "../lib/embed.js";
import { resolveUserId } from "../db/repositories/users.js";
import { buildScopeClause } from "../lib/scope.js";
import {
  accumulateScores,
  ensureVectors,
  isVectorCacheEnabled,
  patchVectorSlots,
  vectorKey,
  withVectorQuery,
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

  // Cached path (TASK-PERF-MATRIX): ids only, resolve their slots in the
  // contiguous matrix, fill the misses with one batched point-read (chunks of
  // EMBED_FETCH_CHUNK), then score every live slot in a single linear pass over
  // the matrix. Rows are read and scored in the same SQL order as the
  // full-BLOB statement, so the stable sort keeps the same tie order.
  //
  // The ids read and the miss fill are two statements, so they run inside one
  // deferred snapshot: another process writing the same DB file between them
  // could otherwise delete an id after it was listed (the row is silently
  // skipped) or reuse its rowid for a new ref (the wrong vector is scored). The
  // whole sequence is also one cache query, so the bucket the slots point into
  // cannot be evicted between the resolution and the scoring pass.
  return withVectorQuery(["memories"], () => {
    const { ids, slots, fetched } = withVectorSnapshot(() => {
      const rows = getVectorIds().all(params) as Array<{ id: number }>;
      const ids = new Int32Array(rows.length);
      for (let i = 0; i < rows.length; i++) ids[i] = rows[i]!.id;
      const slots = ensureVectors("memories", ids);
      let missing = 0;
      for (let i = 0; i < ids.length; i++) if (slots[i]! < 0) missing++;
      let fetched: Map<string, Float32Array> | null = null;
      if (missing > 0) {
        const keys: EmbeddingKey[] = [];
        for (let i = 0; i < ids.length; i++) {
          if (slots[i]! < 0) keys.push({ ref_table: "memories", ref_id: ids[i]! });
        }
        fetched = getEmbeddingsByKeys(keys);
        patchVectorSlots("memories", ids, slots);
      }
      return { ids, slots, fetched };
    });

    const scores = accumulateScores("memories", topicVec);
    const scored: Array<{ id: number; score: number }> = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]!;
      const slot = slots[i]!;
      if (slot >= 0 && scores) {
        scored.push({ id, score: scores[slot]! });
        continue;
      }
      // Not resident: either the database has no vector for the row, or the
      // bucket is at its capacity cap (a table larger than one bucket may hold).
      // Score from the vector the fill already fetched, exactly as the
      // cache-disabled path does, so an over-cap row is never dropped.
      const vec = fetched?.get(vectorKey("memories", id));
      if (!vec) continue;
      scored.push({ id, score: cosine(topicVec, vec) });
    }
    return scored
      .filter((r) => r.score >= floor)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  });
}
