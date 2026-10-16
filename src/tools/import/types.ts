export interface ImportItem {
  id?: unknown;
  type?: string;
  content?: unknown;
  summary?: unknown;
  source?: string;
  confidence?: unknown;
  importance?: unknown;
  salience?: unknown;
  status?: unknown;
  projectId?: unknown;
  sessionId?: unknown;
  userId?: unknown;
  validFrom?: unknown;
  validUntil?: unknown;
  metadata?: unknown;
  // Batch A-2: trust marker for prompt-injection delimiters (team B).
  // Contract is ONLY via metadata.trusted boolean (no schema change):
  // trusted:true => metadata {trusted:true}; missing/other => {trusted:false}.
  trusted?: unknown;
}

export interface ImportLink {
  sourceId?: unknown;
  targetId?: unknown;
  relation?: unknown;
  confidence?: unknown;
}

export interface ImportUser {
  id?: unknown;
  externalId?: unknown;
  external_id?: unknown;
  name?: unknown;
  createdAt?: unknown;
  created_at?: unknown;
}

export interface ImportEntity {
  id?: unknown;
  name?: unknown;
  canonicalName?: unknown;
  canonical_name?: unknown;
  type?: unknown;
  metadata?: unknown;
}

export interface ImportRelation {
  id?: unknown;
  sourceEntityId?: unknown;
  source_entity_id?: unknown;
  targetEntityId?: unknown;
  target_entity_id?: unknown;
  relation?: unknown;
  confidence?: unknown;
  validFrom?: unknown;
  valid_from?: unknown;
  validUntil?: unknown;
  valid_until?: unknown;
  sourceMemoryId?: unknown;
  source_memory_id?: unknown;
  metadata?: unknown;
}

export type ValidatedUser = { external: string; name: string | null; created: string };
export type ValidatedMemory = { idx: number; it: ImportItem };
export type ValidatedLink = { sourceId: number; targetId: number; relation: string; confidence: unknown };
export type ValidatedEntity = { e: ImportEntity; name: string; canonical: string };
export type ValidatedRelation = {
  r: ImportRelation;
  oldSource: number;
  oldTarget: number;
  predicate: string;
  conf: number;
  vf: string | null;
  vu: string | null;
  oldMem: number | null;
};

export interface ImportCounts {
  usersImported: number;
  usersInvalid: number;
  wouldImport: number;
  skipped: number;
  invalid: number;
  linksImported: number;
  linksInvalid: number;
  entitiesImported: number;
  entitiesInvalid: number;
  relationsImported: number;
  relationsInvalid: number;
  prefOk: number;
  prefInvalid: number;
  lessonOk: number;
  lessonInvalid: number;
  profileOk: number;
}

export function createImportCounts(): ImportCounts {
  return {
    usersImported: 0,
    usersInvalid: 0,
    wouldImport: 0,
    skipped: 0,
    invalid: 0,
    linksImported: 0,
    linksInvalid: 0,
    entitiesImported: 0,
    entitiesInvalid: 0,
    relationsImported: 0,
    relationsInvalid: 0,
    prefOk: 0,
    prefInvalid: 0,
    lessonOk: 0,
    lessonInvalid: 0,
    profileOk: 0,
  };
}
