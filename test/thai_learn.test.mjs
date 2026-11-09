// TASK-THAI-LEARN: personal Thai dictionary (thai_dict) — registry CRUD,
// lesson auto-learn (deterministic + idempotent), and the dependency-inverted
// dynamic providers for synonyms and segmentation overrides.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { test, after } from "node:test";
import assert from "node:assert/strict";

const dbPath = join(tmpdir(), `th-mem-thai-learn-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;
process.env.MEMORY_BACKUP_ON_MIGRATE = "0";

const { db, buildFtsMatch, syncSearchIndex } = await import("../dist/db/index.js");
const {
  addSynonym,
  addSegmentOverride,
  removeTerm,
  getDictEntries,
  learnFromLessons,
  refreshDictProvider,
} = await import("../dist/db/thai-dict.js");
const {
  segmentForIndex,
  wordTokens,
  forceSegmenter,
  resetSegmenter,
  setSegmentOverrideProvider,
} = await import("../dist/lib/thai-segment.js");
const {
  setSynonymProvider,
  expandSynonyms,
  expandChunkSynonyms,
  THAI_SYNONYMS,
} = await import("../dist/lib/thai-synonyms.js");
const { MIGRATIONS } = await import("../dist/db/migrations.js");

after(() => {
  resetSegmenter();
  setSynonymProvider(null);
  setSegmentOverrideProvider(null);
  db.close();
  for (const s of ["", "-wal", "-shm"]) rmSync(`${dbPath}${s}`, { force: true });
});

function ftsIds(query, refTable) {
  return db
    .prepare(
      "SELECT ref_id FROM search_index WHERE ref_table = ? AND search_index MATCH ? ORDER BY rank"
    )
    .all(refTable, buildFtsMatch(query))
    .map((r) => Number(r.ref_id));
}

function entry(term) {
  return getDictEntries().find((r) => r.term === term);
}

// --- registry CRUD + validation ----------------------------------------------

test("thai_dict: table exists (M014) and add/remove work; junk is rejected", () => {
  const m014 = MIGRATIONS.find((m) => m.id === "014_thai_dict");
  assert.ok(m014, "014_thai_dict must be registered in MIGRATIONS");
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'thai_dict'")
    .get();
  assert.ok(table, "thai_dict table must exist after migrations");
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'thai_dict'").get();
  assert.match(String(schema?.sql ?? ""), /term\s+TEXT PRIMARY KEY/);

  addSynonym("tempterm", "เทมป์เทอม");
  addSegmentOverride("ติดตั้งโปรแกรม", "ติดตั้งโปรแกรม");
  let r = entry("tempterm");
  assert.ok(r && r.kind === "synonym" && r.pair === "เทมป์เทอม" && r.source === "manual");
  r = entry("ติดตั้งโปรแกรม");
  assert.ok(r && r.kind === "segment" && r.pair === "ติดตั้งโปรแกรม");

  assert.equal(removeTerm("tempterm").removed, true);
  assert.equal(entry("tempterm"), undefined, "removed term must be gone");
  assert.equal(removeTerm("tempterm").removed, false, "double rm is a no-op");
  assert.ok(entry("ติดตั้งโปรแกรม"), "segment entry survives tempterm's removal");

  // junk rejection — clear errors, never silent
  assert.throws(() => addSynonym("", "x"), /non-empty/);
  assert.throws(() => addSynonym("   ", "x"), /not be empty/);
  assert.throws(() => addSynonym("a\u0000b", "x"), /control character/);
  assert.throws(() => addSynonym("a\u0001b", "x"), /control character/);
  assert.throws(() => addSynonym("a".repeat(101), "x"), /100 characters/);
  assert.throws(() => addSynonym("term", ""), /pair/);
  assert.throws(() => addSynonym(null, "x"), /non-empty/);
  assert.throws(() => addSegmentOverride("", "x"), /non-empty/);
  assert.throws(() => addSegmentOverride("ok", "\u0000"), /control character/);
});

// --- learnFromLessons ---------------------------------------------------------

test("learnFromLessons: learns a TH token matching THAI_SYNONYMS, idempotent, never erases manual", () => {
  forceSegmenter(null); // deterministic fallback segmentation
  try {
    // a pre-existing manual entry must survive auto-learn
    addSynonym("ติดตั้ง", "install");

    const ins = db.prepare(
      "INSERT INTO lessons (situation, mistake, correction, created_at) VALUES (?, ?, ?, ?)"
    );
    ins.run(
      "เวลา deploy",
      "ลืมดีพลอย",
      "ควรดีพลอยโค้ดและติดตั้งโปรแกรมก่อนรัน",
      new Date().toISOString()
    );
    ins.run("bug", "no", "need to fix", new Date().toISOString());

    const learned = learnFromLessons();
    assert.equal(learned, 1, "exactly ดีพลอย is new (ติดตั้ง is already manual)");

    const depl = entry("ดีพลอย");
    assert.ok(
      depl && depl.kind === "synonym" && depl.pair === "deploy" && depl.source === "lesson",
      `expected kind=synonym pair=deploy source=lesson, got ${JSON.stringify(depl)}`
    );
    const inst = entry("ติดตั้ง");
    assert.ok(inst, "manual ติดตั้ง row must still exist");
    assert.equal(inst.source, "manual", "manual entry must NOT be overwritten/erased");

    const count = db.prepare("SELECT COUNT(*) AS c FROM thai_dict WHERE term = ?").get("ดีพลอย").c;
    assert.equal(count, 1, "idempotent: exactly one ดีพลอย row");

    const second = learnFromLessons();
    assert.equal(second, 0, "second learn is a no-op (marker unchanged)");
  } finally {
    resetSegmenter();
  }
});

// --- dynamic synonym provider, end to end on search_index --------------------

test("dynamic synonym: dict row feeds the pure expanders and finds Thai docs from EN query", () => {
  addSynonym("rollout", "โรลเอาต์"); // addSynonym refreshes the provider

  // pure seam: the registered pair is now visible in the expanders
  const syns = expandSynonyms("rollout");
  assert.ok(syns.includes("โรลเอาต์"), `dynamic synonym missing: ${syns}`);
  assert.deepEqual(expandChunkSynonyms("rollout").slice(0, 2), ["rollout", "โรลเอาต์"]);

  // TH doc found by EN query through the index round-trip
  const table = "learn_syn";
  syncSearchIndex(table, 1, "", "ทำการโรลเอาต์เวอร์ชันใหม่บนเซิร์ฟเวอร์");
  syncSearchIndex(table, 2, "", "แมวกินปลา");
  syncSearchIndex(table, 3, "", "ซื้อข้าวในตลาด");

  assert.deepEqual(ftsIds("rollout", table), [1], "EN rollout query must find the Thai doc");
  assert.deepEqual(ftsIds("โรลเอาต์", table), [1], "TH query still finds its own doc");
  assert.deepEqual(ftsIds("server", table), [1]);
  assert.deepEqual(ftsIds("search", table), [], "irrelevant EN query matches nothing");

  // reversed: EN doc found by TH query (index appended the TH counterpart)
  const en = "learn_syn_en";
  syncSearchIndex(en, 10, "", "perform the rollout release");
  assert.deepEqual(ftsIds("โรลเอาต์", en), [10], "TH query finds the EN rollout doc");
  const stored = db
    .prepare("SELECT body FROM search_index WHERE ref_table = ? AND ref_id = ?")
    .get(en, 10);
  assert.ok(String(stored.body).includes("โรล"), `index carries TH counterpart: ${stored.body}`);
});

// --- segment override provider, end to end -----------------------------------

test("segment override: registered compound stays ONE token in wordTokens/segmentForIndex", () => {
  addSegmentOverride("ติดตั้งโปรแกรม", "ติดตั้งโปรแกรม"); // refreshes the provider
  forceSegmenter(null); // deterministic fallback base
  try {
    const toks = wordTokens("ช่วยติดตั้งโปรแกรม");
    assert.ok(
      toks.includes("ติดตั้งโปรแกรม"),
      `expected the forced compound as one token, got ${JSON.stringify(toks)}`
    );
    assert.ok(!toks.includes("ติดตั้ง") || !toks.includes("โปรแกรม"), "no split pieces left");
    assert.equal(toks.join(""), "ช่วยติดตั้งโปรแกรม", "segmentation never drops characters");
    assert.deepEqual(wordTokens(toks.join(" ")), toks, "override merge is a fixed point");

    const seg = segmentForIndex("ช่วยติดตั้งโปรแกรม").trim().split(/\s+/).filter(Boolean);
    assert.ok(seg.includes("ติดตั้งโปรแกรม"), `segmentForIndex keeps it whole: ${seg}`);
  } finally {
    resetSegmenter();
  }
});

// --- provider null => static-only behavior unchanged --------------------------

test("provider null: static-only behavior is byte-identical (default)", () => {
  setSynonymProvider(null);
  setSegmentOverrideProvider(null);

  assert.deepEqual(expandSynonyms("deploy"), ["deploy", "ดีพลอย"]);
  assert.deepEqual(expandSynonyms("ติดตั้ง"), ["ติดตั้ง", "install"]);
  assert.deepEqual(expandChunkSynonyms("zzz"), ["zzz"]);
  assert.deepEqual(expandSynonyms("memory"), ["memory", "ความจำ", "หน่วยความจำ"]);

  forceSegmenter(null);
  try {
    assert.deepEqual(wordTokens("ติดตั้งโปรแกรม"), ["ติดตั้ง", "โปรแกรม"]);
  } finally {
    resetSegmenter();
  }

  // DB rows survive; a refresh re-warms the providers
  assert.ok(entry("rollout"), "clearing providers never touches DB rows");
  refreshDictProvider();
  assert.ok(expandSynonyms("rollout").includes("โรลเอาต์"), "refresh restores the dynamic layer");
});

// --- THAI_SYNONYMS sanity (this task's learn source) --------------------------

test("THAI_SYNONYMS still lists a known TH side learn can match", () => {
  const hasDepl = THAI_SYNONYMS.some(([en, th]) => en === "deploy" && th === "ดีพลอย");
  assert.ok(hasDepl, "deploy ↔ ดีพลอย must remain a curated pair");
});
