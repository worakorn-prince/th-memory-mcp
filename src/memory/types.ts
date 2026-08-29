export const MEMORY_TYPES = [
  "FACT",
  "PREFERENCE",
  "GOAL",
  "DECISION",
  "CONSTRAINT",
  "LESSON",
  "PROCEDURE",
  "EPISODE",
  "RELATION",
  "PROFILE",
  "DERIVED",
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const SOURCE_TYPES = [
  "explicit",
  "corrected",
  "inferred",
  "captured",
  "consolidated",
  "imported",
  "system",
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const LIFECYCLE_STATES = [
  "new",
  "active",
  "reinforced",
  "stale",
  "superseded",
  "archived",
  "deleted",
] as const;
export type LifecycleState = (typeof LIFECYCLE_STATES)[number];

export const SCOPES = ["GLOBAL", "USER", "PROJECT", "SESSION"] as const;
export type Scope = (typeof SCOPES)[number];

export const LINK_RELATIONS = [
  "supports",
  "contradicts",
  "supersedes",
  "derived_from",
  "related_to",
  "caused_by",
  "depends_on",
] as const;
export type LinkRelation = (typeof LINK_RELATIONS)[number];

export interface MemoryRecord {
  id: number;
  type: MemoryType;
  content: string;
  summary: string | null;
  status: LifecycleState;
  source: SourceType;
  confidence: number;
  importance: number;
  salience: number;
  project_id: string | null;
  session_id: string | null;
  user_id: number | null;
  scope: Scope;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  access_count: number;
  valid_from: string | null;
  valid_until: string | null;
  supersedes_id: number | null;
  metadata: string | null;
}
