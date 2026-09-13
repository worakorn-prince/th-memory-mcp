import { z } from "zod";

// Single source of truth for strict ISO datetime validation.
// Requires a full datetime with timezone offset (e.g. 2024-01-01T00:00:00.000Z).
// Date-only strings like "2024-01-01" are intentionally rejected: they are
// ambiguous (no timezone) and break validFrom<=validUntil comparisons.
export const isoDateTimeSchema = z.string().datetime({ offset: true });

export function isIsoDateString(s: unknown): boolean {
  if (typeof s !== "string") return false;
  return isoDateTimeSchema.safeParse(s).success;
}
