import { z } from "zod";
import {
  db,
  buildFtsMatch,
  escapeLike,
  truncate,
  ok,
  err,
  type ToolResult,
} from "../db.js";

export const recallInput = {
  topic: z.string().min(1).max(500).describe("Topic to recall from memory"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(8)
    .describe("Max preference/lesson matches (default 8)"),
};

const RECALL_BUDGET = 2000;
const RECENT_INTERACTIONS_LIMIT = 20;
const searchIndexed = db.prepare(
  "SELECT ref_table, ref_id, title, body FROM search_index WHERE search_index MATCH ? AND ref_table IN ('preferences','lessons') LIMIT ?"
);
const recentInteractions = db.prepare(
  `SELECT ts, kind, content FROM interactions WHERE content LIKE ? ESCAPE '\\' ORDER BY ts DESC LIMIT ${RECENT_INTERACTIONS_LIMIT}`
);

export async function recallHandler(args: {
  topic: string;
  limit: number;
}): Promise<ToolResult> {
  try {
    const limit = args.limit;
    const parts: string[] = [];

    let prefLines = "";
    let lessonLines = "";
    try {
      const rows = searchIndexed.all(buildFtsMatch(args.topic), limit) as {
        ref_table: string;
        ref_id: number;
        title: string;
        body: string;
      }[];
      for (const r of rows) {
        if (r.ref_table === "preferences") {
          prefLines += `- ${truncate(r.title, 120)} | ${truncate(r.body, 200)}\n`;
        } else if (r.ref_table === "lessons") {
          lessonLines += `- ${truncate(r.title, 120)} | ${truncate(r.body, 300)}\n`;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[recall] preference/lesson search failed:", msg);
      prefLines = "";
      lessonLines = "";
    }

    let interactionLines = "";
    try {
      const like = `%${escapeLike(args.topic)}%`;
      const rows = recentInteractions.all(like) as {
        ts: string;
        kind: string;
        content: string;
      }[];
      for (const r of rows) {
        interactionLines += `- [${r.ts}] (${r.kind}) ${truncate(r.content, 150)}\n`;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[recall] interaction search failed:", msg);
      interactionLines = "";
    }

    if (prefLines) parts.push(`[preferences]\n${prefLines.trimEnd()}`);
    if (lessonLines) parts.push(`[lessons]\n${lessonLines.trimEnd()}`);
    if (interactionLines)
      parts.push(
        `[recent interactions matching "${truncate(args.topic, 80)}"]\n${interactionLines.trimEnd()}`
      );

    if (parts.length === 0) {
      return ok(`no memory found for "${truncate(args.topic, 100)}"`);
    }

    return ok(truncate(parts.join("\n\n"), RECALL_BUDGET));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
