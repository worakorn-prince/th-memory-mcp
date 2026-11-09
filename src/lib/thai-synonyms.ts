/**
 * Curated TH<->EN transliteration/semantic synonym layer for the dev/tech
 * domain. Zero-dependency: imports only `./thai-segment.js` (itself pure), no
 * `node:` modules, no `db/`, no npm packages. Copy the two files together into
 * any Node project and call it directly:
 *
 * ```ts
 * import { expandSynonyms } from "./thai-synonyms.js";
 * expandSynonyms("deploy");          // → ["deploy", "ดีพลอย"]
 * expandSynonyms("ติดตั้ง");          // → ["ติดตั้ง", "install"]
 * expandSynonyms("nope");            // → ["nope"]
 * ```
 *
 * The lookup is bidirectional and whole-term only; `expandChunkSynonyms` and
 * `expandIndexedText` are the FTS-payload helpers used by the server.
 */
// thai-synonyms: a small curated TH<->EN transliteration/semantic synonym
// layer for the dev/tech domain (TASK-THAI-SYN).
//
// Precision first: a synonym only ADDS a new equivalent term. It never relaxes
// the mark-aware Thai channel, so ติดตั้ง != ติดตัง stays exact below. A synonym
// fires only on WHOLE terms: exact token match at index time, whole-chunk match
// on the ASCII query side.
//
// Scope: ~20 unambiguous dev terms. Hyper-common ambiguous English words
// (the/use/run/set/...) are deliberately excluded to keep noise near zero.
//
// Pure module: no DB access, no npm dependencies. It imports only the sibling
// pure thai-segment module so appended counterpart terms are segmented exactly
// the way queries are, which is what keeps index/query consistent.
import { segmentForIndex } from "./thai-segment.js";

export type SynonymPair = readonly [string, string];

export const THAI_SYNONYMS: readonly SynonymPair[] = [
  ["deploy", "ดีพลอย"], // dev loanword; already a segmenter-dictionary word.
  ["server", "เซิร์ฟเวอร์"], // standard TH transliteration for "server".
  ["database", "ฐานข้อมูล"], // semantic TH term for "database".
  ["repository", "รีโพสิทอรี"], // TH loanword for repository.
  ["repository", "รีโพ"], // dev slang "repo", unambiguous in chat/code.
  ["install", "ติดตั้ง"], // TH verb (strict tone-marked form).
  ["package", "แพ็กเกจ"], // TH loanword (packaging context).
  ["project", "โปรเจกต์"], // TH loanword.
  ["version", "เวอร์ชัน"], // TH loanword.
  ["test", "เทสต์"], // TH loanword verb/noun.
  ["node", "โหนด"], // graph / Node.js node, TH loanword.
  ["backup", "สำรอง"], // TH verb.
  ["error", "ข้อผิดพลาด"], // semantic TH term.
  ["search", "ค้นหา"], // TH verb.
  ["save", "บันทึก"], // TH verb.
  ["delete", "ลบ"], // TH verb.
  ["memory", "ความจำ"], // memory (faculty sense) — core domain.
  ["memory", "หน่วยความจำ"], // memory (hardware sense).
  ["config", "คอนฟิก"], // TH loanword for config.
  ["debug", "ดีบั๊ก"], // TH loanword; dictionary word.
];

const THAI_RE = /[\u0E00-\u0E7F]/;

/** Build a two-direction lookup from `[en, th]` pairs (all keys lowercased). */
function buildLookup(
  pairs: Iterable<readonly [string, string]>
): Map<string, readonly string[]> {
  const m = new Map<string, string[]>();
  const put = (k: string, v: string): void => {
    if (!k || !v || k === v) return;
    const cur = m.get(k);
    if (cur) {
      if (!cur.includes(v)) cur.push(v);
    } else {
      m.set(k, [v]);
    }
  };
  for (const [a, b] of pairs) {
    put(a.toLowerCase(), b.toLowerCase());
    put(b.toLowerCase(), a.toLowerCase());
  }
  return m;
}

const STATIC_LOOKUP: Map<string, readonly string[]> = buildLookup(THAI_SYNONYMS);

// --- dynamic provider seam (TASK-THAI-LEARN) --------------------------------
//
// The LEARN task registers a module-level *provider* here (wired by
// src/db/thai-dict.ts, which owns the DB). This file stays pure: it never
// touches the DB, it only calls `provider()` — a cheap function that hands
// back the same in-memory array until refreshed. When no provider is set (the
// default), behavior is byte-identical to the static-only path below.
export type SynonymProvider = () => Array<readonly [string, string]> | null;

let synonymProvider: SynonymProvider | null = null;
let synonymProviderCached: SynonymProvider | null | undefined;
let synonymDynamicBase: Map<string, readonly string[]> | null = null;

/** Set the dynamic synonym provider (no argument / null clears it → static
 * only). Each re-set invalidates the cached merged lookup, so the DB layer can
 * bounce it after every registry write. The provider must be cheap to call. */
export function setSynonymProvider(fn?: SynonymProvider | null): void {
  synonymProvider = fn ?? null;
  synonymProviderCached = undefined;
  synonymDynamicBase = null;
}

/** Static map + provider pairs, cached until the provider is re-set. The
 * returned map is the bidirectional lookup (same shape as STATIC_LOOKUP). */
function getDynamicBase(): Map<string, readonly string[]> | null {
  if (!synonymProvider) return null;
  if (synonymProviderCached !== synonymProvider) {
    const pairs = synonymProvider() ?? [];
    const merged = new Map<string, readonly string[]>(STATIC_LOOKUP);
    mergeLookup(merged, buildLookup(pairs));
    synonymDynamicBase = merged;
    synonymProviderCached = synonymProvider;
  }
  return synonymDynamicBase;
}

