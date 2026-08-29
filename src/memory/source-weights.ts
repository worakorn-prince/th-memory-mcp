import type { SourceType } from "./types.js";

// Recommended source weights for confidence (spec §8). Defaults, not immutable constants.
export const SOURCE_WEIGHTS: Record<SourceType, number> = {
  explicit: 1.0,
  corrected: 0.95,
  system: 0.8,
  consolidated: 0.75,
  imported: 0.7,
  inferred: 0.5,
  captured: 0.3,
};

export function sourceWeight(source: SourceType): number {
  return SOURCE_WEIGHTS[source] ?? 0.5;
}
