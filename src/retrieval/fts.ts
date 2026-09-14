import { db, buildFtsMatch } from "../db/index.js";
import { resolveUserId } from "../db/repositories/users.js";

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
  const uid = opts.userId == null ? null : resolveUserId(opts.userId);
  const sid = opts.sessionId ?? null;
  const pid = opts.projectId ?? null;
  const rows = db
    .prepare(
      `SELECT m.id, m.scope, m.project_id, m.session_id, m.user_id FROM memories m
       JOIN search_index ON search_index.ref_table = 'memories' AND search_index.ref_id = m.id
       WHERE search_index MATCH @match ${statusClause}
         AND (
           m.scope = 'GLOBAL'
           OR (m.scope = 'USER' AND @uid IS NOT NULL AND m.user_id = @uid)
           OR (m.scope = 'SESSION' AND @sid IS NOT NULL AND m.session_id = @sid)
           OR (m.scope = 'PROJECT' AND @pid IS NOT NULL AND m.project_id = @pid)
         )
       ORDER BY rank
       LIMIT @limit`
    )
    .all({
      match: buildFtsMatch(query),
      limit,
      uid,
      sid,
      pid,
    }) as Array<{
      id: number;
      scope: string;
      project_id: string | null;
      session_id: string | null;
      user_id: number | null;
    }>;
  return rows.map((r, i) => ({ id: r.id, rank: i + 1 }));
}
