// thai-segment: word segmentation for Thai text before it reaches FTS5.
//
// Thai is written without spaces between words. SQLite's default FTS5
// tokenizer (unicode61) also treats Thai combining marks (Unicode category M,
// the vowels/tone marks in U+0E31..U+0E4E) as separators, so an unspaced Thai
// clause was stored as consonant fragments and a query for a whole word such
// as "ติดตั้ง" could never match.
//
// We fix this on both sides:
//   - index time: segmentForIndex() inserts spaces between Thai words, so the
//     tokenizer sees one token per word.
//   - query time: buildFtsMatch() (db/index.ts) turns each Thai chunk into an
//     FTS5 phrase of its words ("ติด ตั้ง เร็ว"), so the words must appear
//     consecutively — the same precision a single English word has.
//
// Keeping those tokens whole relies on the mark-aware search_index tokenizer
// (src/db/search-index-schema.ts): with M* in the category list, a segmented
// Thai word is stored whole and tone marks stay significant, so "ติดตัง" no
// longer collides with "ติดตั้ง".
//
// This file is the single source of truth for Thai lexical handling. It stays
// dependency-free and DB-free (no node: imports), so EMBED/LOOSE/PKG can
// import it without dragging in the database layer.
//
// Segmentation prefers the built-in Intl.Segmenter (full ICU dictionary). On a
// runtime without Intl.Segmenter (Node built with small-icu) we fall back to
// a deterministic built-in dictionary + syllable heuristic — best-effort but
// never a silent no-op, never drops characters, never throws.

const THAI_RE = /[\u0E00-\u0E7F]/;
const THAI_RUN_RE = /[\u0E00-\u0E7F]+/g;

// Tone-level marks only, dropped by looseForm(): ่ ้ ๊ ๋ (U+0E48..U+0E4B) are
// the four English-tone marks; ์ (U+0E4C, thanthakhat) is the cancellation
// sign (drop the mark, keep the consonant); ํ (U+0E4D, nikhahit) sits at the
// same level. Vowel marks (เ แ โ ใ ไ ำ ิ ี ึ ื ุ ู ะ ั ็ ...) are NOT in this
// class — looseForm keeps vowels intact and only strips tone-level marks.
const THAI_TONE_MARK_RE = /[\u0E48\u0E49\u0E4A\u0E4B\u0E4C\u0E4D]/g;

interface SegmentLike {
  segment: string;
  isWordLike?: boolean;
}
type Segmenter = { segment(text: string): Iterable<SegmentLike> };

let cached: Segmenter | null | undefined;

/**
 * @internal override used by tests to force the fallback path. When set,
 * getSegmenter() returns it verbatim and skips auto-detection.
 */
let forced: Segmenter | null | undefined;

