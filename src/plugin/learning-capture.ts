// learning-capture: OpenCode plugin — auto-captures user prompts, tool calls
// and session errors into data/memory.db (table `interactions`).
// Deployed as a SINGLE standalone file (~/.config/opencode/plugins/), so all
// logic below is an inline copy kept IN SYNC with src/lib/capture-core.ts.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

interface AnyRecord {
  [key: string]: any;
}
interface PluginContext {
  client?: AnyRecord;
}
interface OpencodeEvent {
  type?: string;
  properties?: AnyRecord;
}
interface MessageInfo {
  id?: unknown;
  role?: unknown;
  sessionID?: unknown;
  parts?: unknown;
}

// Portable default: resolve relative to this plugin file.
// When deployed at ~/.config/opencode/plugins/, this becomes
// ~/.config/opencode/data/memory.db. Override with MEMORY_DB_PATH to point
// at the SAME shared DB the MCP server uses (recommended so capture + recall
// read/write one database).
const DEFAULT_DB_PATH = fileURLToPath(
  new URL("../../data/memory.db", import.meta.url)
);

// --- sync with src/lib/capture-core.ts ---
const SECRET_PATTERNS = [
  /(api[_-]?key|secret|token|password|auth|bearer|credential|private[_-]?key|access[_-]?key|database[_-]?url|connection[_-]?string)\s*[=:]\s*\S+/i,
  /(sk-[a-zA-Z0-9]{20,})/i,
  /(ghp_[a-zA-Z0-9]{36})/i,
  /(glpat-[a-zA-Z0-9\-]{20,})/i,
  /(Bearer\s+[a-zA-Z0-9\-_]+)/i,
  /(-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----)/i,
];
const SECRET_LINE = SECRET_PATTERNS[0]!;
type CaptureKind = "prompt" | "tool_call" | "error";
const LIMITS: Record<CaptureKind, number> = { prompt: 4000, tool_call: 500, error: 500 };
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

function filterSecrets(text: string): string {
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

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "\u2026";
}

function createDedupe(maxSize: number = 1000): { seen(id: string): boolean } {
  const live = new Set<string>();
  const order: string[] = [];
  return {
    seen(id: string): boolean {
      if (live.has(id)) return true;
      live.add(id);
      order.push(id);
      while (order.length > maxSize) {
        const evicted = order.shift();
        if (evicted !== undefined) live.delete(evicted);
      }
      return false;
    },
  };
}

interface InteractionRow {
  ts: string;
  session_id: string | null;
  kind: CaptureKind;
  content: string;
  meta: string | null;
}

function buildRow(
  kind: CaptureKind,
  content: string,
  opts?: { sessionId?: string; meta?: unknown }
): InteractionRow {
  return {
    ts: new Date().toISOString(),
    session_id: opts?.sessionId ?? null,
    kind,
    content: filterSecrets(truncate(content, LIMITS[kind])),
    meta: JSON.stringify(opts?.meta) ?? null,
  };
}

// console.error QUIET — log only the first error per hook, then suppress.
function makeQuietLog(label: string): (e: unknown) => void {
  let warned = false;
  return (e: unknown) => {
    if (!warned) {
      warned = true;
      const msg = e instanceof Error ? e.message : String(e);
      try {
        console.error(`[learning-capture] ${label}: ${msg} (further errors suppressed)`);
      } catch {}
    }
  };
}

function textFromParts(parts: unknown): string | null {
  if (!Array.isArray(parts)) return null;
  const out: string[] = [];
  for (const p of parts) {
    const t = p?.text;
    if (typeof t === "string" && t.trim()) out.push(t);
  }
  return out.length > 0 ? out.join("\n") : null;
}

// --- profile injection (Phase 3) ---
function fmtConfidence(c: unknown): string {
  const n = Number(c);
  if (!Number.isFinite(n)) return "(0)";
  return String(Math.round(n * 100) / 100);
}

