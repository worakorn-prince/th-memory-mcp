import { db, nowISO } from "../db/index.js";
import { getMemoryById, setStatus } from "../db/repositories/memories.js";
import type { LifecycleState, MemoryRecord } from "../memory/types.js";

const TRANSITIONS: Record<LifecycleState, LifecycleState[]> = {
  new: ["active", "deleted"],
  active: ["reinforced", "stale", "superseded", "archived", "deleted"],
  reinforced: ["active", "stale", "superseded", "archived", "deleted"],
  stale: ["active", "archived", "deleted"],
  superseded: ["archived", "deleted"],
  archived: ["deleted"],
  deleted: [],
};

export class LifecycleError extends Error {}

export function canTransition(
  from: LifecycleState,
  to: LifecycleState
): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function transitionStatus(
  id: number,
  to: LifecycleState
): MemoryRecord {
  const mem = getMemoryById(id);
  if (!mem) throw new LifecycleError(`memory ${id} not found`);
  if (!canTransition(mem.status, to)) {
    throw new LifecycleError(
      `illegal transition ${mem.status} -> ${to} for memory ${id}`
    );
  }
  setStatus(id, to);
  return getMemoryById(id) as MemoryRecord;
}

export function reinforce(id: number): MemoryRecord {
  const mem = getMemoryById(id);
  if (!mem) throw new LifecycleError(`memory ${id} not found`);
  if (mem.status === "deleted" || mem.status === "archived") {
    throw new LifecycleError(`cannot reinforce memory in state ${mem.status}`);
  }
  const ts = nowISO();
  db.prepare(
    `UPDATE memories
     SET status = 'active',
         confidence = MIN(1.0, confidence + 0.05),
         updated_at = ?,
         access_count = access_count + 1,
         last_accessed_at = ?
     WHERE id = ?`
  ).run(ts, ts, id);
  return getMemoryById(id) as MemoryRecord;
}

export function touch(id: number): void {
  const ts = nowISO();
  db.prepare(
    `UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`
  ).run(ts, id);
}

// old memory becomes superseded; new memory becomes active and points to old.
export function supersede(oldId: number, newId: number): void {
  const oldM = getMemoryById(oldId);
  const newM = getMemoryById(newId);
  if (!oldM) throw new LifecycleError(`old memory ${oldId} not found`);
  if (!newM) throw new LifecycleError(`new memory ${newId} not found`);
  const ts = nowISO();
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE memories SET status = 'superseded', updated_at = ? WHERE id = ?`
    ).run(ts, oldId);
    db.prepare(
      `UPDATE memories SET status = 'active', supersedes_id = ?, updated_at = ? WHERE id = ?`
    ).run(oldId, ts, newId);
    db.prepare(
      `INSERT INTO memory_links (source_memory_id, relation, target_memory_id, confidence, created_at)
       VALUES (?, 'supersedes', ?, 0.9, ?)
       ON CONFLICT(source_memory_id, relation, target_memory_id) DO UPDATE SET confidence = 0.9`
    ).run(newId, oldId, ts);
  });
  tx();
}

export function archive(id: number): MemoryRecord {
  const mem = getMemoryById(id);
  if (!mem) throw new LifecycleError(`memory ${id} not found`);
  if (mem.status === "deleted")
    throw new LifecycleError(`cannot archive deleted memory ${id}`);
  return transitionStatus(id, "archived");
}

export function softDelete(id: number): MemoryRecord {
  return transitionStatus(id, "deleted");
}
