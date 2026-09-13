import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const dbPath = join(tmpdir(), `th-export-v2-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { createMemory } = await import("../dist/db/repositories/memories.js");
const { exportMemoryHandler } = await import("../dist/tools/export_memory.js");
const { importMemoryHandler } = await import("../dist/tools/import_memory.js");
const { forgetHandler } = await import("../dist/tools/forget.js");
const { db } = await import("../dist/db/index.js");
const { createEntity, addRelation } = await import("../dist/core/graph-engine.js");
const { ensureUser } = await import("../dist/db/repositories/users.js");

test("v2 export includes memories and graph links; import preserves lifecycle", async () => {
  const first = createMemory({ type: "FACT", content: "export v2 first", projectId: "project-a" });
  const second = createMemory({ type: "DECISION", content: "export v2 second", status: "archived" });
  db.prepare("INSERT INTO memory_links (source_memory_id, relation, target_memory_id, confidence, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(first, "supports", second, 0.8, new Date().toISOString());

  const exp = await exportMemoryHandler({ filename: "v2-export-test.json" });
  const filePath = exp.content[0].text.match(/exported:\s*(\S+\.json)/)?.[1];
  assert.ok(filePath && existsSync(filePath));
  const payload = JSON.parse(readFileSync(filePath, "utf8"));
  assert.equal(payload.format, "th-memory-mcp/v2");
  assert.ok(payload.memories.some((m) => m.id === first && m.projectId === "project-a"));
  assert.ok(payload.memoryLinks.some((l) => l.sourceId === first && l.targetId === second));

  const imported = importMemoryHandler({
    json: JSON.stringify({
      memories: [{ id: 101, type: "GOAL", content: "imported archived goal", status: "archived" }],
      memoryLinks: [],
    }),
    apply: true,
  });
  assert.match(imported.content[0].text, /1 to import/);
  const restored = db.prepare("SELECT id, status FROM memories WHERE content = ?").get("imported archived goal");
  assert.equal(restored.status, "archived");

  const forgotten = await forgetHandler({ target_id: restored.id, type: "memory" });
  assert.match(forgotten.content[0].text, /forgot memory/);
  assert.equal(db.prepare("SELECT status FROM memories WHERE id = ?").get(restored.id).status, "deleted");
});

test("Batch A: entities/relations/users round-trip via export/import", async () => {
  const stamp = Date.now();
  const userExt = `batch-a-user-${stamp}`;
  ensureUser(userExt, "Batch A");
  const memUser = createMemory({ type: "FACT", content: `batchA user memory ${stamp}`, userId: userExt });
  const e1Name = `BatchAAlpha${stamp}`;
  const e2Name = `BatchABeta${stamp}`;
  const e1 = createEntity({ name: e1Name, type: "concept" });
  const e2 = createEntity({ name: e2Name, type: "concept" });
  addRelation({ subjectId: e1, predicate: "related_to", objectId: e2, confidence: 0.9, sourceMemoryId: memUser });

  const exp = await exportMemoryHandler({ filename: "v2-batch-a-entities.json" });
  const filePath = exp.content[0].text.match(/exported:\s*(\S+\.json)/)?.[1];
  assert.ok(filePath && existsSync(filePath));
  const payload = JSON.parse(readFileSync(filePath, "utf8"));
  // Format stays v2 (additive backward-compatible fields, see export_memory.ts comment).
  assert.equal(payload.format, "th-memory-mcp/v2");
  assert.ok(Array.isArray(payload.users) && payload.users.some((u) => u.externalId === userExt));
  assert.ok(Array.isArray(payload.entities) && payload.entities.some((e) => e.id === e1 && e.name === e1Name));
  assert.ok(
    Array.isArray(payload.relations) &&
      payload.relations.some((r) => r.sourceEntityId === e1 && r.targetEntityId === e2)
  );

  // Simulate loss of graph tables, then restore from the same payload.
  db.prepare("DELETE FROM relations").run();
  db.prepare("DELETE FROM entities").run();
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entities").get().c, 0);

  const restored = importMemoryHandler({ json: JSON.stringify(payload), apply: true });
  assert.match(restored.content[0].text, /applied/);
  assert.match(restored.content[0].text, /entities \d+ ok/);
  const entCount = db.prepare("SELECT COUNT(*) AS c FROM entities").get().c;
  assert.ok(entCount >= 2, `entities restored, got ${entCount}`);
  const relCount = db.prepare("SELECT COUNT(*) AS c FROM relations").get().c;
  assert.ok(relCount >= 1, `relations restored, got ${relCount}`);
  // Users are idempotent (INSERT OR IGNORE on external_id).
  const userRow = db.prepare("SELECT external_id FROM users WHERE external_id = ?").get(userExt);
  assert.equal(userRow.external_id, userExt);

  // Re-import must not duplicate entities (idempotent by canonical_name).
  const before = db.prepare("SELECT COUNT(*) AS c FROM entities").get().c;
  const again = importMemoryHandler({ json: JSON.stringify(payload), apply: true });
  assert.match(again.content[0].text, /applied/);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entities").get().c, before);
});

test("Batch A: forget removes memory_links on both sides and reports count", async () => {
  const stamp = Date.now();
  const memA = createMemory({ type: "FACT", content: `batchA forget A ${stamp}` });
  const memB = createMemory({ type: "FACT", content: `batchA forget B ${stamp}` });
  const memC = createMemory({ type: "FACT", content: `batchA forget C ${stamp}` });
  const now = new Date().toISOString();
  db.prepare(
    "INSERT OR IGNORE INTO memory_links (source_memory_id, relation, target_memory_id, confidence, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(memA, "supports", memB, 0.7, now);
  db.prepare(
    "INSERT OR IGNORE INTO memory_links (source_memory_id, relation, target_memory_id, confidence, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(memB, "supports", memA, 0.7, now);
  db.prepare(
    "INSERT OR IGNORE INTO memory_links (source_memory_id, relation, target_memory_id, confidence, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(memB, "related_to", memC, 0.6, now);
  const entBefore = db.prepare("SELECT COUNT(*) AS c FROM entities").get().c;
  const relBefore = db.prepare("SELECT COUNT(*) AS c FROM relations").get().c;

  const res = await forgetHandler({ target_id: memA, type: "memory" });
  assert.match(res.content[0].text, /forgot memory/);
  assert.match(res.content[0].text, /link\(s\) removed/);
  assert.match(res.content[0].text, /2 link\(s\) removed/);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM memory_links WHERE source_memory_id = ? OR target_memory_id = ?").get(memA, memA).c,
    0
  );
  // Unrelated edge B->C must survive.
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM memory_links WHERE source_memory_id = ? AND target_memory_id = ?").get(memB, memC).c,
    1
  );
  // entities/relations must NOT be deleted by forget (shared graph nodes).
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM entities").get().c, entBefore);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM relations").get().c, relBefore);
});

test("Batch A: import legacy v2 file without new fields still passes", () => {
  const stamp = Date.now();
  const legacy = JSON.stringify({
    format: "th-memory-mcp/v2",
    memories: [{ type: "FACT", content: `batchA legacy ${stamp}` }],
    memoryLinks: [],
  });
  const dry = importMemoryHandler({ json: legacy, apply: false });
  assert.match(dry.content[0].text, /dry-run/);
  assert.match(dry.content[0].text, /users 0 ok/);
  const applied = importMemoryHandler({ json: legacy, apply: true });
  assert.match(applied.content[0].text, /applied/);
  const row = db.prepare("SELECT id FROM memories WHERE content = ?").get(`batchA legacy ${stamp}`);
  assert.ok(row && row.id > 0);
});
