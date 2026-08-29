import type { MemoryType } from "./types.js";

// Per-type decay rate (lambda) for recency = exp(-lambda * age_days).
// Lower lambda => slower decay (more durable). Policy classes, not fixed constants.
export const DECAY_LAMBDA_BY_TYPE: Record<MemoryType, number> = {
  CONSTRAINT: 0.0005,
  DECISION: 0.001,
  LESSON: 0.001,
  PREFERENCE: 0.001,
  FACT: 0.005,
  GOAL: 0.01,
  PROCEDURE: 0.005,
  EPISODE: 0.01,
  RELATION: 0.005,
  PROFILE: 0.0,
  DERIVED: 0.002,
};

export function decayLambdaFor(type: MemoryType): number {
  return DECAY_LAMBDA_BY_TYPE[type] ?? 0.005;
}

export function ageInDays(isoTs: string, now: Date = new Date()): number {
  const t = new Date(isoTs).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.max(0, (now.getTime() - t) / 86_400_000);
}

export function recencyFactor(
  isoTs: string,
  lambda: number,
  now: Date = new Date()
): number {
  return Math.exp(-lambda * ageInDays(isoTs, now));
}

export function recencyFactorFor(
  type: MemoryType,
  isoTs: string,
  now: Date = new Date()
): number {
  return recencyFactor(isoTs, decayLambdaFor(type), now);
}