function getSegmenter(): Segmenter | null {
  if (forced !== undefined) return forced;
  if (cached !== undefined) return cached;
  try {
    const Ctor = (
      Intl as unknown as {
        Segmenter?: new (
          locale: string,
          opts: { granularity: "word" }
        ) => Segmenter;
      }
    ).Segmenter;
    cached = typeof Ctor === "function" ? new Ctor("th", { granularity: "word" }) : null;
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * @internal test hook — force the module to segment with a specific
 * segmenter, or pass `null` to exercise the built-in dictionary fallback.
 * Never blocks the default Intl.Segmenter path on real runtimes: pairs with
 * `resetSegmenter()` and is only meaningful inside tests.
 */
export function forceSegmenter(seg: Segmenter | null): void {
  forced = seg;
  cached = undefined;
}

/** @internal Undo `forceSegmenter()` and resume Intl.Segmenter auto-detection. */
export function resetSegmenter(): void {
  forced = undefined;
  cached = undefined;
}

// --- built-in dictionary fallback (small-icu runtimes) ---

// Curated, deterministic longest-match dictionary scoped to this project's
// domain (dev/tech/commands/actions) plus a handful of generic common words.
// Entries are stored with their real tone marks because the fallback runs on
// raw (un-de-accented) text; tone tolerance is `looseForm()`'s job.
const DICT_WORDS = [
  // dev / tech / infrastructure
  "ระบบ", "เซิร์ฟเวอร์", "ฐานข้อมูล", "ข้อมูล", "ความจำ", "หน่วยความจำ",
  "โปรแกรม", "แอปพลิเคชัน", "แอป", "ไฟล์", "โฟลเดอร์", "โค้ด",
  "ฟังก์ชัน", "คลาส", "เมธอด", "ตัวแปร", "โมดูล", "มอดูล",
  "สตริง", "อาร์เรย์", "แพ็กเกจ", "แพ็กเก็ต", "ไลบรารี", "รันไทม์",
  "เวอร์ชัน", "สคริปต์", "เอพีไอ", "เอ็นจิน", "คีย์", "ค่า",
  "โทเคน", "ตาราง", "คอลัมน์", "แถว", "ดัชนี", "สคีมา",
  "เคียวรี", "ควิวรี", "ทรานแซกชัน", "เครือข่าย", "อินเทอร์เน็ต", "เบราว์เซอร์",
  "เว็บไซต์", "รหัสผ่าน", "ผู้ใช้", "บัญชี", "อีเมล", "ล็อก",
  "ล็อกอิน", "ดีบั๊ก", "บั๊ก", "บัค", "โอเพนซอร์ส", "เดสก์ท็อป",
  "โมบาย", "คลาวด์", "โปรเซส", "เธรด", "พาร์เซอร์", "คอมไพเลอร์",
  "ลิงก์", "แมป", "เครื่องมือ", "ภาษา", "พร้อม", "รองรับ",
  // commands / actions
  "ติดตั้ง", "ถอนการติดตั้ง", "ติดตัง", "เปิดใช้งาน", "ปิดใช้งาน",
  "อัปเดต", "อัปเกรด", "ดาวน์เกรด", "ดาวน์โหลด", "อัปโหลด",
  "กู้คืน", "สำรอง", "บันทึก", "ลบ", "แก้ไข", "สร้าง",
  "เขียน", "อ่าน", "ค้นหา", "กรอง", "เรียง", "จัดเรียง",
  "เชื่อมต่อ", "แยก", "รวม", "เพิ่ม", "ลด", "คูณ",
  "หาร", "บวก", "ส่ง", "รับ", "เปิด", "ปิด",
  "หยุด", "พัก", "ต่อ", "ข้าม", "ยกเลิก", "กด",
  "คลิก", "พิมพ์", "ใส่", "แทรก", "คัดลอก", "วาง",
  "ย้าย", "เปลี่ยน", "แปลง", "แปล", "รัน", "เทสต์",
  "ทดสอบ", "เรียก", "เรียกใช้", "แสดง", "ซ่อน", "ตรวจ",
  "ตรวจสอบ", "ตั้งค่า", "กำหนด", "อนุญาต", "ปฏิเสธ", "เริ่ม",
  "เริ่มต้น", "คืนค่า", "รีเซ็ต", "เรียนรู้", "จำ", "ทำงาน",
  "พยายาม", "ลอง", "ต้องการ", "อยากได้", "เข้าใจ", "ตอบ",
  "ถาม", "ช่วย", "ดีพลอย",
  // generic common words
  "เวลา", "งาน", "คน", "วัน", "ศุกร์", "บ่าย",
  "โมง", "สาม", "หลัง", "ใหม่", "เก่า", "เร็ว",
  "ช้า", "ดี", "ง่าย", "ยาก", "ใหญ่", "เล็ก",
  "มาก", "น้อย", "ทุก", "บาง", "เสร็จ", "การ",
  "ของ", "และ", "หรือ", "ที่", "ให้", "ไม่",
  "ใน", "มี", "คือ", "ไป", "มา", "ด้วย",
  "อะไร", "ทำ", "เป็น", "อยู่", "จาก", "กับ",
  "ว่า", "นี้", "นั้น", "โดย", "ครับ", "ค่ะ",
  "ต้อง", "ยัง", "เพื่อ", "แบบ", "นะ", "เลย",
  "ก็", "แต่", "ถ้า", "ผม", "ฉัน", "คุณ",
  "เรา", "เขา", "มัน", "ใช้", "ข้าว", "ผัด",
  "อร่อย", "แมว", "กิน", "ปลา", "น้ำ", "บ้าน",
  "เมือง", "เพื่อน", "ร้าน", "เงิน", "บริการ", "รายเดือน",
  "อาหาร", "ทะเล", "นั่ง", "กลางวัน", "ดื้อ", "ยอม",
  "ฟัง", "ใคร", "แพ้", "เผ็ด",
];

const DICT: ReadonlySet<string> = new Set(DICT_WORDS);
let DICT_MAX = 0;
for (const w of DICT_WORDS) {
  if (w.length > DICT_MAX) DICT_MAX = w.length;
}

/** Thai consonants U+0E01..U+0E2E (ก .. ฮ). */
function isThaiConsonant(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return c >= 0x0e01 && c <= 0x0e2e;
}

/**
 * Best-effort cluster for a run position where no dictionary word matches:
 * take the leading character together with every following non-consonant
 * (vowels/marks) up to the next consonant — a pseudo-syllable. Never drops
 * characters and always advances, so the scan terminates.
 */
function heuristicWord(run: string, start: number): { word: string; next: number } {
  let i = start + 1;
  let word = run[start] ?? "";
  while (i < run.length) {
    const ch = run[i] ?? "";
    if (isThaiConsonant(ch)) break;
    word += ch;
    i++;
  }
  return { word, next: i };
}

/**
 * Deterministic maximal-munch segmentation of one Thai run using the built-in
 * dictionary, falling back to the syllable heuristic for unknown runs. The
 * result is a pure function of the input, which keeps `segmentForIndex`
 * byte-idempotent even on the fallback path.
 */
function dictSegment(run: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < run.length) {
    const max = Math.min(DICT_MAX, run.length - i);
    let matched = "";
    for (let len = max; len >= 1; len--) {
      const cand = run.slice(i, i + len);
      if (DICT.has(cand)) {
        matched = cand;
        break;
      }
    }
    if (matched) {
      out.push(matched);
      i += matched.length;
      continue;
    }
    const cluster = heuristicWord(run, i);
    out.push(cluster.word);
    i = cluster.next;
  }
  return out;
}

/** Split one run of Thai characters into words (shared core of the module). */
function thaiTokens(run: string, seg: Segmenter | null): string[] {
  const out: string[] = [];
  if (seg) {
    for (const s of seg.segment(run)) {
      const w = s.segment.trim();
      if (w) out.push(w);
    }
  } else {
    out.push(...dictSegment(run));
  }
  return applyOverrideMerges(run, out);
}

// --- segment-override provider seam (TASK-THAI-LEARN) -----------------------
//
// A dependency-inverted injection point: src/db/thai-dict.ts registers a
// provider that hands back this module's list of FORCED compounds (term → the
// single token it must stay). This module stays pure — it never imports the DB;
// it only calls `provider()` for a cached in-memory list. When no provider is
// set (default), every function below behaves byte-identically to before.
//
// Semantics: when a segmented Thai run contains the registered `term` as a
// contiguous token-aligned sequence (the segmenter split it apart), those
// tokens are re-merged into one token (`fixed`, normally == `term`). Only
// whole-token-aligned matches merge — a term that straddles a token boundary
// is skipped (safe no-op), so segmentation never drops characters and is
// deterministic and idempotent: after a merge the run holds the single forced
// token, and a second pass re-finds it as one token.
export type SegmentOverride = { term: string; fixed: string };
export type SegmentOverrideProvider = () => SegmentOverride[] | null;

let overrideProvider: SegmentOverrideProvider | null = null;
let overrideProviderCached: SegmentOverrideProvider | null | undefined;
let overrideTermMap: Map<string, string> | null = null;

/** Set the forced-compound provider (no argument / null clears it → built-in
 * behavior). Re-set to invalidate the cached list after a registry write. */
export function setSegmentOverrideProvider(fn?: SegmentOverrideProvider | null): void {
  overrideProvider = fn ?? null;
  overrideProviderCached = undefined;
  overrideTermMap = null;
}

/** Cached term → fixed map from the provider; null when unset/empty. */
function getOverrideTermMap(): Map<string, string> | null {
  const provider = overrideProvider;
  if (!provider) return null;
  if (overrideProviderCached !== provider) {
    let list: SegmentOverride[] | null = null;
    try {
      list = provider() ?? null;
    } catch {
      list = null;
    }
    const map = new Map<string, string>();
    if (list) {
      for (const o of list) {
        const t = String(o?.term ?? "").trim();
        const f = String(o?.fixed ?? "").trim();
        if (t && f) map.set(t, f);
      }
    }
    overrideTermMap = map;
    overrideProviderCached = provider;
  }
  return overrideTermMap;
}

function mergeForcedTokens(
  tokens: readonly string[],
  term: string,
  fixed: string
): readonly string[] | null {
  const out: string[] = [];
  let changed = false;
  let i = 0;
  while (i < tokens.length) {
    const head = tokens[i] ?? "";
    if (head === term) {
      out.push(fixed);
      changed = true;
      i += 1;
      continue;
    }
    if (head.length < term.length) {
      let acc = head;
      let j = i + 1;
      while (j < tokens.length && acc.length < term.length) {
        acc += tokens[j] ?? "";
        j += 1;
      }
      if (acc === term) {
        out.push(fixed);
        changed = true;
        i = j;
        continue;
      }
    }
    out.push(head);
    i += 1;
  }
  return changed ? out : null;
}

function applyOverrideMerges(run: string, tokens: readonly string[]): string[] {
  const map = getOverrideTermMap();
  if (map === null || map.size === 0) return [...tokens];
  const terms = [...map.keys()]
    .filter((t) => run.includes(t))
    .sort((a, b) => b.length - a.length);
  if (terms.length === 0) return [...tokens];
  let out: readonly string[] = tokens;
  for (const term of terms) {
    const merged = mergeForcedTokens(out, term, map.get(term) ?? term);
    if (merged) out = merged;
  }
  return [...out];
}

export function hasThai(text: string): boolean {
  return THAI_RE.test(text);
}

/**
 * Tone-tolerant / de-accented form of `text` (query-expansion fallback matching):
 * strips only Thai tone-level marks (่ ้ ๊ ๋ ์ ํ), keeps all vowels intact, and
 * lowercases. Powers the LOOSE matcher: "ติดตั้ง" → "ติดตัง" equivalence is used
 * for relaxed fallback lookups only, never for FTS index content (tone marks
 * stay significant there). Pure and idempotent.
 */
export function looseForm(text: string): string {
  return String(text ?? "").toLowerCase().replace(THAI_TONE_MARK_RE, "");
}

/**
 * Tokenize mixed Thai/English text into word tokens (lowercased, trimmed).
 * The single core path an indexer uses: pure-English text is a plain
 * whitespace/alpha split, Thai runs go through the segmenter (or the fallback
 * dictionary). English stopword filtering deliberately lives in distill-core,
 * not here. Deterministic → re-tokenizing the joined tokens is a fixed point.
 */
export function wordTokens(text: string): string[] {
  const input = String(text ?? "");
  const seg = getSegmenter();
  const out: string[] = [];
  let last = 0;
  for (const m of input.matchAll(THAI_RUN_RE)) {
    const run = m[0] ?? "";
    const idx = m.index;
    pushLatinTokens(input.slice(last, idx), out);
    for (const w of thaiTokens(run, seg)) {
      if (w) out.push(w.toLowerCase());
    }
    last = idx + run.length;
  }
  pushLatinTokens(input.slice(last), out);
  return out;
}

/** Split a non-Thai segment into word tokens on whitespace/punctuation. */
function pushLatinTokens(segment: string, out: string[]): void {
  if (!segment) return;
  for (const tok of segment.toLowerCase().split(/[^a-z0-9]+/)) {
    if (tok) out.push(tok);
  }
}

/**
 * Text to store in FTS5: Thai runs get spaces between words, everything else
 * is left untouched. Display paths read from the source tables, never from
 * search_index, so the extra spaces are never shown to the user.
 *
 * Only spaces are collapsed after the transform (never tabs/newlines), which
 * makes the function byte-idempotent: a second pass inserts boundary spaces
 * around every already-separated Thai word, and those runs collapse back to
 * the single spaces produced by the first pass. Non-Thai text keeps its exact
 * whitespace because inputs without Thai are returned verbatim.
 */
export function segmentForIndex(text: string): string {
  const input = String(text ?? "");
  if (!hasThai(input)) return input;
  const seg = getSegmenter();
  const out = input.replace(THAI_RUN_RE, (run) => ` ${thaiTokens(run, seg).join(" ")} `);
  return out.replace(/ {2,}/g, " ");
}

/**
 * Turn one whitespace-delimited query chunk into its word list. A chunk such
 * as "ใช้pnpm" yields ["ใช้", "pnpm"].
 */
export function segmentQueryChunk(chunk: string): string[] {
  const spaced = segmentForIndex(chunk);
  return spaced.split(/\s+/).filter(Boolean);
}
