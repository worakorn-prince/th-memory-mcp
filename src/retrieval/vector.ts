import { db } from "../db/index.js";
import { embed, cosine, deserialize } from "../lib/embed.js";
import { resolveUserId } from "../db/repositories/users.js";

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
  const rows = db
    .prepare(
      `SELECT e.ref_id as id, e.vec as vec, m.status, m.scope, m.project_id, m.session_id, m.user_id
       FROM embeddings e
       JOIN memories m ON m.id = e.ref_id
       WHERE e.ref_table = 'memories'
         AND ( ? OR m.status NOT IN ('deleted','archived','superseded'))`
    )
    .all(opts.includeArchived ? 1 : 0) as Array<{
    id: number;
    vec: Buffer;
    status: string;
    scope: string;
    project_id: string | null;
    session_id: string | null;
    user_id: number | null;
  }>;
  const uid = opts.userId ? resolveUserId(opts.userId) : null;
  return rows
    .filter((r) => {
      if (r.scope === "USER") {
        if (opts.userId == null) return false;
        return r.user_id === uid;
      }
      if (r.scope === "SESSION") {
        if (opts.sessionId == null) return false;
        return r.session_id === opts.sessionId;
      }
      if (r.scope === "PROJECT") {
        if (opts.projectId == null) return false;
        return r.project_id === opts.projectId;
      }
      return true;
    })
    .map((r) => ({ id: r.id, score: cosine(topicVec, deserialize(r.vec)) }))
    .filter((r) => r.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
