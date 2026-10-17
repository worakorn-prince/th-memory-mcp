import type BetterSqlite3 from "better-sqlite3";
import { db, nowISO } from "../db/index.js";

export interface EntityInput {
  name: string;
  type?: string;
  aliases?: string[];
}

let _findEntity: BetterSqlite3.Statement | null = null;
function getFindEntity(): BetterSqlite3.Statement {
  return (_findEntity ??= db.prepare(
    "SELECT id FROM entities WHERE canonical_name = ?"
  ));
}

let _insertEntity: BetterSqlite3.Statement | null = null;
function getInsertEntity(): BetterSqlite3.Statement {
  return (_insertEntity ??= db.prepare(
    `INSERT INTO entities (name, canonical_name, type, metadata)
     VALUES (?, ?, ?, ?)`
  ));
}

export function createEntity(input: EntityInput): number {
  const canonical = input.name.toLowerCase().trim();
  const existing = getFindEntity().get(canonical) as { id: number } | undefined;
  if (existing) return existing.id;
  const info = getInsertEntity().run(
    input.name,
    canonical,
    input.type ?? "concept",
    JSON.stringify({ aliases: input.aliases ?? [] })
  );
  return Number(info.lastInsertRowid);
}

let _findRelation: BetterSqlite3.Statement | null = null;
function getFindRelation(): BetterSqlite3.Statement {
  return (_findRelation ??= db.prepare(
    `SELECT id FROM relations
     WHERE source_entity_id = ? AND relation = ? AND target_entity_id = ?
       AND COALESCE(source_memory_id, -1) = COALESCE(?, -1)`
  ));
}

let _insertRelation: BetterSqlite3.Statement | null = null;
function getInsertRelation(): BetterSqlite3.Statement {
  return (_insertRelation ??= db.prepare(
    `INSERT INTO relations
     (source_entity_id, relation, target_entity_id, confidence, source_memory_id, metadata)
     VALUES (?, ?, ?, ?, ?, ?)`
  ));
}

export function addRelation(input: {
  subjectId: number;
  predicate: string;
  objectId: number;
  confidence?: number;
  sourceMemoryId?: number | null;
}): number {
  // Batch A-3: upsert against idx_relations_unique (source+relation+target+
  // coalesced source_memory) so repeats return the existing row instead of
  // accumulating duplicates. SELECT-first keeps lastInsertRowid semantics
  // (INSERT OR IGNORE would report a stale rowid on conflict).
  const existing = getFindRelation().get(
    input.subjectId,
    input.predicate,
    input.objectId,
    input.sourceMemoryId ?? null
  ) as { id: number } | undefined;
  if (existing) return existing.id;
  const info = getInsertRelation().run(
    input.subjectId,
    input.predicate,
    input.objectId,
    input.confidence ?? 0.5,
    input.sourceMemoryId ?? null,
    JSON.stringify({})
  );
  return Number(info.lastInsertRowid);
}

let _insertMemoryLink: BetterSqlite3.Statement | null = null;
function getInsertMemoryLink(): BetterSqlite3.Statement {
  return (_insertMemoryLink ??= db.prepare(
    `INSERT OR IGNORE INTO memory_links
     (source_memory_id, relation, target_memory_id, created_at)
     VALUES (?, ?, ?, ?)`
  ));
}

export function linkMemories(
  sourceId: number,
  targetId: number,
  relation: string
): void {
  getInsertMemoryLink().run(sourceId, relation, targetId, nowISO());
}

export interface TraversalOptions {
  maxDepth?: number;
  relationFilter?: string[];
  includeArchived?: boolean;
}

export interface TraversalNode {
  memoryId: number;
  depth: number;
  relation: string | null;
}

let _linksStmt: BetterSqlite3.Statement | null = null;
function getLinksStmt(): BetterSqlite3.Statement {
  return (_linksStmt ??= db.prepare(
    `SELECT target_memory_id, relation FROM memory_links
     WHERE source_memory_id = ?`
  ));
}

// Bounded BFS over memory_links starting from a memory (spec §14)
export function traverse(
  startMemoryId: number,
  opts: TraversalOptions = {}
): TraversalNode[] {
  const maxDepth = Math.min(Math.max(opts.maxDepth ?? 2, 1), 5);
  const visited = new Set<number>([startMemoryId]);
  const queue: Array<{ id: number; depth: number; relation: string | null }> = [
    { id: startMemoryId, depth: 0, relation: null },
  ];
  const result: TraversalNode[] = [];
  const linksStmt = getLinksStmt();
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur.depth >= maxDepth) continue;
    const links = linksStmt.all(cur.id) as Array<{
      target_memory_id: number;
      relation: string;
    }>;
    for (const l of links) {
      if (opts.relationFilter && !opts.relationFilter.includes(l.relation)) {
        continue;
      }
      if (!visited.has(l.target_memory_id)) {
        visited.add(l.target_memory_id);
        result.push({
          memoryId: l.target_memory_id,
          depth: cur.depth + 1,
          relation: l.relation,
        });
        queue.push({
          id: l.target_memory_id,
          depth: cur.depth + 1,
          relation: l.relation,
        });
      }
    }
  }
  return result;
}

/** PARKED: not wired into any tool flow; exercised only by test/graph.test.mjs.
 *  Do not delete without relocating the neighbor traversal together with its tests. */
export function neighbors(memoryId: number): TraversalNode[] {
  return traverse(memoryId, { maxDepth: 1 });
}
