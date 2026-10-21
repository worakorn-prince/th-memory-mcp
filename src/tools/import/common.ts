import { SOURCE_TYPES } from "../../memory/types.js";

// SEC-08: hard import limits. Shared by the handler (direct calls bypass zod),
// memory validation and aux validation so every entry point uses the same caps.
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 10000;
export const MAX_METADATA_BYTES = 64 * 1024;
export const MAX_PROFILE_CONTENT = 10000;
export const MAX_PROFILE_SECTION = 200;

export function isValidSource(s: string): boolean {
  return (SOURCE_TYPES as readonly string[]).includes(s);
}

// SEC-05: trust is a TOOL-LEVEL decision only. Row-level `trusted` flags in an
// import payload are never consulted (the optional ImportItem.trusted field is
// kept for backward-compatible parsing only). parseTrustedFlag stays strict:
// only boolean true is trusted, string aliases ("yes"/"true"/"1") are not.
export function parseTrustedFlag(v: unknown): boolean {
  return v === true;
}

export function withTrustedFlag(meta: unknown, trusted: unknown): unknown {
  const flag = parseTrustedFlag(trusted);
  if (meta == null) return { trusted: flag };
  if (typeof meta === "object" && !Array.isArray(meta)) {
    return { ...(meta as Record<string, unknown>), trusted: flag };
  }
  // Non-object legacy metadata cannot carry a field — wrap it so the
  // contract metadata.trusted stays readable without altering the DB schema.
  return { value: meta, trusted: flag };
}

export type ImportScopeKind = "GLOBAL" | "USER" | "SESSION" | "PROJECT";

export interface ImportScopeFields {
  userId?: unknown;
  sessionId?: unknown;
  projectId?: unknown;
}

export interface ImportScopeIdentity {
  scope: ImportScopeKind;
  userId: string | null;
  sessionId: string | null;
  projectId: string | null;
}

// SEC-03/SEC-04: shared scope identity. Precedence mirrors createMemory():
// sessionId -> SESSION, projectId -> PROJECT, userId -> USER, else GLOBAL.
// The tool-level `forcedUserId` always wins over the row's userId.
export function effectiveImportScope(
  fields: ImportScopeFields,
  forcedUserId?: string | null
): ImportScopeIdentity {
  const userId =
    typeof forcedUserId === "string"
      ? forcedUserId
      : typeof fields.userId === "string"
        ? fields.userId
        : null;
  const sessionId =
    typeof fields.sessionId === "string" ? fields.sessionId : null;
  const projectId =
    typeof fields.projectId === "string" ? fields.projectId : null;
  if (sessionId) return { scope: "SESSION", userId, sessionId, projectId };
  if (projectId) return { scope: "PROJECT", userId, sessionId, projectId };
  if (userId) return { scope: "USER", userId, sessionId, projectId };
  return { scope: "GLOBAL", userId, sessionId, projectId };
}

// Exact mirror of the checks in src/tools/link_memory.ts:
//  - either USER   -> userIds must be equal (USER vs GLOBAL is rejected
//    because one user id is null, matching link_memory's user_id comparison)
//  - either SESSION -> sessionIds must be equal
//  - both PROJECT  -> projectIds must be equal
//  - otherwise     -> allowed (e.g. PROJECT -> GLOBAL)
export function linkAllowed(
  a: ImportScopeIdentity,
  b: ImportScopeIdentity
): boolean {
  if ((a.scope === "USER" || b.scope === "USER") && a.userId !== b.userId)
    return false;
  if (
    (a.scope === "SESSION" || b.scope === "SESSION") &&
    a.sessionId !== b.sessionId
  )
    return false;
  if (
    a.scope === "PROJECT" &&
    b.scope === "PROJECT" &&
    a.projectId !== b.projectId
  )
    return false;
  return true;
}
