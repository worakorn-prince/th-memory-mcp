// Thai lexical core: looseForm (tone-tolerant form), dictionary fallback
// segmentation (small-icu runtimes), and the mixed TH/EN wordTokens tokenizer.
// Pure unit tests — no DB. Exercises dist via the exported @internal hooks.
import { test, after } from "node:test";
import assert from "node:assert/strict";

const {
  hasThai,
  segmentForIndex,
  segmentQueryChunk,
  wordTokens,
  looseForm,
  forceSegmenter,
  resetSegmenter,
} = await import("../dist/lib/thai-segment.js");

const ICU_AVAILABLE = typeof Intl.Segmenter === "function";

after(() => resetSegmenter());

test("looseForm: strips tone-level marks only, keeps vowels", () => {
  // ้าสำคัญ: ติดตั้ง collapses to ติดตัง — this is exactly the fallback-match
  // equivalence the LOOSE task relies on (FTS itself keeps them distinct).
  assert.equal(looseForm("ติดตั้ง"), "ติดตัง");
  assert.equal(looseForm("ติดตั้ง"), looseForm("ติดตัง"));
  assert.equal(looseForm("กู้คืน"), "กูคืน");
  assert.equal(looseForm("แก้ม"), "แกม");
  assert.equal(looseForm("ตั้งค่า"), "ตังคา", "tones ้ and ่ stripped, vowel ั and า kept");

  // Each tone-level mark alone is dropped while the consonant survives.
  for (const ch of ["่", "้", "๊", "๋", "์"]) {
    assert.equal(looseForm("ก" + ch), "ก", `mark ${ch}`);
  }
  // U+0E4D nikhahit is the same level mark (referenced by the task spec).
  assert.equal(looseForm("\u0E1E\u0E4D\u0E32"), "\u0E1E\u0E32"); // พํา -> พา

  // Vowel marks (ิ ี ึ ื ุ ู ะ ั ็ เ แ โ ใ ไ ำ) survive.
  assert.equal(looseForm("เกาะ"), "เกาะ");
  assert.equal(looseForm("เก็"), "เก็");
  assert.equal(looseForm("กระติก"), "กระติก");
  assert.equal(looseForm("เสาร์"), "เสาร", "cancellation ์ dropped, consonant kept");

  // Non-Thai goes through lowercase only; empty stays empty.
  assert.equal(looseForm("Hello WORLD"), "hello world");
  assert.equal(looseForm("ใช้pnpm"), "ใชpnpm", "tone ้ inside ใช้ is stripped too");
  assert.equal(looseForm(""), "");
});

test("looseForm: idempotent", () => {
  const cases = ["ติดตั้ง", "กู้คืน", "แก้ม", "Hello WORLD", "", "ใช้pnpm", "เสาร์"];
  for (const s of cases) {
    assert.equal(looseForm(looseForm(s)), looseForm(s), `idempotent for ${s}`);
  }
});

test("wordTokens: mixed TH/EN, pure EN, idempotent", () => {
  const mixed = wordTokens("ใช้pnpm");
  assert.ok(mixed.includes("ใช้"), `expected ใช้ in ${mixed}`);
  assert.ok(mixed.includes("pnpm"), `expected pnpm in ${mixed}`);

  assert.deepEqual(wordTokens("Hello  World!"), ["hello", "world"]);
  assert.deepEqual(wordTokens("use 2-space indent"), ["use", "2", "space", "indent"]);
  assert.deepEqual(wordTokens("The project uses SQLite"), ["the", "project", "uses", "sqlite"]);
  assert.deepEqual(wordTokens(""), []);

  const en = wordTokens("The project uses SQLite");
  assert.deepEqual(wordTokens(en.join(" ")), en, "en tokenization is a fixed point");

  const th = wordTokens("โปรแกรมติดตั้ง");
  assert.ok(th.length >= 2, `expected 2+ words, got ${th}`);
  assert.equal(th.join(""), "โปรแกรมติดตั้ง", "Thai tokenization must not drop characters");
});

test("fallback dictionary: known Thai run splits into words", () => {
  forceSegmenter(null);
  try {
    const clause = "ผมต้องติดตั้งโปรแกรมบนเซิร์ฟเวอร์ใหม่";
    const once = segmentForIndex(clause);
    const words = once.trim().split(/\s+/).filter(Boolean);
    assert.ok(words.length > 1, `expected several words, got: ${once}`);
    assert.equal(words.join(""), clause, "fallback must never drop characters");
  } finally {
    resetSegmenter();
  }
});

test("fallback dictionary: byte-idempotent and robust on arbitrary text", () => {
  forceSegmenter(null);
  try {
    const clause = "ผมต้องติดตั้งโปรแกรมบนเซิร์ฟเวอร์ใหม่";
    const once = segmentForIndex(clause);
    assert.equal(segmentForIndex(once), once, "fallback must be byte-idempotent");

    // Non-Thai / empty inputs are returned verbatim.
    assert.equal(segmentForIndex(""), "");
    assert.equal(segmentForIndex("hello world"), "hello world");
    assert.equal(segmentForIndex("  a  b  "), "  a  b  ");

    // Arbitrary mixed input never throws and stays idempotent.
    const mixed = "foo ไทย bar 123 !!!";
    assert.doesNotThrow(() => segmentForIndex(mixed));
    assert.doesNotThrow(() => wordTokens(["x", "แมวซน", "use pnpm"].join(" ")));
    const s = "ใช้pnpm และ Omise";
    assert.equal(segmentForIndex(segmentForIndex(s)), segmentForIndex(s));

    // Unknown clusters still tokenize without dropping characters.
    const toks = wordTokens("แมวซน");
    assert.ok(toks.length >= 1);
    assert.equal(toks.join(""), "แมวซน");
  } finally {
    resetSegmenter();
  }
});

test("fallback dictionary: hasThai and segmentQueryChunk stay correct", () => {
  forceSegmenter(null);
  try {
    assert.equal(hasThai("สวัสดี"), true);
    assert.equal(hasThai("hello 123"), false);
    assert.equal(hasThai(""), false);

    assert.deepEqual(segmentQueryChunk("ใช้pnpm"), ["ใช้", "pnpm"]);
    const q = segmentQueryChunk("ติดตั้ง");
    assert.ok(q.length >= 1, `expected at least one word, got ${q}`);
    assert.equal(q.join(""), "ติดตั้ง");
  } finally {
    resetSegmenter();
  }
});

test("default path (no override): splits, byte-idempotent, mixed tokens", () => {
  resetSegmenter();
  const clause = "ผมต้องติดตั้งโปรแกรมบนเซิร์ฟเวอร์ใหม่ทุกวันศุกร์";
  const once = segmentForIndex(clause);
  const words = once.trim().split(/\s+/).filter(Boolean);
  assert.ok(words.length > 1, `expected several words, got: ${once}`);
  assert.equal(words.join(""), clause);
  assert.equal(segmentForIndex(once), once);
  assert.deepEqual(wordTokens("ใช้pnpm"), ["ใช้", "pnpm"]);
});

test("resetSegmenter restores the Intl.Segmenter path", { skip: !ICU_AVAILABLE }, () => {
  forceSegmenter(null);
  resetSegmenter();
  const run = "ผมต้องติดตั้งโปรแกรม";
  const seg = new Intl.Segmenter("th", { granularity: "word" });
  const expectWords = [...seg.segment(run)]
    .map((s) => s.segment.trim())
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  assert.deepEqual(wordTokens(run), expectWords);
});
