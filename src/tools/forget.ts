import { z } from "zod";
import {
  db,
  removeSearchIndex,
  removeEmbedding,
  ok,
  err,
  type ToolResult,
} from "../db.js";

export const forgetInput = {
  target_id: z
    .number()
    .int()
    .positive()
    .describe("Row id to delete (id returned by remember/save_lesson)"),
  type: z
    .enum(["preference", "lesson", "interaction"])
    .optional()
    .describe(
      "Which table the id belongs to. Recommended whenever known, because numeric ids can coincide across tables."
    ),
};

const indexTables = db.prepare(
  "SELECT DISTINCT ref_table FROM search_index WHERE ref_id = ?"
);
const existsPreference = db.prepare("SELECT id FROM preferences WHERE id = ?");
const existsLesson = db.prepare("SELECT id FROM lessons WHERE id = ?");
const existsInteraction = db.prepare("SELECT id FROM interactions WHERE id = ?");
const delPreference = db.prepare("DELETE FROM preferences WHERE id = ?");
const delLesson = db.prepare("DELETE FROM lessons WHERE id = ?");
const delInteraction = db.prepare("DELETE FROM interactions WHERE id = ?");

type Kind = "preferences" | "lessons" | "interactions";

function existsIn(kind: Kind, id: number): boolean {
  if (kind === "preferences") {
    return !!existsPreference.get(id);
  }
  if (kind === "lessons") {
    return !!existsLesson.get(id);
  }
  return !!existsInteraction.get(id);
}

export async function forgetHandler(args: {
  target_id: number;
  type?: "preference" | "lesson" | "interaction";
}): Promise<ToolResult> {
  try {
    const id = args.target_id;
    const kindOf: Record<string, Kind> = {
      preference: "preferences",
      lesson: "lessons",
      interaction: "interactions",
    };

    let targets: Kind[] = [];
    const typedKind = args.type ? kindOf[args.type] : undefined;
    if (typedKind) {
      targets = [typedKind];
    } else {
      const indexed = indexTables.all(id) as { ref_table: string }[];
      const evidence = indexed
        .map((r) => r.ref_table)
        .filter((t): t is Kind =>
          t === "preferences" || t === "lessons" || t === "interactions"
        );
      const candidates =
        evidence.length > 0
          ? evidence
          : (["preferences", "lessons", "interactions"] as Kind[]);
      targets = candidates.filter((k) => existsIn(k, id));
    }

    if (targets.length === 0) {
      return ok(`nothing found with id=${id}`);
    }

    const removed: string[] = [];
    db.transaction(() => {
      for (const kind of targets) {
        if (!existsIn(kind, id)) continue;
        if (kind === "preferences") {
          delPreference.run(id);
          removeSearchIndex("preferences", id);
          removeEmbedding("preferences", id);
          removed.push(`preference #${id}`);
        } else if (kind === "lessons") {
          delLesson.run(id);
          removeSearchIndex("lessons", id);
          removeEmbedding("lessons", id);
          removed.push(`lesson #${id}`);
        } else {
          delInteraction.run(id);
          removeSearchIndex("interactions", id);
          removed.push(`interaction #${id}`);
        }
      }
    })();

    if (removed.length === 0) {
      return ok(`nothing found with id=${id}${args.type ? ` (${args.type})` : ""}`);
    }
    return ok(`forgot ${removed.join(", ")}`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
