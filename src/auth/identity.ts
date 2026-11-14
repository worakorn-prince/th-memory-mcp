/**
 * Identity resolution (Ph-1, opt-in via MEMORY_AUTH).
 *
 * Each MCP client launches its own stdio server process, so identity is
 * established ONCE from the process environment at startup — never from MCP
 * tool arguments. `userId` / `sessionId` / `projectId` are at most checks,
 * never authority (see ADR-AUTH-P0-SPIKE §6).
 *
 * Failure is fail-fast: with MEMORY_AUTH=on an unresolved identity throws
 * AuthError (src/index.ts turns that into one bounded stderr line + exit 2).
 * There is no plaintext fallback to legacy mode.
 */
import { readFileSync, statSync } from "node:fs";
import { getAuthMode, getAuthToken, getAuthTokenFile } from "../lib/config.js";
import { findActiveByHash } from "../db/repositories/auth_tokens.js";
import {
  ensureUser,
  getUserByExternalId,
  getUserById,
} from "../db/repositories/users.js";
import { hashToken, isValidTokenFormat, verifyToken } from "./token.js";

export type AuthMode = "legacy" | "enforced";

export type Role = "reader" | "writer" | "owner" | "admin";

export const ROLES: readonly Role[] = ["reader", "writer", "owner", "admin"];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export interface AuthIdentity {
  mode: AuthMode;
  /** External user id (users.external_id); undefined in legacy mode. */
  userId?: string;
  /** Internal numeric id (users.id); undefined in legacy mode. */
  uid?: number;
  /** Populated from users.role in enforced mode; [] in legacy mode. */
  roles: Role[];
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

const GENERIC_FAILURE = "authentication failed (invalid, revoked, or unknown token)";

function readTokenFromEnv(env: NodeJS.ProcessEnv): string | undefined {
  const inline = getAuthToken(env);
  if (inline !== undefined) return inline;

  const file = getAuthTokenFile(env);
  if (file === undefined) return undefined;

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new AuthError("MEMORY_AUTH is on but MEMORY_AUTH_TOKEN_FILE is unreadable");
  }
  warnIfGroupWorldReadable(file);
  const token = raw.trim();
  return token.length > 0 ? token : undefined;
}

// Documented, not enforced: cross-platform ACL detection is unreliable, so a
// loose permission is a one-line stderr warning (POSIX only).
function warnIfGroupWorldReadable(path: string): void {
  if (process.platform === "win32") return;
  try {
    if ((statSync(path).mode & 0o077) !== 0) {
      process.stderr.write(
        "[th-memory-mcp] auth: token file is group/world readable (chmod 600 recommended)\n"
      );
    }
  } catch {
    /* stat failure is reported by the read above */
  }
}

/**
 * Pure-ish resolution: reads env + DB, never creates users. Throws AuthError
 * when MEMORY_AUTH=on and the token is missing/invalid/revoked/unknown.
 */
export function resolveIdentity(env: NodeJS.ProcessEnv = process.env): AuthIdentity {
  if (getAuthMode(env) === "off") return { mode: "legacy", roles: [] };

  const token = readTokenFromEnv(env);
  if (token === undefined) {
    throw new AuthError(
      "MEMORY_AUTH is on but no token was provided (set MEMORY_AUTH_TOKEN or MEMORY_AUTH_TOKEN_FILE)"
    );
  }
  if (!isValidTokenFormat(token)) throw new AuthError(GENERIC_FAILURE);

  const row = findActiveByHash(hashToken(token));
  if (row === undefined) throw new AuthError(GENERIC_FAILURE);
  if (!verifyToken(token, row.token_hash)) throw new AuthError(GENERIC_FAILURE);

  const user = getUserById(row.user_id);
  if (user === undefined) throw new AuthError(GENERIC_FAILURE);

  const role: Role = isRole(user.role) ? user.role : "reader";
  return {
    mode: "enforced",
    userId: user.external_id,
    uid: user.id,
    roles: [role],
  };
}

// Module singleton: set once at startup (src/index.ts) and read by the write
// path (and, in Ph-2, by the per-tool guard).
let _identity: AuthIdentity | null = null;

export function setIdentity(identity: AuthIdentity | null): void {
  _identity = identity;
}

/** Startup singleton; lazily resolves on first use when not set explicitly. */
export function getIdentity(): AuthIdentity {
  if (_identity === null) _identity = resolveIdentity(process.env);
  return _identity;
}

/**
 * Map a caller-supplied userId to an internal uid.
 *
 * legacy   -> ensureUser (v2.5.2 behaviour: auto-create)
 * enforced -> existing user only; unknown ids throw and create no row (T2).
 *             identity-vs-userId ownership binding is Ph-3.
 */
export function resolveWriterUserId(externalId: string): number {
  const identity = getIdentity();
  if (identity.mode === "legacy") return ensureUser(externalId);

  const existing = getUserByExternalId(externalId);
  if (existing === undefined) {
    throw new Error("unknown user (auth enforced; no auto-create)");
  }
  return existing.id;
}
