import type BetterSqlite3 from "better-sqlite3";
import { db } from "../db/index.js";
import { retrieve } from "./retrieval-engine.js";
import { traverse } from "./graph-engine.js";
import { resolveUserId } from "../db/repositories/users.js";
import { isScopeVisible } from "../lib/scope.js";
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

function isCurrentlyValid(m: MemoryRecord, now: Date): boolean {
  if (m.valid_from && new Date(m.valid_from) > now) return false;
  if (m.valid_until && new Date(m.valid_until) < now) return false;
  return true;
}

const ID_FETCH_CHUNK = 500;
const idFetchStmts = new Map<number, BetterSqlite3.Statement>();

function getIdFetchStmt(count: number): BetterSqlite3.Statement {
  let stmt = idFetchStmts.get(count);
  stmt ??= db.prepare(
    `SELECT * FROM memories WHERE id IN (${Array(count).fill("?").join(", ")})`
  );
  idFetchStmts.set(count, stmt);
  return stmt;
}

function fetchMemoriesByIds(ids: number[]): Map<number, MemoryRecord> {
  const out = new Map<number, MemoryRecord>();
  for (let i = 0; i < ids.length; i += ID_FETCH_CHUNK) {
    const chunk = ids.slice(i, i + ID_FETCH_CHUNK);
    const rows = getIdFetchStmt(chunk.length).all(...chunk) as MemoryRecord[];
    for (const row of rows) out.set(row.id, row);
  }
  return out;
}

// Assemble relevant memories for the current task (spec §15)
export function getContext(opts: ContextOptions = {}): ContextResult {
  const query = opts.query ?? "";
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const maxTokens = opts.maxTokens ?? 2000;
  const now = new Date();
  const resolvedUid = opts.userId ? resolveUserId(opts.userId) : null;
  const scopeCtx = {
    userId: opts.userId,
    resolvedUid,
    sessionId: opts.sessionId,
    projectId: opts.projectId,
  };

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
    const neighborIds: number[] = [];
    for (const s of seeds) {
      for (const n of traverse(s.id, { maxDepth: 1 })) {
        neighborIds.push(n.memoryId);
      }
    }
    const fetched = fetchMemoriesByIds([...new Set(neighborIds)]);
    for (const nid of neighborIds) {
      const m = fetched.get(nid);
      if (!m) continue;
      if (
        !opts.includeHistory &&
        (m.status === "deleted" ||
          m.status === "archived" ||
          m.status === "superseded")
      )
        continue;
      if (!isScopeVisible(m, scopeCtx)) continue;
      if (!opts.includeHistory && !isCurrentlyValid(m, now)) continue;
      ids.add(nid);
    }
  }

  const orderedIds = [...ids];
  const fetched = fetchMemoriesByIds(orderedIds);
  const all = orderedIds
    .map((id) => fetched.get(id))
    .filter((m): m is MemoryRecord => !!m)
    .filter((m) => opts.includeHistory || isCurrentlyValid(m, now))
    .filter((m) => isScopeVisible(m, scopeCtx))
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
