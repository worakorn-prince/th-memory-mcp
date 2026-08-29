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
