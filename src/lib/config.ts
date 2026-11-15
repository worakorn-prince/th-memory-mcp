// config: shared constants and environment getters.
//
// Getter modules stay free of side effects at import time. The one exception is
// key resolution (Ph-6 C2): `resolveEncryptionKey()` reads a key file or runs a
// key command, but only when it is called AND MEMORY_ENCRYPTION=on.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Keep this in sync with package.json.  It is surfaced in the MCP handshake
// and in export files, so a stale value makes backups harder to diagnose.
export const VERSION = "3.0.1";

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

/** size of the AES key SQLCipher is configured with */
const KEY_BYTES = 32;
/** C2: the key command is bounded in time, output, and (on Windows) windows. */
const KEY_CMD_TIMEOUT_MS = 5000;
const KEY_CMD_MAX_BUFFER = 64 * 1024;
/** Every stderr line this module writes stays this short. */
const WARNING_MAX = 200;

/** Where a resolved key came from, highest priority first. */
export type EncryptionKeySource = "env" | "file" | "cmd";

export interface EncryptionKeyResolution {
  /** The 32-byte key, or undefined when no provider produced one. */
  key?: Uint8Array;
  source?: EncryptionKeySource;
  /**
   * One bounded line explaining why a configured provider failed. Never
   * contains key material, a key path, or the command's output.
   */
  error?: string;
}

function warnEncryption(message: string): void {
  const flat = message.replace(/[\r\n]+/g, " ").trim().slice(0, WARNING_MAX);
  if (flat.length === 0) return;
  try {
    process.stderr.write(`[th-memory-mcp] encryption: ${flat}\n`);
  } catch {
    /* stderr unavailable: resolution still works, the warning is lost */
  }
}

/**
 * Strict base64 → 32 bytes. Standard and URL-safe alphabets are accepted; a
 * shorter/longer decode, or any character outside the alphabet, is rejected so
 * a garbage provider cannot silently become a key.
 */
function decodeKeyBase64(raw: string): Uint8Array | undefined {
  const normalized = raw.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (normalized.length === 0) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return undefined;
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length !== KEY_BYTES) return undefined;
  return new Uint8Array(decoded);
}

/** Paths already warned about, so a repeated resolution cannot spam. */
const _insecureKeyFiles = new Set<string>();

/** Mirrors the token-file warning in src/auth/identity.ts (POSIX only). */
function warnIfKeyFileGroupWorldReadable(path: string): void {
  if (process.platform === "win32") return;
  if (_insecureKeyFiles.has(path)) return;
  try {
    if ((statSync(path).mode & 0o077) !== 0) {
      _insecureKeyFiles.add(path);
      warnEncryption(
        "MEMORY_ENCRYPTION_KEY_FILE is group/world readable (chmod 600 recommended)"
      );
    }
  } catch {
    /* stat failure is reported by the read that failed/succeeded */
  }
}

/**
 * Split a command line into argv without a shell. Whitespace separates tokens;
 * single and double quotes group them; inside quotes every character is
 * literal (backslashes matter on Windows paths and are never escapes here).
 */
