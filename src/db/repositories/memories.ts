import type BetterSqlite3 from "better-sqlite3-multiple-ciphers";
import {
  db,
  syncSearchIndex,
  upsertEmbedding,
  nowISO,
} from "../../db/index.js";
import { embed } from "../../lib/embed.js";
import { redactMetadata, redactSecrets } from "../../lib/redact.js";
import { getIdentity, resolveWriterUserId } from "../../auth/identity.js";
import { canAccessRow, getEffectiveScope } from "../../auth/scope-resolver.js";
import type {
  MemoryType,
  SourceType,
  LifecycleState,
  MemoryRecord,
  Scope,
} from "../../memory/types.js";

export interface CreateMemoryInput {
  type: MemoryType;
  content: string;
  summary?: string | null;
  status?: LifecycleState;
  source?: SourceType;
  confidence?: number;
  importance?: number;
  salience?: number;
  projectId?: string | null;
  sessionId?: string | null;
  userId?: string | null;
  validFrom?: string | null;
  validUntil?: string | null;
  metadata?: unknown;
}

/**
 * Ph-3 defence in depth. The guard already bound the scope from the verified
 * identity, so an enforced insert may only produce that scope:
 *
 *   - `user_id` must be the bound user (own or granted);
 *   - a NULL owner (= GLOBAL row) needs `allowGlobalWrite`;
 *   - `session_id` / `project_id` must be the bound ones.
 *
 * Beyond the exact bound scope, a row the identity may write per
 * `canAccessRow` is also accepted: `update_memory` reinstates the SOURCE row's
 * scope when it supersedes, and that row may legitimately be a granted foreign
 * scope rather than the request's scope. Nothing wider than the grant model is
 * ever accepted, so this cannot escalate. Legacy (no bound scope) is untouched.
 */
function assertBoundScope(
  input: CreateMemoryInput,
  uid: number | null,
  rowScope: Scope
): void {
  const bound = getEffectiveScope();
  if (bound === null || bound.mode !== "enforced") return;

  const sessionId = input.sessionId ?? null;
  const projectId = input.projectId ?? null;
  const targetUid = bound.resolvedUid ?? bound.uid ?? null;

  const direct =
    ((uid !== null && uid === targetUid) ||
      (uid === null && bound.allowGlobalWrite)) &&
    sessionId === (bound.sessionId ?? null) &&
    projectId === (bound.projectId ?? null);
  if (direct) return;

  // A GLOBAL row is only ever allowed through `allowGlobalWrite` above.
  if (rowScope !== "GLOBAL") {
    const candidate = {
      scope: rowScope,
      user_id: uid,
      session_id: sessionId,
      project_id: projectId,
    };
    if (canAccessRow(getIdentity(), candidate, "write")) return;
  }

  throw new Error("scope mismatch (auth enforced)");
}

function insertMemoryAtomic(input: CreateMemoryInput): number {
  const ts = nowISO();
  const content = redactSecrets(input.content);
  const summary = input.summary != null ? redactSecrets(input.summary) : null;
  const metadata =
    input.metadata != null ? redactMetadata(input.metadata) : null;
  const uid = input.userId ? resolveWriterUserId(input.userId) : null;
  const scope: Scope = input.sessionId
    ? "SESSION"
    : input.projectId
      ? "PROJECT"
      : uid
        ? "USER"
        : "GLOBAL";
  assertBoundScope(input, uid, scope);
  const info = db
    .prepare(
        `INSERT INTO memories
         (type, content, summary, status, source, confidence, importance, salience,
          project_id, session_id, user_id, scope, created_at, updated_at, last_accessed_at, access_count,
          valid_from, valid_until, metadata)
         VALUES (@type, @content, @summary, @status, @source, @confidence, @importance, @salience,
          @projectId, @sessionId, @userId, @scope, @ts, @ts, NULL, 0, @validFrom, @validUntil, @metadata)`
    )
    .run({
      type: input.type,
      content,
      summary,
      status: input.status ?? "active",
      source: input.source ?? "explicit",
      confidence: input.confidence ?? 0.5,
      importance: input.importance ?? 0.5,
      salience: input.salience ?? 0.5,
        projectId: input.projectId ?? null,
        sessionId: input.sessionId ?? null,
        userId: uid,
        scope,
        ts,
      validFrom: input.validFrom ?? null,
      validUntil: input.validUntil ?? null,
      metadata: metadata != null ? JSON.stringify(metadata) : null,
    });
  const id = Number(info.lastInsertRowid);
  syncMemoryIndex(id, input.type, content);
  return id;
}

let createMemoryTxn: ((input: CreateMemoryInput) => number) | null = null;

export function createMemory(input: CreateMemoryInput): number {
  createMemoryTxn ??= db.transaction(insertMemoryAtomic);
  return createMemoryTxn(input);
}

export function syncMemoryIndex(id: number, title: string, body: string): void {
  syncSearchIndex("memories", id, title, body);
  upsertEmbedding("memories", id, embed(body));
}

let _memoryByIdStmt: BetterSqlite3.Statement | null = null;
function getMemoryByIdStmt(): BetterSqlite3.Statement {
  return (_memoryByIdStmt ??= db.prepare(
    "SELECT * FROM memories WHERE id = ?"
  ));
}

export function getMemoryById(id: number): MemoryRecord | undefined {
  return getMemoryByIdStmt().get(id) as MemoryRecord | undefined;
}

let _setStatusStmt: BetterSqlite3.Statement | null = null;
function getSetStatusStmt(): BetterSqlite3.Statement {
  return (_setStatusStmt ??= db.prepare(
    "UPDATE memories SET status = ?, updated_at = ? WHERE id = ?"
  ));
}

export function setStatus(id: number, status: LifecycleState): void {
  getSetStatusStmt().run(status, nowISO(), id);
}
