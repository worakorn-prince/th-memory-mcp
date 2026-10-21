import { z } from "zod";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { DB_PATH, ok, err, type ToolResult } from "../db/index.js";
import { EXPORTS_DIRNAME } from "../lib/config.js";
import { applyValidatedRows } from "./import/apply.js";
import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ROWS,
} from "./import/common.js";
import { createImportCounts, type ImportItem } from "./import/types.js";
import { validateAux } from "./import/validate-aux.js";
import { validateEntities } from "./import/validate-entities.js";
import { validateLinks } from "./import/validate-links.js";
import { validateMemories } from "./import/validate-memories.js";
import { validateRelations } from "./import/validate-relations.js";
import { validateUsers } from "./import/validate-users.js";

const IMPORT_ROW_KEYS = [
  "memories",
  "memoryLinks",
  "users",
  "entities",
  "relations",
  "preferences",
  "lessons",
  "profile",
] as const;

// SEC-08: count every importable row before validation starts.
function countImportRows(parsed: unknown): number {
  if (Array.isArray(parsed)) return parsed.length;
  if (!parsed || typeof parsed !== "object") return 0;
  const record = parsed as Record<string, unknown>;
  let total = 0;
  for (const key of IMPORT_ROW_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) total += value.length;
  }
  return total;
}

export const importMemoryInput = {
  file: z
    .string()
    .max(500)
    .optional()
    .describe("Path to a .json export file (must be inside data/exports/)"),
  json: z
    .string()
    .max(MAX_IMPORT_BYTES)
    .optional()
    .describe("Inline JSON: an array of memory objects, or { memories: [...] }"),
  apply: z
    .boolean()
    .optional()
    .describe("Actually insert memories (default false = dry run, just report)"),
  userId: z
    .string()
    .nullable()
    .optional()
    .describe("Scope imported memories to a user (USER scope); overrides per-item userId"),
  trusted: z
    .boolean()
    .optional()
    .describe(
      "Trusted import (default false). Auxiliary data (preferences/lessons/profile) is restored only when true; per-item trusted flags are ignored"
    ),
};

