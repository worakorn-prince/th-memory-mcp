// Ph-6 B6 — content ↔ embedding synchronisation regression.
//
// Every writer that changes a memory's content must leave
// `embeddings.vec` byte-for-byte equal to `serialize(embed(<current content>))`.
// The comparison is on the stored BLOB, read back from the DB, so a stale
// index (or an index built from the pre-redaction text) fails here even when
// the row itself looks right.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";

const workDir = mkdtempSync(join(tmpdir(), "th-p6-embedding-sync-"));
const dbPath = join(workDir, "embedding-sync.db");

process.env.MEMORY_DB_PATH = dbPath;
process.env.MEMORY_BACKUP_ON_MIGRATE = "0";
delete process.env.MEMORY_ENCRYPTION;
delete process.env.MEMORY_ENCRYPTION_KEY;
delete process.env.MEMORY_AUTH;
delete process.env.MEMORY_AUTH_TOKEN;
delete process.env.MEMORY_AUTH_TOKEN_FILE;

const { db, upsertEmbedding } = await import("../dist/db/index.js");
const { embed, serialize, EMBED_DIM } = await import("../dist/lib/embed.js");
const { createMemory, getMemoryById } = await import(
  "../dist/db/repositories/memories.js"
);
const { updateMemoryHandler } = await import("../dist/tools/update_memory.js");
const { mergeMemoryHandler } = await import("../dist/tools/merge_memory.js");
const { rememberHandler } = await import("../dist/tools/remember.js");
const { scrubHistoricalSecrets } = await import("../dist/tools/scrub.js");

const SECRET = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";

const textOf = (r) => (r?.content ?? []).map((c) => c.text).join("\n");

after(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  rmSync(workDir, { recursive: true, force: true });
});

function storedVec(refTable, refId) {
  const row = db
    .prepare("SELECT vec FROM embeddings WHERE ref_table = ? AND ref_id = ?")
    .get(refTable, refId);
  return row?.vec;
}

/** Assert the stored BLOB is exactly serialize(embed(text)) and nothing else. */
function assertEmbeddingIs(text, refTable, refId, label) {
  const blob = storedVec(refTable, refId);
  assert.ok(blob, `${label}: no embeddings row for ${refTable}/${refId}`);
  assert.equal(
    blob.length,
    EMBED_DIM * 4,
    `${label}: unexpected vector length ${blob.length}`
  );
  const expected = serialize(embed(text));
  assert.deepEqual(
    Buffer.from(blob),
    expected,
    `${label}: stored vec != serialize(embed(${JSON.stringify(text)}))`
  );
}

function assertNoDrift(label, refId) {
  const row = getMemoryById(refId);
  assert.ok(row, `${label}: memory ${refId} missing`);
  assertEmbeddingIs(row.content, "memories", row.id, label);
  return row;
}

// ------------------------------------------------------ 1. in-place update ---
test("B6.1 update_memory in place re-embeds the new content", () => {
  const id = createMemory({
    type: "FACT",
    content: "embedding sync original in place text",
  });
  assertNoDrift("before in-place update", id);
  const before = Buffer.from(storedVec("memories", id));

  const result = updateMemoryHandler({
    id,
    content: "embedding sync rewritten in place text",
    supersede: false,
  });
  assert.notEqual(result.isError, true, textOf(result));

  const row = assertNoDrift("after in-place update", id);
  assert.equal(row.content, "embedding sync rewritten in place text");
  assert.equal(row.status, "active", "in-place update keeps the row active");
  assert.equal(row.id, id, "in-place update reuses the row");
  assert.notDeepEqual(
    Buffer.from(storedVec("memories", id)),
    before,
    "the embedding must actually change with the content"
  );
});

// ---------------------------------------------------- 2. supersede (default) ---
test("B6.2 update_memory supersede re-embeds the new row and keeps the old one", () => {
  const id = createMemory({
    type: "FACT",
    content: "embedding sync old superseded body",
  });
  const oldBlob = Buffer.from(storedVec("memories", id));

  const result = updateMemoryHandler({
    id,
    content: "embedding sync newer superseding body",
  });
  assert.notEqual(result.isError, true, textOf(result));
  const match = /created superseding memory id=(\d+)/.exec(textOf(result));
  assert.ok(match, `supersede reported no new id: ${textOf(result)}`);
  const newId = Number(match[1]);
  assert.notEqual(newId, id);

  const fresh = assertNoDrift("after supersede", newId);
  assert.equal(fresh.content, "embedding sync newer superseding body");
  assert.equal(fresh.status, "active");

  const oldRow = getMemoryById(id);
  assert.equal(oldRow.status, "superseded", "the old row is superseded");
  assertEmbeddingIs(oldRow.content, "memories", id, "superseded row keeps its own vector");
  assert.deepEqual(
    Buffer.from(storedVec("memories", id)),
    oldBlob,
    "the superseded row's embedding must not be rewritten to the new content"
  );
  assert.notDeepEqual(
    Buffer.from(storedVec("memories", newId)),
    oldBlob,
    "the new row must not inherit the old vector"
  );
});

