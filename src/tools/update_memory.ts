import { z } from "zod";
import {
  db,
  nowISO,
  ok,
  err,
  type ToolResult,
} from "../db/index.js";
import {
  getMemoryById,
  createMemory,
  syncMemoryIndex,
} from "../db/repositories/memories.js";
import { supersede } from "../core/lifecycle-engine.js";
import type { MemoryType, SourceType } from "../memory/types.js";

export const updateMemoryInput = {
  id: z.number().int().describe("Memory id to update"),
  content: z
    .string()
    .max(2000)
    .optional()
    .describe(
      "New content. When provided, a superseding memory is created (supersede=true) unless supersede=false."
    ),
  summary: z.string().max(2000).nullable().optional().describe("New summary"),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  validUntil: z
    .string()
    .nullable()
    .optional()
    .describe("ISO timestamp or null to clear"),
  metadata: z.unknown().optional().describe("New metadata object (replaces)"),
  supersede: z
    .boolean()
    .optional()
    .describe(
      "If content changes, create a superseding memory instead of editing in place (default true)"
    ),
};

export function updateMemoryHandler(args: {
  id: number;
  content?: string;
  summary?: string | null;
  importance?: number;
  confidence?: number;
  validUntil?: string | null;
  metadata?: unknown;
  supersede?: boolean;
}): ToolResult {
  try {
    const mem = getMemoryById(args.id);
    if (!mem) return err(`memory ${args.id} not found`);
    if (mem.status === "deleted")
      return err("cannot update a deleted memory");

    const supersedeContent =
      args.content !== undefined && (args.supersede ?? true);

    if (supersedeContent) {
      const externalId = mem.user_id
        ? (
            db
              .prepare("SELECT external_id FROM users WHERE id = ?")
              .get(mem.user_id) as { external_id: string } | undefined
          )?.external_id ?? null
        : null;
      const newId = createMemory({
        type: mem.type as MemoryType,
        content: args.content as string,
        summary: args.summary ?? mem.summary,
        source: mem.source as SourceType,
        confidence: args.confidence ?? mem.confidence,
        importance: args.importance ?? mem.importance,
        salience: mem.salience,
        projectId: mem.project_id,
        sessionId: mem.session_id,
        userId: externalId,
        validFrom: mem.valid_from,
        validUntil:
          args.validUntil !== undefined ? args.validUntil : mem.valid_until,
        metadata:
          args.metadata !== undefined
            ? args.metadata
            : mem.metadata
              ? JSON.parse(mem.metadata)
              : null,
      });
      supersede(mem.id, newId);
      return ok(
        `created superseding memory id=${newId} for old id=${mem.id} (old now superseded)`
      );
    }

    const sets: string[] = [];
    const vals: unknown[] = [];
    if (args.summary !== undefined) {
      sets.push("summary = ?");
      vals.push(args.summary);
    }
    if (args.importance !== undefined) {
      sets.push("importance = ?");
      vals.push(args.importance);
    }
    if (args.confidence !== undefined) {
      sets.push("confidence = ?");
      vals.push(args.confidence);
    }
    if (args.validUntil !== undefined) {
      sets.push("valid_until = ?");
      vals.push(args.validUntil);
    }
    if (args.metadata !== undefined) {
      sets.push("metadata = ?");
      vals.push(JSON.stringify(args.metadata));
    }
    if (args.content !== undefined) {
      sets.push("content = ?");
      vals.push(args.content);
    }
    if (sets.length === 0)
      return ok(`no mutable fields provided; memory ${mem.id} unchanged`);
    sets.push("updated_at = ?");
    vals.push(nowISO());
    vals.push(mem.id);
    db.prepare(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`).run(
      ...vals
    );
    if (args.content !== undefined) {
      const m = getMemoryById(mem.id);
      if (m) syncMemoryIndex(m.id, m.type, m.content);
    }
    return ok(`updated memory ${mem.id} in place`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
