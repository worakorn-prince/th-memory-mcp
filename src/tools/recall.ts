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
  accumulateScores,
  ensureVectors,
  isVectorCacheEnabled,
  patchVectorSlots,
  vectorKey,
  withVectorQuery,
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

// TASK-PERF-MATRIX: one resolved table slice of the semantic blend — the ids
// read in `getAllEmbeddingKeys()` order, their matrix slots, the row index each
// id came from (so the scored list can be rebuilt in the original order), and
// the vectors the miss fill fetched (used for rows that cannot be resident:
// no row, or a table bigger than the per-bucket capacity cap).
interface RecallGroup {
  table: string;
  ids: Int32Array;
  rows: Int32Array;
  slots: Int32Array;
  fetched: Map<string, Float32Array> | null;
}

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
        // TASK-PERF-MATRIX: the vectors are grouped per ref_table because the
        // cache holds one contiguous matrix per table; slots are resolved once
        // per table and the dot products run in one linear pass per matrix.
        // The scored list is rebuilt in `getAllEmbeddingKeys()` order, so the
        // stable sort keeps the same tie order as before.
        const ordered = withVectorQuery(
          ["memories", "preferences", "lessons"],
          () => {
            const { keys, groups } = withVectorSnapshot(() => {
              const keys = getAllEmbeddingKeys();
              const byTable = new Map<
                string,
                { ids: number[]; rows: number[] }
              >();
              for (let i = 0; i < keys.length; i++) {
                const k = keys[i]!;
                let group = byTable.get(k.ref_table);
                if (!group) {
                  group = { ids: [], rows: [] };
                  byTable.set(k.ref_table, group);
                }
                group.ids.push(k.ref_id);
                group.rows.push(i);
              }
              const groups: RecallGroup[] = [];
              for (const [table, group] of byTable) {
                const ids = Int32Array.from(group.ids);
                const slots = ensureVectors(table, ids);
                let missing = 0;
                for (let i = 0; i < ids.length; i++) {
                  if (slots[i]! < 0) missing++;
                }
                let fetched: Map<string, Float32Array> | null = null;
                if (missing > 0) {
                  const missKeys: EmbeddingKey[] = [];
                  for (let i = 0; i < ids.length; i++) {
                    if (slots[i]! < 0) {
                      missKeys.push({ ref_table: table, ref_id: ids[i]! });
                    }
                  }
                  fetched = getEmbeddingsByKeys(missKeys);
                  patchVectorSlots(table, ids, slots);
                }
                groups.push({
                  table,
                  ids,
                  rows: Int32Array.from(group.rows),
                  slots,
                  fetched,
                });
              }
              return { keys, groups };
            });

            const rowScores = new Float64Array(keys.length);
            const rowHasScore = new Uint8Array(keys.length);
            for (const group of groups) {
              const scores = accumulateScores(group.table, topicVec);
              for (let i = 0; i < group.ids.length; i++) {
                const slot = group.slots[i]!;
                let score: number;
                if (slot >= 0 && scores) {
                  score = scores[slot]!;
                } else {
                  // Not resident (no row, or over the bucket's capacity cap):
                  // score the fetched vector exactly like the cache-off path.
                  const vec = group.fetched?.get(
                    vectorKey(group.table, group.ids[i]!)
                  );
                  if (!vec) continue;
                  score = cosine(topicVec, vec);
                }
                const row = group.rows[i]!;
                rowScores[row] = score;
                rowHasScore[row] = 1;
              }
            }

            const out: Array<{ table: string; id: number; score: number }> = [];
            for (let i = 0; i < keys.length; i++) {
              if (!rowHasScore[i]) continue;
              const k = keys[i]!;
              out.push({
                table: k.ref_table,
                id: k.ref_id,
                score: rowScores[i]!,
              });
            }
            return out;
          }
        );
        scored.push(...ordered);
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
