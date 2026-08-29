import { z } from "zod";
import { db, ok, err, type ToolResult } from "../db/index.js";
import { createMemory } from "../db/repositories/memories.js";
import { deduplicate } from "../memory/deduplicator.js";
import { MEMORY_TYPES } from "../memory/types.js";
import type { MemoryType } from "../memory/types.js";

// Deterministic, LLM-free intent heuristics (spec §19 "optional extraction").
// Scans captured interactions and proposes memory candidates. Safe by default:
// dry-run proposes; pass apply=true to actually create memories (source=captured).
const INTENT_PATTERNS: Array<{ re: RegExp; type: MemoryType }> = [
  { re: /(?:remember|จำไว้ว่า|บันทึกว่า)\s+(?:that\s+)?(.+)/i, type: "FACT" },
  {
    re: /(?:i prefer|my preference is|ผมชอบ|ฉันชอบ|เราชอบ)\s+(.+)/i,
    type: "PREFERENCE",
  },
  {
    re: /(?:i use|เราใช้|ฉันใช้)\s+([^\s,]+)\s+(?:for|ในการ|เพื่อ)\s+(.+)/i,
    type: "PREFERENCE",
  },
  {
    re: /(?:don'?t use|ห้ามใช้|อย่าใช้)\s+(.+?)(?:,\s*(?:use|ใช้)\s+(.+))?/i,
    type: "LESSON",
  },
  {
    re: /(?:instead|use)\s+(.+?)\s+(?:rather than|แทน)\s+(.+)/i,
    type: "LESSON",
  },
];

export const extractMemoriesInput = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe("Max recent interactions to scan (default 50)"),
  kind: z
    .enum(["prompt", "tool_call", "error"])
    .optional()
    .describe("Interaction kind to scan (default prompt)"),
  apply: z
    .boolean()
    .optional()
    .describe("Create the proposed memories (default false = propose only)"),
  userId: z
    .string()
    .nullable()
    .optional()
    .describe("Scope extracted memories to a user (USER scope)"),
};

export function extractMemoriesHandler(args: {
  limit?: number;
  kind?: "prompt" | "tool_call" | "error";
  apply?: boolean;
  userId?: string | null;
}): ToolResult {
  try {
    const limit = args.limit ?? 50;
    const kind = args.kind ?? "prompt";
    const rows = db
      .prepare(
        "SELECT id, content FROM interactions WHERE kind = ? ORDER BY id DESC LIMIT ?"
      )
      .all(kind, limit) as Array<{ id: number; content: string }>;

    const candidates: Array<{ interactionId: number; type: MemoryType; content: string }> =
      [];
    for (const r of rows) {
      for (const p of INTENT_PATTERNS) {
        const m = r.content.match(p.re);
        if (m) {
          const clause = (m[1] || "").trim();
          if (clause.length >= 3) {
            candidates.push({
              interactionId: r.id,
              type: p.type,
              content: clause,
            });
          }
          break;
        }
      }
    }

    const distinct = candidates.filter(
      (c) =>
        deduplicate(c.type, c.content).verdict === "distinct"
    );

    if (args.apply === true) {
      let n = 0;
      for (const c of distinct) {
        createMemory({
          type: c.type,
          content: c.content,
          source: "captured",
          userId: typeof args.userId === "string" ? args.userId : null,
        });
        n++;
      }
      return ok(
        `extracted and created ${n} memories from interactions (${candidates.length} candidates, ${candidates.length - distinct.length} duplicates skipped)`
      );
    }

    const preview =
      distinct
        .slice(0, 20)
        .map((c) => `[${c.type}] ${c.content}`)
        .join("\n") || "(no candidates)";
    return ok(
      `proposed ${distinct.length} memory candidate(s) from ${rows.length} ${kind} interactions (dry-run; pass apply=true to create):\n${preview}`
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
