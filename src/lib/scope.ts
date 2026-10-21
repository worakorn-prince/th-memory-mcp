// scope.ts (P1-A) — single source of truth for scope visibility.
//
// Before this module the GLOBAL / USER / SESSION / PROJECT visibility rule was
// copy-pasted across retrieval-engine, context-engine, consolidation-engine,
// retrieval/vector, retrieval/fts and db/index (getScopedEmbeds). Every site
// had to stay in sync manually or a scope could leak. All of them now call
// the helpers here instead.
//
// DB-free on purpose (lib layer): callers resolve the external userId to the
// internal uid via resolveUserId() and pass both:
//   - ctx.userId      external id; its presence (non-null) is the gate for
//                     USER records — no userId hides every USER record even
//                     if resolvedUid happens to carry a value.
//   - ctx.resolvedUid internal numeric id compared against record.user_id.
// Null rules: a missing scope value (null/undefined) hides records of that
// scope. Only explicit GLOBAL always passes; unknown scope values are hidden
// (fail-closed, SEC-14).

export interface ScopeSqlContext {
  /** Internal user id from resolveUserId(); compared to records' user_id. */
  resolvedUid?: number | null;
  sessionId?: string | null;
  projectId?: string | null;
}

export interface ScopeContext extends ScopeSqlContext {
  /** External user id the caller passed (presence gate for USER records). */
  userId?: string | null;
}

export interface ScopeRecordLike {
  scope: string;
  project_id?: string | null;
  session_id?: string | null;
  user_id?: number | null;
}

/**
 * JS-side visibility filter for records already fetched from the DB
 * (retrieval-engine, context-engine, consolidation-engine).
 *
 * The gate checks the external `userId` (not `resolvedUid`) and the
 * comparison uses the resolved numeric id (`record.user_id === resolvedUid`).
 * Only explicit GLOBAL passes the default branch; unknown scope values are
 * hidden (fail-closed, SEC-14).
 */
export function isScopeVisible(
  record: ScopeRecordLike,
  ctx: ScopeContext
): boolean {
  if (record.scope === "USER") {
    if (ctx.userId == null) return false;
    return record.user_id === (ctx.resolvedUid ?? null);
  }
  if (record.scope === "SESSION") {
    if (ctx.sessionId == null) return false;
    return record.session_id === ctx.sessionId;
  }
  if (record.scope === "PROJECT") {
    if (ctx.projectId == null) return false;
    return record.project_id === ctx.projectId;
  }
  return record.scope === "GLOBAL";
}

export interface ScopeSqlValues {
  uid: number | null;
  sid: string | null;
  pid: string | null;
}

export interface ScopeClause {
  /** Parenthesized WHERE predicate; alias is validated, no input is interpolated. */
  sql: string;
  /** Bindings for the @uid / @sid / @pid named parameters. */
  params: ScopeSqlValues;
}

const ALIAS_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * SQL twin of isScopeVisible() for a table alias whose rows expose
 * scope / user_id / session_id / project_id (memories table). Returns a
 * parameterized predicate plus the named-parameter bindings. Pass
 * `resolvedUid`, not the external userId.
 *
 * `@x IS NOT NULL AND col = @x` is equivalent to `col = @x` for `=` (a NULL
 * binding can never satisfy equality); the explicit guard documents intent
 * and mirrors the canonical fts predicate.
 *
 * Documented divergence from the legacy JS sites: a corrupt USER row with
 * `user_id IS NULL` is hidden by SQL even when the caller passed an external
 * userId that did not resolve (legacy JS could match `null === null`).
 * Production USER rows always carry a resolved user_id (createMemory derives
 * USER scope only from a resolved user), so this only affects corrupt data —
 * and hiding is the fail-closed direction.
 *
 * Unknown scope values are hidden by both this predicate and the JS helper
 * (fail-closed, SEC-14): the predicate matches only GLOBAL/USER/SESSION/
 * PROJECT, and isScopeVisible returns true only for explicit GLOBAL.
 */
export function buildScopeClause(
  alias: string,
  ctx: ScopeSqlContext = {}
): ScopeClause {
  if (!ALIAS_RE.test(alias)) {
    throw new Error(
      `invalid SQL alias for scope clause: ${JSON.stringify(alias)}`
    );
  }
  const sql =
    `(${alias}.scope = 'GLOBAL'` +
    ` OR (${alias}.scope = 'USER' AND @uid IS NOT NULL AND ${alias}.user_id = @uid)` +
    ` OR (${alias}.scope = 'SESSION' AND @sid IS NOT NULL AND ${alias}.session_id = @sid)` +
    ` OR (${alias}.scope = 'PROJECT' AND @pid IS NOT NULL AND ${alias}.project_id = @pid))`;
  return {
    sql,
    params: {
      uid: ctx.resolvedUid ?? null,
      sid: ctx.sessionId ?? null,
      pid: ctx.projectId ?? null,
    },
  };
}