function mergeLookup(
  target: Map<string, readonly string[]>,
  source: ReadonlyMap<string, readonly string[]>
): void {
  for (const [k, v] of source) {
    const cur = target.get(k);
    const arr = cur ? [...cur] : [];
    for (const x of v) if (!arr.includes(x)) arr.push(x);
    target.set(k, arr);
  }
}

/**
 * Static map optionally merged with runtime-injected pairs and cached for the
 * static-only path. The `extra` seam exists so the later LEARN task can add
 * learned transliterations without reopening this file. A module-level
 * provider (setSynonymProvider) merges into the same path too.
 */
function lookupFor(
  extra?: Iterable<readonly [string, string]>
): Map<string, readonly string[]> {
  const dyn = getDynamicBase();
  if (dyn === null) {
    if (!extra) return STATIC_LOOKUP;
    const merged = new Map<string, readonly string[]>(STATIC_LOOKUP);
    mergeLookup(merged, buildLookup(extra));
    return merged;
  }
  if (!extra) return dyn;
  const merged = new Map<string, readonly string[]>(dyn);
  mergeLookup(merged, buildLookup(extra));
  return merged;
}

/** Lowercased term + every known counterpart (lowercased, deduped). A term with
 * no known counterpart returns just itself. */
export function expandSynonyms(
  term: string,
  extra?: Iterable<readonly [string, string]>
): string[] {
  const input = String(term ?? "");
  const lc = input.toLowerCase();
  if (!lc) return [lc];
  const exts = lookupFor(extra).get(lc);
  return exts ? [lc, ...exts] : [lc];
}

/** Whole chunk + transliteration variants when the chunk is a known term (TH or
 * EN side). The chunk itself is returned verbatim; variants are lowercased.
 * Chunks that are not a known term return just the chunk. */
export function expandChunkSynonyms(
  chunk: string,
  extra?: Iterable<readonly [string, string]>
): string[] {
  const input = String(chunk ?? "");
  if (!input) return [input];
  const syns = expandSynonyms(input, extra);
  return syns.length === 1 ? [input] : [input, ...syns.slice(1)];
}

const THAI_SUBSEQ_CAP = 40;

/**
 * Append synonym-expanded terms to an already-segmented FTS payload (the
 * segmentForIndex output this module is fed by both index.ts and the 012
 * migration).
 *
 * Idempotency: a counterpart is only appended when its segmented form is not
 * already present in the text (word-safe substring check on the space-delimited
 * payload), so a second pass appends nothing — a byte-idempotent fixed point.
 * Display text never comes from search_index, so the appended terms can never
 * leak to output.
 *
 * Behaviour guarantees:
 *  - Rows with no Thai run and no known term are returned byte-identical.
 *  - Only WHOLE known terms fire (exact token for the single-token pass; for
 *    Thai terms the segmenter may split a word into syllables, so each
 *    contiguous run of Thai tokens is also re-joined and a term fires only when
 *    a contiguous subsequence concatenates to it EXACTLY — ความจำเป็น can never
 *    trip ความจำ, because there is no contiguous subsequence equal to ความจำ).
 *  - Appended counterparts are segmented before appending so they stay
 *    one-token-per-word, exactly like the text a query phrase is matched
 *    against.
 */
export function expandIndexedText(
  segmented: string,
  extra?: Iterable<readonly [string, string]>
): string {
  const text = String(segmented ?? "");
  if (!text.trim()) return text;
  const lookup = lookupFor(extra);
  const tokens = text.split(/\s+/).filter(Boolean);
  const lower = text.toLowerCase();
  const toAppend: string[] = [];
  const appended = new Set<string>();

  const present = (c: string): boolean => {
    const cs = segmentForIndex(String(c)).toLowerCase().trim();
    return cs.length === 0 || lower.includes(cs);
  };
  const push = (c: string): void => {
    // segmentForIndex pads pure-Thai strings with surrounding spaces; trim the
    // appended form so joined entries never bring stray leading/trailing spaces.
    const cs = segmentForIndex(String(c)).toLowerCase().trim();
    if (!cs || present(c)) return;
    if (!appended.has(cs)) {
      appended.add(cs);
      toAppend.push(cs);
    }
  };

  for (const tok of tokens) {
    const syns = expandSynonyms(tok, extra);
    for (let i = 1; i < syns.length; i++) {
      const c = syns[i];
      if (c) push(c);
    }
  }

  const thaiKeys = new Set<string>();
  for (const k of lookup.keys()) {
    if (THAI_RE.test(k)) thaiKeys.add(k);
  }
  let run: string[] | null = null;
  const flush = (): void => {
    if (run && run.length > 0 && run.length <= THAI_SUBSEQ_CAP) {
      for (let s = 0; s < run.length; s++) {
        let join = "";
        for (let e = s; e < run.length; e++) {
          join += run[e] ?? "";
          if (thaiKeys.has(join)) {
            const syns = expandSynonyms(join, extra);
            for (let i = 1; i < syns.length; i++) {
              const c = syns[i];
              if (c) push(c);
            }
          }
        }
      }
    }
    run = null;
  };
  for (const tok of tokens) {
    if (THAI_RE.test(tok)) {
      run = run ?? [];
      run.push(tok.toLowerCase());
    } else {
      flush();
    }
  }
  flush();

  if (toAppend.length === 0) return text.trimEnd();
  return `${text} ${toAppend.join(" ")}`.replace(/ {2,}/g, " ").trimEnd();
}