// ------------------------------------------------------------- 3. scrub ---
test("B6.3 scrub --apply re-embeds the redacted content", () => {
  const rawContent = `legacy captured ${SECRET} before redaction existed`;
  const now = new Date().toISOString();
  const id = Number(
    db
      .prepare(
        "INSERT INTO memories (type, content, status, source, created_at, updated_at) VALUES ('FACT', ?, 'active', 'explicit', ?, ?)"
      )
      .run(rawContent, now, now).lastInsertRowid
  );
  // The row was indexed from the unredacted text, exactly as a pre-redaction
  // writer would have left it.
  upsertEmbedding("memories", id, embed(rawContent));
  const staleBlob = Buffer.from(storedVec("memories", id));

  const report = scrubHistoricalSecrets(true);
  assert.equal(report.apply, true);
  assert.ok((report.changed.memories ?? 0) >= 1, "scrub reported the legacy row");

  const row = getMemoryById(id);
  assert.equal(row.content.includes(SECRET), false, `secret survived scrub: ${row.content}`);
  assertEmbeddingIs(row.content, "memories", id, "after scrub");
  assert.notDeepEqual(
    Buffer.from(storedVec("memories", id)),
    staleBlob,
    "scrub must replace the stale unredacted embedding"
  );
});

// ------------------------------------------------------- 4. merge_memory ---
test("B6.4 merge_memory keeps the canonical vector and supersedes the source", () => {
  const sourceId = createMemory({
    type: "FACT",
    content: "embedding sync merge source body",
  });
  const targetId = createMemory({
    type: "FACT",
    content: "embedding sync merge canonical body",
  });
  const targetBlob = Buffer.from(storedVec("memories", targetId));
  const sourceBlob = Buffer.from(storedVec("memories", sourceId));

  const result = mergeMemoryHandler({ sourceId, targetId });
  assert.notEqual(result.isError, true, textOf(result));

  const target = assertNoDrift("merge target", targetId);
  assert.equal(target.status, "active");
  assert.deepEqual(
    Buffer.from(storedVec("memories", targetId)),
    targetBlob,
    "merging must not desync the canonical row's vector"
  );

  const source = getMemoryById(sourceId);
  assert.equal(source.status, "superseded", "the merged-away row is superseded");
  assertEmbeddingIs(source.content, "memories", sourceId, "merged-away row");
  assert.deepEqual(
    Buffer.from(storedVec("memories", sourceId)),
    sourceBlob,
    "the merged-away row keeps its own vector"
  );
});

// ------------------------------------------------- 5. remember re-save ---
test("B6.5 remember re-save (confidence bump) keeps the preference vector in sync", async () => {
  const category = "coding_pref";
  const key = "embedding_sync_pkg_manager";

  const first = await rememberHandler({ category, key, value: "pnpm" });
  assert.notEqual(first.isError, true, textOf(first));
  const prefId = Number(/preference id=(\d+)/.exec(textOf(first))[1]);
  const firstConfidence = Number(/confidence=([\d.]+)/.exec(textOf(first))[1]);

  const prefText = (row) => `${row.category} ${row.key} ${row.value}`;
  const readPref = () =>
    db.prepare("SELECT id, category, key, value, confidence FROM preferences WHERE id = ?").get(prefId);

  assertEmbeddingIs(prefText(readPref()), "preferences", prefId, "first remember");

  // Re-save with a secret: the stored value is redacted, so the vector must be
  // rebuilt from the redacted value rather than the raw one.
  const second = await rememberHandler({
    category,
    key,
    value: `npm ${SECRET}`,
  });
  assert.notEqual(second.isError, true, textOf(second));
  const secondConfidence = Number(/confidence=([\d.]+)/.exec(textOf(second))[1]);
  assert.ok(
    secondConfidence > firstConfidence,
    `re-save must bump confidence (${firstConfidence} -> ${secondConfidence})`
  );

  const row = readPref();
  assert.equal(row.id, prefId, "re-save updates the same preference row");
  assert.equal(row.value.includes(SECRET), false, `raw secret stored: ${row.value}`);
  assertEmbeddingIs(prefText(row), "preferences", prefId, "re-saved preference");
});
