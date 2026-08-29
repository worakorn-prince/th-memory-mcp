import { db, nowISO } from "../index.js";

// Resolve or create a user by external identity (what clients pass as `userId`).
// Returns the internal user id.
export function ensureUser(externalId: string, name?: string): number {
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
