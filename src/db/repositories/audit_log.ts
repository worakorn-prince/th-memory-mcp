/**
 * Authorization audit trail (Ph-3, task TASK-AUTH-P3-SCOPE).
 *
 * One row per enforced tool decision (allow + deny). Two hard rules:
 *
 *  1. **Content-free and bounded** — only identifiers land here. `tool` is
 *     capped at 64 chars, `reason` at 32, `scope_ref` at 120, and CR/LF are
 *     flattened so a hostile value can never forge a second log line. Tool
 *     arguments and memory content are never accepted by this module.
 *  2. **Best-effort** — a failed insert must never change a tool result. The
 *     failure is swallowed and reported as exactly one bounded stderr line.
 *
 * Legacy mode writes no rows at all (the guard never calls this), keeping the
 * auth-off path byte-identical to v2.5.2.
 */
import { db, nowISO } from "../index.js";
import { redactSecrets } from "../../lib/redact.js";

export const AUDIT_DECISIONS = ["allow", "deny"] as const;
export type AuditDecision = (typeof AUDIT_DECISIONS)[number];

export const AUDIT_KINDS = ["read", "write"] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

const MAX_TOOL = 64;
const MAX_REASON = 32;
const MAX_SCOPE_KIND = 16;
export const MAX_SCOPE_REF = 120;

const MAX_TRAIL = 200;

export interface AuditDecisionInput {
  /** Internal users.id of the authenticated identity; null when unavailable. */
  uid?: number | null;
  tool: string;
  kind: AuditKind;
  decision: AuditDecision;
  /** Fixed enum: 'role' | 'scope' | 'global-write' | 'grant' | null. */
  reason?: string | null;
  /** Resolved (or requested) scope class: USER | PROJECT | SESSION | GLOBAL. */
  scopeKind?: string | null;
  /** Target ref (id only, never content); truncated to MAX_SCOPE_REF. */
  scopeRef?: string | null;
}

export interface AuditLogRow {
  id: number;
  ts: string;
  user_id: number | null;
  tool: string;
  kind: string;
  decision: string;
  reason: string | null;
  scope_kind: string | null;
  scope_ref: string | null;
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const flat = value.replace(/[\r\n]+/g, " ").trim();
  return flat.length === 0 ? null : flat.slice(0, max);
}

function boundedUid(uid: unknown): number | null {
  return typeof uid === "number" && Number.isInteger(uid) && uid > 0 ? uid : null;
}

function insertRow(
  uid: number | null,
  ts: string,
  tool: string,
  kind: AuditKind,
  decision: AuditDecision,
  reason: string | null,
  scopeKind: string | null,
  scopeRef: string | null
): void {
  db.prepare(
    `INSERT INTO audit_log
       (ts, user_id, tool, kind, decision, reason, scope_kind, scope_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(ts, uid, tool, kind, decision, reason, scopeKind, scopeRef);
}

function warnOnce(message: string): void {
  try {
    const line = redactSecrets(
      `[th-memory-mcp] audit: ${message}`
    ).replace(/[\r\n]+/g, " ");
    process.stderr.write(`${line.slice(0, MAX_TRAIL)}\n`);
  } catch {
    /* stderr itself is unavailable: nothing left to do */
  }
}

/**
 * Record one authorization decision. Never throws, never blocks the caller.
 *
 * A `uid` that is not in `users` (e.g. a fixture identity in tests) is retried
 * as NULL so the decision is still auditable instead of being lost to the
 * foreign key.
 */
export function recordDecision(input: AuditDecisionInput): void {
  const ts = nowISO();
  const tool = boundedText(input.tool, MAX_TOOL) ?? "unknown";
  const kind: AuditKind = input.kind === "write" ? "write" : "read";
  const decision: AuditDecision = input.decision === "allow" ? "allow" : "deny";
  const reason = boundedText(input.reason, MAX_REASON);
  const scopeKind = boundedText(input.scopeKind, MAX_SCOPE_KIND);
  const scopeRef = boundedText(input.scopeRef, MAX_SCOPE_REF);
  const uid = boundedUid(input.uid);

  try {
    insertRow(uid, ts, tool, kind, decision, reason, scopeKind, scopeRef);
    return;
  } catch {
    /* fall through: retry without the user reference */
  }
  if (uid === null) {
    warnOnce(`insert failed for tool=${tool} decision=${decision}`);
    return;
  }
  try {
    insertRow(null, ts, tool, kind, decision, reason, scopeKind, scopeRef);
  } catch {
    warnOnce(`insert failed for tool=${tool} decision=${decision}`);
  }
}

/** Newest-first rows for inspection and tests. `limit` is clamped to 1..500. */
export function listRecent(limit = 50): AuditLogRow[] {
  const n = Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 500) : 50;
  return db
    .prepare(
      `SELECT id, ts, user_id, tool, kind, decision, reason, scope_kind, scope_ref
       FROM audit_log ORDER BY id DESC LIMIT ?`
    )
    .all(n) as AuditLogRow[];
}
