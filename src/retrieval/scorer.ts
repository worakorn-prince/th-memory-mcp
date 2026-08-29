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
  projectId?: string | null
): number {
  if (!projectId) return 0.8; // global query: project-scoped memories slightly favored
  if (mem.project_id === projectId) return 1.0;
  if (mem.project_id === null) return 0.7;
  return 0.3; // different project
}
