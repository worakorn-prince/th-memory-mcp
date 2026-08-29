import { db } from "../db/index.js";
import { retrieve } from "./retrieval-engine.js";
import { traverse } from "./graph-engine.js";
import type { MemoryRecord } from "../memory/types.js";

export interface ContextOptions {
  query?: string;
  projectId?: string | null;
  sessionId?: string | null;
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

  const seeds = retrieve(query, {
    limit,
    projectId: opts.projectId,
    sessionId: opts.sessionId,
    includeArchived: opts.includeHistory,
  });

  const seedScores = new Map<number, number>();
  for (const s of seeds) seedScores.set(s.id, s.final_score);

  const ids = new Set<number>(seeds.map((s) => s.id));
  if (opts.includeGraph) {
    for (const s of seeds) {
      for (const n of traverse(s.id, { maxDepth: 1 })) ids.add(n.memoryId);
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
    .filter((m) => opts.includeHistory || isCurrentlyValid(m, now));

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
