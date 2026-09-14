import { db, getAllEmbeddings } from "../db/index.js";
import { cosine, deserialize } from "../lib/embed.js";
import { createMemory } from "../db/repositories/memories.js";
import { linkMemories } from "./graph-engine.js";
import { resolveUserId } from "../db/repositories/users.js";

export interface ClusterOptions {
  threshold?: number;
  projectId?: string | null;
  // Batch B-1 (optional, additive): scope filters so USER/SESSION memories
  // never cluster into a scope the caller did not ask for.
  sessionId?: string | null;
  userId?: string | null;
  minClusterSize?: number;
  includeArchived?: boolean;
}

// Group similar active memories into clusters via embedding cosine + union-find (spec §16)
export function clusterMemories(opts: ClusterOptions = {}): number[][] {
  const threshold = opts.threshold ?? 0.7;
  const minSize = opts.minClusterSize ?? 2;
  const rows = db
    .prepare(
      `SELECT e.ref_id as ref_id, e.vec as vec, m.status, m.project_id, m.scope, m.session_id, m.user_id
       FROM embeddings e
       JOIN memories m ON m.id = e.ref_id
       WHERE e.ref_table = 'memories'
         AND ( ? OR m.status NOT IN ('deleted','archived','superseded'))`
    )
    .all(opts.includeArchived ? 1 : 0) as Array<{
    ref_id: number;
    vec: Buffer;
    status: string;
    project_id: string | null;
    scope: string;
    session_id: string | null;
    user_id: number | null;
  }>;
  // External userId -> internal id once (null when unscoped/unknown; then no
  // USER row can match, so only GLOBAL clusters — never another user's data).
  const resolvedUid = opts.userId ? resolveUserId(opts.userId) : null;
  const valid = rows.filter((r) => {
    // Batch B-1 strict scope filter (mirrors retrieval visible()): a scoped
    // memory clusters only when the caller explicitly scopes to it. GLOBAL
    // always participates. This stops USER/SESSION/PROJECT memories from
    // being absorbed into a cluster the caller reads as another scope.
    if (r.scope === "USER") {
      if (opts.userId == null) return false;
      return r.user_id === resolvedUid;
    }
    if (r.scope === "SESSION") {
      if (opts.sessionId == null) return false;
      return r.session_id === opts.sessionId;
    }
    if (r.scope === "PROJECT") {
      if (opts.projectId == null) return false;
      return r.project_id === opts.projectId;
    }
    return true;
  });

  const CAP = 2000;
  const sliced = valid.slice(0, CAP);
  const vecs = new Map<number, Float32Array>();
  for (const r of sliced) vecs.set(r.ref_id, deserialize(r.vec));
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
  // Batch B-1 (optional, additive): scope inherited from the cluster sources
  // so a derived memory is never escalated to GLOBAL on its own.
  sessionId?: string | null;
  userId?: string | null;
}

export interface ScopeRow {
  scope: string;
  project_id: string | null;
  session_id: string | null;
  user_id: number | null;
}

export interface DerivedScope {
  projectId: string | null;
  sessionId: string | null;
  /** External user id (what callers pass as `userId`). */
  userId: string | null;
}

function scopeRank(scope: string): number {
  switch (scope) {
    case "SESSION":
      return 3;
    case "USER":
      return 2;
    case "PROJECT":
      return 1;
    default:
      return 0;
  }
}

function externalIdFor(internalId: number | null): string | null {
  if (internalId == null) return null;
  try {
    const row = db
      .prepare("SELECT external_id FROM users WHERE id = ?")
      .get(internalId) as { external_id: string } | undefined;
    return row?.external_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolve the scope for a derived memory without ever escalating.
 * Unanimous cluster → inherit that exact scope; mixed cluster → inherit the
 * narrowest member scope (SESSION > USER > PROJECT > GLOBAL). GLOBAL is
 * returned only when every source is GLOBAL (plus any explicit caller scope,
 * which only narrows). Returns null when a non-GLOBAL source has no safely
 * resolvable identity — the caller must skip deriving instead of escalating.
 */
export function resolveDerivedScope(
  members: ScopeRow[],
  caller: {
    projectId?: string | null;
    sessionId?: string | null;
    userId?: string | null;
  } = {}
): DerivedScope | null {
  const norm = (v: string | null | undefined): string | null =>
    typeof v === "string" ? v : null;
  if (members.length === 0) {
    return {
      projectId: norm(caller.projectId),
      sessionId: norm(caller.sessionId),
      userId: norm(caller.userId),
    };
  }
  const sawNonGlobal = members.some((m) => m.scope !== "GLOBAL");
  const first = members[0]!;
  const unanimous =
    members.every((m) => m.scope === first.scope) &&
    members.every((m) => m.project_id === first.project_id) &&
    members.every((m) => m.session_id === first.session_id) &&
    members.every((m) => m.user_id === first.user_id);
  const ordered = unanimous
    ? [first]
    : [...members].sort((a, b) => {
        const byRank = scopeRank(b.scope) - scopeRank(a.scope);
        if (byRank !== 0) return byRank;
        // Deterministic tie-break on owner identity so equal-rank members
        // (e.g. USER alice vs USER bob) never resolve to an arbitrary pick.
        const ownerKey = (m: ScopeRow) =>
          `${m.user_id ?? ""}|${m.project_id ?? ""}|${m.session_id ?? ""}`;
        return ownerKey(a).localeCompare(ownerKey(b));
      });
  // If the narrowest-scope group mixes distinct owners, we cannot safely
  // attribute the derived memory to any single owner — skip instead of
  // leaking one owner's data into another's derived memory.
  const topRank = scopeRank(ordered[0]!.scope);
  const topGroup = ordered.filter((m) => scopeRank(m.scope) === topRank);
  const ownerSet = new Set(
    topGroup.map((m) => `${m.user_id ?? ""}|${m.project_id ?? ""}|${m.session_id ?? ""}`)
  );
  if (ownerSet.size > 1) return null;
  for (const pick of ordered) {
    if (pick.scope === "SESSION" && pick.session_id != null) {
      return {
        projectId: pick.project_id,
        sessionId: pick.session_id,
        userId: externalIdFor(pick.user_id),
      };
    }
    if (pick.scope === "USER") {
      // createMemory derives USER only from userId alone (projectId would
      // make it PROJECT), so pass the owner with no project/session.
      const ext = externalIdFor(pick.user_id) ?? norm(caller.userId);
      if (ext == null) continue;
      return { projectId: null, sessionId: null, userId: ext };
    }
    if (pick.scope === "PROJECT" && pick.project_id != null) {
      return { projectId: pick.project_id, sessionId: null, userId: null };
    }
    if (pick.scope === "GLOBAL" && !sawNonGlobal) {
      return {
        projectId: norm(caller.projectId),
        sessionId: norm(caller.sessionId),
        userId: norm(caller.userId),
      };
    }
  }
  return null;
}

// Create a derived/consolidated memory and link its sources via `derived_from` (spec §16)
export function createDerivedMemory(input: DerivedMemoryInput): number {
  const id = createMemory({
    type: "DERIVED",
    content: input.content,
    summary: input.summary ?? null,
    source: "consolidated",
    projectId: input.projectId ?? null,
    sessionId: input.sessionId ?? null,
    userId: input.userId ?? null,
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
