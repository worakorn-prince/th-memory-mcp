import { db } from "../db/index.js";
import { retrieve } from "./retrieval-engine.js";
import { traverse } from "./graph-engine.js";
import { resolveUserId } from "../db/repositories/users.js";
import type { MemoryRecord } from "../memory/types.js";

export interface ContextOptions {
  query?: string;
  projectId?: string | null;
  sessionId?: string | null;
  userId?: string | null;
  limit?: number;
  maxTokens?: number;
  includeHistory?: boolean;
  includeGraph?: boolean;
}

export interface ContextMemory extends MemoryRecord {
  final_score: number;
  viaGraph?: boolean;
}

export interface ContextResult {
  query: string;
  memories: ContextMemory[];
  tokenEstimate: number;
  truncated: boolean;
}

function isScopeVisible(
  m: MemoryRecord,
  opts: ContextOptions,
  uid: number | null
): boolean {
  if (m.scope === "USER") {
    if (opts.userId == null) return false;
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
}

function isCurrentlyValid(m: MemoryRecord, now: Date): boolean {
  if (m.valid_from && new Date(m.valid_from) > now) return false;
  if (m.valid_until && new Date(m.valid_until) < now) return false;
  return true;
}

// Assemble relevant memories for the current task (spec §15)
export function getContext(opts: ContextOptions = {}): ContextResult {
  const query = opts.query ?? "";
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const maxTokens = opts.maxTokens ?? 2000;
  const now = new Date();
  const resolvedUid = opts.userId ? resolveUserId(opts.userId) : null;

  const seeds = retrieve(query, {
    limit,
    projectId: opts.projectId,
    sessionId: opts.sessionId,
    userId: opts.userId,
    resolvedUid,
    includeArchived: opts.includeHistory,
  });

  const seedScores = new Map<number, number>();
  for (const s of seeds) seedScores.set(s.id, s.final_score);

  const ids = new Set<number>(seeds.map((s) => s.id));
  if (opts.includeGraph) {
    for (const s of seeds) {
      for (const n of traverse(s.id, { maxDepth: 1 })) {
        const m = db
          .prepare("SELECT * FROM memories WHERE id = ?")
          .get(n.memoryId) as MemoryRecord | undefined;
        if (!m) continue;
        if (
          !opts.includeHistory &&
          (m.status === "deleted" ||
            m.status === "archived" ||
            m.status === "superseded")
        )
          continue;
        if (!isScopeVisible(m, opts, resolvedUid)) continue;
        if (!opts.includeHistory && !isCurrentlyValid(m, now)) continue;
        ids.add(n.memoryId);
      }
    }
  }


  const all = [...ids]
    .map(
      (id) =>
        db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
          | MemoryRecord
          | undefined
    )
    .filter((m): m is MemoryRecord => !!m)
    .filter((m) => opts.includeHistory || isCurrentlyValid(m, now))
    .filter((m) => isScopeVisible(m, opts, resolvedUid))
    .filter(
      (m) =>
        opts.includeHistory ||
        !(m.status === "deleted" || m.status === "archived" || m.status === "superseded")
    );

  all.sort(
    (a, b) =>
      (seedScores.get(b.id) ?? 0) - (seedScores.get(a.id) ?? 0)
  );

  let used = 0;
  const out: ContextMemory[] = [];
  let truncated = false;
  for (const m of all) {
    const t = Math.ceil((m.content?.length ?? 0) / 4) + 8;
    if (used + t > maxTokens && out.length > 0) {
      truncated = true;
      break;
    }
    used += t;
    out.push({ ...m, final_score: seedScores.get(m.id) ?? 0, viaGraph: !seedScores.has(m.id) });
  }

  return { query, memories: out, tokenEstimate: used, truncated };
}
