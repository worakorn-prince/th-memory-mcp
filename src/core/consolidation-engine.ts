import { db, getAllEmbeddings } from "../db/index.js";
import { cosine, deserialize } from "../lib/embed.js";
import { createMemory } from "../db/repositories/memories.js";
import { linkMemories } from "./graph-engine.js";

export interface ClusterOptions {
  threshold?: number;
  projectId?: string | null;
  minClusterSize?: number;
  includeArchived?: boolean;
}

// Group similar active memories into clusters via embedding cosine + union-find (spec §16)
export function clusterMemories(opts: ClusterOptions = {}): number[][] {
  const threshold = opts.threshold ?? 0.7;
  const minSize = opts.minClusterSize ?? 2;
  const rows = getAllEmbeddings() as Array<{ ref_id: number; vec: Buffer }>;
  const valid = rows.filter((r) => {
    const m = db
      .prepare("SELECT status, project_id FROM memories WHERE id = ?")
      .get(r.ref_id) as
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
  });

  const vecs = new Map<number, Float32Array>();
  for (const r of valid) vecs.set(r.ref_id, deserialize(r.vec));
  const ids = [...vecs.keys()];

  const parent = new Map<number, number>();
  ids.forEach((id) => parent.set(id, id));
  function find(x: number): number {
    let root = parent.get(x);
    while (root !== undefined && root !== x) {
      const next = parent.get(root);
      if (next === undefined) break;
      parent.set(x, next);
      x = root;
      root = next;
    }
    return root ?? x;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }

  for (let i = 0; i < ids.length; i++) {
    const a = ids[i]!;
    for (let j = i + 1; j < ids.length; j++) {
      const b = ids[j]!;
      if (cosine(vecs.get(a)!, vecs.get(b)!) >= threshold) {
        union(a, b);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (const id of ids) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(id);
  }
  return [...groups.values()].filter((g) => g.length >= minSize);
}

export interface DerivedMemoryInput {
  content: string;
  summary?: string | null;
  sourceIds: number[];
  projectId?: string | null;
}

// Create a derived/consolidated memory and link its sources via `derived_from` (spec §16)
export function createDerivedMemory(input: DerivedMemoryInput): number {
  const id = createMemory({
    type: "DERIVED",
    content: input.content,
    summary: input.summary ?? null,
    source: "consolidated",
    projectId: input.projectId ?? null,
  });
  for (const src of input.sourceIds) {
    if (src !== id) linkMemories(src, id, "derived_from");
  }
  return id;
}

export function getProvenance(memoryId: number): number[] {
  const rows = db
    .prepare(
      `SELECT source_memory_id FROM memory_links
       WHERE target_memory_id = ? AND relation = 'derived_from'`
    )
    .all(memoryId) as Array<{ source_memory_id: number }>;
  return rows.map((r) => r.source_memory_id);
}
