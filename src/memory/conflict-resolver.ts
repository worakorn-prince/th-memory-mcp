import { db, nowISO } from "../db/index.js";
import { getMemoryById } from "../db/repositories/memories.js";
import { supersede, reinforce, softDelete } from "../core/lifecycle-engine.js";
import { embed, cosine, deserialize } from "../lib/embed.js";
import type { MemoryType } from "./types.js";

export type Relation = "duplicate" | "update" | "contradiction" | "unrelated";

export interface Candidate {
  type: MemoryType;
  content: string;
  id?: number; // id of the already-created memory (if caller created it first)
}

export interface Resolution {
  relation: Relation;
  relatedId?: number;
  score: number;
  action: "none" | "superseded" | "linked_contradiction" | "merged";
}

const SIM_DUP = 0.9;
const SIM_UPDATE = 0.45;
const SIM_CONTRA = 0.35;
const RELATED_THRESHOLD = 0.35;

const NEGATION = [
  /\bnot\b/i,
  /\bnever\b/i,
  /\bno longer\b/i,
  /\bstop\b/i,
  /\bavoid\b/i,
  /\bdon'?t\b/i,
  /\binstead\b/i,
  /\bbut\b/i,
  /\bhowever\b/i,
  /ไม่/i,
  /ห้าม/i,
  /เลิก/i,
  /อย่า/i,
];

// Opposite-value lexicon for ambiguous preference conflicts (preserve, don't
// silently supersede). A pair is contradictory when each side names a different
// antonym from this set.
export const ANTONYMS = new Set<string>([
  "tabs", "spaces", "vim", "emacs", "light", "dark",
  "mysql", "postgres", "windows", "mac", "linux",
  "react", "vue", "ios", "android",
  "ชา", "กาแฟ", "แมว", "สุนัข", "กลางคืน", "กลางวัน", "ร้อน", "เย็น", "หวาน", "เค็ม",
  "เปิด", "ปิด", "ซ้าย", "ขวา", "บน", "ล่าง", "ก่อน", "หลัง", "ไทย", "อังกฤษ",
]);

function parseAntonymsExtra(raw: string): string[] {
  return raw.split(/[\s,;\n|:\/]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
}
if (process.env.MEMORY_ANTONYMS_EXTRA) {
  for (const w of parseAntonymsExtra(process.env.MEMORY_ANTONYMS_EXTRA)) ANTONYMS.add(w);
}
export function addAntonyms(...words: (string | string[])[]): void {
  for (const w of words.flat()) {
    for (const t of parseAntonymsExtra(String(w))) ANTONYMS.add(t);
  }
}
export function getAntonyms(): string[] { return [...ANTONYMS]; }

export function isContradiction(a: string, b: string): boolean {
  const na = NEGATION.some((re) => re.test(a));
  const nb = NEGATION.some((re) => re.test(b));
  if (na === nb) return false; // both or neither negated -> not a simple contradiction
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  return overlap >= 2;
}

// True when the two texts each name a *different* antonym from ANTONYMS
// (e.g. "Prefer tabs" vs "Prefer spaces"). Used to preserve ambiguous
// conflicts as contradictions instead of destructively superseding them.
export function hasAntonymPair(a: string, b: string): boolean {
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  let aAnt: string | undefined;
  let bAnt: string | undefined;
  for (const w of ANTONYMS) {
    if (ta.has(w) || lowerA.includes(w)) aAnt = w;
    if (tb.has(w) || lowerB.includes(w)) bAnt = w;
  }
  // Find distinct pair: ensure each side has at least one and they are different
  if (!aAnt || !bAnt) return false;
  if (aAnt === bAnt) {
    // Check if there are other hits that give distinct pair
    const hitsA = [...ANTONYMS].filter((w) => ta.has(w) || lowerA.includes(w));
    const hitsB = [...ANTONYMS].filter((w) => tb.has(w) || lowerB.includes(w));
    for (const ha of hitsA) for (const hb of hitsB) if (ha !== hb) return true;
    return false;
  }
  return true;
}

function tokenSet(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[a-z0-9ก-์]+/gi) ?? []);
}

export function classifyRelationship(
  candidate: Candidate,
  relatedId: number
): Relation {
  const rel = getMemoryById(relatedId);
  if (!rel) return "unrelated";
  const relVecRow = db
    .prepare(
      "SELECT vec FROM embeddings WHERE ref_table='memories' AND ref_id=?"
    )
    .get(relatedId) as { vec: Buffer } | undefined;
  if (!relVecRow) return "unrelated";
  const score = cosine(embed(candidate.content), deserialize(relVecRow.vec));
  const ta = tokenSet(candidate.content);
  const tb = tokenSet(rel.content);
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap++;
  const jac = overlap / (ta.size + tb.size - overlap || 1);

  if (score >= SIM_DUP) return "duplicate";
  if (isContradiction(candidate.content, rel.content) && score >= SIM_CONTRA) {
    return "contradiction";
  }
  if (hasAntonymPair(candidate.content, rel.content)) {
    return "contradiction";
  }
  if (score >= 0.6 && jac >= 0.5) return "duplicate";
  if (score >= SIM_UPDATE && jac >= 0.25) return "update";
  return "unrelated";
}

// Find best related active/non-archived memory of the same type for a candidate.
export function findRelated(
  candidate: Candidate,
  threshold = RELATED_THRESHOLD
): { id: number; score: number } | undefined {
  const vec = embed(candidate.content);
  const rows = db
    .prepare("SELECT ref_id, vec FROM embeddings WHERE ref_table = 'memories'")
    .all() as Array<{ ref_id: number; vec: Buffer }>;
  let best: { id: number; score: number } | undefined;
  for (const r of rows) {
    if (candidate.id && r.ref_id === candidate.id) continue;
    const m = getMemoryById(r.ref_id);
    if (
      !m ||
      m.type !== candidate.type ||
      m.status === "deleted" ||
      m.status === "archived"
    )
      continue;
    const score = cosine(vec, deserialize(r.vec));
    if (score >= threshold && (!best || score > best.score)) {
      best = { id: r.ref_id, score };
    }
  }
  return best;
}

// Resolve a candidate against existing memories. If candidate.id is set (memory
// already created), it will be reconciled (superseded / linked / merged).
export function resolveConflict(candidate: Candidate): Resolution {
  const related = findRelated(candidate);
  if (!related) return { relation: "unrelated", score: 0, action: "none" };
  const relation = classifyRelationship(candidate, related.id);

  if (relation === "duplicate" && candidate.id !== undefined) {
    reinforce(related.id);
    softDelete(candidate.id);
    return {
      relation,
      relatedId: related.id,
      score: related.score,
      action: "merged",
    };
  }
  if (relation === "update" && candidate.id !== undefined) {
    supersede(related.id, candidate.id);
    return {
      relation,
      relatedId: related.id,
      score: related.score,
      action: "superseded",
    };
  }
  if (relation === "contradiction" && candidate.id !== undefined) {
    db.prepare(
      `INSERT INTO memory_links (source_memory_id, relation, target_memory_id, confidence, created_at)
       VALUES (?, 'contradicts', ?, 0.8, ?)
       ON CONFLICT(source_memory_id, relation, target_memory_id) DO UPDATE SET confidence = 0.8`
    ).run(candidate.id, related.id, nowISO());
    return {
      relation,
      relatedId: related.id,
      score: related.score,
      action: "linked_contradiction",
    };
  }
  return {
    relation,
    relatedId: related.id,
    score: related.score,
    action: "none",
  };
}
