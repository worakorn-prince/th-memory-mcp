import { z } from "zod";
import {
  db,
  escapeLike,
  truncate,
  ok,
  err,
  type ToolResult,
} from "../db/index.js";

export const searchHistoryInput = {
  query: z.string().min(1).max(500).describe("Text to search in past prompts"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe("Max results (default 10)"),
};

const ITEM_BUDGET = 200;
const searchPrompts = db.prepare(
  "SELECT ts, content FROM interactions WHERE kind = 'prompt' AND content LIKE ? ESCAPE '\\' ORDER BY ts DESC LIMIT ?"
);

export async function searchHistoryHandler(args: {
  query: string;
  limit: number;
}): Promise<ToolResult> {
  try {
    const limit = args.limit;
    const like = `%${escapeLike(args.query)}%`;
    const rows = searchPrompts.all(like, limit) as {
      ts: string;
      content: string;
    }[];
    if (rows.length === 0) {
      return ok(`no prompts found matching "${truncate(args.query, 100)}"`);
    }
    const lines = rows.map(
      (r) => `- [${r.ts}] ${truncate(r.content, ITEM_BUDGET)}`
    );
    return ok(lines.join("\n"));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
