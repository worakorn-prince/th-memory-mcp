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

export const saveLessonInput = {
  situation: z.string().min(1).max(1000).describe("The original situation/context"),
  mistake: z.string().min(1).max(1000).describe("What was done wrong"),
  correction: z.string().min(1).max(1000).describe("The correct approach"),
};

const LESSON_TITLE_MAX = 80;

const insertLesson = db.prepare(
  "INSERT INTO lessons (situation, mistake, correction, created_at) VALUES (?, ?, ?, ?)"
);

export async function saveLessonHandler(args: {
  situation: string;
  mistake: string;
  correction: string;
}): Promise<ToolResult> {
  try {
    const res = insertLesson.run(
      args.situation,
      args.mistake,
      args.correction,
      nowISO()
    );
    const id = Number(res.lastInsertRowid);
    syncSearchIndex(
      "lessons",
      id,
      args.situation.slice(0, LESSON_TITLE_MAX),
      `${args.situation} | mistake: ${args.mistake} -> correction: ${args.correction}`
    );
    upsertEmbedding(
      "lessons",
      id,
      embed(`${args.situation} ${args.mistake} ${args.correction}`)
    );
    return ok(`lesson saved (lesson id=${id})`);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
