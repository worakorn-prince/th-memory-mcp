import { db, nowISO } from "../db/index.js";

export interface EntityInput {
  name: string;
  type?: string;
  aliases?: string[];
}

export function createEntity(input: EntityInput): number {
  const canonical = input.name.toLowerCase().trim();
  const existing = db
    .prepare("SELECT id FROM entities WHERE canonical_name = ?")
    .get(canonical) as { id: number } | undefined;
  if (existing) return existing.id;
  const info = db
    .prepare(
      `INSERT INTO entities (name, canonical_name, type, metadata)
       VALUES (?, ?, ?, ?)`
    )
    .run(
      input.name,
      canonical,
      input.type ?? "concept",
      JSON.stringify({ aliases: input.aliases ?? [] })
    );
  return Number(info.lastInsertRowid);
}

export function addRelation(input: {
  subjectId: number;
  predicate: string;
  objectId: number;
  confidence?: number;
  sourceMemoryId?: number | null;
}): number {
  const info = db
    .prepare(
      `INSERT INTO relations
       (source_entity_id, relation, target_entity_id, confidence, source_memory_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.subjectId,
      input.predicate,
      input.objectId,
      input.confidence ?? 0.5,
      input.sourceMemoryId ?? null,
      JSON.stringify({})
    );
  return Number(info.lastInsertRowid);
}

export function linkMemories(
  sourceId: number,
  targetId: number,
  relation: string
): void {
  db.prepare(
    `INSERT OR IGNORE INTO memory_links
     (source_memory_id, relation, target_memory_id, created_at)
     VALUES (?, ?, ?, ?)`
  ).run(sourceId, relation, targetId, nowISO());
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
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur.depth >= maxDepth) continue;
    const links = db
      .prepare(
        `SELECT target_memory_id, relation FROM memory_links
         WHERE source_memory_id = ?`
      )
      .all(cur.id) as Array<{ target_memory_id: number; relation: string }>;
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

export function neighbors(memoryId: number): TraversalNode[] {
  return traverse(memoryId, { maxDepth: 1 });
}
