// TASK-THAI-SYN: curated transliteration synonyms TH<->EN at index + query.
// Precision first: synonyms only ADD equivalent terms; the strict Thai channel
// keeps tone-mark exactness (ติดตั้ง != ติดตัง).
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { test, after } from "node:test";
import assert from "node:assert/strict";

const dbPath = join(tmpdir(), `th-mem-thai-syn-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;
process.env.MEMORY_BACKUP_ON_MIGRATE = "0";

const { db, buildFtsMatch, syncSearchIndex } = await import("../dist/db/index.js");
const { segmentForIndex } = await import("../dist/lib/thai-segment.js");
const {
  THAI_SYNONYMS,
  expandSynonyms,
  expandChunkSynonyms,
  expandIndexedText,
} = await import("../dist/lib/thai-synonyms.js");
const { MIGRATIONS } = await import("../dist/db/migrations.js");

const skip = typeof Intl.Segmenter !== "function";

function ftsIds(query, refTable) {
  return db
    .prepare(
      "SELECT ref_id FROM search_index WHERE ref_table = ? AND search_index MATCH ? ORDER BY rank"
    )
    .all(refTable, buildFtsMatch(query))
    .map((r) => Number(r.ref_id));
}

function storedBody(refTable, refId) {
  const row = db
    .prepare(
      "SELECT body FROM search_index WHERE ref_table = ? AND ref_id = ?"
    )
    .get(refTable, refId);
  return row ? String(row.body) : "";
}

after(() => {
  db.close();
  for (const s of ["", "-wal", "-shm"]) rmSync(`${dbPath}${s}`, { force: true });
});

// --- pure synonym API -------------------------------------------------------

test("THAI_SYNONYMS: curated size and bidirectional shape", () => {
  assert.ok(
    Array.isArray(THAI_SYNONYMS) && THAI_SYNONYMS.length >= 15 && THAI_SYNONYMS.length <= 25,
    `expected 15-25 curated pairs, got ${THAI_SYNONYMS.length}`
  );
  for (const [en, th] of THAI_SYNONYMS) {
    assert.ok(/^[a-z0-9-]+$/.test(en), `EN key should be a plain token: ${en}`);
    assert.ok(/[\u0E00-\u0E7F]/.test(th), `TH value should contain Thai: ${th}`);
  }
  const enKeys = new Set(THAI_SYNONYMS.map(([en]) => en));
  assert.ok(enKeys.has("deploy") && enKeys.has("install") && enKeys.has("memory"));
  assert.ok(!enKeys.has("the") && !enKeys.has("use") && !enKeys.has("run"), "hyper-common ambiguous words excluded");
});

test("expandSynonyms: TH->EN and EN->TH, lowercase, unknown passes through", () => {
  assert.deepEqual(expandSynonyms("ดีพลอย"), ["ดีพลอย", "deploy"]);
  assert.deepEqual(expandSynonyms("deploy"), ["deploy", "ดีพลอย"]);
  assert.deepEqual(expandSynonyms("ติดตั้ง"), ["ติดตั้ง", "install"]);
  assert.deepEqual(expandSynonyms("install"), ["install", "ติดตั้ง"]);
  // multi-variant dedup for repository
  assert.deepEqual(expandSynonyms("repository"), ["repository", "รีโพสิทอรี", "รีโพ"]);
  // one-to-many on the TH side
  assert.deepEqual(expandSynonyms("memory"), ["memory", "ความจำ", "หน่วยความจำ"]);
  // unknown term returns just itself
  assert.deepEqual(expandSynonyms("zzz"), ["zzz"]);
  assert.deepEqual(expandSynonyms(""), [""]);
  // uppercase input is lowercased in the output
  assert.deepEqual(expandSynonyms("DEPLOY"), ["deploy", "ดีพลอย"]);
  // dynamic extra pairs are merged (the LEARN seam)
  assert.deepEqual(
    expandSynonyms("rollout", [["rollout", "โรลเอาต์"]]),
    ["rollout", "โรลเอาต์"]
  );
});

test("expandChunkSynonyms: chunk verbatim + variants; unknown stays just the chunk", () => {
  assert.deepEqual(expandChunkSynonyms("deploy"), ["deploy", "ดีพลอย"]);
  assert.deepEqual(expandChunkSynonyms("ดีพลอย"), ["ดีพลอย", "deploy"]);
  assert.deepEqual(expandChunkSynonyms("zzz"), ["zzz"]);
  // the chunk keeps its original case; variants are lowercased
  assert.deepEqual(expandChunkSynonyms("DEPLOY"), ["DEPLOY", "ดีพลอย"]);
});

// --- index-side expansion ---------------------------------------------------

test("expandIndexedText: appends counterparts, no drift on unknown text", { skip }, () => {
  // English known term -> TH counterpart appended (segmented form).
  const en = expandIndexedText(segmentForIndex("deploy the app"));
  assert.ok(en.includes("deploy"), `expected deploy kept: ${en}`);
  assert.ok(en.includes("ดี พลอย"), `expected TH counterpart appended: ${en}`);

  // Thai known term -> EN counterpart appended (boundary exact, syllable-safe).
  const th = expandIndexedText(segmentForIndex("เวลาดีพลอยโค้ดบนเซิร์ฟเวอร์"));
  assert.ok(th.includes("server"), `expected server appended: ${th}`);
  assert.ok(th.includes("deploy"), `expected deploy appended: ${th}`);

  // Non-Thai text with no known term stays byte-identical to segmentForIndex output.
  const plain = expandIndexedText(segmentForIndex("use 2-space indent"));
  assert.equal(plain, "use 2-space indent");

  // Precision: ติดตัง (wrong tone) never fires, and ความจำเป็น never trips ความจำ.
  assert.ok(!expandIndexedText(segmentForIndex("ติดตังค่าบริการ")).includes("install"));
  assert.ok(!expandIndexedText(segmentForIndex("ความจำเป็น")).includes("memory"));
});

test("expandIndexedText: byte-idempotent under a second pass", { skip }, () => {
  const cases = [
    "deploy the app",
    "เวลาดีพลอยโค้ดบนเซิร์ฟเวอร์",
    "use 2-space indent",
    "ผมติดตั้งโปรแกรมบนเซิร์ฟเวอร์ใหม่",
    "ติดตังค่าบริการรายเดือน",
  ];
  for (const s of cases) {
    const once = expandIndexedText(segmentForIndex(s));
    const twice = expandIndexedText(segmentForIndex(once));
    assert.equal(twice, once, `idempotent for ${s}`);
  }
});

// --- buildFtsMatch query-side shape ----------------------------------------

test("buildFtsMatch: Thai chunk stays an ordered phrase, known ASCII chunks OR their TH counterpart", { skip }, () => {
  // Locked-shape guarantee that keeps test/thai_fts.test.mjs green: a Thai
  // chunk is NEVER OR-expanded into multiple phrases.
  const thai = buildFtsMatch("ติดตั้ง");
  assert.ok(thai.startsWith('"') && thai.endsWith('"'), `expected a phrase: ${thai}`);
  assert.ok(!thai.includes(" OR "), `Thai chunk must stay a single phrase: ${thai}`);
  assert.equal(thai.slice(1, -1).replace(/\s+/g, ""), "ติดตั้ง");

  // Known ASCII chunk ORs its TH transliteration phrase in.
  const en = buildFtsMatch("deploy");
  assert.equal(en, '"deploy" OR "ดี พลอย"');

  // Unknown ASCII chunks are untouched (English behavior identical).
  assert.equal(buildFtsMatch("pnpm npm"), '"pnpm" OR "npm"');
  assert.equal(buildFtsMatch("Omise"), '"Omise"');
});

// --- round trip on the real search_index -----------------------------------

test("round trip: Thai doc with ดีพลอย / เซิร์ฟเวอร์ found by English queries", { skip }, () => {
  const table = "syn_x";
  syncSearchIndex(table, 1, "", "เวลาดีพลอยบนเซิร์ฟเวอร์");
  syncSearchIndex(table, 2, "", "แมวกินปลา");
  syncSearchIndex(table, 3, "", "ซื้อข้าวในตลาด");

  assert.deepEqual(ftsIds("deploy", table), [1], "query deploy must find the Thai doc");
  assert.deepEqual(ftsIds("server", table), [1], "query server must find the Thai doc");
  assert.deepEqual(ftsIds("ดีพลอย", table), [1], "query ดีพลอย still finds its own Thai doc");
  assert.deepEqual(ftsIds("แมวกินปลา", table), [2], "unknown Thai still matches normally");
  assert.deepEqual(ftsIds("search", table), [], "irrelevant English query matches nothing");
});

test("round trip: English doc with deploy found by Thai query ดีพลอย", { skip }, () => {
  const table = "syn_en";
  syncSearchIndex(table, 10, "", "deploy the app");
  syncSearchIndex(table, 11, "", "buy fresh milk");

  assert.deepEqual(ftsIds("ดีพลอย", table), [10], "query ดีพลอย must find the English deploy doc");
  assert.deepEqual(ftsIds("deploy", table), [10], "query deploy still finds it directly");
  assert.deepEqual(ftsIds("เซิร์ฟเวอร์", table), [], "unrelated Thai query must not match");
  assert.deepEqual(ftsIds("milk", table), [11]);

  const stored = storedBody(table, 10);
  assert.ok(stored.includes("ดี พลอย"), `index should carry the Thai counterpart: ${stored}`);
});

test("mixed: ติดตั้ง pnpm query still matches the strict Thai doc", { skip }, () => {
  const table = "syn_mixed";
  syncSearchIndex(table, 20, "", "ติดตั้ง pnpm ในโปรเจกต์");
  syncSearchIndex(table, 21, "", "ร้านนี้ข้าวผัดอร่อยมาก");

  assert.deepEqual(ftsIds("ติดตั้ง pnpm", table), [20]);
  assert.deepEqual(ftsIds("install", table), [20], "install synonym must reach the Thai doc");
  assert.deepEqual(ftsIds("โปรเจกต์", table), [20]);
  assert.deepEqual(ftsIds("pnpm", table), [20]);
});

// --- migration 012 ----------------------------------------------------------

test("012_search_index_synonyms: rebuild is idempotent, count-preserving, DDL intact, mark-precision intact", { skip }, () => {
  const marksTable = "syn_marks";
  syncSearchIndex(marksTable, 30, "", "ผมติดตั้งโปรแกรมบนเซิร์ฟเวอร์");
  syncSearchIndex(marksTable, 31, "", "ติดตังค่าบริการรายเดือน");

  const migration = MIGRATIONS.find((m) => m.id === "012_search_index_synonyms");
  assert.ok(migration, "012_search_index_synonyms must be registered");

  const snapshotCount = db.prepare("SELECT COUNT(*) AS c FROM search_index").get().c;
  assert.ok(snapshotCount >= 9, `expected rows to rebuild, got ${snapshotCount}`);

  const before = {
    x: ftsIds("deploy", "syn_x"),
    en: ftsIds("ดีพลอย", "syn_en"),
    mixed: ftsIds("ติดตั้ง pnpm", "syn_mixed"),
  };

  migration.up(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM search_index").get().c, snapshotCount, "row count preserved");

  migration.up(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM search_index").get().c, snapshotCount, "row count preserved on second run");

  assert.deepEqual(ftsIds("deploy", "syn_x"), before.x, "results identical after rebuild");
  assert.deepEqual(ftsIds("ดีพลอย", "syn_en"), before.en, "results identical after rebuild");
  assert.deepEqual(ftsIds("ติดตั้ง pnpm", "syn_mixed"), before.mixed, "results identical after rebuild");

  // tokenizer DDL preserved
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'search_index'").get();
  assert.ok(row && typeof row.sql === "string");
  assert.match(row.sql, /categories/);
  assert.match(row.sql, /L\* N\* Co M\*/);

  // strict mark precision re-confirmed after the rebuild: ติดตั้ง never returns ติดตัง
  assert.deepEqual(ftsIds("ติดตั้ง", marksTable), [30]);
  assert.deepEqual(ftsIds("ติดตัง", marksTable), [31]);
});
