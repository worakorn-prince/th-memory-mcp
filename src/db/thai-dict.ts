// thai-dict: the PERSONAL Thai lexical registry (TASK-THAI-LEARN).
//
// This is the ONLY task-owned module that touches the DB for dictionary data.
// It holds two kinds of rows:
//   - kind='synonym'  → an extra TH<->EN transliteration (dynamic synonym layer)
//   - kind='segment'  → a forced compound the segmenter must keep as ONE token
//
// Pure modules (src/lib/thai-synonyms.ts, src/lib/thai-segment.ts) stay
// DB-free: they expose provider seams, and this module wires them by loading
// rows into in-memory providers via `setSynonymProvider` /
// `setSegmentOverrideProvider`. `refreshDictProvider()` rebuilds those
// providers after every registry write and at startup, so the runtime dict is
// always warm.
//
// `learnFromLessons()` auto-learns synonyms from the user's own lessons: any
// Thai token (from the CORE `wordTokens` segmentation) that EXACTLY matches a
// known TH side of THAI_SYNONYMS is upserted as kind='synonym' source='lesson'
// (term=TH token, pair=its EN). It is bounded (most-recent 500 lessons),
// idempotent (INSERT ... ON CONFLICT DO NOTHING + a schema_meta marker so
// nothing re-runs when no lesson changed), and NEVER erases manual entries.
import { db } from "./index.js";
import { wordTokens } from "../lib/thai-segment.js";
import { THAI_SYNONYMS, setSynonymProvider } from "../lib/thai-synonyms.js";
import { setSegmentOverrideProvider } from "../lib/thai-segment.js";

export const MAX_DICT_TERM_LENGTH = 100;
export const LESSON_SCAN_LIMIT = 500;
const MARKER_KEY = "thai_dict_lesson_marker";
const THAI_RE = /[\u0E00-\u0E7F]/;
const CONTROL_RE = /[\u0000-\u001F\u007F]/;
const NOW = () => new Date().toISOString();

export interface DictEntry {
  term: string;
  kind: "synonym" | "segment";
  pair: string;
  source: string;
  project_id: string | null;
  created_at: string;
}

export interface DictAddOpts {
  source?: string;
  projectId?: string | null;
}

/** Defensive registry validation: non-empty, no control chars, max length,
 * lowercased (Thai is case-less; Latin sides fold so lookups match). Junk is
 * REJECTED with a clear error — never accepted silently, never thrown on
 * absent input. */
function validateTerm(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`thai-dict: ${label} must be a non-empty string`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`thai-dict: ${label} must not be empty`);
  if (CONTROL_RE.test(trimmed))
    throw new Error(`thai-dict: ${label} must not contain control characters`);
  if (trimmed.length > MAX_DICT_TERM_LENGTH)
    throw new Error(
      `thai-dict: ${label} exceeds ${MAX_DICT_TERM_LENGTH} characters`
    );
  return trimmed.toLowerCase();
}

function tableExists(name: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== undefined;
}