export function splitCommandLine(line: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quoted: '"' | "'" | null = null;
  let started = false;
  for (const ch of line) {
    if (quoted !== null) {
      if (ch === quoted) quoted = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quoted = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

function commandFailure(e: unknown): string {
  const info = (typeof e === "object" && e !== null ? e : {}) as {
    signal?: unknown;
    status?: unknown;
    code?: unknown;
  };
  if (info.code === "ETIMEDOUT" || info.signal === "SIGTERM") {
    return `MEMORY_ENCRYPTION_KEY_CMD timed out after ${KEY_CMD_TIMEOUT_MS} ms`;
  }
  if (info.code === "ENOENT") return "MEMORY_ENCRYPTION_KEY_CMD could not be started";
  if (info.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return "MEMORY_ENCRYPTION_KEY_CMD produced more than 64 KiB of output";
  }
  if (typeof info.status === "number") {
    return `MEMORY_ENCRYPTION_KEY_CMD exited with status ${info.status}`;
  }
  return "MEMORY_ENCRYPTION_KEY_CMD failed";
}

/** Run the operator's key command (no shell) and decode its stdout. */
function resolveCommandKey(commandLine: string): EncryptionKeyResolution {
  const argv = splitCommandLine(commandLine);
  if (argv.length === 0) {
    return { error: "MEMORY_ENCRYPTION_KEY_CMD is empty" };
  }
  let stdout: string;
  try {
    stdout = execFileSync(argv[0] as string, argv.slice(1), {
      encoding: "utf8",
      timeout: KEY_CMD_TIMEOUT_MS,
      maxBuffer: KEY_CMD_MAX_BUFFER,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    return { error: commandFailure(e) };
  }
  if (stdout.trim().length === 0) {
    return { error: "MEMORY_ENCRYPTION_KEY_CMD produced no output" };
  }
  const key = decodeKeyBase64(stdout);
  if (key === undefined) {
    return { error: "MEMORY_ENCRYPTION_KEY_CMD did not produce a valid 32-byte key" };
  }
  return { key, source: "cmd" };
}

/**
 * C2 key providers, resolved in this order (highest first):
 *
 *   1. MEMORY_ENCRYPTION_KEY       — inline base64 (existing behaviour)
 *   2. MEMORY_ENCRYPTION_KEY_FILE  — file whose trimmed contents are the base64 key
 *   3. MEMORY_ENCRYPTION_KEY_CMD   — a command line printing the base64 key
 *
 * Exactly one provider is effective. When more are set, the highest-priority
 * one is used and one bounded stderr line names what was ignored. A failing
 * provider never falls back (a typo must not silently pick another key).
 *
 * Legacy (MEMORY_ENCRYPTION off/unset) resolves to nothing and reads/executes
 * neither the file nor the command.
 */
export function resolveEncryptionKey(
  env: NodeJS.ProcessEnv = process.env
): EncryptionKeyResolution {
  if (getEncryptionMode(env) === "off") return {};

  const inline = envValue(env, "MEMORY_ENCRYPTION_KEY");
  const filePath = envValue(env, "MEMORY_ENCRYPTION_KEY_FILE");
  const command = envValue(env, "MEMORY_ENCRYPTION_KEY_CMD");

  const configured: { name: string; source: EncryptionKeySource }[] = [];
  if (inline !== undefined) configured.push({ name: "MEMORY_ENCRYPTION_KEY", source: "env" });
  if (filePath !== undefined) configured.push({ name: "MEMORY_ENCRYPTION_KEY_FILE", source: "file" });
  if (command !== undefined) configured.push({ name: "MEMORY_ENCRYPTION_KEY_CMD", source: "cmd" });

  if (configured.length === 0) return {};
  const chosen = configured[0] as { name: string; source: EncryptionKeySource };
  if (configured.length > 1) {
    warnEncryption(
      `${chosen.name} takes precedence; ignoring ${configured
        .slice(1)
        .map((c) => c.name)
        .join(" and ")}`
    );
  }

  if (chosen.source === "env") {
    const key = decodeKeyBase64(inline as string);
    return key === undefined
      ? { error: "MEMORY_ENCRYPTION_KEY is not a valid base64-encoded 32-byte key" }
      : { key, source: "env" };
  }

  if (chosen.source === "file") {
    let raw: string;
    try {
      raw = readFileSync(filePath as string, "utf8");
    } catch {
      return { error: "MEMORY_ENCRYPTION_KEY_FILE is unreadable" };
    }
    warnIfKeyFileGroupWorldReadable(filePath as string);
    const key = decodeKeyBase64(raw);
    return key === undefined
      ? { error: "MEMORY_ENCRYPTION_KEY_FILE did not produce a valid 32-byte key" }
      : { key, source: "file" };
  }

  return resolveCommandKey(command as string);
}

/** Backwards-compatible accessor: the effective key, if any. */
export function getEncryptionKey(env: NodeJS.ProcessEnv = process.env): Uint8Array | undefined {
  return resolveEncryptionKey(env).key;
}

export function getEncryptionKdfIter(env: NodeJS.ProcessEnv = process.env): number {
  const raw = envValue(env, "MEMORY_ENCRYPTION_KDF_ITER");
  if (raw === undefined) return 256000; // SQLCipher default
  const n = parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : 256000;
}
