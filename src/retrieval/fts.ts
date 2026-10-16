import { db, buildFtsMatch } from "../db/index.js";
import { resolveUserId } from "../db/repositories/users.js";
import { buildScopeClause } from "../lib/scope.js";

export interface RankedId {
  id: number;
  rank: number;
}

export function ftsSearch(
  query: string,
  opts: {
    limit?: number;
    projectId?: string | null;
    sessionId?: string | null;
    userId?: string | null;
    includeArchived?: boolean;
  } = {}
): RankedId[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const statusClause = opts.includeArchived
    ? ""
    : "AND m.status NOT IN ('deleted','archived','superseded')";
  // Batch A-4: scope predicate lives INSIDE SQL (not JS post-filter), so
  // LIMIT applies after scope filtering. The old code did LIMIT-then-filter:
  // out-of-scope rows could fill the LIMIT window and starve in-scope hits.
  // P1-A: the predicate is now the shared clause from lib/scope.ts.
  const uid = opts.userId == null ? null : resolveUserId(opts.userId);
  const scope = buildScopeClause("m", {
    resolvedUid: uid,
    sessionId: opts.sessionId,
    projectId: opts.projectId,
  });
  const rows = db
    .prepare(
      `SELECT m.id, m.scope, m.project_id, m.session_id, m.user_id FROM memories m
       JOIN search_index ON search_index.ref_table = 'memories' AND search_index.ref_id = m.id
       WHERE search_index MATCH @match ${statusClause}
         AND ${scope.sql}
       ORDER BY rank
       LIMIT @limit`
    )
    .all({
      match: buildFtsMatch(query),
      limit,
      ...scope.params,
    }) as Array<{
      id: number;
      scope: string;
      project_id: string | null;
      session_id: string | null;
      user_id: number | null;
    }>;
  return rows.map((r, i) => ({ id: r.id, rank: i + 1 }));
}
