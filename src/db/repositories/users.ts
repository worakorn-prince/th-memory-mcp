import { db, nowISO } from "../index.js";
import type { Role } from "../../auth/identity.js";

export interface UserRow {
  id: number;
  external_id: string;
  name: string | null;
  role: string;
  created_at: string;
}

const USER_ROLES: readonly string[] = ["reader", "writer", "owner", "admin"];

// Resolve or create a user by external identity (what clients pass as `userId`).
// Returns the internal user id.
// Admin CLI / legacy mode only: with MEMORY_AUTH=on the write path goes through
// resolveWriterUserId() and must never mint users.
export function ensureUser(externalId: string, name?: string): number {
  if (externalId.length === 0 || externalId.length > 200) throw new Error("externalId must be 1-200 chars");
  if (/[\x00-\x1f]/.test(externalId)) throw new Error("externalId contains invalid characters");
  const existing = db
    .prepare("SELECT id FROM users WHERE external_id = ?")
    .get(externalId) as { id: number } | undefined;
  if (existing) return existing.id;
  const res = db
    .prepare("INSERT INTO users (external_id, name, created_at) VALUES (?, ?, ?)")
    .run(externalId, name ?? null, nowISO());
  return Number(res.lastInsertRowid);
}

// Map an external user id to its internal id, or null if unknown/absent.
export function resolveUserId(externalId?: string | null): number | null {
  if (!externalId) return null;
  const r = db
    .prepare("SELECT id FROM users WHERE external_id = ?")
    .get(externalId) as { id: number } | undefined;
  return r ? r.id : null;
}

export function getUserByExternalId(externalId: string): UserRow | undefined {
  return db
    .prepare(
      "SELECT id, external_id, name, role, created_at FROM users WHERE external_id = ?"
    )
    .get(externalId) as UserRow | undefined;
}

export function getUserById(id: number): UserRow | undefined {
  return db
    .prepare(
      "SELECT id, external_id, name, role, created_at FROM users WHERE id = ?"
    )
    .get(id) as UserRow | undefined;
}

export function listUsers(): UserRow[] {
  return db
    .prepare("SELECT id, external_id, name, role, created_at FROM users ORDER BY external_id")
    .all() as UserRow[];
}

export function setUserRole(externalId: string, role: Role | string): void {
  if (!USER_ROLES.includes(role)) {
    throw new Error(`invalid role "${role}" (expected ${USER_ROLES.join("|")})`);
  }
  const res = db
    .prepare("UPDATE users SET role = ? WHERE external_id = ?")
    .run(role, externalId);
  if (res.changes === 0) throw new Error(`unknown user "${externalId}"`);
}
