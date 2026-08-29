import { z } from "zod";
import {
  db,
  buildFtsMatch,
  escapeLike,
  truncate,
  getAllEmbeddings,
  ok,
  err,
  type ToolResult,
} from "../db/index.js";
import { embed, cosine, deserialize } from "../lib/embed.js";

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
const SEMANTIC_FLOOR = 0.15;
const searchIndexed = db.prepare(
  "SELECT ref_table, ref_id, title, body FROM search_index WHERE search_index MATCH ? AND ref_table IN ('preferences','lessons') LIMIT ?"
);
const recentInteractions = db.prepare(
  `SELECT ts, kind, content FROM interactions WHERE content LIKE ? ESCAPE '\\' ORDER BY ts DESC LIMIT ${RECENT_INTERACTIONS_LIMIT}`
);
const prefById = db.prepare(
  "SELECT category, key, value FROM preferences WHERE id = ?"
);
const lessonById = db.prepare(
  "SELECT situation, mistake, correction FROM lessons WHERE id = ?"
);

function prefLine(id: number): string | null {
  const r = prefById.get(id) as
    | { category: string; key: string; value: string }
    | undefined;
  if (!r) return null;
  return `- ${truncate(`${r.category}/${r.key}`, 120)} | ${truncate(`${r.key}: ${r.value}`, 200)}`;
}
function lessonLine(id: number): string | null {
  const r = lessonById.get(id) as
    | { situation: string; mistake: string; correction: string }
    | undefined;
  if (!r) return null;
  return `- ${truncate(r.situation, 120)} | ${truncate(`mistake: ${r.mistake} -> correction: ${r.correction}`, 300)}`;
}

export async function recallHandler(args: {
  topic: string;
  limit: number;
}): Promise<ToolResult> {
  try {
        const limit = args.limit ?? 8;
    const parts: string[] = [];

    const seen = new Set<string>();
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
          const line = prefLine(Number(r.ref_id));
          if (line) {
            prefLines += line + "\n";
            seen.add(`p:${r.ref_id}`);
          }
        } else if (r.ref_table === "lessons") {
          const line = lessonLine(Number(r.ref_id));
          if (line) {
            lessonLines += line + "\n";
            seen.add(`l:${r.ref_id}`);
          }
        }
      }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[recall] preference/lesson search failed:", msg);
    prefLines = "";
    lessonLines = "";
  }

    // Semantic blend: surface vector neighbors missed by keyword search.
    try {
      const topicVec = embed(args.topic);
      const all = getAllEmbeddings();
      const scored = all
        .map((row) => ({
          table: row.ref_table,
          id: row.ref_id,
          score: cosine(topicVec, deserialize(row.vec)),
        }))
        .filter((x) => x.score >= SEMANTIC_FLOOR)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      for (const x of scored) {
        const key = `${x.table[0]}:${x.id}`;
        if (seen.has(key)) continue;
        if (x.table === "preferences") {
          const line = prefLine(x.id);
          if (line) {
            prefLines += line + "\n";
            seen.add(key);
          }
        } else if (x.table === "lessons") {
          const line = lessonLine(x.id);
          if (line) {
            lessonLines += line + "\n";
            seen.add(key);
          }
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[recall] semantic search failed:", msg);
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
