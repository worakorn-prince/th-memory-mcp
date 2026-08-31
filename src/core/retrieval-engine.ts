import { db } from "../db/index.js";
import { ftsSearch } from "../retrieval/fts.js";
import { vectorSearch } from "../retrieval/vector.js";
import { rrfFuse } from "../retrieval/fusion.js";
import { finalScore, scopeFactorFor } from "../retrieval/scorer.js";
import { recencyFactorFor } from "../memory/decay.js";
import { resolveUserId } from "../db/repositories/users.js";
import type { MemoryRecord } from "../memory/types.js";

export interface RetrieveOptions {
  limit?: number;
  projectId?: string | null;
  sessionId?: string | null;
  userId?: string | null;
  resolvedUid?: number | null;
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
  const mode = (process.env.MEMORY_RETRIEVAL_MODE || "rrf").toLowerCase();
  const fts = ftsSearch(query, opts);
  let lists: Array<Array<{ id: number; rank: number }>> = [fts];
  if (mode === "vector-only") {
    const vecRaw = vectorSearch(query, opts);
    lists = [vecRaw.map((r, i) => ({ id: r.id, rank: i + 1 }))];
  } else if (mode !== "fts-only") {
    const vecRaw = vectorSearch(query, opts);
    lists = [fts, vecRaw.map((r, i) => ({ id: r.id, rank: i + 1 }))];
  }
  const fused = rrfFuse(lists);
  const now = new Date();
  const resolvedUid =
    opts.resolvedUid !== undefined
      ? opts.resolvedUid
      : opts.userId
        ? resolveUserId(opts.userId)
        : null;
  const visible = (m: MemoryRecord): boolean => {
    if (m.scope === "USER") {
      if (opts.userId == null) return false;
      return m.user_id === resolvedUid;
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
  };
  const ids = [...fused.keys()];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT * FROM memories WHERE id IN (${placeholders})`)
    .all(...ids) as MemoryRecord[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: RetrievedMemory[] = [];
  for (const [id, rrf] of fused.entries()) {
    const mem = byId.get(id);
    if (!mem) continue;
    if (
      !opts.includeArchived &&
      (mem.status === "deleted" ||
        mem.status === "archived" ||
        mem.status === "superseded")
    )
      continue;
    if (!visible(mem)) continue;
    const recency = recencyFactorFor(mem.type, mem.updated_at, now);
    const scope = scopeFactorFor(mem, {
      projectId: opts.projectId,
      sessionId: opts.sessionId,
      userId: resolvedUid,
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