function columnNames(table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

export function getDictEntries(): DictEntry[] {
  return db
    .prepare(
      "SELECT term, kind, pair, source, project_id, created_at FROM thai_dict ORDER BY term"
    )
    .all() as DictEntry[];
}

function upsertEntry(
  kind: "synonym" | "segment",
  term: string,
  pair: string,
  opts?: DictAddOpts
): void {
  const t = validateTerm(term, "term");
  const p = validateTerm(pair, "pair");
  const source = opts?.source ?? "manual";
  const projectId = opts?.projectId ?? null;
  db.prepare(
    `INSERT INTO thai_dict (term, kind, pair, source, project_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(term) DO UPDATE SET
       kind = excluded.kind,
       pair = excluded.pair,
       source = excluded.source,
       project_id = excluded.project_id,
       created_at = excluded.created_at`
  ).run(t, kind, p, source, projectId, NOW());
  refreshDictProvider();
}

/** Add (or replace) a TH<->EN synonym entry. Pair direction is free — the
 * lookup is bidirectional, so term/pair can be either the EN or the TH side. */
export function addSynonym(
  term: string,
  pair: string,
  opts?: DictAddOpts
): DictEntry {
  upsertEntry("synonym", term, pair, opts);
  return (
    db.prepare("SELECT term, kind, pair, source, project_id, created_at FROM thai_dict WHERE term = ?").get(validateTerm(term, "term")) as DictEntry
  );
}

/** Add (or replace) a forced-compound segment override: when a raw Thai run
 * contains `term` as a contiguous token-aligned sequence, it stays ONE token
 * (`pair`). Use pair == term to force a compound the segmenter would split. */
export function addSegmentOverride(
  term: string,
  pair: string,
  opts?: DictAddOpts
): DictEntry {
  upsertEntry("segment", term, pair, opts);
  return (
    db.prepare("SELECT term, kind, pair, source, project_id, created_at FROM thai_dict WHERE term = ?").get(validateTerm(term, "term")) as DictEntry
  );
}

export function removeTerm(term: string): { removed: boolean } {
  const t = validateTerm(term, "term");
  const info = db.prepare("DELETE FROM thai_dict WHERE term = ?").run(t);
  refreshDictProvider();
  return { removed: info.changes > 0 };
}

// --- provider wiring ---------------------------------------------------------

let synCache: Array<readonly [string, string]> = [];
let segCache: Array<{ term: string; fixed: string }> = [];

/**
 * Reload thai_dict rows into the pure-module providers. `synonym` rows become
 * the setSynonymProvider source; `segment` rows become the
 * setSegmentOverrideProvider source. Each call re-sets the providers (new
 * closures + freshly rebuilt arrays), which invalidates their internal caches.
 * Safe before M014 exists (the table is simply empty).
 */
export function refreshDictProvider(): void {
  let rows: DictEntry[];
  try {
    rows = getDictEntries();
  } catch {
    rows = [];
  }
  const syns: Array<readonly [string, string]> = [];
  const segs: Array<{ term: string; fixed: string }> = [];
  for (const r of rows) {
    if (r.kind === "synonym") syns.push([r.term, r.pair]);
    else if (r.kind === "segment") segs.push({ term: r.term, fixed: r.pair });
  }
  synCache = syns;
  segCache = segs;
  setSynonymProvider(() => synCache);
  setSegmentOverrideProvider(() => segCache);
}

// --- auto-learn from lessons -------------------------------------------------

function thToEnLookup(): Map<string, string> {
  const m = new Map<string, string>();
  for (const [en, th] of THAI_SYNONYMS) {
    const thKey = th.toLowerCase();
    if (!m.has(thKey)) m.set(thKey, en.toLowerCase());
  }
  return m;
}

function lessonSignature(): string {
  const parts: string[] = [];
  try {
    const l = db
      .prepare("SELECT COUNT(*) AS c, COALESCE(MAX(id), 0) AS mx FROM lessons")
      .get() as { c: number; mx: number };
    parts.push(`L${l.c}:${l.mx}`);
  } catch {
    parts.push("L0:0");
  }
  try {
    const m = db
      .prepare(
        "SELECT COUNT(*) AS c, COALESCE(MAX(id), 0) AS mx FROM memories WHERE type = 'LESSON'"
      )
      .get() as { c: number; mx: number };
    parts.push(`M${m.c}:${m.mx}`);
  } catch {
    parts.push("M0:0");
  }
  return parts.join("|");
}

function readMarker(): string {
  const row = db
    .prepare("SELECT value FROM schema_meta WHERE key = ?")
    .get(MARKER_KEY) as { value: string } | undefined;
  return row?.value ?? "";
}

function writeMarker(sig: string): void {
  db.prepare(
    "INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(MARKER_KEY, sig);
}

function doLearn(): number {
  const thToEn = thToEnLookup();
  if (thToEn.size === 0) return 0;
  const upsert = db.prepare(
    `INSERT INTO thai_dict (term, kind, pair, source, project_id, created_at)
     VALUES (?, 'synonym', ?, 'lesson', ?, ?)
     ON CONFLICT(term) DO NOTHING`
  );
  const scans: Array<{ text: string; projectId: string | null }> = [];

  try {
    if (tableExists("lessons")) {
      const cols = columnNames("lessons");
      const hasProject = cols.has("project_id");
      const lessons = hasProject
        ? db
            .prepare(
              "SELECT situation, mistake, correction, project_id FROM lessons ORDER BY id DESC LIMIT ?"
            )
            .all(LESSON_SCAN_LIMIT)
        : db
            .prepare(
              "SELECT situation, mistake, correction, NULL AS project_id FROM lessons ORDER BY id DESC LIMIT ?"
            )
            .all(LESSON_SCAN_LIMIT);
      for (const r of lessons as Array<{
        situation: string | null;
        mistake: string | null;
        correction: string | null;
        project_id: string | null;
      }>) {
        scans.push({
          text: `${r.situation ?? ""} ${r.mistake ?? ""} ${r.correction ?? ""}`,
          projectId: r.project_id ?? null,
        });
      }
    }
  } catch {
    /* defensive: never break the init path on a weird schema */
  }

  try {
    if (tableExists("memories")) {
      const cols = columnNames("memories");
      if (cols.has("content") && cols.has("type")) {
        const hasProject = cols.has("project_id");
        const mems = hasProject
          ? db
              .prepare(
                "SELECT id, content, project_id FROM memories WHERE type = 'LESSON' ORDER BY id DESC LIMIT ?"
              )
              .all(LESSON_SCAN_LIMIT)
          : db
              .prepare(
                "SELECT id, content, NULL AS project_id FROM memories WHERE type = 'LESSON' ORDER BY id DESC LIMIT ?"
              )
              .all(LESSON_SCAN_LIMIT);
        for (const r of mems as Array<{
          content: string | null;
          project_id: string | null;
        }>) {
          scans.push({ text: r.content ?? "", projectId: r.project_id ?? null });
        }
      }
    }
  } catch {
    /* defensive */
  }

  let learned = 0;
  for (const { text, projectId } of scans) {
    for (const tok of wordTokens(text)) {
      if (!THAI_RE.test(tok)) continue;
      const en = thToEn.get(tok.toLowerCase());
      if (en === undefined) continue;
      const info = upsert.run(tok.toLowerCase(), en, projectId, NOW());
      if (info.changes > 0) learned += 1;
    }
  }
  return learned;
}

/**
 * Deterministic, idempotent auto-learn. Fast path: a schema_meta marker
 * records a signature of the lesson sources (count + max id per source); when
 * nothing changed the scan is skipped (near-zero cost per open). When the
 * sources changed, up to `LESSON_SCAN_LIMIT` most-recent lessons are scanned
 * and matching TH tokens are upserted as kind='synonym' source='lesson'
 * (INSERT ... DO NOTHING → manual rows are never erased/overwritten).
 * Returns the number of NEW rows learned this run.
 */
export function learnFromLessons(): number {
  const sig = lessonSignature();
  if (readMarker() === sig) return 0;
  const learned = doLearn();
  writeMarker(sig);
  if (learned > 0) refreshDictProvider();
  return learned;
}
