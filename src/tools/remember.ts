import { z } from "zod";
import {
  db,
  nowISO,
  syncSearchIndex,
  upsertEmbedding,
  ok,
  err,
  type ToolResult,
} from "../db/index.js";
import { embed } from "../lib/embed.js";
import { redactSecrets } from "../lib/redact.js";
import { getEffectiveScope } from "../auth/scope-resolver.js";

export const rememberInput = {
  category: z
    .enum(["work_style", "coding_pref", "language", "domain", "other"])
    .describe("Preference category"),
  key: z.string().min(1).max(200).describe("Short stable key, e.g. package_manager"),
  value: z.string().min(1).max(2000).describe("The preference value"),
};

const CONFIDENCE_INITIAL = 0.5;
const CONFIDENCE_STEP = 0.1;
const CONFIDENCE_MAX = 1.0;

const selectPref = db.prepare<
  [{ category: string; key: string }],
  { id: number; confidence: number; user_id: number | null }
>("SELECT id, confidence, user_id FROM preferences WHERE category = @category AND key = @key");

const insertPref = db.prepare(
  `INSERT INTO preferences (category, key, value, confidence, source, user_id, updated_at) VALUES (?, ?, ?, ${CONFIDENCE_INITIAL}, 'explicit', ?, ?)`
);

const updatePref = db.prepare(
  `UPDATE preferences SET value = ?, confidence = MIN(confidence + ${CONFIDENCE_STEP}, ${CONFIDENCE_MAX}), updated_at = ? WHERE id = ?`
);

type RememberRequest = {
  category: "work_style" | "coding_pref" | "language" | "domain" | "other";
  key: string;
  value: string;
};

type RememberArgs = RememberRequest & {
  /** Bound owner in enforced mode, NULL in legacy (shared/global row). */
  ownerUid: number | null;
};

// `.immediate` (not deferred): this transaction SELECTs the preference and then
// writes it. A deferred BEGIN takes a read snapshot first, so a commit from
// another connection in between makes the later write fail with
// SQLITE_BUSY_SNAPSHOT — which busy_timeout does not retry (same trap as
// syncSearchIndex in db/index.ts). IMMEDIATE takes the write lock up front.
const applyRemember = db.transaction(
  (args: RememberArgs): { id: number; confidence: number } => {
    const existing = selectPref.get({ category: args.category, key: args.key });
    let id: number;
    let confidence: number;
    if (existing) {
      // Ph-3: (category,key) is unique across the whole table, so the only
      // safe reaction to a row owned by another user is a bounded deny — never
      // a silent overwrite of someone else's preference.
      if (
        args.ownerUid !== null &&
        existing.user_id !== null &&
        existing.user_id !== args.ownerUid
      ) {
        throw new Error("denied: preference belongs to another user (auth enforced)");
      }
      updatePref.run(args.value, nowISO(), existing.id);
      id = existing.id;
      confidence = Math.min(existing.confidence + CONFIDENCE_STEP, CONFIDENCE_MAX);
    } else {
      const res = insertPref.run(
        args.category,
        args.key,
        args.value,
        args.ownerUid,
        nowISO()
      );
      id = Number(res.lastInsertRowid);
      confidence = CONFIDENCE_INITIAL;
    }
    syncSearchIndex(
      "preferences",
      id,
      `${args.category}/${args.key}`,
      `${args.key}: ${args.value}`
    );
    upsertEmbedding("preferences", id, embed(`${args.category} ${args.key} ${args.value}`));
    return { id, confidence };
  }
).immediate;

export async function rememberHandler(args: RememberRequest): Promise<ToolResult> {
  try {
    const key = redactSecrets(args.key);
    const value = redactSecrets(args.value);
    const scope = getEffectiveScope();
    const ownerUid = scope !== null ? (scope.uid ?? null) : null;
    const { id, confidence } = applyRemember({ ...args, key, value, ownerUid });
    return ok(
      `remembered [${args.category}] ${key} = ${value} (preference id=${id}, confidence=${confidence.toFixed(2)})`
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
