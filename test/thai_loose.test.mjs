// TASK-THAI-LOOSE: tone-tolerant fallback channel (search_index_loose).
// The strict channel keeps tone marks significant (ติดตั้ง != ติดตัง). The loose
// channel stores the de-accented looseForm() of the same segmented payload, so
// a tone-mark typo (ติดตัง) can still surface a correctly-marked document —
// but always ranked BELOW strict hits. English-only queries must be unchanged
// (looseForm on ASCII is just a lowercase; FTS5 case-folds anyway).
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { test, after } from "node:test";
import assert from "node:assert/strict";

const dbPath = join(tmpdir(), `th-mem-thai-loose-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;
process.env.MEMORY_BACKUP_ON_MIGRATE = "0";

const {
  db,
  buildFtsMatch,
  buildLooseFtsMatch,
  syncSearchIndex,
} = await import("../dist/db/index.js");
const { ftsSearch } = await import("../dist/retrieval/fts.js");
const { createMemory } = await import("../dist/db/repositories/memories.js");
const { MIGRATIONS } = await import("../dist/db/migrations.js");

// ICU-based segmentation is optional; the linear fallback dictionary is best
// effort, so every Thai-dependent assertion skips when the runtime cannot
// segment (small-icu builds), exactly like thai_fts / thai_synonyms.
const skip = typeof Intl.Segmenter !== "function";

function strictIds(refTable, query) {
  return db
    .prepare(
      "SELECT ref_id FROM search_index WHERE ref_table = ? AND search_index MATCH ? ORDER BY rank"
    )
    .all(refTable, buildFtsMatch(query))
    .map((r) => Number(r.ref_id));
}

function looseIds(refTable, query) {
  return db
    .prepare(
      "SELECT ref_id FROM search_index_loose WHERE ref_table = ? AND search_index_loose MATCH ? ORDER BY rank"
    )
    .all(refTable, buildLooseFtsMatch(query))
    .map((r) => Number(r.ref_id));
}

after(() => {
  db.close();
  for (const s of ["", "-wal", "-shm"]) rmSync(`${dbPath}${s}`, { force: true });
});

// --- buildLooseFtsMatch pure shape ------------------------------------------

test("buildLooseFtsMatch: Thai de-accented phrase; ASCII mirrors strict shape", () => {
  // ติดตั้ง -> loose ติดตัง: a single ordered phrase, never OR-expanded.
  const thai = buildLooseFtsMatch("ติดตั้ง");
  assert.ok(thai.startsWith('"') && thai.endsWith('"'), `expected a phrase: ${thai}`);
  assert.ok(!thai.includes(" OR "), `Thai chunk must stay a single phrase: ${thai}`);
  assert.equal(thai.slice(1, -1).replace(/\s+/g, ""), "ติดตัง");

  // The tone typo collapses to the exact same loose phrase as the spelling.
  assert.equal(
    buildLooseFtsMatch("ติดตัง").slice(1, -1).replace(/\s+/g, ""),
    thai.slice(1, -1).replace(/\s+/g, "")
  );

  // Unknown ASCII tokens: identical shape to buildFtsMatch.
  assert.equal(buildLooseFtsMatch("pnpm npm"), '"pnpm" OR "npm"');

  // Known ASCII chunk: mirrors the strict synonym OR (ดีพลอย keeps its vowels).
  assert.equal(buildLooseFtsMatch("deploy"), '"deploy" OR "ดี พลอย"');

  // English casing: looseForm lowercases ASCII, unlike strict.
  assert.equal(buildLooseFtsMatch("Omise"), '"omise"');
  assert.equal(buildFtsMatch("Omise"), '"Omise"');
});

// --- strict channel stays exact (direct on search_index) --------------------

test("strict channel stays exact: ติดตั้ง never returns the ติดตัง doc; loose channel collides", { skip }, () => {
  const table = "loose_strict";
  syncSearchIndex(table, 1, "", "ผมต้องติดตั้งโปรแกรมบนเซิร์ฟเวอร์ใหม่");
  syncSearchIndex(table, 2, "", "ติดตังค่าบริการรายเดือน");

  // STRICT (authoritative): ติดตั้ง and ติดตัง stay distinct.
  assert.deepEqual(strictIds(table, "ติดตั้ง"), [1]);
  assert.deepEqual(strictIds(table, "ติดตัง"), [2]);

  // LOOSE: the whole point — ติดตั้ง and ติดตัง collide, so a mis-typed query
  // reaches the correctly-marked document (and vice-versa).
  assert.deepEqual(looseIds(table, "ติดตั้ง").sort(), [1, 2]);
  assert.deepEqual(looseIds(table, "ติดตัง").sort(), [1, 2]);
});

// --- through ftsSearch -------------------------------------------------------

test("ftsSearch: tone typo query surfaces the correctly-marked memory via loose", { skip }, () => {
  const correct = createMemory({
    type: "PREFERENCE",
    content: "ผมต้องติดตั้งโปรแกรมบนเซิร์ฟเวอร์ใหม่",
    source: "explicit",
    confidence: 0.9,
  });
  createMemory({
    type: "FACT",
    content: "แมวกินปลาในห้องครัว",
    source: "explicit",
    confidence: 0.8,
  });

  // Strict has nothing for ติดตัง (only ติดตัง exists nowhere in strict form),
  // so the loose channel must supply the correctly-marked memory.
  const res = ftsSearch("ติดตัง", { limit: 10 });
  const ids = res.map((r) => r.id);
  assert.ok(ids.includes(correct), `typo query should surface the ติดตั้ง memory: ${JSON.stringify(res)}`);
});

test("ftsSearch: strict hit ranks above a loose-only hit when both exist", { skip }, () => {
  const correct = createMemory({
    type: "PREFERENCE",
    content: "สคริปต์ติดตั้งโปรแกรมบนเซิร์ฟเวอร์",
    source: "explicit",
    confidence: 0.9,
  });
  const typoOnly = createMemory({
    type: "PREFERENCE",
    content: "ผมติดตังแอปพลิเคชันใหม่วันนี้",
    source: "explicit",
    confidence: 0.5,
  });

  // Query with the CORRECT spelling: strict hit (correct) + loose-only hit
  // (typoOnly, de-accented) must both appear, strict FIRST.
  const res = ftsSearch("ติดตั้ง", { limit: 10 });
  const ids = res.map((r) => r.id);
  const iCorrect = ids.indexOf(correct);
  const iTypo = ids.indexOf(typoOnly);
  assert.ok(iCorrect !== -1 && iTypo !== -1, `both must appear: ${JSON.stringify(res)}`);
  assert.ok(iCorrect < iTypo, `strict hit must rank first: ${JSON.stringify(res)}`);
});

test("English-only query: loose channel adds nothing to ftsSearch", () => {
  const en = createMemory({
    type: "PREFERENCE",
    content: "Use pnpm for Node projects",
    source: "explicit",
    confidence: 0.9,
  });
  createMemory({
    type: "FACT",
    content: "Boil water at 100C to cook pasta",
    source: "explicit",
    confidence: 0.8,
  });

  // Ground truth: the strict channel alone (memories scope).
  const strictOnly = db
    .prepare(
      "SELECT ref_id FROM search_index WHERE ref_table = 'memories' AND search_index MATCH ? ORDER BY rank"
    )
    .all(buildFtsMatch("pnpm"))
    .map((r) => Number(r.ref_id));

  const viaFts = ftsSearch("pnpm", { limit: 10 }).map((r) => r.id);
  assert.deepEqual(viaFts, strictOnly, "pure-ASCII query must not gain loose-only hits");
  assert.ok(viaFts.includes(en), `pnpm memory should rank: ${viaFts}`);
});

// --- migration 013 -----------------------------------------------------------

test("013_search_index_loose: idempotent, count-preserving, DDL preserved, non-Thai rows survive", { skip }, () => {
  const table = "loose_mig";
  syncSearchIndex(table, 1, "", "ติดตังค่าบริการรายเดือน");
  syncSearchIndex(table, 2, "", "The project uses SQLite with a hybrid engine");

  const migration = MIGRATIONS.find((m) => m.id === "013_search_index_loose");
  assert.ok(migration, "013_search_index_loose must be registered");

  const strictCount = db.prepare("SELECT COUNT(*) AS c FROM search_index").get().c;
  const looseCount = () => db.prepare("SELECT COUNT(*) AS c FROM search_index_loose").get().c;

  // Fresh DBs already ran 013 at open, so capture the base then re-run.
  const before = looseCount();
  assert.equal(before, strictCount, "loose table must mirror the strict row count");

  migration.up(db);
  assert.equal(looseCount(), before, "row count preserved on first run");

  // Non-Thai row survives the rebuild and still matches via the loose channel.
  assert.deepEqual(
    db
      .prepare(
        "SELECT ref_id FROM search_index_loose WHERE ref_table = ? AND search_index_loose MATCH ? ORDER BY rank"
      )
      .all(table, buildLooseFtsMatch("sqlite"))
      .map((r) => Number(r.ref_id)),
    [2]
  );

  // Strict channel unchanged after rebuild: ติดตัง doc is not a ติดตั้ง hit.
  assert.deepEqual(strictIds(table, "ติดตั้ง"), []);
  assert.deepEqual(looseIds(table, "ติดตั้ง"), [1]);

  migration.up(db);
  assert.equal(looseCount(), before, "row count preserved on second run (idempotent)");
  assert.equal(looseCount(), strictCount, "still mirrors the strict row count");

  // Loose table uses the same mark-aware tokenizer DDL.
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE name = 'search_index_loose'")
    .get();
  assert.ok(row && typeof row.sql === "string", "search_index_loose SQL not found");
  assert.match(row.sql, /categories/);
  assert.match(row.sql, /L\* N\* Co M\*/);
});
