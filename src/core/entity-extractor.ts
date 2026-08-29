import { db } from "../db/index.js";
import { createEntity, addRelation, linkMemories } from "./graph-engine.js";
import { STOPWORDS } from "../lib/distill-core.js";

// Heuristic entity extraction (no LLM). Catches quoted strings, CamelCase /
// PascalCase identifiers, capitalized proper nouns, kebab-case, file paths, URLs,
// and generic technical tokens (length >= 4, non-stopword).
export function extractEntities(text: string): string[] {
  const found = new Set<string>();
  if (!text) return [];
  const add = (s: string | null | undefined) => {
    if (s && s.trim().length >= 2) found.add(s.trim());
  };

  for (const m of text.matchAll(/"([^"]{2,60})"|'([^']{2,60})'/g)) add(m[1] ?? m[2]);
  for (const m of text.matchAll(/[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+/g)) add(m[0]);
  for (const m of text.matchAll(/\b[A-Z][a-z]{2,}\b/g)) add(m[0]);
  for (const m of text.matchAll(/\b[a-z]+(?:-[a-z]+){1,}\b/g)) add(m[0]);
  for (const m of text.matchAll(/\b[\w./-]+\.(ts|js|mjs|py|json|md|yaml|yml)\b/gi)) add(m[0]);
  for (const m of text.matchAll(/\bhttps?:\/\/\S+/gi)) add(m[0]);
  for (const m of text.matchAll(/\b[A-Za-z][A-Za-z0-9_-]*\b/g)) {
    const t = m[0];
    if (t.length >= 4 && !STOPWORDS.has(t.toLowerCase())) add(t);
  }

  return [...found].filter((e) => e.length >= 2).slice(0, 12);
}

// Extract entities from a memory's content, persist them, and record
// co-occurrence relations (sourced from this memory). Returns entity ids.
export function linkEntitiesForMemory(memoryId: number, content: string): number[] {
  const names = extractEntities(content);
  const ids: number[] = [];
  for (const name of names) {
    ids.push(createEntity({ name, type: "concept" }));
  }
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      addRelation({
        subjectId: ids[i]!,
        predicate: "co_occurs",
        objectId: ids[j]!,
        confidence: 0.6,
        sourceMemoryId: memoryId,
      });
    }
  }
  return ids;
}

// Link memories that share at least one extracted entity (item 5).
export function linkMemoriesBySharedEntities(memoryIds: number[]): void {
  const memEntities = new Map<number, Set<number>>();
  for (const id of memoryIds) {
    const rows = db
      .prepare(
        `SELECT DISTINCT e FROM (
           SELECT target_entity_id AS e FROM relations WHERE source_memory_id = ?
           UNION
           SELECT source_entity_id AS e FROM relations WHERE source_memory_id = ?
         )`
      )
      .all(id, id) as Array<{ e: number }>;
    memEntities.set(id, new Set(rows.map((r) => r.e)));
  }
  for (let i = 0; i < memoryIds.length; i++) {
    for (let j = i + 1; j < memoryIds.length; j++) {
      const a = memEntities.get(memoryIds[i]!)!;
      const b = memEntities.get(memoryIds[j]!)!;
      let shared = false;
      for (const e of a) {
        if (b.has(e)) {
          shared = true;
          break;
        }
      }
      if (shared) linkMemories(memoryIds[i]!, memoryIds[j]!, "shares_entity");
    }
  }
}