export function importMemoryHandler(args: {
  file?: string;
  json?: string;
  apply?: boolean;
  userId?: string | null;
  trusted?: boolean;
}): ToolResult {
  try {
    // SEC-03: a supplied tool-level userId wins over every row owner.
    const forcedUserId = typeof args.userId === "string" ? args.userId : null;
    if (
      forcedUserId != null &&
      (forcedUserId.length === 0 ||
        forcedUserId.length > 200 ||
        /[\x00-\x1f]/.test(forcedUserId))
    ) {
      return err("userId must be 1-200 characters and contain no control characters");
    }
    // SEC-05/SEC-13: trust is decided by this flag only, never by row data.
    const trusted = args.trusted === true;

    let raw: string;
    if (args.json) {
      // Direct handler calls bypass zod, so enforce the cap here too.
      if (
        args.json.length > MAX_IMPORT_BYTES ||
        Buffer.byteLength(args.json, "utf8") > MAX_IMPORT_BYTES
      )
        return err(`json exceeds maximum import size of ${MAX_IMPORT_BYTES} bytes`);
      raw = args.json;
    } else if (args.file) {
      if (args.file.length > 500)
        return err("file path exceeds maximum length of 500 characters");
      const exportDir = join(dirname(DB_PATH), EXPORTS_DIRNAME);
      const full = resolve(args.file);
      let realExportDir: string;
      try {
        realExportDir = realpathSync(exportDir);
      } catch {
        realExportDir = resolve(exportDir);
      }
      let realFull: string;
      try {
        realFull = realpathSync(full);
      } catch {
        return err(`file not found: ${full}`);
      }
      if (!realFull.startsWith(realExportDir + sep) && realFull !== realExportDir)
        return err(`file must be inside ${exportDir}`);
      if (!realFull.endsWith(".json")) return err("file must end with .json");
      let size: number;
      try {
        size = statSync(realFull).size;
      } catch {
        return err(`file not found: ${full}`);
      }
      if (size > MAX_IMPORT_BYTES)
        return err(`file exceeds maximum import size of ${MAX_IMPORT_BYTES} bytes`);
      raw = readFileSync(realFull, "utf8");
      // Guard against a size change between stat and read.
      if (Buffer.byteLength(raw, "utf8") > MAX_IMPORT_BYTES)
        return err(`file exceeds maximum import size of ${MAX_IMPORT_BYTES} bytes`);
    } else {
      return err("provide either file or json");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return err("invalid JSON");
    }

    // SEC-08: reject oversized imports before any validation/dedup work.
    const totalRows = countImportRows(parsed);
    if (totalRows > MAX_IMPORT_ROWS)
      return err(
        `import rejected: ${totalRows} rows exceeds the maximum of ${MAX_IMPORT_ROWS} rows per import; split the export into smaller batches`
      );

    let memoryItems: ImportItem[] = [];
    let exportPrefs: unknown = null;
    let exportLessons: unknown = null;
    let exportProfile: unknown = null;
    let exportLinks: unknown = null;
    // Batch A: additive backup fields (may be absent in legacy v2 files -> null = backward compat).
    let exportUsers: unknown = null;
    let exportEntities: unknown = null;
    let exportRelations: unknown = null;
    if (Array.isArray(parsed)) {
      memoryItems = parsed as ImportItem[];
    } else if (parsed && typeof parsed === "object") {
      const p = parsed as {
        preferences?: unknown;
        lessons?: unknown;
        profile?: unknown;
        memories?: unknown;
        users?: unknown;
        entities?: unknown;
        relations?: unknown;
      };
      if (Array.isArray(p.preferences)) exportPrefs = p.preferences;
      if (Array.isArray(p.lessons)) exportLessons = p.lessons;
      if (Array.isArray(p.profile)) exportProfile = p.profile;
      if (Array.isArray(p.memories)) memoryItems = p.memories as ImportItem[];
      if (Array.isArray((p as { memoryLinks?: unknown }).memoryLinks))
        exportLinks = (p as { memoryLinks: unknown }).memoryLinks;
      // Accept both new keys and legacy absence (missing => null => skip, still pass).
      if (Array.isArray(p.users)) exportUsers = p.users;
      if (Array.isArray(p.entities)) exportEntities = p.entities;
      if (Array.isArray(p.relations)) exportRelations = p.relations;
    } else {
      memoryItems = [];
    }

    // Batch A-2 phase 1: parse + validate everything first (no DB writes).
    // Phase 2 (apply module) applies all validated rows inside ONE db.transaction,
    // so a mid-way error rolls back everything. Users are validated first and
    // restored before memories inside the transaction so createMemory()->ensureUser
    // reuses the restored row. Idempotent via UNIQUE(external_id).
    const state = createImportCounts();
    const log: string[] = [];

    const validUsers = validateUsers(exportUsers, state);
    const validMemories = validateMemories(memoryItems, forcedUserId, state, log);
    const validLinks = validateLinks(
      exportLinks,
      validMemories,
      forcedUserId,
      state,
      log
    );
    const validEntities = validateEntities(exportEntities, state);
    const validRelations = validateRelations(exportRelations, validEntities, state);
    const auxPresent =
      exportPrefs != null || exportLessons != null || exportProfile != null;
    // SEC-13: untrusted imports never validate or apply auxiliary data.
    const auxSkipped = auxPresent && !trusted;
    const { validPrefs, validLessons, validProfiles } = auxSkipped
      ? {
          validPrefs: [] as Array<Record<string, unknown>>,
          validLessons: [] as Array<Record<string, unknown>>,
          validProfiles: [] as Array<Record<string, unknown>>,
        }
      : validateAux(
          exportPrefs,
          exportLessons,
          exportProfile,
          auxPresent,
          state
        );

    if (args.apply === true) {
      const applyError = applyValidatedRows(
        {
          userId: forcedUserId,
          trusted,
          validUsers,
          validMemories,
          validLinks,
          validEntities,
          validRelations,
          validPrefs,
          validLessons,
          validProfiles,
          hasAux: auxPresent && trusted,
        },
        state,
        log
      );
      if (applyError) return err(applyError);
    }

    const graphSuffix = `users ${state.usersImported} ok ${state.usersInvalid} invalid; entities ${state.entitiesImported} ok ${state.entitiesInvalid} invalid; relations ${state.relationsImported} ok ${state.relationsInvalid} invalid`;
    const mode = args.apply === true ? "applied" : "dry-run";
    const base = auxPresent
      ? `import ${mode}: ${state.wouldImport} memories to import, ${state.skipped} duplicate(s) skipped, ${state.invalid} invalid memories; ${state.linksImported} link(s) imported, ${state.linksInvalid} invalid link(s); preferences ${state.prefOk} ok ${state.prefInvalid} invalid; lessons ${state.lessonOk} ok ${state.lessonInvalid} invalid; profile ${state.profileOk} ok ${state.profileInvalid} invalid; ${graphSuffix}`
      : `import ${mode}: ${state.wouldImport} to import, ${state.skipped} duplicate(s) skipped, ${state.invalid} invalid, ${state.linksImported} link(s) imported, ${state.linksInvalid} invalid link(s); ${graphSuffix}`;
    const summary = auxSkipped
      ? `${base}; aux skipped (untrusted import; pass trusted=true to restore)`
      : base;
    return ok(log.length ? `${summary}\n${log.join("\n")}` : summary);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
