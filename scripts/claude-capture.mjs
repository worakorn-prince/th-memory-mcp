// claude-capture.mjs — Claude Code hooks bridge for th-memory-mcp.
//
// Replicates the OpenCode auto-capture plugin (src/plugin/learning-capture.ts)
// on Claude Code: captures user prompts + tool calls into the SAME SQLite DB
// the MCP server uses, and (on UserPromptSubmit) injects the memory profile
// back into context — the closest equivalent to OpenCode's
// "experimental.session.compacting" injection.
//
// Wire it up in ~/.claude/settings.json (see CLAUDE_CODE_HOOKS.md):
//   UserPromptSubmit -> node <repo>/scripts/claude-capture.mjs
//   PostToolUse      -> node <repo>/scripts/claude-capture.mjs
//
// Hooks MUST never block Claude Code, so every failure is swallowed and the
// process always exits 0 with valid JSON on stdout.
import Database from "better-sqlite3-multiple-ciphers";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath as urlPath } from "node:url";
import { spawn } from "node:child_process";

const DEFAULT_DB_PATH = urlPath(
  new URL("../../data/memory.db", import.meta.url)
);
const DEFAULT_HOOK_LOG_PATH = urlPath(
  new URL("../../data/hook-errors.log", import.meta.url)
);
const sensitiveValues = new Set();

// --- sync with src/lib/capture-core.ts (do not drift — keep SECRET_PATTERNS + filterSecrets identical) ---
const SECRET_PATTERNS = [
  /(api[_-]?key|secret|token|password|auth|bearer|credential|private[_-]?key|access[_-]?key|database[_-]?url|connection[_-]?string)\s*[=:]\s*\S+/i,
  /(sk-[a-zA-Z0-9]{20,})/i,
  /(ghp_[a-zA-Z0-9]{36})/i,
  /(glpat-[a-zA-Z0-9\-]{20,})/i,
  /(Bearer\s+[a-zA-Z0-9\-_]+)/i,
  /(-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----)/i,
];
const LIMITS = { prompt: 4000, tool_call: 500, error: 500 };
const INSERT_SQL =
  "INSERT INTO interactions (ts, session_id, kind, content, meta) VALUES (?, ?, ?, ?, ?)";
const INTERACTIONS_DDL = `
CREATE TABLE IF NOT EXISTS interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  meta TEXT
);`;

const PROFILE_MAX_CHARS = 3000;

function filterSecrets(text) {
  return text
    .split("\n")
    .map((line) => {
      for (const p of SECRET_PATTERNS) {
        if (p.test(line)) return line.replace(p, "[REDACTED]");
      }
      return line;
    })
    .join("\n");
}

function truncate(text, max) {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + "…";
}

// --- keep in sync with `src/lib/config.ts` `getEncryptionMode()` ---
function getHookEncryptionMode(env = process.env) {
  const raw =
    typeof env.MEMORY_ENCRYPTION === "string"
      ? env.MEMORY_ENCRYPTION.trim()
      : "";
  if (raw.length === 0) return "off";
  const value = raw.toLowerCase();
  if (value === "off" || value === "0" || value === "false" || value === "no" || value === "n") {
    return "off";
  }
  return "on";
}

function getDbPath() {
  return typeof process.env.MEMORY_DB_PATH === "string" &&
    process.env.MEMORY_DB_PATH
    ? process.env.MEMORY_DB_PATH
    : DEFAULT_DB_PATH;
}

function getHookLogPath() {
  const dbPath = getDbPath();
  if (dbPath === DEFAULT_DB_PATH) return DEFAULT_HOOK_LOG_PATH;
  return join(dirname(dbPath), "hook-errors.log");
}

function addSensitiveValue(value) {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed.length > 0) sensitiveValues.add(trimmed);
}

function redactSensitive(text) {
  let safe = String(text ?? "");
  for (const value of sensitiveValues) {
    safe = safe.split(value).join("[REDACTED]");
  }
  return safe.replace(/[\r\n]+/g, " ").trim().slice(0, 500);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function logHookError(msg) {
  try {
    const hookLogPath = getHookLogPath();
    mkdirSync(dirname(hookLogPath), { recursive: true });
    const line = `[${new Date().toISOString()}] ${redactSensitive(msg)}\n`;
    appendFileSync(hookLogPath, line, "utf8");
  } catch {}
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", (error) => {
      logHookError(`stdin read failed: ${errorMessage(error)}`);
      resolve("");
    });
  });
}

function emit(obj) {
  process.stdout.write(JSON.stringify(obj ?? {}));
}

// Only the first emit wins — the finally block must not overwrite a
// meaningful additionalContext with a trailing `{}`.
let emitted = false;
function emitOnce(obj) {
  if (emitted) return;
  emitted = true;
  emit(obj);
}

function fmtConfidence(c) {
  const n = Number(c);
  if (!Number.isFinite(n)) return "(0)";
  return String(Math.round(n * 100) / 100);
}

function buildProfileText(dbi) {
  const parts = [];
  const safe = (sql) => {
    try {
      return dbi.prepare(sql).all();
    } catch {
      return [];
    }
  };
  let rows = safe("SELECT section, content FROM profile");
    if (rows.length > 0) {
      parts.push("## User Memory Profile");
      for (const r of rows) {
        const section = typeof r.section === "string" ? r.section : "";
        const content = typeof r.content === "string" ? r.content : "";
        if (section || content) parts.push(`${section}: ${content}`);
      }
    }
    rows = safe(
      "SELECT category, key, value, confidence FROM preferences ORDER BY confidence DESC LIMIT 15"
    );
    if (rows.length > 0) {
      parts.push("## Preferences");
      for (const r of rows) {
        parts.push(
          `- ${r.category}/${r.key}: ${r.value} (${fmtConfidence(r.confidence)})`
        );
      }
    }
    rows = safe(
      "SELECT situation, mistake, correction FROM lessons ORDER BY created_at DESC LIMIT 5"
    );
    if (rows.length > 0) {
      parts.push("## Recent Lessons");
      for (const r of rows) {
        parts.push(
          `- situation=${r.situation}; mistake=${r.mistake}; correction=${r.correction}`
        );
      }
    }
  let text = parts.join("\n");
  if (text.length > PROFILE_MAX_CHARS) {
    text = text.slice(0, PROFILE_MAX_CHARS - 1) + "…";
  }
  return text;
}

