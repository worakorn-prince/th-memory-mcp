import { db } from "../db/index.js";
import { embed, cosine, deserialize } from "../lib/embed.js";

export function vectorSearch(
  query: string,
  opts: {
    limit?: number;
    projectId?: string | null;
    includeArchived?: boolean;
    floor?: number;
  } = {}
): Array<{ id: number; score: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const floor = opts.floor ?? 0.15;
  const topicVec = embed(query);
  const rows = db
    .prepare("SELECT ref_id, vec FROM embeddings WHERE ref_table = 'memories'")
    .all() as Array<{ ref_id: number; vec: Buffer }>;
  const statusOk = (id: number): boolean => {
    const m = db
      .prepare("SELECT status, project_id FROM memories WHERE id = ?")
      .get(id) as
      | { status: string; project_id: string | null }
      | undefined;
    if (!m) return false;
    if (
      !opts.includeArchived &&
      (m.status === "deleted" || m.status === "archived")
    )
      return false;
    if (
      opts.projectId &&
      !(m.project_id === opts.projectId || m.project_id === null)
    )
      return false;
    return true;
  };
  return rows
    .map((r) => ({ id: r.ref_id, score: cosine(topicVec, deserialize(r.vec)) }))
    .filter((r) => r.score >= floor && statusOk(r.id))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
