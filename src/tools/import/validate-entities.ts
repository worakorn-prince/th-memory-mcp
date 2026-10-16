import type { ImportCounts, ImportEntity, ValidatedEntity } from "./types.js";

export function validateEntities(exportEntities: unknown, state: ImportCounts): ValidatedEntity[] {
  const validEntities: ValidatedEntity[] = [];
  if (exportEntities != null) {
    for (const e of exportEntities as ImportEntity[]) {
      const name = typeof e.name === "string" ? e.name : "";
      const canonical =
        typeof e.canonicalName === "string"
          ? e.canonicalName
          : typeof e.canonical_name === "string"
            ? (e.canonical_name as string)
            : "";
      if (!e || name.length === 0 || name.length > 500 || canonical.length === 0 || canonical.length > 500) {
        state.entitiesInvalid++;
        continue;
      }
      state.entitiesImported++;
      validEntities.push({ e, name, canonical });
    }
  }
  return validEntities;
}
