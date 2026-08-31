export const SECRET_LINE = /(api[_-]?key|secret|token|password)\s*[=:]/i;

export const SECRET_PATTERNS = [
  /(api[_-]?key|secret|token|password|auth|bearer|credential|private[_-]?key|access[_-]?key|database[_-]?url|connection[_-]?string)\s*[=:]\s*\S+/i,
  /(sk-[a-zA-Z0-9]{20,})/i,
  /(ghp_[a-zA-Z0-9]{36})/i,
  /(glpat-[a-zA-Z0-9\-]{20,})/i,
  /(Bearer\s+[a-zA-Z0-9\-_]+)/i,
  /(-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----)/i,
];

export const CAPTURE_KINDS = ["prompt", "tool_call", "error"] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

export const LIMITS: Record<CaptureKind, number> = {
  prompt: 4000,
  tool_call: 500,
  error: 500,
};

export function filterSecrets(text: string): string {
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

export function truncate(text: string, max: number): string {
  if (max <= 0) return "";
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 1)) + "\u2026";
}

export interface Dedupe {
  seen(id: string): boolean;
}

export function createDedupe(maxSize: number = 1000): Dedupe {
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

export interface BuildRowOptions {
  sessionId?: string;
  meta?: unknown;
}

export interface InteractionRow {
  /** DB row id — absent on rows built by buildRow() before insertion. */
  id?: number;
  ts: string;
  session_id: string | null;
  kind: CaptureKind;
  content: string;
  meta: string | null;
}

export function buildRow(
  kind: CaptureKind,
  content: string,
  opts?: BuildRowOptions
): InteractionRow {
  return {
    ts: new Date().toISOString(),
    session_id: opts?.sessionId ?? null,
    kind,
    content: filterSecrets(truncate(content, LIMITS[kind])),
    meta: JSON.stringify(opts?.meta) ?? null,
  };
}

export const INSERT_SQL =
  "INSERT INTO interactions (ts, session_id, kind, content, meta) VALUES (?, ?, ?, ?, ?)";
