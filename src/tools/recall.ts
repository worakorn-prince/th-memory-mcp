import { z } from "zod";
import {
  db,
  buildFtsMatch,
  buildLooseFtsMatch,
  escapeLike,
  truncate,
  getAllEmbeddingKeys,
  getAllEmbeddings,
  getEmbeddingsByKeys,
  ok,
  err,
  withVectorSnapshot,
  type EmbeddingKey,
  type ToolResult,
} from "../db/index.js";
import { embed, cosine, deserialize } from "../lib/embed.js";
import {
  getVector,
  isVectorCacheEnabled,
  vectorKey,
} from "../retrieval/vector-cache.js";
import { redactSecrets } from "../lib/redact.js";
import { wrapMemoryReference } from "../lib/memory-format.js";

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
// LOOSE channel (TASK-THAI-LOOSE): de-accented fallback on search_index_loose,
// only consulted when the strict path yields fewer than `limit` rows, and its
// hits are always appended BELOW strict hits (never displacing them).
const searchIndexedLoose = db.prepare(
  "SELECT ref_table, ref_id, title, body FROM search_index_loose WHERE search_index_loose MATCH ? AND ref_table IN ('preferences','lessons') LIMIT ?"
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
      const strictRows = searchIndexed.all(buildFtsMatch(args.topic), limit) as {
        ref_table: string;
        ref_id: number;
        title: string;
        body: string;
      }[];
      const rows = [...strictRows];
      if (strictRows.length < limit) {
        const seenLoose = new Set<string>(
          strictRows.map((r) => `${String(r.ref_table)}:${String(r.ref_id)}`)
        );
        const looseRows = searchIndexedLoose.all(
          buildLooseFtsMatch(args.topic),
          limit
        ) as {
          ref_table: string;
          ref_id: number;
          title: string;
          body: string;
        }[];
        for (const r of looseRows) {
          if (rows.length >= limit) break;
          const key = `${String(r.ref_table)}:${String(r.ref_id)}`;
          if (seenLoose.has(key)) continue;
          seenLoose.add(key);
          rows.push(r);
        }
      }
      for (const r of rows) {
        if (r.ref_table === "preferences") {
          const line = prefLine(Number(r.ref_id));
          if (line) {
            prefLines += line + "\n";
            seen.add(`p:${String(r.ref_id)}`);
          }
        } else if (r.ref_table === "lessons") {
          const line = lessonLine(Number(r.ref_id));
          if (line) {
            lessonLines += line + "\n";
            seen.add(`l:${String(r.ref_id)}`);
          }
        }
      }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[recall] preference/lesson search failed: ${redactSecrets(msg)}`);
    prefLines = "";
    lessonLines = "";
  }

    // Semantic blend: surface vector neighbors missed by keyword search.
    try {
      const topicVec = embed(args.topic);
      const scored: Array<{ table: string; id: number; score: number }> = [];
      if (!isVectorCacheEnabled()) {
        // Opt-out path: the historical full payload read + per-row decode.
        const all = getAllEmbeddings();
        for (const row of all) {
          scored.push({
            table: row.ref_table,
            id: row.ref_id,
            score: cosine(topicVec, deserialize(row.vec)),
          });
        }
      } else {
        // TASK-PERF-READ: same rows in the same order (ids-only twin of
        // getAllEmbeddings), vectors resolved from the decoded-vector cache;
        // misses are filled with one batched BLOB read. The ids read and the
        // fill share one deferred snapshot (see withVectorSnapshot) so a
        // concurrent writer cannot drop or reuse a row between the statements.
        // Each key is looked up exactly once: resolving it a second time in the
        // scoring loop both doubled the lookups and inflated the hit/miss
        // counters.
        const { entries, kept, fetched } = withVectorSnapshot(() => {
          const keys = getAllEmbeddingKeys();
          const entries = keys.map((k) => ({
            table: k.ref_table,
            id: k.ref_id,
            key: vectorKey(k.ref_table, k.ref_id),
          }));
          const kept = entries.map((e) => getVector(e.key));
          const missing: EmbeddingKey[] = [];
          for (let i = 0; i < entries.length; i++) {
            if (!kept[i]) {
              missing.push({
                ref_table: entries[i]!.table,
                ref_id: entries[i]!.id,
              });
            }
          }
          const fetched =
            missing.length > 0 ? getEmbeddingsByKeys(missing) : null;
          return { entries, kept, fetched };
        });
        for (let i = 0; i < entries.length; i++) {
          const e = entries[i]!;
          const vec = kept[i] ?? fetched?.get(e.key);
          if (!vec) continue;
          scored.push({
            table: e.table,
            id: e.id,
            score: cosine(topicVec, vec),
          });
        }
      }
      const top = scored
        .filter((x) => x.score >= SEMANTIC_FLOOR)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      for (const x of top) {
        const key = `${x.table[0]}:${String(x.id)}`;
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
      console.error(`[recall] semantic search failed: ${redactSecrets(msg)}`);
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
      console.error(`[recall] interaction search failed: ${redactSecrets(msg)}`);
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

    // Batch B-2: recalled memory is reference data, not instructions.
    return ok(
      wrapMemoryReference(truncate(parts.join("\n\n"), RECALL_BUDGET))
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
