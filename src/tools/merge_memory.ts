import { z } from "zod";
import { db, nowISO, ok, err, type ToolResult } from "../db/index.js";
import { getMemoryById } from "../db/repositories/memories.js";
import { supersede } from "../core/lifecycle-engine.js";

export const mergeMemoryInput = {
  sourceId: z
    .number()
    .int()
    .describe("Memory to merge away (becomes superseded)"),
  targetId: z
    .number()
    .int()
    .describe("Canonical memory to keep (becomes active)"),
};

function mergeMetadata(existing: string | null, mergedId: number): string {
  let obj: Record<string, unknown> = {};
  if (existing) {
    try {
      obj = JSON.parse(existing);
    } catch {
      obj = {};
    }
  }
  const from = Array.isArray(obj.merged_from) ? obj.merged_from : [];
  from.push(mergedId);
  obj.merged_from = from;
  return JSON.stringify(obj);
}

export function mergeMemoryHandler(args: {
  sourceId: number;
  targetId: number;
}): ToolResult {
  try {
    const src = getMemoryById(args.sourceId);
    const tgt = getMemoryById(args.targetId);
    if (!src) return err(`source memory ${args.sourceId} not found`);
    if (!tgt) return err(`target memory ${args.targetId} not found`);
    if (src.id === tgt.id)
      return err("cannot merge a memory into itself");
    if (src.status === "deleted" || tgt.status === "deleted")
      return err("cannot merge deleted memories");
    // Batch B-3 (defense-in-depth, mirrors link_memory): refuse to merge
    // across scope boundaries. Note: userId/sessionId/projectId are
    // caller-supplied with no auth layer (single-user local process) — these
    // checks are only as trustworthy as the caller (see README/SECURITY).
    if (
      (src.scope === "USER" || tgt.scope === "USER") &&
      src.user_id !== tgt.user_id
    )
      return err("cannot merge memories across different users");
    if (
      (src.scope === "SESSION" || tgt.scope === "SESSION") &&
      src.session_id !== tgt.session_id
    )
      return err("cannot merge memories across different sessions");
    if (
      src.scope === "PROJECT" &&
      tgt.scope === "PROJECT" &&
      src.project_id !== tgt.project_id
    )
      return err("cannot merge memories across different projects");
    db.prepare(
      "UPDATE memories SET metadata = ?, updated_at = ? WHERE id = ?"
    ).run(mergeMetadata(tgt.metadata, src.id), nowISO(), tgt.id);
    supersede(src.id, tgt.id);
    return ok(
      `merged memory ${src.id} into ${tgt.id} (source superseded, provenance recorded in metadata.merged_from)`
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
