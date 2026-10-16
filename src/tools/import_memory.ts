import { z } from "zod";
import { readFileSync, realpathSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import { DB_PATH, ok, err, type ToolResult } from "../db/index.js";
import { EXPORTS_DIRNAME } from "../lib/config.js";
import { applyValidatedRows } from "./import/apply.js";
import { createImportCounts, type ImportItem } from "./import/types.js";
import { validateAux } from "./import/validate-aux.js";
import { validateEntities } from "./import/validate-entities.js";
import { validateLinks } from "./import/validate-links.js";
import { validateMemories } from "./import/validate-memories.js";
import { validateRelations } from "./import/validate-relations.js";
import { validateUsers } from "./import/validate-users.js";

export const importMemoryInput = {
  file: z
    .string()
    .optional()
    .describe("Path to a .json export file (must be inside data/exports/)"),
  json: z
    .string()
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
    .describe("Scope imported memories to a user (USER scope)"),
};

export function importMemoryHandler(args: {
  file?: string;
  json?: string;
  apply?: boolean;
  userId?: string | null;
}): ToolResult {
  try {
    let raw: string;
    if (args.json) {
      raw = args.json;
    } else if (args.file) {
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
      raw = readFileSync(realFull, "utf8");
    } else {
      return err("provide either file or json");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return err("invalid JSON");
    }

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
    const validMemories = validateMemories(memoryItems, state, log);
    const validLinks = validateLinks(exportLinks, validMemories, state, log);
    const validEntities = validateEntities(exportEntities, state);
    const validRelations = validateRelations(exportRelations, validEntities, state);
    const hasAux = exportPrefs != null || exportLessons != null || exportProfile != null;
    const { validPrefs, validLessons, validProfiles } = validateAux(
      exportPrefs,
      exportLessons,
      exportProfile,
      hasAux,
      state
    );

    if (args.apply === true) {
      const applyError = applyValidatedRows(
        {
          userId: args.userId,
          validUsers,
          validMemories,
          validLinks,
          validEntities,
          validRelations,
          validPrefs,
          validLessons,
          validProfiles,
          hasAux,
        },
        state,
        log
      );
      if (applyError) return err(applyError);
    }

    const graphSuffix = `users ${state.usersImported} ok ${state.usersInvalid} invalid; entities ${state.entitiesImported} ok ${state.entitiesInvalid} invalid; relations ${state.relationsImported} ok ${state.relationsInvalid} invalid`;

    if (hasAux) {
      const mode = args.apply === true ? "applied" : "dry-run";
      const summary = `import ${mode}: ${state.wouldImport} memories to import, ${state.skipped} duplicate(s) skipped, ${state.invalid} invalid memories; ${state.linksImported} link(s) imported, ${state.linksInvalid} invalid link(s); preferences ${state.prefOk} ok ${state.prefInvalid} invalid; lessons ${state.lessonOk} ok ${state.lessonInvalid} invalid; profile ${state.profileOk} ok; ${graphSuffix}`;
      return ok(summary);
    }

    const mode = args.apply === true ? "applied" : "dry-run";
    const summary = `import ${mode}: ${state.wouldImport} to import, ${state.skipped} duplicate(s) skipped, ${state.invalid} invalid, ${state.linksImported} link(s) imported, ${state.linksInvalid} invalid link(s); ${graphSuffix}`;
    return ok(log.length ? `${summary}\n${log.join("\n")}` : summary);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
