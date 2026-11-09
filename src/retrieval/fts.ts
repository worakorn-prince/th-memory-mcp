import { db, buildFtsMatch, buildLooseFtsMatch } from "../db/index.js";
import { resolveUserId } from "../db/repositories/users.js";
import { buildScopeClause } from "../lib/scope.js";

export interface RankedId {
  id: number;
  rank: number;
}

type FtsChannel = "search_index" | "search_index_loose";

// Shared shape of the scope clause + named params (alias is fixed to "m").
interface ChannelContext {
  statusClause: string;
  scope: ReturnType<typeof buildScopeClause>;
}

function runChannel(
  table: FtsChannel,
  match: string,
  limit: number,
  ctx: ChannelContext
): number[] {
  const rows = db
    .prepare(
      `SELECT m.id FROM memories m
       JOIN ${table} ON ${table}.ref_table = 'memories' AND ${table}.ref_id = m.id
       WHERE ${table} MATCH @match ${ctx.statusClause}
         AND ${ctx.scope.sql}
       ORDER BY rank
       LIMIT @limit`
    )
    .all({
      match,
      limit,
      ...ctx.scope.params,
    }) as Array<{ id: number }>;
  return rows.map((r) => Number(r.id));
}

export function ftsSearch(
  query: string,
  opts: {
    limit?: number;
    projectId?: string | null;
    sessionId?: string | null;
    userId?: string | null;
    includeArchived?: boolean;
  } = {}
): RankedId[] {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const statusClause = opts.includeArchived
    ? ""
    : "AND m.status NOT IN ('deleted','archived','superseded')";
  // Batch A-4: scope predicate lives INSIDE SQL (not JS post-filter), so
  // LIMIT applies after scope filtering. The old code did LIMIT-then-filter:
  // out-of-scope rows could fill the LIMIT window and starve in-scope hits.
  // P1-A: the predicate is now the shared clause from lib/scope.ts.
  const uid = opts.userId == null ? null : resolveUserId(opts.userId);
  const scope = buildScopeClause("m", {
    resolvedUid: uid,
    sessionId: opts.sessionId,
    projectId: opts.projectId,
  });
  const ctx: ChannelContext = { statusClause, scope };

  // STRICT channel is the authoritative, higher-ranked path (tone marks stay
  // significant): ติดตั้ง ≠ ติดตัง.
  const strict = runChannel("search_index", buildFtsMatch(query), limit, ctx);
  const out: RankedId[] = strict.map((id, i) => ({ id, rank: i + 1 }));

  // LOOSE fallback channel (TASK-THAI-LOOSE): only consulted when the strict
  // channel is short of the limit, so a tone-typo query (ติดตัง) can still
  // surface the correctly-marked document. Loose-only hits are appended BELOW
  // strict hits, deduped by id, and never displace a strict hit. Same
  // scope/status predicates and the same LIMIT clamp are applied on both
  // channels, so the merge is deterministic (strict-then-loose).
  if (strict.length < limit) {
    const loose = runChannel("search_index_loose", buildLooseFtsMatch(query), limit, ctx);
    const seen = new Set<number>(strict);
    for (const id of loose) {
      if (out.length >= limit) break;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, rank: out.length + 1 });
    }
  }
  return out;
}
