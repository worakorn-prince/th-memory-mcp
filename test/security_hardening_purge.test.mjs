import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";

const tempRoot = mkdtempSync(join(tmpdir(), `th-sec-purge-${process.pid}-`));
const dbPath = join(tempRoot, "memory.db");
process.env.MEMORY_DB_PATH = dbPath;

const { db } = await import("../dist/db/index.js");
const { createMemory } = await import("../dist/db/repositories/memories.js");
const { forgetHandler } = await import("../dist/tools/forget.js");
const { exportMemoryHandler } = await import("../dist/tools/export_memory.js");
const {
  createEntity,
  addRelation,
  linkMemories,
} = await import("../dist/core/graph-engine.js");

after(() => {
  try {
    db.close();
  } catch {}
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {}
});

function text(r) {
  return r?.content?.[0]?.text ?? "";
}

function memory(id) {
  return db.prepare("SELECT * FROM memories WHERE id = ?").get(id);
}

function indexRows(id) {
  return db
    .prepare(
      "SELECT body FROM search_index WHERE ref_table = 'memories' AND ref_id = ?"
    )
    .all(id);
}

function embeddingRows(id) {
  return db
    .prepare(
      "SELECT ref_id FROM embeddings WHERE ref_table = 'memories' AND ref_id = ?"
    )
    .all(id);
}

test("forget hard-purges memory row, links, relation source, and supersession link", async () => {
  const stamp = Date.now();
  const marker = `PURGE_CONTENT_MARKER_${stamp}`;
  const a = createMemory({ type: "FACT", content: `${marker} memory A` });
  const b = createMemory({ type: "FACT", content: `purge memory B ${stamp}` });
  const c = createMemory({ type: "FACT", content: `purge memory C ${stamp}` });

  linkMemories(a, b, "supports");
  linkMemories(b, a, "supports");
  db.prepare("UPDATE memories SET supersedes_id = ? WHERE id = ?").run(a, c);

  const sourceEntity = createEntity({ name: `PurgeSource${stamp}` });
  const targetEntity = createEntity({ name: `PurgeTarget${stamp}` });
  const relationId = addRelation({
    subjectId: sourceEntity,
    predicate: "derived_from",
    objectId: targetEntity,
    confidence: 0.9,
    sourceMemoryId: a,
  });

  // Preconditions: content is indexed and referenced.
  assert.ok(indexRows(a).some((row) => row.body.includes(marker)));
  assert.equal(embeddingRows(a).length, 1);
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM memory_links WHERE source_memory_id = ? OR target_memory_id = ?"
      )
      .get(a, a).c,
    2
  );
  assert.equal(
    db.prepare("SELECT source_memory_id FROM relations WHERE id = ?").get(relationId)
      .source_memory_id,
    a
  );

  const res = await forgetHandler({ target_id: a, type: "memory" });
  assert.match(text(res), /forgot memory/);
  assert.match(text(res), /2 link\(s\) removed/);

  assert.equal(memory(a), undefined, "memory row must be hard-deleted");
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM memory_links WHERE source_memory_id = ? OR target_memory_id = ?"
      )
      .get(a, a).c,
    0,
    "links on both sides must be deleted"
  );
  assert.equal(
    db.prepare("SELECT source_memory_id FROM relations WHERE id = ?").get(relationId)
      .source_memory_id,
    null,
    "relation source must be nulled, not deleted"
  );
  const survivor = memory(c);
  assert.ok(survivor, "referencing memory must survive");
  assert.equal(
    survivor.supersedes_id,
    null,
    "supersession chain must be intentionally broken"
  );
  assert.equal(indexRows(a).length, 0, "search index rows must be removed");
  assert.equal(embeddingRows(a).length, 0, "embeddings must be removed");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM search_index WHERE body LIKE ?").get(
      `%${marker}%`
    ).c,
    0,
    "purged content must not survive in the search index"
  );
});

