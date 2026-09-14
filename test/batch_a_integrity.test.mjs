import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const dbPath = join(tmpdir(), `th-batch-a-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { db, nowISO } = await import("../dist/db/index.js");
const { createMemory } = await import("../dist/db/repositories/memories.js");
const { forgetHandler } = await import("../dist/tools/forget.js");
const { importMemoryHandler } = await import("../dist/tools/import_memory.js");
const { ftsSearch } = await import("../dist/retrieval/fts.js");
const { createEntity, addRelation } = await import("../dist/core/graph-engine.js");

function text(r) {
  return r?.content?.[0]?.text ?? "";
}
function isErr(r) {
  return r?.isError === true || text(r).startsWith("error:");
}

// --- A1: forget without type must not silently delete across tables ---
test("A1: forget without type errors on ambiguous id, deletes nothing", async () => {
  const id = 900101;
  db.prepare(
    "INSERT OR REPLACE INTO preferences (id, category, key, value, confidence, source, updated_at) VALUES (?, 'other', 'batchA_amb', 'v', 0.5, 'explicit', ?)"
  ).run(id, nowISO());
  db.prepare(
    "INSERT OR REPLACE INTO lessons (id, situation, mistake, correction, created_at) VALUES (?, 's', 'm', 'c', ?)"
  ).run(id, nowISO());

  const res = await forgetHandler({ target_id: id });
  assert.ok(isErr(res), `expected ambiguous error, got: ${text(res)}`);
  assert.match(text(res), /ambiguous/);
  assert.match(text(res), /Specify type/);
  // Nothing deleted.
  assert.ok(db.prepare("SELECT id FROM preferences WHERE id = ?").get(id), "preference survives");
  assert.ok(db.prepare("SELECT id FROM lessons WHERE id = ?").get(id), "lesson survives");

  // Typed delete removes only that table.
  const one = await forgetHandler({ target_id: id, type: "preference" });
  assert.ok(!isErr(one), text(one));
  assert.equal(db.prepare("SELECT id FROM preferences WHERE id = ?").get(id), undefined);
  assert.ok(db.prepare("SELECT id FROM lessons WHERE id = ?").get(id), "lesson still survives typed delete");
  db.prepare("DELETE FROM lessons WHERE id = ?").run(id);
});

// --- A2a: trusted flag lands in metadata (default untrusted) ---
test("A2: import stores trusted flag in metadata, default untrusted", () => {
  const stamp = Date.now();
  const payload = JSON.stringify({
    memories: [
      { type: "FACT", content: `batchA trusted yes ${stamp}`, trusted: true },
      { type: "FACT", content: `batchA trusted default ${stamp}` },
    ],
    memoryLinks: [],
  });
  const applied = importMemoryHandler({ json: payload, apply: true });
  assert.ok(!isErr(applied), text(applied));
  const yes = db.prepare("SELECT metadata FROM memories WHERE content = ?").get(`batchA trusted yes ${stamp}`);
  const def = db.prepare("SELECT metadata FROM memories WHERE content = ?").get(`batchA trusted default ${stamp}`);
  assert.ok(yes && def, "both rows imported");
  assert.equal(JSON.parse(yes.metadata).trusted, true);
  assert.equal(JSON.parse(def.metadata).trusted, false);
});

// --- A2b: single-transaction atomicity (mid-batch throw rolls back all) ---
test("A2: import batch with a late poison row rolls back everything", () => {
  const stamp = Date.now();
  const good = `batchA atomic good ${stamp}`;
  const before = db.prepare("SELECT COUNT(*) AS c FROM memories").get().c;
  // Second row passes phase-1 validation (userId length ok) but ensureUser
  // throws in phase 2 (control char) -> whole transaction must roll back.
  const payload = JSON.stringify({
    memories: [
      { type: "FACT", content: good },
      { type: "FACT", content: `batchA atomic poison ${stamp}`, userId: "bad\u0001id" },
    ],
    memoryLinks: [],
  });
  const res = importMemoryHandler({ json: payload, apply: true });
  assert.ok(isErr(res), `expected rollback error, got: ${text(res)}`);
  assert.match(text(res), /rolled back/);
  const after = db.prepare("SELECT COUNT(*) AS c FROM memories").get().c;
  assert.equal(after, before, "no partial writes");
  assert.equal(db.prepare("SELECT id FROM memories WHERE content = ?").get(good), undefined);
});

// --- A3a: FK enforcement is ON ---
test("A3: foreign_keys pragma is ON and orphans are rejected", () => {
  const pragma = db.prepare("PRAGMA foreign_keys").get();
  assert.equal(pragma.foreign_keys, 1, "foreign_keys=ON");
  assert.throws(() => {
    db.prepare(
      "INSERT INTO relations (source_entity_id, relation, target_entity_id, confidence, source_memory_id, metadata) VALUES (999998001, 'related_to', 999998002, 0.5, NULL, '{}')"
    ).run();
  }, "orphan relation rejected by FK");
});

// --- A3b: relations upsert (no duplicate accumulation) ---
test("A3: addRelation upserts on (source, relation, target, memory)", () => {
  const stamp = Date.now();
  const e1 = createEntity({ name: `BatchAEnt1${stamp}` });
  const e2 = createEntity({ name: `BatchAEnt2${stamp}` });
  const mem = createMemory({ type: "FACT", content: `batchA rel mem ${stamp}` });
  const first = addRelation({ subjectId: e1, predicate: "related_to", objectId: e2, sourceMemoryId: mem });
  const second = addRelation({ subjectId: e1, predicate: "related_to", objectId: e2, sourceMemoryId: mem });
  assert.equal(second, first, "duplicate returns existing id");
  const c = db.prepare(
    "SELECT COUNT(*) AS c FROM relations WHERE source_entity_id = ? AND relation = ? AND target_entity_id = ?"
  ).get(e1, "related_to", e2).c;
  assert.equal(c, 1, "no duplicate rows");
  // Different source_memory is a distinct edge.
  const third = addRelation({ subjectId: e1, predicate: "related_to", objectId: e2, sourceMemoryId: null });
  assert.notEqual(third, first);
});

// --- A4: FTS scope is applied before LIMIT ---
test("A4: ftsSearch returns in-scope hit even when out-of-scope rows exceed limit", () => {
  const stamp = Date.now();
  const q = `zebrascope${stamp}`;
  // Out-of-scope rows rank higher (term repeated 3x) and outnumber the limit.
  for (let i = 0; i < 10; i++) {
    createMemory({ type: "FACT", content: `${q} ${q} ${q} filler ${i}`, sessionId: `nope-${stamp}` });
  }
  const inScope = createMemory({ type: "FACT", content: `${q} single`, projectId: `p-${stamp}` });
  const res = ftsSearch(q, { projectId: `p-${stamp}`, limit: 3 });
  const ids = res.map((r) => r.id);
  assert.ok(ids.includes(inScope), `in-scope hit must survive LIMIT (got ${JSON.stringify(ids)})`);
  assert.ok(ids.length <= 3, "limit respected");
  for (const id of ids) {
    const m = db.prepare("SELECT scope, project_id FROM memories WHERE id = ?").get(id);
    assert.ok(m.scope === "GLOBAL" || (m.scope === "PROJECT" && m.project_id === `p-${stamp}`), `row ${id} is visible in this scope`);
  }
});