async function openDb() {
  const path = getDbPath();
  mkdirSync(dirname(path), { recursive: true });

  if (getHookEncryptionMode() === "off") {
    const db = new Database(path);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.exec(INTERACTIONS_DDL);
    return db;
  }

  const config = await import("../dist/lib/config.js");
  const resolution = config.resolveEncryptionKey();
  const key = resolution.key;
  if (!key) {
    const reason =
      resolution.error ??
      "no key was provided (set MEMORY_ENCRYPTION_KEY, MEMORY_ENCRYPTION_KEY_FILE, or MEMORY_ENCRYPTION_KEY_CMD)";
    throw new Error(`MEMORY_ENCRYPTION=on but ${reason}`);
  }
  addSensitiveValue(Buffer.from(key).toString("base64"));
  addSensitiveValue(Buffer.from(key).toString("hex"));

  const kdfIter = config.getEncryptionKdfIter();
  const { openEncryptedDB, isPlaintextDB } = await import(
    "../dist/db/encryption.js"
  );
  if (isPlaintextDB(path)) {
    throw new Error(
      "refusing to open a plaintext database while MEMORY_ENCRYPTION=on; start the MCP server to migrate it first"
    );
  }

  const db = openEncryptedDB(path, key, kdfIter);
  db.exec(INTERACTIONS_DDL);
  return db;
}

async function main() {
  addSensitiveValue(process.env.MEMORY_ENCRYPTION_KEY);

  let db = null;
  try {
    db = await openDb();
  } catch (error) {
    logHookError(`database open failed: ${errorMessage(error)}`);
    emitOnce({});
    return;
  }

  try {
    const insertStmt = db.prepare(INSERT_SQL);

    function insert(kind, content, opts) {
      const ts = new Date().toISOString();
      const sessionId = opts?.sessionId ?? null;
      const meta = JSON.stringify(opts?.meta ?? null);
      const safe = filterSecrets(truncate(content, LIMITS[kind] ?? 500));
      if (!safe.trim()) return;
      // lightweight cross-invocation dedupe: skip identical row within 3s
      const dup = db
        .prepare(
          "SELECT id FROM interactions WHERE kind=? AND content=? AND session_id IS ? AND ts > datetime('now','-3 seconds') LIMIT 1"
        )
        .get(kind, safe, sessionId);
      if (dup) return;
      insertStmt.run(ts, sessionId, kind, safe, meta);
    }

    const raw = await readStdin();
    try {
      const ev = raw ? JSON.parse(raw) : {};
      const sessionId =
        typeof ev.session_id === "string" ? ev.session_id : undefined;

      if (ev.hook_event_name === "UserPromptSubmit") {
        const prompt = typeof ev.prompt === "string" ? ev.prompt : "";
        if (prompt.trim()) insert("prompt", prompt, { sessionId });
        const profile = buildProfileText(db);
        if (profile) {
          emitOnce({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: profile } });
          return;
        }
      } else if (ev.hook_event_name === "PostToolUse") {
        const tool = typeof ev.tool_name === "string" ? ev.tool_name : "";
        const resp = typeof ev.tool_response === "string" ? ev.tool_response : JSON.stringify(ev.tool_response ?? "");
        const isError = /"is_error"\s*:\s*true/i.test(resp) || /error/i.test(resp.slice(0, 200));
        insert("tool_call", `tool=${tool}`, {
          sessionId,
          meta: { tool, status: isError ? "error" : "success" },
        });
      } else if (ev.hook_event_name === "PreCompact") {
        // Keep memory across compaction: inject the profile into the
        // compacted context (mirrors OpenCode's experimental.session.compacting).
        const profile = buildProfileText(db);
        if (profile) {
          emitOnce({ hookSpecificOutput: { hookEventName: "PreCompact", additionalContext: profile } });
          return;
        }
      } else if (ev.hook_event_name === "SessionEnd") {
        try {
          const distill = urlPath(new URL("../../dist/distill.js", import.meta.url));
          const child = spawn(process.execPath, [distill], {
            env: process.env,
            stdio: "ignore",
            detached: true,
          });
          child.on("error", (e) => {
            const msg = e instanceof Error ? e.message : String(e);
            logHookError(`SessionEnd distill spawn error: ${msg} (dist=${distill})`);
          });
          child.on("exit", (code) => {
            if (code !== 0 && code !== null) {
              logHookError(`SessionEnd distill exited with code ${code} (dist=${distill})`);
            }
          });
          child.unref();
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          logHookError(`SessionEnd distill setup error: ${msg}`);
        }
      }
    } catch (error) {
      logHookError(`event handling failed: ${errorMessage(error)}`);
    }
  } catch (error) {
    logHookError(`capture failed: ${errorMessage(error)}`);
  } finally {
    try {
      db?.close();
    } catch (error) {
      logHookError(`database close failed: ${errorMessage(error)}`);
    }
    emitOnce({});
  }
}

main().catch((error) => {
  logHookError(`unexpected hook failure: ${errorMessage(error)}`);
  emitOnce({});
});