function buildProfileText(dbi: InstanceType<typeof Database> | null): string {
  if (!dbi) return "";
  try {
    const parts: string[] = [];

    let rows = dbi.prepare("SELECT section, content FROM profile").all();
    if (rows.length > 0) {
      parts.push("## User Memory Profile");
      for (const r of rows) {
        const section = typeof r.section === "string" ? r.section : "";
        const content = typeof r.content === "string" ? r.content : "";
        if (section || content) parts.push(`${truncate(section,200)}: ${truncate(content,200)}`);
      }
    }

    rows = dbi
      .prepare(
        "SELECT category, key, value, confidence FROM preferences ORDER BY confidence DESC LIMIT 15"
      )
      .all();
    if (rows.length > 0) {
      parts.push("## Preferences");
      for (const r of rows) {
        parts.push(
          `- ${r.category}/${r.key}: ${truncate(r.value,200)} (${fmtConfidence(r.confidence)})`
        );
      }
    }

    rows = dbi
      .prepare(
        "SELECT situation, mistake, correction FROM lessons ORDER BY created_at DESC LIMIT 5"
      )
      .all();
    if (rows.length > 0) {
      parts.push("## Recent Lessons");
      for (const r of rows) {
        parts.push(`- situation=${truncate(r.situation,200)}; mistake=${truncate(r.mistake,200)}; correction=${truncate(r.correction,200)}`);
      }
    }

    return parts.join("\n");
  } catch {
    return "";
  }
}

export const LearningCapture = async (ctx?: PluginContext) => {
  let db: InstanceType<typeof Database> | null = null;
  const initLog = makeQuietLog("init");
  try {
    const path =
      typeof process.env.MEMORY_DB_PATH === "string" && process.env.MEMORY_DB_PATH
        ? process.env.MEMORY_DB_PATH
        : DEFAULT_DB_PATH;
    mkdirSync(dirname(path), { recursive: true });
    db = new Database(path);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA busy_timeout=5000");
    db.exec(INTERACTIONS_DDL);
  } catch (e) {
    initLog(e);
  }

  let insertStmt: ReturnType<Database["prepare"]> | null = null;
  function insert(
    kind: CaptureKind,
    content: string,
    opts?: { sessionId?: string; meta?: unknown }
  ): void {
    if (!db) throw new Error("memory.db not open");
    if (!insertStmt) insertStmt = db.prepare(INSERT_SQL);
    const row = buildRow(kind, content, opts);
    insertStmt.run(row.ts, row.session_id, row.kind, row.content, row.meta);
  }

  const promptDedupe = createDedupe();
  const toolDedupe = createDedupe();
  const eventLog = makeQuietLog("event hook");
  const toolLog = makeQuietLog("tool.execute.after hook");

  return {
    event: async ({ event }: { event: OpencodeEvent }) => {
      try {
        if (event?.type === "message.updated") {
          const props = event.properties ?? {};
          const info: MessageInfo = props.info ?? {};
          if (info.role !== "user") return;
          const msgId = typeof info.id === "string" ? info.id : "";
          if (!msgId || promptDedupe.seen(msgId)) return;

          let text = textFromParts(info.parts) ?? textFromParts(props.parts);
          if (text === null && ctx?.client?.session?.messages) {
            try {
              const res = await ctx.client.session.messages({
                sessionID: info.sessionID,
              });
              const list: any[] = Array.isArray(res)
                ? res
                : Array.isArray(res?.data)
                  ? res.data
                  : [];
              const target = list.find(
                (m) => m?.info?.id === msgId || m?.id === msgId
              );
              text = textFromParts(target?.parts ?? target?.info?.parts);
            } catch {}
          }
          if (text === null || !text.trim()) return;

          insert("prompt", text, {
            sessionId:
              typeof info.sessionID === "string" ? info.sessionID : undefined,
          });
        } else if (event?.type === "session.error") {
          insert("error", JSON.stringify(event.properties ?? {}), {});
        }
      } catch (e) {
        eventLog(e);
      }
    },

    "tool.execute.after": async (
      input?: AnyRecord,
      output?: AnyRecord
    ) => {
      try {
        const callID =
          input?.callID !== undefined && input?.callID !== null
            ? String(input.callID)
            : "";
        if (!callID || toolDedupe.seen(callID)) return;
        const isError = output?.error != null || output?.metadata?.error != null;
        const content = `tool=${input?.tool ?? ""} title=${output?.title ?? ""}`;
        insert("tool_call", content, {
          meta: {
            callID: input?.callID ?? null,
            status: isError ? "error" : "success",
          },
        });
      } catch (e) {
        toolLog(e);
      }
    },

    // Phase 3: inject user memory profile into context on session compaction.
    // MUST swallow every error — a failed injection must never break OpenCode.
    "experimental.session.compacting": async (
      input?: AnyRecord,
      output?: AnyRecord
    ) => {
      try {
        const txt = buildProfileText(db);
        if (txt && output?.context && typeof output.context.push === "function") {
          output.context.push(txt);
        }
      } catch {}
    },
  };
};
