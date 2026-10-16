import { db } from "../../db/index.js";
import { isIsoDateString } from "../../lib/iso.js";
import type { ImportCounts, ImportRelation, ValidatedEntity, ValidatedRelation } from "./types.js";

// Batch A: restore M003 entities/relations idempotently.
// - entities: dedupe by UNIQUE(canonical_name); keep oldId->newId map for relations.
// - relations: `relation` is free-form (e.g. co_occurs) so do NOT check LINK_RELATIONS
//   here (that check stays only for memory_links above). Keep ISO validation as-is;
//   another team will unify validation later. Missing arrays (legacy v2) => skip, still pass.
export function validateRelations(
  exportRelations: unknown,
  validEntities: ValidatedEntity[],
  state: ImportCounts
): ValidatedRelation[] {
  const validRelations: ValidatedRelation[] = [];
  if (exportRelations != null) {
    // Phase-1 entity-existence precheck (read-only): an old entity id is
    // resolvable in phase 2 iff it is shipped in THIS batch (validEntities)
    // or still exists in the DB. oldMem stays orphan-safe (NULL fallback).
    const batchEntIds = new Set<number>();
    for (const { e } of validEntities) {
      if (typeof e.id === "number" && Number.isInteger(e.id)) batchEntIds.add(e.id);
    }
    const selEntExists = db.prepare("SELECT id FROM entities WHERE id = ?");
    for (const r of exportRelations as ImportRelation[]) {
      const oldSource =
        typeof r.sourceEntityId === "number"
          ? r.sourceEntityId
          : typeof r.source_entity_id === "number"
            ? (r.source_entity_id as number)
            : null;
      const oldTarget =
        typeof r.targetEntityId === "number"
          ? r.targetEntityId
          : typeof r.target_entity_id === "number"
            ? (r.target_entity_id as number)
            : null;
      const predicate = typeof r.relation === "string" ? r.relation : "";
      const conf = r.confidence == null ? 0.5 : r.confidence;
      const vf =
        typeof r.validFrom === "string"
          ? (r.validFrom as string)
          : typeof r.valid_from === "string"
            ? (r.valid_from as string)
            : null;
      const vu =
        typeof r.validUntil === "string"
          ? (r.validUntil as string)
          : typeof r.valid_until === "string"
            ? (r.valid_until as string)
            : null;
      const oldMem =
        typeof r.sourceMemoryId === "number"
          ? r.sourceMemoryId
          : typeof r.source_memory_id === "number"
            ? (r.source_memory_id as number)
            : null;
      if (
        !r ||
        oldSource == null ||
        oldTarget == null ||
        predicate.length === 0 ||
        predicate.length > 200 ||
        typeof conf !== "number" ||
        conf < 0 ||
        conf > 1 ||
        (vf != null && !isIsoDateString(vf)) ||
        (vu != null && !isIsoDateString(vu)) ||
        (vf != null && vu != null && new Date(vf) > new Date(vu))
      ) {
        state.relationsInvalid++;
        continue;
      }
      const srcOk = batchEntIds.has(oldSource) || !!selEntExists.get(oldSource);
      const tgtOk = batchEntIds.has(oldTarget) || !!selEntExists.get(oldTarget);
      if (!srcOk || !tgtOk) {
        state.relationsInvalid++;
        continue;
      }
      state.relationsImported++;
      validRelations.push({ r, oldSource, oldTarget, predicate, conf, vf, vu, oldMem });
    }
  }
  return validRelations;
}
