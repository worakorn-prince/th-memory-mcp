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
  if (score >= SIM_DUP) return "duplicate";
  if (isContradiction(candidate.content, rel.content) && score >= SIM_CONTRA) {
    return "contradiction";
  }
  if (score >= SIM_UPDATE) return "update";
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