test("forget purges legacy rows that are already status='deleted'", async () => {
  const stamp = Date.now();
  const marker = `LEGACY_DELETED_MARKER_${stamp}`;
  const d = createMemory({ type: "FACT", content: `${marker} legacy D` });
  db.prepare("UPDATE memories SET status = 'deleted' WHERE id = ?").run(d);
  assert.equal(memory(d).status, "deleted");

  const res = await forgetHandler({ target_id: d, type: "memory" });
  assert.match(text(res), /forgot memory/);
  assert.equal(memory(d), undefined, "legacy soft-deleted row must be purged");
  assert.equal(indexRows(d).length, 0);
  assert.equal(embeddingRows(d).length, 0);
});

test("export excludes deleted/forgotten memories, their links, and their relations", async () => {
  const stamp = Date.now();
  const keepMarker = `EXPORT_KEEP_MARKER_${stamp}`;
  const softMarker = `EXPORT_SOFT_DELETED_MARKER_${stamp}`;
  const goneMarker = `EXPORT_FORGOTTEN_MARKER_${stamp}`;

  const keep = createMemory({ type: "FACT", content: `${keepMarker} keep` });
  const partner = createMemory({ type: "FACT", content: `export partner ${stamp}` });
  const soft = createMemory({ type: "FACT", content: `${softMarker} soft deleted` });
  const gone = createMemory({ type: "FACT", content: `${goneMarker} forgotten` });

  // Legacy soft delete (row still exists in the DB).
  db.prepare("UPDATE memories SET status = 'deleted' WHERE id = ?").run(soft);

  linkMemories(keep, partner, "supports");
  linkMemories(keep, soft, "supports");
  linkMemories(soft, keep, "supports");
  linkMemories(keep, gone, "supports");

  const sourceEntity = createEntity({ name: `ExportSource${stamp}` });
  const targetEntity = createEntity({ name: `ExportTarget${stamp}` });
  const softRelation = addRelation({
    subjectId: sourceEntity,
    predicate: "referenced_by",
    objectId: targetEntity,
    confidence: 0.8,
    sourceMemoryId: soft,
  });
  const globalRelation = addRelation({
    subjectId: sourceEntity,
    predicate: "related_to",
    objectId: targetEntity,
    confidence: 0.7,
    sourceMemoryId: null,
  });

  const forgotten = await forgetHandler({ target_id: gone, type: "memory" });
  assert.match(text(forgotten), /forgot memory/);

  const exp = await exportMemoryHandler({ filename: "purge-export.json" });
  const filePath = text(exp).match(/exported:\s*(\S+\.json)/)?.[1];
  assert.ok(filePath && existsSync(filePath), "export file must exist");
  assert.ok(
    filePath.startsWith(join(tempRoot, "exports")),
    "export must stay inside the temp directory"
  );

  const raw = readFileSync(filePath, "utf8");
  const payload = JSON.parse(raw);
  assert.equal(payload.format, "th-memory-mcp/v2");

  assert.ok(
    payload.memories.some((m) => m.id === keep),
    "active memory must be exported"
  );
  assert.equal(
    payload.memories.some((m) => m.id === soft || m.id === gone),
    false,
    "deleted/forgotten memory rows must not be exported"
  );
  assert.equal(raw.includes(softMarker), false, "soft-deleted content must not leak");
  assert.equal(raw.includes(goneMarker), false, "forgotten content must not leak");

  assert.equal(
    payload.memoryLinks.some(
      (l) =>
        l.sourceId === soft ||
        l.targetId === soft ||
        l.sourceId === gone ||
        l.targetId === gone
    ),
    false,
    "links touching deleted/forgotten memories must not be exported"
  );
  assert.ok(
    payload.memoryLinks.some((l) => l.sourceId === keep && l.targetId === partner),
    "links between live memories must survive"
  );

  assert.equal(
    payload.relations.some((r) => r.id === softRelation),
    false,
    "relations sourced from a deleted memory must not be exported"
  );
  assert.ok(
    payload.relations.some((r) => r.id === globalRelation && r.sourceMemoryId === null),
    "relations with a NULL source memory must be exported"
  );
});
