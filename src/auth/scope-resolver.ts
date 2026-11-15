/**
 * Identity-derived scope (Ph-3, task TASK-AUTH-P3-SCOPE).
 *
 * Before Ph-3 every tool derived its scope from raw arguments, so a caller
 * could pass another user's `userId` (T1) or borrow a `projectId`/`sessionId`
 * (T3) and read/write outside their own data. From Ph-3 the scope is resolved
 * ONCE, in the guard, from the verified `AuthIdentity`:
 *
 *   - a caller-supplied `userId` is a **check**, never authority: own id is ok,
 *     a foreign id needs a `scope_grants` row for the current operation kind;
 *   - `projectId` / `sessionId` need an explicit grant (no membership table);
 *   - GLOBAL writes need owner/admin, or a writer with an explicit
 *     `(GLOBAL, '*', write)` grant.
 *
 * Grants are non-escalatable: `hasGrant(..., 'write')` requires a write row, so
 * a read grant can never authorize a write.
 *
 * The bound scope is published through an `AsyncLocalStorage` context
 * (`runWithScope` / `getEffectiveScope`) instead of a new handler argument, so
 * the 16 tool handlers keep their signatures and only read the bound scope when
 * they need it. Legacy mode publishes nothing and the resolver never touches
 * the DB, which keeps the auth-off path byte-identical to v2.5.2.
 *
 * Deny reasons are a fixed enum and never contain argument content:
 *   - `"scope"`        — foreign user/session/project requested without a grant
 *   - `"global-write"` — a tool that would write GLOBAL rows, by a principal
 *                        without owner/admin or a GLOBAL write grant
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthIdentity } from "./identity.js";
import { hasRole, TOOL_POLICY } from "./policy.js";
import { getUserByExternalId, getUserById } from "../db/repositories/users.js";
import {
  GLOBAL_SCOPE_REF,
  hasGrant,
  type GrantPermission,
} from "../db/repositories/scope_grants.js";

/**
 * Which scope dimensions the caller actually supplied (non-empty string, the
 * same test the resolver uses). `userId` is defaulted to the identity for every
 * tool — right for write tools, wrong for reads whose documented no-arg
 * behaviour is GLOBAL-only (`get_profile`, plan §9.2) — so read tools consult
 * these flags instead of the defaulted value.
 */
export interface ScopeRequestedFlags {
  userId: boolean;
  sessionId: boolean;
  projectId: boolean;
}

export interface EffectiveScope {
  mode: "legacy" | "enforced";
  /** External + internal id of the authenticated identity (enforced only). */
  externalId?: string;
  uid?: number;
  /** Verified scope values; null = not requested / not granted. */
  userId?: string | null;
  resolvedUid?: number | null;
  sessionId?: string | null;
  projectId?: string | null;
  /** Dimensions the caller explicitly asked for (see ScopeRequestedFlags). */
  requested: ScopeRequestedFlags;
  /** GLOBAL write allowed only for owner/admin (+ optional grant). */
  allowGlobalWrite: boolean;
}

export const SCOPE_DENY_REASONS = ["scope", "global-write"] as const;
export type ScopeDenyReason = (typeof SCOPE_DENY_REASONS)[number];

export type BindScopeResult =
  | { ok: true; scope: EffectiveScope }
  | { ok: false; reason: ScopeDenyReason };

/**
 * Write tools whose no-argument default lands rows outside the caller's own
 * USER scope (consolidation clusters GLOBAL rows, extraction derives from the
 * session/GLOBAL store, import replays foreign payloads). A writer must not be
 * able to widen those into GLOBAL without an explicit grant; owner/admin may.
 * Deliberately narrow — `remember`/`save_lesson` write the caller's OWN scope
 * (design §5) and are not GLOBAL writes.
 */
const GLOBAL_DEFAULT_WRITE_TOOLS: readonly string[] = [
  "consolidate",
  "extract_memories",
  "import_memory",
];

