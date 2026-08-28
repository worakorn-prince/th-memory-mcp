import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { truncate } from "./lib/capture-core.js";
import { serialize } from "./lib/embed.js";
import { DEFAULT_DB_PATH } from "./lib/config.js";

type DbInstance = BetterSqlite3.Database;

export const DB_PATH: string =
  process.env.MEMORY_DB_PATH ?? DEFAULT_DB_PATH;

function initDb(): DbInstance {
  try {
    mkdirSync(dirname(DB_PATH), { recursive: true });
    return new Database(DB_PATH);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[th-memory-mcp] cannot open DB at ${DB_PATH}: ${msg}`);
    process.exit(1);
  }
}

export const db: DbInstance = initDb();

db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

db.exec(`
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
  return tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" ");
}

const insertSearchIndex = db.prepare(
  "INSERT INTO search_index (ref_table, ref_id, title, body) VALUES (?, ?, ?, ?)"
);
const deleteSearchIndex = db.prepare(
  "DELETE FROM search_index WHERE ref_table = ? AND ref_id = ?"
);

export function syncSearchIndex(
  refTable: string,
  refId: number,
  title: string,
  body: string
): void {
  deleteSearchIndex.run(refTable, refId);
  insertSearchIndex.run(refTable, refId, title, body);
}

export function removeSearchIndex(refTable: string, refId: number): void {
  deleteSearchIndex.run(refTable, refId);
}

// --- vector embeddings (lightweight local semantic search) ---
const upsertEmbed = db.prepare(
  `INSERT INTO embeddings (ref_table, ref_id, vec) VALUES (?, ?, ?)
   ON CONFLICT(ref_table, ref_id) DO UPDATE SET vec = excluded.vec`
);
const deleteEmbed = db.prepare(
  "DELETE FROM embeddings WHERE ref_table = ? AND ref_id = ?"
);
const allEmbeds = db.prepare(
  "SELECT ref_table, ref_id, vec FROM embeddings"
);

export function upsertEmbedding(
  refTable: string,
  refId: number,
  vec: Float32Array
): void {
  upsertEmbed.run(refTable, refId, serialize(vec));
}

export function removeEmbedding(refTable: string, refId: number): void {
  deleteEmbed.run(refTable, refId);
}

export function getAllEmbeddings(): {
  ref_table: string;
  ref_id: number;
  vec: Buffer;
}[] {
  return allEmbeds.all() as { ref_table: string; ref_id: number; vec: Buffer }[];
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  [key: string]: unknown;
}

export function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function err(text: string): ToolResult {
  return ok(`error: ${truncate(text, 300)}`);
}
