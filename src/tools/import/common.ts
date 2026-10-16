import { SOURCE_TYPES } from "../../memory/types.js";

export function isValidSource(s: string): boolean {
  return (SOURCE_TYPES as readonly string[]).includes(s);
}

// Batch A-2: normalize the per-item trust marker. Accepts boolean true,
// "trusted"/"trust"/"yes"/"1" strings as trusted; everything else (including
// missing) defaults to untrusted (false). No schema change — the flag is
// carried inside memory metadata as { trusted: boolean } for team B delimiters.
export function parseTrustedFlag(v: unknown): boolean {
  // Strict: only a boolean true marks a source trusted. String aliases
  // ("yes"/"true"/"1") are NOT accepted — otherwise a caller could pass
  // trusted:"yes" and bypass the untrusted-import label.
  return v === true;
}

export function withTrustedFlag(meta: unknown, trusted: unknown): unknown {
  const flag = parseTrustedFlag(trusted);
  if (meta == null) return { trusted: flag };
  if (typeof meta === "object" && !Array.isArray(meta)) {
    return { ...(meta as Record<string, unknown>), trusted: flag };
  }
  // Non-object legacy metadata cannot carry a field — wrap it so the
  // contract metadata.trusted stays readable without altering the DB schema.
  return { value: meta, trusted: flag };
}
