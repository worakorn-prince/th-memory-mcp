import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { after, test } from "node:test";
import assert from "node:assert/strict";

const dbPath = join(tmpdir(), `th-scrub-${process.pid}-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { db } = await import("../dist/db/index.js");
const { scrubHistoricalSecrets } = await import("../dist/tools/scrub.js");

const OPENAI_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
const now = new Date().toISOString();

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

function seedLegacyRows() {
  const insMem = db.prepare(
    "INSERT INTO memories (type, content, summary, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const m1 = Number(insMem.run("FACT", `legacy ${OPENAI_KEY}`, `summary ${OPENAI_KEY}`, JSON.stringify({ note: OPENAI_KEY }), now, now).lastInsertRowid);
  const m2 = Number(insMem.run("FACT", "clean memory", null, null, now, now).lastInsertRowid);

  db.prepare(
    "INSERT INTO preferences (category, key, value, updated_at) VALUES (?, ?, ?, ?)"
  ).run("other", `legacy-key-${OPENAI_KEY}`, `legacy-value-${OPENAI_KEY}`, now);
  db.prepare(
    "INSERT INTO lessons (situation, mistake, correction, created_at) VALUES (?, ?, ?, ?)"
  ).run(`sit ${OPENAI_KEY}`, "mis", "fix", now);
  db.prepare("INSERT INTO profile (section, content, updated_at) VALUES (?, ?, ?)").run(
    "legacy",
    `profile ${OPENAI_KEY}`,
    now
  );
  db.prepare(
    "INSERT INTO interactions (ts, kind, content, meta) VALUES (?, ?, ?, ?)"
  ).run(now, "prompt", `interaction ${OPENAI_KEY}`, JSON.stringify({ token: OPENAI_KEY }));

  const ent = db.prepare(
    "INSERT INTO entities (name, canonical_name, type, metadata) VALUES (?, ?, ?, ?)"
  );
  const e1 = Number(ent.run(`ent-${OPENAI_KEY}`, `ent-${OPENAI_KEY}`, "concept", JSON.stringify({ alias: OPENAI_KEY })).lastInsertRowid);
  const e2 = Number(ent.run("clean-entity", "clean-entity", "concept", null).lastInsertRowid);
  db.prepare(
    "INSERT INTO relations (source_entity_id, relation, target_entity_id, metadata) VALUES (?, ?, ?, ?)"
  ).run(e1, `rel-${OPENAI_KEY}`, e2, JSON.stringify({ note: OPENAI_KEY }));
  db.prepare(
    "INSERT INTO memory_links (source_memory_id, relation, target_memory_id, created_at) VALUES (?, ?, ?, ?)"
  ).run(m1, `link-${OPENAI_KEY}`, m2, now);
  db.prepare("INSERT INTO users (external_id, name, created_at) VALUES (?, ?, ?)").run(
    "user-1",
    `user ${OPENAI_KEY}`,
    now
  );
  return { m1, m2, e1 };
}

function countLeaks() {
  const values = [];
  for (const [sql] of [
    ["SELECT content, summary, metadata FROM memories"],
    ["SELECT key, value FROM preferences"],
    ["SELECT situation, mistake, correction FROM lessons"],
    ["SELECT content FROM profile"],
    ["SELECT content, meta FROM interactions"],
    ["SELECT name, canonical_name, metadata FROM entities"],
    ["SELECT relation, metadata FROM relations"],
    ["SELECT relation FROM memory_links"],
    ["SELECT name FROM users"],
  ]) {
    for (const row of db.prepare(sql).all()) {
      for (const value of Object.values(row)) values.push(String(value));
    }
  }
  return values.filter((v) => v.includes(OPENAI_KEY)).length;
}

test("P1-HISTORICAL-SCRUB: dry-run reports but does not modify", () => {
  seedLegacyRows();
  assert.ok(countLeaks() > 0, "seed contains raw secrets");

  const report = scrubHistoricalSecrets(false);
  assert.equal(report.apply, false);
  assert.ok((report.changed.memories ?? 0) >= 1);
  assert.ok((report.changed.preferences ?? 0) >= 1);
  assert.ok((report.changed.entities ?? 0) >= 1);
  assert.ok(countLeaks() > 0, "dry-run must not modify rows");
});

test("P1-HISTORICAL-SCRUB: apply rewrites legacy rows and keeps clean rows", () => {
  const report = scrubHistoricalSecrets(true);
  assert.equal(report.apply, true);
  assert.ok(Object.values(report.changed).some((n) => n > 0));

  assert.equal(countLeaks(), 0, "no raw secret should remain after apply");
  const clean = db.prepare("SELECT content FROM memories WHERE content = 'clean memory'").get();
  assert.ok(clean, "clean row untouched");
  const user = db.prepare("SELECT external_id FROM users WHERE name IS NOT NULL").get();
  assert.equal(user.external_id, "user-1", "external_id stays as identity key");
});
