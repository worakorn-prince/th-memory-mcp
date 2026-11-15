/**
 * Scope grants (Ph-3, task TASK-AUTH-P3-SCOPE).
 *
 * A grant is one permission (`read` | `write`) on one scope target
 * (`USER` / `PROJECT` / `SESSION` / `GLOBAL`) for one user. It is the ONLY way a
 * caller can act outside their own identity-derived scope, so the permission
 * model is deliberately non-escalatable:
 *
 *   - `write` on (kind, ref) implies `read` on the same (kind, ref)
 *   - `read` on (kind, ref) never implies `write`
 *
 * GLOBAL writes are expressed as `(scope_kind='GLOBAL', scope_ref='*',
 * permission='write')`. `USER` grants use the target's external id as
 * `scope_ref` (the same value a caller passes as `userId`), so no id mapping is
 * needed at check time. Writes are idempotent (UNIQUE) so admin scripts and
 * retries are safe.
 */
import { db, nowISO } from "../index.js";

export const SCOPE_KINDS = ["USER", "PROJECT", "SESSION", "GLOBAL"] as const;
export type ScopeKind = (typeof SCOPE_KINDS)[number];

export const GRANT_PERMISSIONS = ["read", "write"] as const;
export type GrantPermission = (typeof GRANT_PERMISSIONS)[number];

/** `scope_ref` used for GLOBAL grants (the only GLOBAL target). */
export const GLOBAL_SCOPE_REF = "*";

const MAX_REF = 200;

export interface ScopeGrantRow {
  id: number;
  grantee_user_id: number;
  scope_kind: string;
  scope_ref: string;
  permission: string;
  granted_by: number | null;
  created_at: string;
}

export function isScopeKind(value: unknown): value is ScopeKind {
  return (
    typeof value === "string" && (SCOPE_KINDS as readonly string[]).includes(value)
  );
}

export function isGrantPermission(value: unknown): value is GrantPermission {
  return (
    typeof value === "string" &&
    (GRANT_PERMISSIONS as readonly string[]).includes(value)
  );
}

function isValidRef(ref: unknown): ref is string {
  return (
    typeof ref === "string" &&
    ref.length > 0 &&
    ref.length <= MAX_REF &&
    !/[\x00-\x1f]/.test(ref)
  );
}

function assertGrantTarget(
  granteeUid: number,
  kind: ScopeKind,
  ref: string,
  permission: GrantPermission
): void {
  if (!Number.isInteger(granteeUid) || granteeUid <= 0) {
    throw new Error("grantee uid must be a positive integer");
  }
  if (!isScopeKind(kind)) {
    throw new Error(`invalid scope kind "${String(kind)}" (expected ${SCOPE_KINDS.join("|")})`);
  }
  if (!isValidRef(ref)) {
    throw new Error(`invalid scope ref (1-${MAX_REF} chars, no control characters)`);
  }
  if (!isGrantPermission(permission)) {
    throw new Error(
      `invalid permission "${String(permission)}" (expected ${GRANT_PERMISSIONS.join("|")})`
    );
  }
}

/**
 * Does `granteeUid` hold `permission` on (kind, ref)?
 *
 * `write` requires an explicit write row; `read` accepts read or write. An
 * invalid kind/permission/target answers false (fail-closed), never true.
 */
export function hasGrant(
  granteeUid: number,
  kind: ScopeKind,
  ref: string,
  permission: GrantPermission
): boolean {
  if (!Number.isInteger(granteeUid) || granteeUid <= 0) return false;
  if (!isScopeKind(kind)) return false;
  if (!isValidRef(ref)) return false;
  if (!isGrantPermission(permission)) return false;

  const row =
    permission === "write"
      ? db
          .prepare(
            `SELECT 1 AS hit FROM scope_grants
             WHERE grantee_user_id = ? AND scope_kind = ? AND scope_ref = ?
               AND permission = 'write'
             LIMIT 1`
          )
          .get(granteeUid, kind, ref)
      : db
          .prepare(
            `SELECT 1 AS hit FROM scope_grants
             WHERE grantee_user_id = ? AND scope_kind = ? AND scope_ref = ?
               AND permission IN ('read', 'write')
             LIMIT 1`
          )
          .get(granteeUid, kind, ref);
  return row !== undefined;
}

/**
 * Add a grant (idempotent: a duplicate target is a no-op) and return its id.
 * `grantedBy` is stored for audit purposes only; it grants nothing extra.
 */
export function addGrant(
  granteeUid: number,
  kind: ScopeKind,
  ref: string,
  permission: GrantPermission,
  grantedBy: number | null = null
): number {
  assertGrantTarget(granteeUid, kind, ref, permission);
  if (grantedBy !== null && (!Number.isInteger(grantedBy) || grantedBy <= 0)) {
    throw new Error("grantedBy must be a positive integer or null");
  }
  db.prepare(
    `INSERT INTO scope_grants
       (grantee_user_id, scope_kind, scope_ref, permission, granted_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(grantee_user_id, scope_kind, scope_ref, permission) DO NOTHING`
  ).run(granteeUid, kind, ref, permission, grantedBy, nowISO());

  const row = db
    .prepare(
      `SELECT id FROM scope_grants
       WHERE grantee_user_id = ? AND scope_kind = ? AND scope_ref = ?
         AND permission = ?`
    )
    .get(granteeUid, kind, ref, permission) as { id: number } | undefined;
  if (row === undefined) throw new Error("grant insert failed");
  return row.id;
}

/** Remove one grant. Idempotent: removing a missing grant returns false. */
export function removeGrant(
  granteeUid: number,
  kind: ScopeKind,
  ref: string,
  permission: GrantPermission
): boolean {
  if (!Number.isInteger(granteeUid) || !isScopeKind(kind) || !isValidRef(ref)) {
    return false;
  }
  if (!isGrantPermission(permission)) return false;
  const info = db
    .prepare(
      `DELETE FROM scope_grants
       WHERE grantee_user_id = ? AND scope_kind = ? AND scope_ref = ?
         AND permission = ?`
    )
    .run(granteeUid, kind, ref, permission);
  return info.changes > 0;
}

/** List grants, optionally for one grantee, oldest first (deterministic). */
export function listGrants(granteeUid?: number): ScopeGrantRow[] {
  if (granteeUid === undefined) {
    return db
      .prepare(
        `SELECT id, grantee_user_id, scope_kind, scope_ref, permission,
                granted_by, created_at
         FROM scope_grants ORDER BY id`
      )
      .all() as ScopeGrantRow[];
  }
  return db
    .prepare(
      `SELECT id, grantee_user_id, scope_kind, scope_ref, permission,
              granted_by, created_at
       FROM scope_grants WHERE grantee_user_id = ? ORDER BY id`
    )
    .all(granteeUid) as ScopeGrantRow[];
}
