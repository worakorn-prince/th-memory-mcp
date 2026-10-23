import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

const dbPath = join(tmpdir(), `th-trust-prop-${process.pid}-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { db } = await import("../dist/db/index.js");
const { createMemory } = await import("../dist/db/repositories/memories.js");
const { consolidateHandler } = await import("../dist/tools/consolidate.js");

function textOf(res) {
  return res?.content?.[0]?.text ?? "";
}

beforeEach(() => {
  const wipe = db.transaction(() => {
    for (const table of [
      "memory_links",
      "relations",
      "entities",
      "memories",
      "search_index",
      "embeddings",
    ]) {
      db.prepare(`DELETE FROM ${table}`).run();
    }
  });
  wipe();
});

after(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`, { force: true });
    } catch {
      /* ignore */
    }
  }
});

test("P2: derived memory inherits untrusted label from its sources", () => {
  const stamp = Date.now();
  createMemory({
    type: "FACT",
    content: `trust propagation probe ${stamp} alpha`,
    metadata: { trusted: false },
  });
  createMemory({
    type: "FACT",
    content: `trust propagation probe ${stamp} beta`,
  });

  const text = textOf(
    consolidateHandler({ threshold: 0.5, minClusterSize: 2, derive: true })
  );
  assert.match(text, /derived memory id=\d+/);
  assert.match(text, /\[untrusted-import\]/);

  const derived = db
    .prepare("SELECT id, metadata FROM memories WHERE type = 'DERIVED'")
    .get();
  assert.ok(derived, "derived memory created");
  const meta = JSON.parse(derived.metadata);
  assert.equal(meta.trusted, false);
  assert.ok(Array.isArray(meta.derived_from) && meta.derived_from.length >= 2);
});

test("P2: derived memory from trusted-only sources stays unlabelled", () => {
  const stamp = Date.now();
  createMemory({
    type: "FACT",
    content: `trusted propagation probe ${stamp} alpha`,
  });
  createMemory({
    type: "FACT",
    content: `trusted propagation probe ${stamp} beta`,
  });

  const text = textOf(
    consolidateHandler({ threshold: 0.5, minClusterSize: 2, derive: true })
  );
  assert.match(text, /derived memory id=\d+/);
  assert.doesNotMatch(text, /derived memory id=\d+ \[untrusted-import\]/);

  const derived = db
    .prepare("SELECT metadata FROM memories WHERE type = 'DERIVED'")
    .get();
  assert.ok(derived, "derived memory created");
  if (derived.metadata) {
    const meta = JSON.parse(derived.metadata);
    assert.notEqual(meta.trusted, false);
  }
});
