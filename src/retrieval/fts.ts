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
  const rows = db
    .prepare(
      `SELECT m.id FROM memories m
       JOIN search_index ON search_index.ref_table = 'memories' AND search_index.ref_id = m.id
       WHERE search_index MATCH @match ${statusClause}
       ORDER BY rank
       LIMIT @limit`
    )
    .all({
      match: buildFtsMatch(query),
      limit,
    }) as Array<{ id: number }>;
  const filtered = rows.filter(({ id }) => {
    const m = db
      .prepare(
        "SELECT scope, project_id, session_id, user_id FROM memories WHERE id = ?"
      )
      .get(id) as
      | {
          scope: string;
          project_id: string | null;
          session_id: string | null;
          user_id: number | null;
        }
      | undefined;
    if (!m) return false;
    if (m.scope === "USER") {
      if (opts.userId == null) return false;
      const uid = resolveUserId(opts.userId as string);
      return m.user_id === uid;
    }
    if (m.scope === "SESSION") {
      if (opts.sessionId == null) return false;
      return m.session_id === opts.sessionId;
    }
    if (m.scope === "PROJECT") {
      if (opts.projectId == null) return false;
      return m.project_id === opts.projectId;
    }
    return true;
  });
  return filtered.map((r, i) => ({ id: r.id, rank: i + 1 }));
}
