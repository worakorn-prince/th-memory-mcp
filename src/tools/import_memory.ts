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
import { MEMORY_TYPES, SOURCE_TYPES, LIFECYCLE_STATES, LINK_RELATIONS } from "../memory/types.js";
import type { MemoryType, SourceType, LifecycleState } from "../memory/types.js";
import { EXPORTS_DIRNAME } from "../lib/config.js";
import { isIsoDateString } from "../lib/iso.js";
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
}

interface ImportLink {
  sourceId?: unknown;
  targetId?: unknown;
  relation?: unknown;
  confidence?: unknown;
}

interface ImportUser {
  id?: unknown;
  externalId?: unknown;
  external_id?: unknown;
  name?: unknown;
  createdAt?: unknown;
  created_at?: unknown;
}

interface ImportEntity {
  id?: unknown;
  name?: unknown;
  canonicalName?: unknown;
  canonical_name?: unknown;
  type?: unknown;
  metadata?: unknown;
}

interface ImportRelation {
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

    // Restore users FIRST (before memories) so createMemory()->ensureUser reuses
    // the restored row (with original name/created_at) instead of auto-creating
    // a bare row. Idempotent via UNIQUE(external_id) + INSERT OR IGNORE.
    let usersImported = 0;
    let usersInvalid = 0;
    if (exportUsers != null) {
      const insertUser = db.prepare(
        "INSERT OR IGNORE INTO users (external_id, name, created_at) VALUES (?, ?, ?)"
      );
      for (const u of exportUsers as ImportUser[]) {
        const external =
          typeof u.externalId === "string"
            ? u.externalId
            : typeof u.external_id === "string"
              ? u.external_id
              : null;
        if (
          !u ||
          !external ||
          external.length === 0 ||
          external.length > 200 ||
          /[\x00-\x1f]/.test(external)
        ) {
          usersInvalid++;
          continue;
        }
        const created =
          (typeof u.createdAt === "string" && isIsoDateString(u.createdAt as string)
            ? (u.createdAt as string)
            : typeof u.created_at === "string" && isIsoDateString(u.created_at as string)
              ? (u.created_at as string)
              : null) ?? nowISO();
        const name = typeof u.name === "string" ? (u.name as string).slice(0, 500) : null;
        usersImported++;
        if (args.apply === true) {
          insertUser.run(external, name, created);
        }
      }
    }

    let wouldImport = 0;
    let skipped = 0;
    let invalid = 0;
    const log: string[] = [];
    const importedIds = new Map<number, number>();

