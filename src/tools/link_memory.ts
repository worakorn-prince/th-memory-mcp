import { z } from "zod";
import { ok, err, type ToolResult } from "../db/index.js";
import { linkMemories } from "../core/graph-engine.js";
import { getMemoryById } from "../db/repositories/memories.js";
import { LINK_RELATIONS } from "../memory/types.js";

export const linkMemoryInput = {
  sourceId: z.number().int().describe("Source memory id"),
  targetId: z.number().int().describe("Target memory id"),
  relation: z
    .enum(LINK_RELATIONS)
    .describe("Link relation (supports/contradicts/supersedes/derived_from/related_to/caused_by/depends_on)"),
};

export function linkMemoryHandler(args: {
  sourceId: number;
  targetId: number;
  relation: string;
}): ToolResult {
  try {
    const src = getMemoryById(args.sourceId);
    const tgt = getMemoryById(args.targetId);
    if (!src) return err(`source memory ${args.sourceId} not found`);
    if (!tgt) return err(`target memory ${args.targetId} not found`);
    if (src.status === "deleted" || tgt.status === "deleted")
      return err("cannot link deleted memories");
    if (src.id === tgt.id) return err("cannot link a memory to itself");
    if (
      (src.scope === "USER" || tgt.scope === "USER") &&
      src.user_id !== tgt.user_id
    )
      return err("cannot link memories across different users");
    if (
      (src.scope === "SESSION" || tgt.scope === "SESSION") &&
      src.session_id !== tgt.session_id
    )
      return err("cannot link memories across different sessions");
    if (
      src.scope === "PROJECT" &&
      tgt.scope === "PROJECT" &&
      src.project_id !== tgt.project_id
    )
      return err("cannot link memories across different projects");
    linkMemories(args.sourceId, args.targetId, args.relation);
    return ok(
      `linked memory ${args.sourceId} -[${args.relation}]-> ${args.targetId}`
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
