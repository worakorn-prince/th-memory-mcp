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
import { isoDateTimeSchema, isIsoDateString } from "../lib/iso.js";
import type { MemoryType, SourceType } from "../memory/types.js";

type MetadataObject = Record<string, unknown>;

function safeParseMetadata(
  raw: string | null | undefined
): MetadataObject | null {
  if (raw == null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as MetadataObject;
    }
  } catch {
    // Malformed legacy metadata is treated as absent, never thrown.
  }
  return null;
}

// SEC-06: the trusted flag records provenance, so an update may never create
// it. When the existing metadata has no flag, absence is preserved (legacy
// local data stays unlabelled); an existing flag is canonicalized to a boolean
// carrying the same trust value.
function normalizeMetadata(
  existingRaw: string | null | undefined,
  incoming: unknown
): MetadataObject | null {
  const existing = safeParseMetadata(existingRaw);
  const hasExistingFlag =
    existing !== null && Object.hasOwn(existing, "trusted");
  const existingTrusted = hasExistingFlag && existing!.trusted === true;

  if (incoming === undefined) {
    if (existing === null) return null;
    if (hasExistingFlag) existing.trusted = existingTrusted;
    return existing;
  }

  if (incoming === null) {
    return hasExistingFlag ? { trusted: existingTrusted } : null;
  }

  const next: MetadataObject =
    typeof incoming === "object" && !Array.isArray(incoming)
      ? { ...(incoming as MetadataObject) }
      : { value: incoming };
  if (hasExistingFlag) next.trusted = existingTrusted;
  else delete next.trusted;
  return next;
}

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
  validFrom: z
    .union([isoDateTimeSchema, z.null()])
    .optional()
    .describe("ISO timestamp or null to clear"),
  validUntil: z
    .union([isoDateTimeSchema, z.null()])
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
  validFrom?: string | null;
  validUntil?: string | null;
  metadata?: unknown;
  supersede?: boolean;
}): ToolResult {
  try {
    const mem = getMemoryById(args.id);
    if (!mem) return err(`memory ${args.id} not found`);
    if (mem.status === "deleted")
      return err("cannot update a deleted memory");
    if (
      args.validFrom !== undefined &&
      args.validFrom !== null &&
      !isIsoDateString(args.validFrom)
    ) {
      return err(
        `validFrom must be a full ISO datetime with timezone offset (e.g. 2024-01-01T00:00:00.000Z), got '${args.validFrom}'`
      );
    }
    if (
      args.validUntil !== undefined &&
      args.validUntil !== null &&
      !isIsoDateString(args.validUntil)
    ) {
      return err(
        `validUntil must be a full ISO datetime with timezone offset (e.g. 2024-01-01T00:00:00.000Z), got '${args.validUntil}'`
      );
    }
    // Effective range covers new values and values mixed with the existing row.
    const effectiveValidFrom =
      args.validFrom !== undefined ? args.validFrom : mem.valid_from;
    const effectiveValidUntil =
      args.validUntil !== undefined ? args.validUntil : mem.valid_until;
    if (
      effectiveValidFrom != null &&
      effectiveValidUntil != null &&
      new Date(effectiveValidFrom) > new Date(effectiveValidUntil)
    ) {
      return err(
        `validFrom (${effectiveValidFrom}) must not be later than validUntil (${effectiveValidUntil})`
      );
    }

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
        validFrom:
          args.validFrom !== undefined ? args.validFrom : mem.valid_from,
        validUntil:
          args.validUntil !== undefined ? args.validUntil : mem.valid_until,
        metadata: normalizeMetadata(mem.metadata, args.metadata),
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
    if (args.validFrom !== undefined) {
      sets.push("valid_from = ?");
      vals.push(args.validFrom);
    }
    if (args.validUntil !== undefined) {
      sets.push("valid_until = ?");
      vals.push(args.validUntil);
    }
    if (args.metadata !== undefined) {
      const normalized = normalizeMetadata(mem.metadata, args.metadata);
      sets.push("metadata = ?");
      vals.push(normalized === null ? null : JSON.stringify(normalized));
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
