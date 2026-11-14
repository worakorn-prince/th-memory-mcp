/**
 * Token format (frozen, ADR-AUTH-P0-SPIKE §6):
 *
 *   thm_<userId>_<base64url(32 random bytes)>
 *
 * Why SHA-256 and NOT a password KDF (scrypt / PBKDF2 / argon2):
 * the secret half comes from crypto.randomBytes(32) — a 256-bit uniformly
 * random value. Offline guessing is already infeasible, so a deliberately slow
 * KDF would buy no security and would only add startup latency. A KDF is the
 * right tool for human-chosen passphrases; these tokens are not passphrases.
 *
 * Tokens are hash-only at rest (sha256 hex). The plaintext leaves the process
 * exactly once, on the `th-memory auth issue-token` stdout print.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const TOKEN_PREFIX = "thm_";
const RANDOM_BYTES = 32;
// base64url without padding: ceil(32 / 3) * 4 - padding = 43 chars.
const SUFFIX_LENGTH = 43;
const SUFFIX_RE = /^[A-Za-z0-9_-]+$/;
const TOKEN_RE = /^thm_([^\x00-\x1f]{1,200})_([A-Za-z0-9_-]{43})$/;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export const TOKEN_FORMAT_HINT =
  "expected thm_<userId>_<43-char base64url secret>";

/** Same rules as ensureUser(): 1-200 chars, no control characters. */
export function isValidUserId(userId: string): boolean {
  if (typeof userId !== "string") return false;
  if (userId.length === 0 || userId.length > 200) return false;
  return !/[\x00-\x1f]/.test(userId);
}

/** Validate the exact frozen shape (prefix, user segment, 43-char secret). */
export function isValidTokenFormat(token: string): boolean {
  if (typeof token !== "string") return false;
  if (!TOKEN_RE.test(token)) return false;
  const suffix = token.slice(token.length - SUFFIX_LENGTH);
  return SUFFIX_RE.test(suffix);
}

export function generateToken(userId: string): string {
  if (!isValidUserId(userId)) {
    throw new Error("userId must be 1-200 chars without control characters");
  }
  const suffix = randomBytes(RANDOM_BYTES).toString("base64url");
  return `${TOKEN_PREFIX}${userId}_${suffix}`;
}

/** sha256 hex — the only representation ever persisted. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Defence in depth: the DB lookup is already by token_hash, but the final
 * comparison still runs through crypto.timingSafeEqual so an attacker who can
 * influence both sides cannot learn anything from timing.
 */
export function verifyToken(candidate: string, storedHash: string): boolean {
  if (typeof candidate !== "string" || typeof storedHash !== "string") return false;
  if (!isValidTokenFormat(candidate)) return false;
  const stored = storedHash.trim().toLowerCase();
  if (!SHA256_HEX_RE.test(stored)) return false;
  const a = Buffer.from(hashToken(candidate), "hex");
  const b = Buffer.from(stored, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** First `length` chars of a hash, for display (never the plaintext). */
export function hashPrefix(tokenHash: string, length = 12): string {
  const hex = tokenHash.trim().toLowerCase();
  return hex.slice(0, Math.max(0, length));
}
