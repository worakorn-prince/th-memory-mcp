// TASK-PERF-WRITE: the search_index_keys side table turns the write path from
// an O(n) scan-delete over the FTS tables into an O(1) rowid update/delete.
// These tests pin the mapping contract: one row per channel, rowid identity
// preserved on update, full cleanup on remove, idempotent re-sync, self-heal
// for a stale mapping, and the M015 backfill on a pre-existing database.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { test, after } from "node:test";
import assert from "node:assert/strict";

const dbPath = join(tmpdir(), `th-mem-index-keys-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;
process.env.MEMORY_BACKUP_ON_MIGRATE = "0";

const {
  db,
  syncSearchIndex,
  removeSearchIndex,
  buildFtsMatch,
  buildLooseFtsMatch,
} = await import("../dist/db/index.js");
const { createMemory } = await import("../dist/db/repositories/memories.js");
const { ftsSearch } = await import("../dist/retrieval/fts.js");
const { MIGRATIONS, runMigrations } = await import("../dist/db/migrations.js");
const { looseForm } = await import("../dist/lib/thai-segment.js");

// ICU-based segmentation is optional; Thai assertions skip when the runtime
// cannot segment (small-icu builds), exactly like thai_fts / thai_loose.
const skip = typeof Intl.Segmenter !== "function";

const strictIds = (refTable, query) =>
  db
    .prepare(
      "SELECT ref_id FROM search_index WHERE ref_table = ? AND search_index MATCH ? ORDER BY rank"
    )
    .all(refTable, buildFtsMatch(query))
    .map((r) => Number(r.ref_id));

const looseIds = (refTable, query) =>
  db
    .prepare(
      "SELECT ref_id FROM search_index_loose WHERE ref_table = ? AND search_index_loose MATCH ? ORDER BY rank"
    )
    .all(refTable, buildLooseFtsMatch(query))
    .map((r) => Number(r.ref_id));

const strictCount = (refTable, refId) =>
  Number(
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM search_index WHERE ref_table = ? AND ref_id = ?"
      )
      .get(refTable, refId).c
  );

const looseCount = (refTable, refId) =>
  Number(
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM search_index_loose WHERE ref_table = ? AND ref_id = ?"
      )
      .get(refTable, refId).c
  );

const strictRowid = (refTable, refId) =>
  Number(
    db
      .prepare(
        "SELECT rowid AS rid FROM search_index WHERE ref_table = ? AND ref_id = ?"
      )
      .get(refTable, refId).rid
  );

const looseRowid = (refTable, refId) =>
  Number(
    db
      .prepare(
        "SELECT rowid AS rid FROM search_index_loose WHERE ref_table = ? AND ref_id = ?"
      )
      .get(refTable, refId).rid
  );

const keyRow = (refTable, refId) =>
  db
    .prepare(
      "SELECT strict_rowid, loose_rowid FROM search_index_keys WHERE ref_table = ? AND ref_id = ?"
    )
    .get(refTable, refId);

const insertStrict = db.prepare(
  "INSERT INTO search_index (ref_table, ref_id, title, body) VALUES (?, ?, ?, ?)"
);
const insertLoose = db.prepare(
  "INSERT INTO search_index_loose (ref_table, ref_id, title, body) VALUES (?, ?, ?, ?)"
);

// Simulate a pre-M015 database: mapping rows gone + migration marked pending.
function invalidateKeysMigration() {
  db.prepare("DELETE FROM schema_meta WHERE key = '015_search_index_keys'").run();
}

const M015 = MIGRATIONS.find((m) => m.id === "015_search_index_keys");

after(() => {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    rmSync(`${dbPath}${suffix}`, { force: true });
  }
});

// --- registration / schema ------------------------------------------------

test("M015_search_index_keys is registered and creates the side table", () => {
  assert.ok(M015, "015_search_index_keys must be registered in MIGRATIONS");
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE name = 'search_index_keys'")
    .get();
  assert.ok(row, "search_index_keys table must exist");
  assert.match(row.sql, /PRIMARY KEY \(ref_table, ref_id\)/);
  assert.doesNotMatch(row.sql, /WITHOUT ROWID/, "plain rowid table");
});

// --- create ---------------------------------------------------------------

test("createMemory: searchable, one FTS row per channel, mapping matches", () => {
  const id = createMemory({
    type: "FACT",
    content: "the deployment pipeline uses sqlite wal mode",
    source: "explicit",
    confidence: 0.9,
  });

  const ids = ftsSearch("deployment", { limit: 10 }).map((r) => r.id);
  assert.ok(ids.includes(id), `recall should find the memory: ${JSON.stringify(ids)}`);

  assert.equal(strictCount("memories", id), 1, "exactly one strict row");
  assert.equal(looseCount("memories", id), 1, "exactly one loose row");

  const key = keyRow("memories", id);
  assert.ok(key, "a mapping row must be written");
  assert.equal(Number(key.strict_rowid), strictRowid("memories", id));
  assert.equal(Number(key.loose_rowid), looseRowid("memories", id));
});

// --- update ---------------------------------------------------------------

test("syncSearchIndex update: old text gone, new text matches, rowid stable", () => {
  const table = "keys_update";
  syncSearchIndex(table, 1, "", "alpha bravo");
  const before = {
    strict: strictRowid(table, 1),
    loose: looseRowid(table, 1),
  };
  assert.deepEqual(strictIds(table, "alpha"), [1]);

  syncSearchIndex(table, 1, "", "charlie delta");

  assert.deepEqual(strictIds(table, "alpha"), [], "old body must stop matching");
  assert.deepEqual(strictIds(table, "charlie"), [1], "new body must match");
  assert.deepEqual(looseIds(table, "charlie"), [1], "loose channel follows");

  assert.equal(strictCount(table, 1), 1);
  assert.equal(looseCount(table, 1), 1);

  // The update path is an UPDATE by rowid: the rowid (and therefore the
  // mapping) is stable, no delete+insert churn.
  assert.equal(strictRowid(table, 1), before.strict);
  assert.equal(looseRowid(table, 1), before.loose);
  assert.equal(Number(keyRow(table, 1).strict_rowid), before.strict);
  assert.equal(Number(keyRow(table, 1).loose_rowid), before.loose);
});

// --- repeated sync --------------------------------------------------------

test("repeated syncSearchIndex of the same ref is idempotent", () => {
  const table = "keys_idempotent";
  syncSearchIndex(table, 1, "", "same body every time");
  const rowids = {
    strict: strictRowid(table, 1),
    loose: looseRowid(table, 1),
  };

  for (let i = 0; i < 3; i++) syncSearchIndex(table, 1, "", "same body every time");

  assert.equal(strictCount(table, 1), 1);
  assert.equal(looseCount(table, 1), 1);
  assert.equal(strictRowid(table, 1), rowids.strict);
  assert.equal(looseRowid(table, 1), rowids.loose);
  assert.equal(
    Number(
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM search_index_keys WHERE ref_table = ? AND ref_id = ?"
        )
        .get(table, 1).c
    ),
    1,
    "no duplicate mapping row"
  );
});

// --- remove ---------------------------------------------------------------

test("removeSearchIndex: keyed rows and the mapping are all deleted", () => {
  const table = "keys_remove";
  syncSearchIndex(table, 1, "", "remove me please");
  syncSearchIndex(table, 2, "", "keep me please");

  removeSearchIndex(table, 1);

  assert.equal(strictCount(table, 1), 0);
  assert.equal(looseCount(table, 1), 0);
  assert.equal(keyRow(table, 1), undefined, "mapping must be deleted");

  // The neighbouring ref is untouched.
  assert.equal(strictCount(table, 2), 1);
  assert.equal(looseCount(table, 2), 1);
  assert.ok(keyRow(table, 2));
});

test("removeSearchIndex: legacy rows without a mapping still get scan-deleted", () => {
  const table = "keys_remove_legacy";
  insertStrict.run(table, 7, "", "legacy row without a mapping");
  insertLoose.run(table, 7, "", "legacy row without a mapping");
  assert.equal(keyRow(table, 7), undefined);

  removeSearchIndex(table, 7);

  assert.equal(strictCount(table, 7), 0);
  assert.equal(looseCount(table, 7), 0);
});

test("remove then sync again writes a fresh row and exactly one key row", () => {
  const table = "keys_remove_resync";
  syncSearchIndex(table, 1, "", "first pass");
  removeSearchIndex(table, 1);
  assert.equal(strictCount(table, 1), 0);
  assert.equal(keyRow(table, 1), undefined);

  syncSearchIndex(table, 1, "", "second pass");

  assert.equal(strictCount(table, 1), 1);
  assert.equal(looseCount(table, 1), 1);
  assert.equal(
    Number(
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM search_index_keys WHERE ref_table = ? AND ref_id = ?"
        )
        .get(table, 1).c
    ),
    1,
    "exactly one mapping row after the re-create"
  );
  assert.equal(Number(keyRow(table, 1).strict_rowid), strictRowid(table, 1));
  assert.deepEqual(strictIds(table, "second"), [1]);
  assert.deepEqual(strictIds(table, "first"), [], "the removed text is gone");
});

test("removeSearchIndex: a stale mapping never deletes another ref's row (S1)", () => {
  const table = "keys_remove_own";
  syncSearchIndex(table, 1, "", "owner one keeps this row");
  syncSearchIndex(table, 2, "", "owner two keeps this row");
  const foreignStrict = strictRowid(table, 1);
  const foreignLoose = looseRowid(table, 2);

  // Corrupt mapping: ref 3 points at rows that belong to refs 1 and 2.
  db.prepare(
    "INSERT INTO search_index_keys (ref_table, ref_id, strict_rowid, loose_rowid) VALUES (?, ?, ?, ?)"
  ).run(table, 3, foreignStrict, foreignLoose);

  removeSearchIndex(table, 3);

  assert.equal(strictCount(table, 1), 1, "ref 1's strict row must survive");
  assert.equal(looseCount(table, 2), 1, "ref 2's loose row must survive");
  assert.equal(Number(keyRow(table, 1).strict_rowid), foreignStrict);
  assert.equal(keyRow(table, 3), undefined, "the bogus mapping is removed");
  assert.deepEqual(strictIds(table, "owner").sort(), [1, 2]);
});

// --- self-heal ------------------------------------------------------------

test("self-heal: a stale mapping whose FTS row vanished is repointed", () => {
  const table = "keys_heal";
  syncSearchIndex(table, 1, "", "self heal me");
  const stale = keyRow(table, 1);

  // Corrupt the mapping behind our back: the FTS row is gone, the key row is
  // not. The UPDATE path reports 0 changes and must re-insert + repoint.
  db.prepare("DELETE FROM search_index WHERE rowid = ?").run(
    Number(stale.strict_rowid)
  );

  syncSearchIndex(table, 1, "", "self heal me");

  assert.equal(strictCount(table, 1), 1, "exactly one strict row");
  assert.equal(looseCount(table, 1), 1, "exactly one loose row");
  const healed = keyRow(table, 1);
  assert.equal(Number(healed.strict_rowid), strictRowid(table, 1));
  assert.equal(Number(healed.loose_rowid), looseRowid(table, 1));
  assert.deepEqual(strictIds(table, "heal"), [1]);
});

test("self-heal: a vanished loose row is re-inserted while strict updates in place", () => {
  const table = "keys_heal_loose";
  syncSearchIndex(table, 1, "", "mirror heal me");
  const key = keyRow(table, 1);
  const strictBefore = Number(key.strict_rowid);

  // Only the loose half is missing: the strict UPDATE succeeds, the loose
  // UPDATE reports 0 changes, so only the loose row is (re)inserted.
  db.prepare("DELETE FROM search_index_loose WHERE rowid = ?").run(
    Number(key.loose_rowid)
  );

  syncSearchIndex(table, 1, "", "mirror heal me");

  const healed = keyRow(table, 1);
  assert.equal(Number(healed.strict_rowid), strictBefore, "strict row updated in place");
  assert.equal(strictCount(table, 1), 1);
  assert.equal(looseCount(table, 1), 1);
  assert.equal(Number(healed.loose_rowid), looseRowid(table, 1));
  assert.deepEqual(looseIds(table, "mirror"), [1]);
});

test("missing mapping: sync recreates it and the ref stays searchable", () => {
  const table = "keys_heal_mapping";
  syncSearchIndex(table, 1, "", "mapping lost but row stays");

  // Only the mapping row is deleted. The no-key path is deliberately scan-free
  // (a scan there would put the O(n) cost back on every brand-new insert), so
  // it writes fresh rows and restores the mapping. The pre-existing rows stay
  // behind as UNMAPPED orphans: nothing deletes them at write time, and
  // removeSearchIndex's legacy scan only runs when a ref has no mapping at all.
  // The repair path is a backfill (M015) re-run, which dedupes by MAX(rowid) —
  // exercised at the end of this test.
  db.prepare("DELETE FROM search_index_keys WHERE ref_table = ? AND ref_id = ?").run(
    table,
    1
  );
  assert.equal(keyRow(table, 1), undefined);

  syncSearchIndex(table, 1, "", "mapping lost but row stays");

  const key = keyRow(table, 1);
  assert.ok(key, "mapping must be restored");
  const mappedStrict = db
    .prepare("SELECT ref_id FROM search_index WHERE rowid = ?")
    .get(Number(key.strict_rowid));
  const mappedLoose = db
    .prepare("SELECT ref_id FROM search_index_loose WHERE rowid = ?")
    .get(Number(key.loose_rowid));
  assert.equal(Number(mappedStrict.ref_id), 1, "mapping points at a live strict row");
  assert.equal(Number(mappedLoose.ref_id), 1, "mapping points at a live loose row");
  assert.ok(strictIds(table, "mapping").includes(1));
  assert.equal(strictCount(table, 1), 2, "the orphan row is still there");

  // The backfill repairs it: MAX(rowid) wins, the orphan is deleted.
  M015.up(db);
  assert.equal(strictCount(table, 1), 1);
  assert.equal(looseCount(table, 1), 1);
  assert.equal(Number(keyRow(table, 1).strict_rowid), strictRowid(table, 1));
});

// --- M015 backfill --------------------------------------------------------

test("M015 backfills a pre-existing DB, recreates the table, stays idempotent", () => {
  const table = "mig_backfill";
  insertStrict.run(table, 1, "", "legacy alpha bravo");
  insertLoose.run(table, 1, "", "legacy alpha bravo");
  insertStrict.run(table, 2, "", "legacy charlie delta");
  insertLoose.run(table, 2, "", "legacy charlie delta");
  invalidateKeysMigration();
  db.exec("DROP TABLE IF EXISTS search_index_keys");

  runMigrations(db);

  assert.ok(
    db.prepare("SELECT sql FROM sqlite_master WHERE name = 'search_index_keys'").get(),
    "the migration must recreate the table"
  );
  for (const refId of [1, 2]) {
    const key = keyRow(table, refId);
    assert.ok(key, `mapping for ref ${refId} must be backfilled`);
    assert.equal(strictCount(table, refId), 1, "exactly one strict row before comparing");
    assert.equal(looseCount(table, refId), 1, "exactly one loose row before comparing");
    assert.equal(Number(key.strict_rowid), strictRowid(table, refId));
    assert.equal(Number(key.loose_rowid), looseRowid(table, refId));
  }

  // Search behaviour is unchanged after the backfill.
  assert.deepEqual(strictIds(table, "alpha"), [1]);
  assert.deepEqual(strictIds(table, "delta"), [2]);

  // Idempotent: a second run keeps the mappings and the row counts.
  M015.up(db);
  assert.equal(strictCount(table, 1), 1);
  assert.equal(looseCount(table, 1), 1);
  assert.equal(Number(keyRow(table, 1).strict_rowid), strictRowid(table, 1));
});

test("M015 repairs orphans and duplicates without re-segmenting stored text", () => {
  const table = "mig_repair";

  // strict-only ref -> a loose row is built from the strict row's own text.
  insertStrict.run(table, 1, "", "strict only body");
  // duplicates -> keep MAX(rowid), delete the rest, text untouched.
  insertStrict.run(table, 2, "", "dup one");
  insertStrict.run(table, 2, "", "dup two");
  insertLoose.run(table, 2, "", "dup one");
  insertLoose.run(table, 2, "", "dup two");
  // loose-only ref -> dropped as an orphan.
  insertLoose.run(table, 3, "", "orphan loose");

  invalidateKeysMigration();
  runMigrations(db);

  const strictText = db
    .prepare(
      "SELECT title, body FROM search_index WHERE ref_table = ? AND ref_id = ?"
    )
    .get(table, 1);
  const looseText = db
    .prepare(
      "SELECT title, body FROM search_index_loose WHERE ref_table = ? AND ref_id = ?"
    )
    .get(table, 1);
  assert.equal(strictText.body, "strict only body", "strict text is untouched");
  assert.equal(looseText.body, looseForm(strictText.body));
  assert.equal(strictCount(table, 1), 1);
  assert.equal(looseCount(table, 1), 1);

  assert.equal(strictCount(table, 2), 1, "duplicates deduped");
  assert.equal(looseCount(table, 2), 1, "loose duplicates deduped");
  assert.equal(
    db
      .prepare("SELECT body FROM search_index WHERE ref_table = ? AND ref_id = ?")
      .get(table, 2).body,
    "dup two",
    "MAX(rowid) wins and its text is not rewritten"
  );

  assert.equal(looseCount(table, 3), 0, "loose-only orphan deleted");
  assert.equal(keyRow(table, 3), undefined);

  // Both surviving refs are mapped and searchable.
  assert.deepEqual(strictIds(table, "strict"), [1]);
  assert.deepEqual(strictIds(table, "dup"), [2]);
  assert.ok(keyRow(table, 1));
  assert.ok(keyRow(table, 2));
});

test("M015 recomputes: stale mapping rows leave no orphan keys (S2)", () => {
  const table = "mig_stale_keys";
  syncSearchIndex(table, 1, "", "stays alive");
  syncSearchIndex(table, 2, "", "will vanish behind the back");
  const stale = keyRow(table, 2);

  // FTS rows gone, key row left behind; plus a key that never had any FTS row.
  db.prepare("DELETE FROM search_index WHERE rowid = ?").run(
    Number(stale.strict_rowid)
  );
  db.prepare("DELETE FROM search_index_loose WHERE rowid = ?").run(
    Number(stale.loose_rowid)
  );
  db.prepare(
    "INSERT INTO search_index_keys (ref_table, ref_id, strict_rowid, loose_rowid) VALUES (?, ?, ?, ?)"
  ).run(table, 3, 999999, 999999);

  M015.up(db);

  assert.ok(keyRow(table, 1), "a live ref keeps its mapping");
  assert.equal(keyRow(table, 2), undefined, "stale mapping dropped, not merged");
  assert.equal(keyRow(table, 3), undefined, "key with no FTS row dropped");
  const keys = db
    .prepare("SELECT COUNT(*) AS c FROM search_index_keys WHERE ref_table = ?")
    .get(table).c;
  assert.equal(Number(keys), 1);
  assert.deepEqual(strictIds(table, "alive"), [1]);
});

test("M015 rewrites a loose row from the paired strict row when generations differ", () => {
  const table = "mig_generation";
  insertStrict.run(table, 1, "", "ติดตั้งระบบใหม่");
  // Loose half from an older generation: same ref, stale text.
  insertLoose.run(table, 1, "", "เนื้อหาเก่าคนละรุ่น");

  M015.up(db);

  const strictText = db
    .prepare("SELECT title, body FROM search_index WHERE ref_table = ? AND ref_id = ?")
    .get(table, 1);
  const looseText = db
    .prepare(
      "SELECT title, body FROM search_index_loose WHERE ref_table = ? AND ref_id = ?"
    )
    .get(table, 1);
  assert.equal(strictText.body, "ติดตั้งระบบใหม่", "strict text is never rewritten");
  assert.equal(looseText.body, looseForm(strictText.body));
  assert.equal(strictCount(table, 1), 1);
  assert.equal(looseCount(table, 1), 1);
  assert.ok(keyRow(table, 1));
});

// --- loose channel regression guard ---------------------------------------

test("loose channel still matches a tone-typo query after an update", { skip }, () => {
  const table = "keys_loose_update";
  syncSearchIndex(table, 1, "", "ผมต้องติดตั้งโปรแกรมบนเซิร์ฟเวอร์ใหม่");
  // Update through the rowid path; the loose twin must be re-written too.
  syncSearchIndex(table, 1, "", "ต้องติดตั้งระบบใหม่บนเซิร์ฟเวอร์หลัก");

  assert.deepEqual(looseIds(table, "ติดตัง"), [1]);
  assert.equal(strictCount(table, 1), 1);
  assert.equal(looseCount(table, 1), 1);
});
