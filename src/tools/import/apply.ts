import { db, nowISO, syncSearchIndex, upsertEmbedding } from "../../db/index.js";
import { createMemory } from "../../db/repositories/memories.js";
import { embed } from "../../lib/embed.js";
import { isIsoDateString } from "../../lib/iso.js";
import { redactMetadata, redactSecrets } from "../../lib/redact.js";
import type { MemoryType, SourceType } from "../../memory/types.js";
import { withTrustedFlag } from "./common.js";
import type {
  ImportCounts,
  ValidatedEntity,
  ValidatedLink,
  ValidatedMemory,
  ValidatedRelation,
  ValidatedUser,
} from "./types.js";

function redactStoredMetadata(value: unknown): string {
  if (value == null) return JSON.stringify({});
  if (typeof value === "string") {
    try {
      return JSON.stringify(redactMetadata(JSON.parse(value)));
    } catch {
      return redactSecrets(value);
    }
  }
  return JSON.stringify(redactMetadata(value));
}

export interface ApplyImportInput {
  userId?: string | null;
  // SEC-05/SEC-13: only a trusted import may write aux rows and set the
  // metadata.trusted marker; per-row flags are ignored by the caller.
  trusted: boolean;
  validUsers: ValidatedUser[];
  validMemories: ValidatedMemory[];
  validLinks: ValidatedLink[];
  validEntities: ValidatedEntity[];
  validRelations: ValidatedRelation[];
  validPrefs: Array<Record<string, unknown>>;
  validLessons: Array<Record<string, unknown>>;
  validProfiles: Array<Record<string, unknown>>;
  hasAux: boolean;
}

