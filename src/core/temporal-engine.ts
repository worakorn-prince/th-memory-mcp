import { db } from "../db/index.js";
import { getMemoryById } from "../db/repositories/memories.js";
import type { MemoryRecord } from "../memory/types.js";

export function setValidity(
  id: number,
  validFrom: string | null,
  validUntil: string | null
): MemoryRecord {
  const mem = getMemoryById(id);
  if (!mem) throw new Error(`memory ${id} not found`);
  db.prepare(
    `UPDATE memories SET valid_from = ?, valid_until = ?, updated_at = ? WHERE id = ?`
  ).run(validFrom, validUntil, new Date().toISOString(), id);
  return getMemoryById(id) as MemoryRecord;
}

// Memories that were valid at time T (inclusive). Excludes logically deleted.
export function memoriesValidAt(
  isoTs: string,
  opts: { projectId?: string | null; types?: string[]; limit?: number } = {}
): MemoryRecord[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const clauses = [
    "(valid_from IS NULL OR valid_from <= @t)",
    "(valid_until IS NULL OR valid_until >= @t)",
    "status != 'deleted'",
  ];
  const params: Record<string, unknown> = { t: isoTs, limit };
  if (opts.projectId) {
    clauses.push("(project_id = @projectId OR project_id IS NULL)");
    params.projectId = opts.projectId;
  }
  if (opts.types && opts.types.length) {
    const ph = opts.types.map((_, i) => `@type${i}`).join(",");
    clauses.push(`type IN (${ph})`);
    opts.types.forEach((t, i) => (params[`type${i}`] = t));
  }
  return db
    .prepare(
      `SELECT * FROM memories WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT @limit`
    )
    .all(params) as MemoryRecord[];
}

// Walk the supersession chain: oldest -> newest, centered on the given memory.
export function supersessionChain(id: number): MemoryRecord[] {
  const start = getMemoryById(id);
  if (!start) return [];
  const seen = new Set<number>();

  // backward: follow supersedes_id to the root (oldest)
  const backward: MemoryRecord[] = [];
  let cur: MemoryRecord | undefined = start;
  while (cur && cur.supersedes_id != null && !seen.has(cur.id)) {
    seen.add(cur.id);
    const prev = getMemoryById(cur.supersedes_id);
    if (!prev) break;
    backward.unshift(prev);
    cur = prev;
  }

  // forward: find memories whose supersedes_id == current newest
  const forward: MemoryRecord[] = [];
  cur = start;
  seen.clear();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    forward.push(cur);
    const next = db
      .prepare("SELECT id FROM memories WHERE supersedes_id = ? LIMIT 1")
      .get(cur.id) as { id: number } | undefined;
    if (!next) break;
    cur = getMemoryById(next.id);
  }
  return [...backward, ...forward];
}

// Change detection: memories created or updated within [t1, t2].
export function changesBetween(
  t1: string,
  t2: string,
  limit = 100
): MemoryRecord[] {
  return db
    .prepare(
      `SELECT * FROM memories
       WHERE updated_at >= @t1 AND updated_at <= @t2 AND status != 'deleted'
       ORDER BY updated_at DESC
       LIMIT @limit`
    )
    .all({ t1, t2, limit }) as MemoryRecord[];
}
