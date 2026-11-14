import { db, nowISO } from "../index.js";

export interface AuthTokenRow {
  token_hash: string;
  user_id: number;
  label: string | null;
  created_at: string;
  revoked_at: string | null;
}

export interface AuthTokenListRow extends AuthTokenRow {
  external_id: string;
  role: string;
}

// token_hash is sha256(token) hex — the plaintext is never passed in here.
export function insertAuthToken(
  tokenHash: string,
  userId: number,
  label?: string | null
): void {
  db.prepare(
    `INSERT INTO auth_tokens (token_hash, user_id, label, created_at, revoked_at)
     VALUES (?, ?, ?, ?, NULL)`
  ).run(tokenHash, userId, label ?? null, nowISO());
}

export function findActiveByHash(tokenHash: string): AuthTokenRow | undefined {
  return db
    .prepare(
      `SELECT token_hash, user_id, label, created_at, revoked_at
         FROM auth_tokens
        WHERE token_hash = ? AND revoked_at IS NULL`
    )
    .get(tokenHash) as AuthTokenRow | undefined;
}

export function revokeByHash(tokenHash: string): boolean {
  const res = db
    .prepare(
      "UPDATE auth_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL"
    )
    .run(nowISO(), tokenHash);
  return res.changes > 0;
}

export function listTokens(): AuthTokenListRow[] {
  return db
    .prepare(
      `SELECT t.token_hash, t.user_id, t.label, t.created_at, t.revoked_at,
              u.external_id, u.role
         FROM auth_tokens t
         JOIN users u ON u.id = t.user_id
        ORDER BY t.created_at DESC, t.token_hash`
    )
    .all() as AuthTokenListRow[];
}