// Batch A-2 phase 2: single-transaction apply. All validated rows go in
// together; any mid-way throw rolls back EVERYTHING (atomic import).
// Returns the error message on failure, or null on success.
export function applyValidatedRows(
  input: ApplyImportInput,
  state: ImportCounts,
  log: string[]
): string | null {
  const importedIds = new Map<number, number>();
  const importedEntityIds = new Map<number, number>();
  try {
    const applyAll = db.transaction(() => {
      const insertUser = db.prepare(
        "INSERT OR IGNORE INTO users (external_id, name, created_at) VALUES (?, ?, ?)"
      );
      for (const u of input.validUsers)
        insertUser.run(u.external, u.name == null ? null : redactSecrets(u.name), u.created);

      const updateStatus = db.prepare("UPDATE memories SET status = ? WHERE id = ?");
      for (const { it } of input.validMemories) {
        const newId = createMemory({
          type: it.type as MemoryType,
          content: it.content as string,
          summary: typeof it.summary === "string" ? it.summary : null,
          source: (it.source as SourceType) ?? "imported",
          confidence: typeof it.confidence === "number" ? it.confidence : 0.7,
          importance: typeof it.importance === "number" ? it.importance : 0.5,
          salience: typeof it.salience === "number" ? it.salience : 0.5,
          projectId: typeof it.projectId === "string" ? it.projectId : null,
          sessionId: typeof it.sessionId === "string" ? it.sessionId : null,
          // SEC-03: tool-level userId always wins over the row owner.
          userId:
            typeof input.userId === "string"
              ? input.userId
              : typeof it.userId === "string"
                ? it.userId
                : null,
          validFrom: typeof it.validFrom === "string" ? (it.validFrom as string) : null,
          validUntil: typeof it.validUntil === "string" ? (it.validUntil as string) : null,
          metadata: withTrustedFlag(it.metadata, input.trusted),
        });
        if (typeof it.id === "number" && Number.isInteger(it.id)) importedIds.set(it.id, newId);
        if (typeof it.status === "string" && it.status !== "active") {
          updateStatus.run(it.status, newId);
        }
      }

      // Entities first (relations remap needs importedEntityIds).
      const selEntity = db.prepare("SELECT id FROM entities WHERE canonical_name = ?");
      const insEntity = db.prepare(
        "INSERT INTO entities (name, canonical_name, type, metadata) VALUES (?, ?, ?, ?)"
      );
      const batchCanonical = new Map<string, number>();
      for (const { e, name, canonical } of input.validEntities) {
        const safeName = redactSecrets(name).slice(0, 500);
        const safeCanonical = redactSecrets(canonical);
        if (batchCanonical.has(safeCanonical)) {
          if (typeof e.id === "number" && Number.isInteger(e.id))
            importedEntityIds.set(e.id, batchCanonical.get(safeCanonical)!);
          continue;
        }
        const existing = selEntity.get(safeCanonical) as { id: number } | undefined;
        let newId: number;
        if (existing) {
          newId = existing.id;
        } else {
          const type = typeof e.type === "string" ? redactSecrets(e.type).slice(0, 200) : "concept";
          const meta = redactStoredMetadata(e.metadata);
          const res = insEntity.run(safeName, safeCanonical, type, meta);
          newId = Number((res as { lastInsertRowid: number | bigint }).lastInsertRowid);
        }
        batchCanonical.set(safeCanonical, newId);
        if (typeof e.id === "number" && Number.isInteger(e.id)) importedEntityIds.set(e.id, newId);
      }

      const insLink = db.prepare(
        "INSERT OR IGNORE INTO memory_links (source_memory_id, relation, target_memory_id, confidence, created_at) VALUES (?, ?, ?, ?, ?)"
      );
      for (const link of input.validLinks) {
        const sourceId = importedIds.get(link.sourceId);
        const targetId = importedIds.get(link.targetId);
        if (!sourceId || !targetId) {
          // Old id has no remapped row (points outside this import and
          // the row is gone): reclassify as invalid, keep counts honest.
          state.linksImported--;
          state.linksInvalid++;
          log.push(`invalid link ${link.sourceId}->${link.targetId}: unresolvable memory id`);
          continue;
        }
        insLink.run(sourceId, redactSecrets(link.relation), targetId, (link.confidence as number) ?? 0.5, nowISO());
      }

      const selEntityById = db.prepare("SELECT id FROM entities WHERE id = ?");
      const selMemById = db.prepare("SELECT id FROM memories WHERE id = ?");
      const selRelation = db.prepare(
        "SELECT id FROM relations WHERE source_entity_id = ? AND relation = ? AND target_entity_id = ? AND COALESCE(source_memory_id, -1) = COALESCE(?, -1)"
      );
      const insRelation = db.prepare(
        "INSERT INTO relations (source_entity_id, relation, target_entity_id, confidence, valid_from, valid_until, source_memory_id, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      );
      for (const v of input.validRelations) {
        let newSource: number | null = null;
        let newTarget: number | null = null;
        if (importedEntityIds.has(v.oldSource)) newSource = importedEntityIds.get(v.oldSource)!;
        else if (selEntityById.get(v.oldSource)) newSource = v.oldSource;
        if (importedEntityIds.has(v.oldTarget)) newTarget = importedEntityIds.get(v.oldTarget)!;
        else if (selEntityById.get(v.oldTarget)) newTarget = v.oldTarget;
        if (newSource == null || newTarget == null) {
          state.relationsImported--;
          state.relationsInvalid++;
          continue;
        }
        let newMem: number | null = null;
        if (v.oldMem == null) newMem = null;
        else if (importedIds.has(v.oldMem)) newMem = importedIds.get(v.oldMem)!;
        else if (selMemById.get(v.oldMem)) newMem = v.oldMem;
        else newMem = null;
        const predicate = redactSecrets(v.predicate);
        const dup = selRelation.get(newSource, predicate, newTarget, newMem) as { id: number } | undefined;
        if (dup) continue;
        const meta = redactStoredMetadata(v.r.metadata);
        insRelation.run(newSource, predicate, newTarget, v.conf, v.vf, v.vu, newMem, meta);
      }

      // SEC-13: defense in depth — never apply auxiliary data unless the
      // caller explicitly trusted the import.
      if (input.hasAux && input.trusted) {
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
        for (const p of input.validPrefs) {
          const category = redactSecrets(p.category as string);
          const key = redactSecrets(p.key as string);
          const value = redactSecrets(p.value as string);
          const existing = selectPref.get(category, key) as { id: number } | undefined;
          const conf = typeof p.confidence === "number" ? (p.confidence as number) : 0.5;
          const src = typeof p.source === "string" ? (p.source as string) : "imported";
          const ts = typeof p.updated_at === "string" && isIsoDateString(p.updated_at as string) ? (p.updated_at as string) : nowISO();
          if (existing) updatePref.run(value, conf, src, ts, category, key);
          else insertPref.run(category, key, value, conf, src, ts);
          const row = selectPref.get(category, key) as { id: number } | undefined;
          if (row) {
            syncSearchIndex("preferences", row.id, `${category}/${key}`, `${key}: ${value}`);
            upsertEmbedding("preferences", row.id, embed(`${category} ${key} ${value}`));
          }
        }
        for (const l of input.validLessons) {
          const situation = redactSecrets(l.situation as string);
          const mistake = redactSecrets(l.mistake as string);
          const correction = redactSecrets(l.correction as string);
          const ts = typeof l.created_at === "string" && isIsoDateString(l.created_at as string) ? (l.created_at as string) : nowISO();
          const res = insertLesson.run(situation, mistake, correction, ts);
          const id = Number((res as { lastInsertRowid: number | bigint }).lastInsertRowid);
          syncSearchIndex("lessons", id, situation.slice(0, 80), `${situation} | mistake: ${mistake} -> correction: ${correction}`);
          upsertEmbedding("lessons", id, embed(`${situation} ${mistake} ${correction}`));
        }
        for (const pr of input.validProfiles) {
          const section = redactSecrets(pr.section as string);
          const content = redactSecrets(pr.content as string);
          const ts = typeof pr.updated_at === "string" && isIsoDateString(pr.updated_at as string) ? (pr.updated_at as string) : nowISO();
          upsertProfile.run(section, content, ts);
        }
      }
    });
    applyAll();
    return null;
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return `import failed and rolled back: ${reason} (validated ${state.wouldImport} memories, ${state.linksImported} links, ${state.entitiesImported} entities, ${state.relationsImported} relations; nothing was written)`;
  }
}
