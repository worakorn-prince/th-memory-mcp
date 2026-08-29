import { z } from "zod";
import { db, truncate, ok, err, type ToolResult } from "../db/index.js";
import {
  CAPTURE_KINDS,
  type CaptureKind,
  type InteractionRow,
} from "../lib/capture-core.js";

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
};

const RECENT_BUDGET = 4000;
const ITEM_BUDGET = 300;
const selectAny = db.prepare(
  "SELECT id, ts, kind, content FROM interactions ORDER BY id DESC LIMIT ?"
);
const selectByKind = db.prepare(
  "SELECT id, ts, kind, content FROM interactions WHERE kind = ? ORDER BY id DESC LIMIT ?"
);

export async function getRecentInteractionsHandler(args: {
  limit: number;
  kind?: CaptureKind;
}): Promise<ToolResult> {
  try {
    const limit = args.limit;
    const rows = (
      args.kind
        ? selectByKind.all(args.kind, limit)
        : selectAny.all(limit)
    ) as InteractionRow[];

    if (rows.length === 0) {
      return ok(
        `no interactions found${args.kind ? ` with kind '${args.kind}'` : ""}`
      );
    }

    const lines = rows.map(
      (r) => `[${r.id}] ${r.ts} [${r.kind}] ${truncate(r.content, ITEM_BUDGET)}`
    );
    return ok(truncate(lines.join("\n"), RECENT_BUDGET));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
