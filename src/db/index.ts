/**
 * Security note — encryption at rest (Md-4):
 * DB is plaintext-at-rest. `better-sqlite3` does NOT use SQLCipher or any
 * file-level encryption by default. The file at DB_PATH (default
 * data/memory.db, WAL mode) is readable by anyone with filesystem access
 * (shared machine, backup, malware, stolen device). "100% local & private"
 * means no network exfiltration — it does NOT mean encrypted at rest.
 * If you need encryption at rest, use OS-level full-disk encryption
 * (BitLocker / FileVault / LUKS) or migrate to an opt-in SQLCipher build
 * (native rebuild + key management required). No in-code encryption is
 * applied; treat the file as you would any plaintext local store.
 */
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { truncate } from "../lib/capture-core.js";
import { redactSecrets } from "../lib/redact.js";
import { serialize } from "../lib/embed.js";
import { hasThai, segmentForIndex, segmentQueryChunk } from "../lib/thai-segment.js";
import { expandChunkSynonyms, expandIndexedText } from "../lib/thai-synonyms.js";
import { DEFAULT_DB_PATH } from "../lib/config.js";
import { buildScopeClause } from "../lib/scope.js";
import { runMigrations } from "./migrations.js";
import { SEARCH_INDEX_DDL } from "./search-index-schema.js";

type DbInstance = BetterSqlite3.Database;

export const DB_PATH: string =
  process.env.MEMORY_DB_PATH ?? DEFAULT_DB_PATH;

let _db: DbInstance | null = null;
let _dbInitialized = false;

function createRawDb(): DbInstance {
  try {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    return new Database(DB_PATH);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[th-memory-mcp] cannot open DB at ${DB_PATH}: ${redactSecrets(msg)}`);
    process.exit(1);
  }
}

function ensureDbInitialized(instance: DbInstance): void {
  if (_dbInitialized) return;
  instance.pragma("journal_mode = WAL");
  instance.pragma("busy_timeout = 5000");
  // Batch A-3: enforce foreign keys on every open. Tables declare
  // REFERENCES (memories.supersedes_id, relations.*, memory_links.*);
  // without this pragma SQLite silently allows orphans/dangling edges.
  instance.pragma("foreign_keys = ON");
  instance.exec(`
CREATE TABLE IF NOT EXISTS interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  meta TEXT
);

CREATE TABLE IF NOT EXISTS preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence REAL DEFAULT 0.5,
  source TEXT DEFAULT 'explicit',
  updated_at TEXT NOT NULL,
  UNIQUE(category, key)
);

CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  situation TEXT NOT NULL,
  mistake TEXT NOT NULL,
  correction TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profile (
  section TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

${SEARCH_INDEX_DDL}

CREATE TABLE IF NOT EXISTS embeddings (
  ref_table TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  vec BLOB NOT NULL,
  PRIMARY KEY (ref_table, ref_id)
);
`);
  runMigrations(instance);
  _dbInitialized = true;
}

export function getDb(): DbInstance {
  if (!_db) {
    _db = createRawDb();
  }
  ensureDbInitialized(_db);
  return _db;
}

export const db: DbInstance = new Proxy({} as DbInstance, {
  get(_target, prop) {
    const real = getDb();
    const value = (real as unknown as Record<string | symbol, unknown>)[prop];
    if (typeof value === "function") return (value as (...args: unknown[]) => unknown).bind(real);
    return value;
  },
});

export function nowISO(): string {
  return new Date().toISOString();
}

// re-exported from lib/capture-core.js (single source of truth)
export { truncate };

export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => "\\" + c);
}

function quoteFtsToken(t: string): string {
  return t.replace(/\\/g, "\\\\").replace(/"/g, '""');
}

export function buildFtsMatch(query: string): string {
  const chunks = query.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  return chunks
    .map((chunk) => {
      // A Thai chunk becomes an FTS5 phrase of its words: "ติด ตั้ง เร็ว"
      // matches the words in order, mirroring how the index was segmented.
      // Thai chunks are NEVER OR-expanded here (even when the chunk is a known
      // synonym): the locked thai_fts.test.mjs requires
      // buildFtsMatch("ติดตั้ง") to stay a single ordered phrase, and the
      // TH->EN bridge is already covered at index time (expandIndexedText) plus
      // the ASCII-chunk expansion below.
      const words = hasThai(chunk) ? segmentQueryChunk(chunk) : [chunk];
      const phrase = (words.length > 0 ? words : [chunk]).map(quoteFtsToken).join(" ");
      const base = `"${phrase}"`;
      if (hasThai(chunk)) return base;
      // Known ASCII chunk: OR the transliteration counterpart phrase(s) in, so
      // e.g. `deploy` also matches the Thai "ดี พลอย" token stream.
      const variants = expandChunkSynonyms(chunk);
      if (variants.length <= 1) return base;
      const alternatives = variants
        .slice(1)
        .map((v) => {
          const vw = hasThai(v) ? segmentQueryChunk(v) : [v];
          const vp = (vw.length > 0 ? vw : [v]).map(quoteFtsToken).join(" ");
          return `"${vp}"`;
        });
      return [base, ...alternatives].join(" OR ");
    })
    .join(" OR ");
}

let _insertSearchIndex: BetterSqlite3.Statement | null = null;
function getInsertSearchIndex(): BetterSqlite3.Statement {
  return (_insertSearchIndex ??= db.prepare(
    "INSERT INTO search_index (ref_table, ref_id, title, body) VALUES (?, ?, ?, ?)"
  ));
}
let _deleteSearchIndex: BetterSqlite3.Statement | null = null;
function getDeleteSearchIndex(): BetterSqlite3.Statement {
  return (_deleteSearchIndex ??= db.prepare(
    "DELETE FROM search_index WHERE ref_table = ? AND ref_id = ?"
  ));
}

export function syncSearchIndex(
  refTable: string,
  refId: number,
  title: string,
  body: string
): void {
  getDeleteSearchIndex().run(refTable, refId);
  // The stored text keeps the strict precedence of segmentForIndex plus (for
  // Thai-containing or known-term text) appended transliteration synonyms from
  // expandIndexedText. Display text always reads from the source tables, so
  // the appended terms never surface to output. expandIndexedText is
  // byte-idempotent under a second pass, so re-indexing an already-indexed row
  // is a fixed point.
  getInsertSearchIndex().run(
    refTable,
    refId,
    expandIndexedText(segmentForIndex(title)),
    expandIndexedText(segmentForIndex(body))
  );
}

export function removeSearchIndex(refTable: string, refId: number): void {
  getDeleteSearchIndex().run(refTable, refId);
}

// --- vector embeddings (lightweight local semantic search) ---
let _upsertEmbed: BetterSqlite3.Statement | null = null;
function getUpsertEmbed(): BetterSqlite3.Statement {
  return (_upsertEmbed ??= db.prepare(
    `INSERT INTO embeddings (ref_table, ref_id, vec) VALUES (?, ?, ?)
   ON CONFLICT(ref_table, ref_id) DO UPDATE SET vec = excluded.vec`
  ));
}
let _deleteEmbed: BetterSqlite3.Statement | null = null;
function getDeleteEmbed(): BetterSqlite3.Statement {
  return (_deleteEmbed ??= db.prepare(
    "DELETE FROM embeddings WHERE ref_table = ? AND ref_id = ?"
  ));
}
let _allEmbeds: BetterSqlite3.Statement | null = null;
function getAllEmbeds(): BetterSqlite3.Statement {
  return (_allEmbeds ??= db.prepare(
    "SELECT ref_table, ref_id, vec FROM embeddings"
  ));
}
let _scopedEmbeds: BetterSqlite3.Statement | null = null;
function getScopedEmbeds(): BetterSqlite3.Statement {
  return (_scopedEmbeds ??= db.prepare(`
  SELECT e.ref_table as ref_table, e.ref_id as ref_id, e.vec as vec
  FROM embeddings e
  JOIN memories m ON m.id = e.ref_id
  WHERE e.ref_table = 'memories'
    AND m.status = 'active'
    AND ${buildScopeClause("m").sql}
 `));
}
let _legacyEmbeds: BetterSqlite3.Statement | null = null;
function getLegacyEmbeds(): BetterSqlite3.Statement {
  return (_legacyEmbeds ??= db.prepare(
    "SELECT ref_table, ref_id, vec FROM embeddings WHERE ref_table IN ('preferences','lessons')"
  ));
}

export function upsertEmbedding(
  refTable: string,
  refId: number,
  vec: Float32Array
): void {
  getUpsertEmbed().run(refTable, refId, serialize(vec));
}

export function removeEmbedding(refTable: string, refId: number): void {
  getDeleteEmbed().run(refTable, refId);
}

export function getAllEmbeddings(opts: {
  uid?: number | null;
  sid?: string | null;
  pid?: string | null;
} = {}): {
  ref_table: string;
  ref_id: number;
  vec: Buffer;
}[] {
  const hasScopeFilter =
    opts.uid !== undefined || opts.sid !== undefined || opts.pid !== undefined;
  if (!hasScopeFilter) {
    const scope = buildScopeClause("m", {
      resolvedUid: null,
      sessionId: null,
      projectId: null,
    });
    let memRows: {
      ref_table: string;
      ref_id: number;
      vec: Buffer;
    }[] = [];
    try {
      memRows = getScopedEmbeds().all(scope.params) as {
        ref_table: string;
        ref_id: number;
        vec: Buffer;
      }[];
    } catch (e) {
      // Fail closed (SEC-14): never widen to every embedding row. Legacy
      // preferences/lessons embeddings are global by design and safe to
      // return; if that query also fails, the error propagates below.
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `[db] getAllEmbeddings: scoped memories query failed (${redactSecrets(msg)}); ` +
          `returning legacy preferences/lessons embeddings only (fail-closed)`
      );
    }
    const legacyRows = getLegacyEmbeds().all() as {
      ref_table: string;
      ref_id: number;
      vec: Buffer;
    }[];
    return [...memRows, ...legacyRows];
  }
  const uid = opts.uid ?? null;
  const sid = opts.sid ?? null;
  const pid = opts.pid ?? null;
  // Scoped read path: NO fallback — errors must propagate so a scoped caller
  // can never receive out-of-scope embeddings.
  const scope = buildScopeClause("m", {
    resolvedUid: uid,
    sessionId: sid,
    projectId: pid,
  });
  const memRows = getScopedEmbeds().all(scope.params) as {
    ref_table: string;
    ref_id: number;
    vec: Buffer;
  }[];
  const legacyRows = getLegacyEmbeds().all() as {
    ref_table: string;
    ref_id: number;
    vec: Buffer;
  }[];
  return [...memRows, ...legacyRows];
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  [key: string]: unknown;
}

export function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function err(text: string): ToolResult {
  // P2-ERROR-REDACTION: never echo raw secrets through tool error text.
  return { content: [{ type: "text", text: `error: ${truncate(redactSecrets(text), 300)}` }], isError: true };
}