/**
 * Tools where the session id is a pure row filter, not a scope target:
 * interaction reads are already bounded by `interactions.user_id`, so a session
 * id can only narrow the visible row set and can never widen it — it needs no
 * grant. This is not a widening: the identity predicate is applied first, and
 * the session predicate is ANDed on top of it (`session_id = ?` on rows the
 * caller may already read). No filter-only tool takes a project id today, so
 * project stays strict.
 */
const FILTER_ONLY_SCOPE_TOOLS: readonly string[] = [
  "search_history",
  "get_recent_interactions",
];

const NO_REQUESTED_SCOPE: ScopeRequestedFlags = Object.freeze({
  userId: false,
  sessionId: false,
  projectId: false,
});

function requestedFlags(
  userId: string | undefined,
  sessionId: string | undefined,
  projectId: string | undefined
): ScopeRequestedFlags {
  return Object.freeze({
    userId: userId !== undefined,
    sessionId: sessionId !== undefined,
    projectId: projectId !== undefined,
  });
}

export interface ScopeAuditFields {
  scopeKind: string;
  scopeRef: string | null;
}

function asScopeArg(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Audit projection of a bound scope: most specific class first, no content.
 * A granted foreign USER scope is reported as USER with the target external id.
 */
export function describeScope(scope: EffectiveScope): ScopeAuditFields {
  if (scope.sessionId != null) return { scopeKind: "SESSION", scopeRef: scope.sessionId };
  if (scope.projectId != null) return { scopeKind: "PROJECT", scopeRef: scope.projectId };
  if (scope.userId != null) return { scopeKind: "USER", scopeRef: scope.userId };
  return { scopeKind: "GLOBAL", scopeRef: GLOBAL_SCOPE_REF };
}

function allowGlobalWrite(
  identity: AuthIdentity,
  uid: number,
  permission: GrantPermission
): boolean {
  if (hasRole(identity, "owner")) return true;
  // Read tools never need the grant check; skip the query.
  if (permission !== "write") return false;
  return hasGrant(uid, "GLOBAL", GLOBAL_SCOPE_REF, "write");
}

/**
 * Bind the requested scope to the verified identity.
 *
 * Returns `{ok: false, reason}` — never a partially-trusted scope — when a
 * requested target is not reachable by the identity. In legacy mode the caller's
 * args are untouched and the scope is the legacy pass-through marker.
 */
export function bindScopeToIdentity(
  identity: AuthIdentity,
  args: Record<string, unknown>,
  toolName: string
): BindScopeResult {
  if (identity.mode === "legacy") {
    return {
      ok: true,
      scope: Object.freeze({
        mode: "legacy",
        requested: NO_REQUESTED_SCOPE,
        allowGlobalWrite: true,
      }),
    };
  }

  const uid = identity.uid;
  const externalId = identity.userId;
  // An enforced identity always carries both ids (resolveIdentity guarantees
  // it); a missing one is unusable scope, so fail closed.
  if (uid === undefined || externalId === undefined) {
    return { ok: false, reason: "scope" };
  }

  const entry = TOOL_POLICY[toolName];
  const permission: GrantPermission = entry?.kind === "write" ? "write" : "read";

  const requestedUserId = asScopeArg(args.userId);
  const requestedSessionId = asScopeArg(args.sessionId);
  const requestedProjectId = asScopeArg(args.projectId);

  let userId: string = externalId;
  let resolvedUid: number = uid;

  if (requestedUserId !== undefined && requestedUserId !== externalId) {
    if (!hasGrant(uid, "USER", requestedUserId, permission)) {
      return { ok: false, reason: "scope" };
    }
    const target = getUserByExternalId(requestedUserId);
    // A grant naming an unknown user is not a scope: fail closed.
    if (target === undefined) return { ok: false, reason: "scope" };
    userId = target.external_id;
    resolvedUid = target.id;
  }

  if (
    requestedSessionId !== undefined &&
    !FILTER_ONLY_SCOPE_TOOLS.includes(toolName) &&
    !hasGrant(uid, "SESSION", requestedSessionId, permission)
  ) {
    return { ok: false, reason: "scope" };
  }
  if (
    requestedProjectId !== undefined &&
    !hasGrant(uid, "PROJECT", requestedProjectId, permission)
  ) {
    return { ok: false, reason: "scope" };
  }

  const globalWrite = allowGlobalWrite(identity, uid, permission);
  const wantsGlobalDefault =
    permission === "write" &&
    requestedUserId === undefined &&
    requestedSessionId === undefined &&
    requestedProjectId === undefined &&
    GLOBAL_DEFAULT_WRITE_TOOLS.includes(toolName);
  if (wantsGlobalDefault && !globalWrite) {
    return { ok: false, reason: "global-write" };
  }

  return {
    ok: true,
    scope: Object.freeze({
      mode: "enforced",
      externalId,
      uid,
      userId,
      resolvedUid,
      sessionId: requestedSessionId ?? null,
      projectId: requestedProjectId ?? null,
      requested: requestedFlags(
        requestedUserId,
        requestedSessionId,
        requestedProjectId
      ),
      allowGlobalWrite: globalWrite,
    }),
  };
}

/**
 * The scope columns of an existing row (memories shape). By-id tools
 * (`forget`/`update_memory`/`link_memory`/`merge_memory`) take no scope
 * arguments, so visibility has to be answered against the ROW, not the request.
 */
export interface ScopeRowLike {
  scope: string;
  user_id?: number | null;
  session_id?: string | null;
  project_id?: string | null;
}

/**
 * May `identity` touch `row` for `permission`?
 *
 *   GLOBAL  -> always (shared by design)
 *   USER    -> own row, or a foreign row with a USER grant on that owner's
 *              external id (the grant is what the resolver bound, so the two
 *              checks agree); an unresolvable owner fails closed
 *   SESSION -> needs a grant on the row's session id
 *   PROJECT -> needs a grant on the row's project id
 *   unknown -> false (fail closed)
 *
 * Legacy returns true: callers skip the check entirely when
 * `getEffectiveScope()` is null, so this is only a defensive default.
 */
export function canAccessRow(
  identity: AuthIdentity,
  row: ScopeRowLike,
  permission: GrantPermission
): boolean {
  if (identity.mode === "legacy") return true;
  const uid = identity.uid;
  if (uid === undefined) return false;

  switch (row.scope) {
    case "GLOBAL":
      return true;
    case "USER": {
      if (row.user_id == null) return false;
      if (row.user_id === uid) return true;
      const owner = getUserById(row.user_id);
      if (owner === undefined) return false;
      return hasGrant(uid, "USER", owner.external_id, permission);
    }
    case "SESSION":
      return (
        row.session_id != null &&
        hasGrant(uid, "SESSION", row.session_id, permission)
      );
    case "PROJECT":
      return (
        row.project_id != null &&
        hasGrant(uid, "PROJECT", row.project_id, permission)
      );
    default:
      return false;
  }
}

/**
 * `preferences` / `lessons` / `interactions` carry a nullable `user_id` and no
 * grant model: NULL means shared, a non-NULL owner means that user only. Grants
 * cover USER memories, never these personal tables, so a granted foreign row is
 * still out of scope.
 */
export function canAccessPersonalRow(
  identity: AuthIdentity,
  userId: number | null
): boolean {
  if (identity.mode === "legacy") return true;
  if (identity.uid === undefined) return false;
  return userId == null || userId === identity.uid;
}

const scopeStorage = new AsyncLocalStorage<EffectiveScope>();

/**
 * Run `fn` with `scope` as the effective scope for the current async context.
 * The context survives `await`, so handlers (and the layers under them) can
 * read the bound scope without a signature change.
 */
export function runWithScope<T>(scope: EffectiveScope, fn: () => T): T {
  return scopeStorage.run(scope, fn);
}

/** The bound scope of the current async context, or null outside the guard. */
export function getEffectiveScope(): EffectiveScope | null {
  return scopeStorage.getStore() ?? null;
}
