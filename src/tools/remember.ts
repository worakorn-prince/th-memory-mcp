import { z } from "zod";
import {
  db,
  nowISO,
  syncSearchIndex,
  ok,
  err,
  type ToolResult,
} from "../db.js";

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
  { id: number; confidence: number }
>("SELECT id, confidence FROM preferences WHERE category = @category AND key = @key");

const insertPref = db.prepare(
  `INSERT INTO preferences (category, key, value, confidence, source, updated_at) VALUES (?, ?, ?, ${CONFIDENCE_INITIAL}, 'explicit', ?)`
);

const updatePref = db.prepare(
  `UPDATE preferences SET value = ?, confidence = MIN(confidence + ${CONFIDENCE_STEP}, ${CONFIDENCE_MAX}), updated_at = ? WHERE id = ?`
);

export async function rememberHandler(args: {
  category: "work_style" | "coding_pref" | "language" | "domain" | "other";
  key: string;
  value: string;
}): Promise<ToolResult> {
  try {
    const existing = selectPref.get({ category: args.category, key: args.key });
    let id: number;
    let confidence: number;
    if (existing) {
      updatePref.run(args.value, nowISO(), existing.id);
      id = existing.id;
      confidence = Math.min(existing.confidence + CONFIDENCE_STEP, CONFIDENCE_MAX);
    } else {
      const res = insertPref.run(
        args.category,
        args.key,
        args.value,
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
    return ok(
      `remembered [${args.category}] ${args.key} = ${args.value} (preference id=${id}, confidence=${confidence.toFixed(2)})`
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
