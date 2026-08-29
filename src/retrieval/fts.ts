import { db, buildFtsMatch } from "../db/index.js";

export interface RankedId {
  id: number;
  rank: number;
}

export function ftsSearch(
  query: string,
  opts: {
    limit?: number;
    projectId?: string | null;
    includeArchived?: boolean;
  } = {}
): RankedId[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const statusClause = opts.includeArchived
    ? ""
    : "AND m.status NOT IN ('deleted','archived')";
  const projectClause = opts.projectId
    ? "AND (m.project_id = @projectId OR m.project_id IS NULL)"
    : "";
  const rows = db
    .prepare(
      `SELECT m.id FROM memories m
       JOIN search_index ON search_index.ref_table = 'memories' AND search_index.ref_id = m.id
       WHERE search_index MATCH @match ${statusClause} ${projectClause}
       ORDER BY rank
       LIMIT @limit`
    )
    .all({
      match: buildFtsMatch(query),
      limit,
      projectId: opts.projectId,
    }) as Array<{ id: number }>;
  return rows.map((r, i) => ({ id: r.id, rank: i + 1 }));
}
