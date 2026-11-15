import { z } from "zod";
import {
  db,
  escapeLike,
  truncate,
  ok,
  err,
  type ToolResult,
} from "../db/index.js";
import { wrapMemoryReference } from "../lib/memory-format.js";
import { getIdentity } from "../auth/identity.js";
import { hasRole } from "../auth/policy.js";
import { getEffectiveScope } from "../auth/scope-resolver.js";

export const searchHistoryInput = {
  query: z.string().min(1).max(500).describe("Text to search in past prompts"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .describe("Max results (default 10)"),
  sessionId: z
    .string()
    .max(200)
    .optional()
    .describe("Filter by captured session id (default: all sessions)"),
};

const ITEM_BUDGET = 200;
const searchPrompts = db.prepare(
  "SELECT ts, content FROM interactions WHERE kind = 'prompt' AND content LIKE ? ESCAPE '\\' AND (? IS NULL OR session_id = ?) ORDER BY ts DESC LIMIT ?"
);
// Ph-3 enforced variant: user_id bounds the row set (NULL = anonymous, visible to
// owner/admin only). session_id stays a pure filter on top of it — the tool is
// in FILTER_ONLY_SCOPE_TOOLS, so it needs no grant and can never widen the rows.
const searchPromptsScoped = db.prepare(
  "SELECT ts, content FROM interactions WHERE kind = 'prompt' AND content LIKE ? ESCAPE '\\' AND (? IS NULL OR session_id = ?) AND (user_id = ? OR (? = 1 AND user_id IS NULL)) ORDER BY ts DESC LIMIT ?"
);

export async function searchHistoryHandler(args: {
  query: string;
  limit: number;
  sessionId?: string;
}): Promise<ToolResult> {
  try {
    const limit = args.limit ?? 10;
    const sessionId = args.sessionId ?? null;
    const like = `%${escapeLike(args.query)}%`;
    const scope = getEffectiveScope();
    const rows = (
      scope === null
        ? searchPrompts.all(like, sessionId, sessionId, limit)
        : searchPromptsScoped.all(
            like,
            sessionId,
            sessionId,
            scope.uid ?? -1,
            hasRole(getIdentity(), "owner") ? 1 : 0,
            limit
          )
    ) as {
      ts: string;
      content: string;
    }[];
    if (rows.length === 0) {
      return ok(`no prompts found matching "${truncate(args.query, 100)}"`);
    }
    const lines = rows.map(
      (r) => `- [${r.ts}] ${truncate(r.content, ITEM_BUDGET)}`
    );
    return ok(wrapMemoryReference(lines.join("\n")));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
