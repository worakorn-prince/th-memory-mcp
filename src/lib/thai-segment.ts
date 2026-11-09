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
// Uses the built-in Intl.Segmenter (ICU dictionary). No dependencies. On a
// runtime without Intl.Segmenter (Node built with small-icu) every function
// returns its input unchanged, which is the previous behavior.

const THAI_RE = /[\u0E00-\u0E7F]/;
const THAI_RUN_RE = /[\u0E00-\u0E7F]+/g;

interface SegmentLike {
  segment: string;
  isWordLike?: boolean;
}
type Segmenter = { segment(text: string): Iterable<SegmentLike> };

let cached: Segmenter | null | undefined;

function getSegmenter(): Segmenter | null {
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

export function hasThai(text: string): boolean {
  return THAI_RE.test(text);
}

/** Split one run of Thai characters into words. */
function thaiWords(run: string, seg: Segmenter): string[] {
  const out: string[] = [];
  for (const s of seg.segment(run)) {
    const w = s.segment.trim();
    if (w) out.push(w);
  }
  return out;
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
  if (!seg) return input;
  const out = input.replace(THAI_RUN_RE, (run) => ` ${thaiWords(run, seg).join(" ")} `);
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
