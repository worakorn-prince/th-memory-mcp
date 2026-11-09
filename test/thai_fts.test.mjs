// Thai-aware FTS5: word segmentation + mark-aware tokenizer.
// Asserts against search_index directly so the vector blend in
// recall/get_context cannot mask an FTS regression.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { test, after } from "node:test";
import assert from "node:assert/strict";

const dbPath = join(tmpdir(), `th-mem-thai-fts-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;
process.env.MEMORY_BACKUP_ON_MIGRATE = "0";

const { db, buildFtsMatch, syncSearchIndex } = await import("../dist/db/index.js");
const { segmentForIndex } = await import("../dist/lib/thai-segment.js");
const { MIGRATIONS } = await import("../dist/db/migrations.js");

// ICU-based segmentation is optional; every Thai assertion skips when the
// runtime has no Intl.Segmenter (small-icu builds).
const skip = typeof Intl.Segmenter !== "function";

function ftsIds(query, refTable) {
  return db
    .prepare(
      "SELECT ref_id FROM search_index WHERE ref_table = ? AND search_index MATCH ? ORDER BY rank"
    )
    .all(refTable, buildFtsMatch(query))
    .map((r) => Number(r.ref_id));
}

after(() => {
  db.close();
  for (const s of ["", "-wal", "-shm"]) rmSync(`${dbPath}${s}`, { force: true });
});

test("segmentForIndex splits unspaced Thai, leaves non-Thai alone, is byte-idempotent", { skip }, () => {
  const clause = "ผมต้องติดตั้งโปรแกรมบนเซิร์ฟเวอร์ใหม่ทุกวันศุกร์";
  const once = segmentForIndex(clause);
  const words = once.trim().split(/\s+/).filter(Boolean);
  assert.ok(words.length > 1, `expected several words, got: ${once}`);
  assert.equal(words.join(""), clause, "segmentation must not drop characters");
  assert.equal(segmentForIndex("use 2-space indent"), "use 2-space indent");
  assert.equal(segmentForIndex(once), once, "segmentForIndex must be byte-idempotent");
});

test("buildFtsMatch: Thai chunk -> ordered phrase; non-Thai chunk unchanged", { skip }, () => {
  const thai = buildFtsMatch("ติดตั้ง");
  assert.ok(thai.startsWith('"') && thai.endsWith('"'), `expected a phrase: ${thai}`);
  assert.equal(thai.slice(1, -1).replace(/\s+/g, ""), "ติดตั้ง");

  assert.equal(buildFtsMatch("pnpm npm"), '"pnpm" OR "npm"');

  const mixed = buildFtsMatch("ใช้pnpm");
  assert.ok(mixed.includes("ใช้"), `expected ใช้ in: ${mixed}`);
  assert.ok(mixed.includes("pnpm"), `expected pnpm in: ${mixed}`);

  // Escaping stays intact for non-Thai chunks.
  assert.equal(buildFtsMatch('a"b'), '"a""b"');
  assert.equal(buildFtsMatch("a\\b"), '"a\\\\b"');
});

test("Thai words inside unspaced clauses are found via FTS5", { skip }, () => {
  const table = "thai_words";
  const docs = [
    "ผมต้องติดตั้งโปรแกรมบนเซิร์ฟเวอร์ใหม่ทุกวันศุกร์",
    "ร้านนี้ข้าวผัดอร่อยมาก",
    "ระบบชำระเงินต้องรองรับพร้อมเพย์",
    "ห้ามดีพลอยวันศุกร์หลังบ่ายสามโมง",
    "ใช้ pnpm และ Omise",
  ];
  docs.forEach((d, i) => syncSearchIndex(table, i + 1, "", d));

  const cases = [
    ["ติดตั้ง", [1]],
    ["ข้าวผัด", [2]],
    ["พร้อมเพย์", [3]],
    ["ดีพลอยวันศุกร์", [4]],
    ["pnpm", [5]],
    ["Omise", [5]],
    ["แมวกินปลา", []],
  ];
  for (const [q, expected] of cases) {
    assert.deepEqual(ftsIds(q, table), expected, `query ${q}`);
  }
});

test("mark precision: tone marks are significant, no consonant-skeleton collisions", { skip }, () => {
  const table = "thai_marks";
  syncSearchIndex(table, 1, "", "ผมต้องติดตั้งโปรแกรมบนเซิร์ฟเวอร์ใหม่");
  syncSearchIndex(table, 2, "", "ติดตังค่าบริการรายเดือน");
  syncSearchIndex(table, 3, "", "ร้านนี้ข้าวผัดอร่อยมาก");
  syncSearchIndex(table, 4, "", "นั่งพักผ่อนหลังอาหารกลางวัน");
  syncSearchIndex(table, 5, "", "ดื้อมากและไม่ยอมฟังใคร");

  // The misspelled query must not surface the correctly spelled document.
  assert.deepEqual(ftsIds("ติดตั้ง", table), [1]);
  assert.deepEqual(ftsIds("ติดตัง", table), [2]);

  // Marks-only variants that were never indexed return nothing.
  assert.deepEqual(ftsIds("ขาวผัด", table), []);
  assert.deepEqual(ftsIds("นัง", table), []);
  assert.deepEqual(ftsIds("ดือ", table), []);

  // The correctly marked forms still match.
  assert.deepEqual(ftsIds("ข้าวผัด", table), [3]);
  assert.deepEqual(ftsIds("นั่ง", table), [4]);
  assert.deepEqual(ftsIds("ดื้อ", table), [5]);
});

test("ranking: correct ติดตั้ง document outranks consonant-skeleton-only text", { skip }, () => {
  const table = "thai_rank";
  syncSearchIndex(table, 1, "", "ติดตังค่าบริการรายเดือน");
  syncSearchIndex(table, 2, "", "ต้องติดตั้งโปรแกรมใหม่บนเซิร์ฟเวอร์");
  syncSearchIndex(table, 3, "", "ติดตัง");

  const ids = ftsIds("ติดตั้ง", table);
  assert.equal(ids[0], 2, `expected the correctly marked document first, got ${ids}`);
  assert.ok(!ids.includes(1), "skeleton-only document must not match");
  assert.ok(!ids.includes(3), "skeleton-only document must not match");
});

test("010_search_index_thai rebuilds legacy rows, is idempotent, keeps row count", { skip }, () => {
  const table = "thai_mig";
  const raw = "ไม่กินเผ็ดและแพ้อาหารทะเล";
  db.prepare(
    "INSERT INTO search_index (ref_table, ref_id, title, body) VALUES (?, ?, ?, ?)"
  ).run(table, 99, "", raw);

  assert.deepEqual(ftsIds("แพ้อาหาร", table), [], "legacy unsegmented row should not match");

  // A non-Thai row must survive the rebuild untouched.
  const enTable = "thai_mig_en";
  syncSearchIndex(enTable, 7, "", "The project uses SQLite with a hybrid retrieval engine");
  assert.deepEqual(ftsIds("sqlite", enTable), [7], "non-Thai row must match before rebuild");

  const migration = MIGRATIONS.find((m) => m.id === "010_search_index_thai");
  assert.ok(migration, "010_search_index_thai must be registered");

  const countBefore = db.prepare("SELECT COUNT(*) AS c FROM search_index").get().c;
  migration.up(db);
  const countAfter = db.prepare("SELECT COUNT(*) AS c FROM search_index").get().c;
  assert.equal(countAfter, countBefore, "rebuild must not duplicate rows");
  assert.deepEqual(ftsIds("แพ้อาหาร", table), [99]);
  assert.deepEqual(ftsIds("sqlite", enTable), [7], "non-Thai row must survive the rebuild");

  const rowsForRow = () =>
    db
      .prepare("SELECT COUNT(*) AS c FROM search_index WHERE ref_table = ? AND ref_id = 99")
      .get(table).c;
  assert.equal(rowsForRow(), 1);

  migration.up(db);
  assert.deepEqual(ftsIds("แพ้อาหาร", table), [99], "second run must yield identical results");
  assert.equal(rowsForRow(), 1, "second run must not duplicate rows");
});

test("schema guard: search_index keeps the mark-aware tokenizer", () => {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE name = 'search_index'")
    .get();
  assert.ok(row && typeof row.sql === "string", "search_index SQL not found");
  assert.match(row.sql, /categories/);
  assert.match(row.sql, /L\* N\* Co M\*/);
});
