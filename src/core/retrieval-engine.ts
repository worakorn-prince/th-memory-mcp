import { db } from "../db/index.js";
import { ftsSearch } from "../retrieval/fts.js";
import { vectorSearch } from "../retrieval/vector.js";
import { rrfFuse } from "../retrieval/fusion.js";
import { finalScore, scopeFactorFor } from "../retrieval/scorer.js";
import { recencyFactorFor } from "../memory/decay.js";
import type { MemoryRecord } from "../memory/types.js";

export interface RetrieveOptions {
  limit?: number;
  projectId?: string | null;
  sessionId?: string | null;
  includeArchived?: boolean;
  includeHistory?: boolean;
}

export interface RetrievedMemory extends MemoryRecord {
  rrf: number;
  final_score: number;
}

// Hybrid retrieval pipeline (spec §13): FTS + vector -> RRF fusion -> scoring/rerank -> filter -> topK
export function retrieve(
  query: string,
  opts: RetrieveOptions = {}
): RetrievedMemory[] {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const fts = ftsSearch(query, opts);
  const vecRaw = vectorSearch(query, opts);
  const vec: Array<{ id: number; rank: number }> = vecRaw.map((r, i) => ({
    id: r.id,
    rank: i + 1,
  }));
  const fused = rrfFuse([fts, vec]);
  const now = new Date();
  const out: RetrievedMemory[] = [];
  for (const [id, rrf] of fused.entries()) {
    const mem = db
      .prepare("SELECT * FROM memories WHERE id = ?")
      .get(id) as MemoryRecord | undefined;
    if (!mem) continue;
    if (
      !opts.includeArchived &&
      (mem.status === "deleted" || mem.status === "archived")
    )
      continue;
    const recency = recencyFactorFor(mem.type, mem.updated_at, now);
    const scope = scopeFactorFor(mem, {
      projectId: opts.projectId,
      sessionId: opts.sessionId,
    });
    const fs = finalScore({
      rrf,
      confidence: mem.confidence,
      importance: mem.importance,
      recency,
      scopeFactor: scope,
    });
    out.push({ ...mem, rrf, final_score: fs });
  }
  return out.sort((a, b) => b.final_score - a.final_score).slice(0, limit);
}
