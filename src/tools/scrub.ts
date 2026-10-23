import { db, syncSearchIndex, upsertEmbedding } from "../db/index.js";
import { syncMemoryIndex } from "../db/repositories/memories.js";
import { embed } from "../lib/embed.js";
import { redactMetadata, redactSecrets } from "../lib/redact.js";

export interface ScrubReport {
  apply: boolean;
  changed: Record<string, number>;
}

function redactText(value: string | null): string | null {
  return value == null ? null : redactSecrets(value);
}

function redactMetadataJson(value: string | null): string | null {
  if (value == null) return null;
  try {
    return JSON.stringify(redactMetadata(JSON.parse(value)));
  } catch {
    return redactSecrets(value);
  }
}

/**
 * P1-HISTORICAL-SCRUB: find (and optionally rewrite) rows written before
 * write-boundary redaction existed. Dry-run unless `apply` is true.
 */
export function scrubHistoricalSecrets(apply = false): ScrubReport {
  const changed: Record<string, number> = {};
  const bump = (table: string) => {
    changed[table] = (changed[table] ?? 0) + 1;
  };

  const reindexMemory: number[] = [];
  const reindexPreference: number[] = [];
  const reindexLesson: number[] = [];

  const work = db.transaction(() => {
    // memories
    const memRows = db
      .prepare("SELECT id, content, summary, project_id, session_id, metadata FROM memories")
      .all() as Array<{
      id: number;
      content: string;
      summary: string | null;
      project_id: string | null;
      session_id: string | null;
      metadata: string | null;
    }>;
    const updMem = db.prepare(
      `UPDATE memories SET content = ?, summary = ?, project_id = ?, session_id = ?, metadata = ? WHERE id = ?`
    );
    for (const r of memRows) {
      const content = redactSecrets(r.content);
      const summary = redactText(r.summary);
      const projectId = redactText(r.project_id);
      const sessionId = redactText(r.session_id);
      const metadata = redactMetadataJson(r.metadata);
      if (
        content === r.content &&
        summary === r.summary &&
        projectId === r.project_id &&
        sessionId === r.session_id &&
        metadata === r.metadata
      ) {
        continue;
      }
      bump("memories");
      if (apply) {
        updMem.run(content, summary, projectId, sessionId, metadata, r.id);
        reindexMemory.push(r.id);
      }
    }

    // preferences
    const prefRows = db.prepare("SELECT id, key, value FROM preferences").all() as Array<{
      id: number;
      key: string;
      value: string;
    }>;
    const updPref = db.prepare("UPDATE preferences SET key = ?, value = ? WHERE id = ?");
    for (const r of prefRows) {
      const key = redactSecrets(r.key);
      const value = redactSecrets(r.value);
      if (key === r.key && value === r.value) continue;
      bump("preferences");
      if (apply) {
        updPref.run(key, value, r.id);
        reindexPreference.push(r.id);
      }
    }

    // lessons
    const lessonRows = db
      .prepare("SELECT id, situation, mistake, correction FROM lessons")
      .all() as Array<{
      id: number;
      situation: string;
      mistake: string;
      correction: string;
    }>;
    const updLesson = db.prepare(
      "UPDATE lessons SET situation = ?, mistake = ?, correction = ? WHERE id = ?"
    );
    for (const r of lessonRows) {
      const situation = redactSecrets(r.situation);
      const mistake = redactSecrets(r.mistake);
      const correction = redactSecrets(r.correction);
      if (
        situation === r.situation &&
        mistake === r.mistake &&
        correction === r.correction
      ) {
        continue;
      }
      bump("lessons");
      if (apply) {
        updLesson.run(situation, mistake, correction, r.id);
        reindexLesson.push(r.id);
      }
    }

    // profile (section is the PK; only content is scrubbed)
    const profileRows = db.prepare("SELECT section, content FROM profile").all() as Array<{
      section: string;
      content: string;
    }>;
    const updProfile = db.prepare("UPDATE profile SET content = ? WHERE section = ?");
    for (const r of profileRows) {
      const content = redactSecrets(r.content);
      if (content === r.content) continue;
      bump("profile");
      if (apply) updProfile.run(content, r.section);
    }

    // interactions
    const intRows = db
      .prepare("SELECT id, content, meta, session_id FROM interactions")
      .all() as Array<{
      id: number;
      content: string;
      meta: string | null;
      session_id: string | null;
    }>;
    const updInt = db.prepare(
      "UPDATE interactions SET content = ?, meta = ?, session_id = ? WHERE id = ?"
    );
    for (const r of intRows) {
      const content = redactSecrets(r.content);
      const meta = redactMetadataJson(r.meta);
      const sessionId = redactText(r.session_id);
      if (content === r.content && meta === r.meta && sessionId === r.session_id) continue;
      bump("interactions");
      if (apply) updInt.run(content, meta, sessionId, r.id);
    }

    // entities
    const entRows = db
      .prepare("SELECT id, name, canonical_name, type, metadata FROM entities")
      .all() as Array<{
      id: number;
      name: string;
      canonical_name: string;
      type: string | null;
      metadata: string | null;
    }>;
    const updEnt = db.prepare(
      "UPDATE OR IGNORE entities SET name = ?, canonical_name = ?, type = ?, metadata = ? WHERE id = ?"
    );
    for (const r of entRows) {
      const name = redactSecrets(r.name);
      const canonical = redactSecrets(r.canonical_name);
      const type = redactText(r.type);
      const metadata = redactMetadataJson(r.metadata);
      if (
        name === r.name &&
        canonical === r.canonical_name &&
        type === r.type &&
        metadata === r.metadata
      ) {
        continue;
      }
      bump("entities");
      if (apply) updEnt.run(name, canonical, type, metadata, r.id);
    }

    // relations
    const relRows = db
      .prepare("SELECT id, relation, metadata FROM relations")
      .all() as Array<{ id: number; relation: string; metadata: string | null }>;
    const updRel = db.prepare("UPDATE relations SET relation = ?, metadata = ? WHERE id = ?");
    for (const r of relRows) {
      const relation = redactSecrets(r.relation);
      const metadata = redactMetadataJson(r.metadata);
      if (relation === r.relation && metadata === r.metadata) continue;
      bump("relations");
      if (apply) updRel.run(relation, metadata, r.id);
    }

    // memory_links (relation is part of the PK)
    const linkRows = db
      .prepare("SELECT source_memory_id, relation, target_memory_id FROM memory_links")
      .all() as Array<{
      source_memory_id: number;
      relation: string;
      target_memory_id: number;
    }>;
    const updLink = db.prepare(
      "UPDATE OR IGNORE memory_links SET relation = ? WHERE source_memory_id = ? AND relation = ? AND target_memory_id = ?"
    );
    for (const r of linkRows) {
      const relation = redactSecrets(r.relation);
      if (relation === r.relation) continue;
      bump("memory_links");
      if (apply) {
        updLink.run(relation, r.source_memory_id, r.relation, r.target_memory_id);
      }
    }

    // users (external_id is an identity key and stays untouched)
    const userRows = db.prepare("SELECT id, name FROM users").all() as Array<{
      id: number;
      name: string | null;
    }>;
    const updUser = db.prepare("UPDATE users SET name = ? WHERE id = ?");
    for (const r of userRows) {
      const name = redactText(r.name);
      if (name === r.name) continue;
      bump("users");
      if (apply) updUser.run(name, r.id);
    }

    if (apply) {
      for (const id of reindexMemory) {
        const row = db
          .prepare("SELECT type, content FROM memories WHERE id = ?")
          .get(id) as { type: string; content: string } | undefined;
        if (row) syncMemoryIndex(id, row.type, row.content);
      }
      for (const id of reindexPreference) {
        const row = db
          .prepare("SELECT category, key, value FROM preferences WHERE id = ?")
          .get(id) as { category: string; key: string; value: string } | undefined;
        if (row) {
          syncSearchIndex("preferences", id, `${row.category}/${row.key}`, `${row.key}: ${row.value}`);
          upsertEmbedding("preferences", id, embed(`${row.category} ${row.key} ${row.value}`));
        }
      }
      for (const id of reindexLesson) {
        const row = db
          .prepare("SELECT situation, mistake, correction FROM lessons WHERE id = ?")
          .get(id) as { situation: string; mistake: string; correction: string } | undefined;
        if (row) {
          syncSearchIndex(
            "lessons",
            id,
            row.situation.slice(0, 80),
            `${row.situation} | mistake: ${row.mistake} -> correction: ${row.correction}`
          );
          upsertEmbedding(
            "lessons",
            id,
            embed(`${row.situation} ${row.mistake} ${row.correction}`)
          );
        }
      }
    }
  });

  work();
  return { apply, changed };
}
