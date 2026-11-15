// config: shared constants. Pure module — no side effects, no I/O.
import { fileURLToPath } from "node:url";

// Keep this in sync with package.json.  It is surfaced in the MCP handshake
// and in export files, so a stale value makes backups harder to diagnose.
export const VERSION = "2.5.2";

// dist/lib/config.js -> <project>/data/memory.db (independent of cwd).
export const DEFAULT_DB_PATH = fileURLToPath(
  new URL("../../data/memory.db", import.meta.url)
);

export const EXPORTS_DIRNAME = "exports";

// --- Authentication (opt-in, Ph-1) ---------------------------------------
// Pure getters: no I/O, no caching, no side effects. The token file itself is
// read in src/auth/identity.ts (only when MEMORY_AUTH is on).

export type AuthSwitch = "off" | "on";

function envValue(
  env: NodeJS.ProcessEnv,
  name: string
): string | undefined {
  const raw = env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Unset/empty -> "off" (v2.5.2 behaviour). Anything that is not an explicit
// off value is treated as "on" (fail closed): a typo must not silently
// downgrade an operator who meant to require authentication.
export function getAuthMode(env: NodeJS.ProcessEnv = process.env): AuthSwitch {
  const raw = envValue(env, "MEMORY_AUTH");
  if (raw === undefined) return "off";
  const v = raw.toLowerCase();
  if (v === "off" || v === "0" || v === "false" || v === "no" || v === "n") {
    return "off";
  }
  return "on";
}

export function getAuthToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return envValue(env, "MEMORY_AUTH_TOKEN");
}

export function getAuthTokenFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return envValue(env, "MEMORY_AUTH_TOKEN_FILE");
}

// --- Encryption (opt-in, Ph-4) ---------------------------------------------

export type EncryptionSwitch = "off" | "on";

export function getEncryptionMode(env: NodeJS.ProcessEnv = process.env): EncryptionSwitch {
  const raw = envValue(env, "MEMORY_ENCRYPTION");
  if (raw === undefined) return "off";
  const v = raw.toLowerCase();
  if (v === "off" || v === "0" || v === "false" || v === "no" || v === "n") {
    return "off";
  }
  return "on";
}

export function getEncryptionKey(env: NodeJS.ProcessEnv = process.env): Uint8Array | undefined {
  const raw = envValue(env, "MEMORY_ENCRYPTION_KEY");
  if (raw === undefined) return undefined;
  try {
    const decoded = Buffer.from(raw, "base64");
    if (decoded.length !== 32) return undefined;
    return new Uint8Array(decoded);
  } catch {
    return undefined;
  }
}

export function getEncryptionKdfIter(env: NodeJS.ProcessEnv = process.env): number {
  const raw = envValue(env, "MEMORY_ENCRYPTION_KDF_ITER");
  if (raw === undefined) return 256000; // SQLCipher default
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : 256000;
}
