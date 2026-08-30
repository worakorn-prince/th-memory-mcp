import { z } from "zod";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { join, dirname, resolve, sep } from "node:path";
import {
  db,
  DB_PATH,
  nowISO,
  syncSearchIndex,
  upsertEmbedding,
  ok,
  err,
  type ToolResult,
} from "../db/index.js";
import { createMemory } from "../db/repositories/memories.js";
import { deduplicate } from "../memory/deduplicator.js";
import { MEMORY_TYPES, SOURCE_TYPES } from "../memory/types.js";
import type { MemoryType, SourceType } from "../memory/types.js";
import { EXPORTS_DIRNAME } from "../lib/config.js";
import { embed } from "../lib/embed.js";

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

interface ImportItem {
  type?: string;
  content?: unknown;
  summary?: unknown;
  source?: string;
  confidence?: unknown;
  importance?: unknown;
  projectId?: unknown;
  sessionId?: unknown;
  userId?: unknown;
  validFrom?: unknown;
  validUntil?: unknown;
  metadata?: unknown;
}

function isIsoDateString(s: string): boolean {
  if (typeof s !== "string") return false;
  const d = Date.parse(s);
  if (Number.isNaN(d)) return false;
  try {
    const iso = new Date(s).toISOString();
    return iso.length >= 10;
  } catch {
    return false;
  }
}

