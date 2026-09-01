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
import { serialize } from "../lib/embed.js";
import { DEFAULT_DB_PATH } from "../lib/config.js";
import { runMigrations } from "./migrations.js";

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
    console.error(`[th-memory-mcp] cannot open DB at ${DB_PATH}: ${msg}`);
    process.exit(1);
  }
}

function ensureDbInitialized(instance: DbInstance): void {
  if (_dbInitialized) return;
  instance.pragma("journal_mode = WAL");
  instance.pragma("busy_timeout = 5000");
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

CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  ref_table, ref_id, title, body
);

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

export function buildFtsMatch(query: string): string {
  const tokens = query.trim().split(/\s+/).filter(Boolean).slice(0, 8);
  return tokens
    .map((t) => {
      const safe = t.replace(/\\/g, "\\\\").replace(/"/g, '""');
      return `"${safe}"`;
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
  getInsertSearchIndex().run(refTable, refId, title, body);
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
    AND (m.scope = 'GLOBAL'
         OR (m.scope = 'USER' AND m.user_id = @uid)
         OR (m.scope = 'SESSION' AND m.session_id = @sid)
         OR (m.scope = 'PROJECT' AND m.project_id = @pid))
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
    const uid = null;
    const sid = null;
    const pid = null;
    try {
      const memRows = getScopedEmbeds().all({ uid, sid, pid }) as {
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
    } catch {
      return getAllEmbeds().all() as {
        ref_table: string;
        ref_id: number;
        vec: Buffer;
      }[];
    }
  }
  const uid = opts.uid ?? null;
  const sid = opts.sid ?? null;
  const pid = opts.pid ?? null;
  const memRows = getScopedEmbeds().all({ uid, sid, pid }) as {
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
  return { content: [{ type: "text", text: `error: ${truncate(text, 300)}` }], isError: true };
}