    for (const [idx, it] of memoryItems.entries()) {
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
      if (it.salience != null && (typeof it.salience !== "number" || (it.salience as number) < 0 || (it.salience as number) > 1)) {
        invalid++;
        continue;
      }
      if (it.status != null && (typeof it.status !== "string" || !LIFECYCLE_STATES.includes(it.status as LifecycleState))) {
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
        log.push(
          `invalid row ${idx}: validFrom '${String(it.validFrom)}' rejected — must be a full ISO datetime with timezone offset (e.g. 2024-01-01T00:00:00.000Z), date-only '2024-01-01' is not accepted`
        );
        continue;
      }
      if (it.validUntil != null && (typeof it.validUntil !== "string" || !isIsoDateString(it.validUntil as string))) {
        invalid++;
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
        invalid++;
        log.push(
          `invalid row ${idx}: validFrom (${it.validFrom}) must not be later than validUntil (${it.validUntil})`
        );
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
        const newId = createMemory({
          type: it.type as MemoryType,
          content: it.content,
          summary: typeof it.summary === "string" ? it.summary : null,
          source: (it.source as SourceType) ?? "imported",
          confidence: typeof it.confidence === "number" ? it.confidence : 0.7,
          importance: typeof it.importance === "number" ? it.importance : 0.5,
          salience: typeof it.salience === "number" ? it.salience : 0.5,
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
        if (typeof it.id === "number" && Number.isInteger(it.id)) importedIds.set(it.id, newId);
        if (typeof it.status === "string" && it.status !== "active") {
          db.prepare("UPDATE memories SET status = ? WHERE id = ?").run(it.status, newId);
        }
      }
    }

    let linksImported = 0;
    let linksInvalid = 0;
    if (exportLinks != null) {
      for (const link of exportLinks as ImportLink[]) {
        const sourceId = typeof link.sourceId === "number" ? importedIds.get(link.sourceId) : undefined;
        const targetId = typeof link.targetId === "number" ? importedIds.get(link.targetId) : undefined;
        if (!sourceId || !targetId || typeof link.relation !== "string" || !LINK_RELATIONS.includes(link.relation as typeof LINK_RELATIONS[number]) ||
          (link.confidence != null && (typeof link.confidence !== "number" || link.confidence < 0 || link.confidence > 1))) {
          linksInvalid++;
          continue;
        }
        if (args.apply === true) {
          db.prepare(
            "INSERT OR IGNORE INTO memory_links (source_memory_id, relation, target_memory_id, confidence, created_at) VALUES (?, ?, ?, ?, ?)"
          ).run(sourceId, link.relation, targetId, link.confidence ?? 0.5, nowISO());
        }
        linksImported++;
      }
    }

    // Batch A: restore M003 entities/relations idempotently.
    // - entities: dedupe by UNIQUE(canonical_name); keep oldId->newId map for relations.
    // - relations: `relation` is free-form (e.g. co_occurs) so do NOT check LINK_RELATIONS
    //   here (that check stays only for memory_links above). Keep ISO validation as-is;
    //   another team will unify validation later. Missing arrays (legacy v2) => skip, still pass.
    let entitiesImported = 0;
    let entitiesInvalid = 0;
    const importedEntityIds = new Map<number, number>();
    if (exportEntities != null) {
      const selEntity = db.prepare("SELECT id FROM entities WHERE canonical_name = ?");
      const insEntity = db.prepare(
        "INSERT INTO entities (name, canonical_name, type, metadata) VALUES (?, ?, ?, ?)"
      );
      for (const e of exportEntities as ImportEntity[]) {
        const name = typeof e.name === "string" ? e.name : "";
        const canonical =
          typeof e.canonicalName === "string"
            ? e.canonicalName
            : typeof e.canonical_name === "string"
              ? (e.canonical_name as string)
              : "";
        if (!e || name.length === 0 || name.length > 500 || canonical.length === 0 || canonical.length > 500) {
          entitiesInvalid++;
          continue;
        }
        entitiesImported++;
        if (args.apply === true) {
          const existing = selEntity.get(canonical) as { id: number } | undefined;
          let newId: number;
          if (existing) {
            newId = existing.id;
          } else {
            const type = typeof e.type === "string" ? (e.type as string).slice(0, 200) : "concept";
            const meta =
              e.metadata == null
                ? JSON.stringify({})
                : typeof e.metadata === "string"
                  ? (e.metadata as string)
                  : JSON.stringify(e.metadata);
            const res = insEntity.run(name.slice(0, 500), canonical, type, meta);
            newId = Number((res as { lastInsertRowid: number | bigint }).lastInsertRowid);
          }
          if (typeof e.id === "number" && Number.isInteger(e.id)) importedEntityIds.set(e.id, newId);
        }
      }
    }

    let relationsImported = 0;
    let relationsInvalid = 0;
    if (exportRelations != null) {
      const selEntityById = db.prepare("SELECT id FROM entities WHERE id = ?");
      const selMemById = db.prepare("SELECT id FROM memories WHERE id = ?");
      const selRelation = db.prepare(
        "SELECT id FROM relations WHERE source_entity_id = ? AND relation = ? AND target_entity_id = ? AND COALESCE(source_memory_id, -1) = COALESCE(?, -1)"
      );
      const insRelation = db.prepare(
        "INSERT INTO relations (source_entity_id, relation, target_entity_id, confidence, valid_from, valid_until, source_memory_id, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      );
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
          relationsInvalid++;
          continue;
        }
        // Remap entity ids: prefer import map, else keep original id if row still exists.
        let newSource: number | null = null;
        let newTarget: number | null = null;
        if (importedEntityIds.has(oldSource)) newSource = importedEntityIds.get(oldSource)!;
        else if (selEntityById.get(oldSource)) newSource = oldSource;
        if (importedEntityIds.has(oldTarget)) newTarget = importedEntityIds.get(oldTarget)!;
        else if (selEntityById.get(oldTarget)) newTarget = oldTarget;
        if (newSource == null || newTarget == null) {
          relationsInvalid++;
          continue;
        }
        // Remap memory id: prefer import map, else keep original if still present, else NULL (orphan-safe).
        let newMem: number | null = null;
        if (oldMem == null) newMem = null;
        else if (importedIds.has(oldMem)) newMem = importedIds.get(oldMem)!;
        else if (selMemById.get(oldMem)) newMem = oldMem;
        else newMem = null;
        relationsImported++;
        if (args.apply === true) {
          const dup = selRelation.get(newSource, predicate, newTarget, newMem) as { id: number } | undefined;
          if (dup) continue;
          const meta =
            r.metadata == null
              ? JSON.stringify({})
              : typeof r.metadata === "string"
                ? (r.metadata as string)
                : JSON.stringify(r.metadata);
          insRelation.run(newSource, predicate, newTarget, conf, vf, vu, newMem, meta);
        }
      }
    }
    const graphSuffix = `users ${usersImported} ok ${usersInvalid} invalid; entities ${entitiesImported} ok ${entitiesInvalid} invalid; relations ${relationsImported} ok ${relationsInvalid} invalid`;

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
      const summary = `import ${mode}: ${wouldImport} memories to import, ${skipped} duplicate(s) skipped, ${invalid} invalid memories; ${linksImported} link(s) imported, ${linksInvalid} invalid link(s); preferences ${prefOk} ok ${prefInvalid} invalid; lessons ${lessonOk} ok ${lessonInvalid} invalid; profile ${profileOk} ok; ${graphSuffix}`;
      return ok(summary);
    }

    const mode = args.apply === true ? "applied" : "dry-run";
    const summary = `import ${mode}: ${wouldImport} to import, ${skipped} duplicate(s) skipped, ${invalid} invalid, ${linksImported} link(s) imported, ${linksInvalid} invalid link(s); ${graphSuffix}`;
    return ok(log.length ? `${summary}\n${log.join("\n")}` : summary);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