function isValidSource(s: string): boolean {
  return (SOURCE_TYPES as readonly string[]).includes(s);
}

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
    if (Array.isArray(parsed)) {
      memoryItems = parsed as ImportItem[];
    } else if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as { memories?: unknown }).memories)
    ) {
      memoryItems = (parsed as { memories: ImportItem[] }).memories;
    } else if (
      parsed &&
      typeof parsed === "object" &&
      ("preferences" in (parsed as object) ||
        "lessons" in (parsed as object) ||
        "profile" in (parsed as object))
    ) {
      const p = parsed as {
        preferences?: unknown;
        lessons?: unknown;
        profile?: unknown;
        memories?: unknown;
      };
      if (Array.isArray(p.preferences)) exportPrefs = p.preferences;
      if (Array.isArray(p.lessons)) exportLessons = p.lessons;
      if (Array.isArray(p.profile)) exportProfile = p.profile;
      if (Array.isArray(p.memories)) memoryItems = p.memories as ImportItem[];
    } else {
      memoryItems = [];
    }

    let wouldImport = 0;
    let skipped = 0;
    let invalid = 0;
    const log: string[] = [];

    for (const it of memoryItems) {
      if (
        !it ||
        typeof it.content !== "string" ||
        it.content.length === 0 ||
        it.content.length > 2000 ||
        !MEMORY_TYPES.includes(it.type as MemoryType)
      ) {
        invalid++;
        continue;
      }
      if (it.summary != null && (typeof it.summary !== "string" || (it.summary as string).length > 2000)) {
        invalid++;
        continue;
      }
      if (it.source != null && typeof it.source === "string" && !isValidSource(it.source)) {
        invalid++;
        continue;
      }
      if (it.confidence != null && (typeof it.confidence !== "number" || (it.confidence as number) < 0 || (it.confidence as number) > 1)) {
        invalid++;
        continue;
      }
      if (it.importance != null && (typeof it.importance !== "number" || (it.importance as number) < 0 || (it.importance as number) > 1)) {
        invalid++;
        continue;
      }
      if (it.projectId != null && (typeof it.projectId !== "string" || (it.projectId as string).length === 0 || (it.projectId as string).length > 200)) {
        invalid++;
        continue;
      }
      if (it.sessionId != null && (typeof it.sessionId !== "string" || (it.sessionId as string).length === 0 || (it.sessionId as string).length > 200)) {
        invalid++;
        continue;
      }
      if (it.userId != null && (typeof it.userId !== "string" || (it.userId as string).length === 0 || (it.userId as string).length > 200)) {
        invalid++;
        continue;
      }
      if (it.validFrom != null && (typeof it.validFrom !== "string" || !isIsoDateString(it.validFrom as string))) {
        invalid++;
        continue;
      }
      if (it.validUntil != null && (typeof it.validUntil !== "string" || !isIsoDateString(it.validUntil as string))) {
        invalid++;
        continue;
      }
      const dup = deduplicate(it.type as MemoryType, it.content);
      if (dup.verdict === "duplicate") {
        skipped++;
        log.push(`skip duplicate -> existing ${dup.existingId}`);
        continue;
      }
      wouldImport++;
      if (args.apply === true) {
        createMemory({
          type: it.type as MemoryType,
          content: it.content,
          summary: typeof it.summary === "string" ? it.summary : null,
          source: (it.source as SourceType) ?? "imported",
          confidence: typeof it.confidence === "number" ? it.confidence : 0.7,
          importance: typeof it.importance === "number" ? it.importance : 0.5,
          projectId: typeof it.projectId === "string" ? it.projectId : null,
          sessionId: typeof it.sessionId === "string" ? it.sessionId : null,
          userId:
            typeof it.userId === "string"
              ? it.userId
              : typeof args.userId === "string"
                ? args.userId
                : null,
          validFrom: typeof it.validFrom === "string" ? it.validFrom as string : null,
          validUntil: typeof it.validUntil === "string" ? it.validUntil as string : null,
          metadata: it.metadata ?? null,
        });
      }
    }

    if (exportPrefs != null || exportLessons != null || exportProfile != null) {
      const prefArr = Array.isArray(exportPrefs) ? (exportPrefs as unknown[]) : [];
      const lessonArr = Array.isArray(exportLessons) ? (exportLessons as unknown[]) : [];
      const profileArr = Array.isArray(exportProfile) ? (exportProfile as unknown[]) : [];
      const validCat = new Set(["work_style", "coding_pref", "language", "domain", "other"]);
      let prefOk = 0;
      let prefInvalid = 0;
      let lessonOk = 0;
      let lessonInvalid = 0;
      let profileOk = 0;
      const selectPref = db.prepare("SELECT id FROM preferences WHERE category = ? AND key = ?");
      const insertPref = db.prepare(
        "INSERT INTO preferences (category, key, value, confidence, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      );
      const updatePref = db.prepare(
        "UPDATE preferences SET value = ?, confidence = ?, source = ?, updated_at = ? WHERE category = ? AND key = ?"
      );
      const insertLesson = db.prepare(
        "INSERT INTO lessons (situation, mistake, correction, created_at) VALUES (?, ?, ?, ?)"
      );
      const upsertProfile = db.prepare(
        "INSERT INTO profile (section, content, updated_at) VALUES (?, ?, ?) ON CONFLICT(section) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at"
      );
      for (const p of prefArr as Array<Record<string, unknown>>) {
        if (
          !p ||
          typeof p.category !== "string" ||
          !validCat.has(p.category) ||
          typeof p.key !== "string" ||
          (p.key as string).length === 0 ||
          (p.key as string).length > 200 ||
          typeof p.value !== "string" ||
          (p.value as string).length === 0 ||
          (p.value as string).length > 2000 ||
          (p.confidence != null && (typeof p.confidence !== "number" || (p.confidence as number) < 0 || (p.confidence as number) > 1))
        ) {
          prefInvalid++;
          continue;
        }
        prefOk++;
        if (args.apply === true) {
          const existing = selectPref.get(p.category, p.key) as { id: number } | undefined;
          const conf = typeof p.confidence === "number" ? (p.confidence as number) : 0.5;
          const src = typeof p.source === "string" ? (p.source as string) : "imported";
          const ts = typeof p.updated_at === "string" && isIsoDateString(p.updated_at as string) ? (p.updated_at as string) : nowISO();
          if (existing) updatePref.run(p.value, conf, src, ts, p.category, p.key);
          else insertPref.run(p.category, p.key, p.value, conf, src, ts);
          const row = db.prepare("SELECT id FROM preferences WHERE category = ? AND key = ?").get(p.category, p.key) as { id: number } | undefined;
          if (row) {
            syncSearchIndex("preferences", row.id, `${p.category}/${p.key}`, `${p.key}: ${p.value}`);
            upsertEmbedding("preferences", row.id, embed(`${p.category} ${p.key} ${p.value}`));
          }
        }
      }
      for (const l of lessonArr as Array<Record<string, unknown>>) {
        if (
          !l ||
          typeof l.situation !== "string" ||
          (l.situation as string).length === 0 ||
          (l.situation as string).length > 1000 ||
          typeof l.mistake !== "string" ||
          (l.mistake as string).length === 0 ||
          (l.mistake as string).length > 1000 ||
          typeof l.correction !== "string" ||
          (l.correction as string).length === 0 ||
          (l.correction as string).length > 1000
        ) {
          lessonInvalid++;
          continue;
        }
        lessonOk++;
        if (args.apply === true) {
          const ts = typeof l.created_at === "string" && isIsoDateString(l.created_at as string) ? (l.created_at as string) : nowISO();
          const res = insertLesson.run(l.situation, l.mistake, l.correction, ts);
          const id = Number((res as { lastInsertRowid: number | bigint }).lastInsertRowid);
          syncSearchIndex("lessons", id, (l.situation as string).slice(0, 80), `${l.situation} | mistake: ${l.mistake} -> correction: ${l.correction}`);
          upsertEmbedding("lessons", id, embed(`${l.situation} ${l.mistake} ${l.correction}`));
        }
      }
      for (const pr of profileArr as Array<Record<string, unknown>>) {
        if (!pr || typeof pr.section !== "string" || (pr.section as string).length === 0 || typeof pr.content !== "string" || (pr.content as string).length === 0) continue;
        profileOk++;
        if (args.apply === true) {
          const ts = typeof pr.updated_at === "string" && isIsoDateString(pr.updated_at as string) ? (pr.updated_at as string) : nowISO();
          upsertProfile.run(pr.section, pr.content, ts);
        }
      }
      const mode = args.apply === true ? "applied" : "dry-run";
      const summary = `import ${mode}: ${wouldImport} memories to import, ${skipped} duplicate(s) skipped, ${invalid} invalid memories; preferences ${prefOk} ok ${prefInvalid} invalid; lessons ${lessonOk} ok ${lessonInvalid} invalid; profile ${profileOk} ok`;
      return ok(summary);
    }

    const mode = args.apply === true ? "applied" : "dry-run";
    const summary = `import ${mode}: ${wouldImport} to import, ${skipped} duplicate(s) skipped, ${invalid} invalid`;
    return ok(log.length ? `${summary}\n${log.join("\n")}` : summary);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
