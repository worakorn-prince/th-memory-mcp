import { mkdirSync, writeFileSync, statSync, statfsSync } from "node:fs";
import { join, dirname } from "node:path";
import { z } from "zod";
import {
  db,
  DB_PATH,
  nowISO,
  truncate,
  ok,
  err,
  type ToolResult,
} from "../db/index.js";
import { VERSION, EXPORTS_DIRNAME } from "../lib/config.js";
import type { InteractionRow } from "../lib/capture-core.js";

export const exportMemoryInput = {
  includeInteractions: z
    .boolean()
    .default(false)
    .describe("Include raw interaction rows in the export (file gets bigger)"),
  filename: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Output file name inside data/exports/ (only A-Z a-z 0-9 . _ - allowed, must end with .json). Defaults to memory-export-YYYYMMDD-HHmmss.json"
    ),
};

const PREVIEW_BUDGET = 500;
const EXPORT_DIR = join(dirname(DB_PATH), EXPORTS_DIRNAME);

interface PreferenceRow {
  id: number;
  category: string;
  key: string;
  value: string;
  confidence: number;
  source: string;
  updated_at: string;
}

interface LessonRow {
  id: number;
  situation: string;
  mistake: string;
  correction: string;
  created_at: string;
}

interface ProfileRow {
  section: string;
  content: string;
  updated_at: string;
}

interface ExportMemoryRow {
  id: number;
  type: string;
  content: string;
  summary: string | null;
  status: string;
  source: string;
  confidence: number;
  importance: number;
  salience: number;
  projectId: string | null;
  sessionId: string | null;
  userId: string | null;
  validFrom: string | null;
  validUntil: string | null;
  metadata: unknown;
}

const selectPrefs = db.prepare(
  "SELECT id, category, key, value, confidence, source, updated_at FROM preferences ORDER BY id"
);
const selectLessons = db.prepare(
  "SELECT id, situation, mistake, correction, created_at FROM lessons ORDER BY id"
);
const selectProfile = db.prepare(
  "SELECT section, content, updated_at FROM profile ORDER BY section"
);
const selectInteractions = db.prepare(
  "SELECT id, ts, session_id, kind, content, meta FROM interactions ORDER BY id"
);
const selectMemories = db.prepare(`
  SELECT m.id, m.type, m.content, m.summary, m.status, m.source,
         m.confidence, m.importance, m.salience, m.project_id AS projectId,
         m.session_id AS sessionId, u.external_id AS userId,
         m.valid_from AS validFrom, m.valid_until AS validUntil, m.metadata
  FROM memories m
  LEFT JOIN users u ON u.id = m.user_id
  ORDER BY m.id
`);
const selectMemoryLinks = db.prepare(
  "SELECT source_memory_id AS sourceId, relation, target_memory_id AS targetId, confidence, created_at AS createdAt FROM memory_links ORDER BY source_memory_id, target_memory_id"
);
// Batch A gap-close: export users/entities/relations so backup/restore is complete.
// FORMAT DECISION: keep `th-memory-mcp/v2` (do NOT bump to v3) and add the three
// new top-level fields as additive/optional. Rationale: existing consumers and
// test/export_v2.test.mjs assert format === v2 with a strict equality check; a v3
// bump would break them and any downstream parser that allow-lists v2. Old v2
// files simply lack these keys and import treats missing as empty (backward compat).
const selectUsers = db.prepare(
  "SELECT id, external_id AS externalId, name, created_at AS createdAt FROM users ORDER BY id"
);
const selectEntities = db.prepare(
  "SELECT id, name, canonical_name AS canonicalName, type, metadata FROM entities ORDER BY id"
);
const selectRelations = db.prepare(
  "SELECT id, source_entity_id AS sourceEntityId, relation, target_entity_id AS targetEntityId, confidence, valid_from AS validFrom, valid_until AS validUntil, source_memory_id AS sourceMemoryId, metadata FROM relations ORDER BY id"
);

function parseMetadata(raw: string | null): unknown {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // Preserve malformed legacy values rather than making an export fail.
    return raw;
  }
}

function timestamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

const WINDOWS_RESERVED = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

function sanitizeFilename(name: string): string | null {
  if (name.includes("..")) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  if (!name.endsWith(".json")) return null;
  const stem = name.slice(0, -".json".length);
  if (stem.length === 0) return null;
  if (WINDOWS_RESERVED.has(stem.toUpperCase())) return null;
  return name;
}

export async function exportMemoryHandler(args: {
  includeInteractions?: boolean;
  filename?: string;
}): Promise<ToolResult> {
  try {
    const includeInteractions = args.includeInteractions ?? false;

    let filename: string;
    if (args.filename !== undefined) {
      const clean = sanitizeFilename(args.filename);
      if (!clean) {
        return err(
          `invalid filename "${truncate(args.filename, 100)}": only [A-Za-z0-9._-] allowed, no "..", must end with .json`
        );
      }
      filename = clean;
    } else {
      filename = `memory-export-${timestamp()}.json`;
    }

    const interactionsIncluded = includeInteractions
      ? (selectInteractions.all() as InteractionRow[])
      : undefined;

    const memories = (selectMemories.all() as Array<Omit<ExportMemoryRow, "metadata"> & { metadata: string | null }>)
      .map((m) => ({ ...m, metadata: parseMetadata(m.metadata) }));
    const users = selectUsers.all() as Array<{ id: number; externalId: string; name: string | null; createdAt: string }>;
    const entities = (
      selectEntities.all() as Array<{
        id: number;
        name: string;
        canonicalName: string;
        type: string | null;
        metadata: string | null;
      }>
    ).map((e) => ({ ...e, metadata: parseMetadata(e.metadata) }));
    const relations = (
      selectRelations.all() as Array<{
        id: number;
        sourceEntityId: number;
        relation: string;
        targetEntityId: number;
        confidence: number;
        validFrom: string | null;
        validUntil: string | null;
        sourceMemoryId: number | null;
        metadata: string | null;
      }>
    ).map((r) => ({ ...r, metadata: parseMetadata(r.metadata) }));
    const payload = {
      exported_at: nowISO(),
      version: VERSION,
      format: "th-memory-mcp/v2",
      memories,
      memoryLinks: selectMemoryLinks.all(),
      // Additive v2 fields (optional for backward compat): full backup of
      // M007 users + M003 entities/relations. Old importers ignore unknown keys.
      users,
      entities,
      relations,
      preferences: selectPrefs.all() as PreferenceRow[],
      lessons: selectLessons.all() as LessonRow[],
      profile: selectProfile.all() as ProfileRow[],
      interactions: {
        included: includeInteractions,
        count: interactionsIncluded ? interactionsIncluded.length : 0,
        ...(interactionsIncluded ? { rows: interactionsIncluded } : {}),
      },
    };

    const json = JSON.stringify(payload, null, 2);

    mkdirSync(EXPORT_DIR, { recursive: true });
    try {
      const stats = statfsSync(EXPORT_DIR);
      if (json.length > stats.bavail * stats.bsize * 0.9)
        return err("insufficient disk space for export");
    } catch {}
    const filePath = join(EXPORT_DIR, filename);
    writeFileSync(filePath, json, "utf8");
    const size = statSync(filePath).size;

    return ok(
      `exported: ${filePath}\nsize: ${size} bytes\npreview: ${truncate(json, PREVIEW_BUDGET)}`
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
