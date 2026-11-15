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
import { getIdentity } from "../auth/identity.js";
import { hasRole } from "../auth/policy.js";
import { getEffectiveScope } from "../auth/scope-resolver.js";

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
// Ph-3 enforced variants: user_id bounds the row set (NULL = anonymous, visible
// to owner/admin only). session_id stays a pure filter on top of it — the tool
// is in FILTER_ONLY_SCOPE_TOOLS, so it needs no grant and can never widen rows.
const selectAnyScoped = db.prepare(
  "SELECT id, ts, kind, content FROM interactions WHERE (? IS NULL OR session_id = ?) AND (user_id = ? OR (? = 1 AND user_id IS NULL)) ORDER BY id DESC LIMIT ?"
);
const selectByKindScoped = db.prepare(
  "SELECT id, ts, kind, content FROM interactions WHERE kind = ? AND (? IS NULL OR session_id = ?) AND (user_id = ? OR (? = 1 AND user_id IS NULL)) ORDER BY id DESC LIMIT ?"
);

export async function getRecentInteractionsHandler(args: {
  limit: number;
  kind?: CaptureKind;
  sessionId?: string;
}): Promise<ToolResult> {
  try {
    const limit = args.limit ?? 20;
    const sessionId = args.sessionId ?? null;
    const scope = getEffectiveScope();
    const uid = scope !== null ? (scope.uid ?? -1) : -1;
    const ownerFlag =
      scope !== null ? (hasRole(getIdentity(), "owner") ? 1 : 0) : 0;
    const rows = (
      scope === null
        ? args.kind
          ? selectByKind.all(args.kind, sessionId, sessionId, limit)
          : selectAny.all(sessionId, sessionId, limit)
        : args.kind
        ? selectByKindScoped.all(
            args.kind,
            sessionId,
            sessionId,
            uid,
            ownerFlag,
            limit
          )
        : selectAnyScoped.all(sessionId, sessionId, uid, ownerFlag, limit)
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
