import { z } from "zod";
import { db, truncate, ok, err, type ToolResult } from "../db/index.js";
import {
  CAPTURE_KINDS,
  type CaptureKind,
  type InteractionRow,
} from "../lib/capture-core.js";
import {
  MEMORY_REF_CLOSE,
  MEMORY_REF_GUIDANCE,
  MEMORY_REF_OPEN,
  wrapMemoryReference,
} from "../lib/memory-format.js";

export const recentInteractionsInput = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Max rows (default 20, max 100)"),
  kind: z
    .enum(CAPTURE_KINDS)
    .optional()
    .describe("Filter by kind (prompt / tool_call / error)"),
  sessionId: z
    .string()
    .max(200)
    .optional()
    .describe("Filter by captured session id (default: all sessions)"),
};

const RECENT_BUDGET = 4000;
const ITEM_BUDGET = 300;
const WRAPPER_OVERHEAD =
  MEMORY_REF_GUIDANCE.length +
  MEMORY_REF_OPEN.length +
  MEMORY_REF_CLOSE.length +
  3;
const selectAny = db.prepare(
  "SELECT id, ts, kind, content FROM interactions WHERE (? IS NULL OR session_id = ?) ORDER BY id DESC LIMIT ?"
);
const selectByKind = db.prepare(
  "SELECT id, ts, kind, content FROM interactions WHERE kind = ? AND (? IS NULL OR session_id = ?) ORDER BY id DESC LIMIT ?"
);

export async function getRecentInteractionsHandler(args: {
  limit: number;
  kind?: CaptureKind;
  sessionId?: string;
}): Promise<ToolResult> {
  try {
    const limit = args.limit ?? 20;
    const sessionId = args.sessionId ?? null;
    const rows = (
      args.kind
        ? selectByKind.all(args.kind, sessionId, sessionId, limit)
        : selectAny.all(sessionId, sessionId, limit)
    ) as InteractionRow[];

    if (rows.length === 0) {
      return ok(
        `no interactions found${args.kind ? ` with kind '${args.kind}'` : ""}`
      );
    }

    const lines = rows.map(
      (r) => `[${r.id}] ${r.ts} [${r.kind}] ${truncate(r.content, ITEM_BUDGET)}`
    );
    return ok(
      wrapMemoryReference(
        truncate(
          lines.join("\n"),
          Math.max(0, RECENT_BUDGET - WRAPPER_OVERHEAD)
        )
      )
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
