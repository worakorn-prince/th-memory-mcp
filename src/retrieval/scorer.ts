import type { MemoryRecord } from "../memory/types.js";
import { clamp01 } from "../memory/scorer.js";

export interface FinalScoreInput {
  rrf: number; // fused RRF score
  confidence: number;
  importance: number;
  recency: number; // 0..1
  scopeFactor: number; // 0..1
}

// spec §13.1: final_score = RRF * confidence * importance_factor * recency_factor * scope_factor
export function finalScore(input: FinalScoreInput): number {
  const importanceFactor = 0.5 + 0.5 * clamp01(input.importance); // 0.5..1.0
  return (
    input.rrf *
    clamp01(input.confidence) *
    importanceFactor *
    clamp01(input.recency) *
    clamp01(input.scopeFactor)
  );
}

export function scopeFactorFor(
  mem: MemoryRecord,
  opts: {
    projectId?: string | null;
    sessionId?: string | null;
    userId?: number | null;
  } = {}
): number {
  const { projectId, sessionId, userId } = opts;
  const memScope = mem.scope ?? "GLOBAL";
  if (sessionId) {
    if (memScope === "SESSION" && mem.session_id === sessionId) return 1.0;
    if (memScope === "PROJECT" && mem.project_id === projectId) return 0.8;
    if (memScope === "USER" && mem.user_id === userId) return 0.8;
    if (memScope === "GLOBAL") return 0.6;
    return 0.2;
  }
  if (projectId) {
    if (memScope === "PROJECT" && mem.project_id === projectId) return 1.0;
    if (memScope === "USER" && mem.user_id === userId) return 0.8;
    if (memScope === "GLOBAL") return 0.7;
    return 0.3;
  }
  if (userId) {
    if (memScope === "USER" && mem.user_id === userId) return 1.0;
    if (memScope === "GLOBAL") return 0.7;
    return 0.3;
  }
  if (memScope === "GLOBAL") return 0.8;
  if (memScope === "PROJECT") return 0.7;
  if (memScope === "USER") return 0.6;
  return 0.4;
}
