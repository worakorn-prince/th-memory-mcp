import { deduplicate } from "../../memory/deduplicator.js";
import { MEMORY_TYPES, LIFECYCLE_STATES } from "../../memory/types.js";
import type { MemoryType, LifecycleState } from "../../memory/types.js";
import { isIsoDateString } from "../../lib/iso.js";
import { isValidSource } from "./common.js";
import type { ImportCounts, ImportItem, ValidatedMemory } from "./types.js";

export function validateMemories(
  memoryItems: ImportItem[],
  state: ImportCounts,
  log: string[]
): ValidatedMemory[] {
  const validMemories: ValidatedMemory[] = [];
  // Intra-batch exact-dupe guard: deduplicate() only sees committed rows,
  // so track normalized type+content accepted in THIS batch as well.
  const batchSeen = new Set<string>();

  for (const [idx, it] of memoryItems.entries()) {
    if (
      !it ||
      typeof it.content !== "string" ||
      it.content.length === 0 ||
      it.content.length > 2000 ||
      !MEMORY_TYPES.includes(it.type as MemoryType)
    ) {
      state.invalid++;
      continue;
    }
    if (it.summary != null && (typeof it.summary !== "string" || (it.summary as string).length > 2000)) {
      state.invalid++;
      continue;
    }
    if (it.source != null && typeof it.source === "string" && !isValidSource(it.source)) {
      state.invalid++;
      continue;
    }
    if (it.confidence != null && (typeof it.confidence !== "number" || (it.confidence as number) < 0 || (it.confidence as number) > 1)) {
      state.invalid++;
      continue;
    }
    if (it.importance != null && (typeof it.importance !== "number" || (it.importance as number) < 0 || (it.importance as number) > 1)) {
      state.invalid++;
      continue;
    }
    if (it.salience != null && (typeof it.salience !== "number" || (it.salience as number) < 0 || (it.salience as number) > 1)) {
      state.invalid++;
      continue;
    }
    if (it.status != null && (typeof it.status !== "string" || !LIFECYCLE_STATES.includes(it.status as LifecycleState))) {
      state.invalid++;
      continue;
    }
    if (it.projectId != null && (typeof it.projectId !== "string" || (it.projectId as string).length === 0 || (it.projectId as string).length > 200)) {
      state.invalid++;
      continue;
    }
    if (it.sessionId != null && (typeof it.sessionId !== "string" || (it.sessionId as string).length === 0 || (it.sessionId as string).length > 200)) {
      state.invalid++;
      continue;
    }
    if (it.userId != null && (typeof it.userId !== "string" || (it.userId as string).length === 0 || (it.userId as string).length > 200)) {
      state.invalid++;
      continue;
    }
    if (it.validFrom != null && (typeof it.validFrom !== "string" || !isIsoDateString(it.validFrom as string))) {
      state.invalid++;
      log.push(
        `invalid row ${idx}: validFrom '${String(it.validFrom)}' rejected — must be a full ISO datetime with timezone offset (e.g. 2024-01-01T00:00:00.000Z), date-only '2024-01-01' is not accepted`
      );
      continue;
    }
    if (it.validUntil != null && (typeof it.validUntil !== "string" || !isIsoDateString(it.validUntil as string))) {
      state.invalid++;
      log.push(
        `invalid row ${idx}: validUntil '${String(it.validUntil)}' rejected — must be a full ISO datetime with timezone offset (e.g. 2024-01-01T00:00:00.000Z), date-only '2024-01-01' is not accepted`
      );
      continue;
    }
    if (
      typeof it.validFrom === "string" &&
      typeof it.validUntil === "string" &&
      new Date(it.validFrom) > new Date(it.validUntil)
    ) {
      state.invalid++;
      log.push(
        `invalid row ${idx}: validFrom (${it.validFrom}) must not be later than validUntil (${it.validUntil})`
      );
      continue;
    }
    const dup = deduplicate(it.type as MemoryType, it.content);
    if (dup.verdict === "duplicate") {
      state.skipped++;
      log.push(`skip duplicate -> existing ${dup.existingId}`);
      continue;
    }
    const batchKey = `${it.type}::${(it.content as string).toLowerCase().trim()}`;
    if (batchSeen.has(batchKey)) {
      state.skipped++;
      log.push(`skip duplicate -> duplicate within import batch (row ${idx})`);
      continue;
    }
    batchSeen.add(batchKey);
    state.wouldImport++;
    validMemories.push({ idx, it });
  }

  return validMemories;
}
