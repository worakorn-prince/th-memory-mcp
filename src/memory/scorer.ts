import type { MemoryType } from "./types.js";
import { sourceWeight } from "./source-weights.js";
import { recencyFactorFor } from "./decay.js";

export interface SalienceWeights {
  semanticRelevance: number;
  importance: number;
  confidence: number;
  recency: number;
  accessFrequency: number;
  projectRelevance: number;
}

export const DEFAULT_SALIENCE_WEIGHTS: SalienceWeights = {
  semanticRelevance: 0.3,
  importance: 0.2,
  confidence: 0.15,
  recency: 0.15,
  accessFrequency: 0.1,
  projectRelevance: 0.1,
};

export interface SalienceInput {
  relevance: number; // 0..1 semantic relevance for this query
  importance: number; // 0..1
  confidence: number; // 0..1
  recency: number; // 0..1 (already computed)
  accessFrequency: number; // 0..1 normalized
  projectRelevance: number; // 0..1
  weights?: Partial<SalienceWeights>;
}

export function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

export function computeSalience(input: SalienceInput): number {
  const w = { ...DEFAULT_SALIENCE_WEIGHTS, ...(input.weights ?? {}) };
  const raw =
    w.semanticRelevance * clamp01(input.relevance) +
    w.importance * clamp01(input.importance) +
    w.confidence * clamp01(input.confidence) +
    w.recency * clamp01(input.recency) +
    w.accessFrequency * clamp01(input.accessFrequency) +
    w.projectRelevance * clamp01(input.projectRelevance);
  return clamp01(raw);
}

// Confidence with diminishing returns: starts at the source weight and rises
// toward 1.0 as confirmations accumulate (repeated identical events add less).
export interface ConfidenceInput {
  source: import("./types.js").SourceType;
  confirmations: number; // number of times reinforced/confirmed
}

export function computeConfidence(input: ConfidenceInput): number {
  const w = sourceWeight(input.source);
  const n = Math.max(0, input.confirmations);
  const next = w + (1 - w) * (1 - 1 / (1 + n));
  return clamp01(next);
}

// Convenience: build salience from a memory record + query relevance.
export function salienceForMemory(params: {
  type: MemoryType;
  importance: number;
  confidence: number;
  updatedAt: string;
  accessCount: number;
  relevance: number;
  projectRelevance?: number;
  maxAccess?: number;
}): number {
  const recency = recencyFactorFor(params.type, params.updatedAt);
  const accessFrequency = clamp01(
    params.accessCount / (params.maxAccess ?? 10)
  );
  return computeSalience({
    relevance: params.relevance,
    importance: params.importance,
    confidence: params.confidence,
    recency,
    accessFrequency,
    projectRelevance: params.projectRelevance ?? 0.5,
  });
}
