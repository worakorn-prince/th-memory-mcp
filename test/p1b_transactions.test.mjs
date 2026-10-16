import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import assert from "node:assert/strict";

const dbPath = join(tmpdir(), `th-p1b-tx-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { db } = await import("../dist/db/index.js");
const { createMemory } = await import("../dist/db/repositories/memories.js");
const { rememberHandler } = await import("../dist/tools/remember.js");
const { saveLessonHandler } = await import("../dist/tools/lesson.js");
const { importMemoryHandler } = await import("../dist/tools/import_memory.js");

after(() => {
  try {
    db.close();
  } catch {}
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
});

function text(r) {
  return r?.content?.[0]?.text ?? "";
}

function isErr(r) {
  return r?.isError === true || text(r).startsWith("error:");
}

function hasFts(refTable, refId) {
  return (
    db
      .prepare("SELECT rowid FROM search_index WHERE ref_table = ? AND ref_id = ?")
      .get(refTable, refId) !== undefined
  );
}

function hasEmbedding(refTable, refId) {
  return (
    db
      .prepare("SELECT ref_id FROM embeddings WHERE ref_table = ? AND ref_id = ?")
      .get(refTable, refId) !== undefined
  );
}

test("P1-B happy: createMemory commits row + FTS + embedding together", () => {
  const id = createMemory({ type: "FACT", content: "p1b happy memory" });
  assert.ok(db.prepare("SELECT id FROM memories WHERE id = ?").get(id));
  assert.ok(hasFts("memories", id));
  assert.ok(hasEmbedding("memories", id));
});

test("P1-B happy: remember commits preference + FTS + embedding, output unchanged", async () => {
  const r = await rememberHandler({ category: "other", key: "p1b_key", value: "p1b_value" });
  assert.ok(!isErr(r), text(r));
  assert.match(
    text(r),
    /^remembered \[other\] p1b_key = p1b_value \(preference id=\d+, confidence=0\.50\)$/
  );
  const row = db.prepare("SELECT id FROM preferences WHERE key = ?").get("p1b_key");
  assert.ok(row);
  assert.ok(hasFts("preferences", row.id));
  assert.ok(hasEmbedding("preferences", row.id));
});

test("P1-B happy: save_lesson commits lesson + FTS + embedding, output unchanged", async () => {
  const r = await saveLessonHandler({
    situation: "p1b happy situation",
    mistake: "p1b happy mistake",
    correction: "p1b happy correction",
  });
  assert.ok(!isErr(r), text(r));
  assert.match(text(r), /^lesson saved \(lesson id=\d+\)$/);
  const row = db.prepare("SELECT id FROM lessons WHERE situation = ?").get("p1b happy situation");
  assert.ok(row);
  assert.ok(hasFts("lessons", row.id));
  assert.ok(hasEmbedding("lessons", row.id));
});

test("P1-B nested: import apply (outer tx) + createMemory savepoint commits all indexes", () => {
  const payload = JSON.stringify({
    memories: [{ type: "FACT", content: "p1b import nested ok" }],
    memoryLinks: [],
  });
  const r = importMemoryHandler({ json: payload, apply: true });
  assert.ok(!isErr(r), text(r));
  const row = db.prepare("SELECT id FROM memories WHERE content = ?").get("p1b import nested ok");
  assert.ok(row, "imported memory row exists");
  assert.ok(hasFts("memories", row.id));
  assert.ok(hasEmbedding("memories", row.id));
});

test("P1-B nested: import apply rolls back the whole batch when nested createMemory fails", () => {
  const embedsBefore = db
    .prepare("SELECT COUNT(*) AS c FROM embeddings WHERE ref_table = 'memories'")
    .get().c;
  const payload = JSON.stringify({
    memories: [
      { type: "FACT", content: "p1b import rb first" },
      { type: "FACT", content: "p1b import rb second", userId: "bad\u0001user" },
    ],
    memoryLinks: [],
  });
  const r = importMemoryHandler({ json: payload, apply: true });
  assert.ok(isErr(r), `expected error, got: ${text(r)}`);
  assert.match(text(r), /rolled back/);
  assert.equal(
    db.prepare("SELECT id FROM memories WHERE content LIKE 'p1b import rb %'").get(),
    undefined
  );
  assert.equal(
    db
      .prepare("SELECT rowid FROM search_index WHERE ref_table = 'memories' AND body LIKE ?")
      .get("%p1b import rb %"),
    undefined
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM embeddings WHERE ref_table = 'memories'").get().c,
    embedsBefore
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM embeddings e WHERE e.ref_table = 'memories' AND e.ref_id NOT IN (SELECT id FROM memories)"
      )
      .get().c,
    0
  );
});

test("P1-B setup: drop embeddings table so every embedding write fails", () => {
  db.exec("DROP TABLE embeddings");
  assert.throws(() => db.prepare("SELECT 1 FROM embeddings LIMIT 1").get(), /no such table/);
});

test("P1-B rollback: createMemory leaves no memory row and no FTS row when embedding fails", () => {
  assert.throws(
    () => createMemory({ type: "FACT", content: "p1b rollback memory" }),
    /no such table/
  );
  assert.equal(
    db.prepare("SELECT id FROM memories WHERE content = ?").get("p1b rollback memory"),
    undefined
  );
  assert.equal(
    db
      .prepare("SELECT rowid FROM search_index WHERE ref_table = 'memories' AND body LIKE ?")
      .get("%p1b rollback memory%"),
    undefined
  );
});

test("P1-B rollback: remember leaves no preference row and no FTS row when embedding fails", async () => {
  const r = await rememberHandler({ category: "other", key: "p1b_rb_key", value: "p1b_rb_value" });
  assert.ok(isErr(r), `expected error, got: ${text(r)}`);
  assert.match(text(r), /no such table/);
  assert.equal(
    db.prepare("SELECT id FROM preferences WHERE key = ?").get("p1b_rb_key"),
    undefined
  );
  assert.equal(
    db
      .prepare("SELECT rowid FROM search_index WHERE ref_table = 'preferences' AND title = ?")
      .get("other/p1b_rb_key"),
    undefined
  );
});

test("P1-B rollback: save_lesson leaves no lesson row and no FTS row when embedding fails", async () => {
  const r = await saveLessonHandler({
    situation: "p1b rb situation",
    mistake: "p1b rb mistake",
    correction: "p1b rb correction",
  });
  assert.ok(isErr(r), `expected error, got: ${text(r)}`);
  assert.match(text(r), /no such table/);
  assert.equal(
    db.prepare("SELECT id FROM lessons WHERE situation = ?").get("p1b rb situation"),
    undefined
  );
  assert.equal(
    db
      .prepare("SELECT rowid FROM search_index WHERE ref_table = 'lessons' AND body LIKE ?")
      .get("%p1b rb situation%"),
    undefined
  );
});
