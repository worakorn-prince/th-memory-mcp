import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

const dbPath = join(
  tmpdir(),
  `th-sec-graph-${process.pid}-${Date.now()}.db`
);
process.env.MEMORY_DB_PATH = dbPath;

const { db } = await import("../dist/db/index.js");
const { createMemory } = await import("../dist/db/repositories/memories.js");
const { createEntity, addRelation, linkMemories } = await import(
  "../dist/core/graph-engine.js"
);
const { importMemoryHandler } = await import("../dist/tools/import_memory.js");

const OPENAI_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";

beforeEach(() => {
  const wipe = db.transaction(() => {
    for (const table of [
      "memory_links",
      "relations",
      "entities",
      "memories",
      "users",
    ]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
  });
  wipe();
});

after(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`, { force: true });
    } catch {
      /* ignore */
    }
  }
});

test("P1: createEntity redacts name, canonical, type, and aliases", () => {
  const id = createEntity({
    name: `leaky-entity-${OPENAI_KEY}`,
    type: `concept-${OPENAI_KEY}`,
    aliases: [`alias-${OPENAI_KEY}`],
  });
  const row = db
    .prepare("SELECT name, canonical_name, type, metadata FROM entities WHERE id = ?")
    .get(id);
  for (const value of [row.name, row.canonical_name, row.type, row.metadata]) {
    assert.ok(!String(value).includes(OPENAI_KEY), `raw secret leaked: ${value}`);
  }
});

test("P1: addRelation redacts predicate", () => {
  const a = createEntity({ name: `source-${Date.now()}` });
  const b = createEntity({ name: `target-${Date.now()}` });
  addRelation({
    subjectId: a,
    predicate: `supports-${OPENAI_KEY}`,
    objectId: b,
  });
  const row = db
    .prepare("SELECT relation FROM relations WHERE source_entity_id = ?")
    .get(a);
  assert.ok(!row.relation.includes(OPENAI_KEY));
});

test("P1: linkMemories redacts relation", () => {
  const a = createMemory({ type: "FACT", content: `link a ${Date.now()}` });
  const b = createMemory({ type: "FACT", content: `link b ${Date.now()}` });
  linkMemories(a, b, `related-${OPENAI_KEY}`);
  const row = db
    .prepare("SELECT relation FROM memory_links WHERE source_memory_id = ?")
    .get(a);
  assert.ok(!row.relation.includes(OPENAI_KEY));
});

test("P1: import redacts entity and relation graph fields", () => {
  const stamp = Date.now();
  const payload = {
    memories: [{ id: 1, type: "FACT", content: `graph import ${stamp}` }],
    entities: [
      {
        id: 10,
        name: `ent-a-${OPENAI_KEY}`,
        canonicalName: `ent-a-${OPENAI_KEY}`,
        type: "concept",
        metadata: { note: OPENAI_KEY, nested: { value: OPENAI_KEY } },
      },
      {
        id: 11,
        name: `ent-b-${stamp}`,
        canonicalName: `ent-b-${stamp}`,
        type: "concept",
      },
    ],
    relations: [
      {
        sourceEntityId: 10,
        targetEntityId: 11,
        relation: `links-${OPENAI_KEY}`,
        confidence: 0.5,
        metadata: { note: OPENAI_KEY },
      },
    ],
  };
  const res = importMemoryHandler({
    json: JSON.stringify(payload),
    apply: true,
    trusted: true,
  });
  assert.ok(res?.isError !== true, JSON.stringify(res));

  const entities = db
    .prepare("SELECT name, canonical_name, metadata FROM entities")
    .all();
  const relations = db.prepare("SELECT relation, metadata FROM relations").all();
  assert.ok(entities.length >= 2);
  assert.ok(relations.length >= 1);
  for (const row of [...entities, ...relations]) {
    for (const value of Object.values(row)) {
      assert.ok(
        !String(value).includes(OPENAI_KEY),
        `raw secret leaked through import: ${value}`
      );
    }
  }
});
