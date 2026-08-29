import {
  db,
  syncSearchIndex,
  removeSearchIndex,
  upsertEmbedding,
  removeEmbedding,
  nowISO,
} from "../../db/index.js";
import { embed } from "../../lib/embed.js";
import { retrieve } from "../../core/retrieval-engine.js";
import type {
  MemoryType,
  SourceType,
  LifecycleState,
  MemoryRecord,
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
  validFrom?: string | null;
  validUntil?: string | null;
  metadata?: unknown;
}

export function createMemory(input: CreateMemoryInput): number {
  const ts = nowISO();
  const info = db
    .prepare(
      `INSERT INTO memories
       (type, content, summary, status, source, confidence, importance, salience,
        project_id, session_id, created_at, updated_at, last_accessed_at, access_count,
        valid_from, valid_until, metadata)
       VALUES (@type, @content, @summary, @status, @source, @confidence, @importance, @salience,
        @projectId, @sessionId, @ts, @ts, NULL, 0, @validFrom, @validUntil, @metadata)`
    )
    .run({
      type: input.type,
      content: input.content,
      summary: input.summary ?? null,
      status: input.status ?? "active",
      source: input.source ?? "explicit",
      confidence: input.confidence ?? 0.5,
      importance: input.importance ?? 0.5,
      salience: input.salience ?? 0.5,
      projectId: input.projectId ?? null,
      sessionId: input.sessionId ?? null,
      ts,
      validFrom: input.validFrom ?? null,
      validUntil: input.validUntil ?? null,
      metadata:
        input.metadata != null ? JSON.stringify(input.metadata) : null,
    });
  const id = Number(info.lastInsertRowid);
  syncMemoryIndex(id, input.type, input.content);
  return id;
}

export function syncMemoryIndex(id: number, title: string, body: string): void {
  syncSearchIndex("memories", id, title, body);
  upsertEmbedding("memories", id, embed(body));
}

export function getMemoryById(id: number): MemoryRecord | undefined {
  return db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
    | MemoryRecord
    | undefined;
}

export function setStatus(id: number, status: LifecycleState): void {
  db.prepare("UPDATE memories SET status = ?, updated_at = ? WHERE id = ?").run(
    status,
    nowISO(),
    id
  );
}

export function softDelete(id: number): void {
  setStatus(id, "deleted");
}

export function removeMemoryIndex(id: number): void {
  removeSearchIndex("memories", id);
  removeEmbedding("memories", id);
}

export interface SearchOptions {
  limit?: number;
  projectId?: string | null;
  includeArchived?: boolean;
  includeHistory?: boolean;
}

export function searchMemories(
  query: string,
  opts: SearchOptions = {}
): MemoryRecord[] {
  return retrieve(query, opts);
}
