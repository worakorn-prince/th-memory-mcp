/** PARKED: test-only by design — scripts/check-capture-sync.mjs intentionally
 *  skips it and the deployed plugin aliases SECRET_PATTERNS[0] instead.
 *  Do not delete without relocating the security regression tests that use it. */
export const SECRET_LINE = /(api[_-]?key|secret|token|password)\s*[=:]/i;

// Whole-text replace-all patterns (all must carry /g). Order matters: PEM
// blocks first (so their body is removed before token patterns run), then
// provider token families, then the generic JSON-tolerant key/value matcher.
// Patterns stay bounded/simple (no nested unbounded quantifiers) to avoid
// catastrophic backtracking on captured text.
export const SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi,
  /(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{16,}/g,
  /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{20,}/g,
  /(?<![A-Za-z0-9])xox[baprs]-[A-Za-z0-9-]{10,}/g,
  /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/g,
  /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{30,60}/g,
  /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{20,}/g,
  /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?![A-Za-z0-9_-])/g,
  /(?<![A-Za-z0-9])Bearer\s+[A-Za-z0-9._~+\/-]{8,}=*/gi,
  /(?<![A-Za-z0-9])(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss|amqp|amqps|mssql|ftp|ftps|https?|smtp|ssh):\/\/[^\s"'<>]+@[^\s"'<>]+/gi,
  /(?<![A-Za-z0-9])(?:api[\s_-]?key|secret|token|password|authorization|auth|bearer|credential|private[\s_-]?key|access[\s_-]?key|refresh[\s_-]?token|access[\s_-]?token|id[\s_-]?token|session[\s_-]?token|client[\s_-]?secret|database[\s_-]?url|connection[\s_-]?string|x[\s_-]?api[\s_-]?key)(?![A-Za-z0-9])["']?[ \t]*[:=][ \t]*(?:(?:bearer|basic|token)\s+)?(?:"[^"]*"|'[^']*'|[^\s"',;}]+)/gi,
];

export const CAPTURE_KINDS = ["prompt", "tool_call", "error"] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

export const LIMITS: Record<CaptureKind, number> = {
  prompt: 4000,
  tool_call: 500,
  error: 500,
};

export function filterSecrets(text: string): string {
  let out = text;
  for (const p of SECRET_PATTERNS) out = out.replace(p, "[REDACTED]");
  return out;
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
    content: truncate(filterSecrets(content), LIMITS[kind]),
    meta: JSON.stringify(opts?.meta) ?? null,
  };
}

export const INSERT_SQL =
  "INSERT INTO interactions (ts, session_id, kind, content, meta) VALUES (?, ?, ?, ?, ?)";
