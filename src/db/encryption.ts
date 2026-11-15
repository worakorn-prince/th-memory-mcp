/**
 * Encryption (Ph-4, hardened in Ph-6 A1..A3) — SQLCipher via
 * better-sqlite3-multiple-ciphers.
 *
 * This module handles:
 *   - Key validation & decoding (base64 32-byte key)
 *   - One-time migration: plaintext DB → encrypted (ATTACH copy + atomic replace)
 *   - Crash recovery for an interrupted migration (tmp/bak states)
 *   - Opening encrypted DB with proper pragmas and reading real data to verify
 *   - Migration idempotency via schema_meta marker
 *
 * ADR constraints (from ADR-AUTH-P0-SPIKE §6):
 *   - better-sqlite3-multiple-ciphers@13.1.1 pinned
 *   - Migration = copy through ATTACH (sqlcipher_export is NOT used for this path)
 *   - Backup = VACUUM INTO (encrypted)
 *   - NEVER sqlcipher_export for backup, NEVER db.backup(), NEVER raw file copy
 *
 * Migration shape (Ph-6 A1): the copy is pure SQL — no row ever enters JS.
 * Ordinary tables are created from their own DDL and copied with explicit
 * column lists; FTS5 virtual tables are created from their `CREATE VIRTUAL
 * TABLE` DDL (so FTS5 builds its own shadow tables) and then filled with
 * `INSERT INTO ... (rowid, <cols>) SELECT rowid, <cols> ...`. Shadow tables
 * (`_data`, `_idx`, `_content`, `_docsize`, `_config`) are never created or
 * copied by us — recreating them is reserved to SQLite and fails with
 * "object name reserved for internal use".
 */

import Database from "better-sqlite3-multiple-ciphers";
import type { Database as DatabaseType } from "better-sqlite3-multiple-ciphers";
import { renameSync, unlinkSync, existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const PAGE_SIZE = 4096;
export const KDF_ITER_DEFAULT = 256000;
export const MIGRATION_MARKER_KEY = "encryption_migrated";

/** FTS5 shadow-table suffixes. Derived per virtual table: `<vt><suffix>`. */
export const SHADOW_SUFFIXES = ["_data", "_idx", "_content", "_docsize", "_config"] as const;

/** Single user-facing failure for a wrong key / corrupted encrypted file. */
export const WRONG_KEY_ERROR = "cannot open encrypted database: wrong key or corrupted file";

/**
 * Keys of connections opened by this module, so backupEncryptedDB() can prove a
 * copy opens with the same key without widening its public signature. The map
 * is weak: closing a handle releases its entry, and the key never leaves here.
 */
const OPEN_KEYS = new WeakMap<object, { keyHex: string; kdfIter: number }>();


/**
 * Deterministic copy order. Foreign-key parents come first; `foreign_keys=OFF`
 * during the copy makes the order non-fatal, but it keeps dumps reproducible.
 */
const FOREIGN_KEY_ORDER = [
  "users",
  "memories",
  "entities",
  "relations",
  "memory_links",
  "preferences",
  "lessons",
  "profile",
  "interactions",
  "schema_meta",
  "embeddings",
  "search_index_keys",
  "thai_dict",
  "auth_tokens",
  "scope_grants",
  "audit_log",
];

const CREATE_VIRTUAL_TABLE_RE = /^\s*CREATE\s+VIRTUAL\s+TABLE\b/i;
const TOKEN_RE = /[\p{L}\p{N}]+/gu;

type MasterRow = { type: string; name: string; tbl_name: string; sql: string | null };
type TablePlan = { name: string; sql: string; columns: string[]; rowCount: number };
type VirtualTablePlan = TablePlan & { matchTerm: string | null; matchCount: number };
type CopyPlan = {
  tables: TablePlan[];
  virtualTables: VirtualTablePlan[];
  indexes: { name: string; sql: string }[];
  triggers: { name: string; sql: string }[];
};

/**
 * Convert Uint8Array key to hex string for SQLCipher pragma.
 */
export function keyToHex(key: Uint8Array): string {
  return Array.from(key)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Record the key of a connection this module did not open itself (the CLI's
 * read-only admin handle). Backup verification needs it: a copy is only
 * accepted once it opens with the key the source was read with.
 */
export function registerDatabaseKey(
  db: DatabaseType,
  key: Uint8Array,
  kdfIter: number = KDF_ITER_DEFAULT
): void {
  OPEN_KEYS.set(db, { keyHex: keyToHex(key), kdfIter });
}

/**
 * Whether this connection has a key on record (this module opened it, or
 * `registerDatabaseKey()` recorded one). Callers use it to decide that a key
 * must be resolved elsewhere: a proxy over the connection is a different
 * object, so the identity lookup misses even though the data is readable.
 */
export function hasRegisteredDatabaseKey(db: DatabaseType): boolean {
  return OPEN_KEYS.has(db);
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function applyKeyPragmas(db: DatabaseType, keyHex: string, kdfIter: number): void {
  db.pragma(`key = "x'${keyHex}'"`);
  db.pragma(`kdf_iter = ${kdfIter}`);
  db.pragma(`page_size = ${PAGE_SIZE}`);
}

/**
 * A3: prove the key by reading real pages. `cipher_version` only reports the
 * library version, so the schema read (plus a `schema_meta` read when the table
 * exists) is what decides whether the key is right.
 */
function readCanary(db: DatabaseType): void {
  db.prepare("SELECT count(*) AS c FROM sqlite_master").get();
  const meta = db
    .prepare("SELECT count(*) AS c FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
    .get() as { c: number };
  if (meta.c > 0) {
    db.prepare("SELECT value FROM schema_meta WHERE key = ?").get("schema_version");
  }
}

function integrityOk(db: DatabaseType): boolean {
  try {
    const rows = db.pragma("integrity_check") as { integrity_check: string }[];
    return rows.length === 1 && rows[0]?.integrity_check === "ok";
  } catch {
    return false;
  }
}

function countRows(db: DatabaseType, fromClause: string): number {
  const row = db.prepare(`SELECT count(*) AS c FROM ${fromClause}`).get() as { c: number };
  return row.c;
}

function columnNames(db: DatabaseType, table: string, schema?: string): string[] {
  const rows = (
    schema
      ? db.prepare("SELECT name FROM pragma_table_info(?, ?)").all(table, schema)
      : db.prepare("SELECT name FROM pragma_table_info(?)").all(table)
  ) as { name: string }[];
  return rows.map((r) => r.name);
}

function deleteSqliteFiles(basePath: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const target = basePath + suffix;
    if (!existsSync(target)) continue;
    try {
      unlinkSync(target);
    } catch {
      // Windows may hold a handle briefly; the caller retries or keeps the file.
    }
  }
}

function moveSqliteSidecars(fromPath: string, toPath: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const from = fromPath + suffix;
    if (!existsSync(from)) continue;
    try {
      renameSync(from, toPath + suffix);
    } catch {
      // Non-fatal: the copy already read every committed page.
    }
  }
}

/** Monotonic counter for backup staging names (unique per process). */
let backupStageAttempt = 0;

/**
 * Staging path for a backup target, as a hidden sibling (`.<name>.staging-…`).
 * The leading dot keeps it out of the `<db>.backup-*` set that `db drill` and
 * `pruneOldBackups()` scan, so a killed backup can never be mistaken for the
 * newest backup or consume a generation slot.
 */
function stagePathFor(target: string): string {
  return join(dirname(target), `.${basename(target)}.staging-${process.pid}-${backupStageAttempt++}`);
}

/** Staging artifacts that must never count as a backup generation. */
export const BACKUP_STAGING_RE = /\.(?:staging|tmp)-\d+-\d+(?:-journal|-wal|-shm)?$/;

/**
 * Open an encrypted database with the given key.
 * A wrong key or a corrupted file throws WRONG_KEY_ERROR.
 */
export function openEncryptedDB(dbPath: string, key: Uint8Array, kdfIter: number = KDF_ITER_DEFAULT): DatabaseType {
  const db = new Database(dbPath, {
    fileMustExist: false,
  }) as DatabaseType;

  try {
    applyKeyPragmas(db, keyToHex(key), kdfIter);
    readCanary(db);
  } catch {
    try {
      db.close();
    } catch {
      // ignore close failure on a half-open handle
    }
    throw new Error(WRONG_KEY_ERROR);
  }

  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  OPEN_KEYS.set(db, { keyHex: keyToHex(key), kdfIter });
  return db;
}

/**
 * Check if a DB file is already encrypted with the given key.
 * Returns true if the file exists and its schema can be read with the key.
 */
export function isEncrypted(dbPath: string, key: Uint8Array, kdfIter: number = KDF_ITER_DEFAULT): boolean {
  if (!existsSync(dbPath)) return false;
  if (isPlaintextDB(dbPath)) return false;
  let db: DatabaseType | null = null;
  try {
    db = new Database(dbPath, { readonly: true }) as DatabaseType;
    applyKeyPragmas(db, keyToHex(key), kdfIter);
    readCanary(db);
    return true;
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Check if DB has the migration marker in schema_meta.
 */
export function hasMigrationMarker(dbPath: string, key: Uint8Array, kdfIter: number = KDF_ITER_DEFAULT): boolean {
  if (!existsSync(dbPath)) return false;
  let db: DatabaseType | null = null;
  try {
    db = openEncryptedDB(dbPath, key, kdfIter);
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(MIGRATION_MARKER_KEY) as
      | { value: string }
      | undefined;
    return row?.value === "1";
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Check if a DB file is plaintext (not encrypted).
 * Returns true if file exists and is valid SQLite but NOT encrypted with our key.
 */
export function isPlaintextDB(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false;
  let db: DatabaseType | null = null;
  try {
    db = new Database(dbPath, { readonly: true }) as DatabaseType;
    db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
    return true;
  } catch {
    return false;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Migrate plaintext DB to encrypted DB (ATTACH copy + atomic replace).
 * This runs ONCE per database lifecycle.
 * Returns true if migration ran, false if already encrypted/no migration needed.
 */
export function migrateIfNeeded(dbPath: string, key: Uint8Array, kdfIter: number = KDF_ITER_DEFAULT): boolean {
  // If DB doesn't exist, nothing to migrate (will be created encrypted on first open)
  if (!existsSync(dbPath)) return false;

  // Finish or roll back an interrupted migration before looking at the DB.
  recoverEncryptionState(dbPath, key, kdfIter);

  // If already encrypted with our key, check migration marker
  if (isEncrypted(dbPath, key, kdfIter)) {
    if (hasMigrationMarker(dbPath, key, kdfIter)) {
      return false; // Already migrated
    }
    // Encrypted but no marker - treat as already migrated (legacy encrypted DB)
    // Write marker for future idempotency
    let db: DatabaseType | null = null;
    try {
      db = openEncryptedDB(dbPath, key, kdfIter);
      db.prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)").run(MIGRATION_MARKER_KEY, "1");
    } catch {
      // Ignore marker write failure
    } finally {
      try {
        db?.close();
      } catch {
        // ignore
      }
    }
    return false;
  }

  // If plaintext DB, migrate it
  if (isPlaintextDB(dbPath)) {
    return runMigration(dbPath, key, kdfIter);
  }

  // Unknown state (corrupted, wrong key, etc.) - let caller handle
  return false;
}

/**
 * Checkpoint any WAL content into the plaintext main file so the rename in the
 * replacement step cannot strand committed pages inside `-wal`.
 * Best effort: ATTACH still reads live WAL content if the checkpoint fails.
 */
function checkpointPlaintext(dbPath: string): void {
  let db: DatabaseType | null = null;
  try {
    db = new Database(dbPath) as DatabaseType;
    db.pragma("busy_timeout = 5000");
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch {
    // ignore - the copy step reads whatever the source can serve
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

function compareTableNames(a: string, b: string): number {
  const rank = (name: string): number => {
    const idx = FOREIGN_KEY_ORDER.indexOf(name);
    return idx === -1 ? FOREIGN_KEY_ORDER.length : idx;
  };
  const delta = rank(a) - rank(b);
  return delta !== 0 ? delta : a.localeCompare(b);
}

function collectTokens(text: string, out: Set<string>, max: number): void {
  for (const match of text.matchAll(TOKEN_RE)) {
    const token = match[0];
    if (token.length >= 2) {
      out.add(token);
      if (out.size >= max) return;
    }
  }
}

/**
 * Find tokens that the *source* FTS5 table actually indexes, so the post-copy
 * MATCH sanity check cannot produce a false negative. Content rows are the
 * first choice; `fts5vocab` is the fallback for contentless tables.
 */
function candidateTokens(db: DatabaseType, vtName: string): string[] {
  const tokens = new Set<string>();
  const contentName = `${vtName}_content`;
  const hasContent =
    (
      db
        .prepare("SELECT count(*) AS c FROM src.sqlite_master WHERE type = 'table' AND name = ?")
        .get(contentName) as { c: number }
    ).c > 0;

  if (hasContent) {
    const contentCols = columnNames(db, contentName, "src").filter((c) => c !== "id");
    for (const col of [...contentCols].reverse()) {
      const rows = db
        .prepare(
          `SELECT ${quoteIdent(col)} AS v FROM src.${quoteIdent(contentName)} ` +
            `WHERE ${quoteIdent(col)} IS NOT NULL AND ${quoteIdent(col)} <> '' LIMIT 5`
        )
        .all() as { v: unknown }[];
      for (const row of rows) {
        if (typeof row.v === "string") collectTokens(row.v, tokens, 12);
      }
      if (tokens.size > 0) break;
    }
  }

  if (tokens.size === 0) {
    try {
      db.exec(`CREATE VIRTUAL TABLE temp."p6_vocab" USING fts5vocab('src', ${sqlString(vtName)}, 'row')`);
      try {
        const rows = db
          .prepare(`SELECT term FROM temp."p6_vocab" WHERE term GLOB '*[^0-9]*' LIMIT 12`)
          .all() as { term: string }[];
        for (const row of rows) {
          if (row.term && !/\s/.test(row.term)) tokens.add(row.term);
        }
      } finally {
        try {
          db.exec(`DROP TABLE temp."p6_vocab"`);
        } catch {
          // temp table disappears with the connection anyway
        }
      }
    } catch {
      // fts5vocab unavailable in this build - fall through
    }
  }

  return [...tokens];
}

function matchCount(db: DatabaseType, fromClause: string, vtName: string, term: string): number {
  const row = db
    .prepare(`SELECT count(*) AS c FROM ${fromClause} WHERE ${quoteIdent(vtName)} MATCH ?`)
    .get(term) as { c: number };
  return row.c;
}

function planCopy(target: DatabaseType): CopyPlan {
  const objects = target.prepare("SELECT type, name, tbl_name, sql FROM src.sqlite_master").all() as MasterRow[];

  const virtual = objects.filter(
    (o) => o.type === "table" && o.sql !== null && CREATE_VIRTUAL_TABLE_RE.test(o.sql)
  );
  const virtualNames = new Set(virtual.map((v) => v.name));
  const shadowNames = new Set<string>();
  for (const name of virtualNames) {
    for (const suffix of SHADOW_SUFFIXES) shadowNames.add(name + suffix);
  }

  const ordinary = objects.filter(
    (o) =>
      o.type === "table" &&
      o.sql !== null &&
      !o.name.startsWith("sqlite_") &&
      !virtualNames.has(o.name) &&
      !shadowNames.has(o.name)
  );
  ordinary.sort((a, b) => compareTableNames(a.name, b.name));

  const tables: TablePlan[] = ordinary.map((o) => ({
    name: o.name,
    sql: o.sql as string,
    columns: columnNames(target, o.name, "src"),
    rowCount: countRows(target, `src.${quoteIdent(o.name)}`),
  }));

  // Must run before the target's virtual tables exist: the MATCH operand is the
  // bare table name, which would be ambiguous with the same name in `main`.
  const virtualTables: VirtualTablePlan[] = virtual.map((v) => {
    const rowCount = countRows(target, `src.${quoteIdent(v.name)}`);
    let matchTerm: string | null = null;
    let matchHits = 0;
    if (rowCount > 0) {
      for (const term of candidateTokens(target, v.name)) {
        const hits = matchCount(target, `src.${quoteIdent(v.name)}`, v.name, term);
        if (hits > 0) {
          matchTerm = term;
          matchHits = hits;
          break;
        }
      }
      if (matchTerm === null) {
        throw new Error(`cannot verify virtual table ${v.name}: no indexed token found in source`);
      }
    }
    return {
      name: v.name,
      sql: v.sql as string,
      columns: columnNames(target, v.name, "src"),
      rowCount,
      matchTerm,
      matchCount: matchHits,
    };
  });

  // Indexes/triggers only for ordinary tables (never for shadow tables, which
  // FTS5 owns; auto-indexes have sql IS NULL and are filtered out).
  const indexes = objects
    .filter(
      (o) =>
        o.type === "index" &&
        o.sql !== null &&
        !shadowNames.has(o.tbl_name) &&
        !virtualNames.has(o.tbl_name)
    )
    .map((o) => ({ name: o.name, sql: o.sql as string }));
  const triggers = objects
    .filter(
      (o) => o.type === "trigger" && o.sql !== null && !shadowNames.has(o.tbl_name) && !virtualNames.has(o.tbl_name)
    )
    .map((o) => ({ name: o.name, sql: o.sql as string }));

  return { tables, virtualTables, indexes, triggers };
}

function applySchema(target: DatabaseType, plan: CopyPlan): void {
  for (const table of plan.tables) target.exec(table.sql);
  for (const vt of plan.virtualTables) target.exec(vt.sql);
  for (const index of plan.indexes) {
    try {
      target.exec(index.sql);
    } catch (e) {
      throw new Error(`migration failed: cannot recreate index ${index.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const trigger of plan.triggers) {
    try {
      target.exec(trigger.sql);
    } catch (e) {
      throw new Error(`migration failed: cannot recreate trigger ${trigger.name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

function copyData(target: DatabaseType, plan: CopyPlan): void {
  for (const table of plan.tables) {
    if (table.columns.length === 0) continue;
    const cols = table.columns.map(quoteIdent).join(", ");
    target.exec(`INSERT INTO main.${quoteIdent(table.name)} (${cols}) SELECT ${cols} FROM src.${quoteIdent(table.name)}`);
  }
  for (const vt of plan.virtualTables) {
    if (vt.columns.length === 0) continue;
    const cols = vt.columns.map(quoteIdent).join(", ");
    target.exec(
      `INSERT INTO main.${quoteIdent(vt.name)} (rowid, ${cols}) ` +
        `SELECT rowid, ${cols} FROM src.${quoteIdent(vt.name)}`
    );
  }
}

/**
 * Copy `sqlite_sequence` when the source has it: AUTOINCREMENT counters must not
 * roll back to `max(id)` after the copy (a deleted highest row would let the
 * next insert reuse its id). The target's table is rewritten from the source,
 * because the data copy already bumped its counters.
 */
function copySequence(target: DatabaseType): void {
  const hasTable = (schema: string): boolean =>
    (
      target
        .prepare(
          `SELECT count(*) AS c FROM ${schema}.sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'`
        )
        .get() as { c: number }
    ).c > 0;
  if (!hasTable("src")) return;
  // A source counter implies an AUTOINCREMENT table, whose DDL created the
  // target side already; a missing target is therefore nothing to copy into.
  if (!hasTable("main")) return;
  target.exec("DELETE FROM main.sqlite_sequence");
  target.exec("INSERT INTO main.sqlite_sequence (name, seq) SELECT name, seq FROM src.sqlite_sequence");
  const expected = countRows(target, "src.sqlite_sequence");
  const actual = countRows(target, "main.sqlite_sequence");
  if (actual !== expected) {
    throw new Error(
      `migration verification failed: sqlite_sequence has ${actual} rows, source had ${expected}`
    );
  }
}

function verifyCopy(target: DatabaseType, plan: CopyPlan): void {
  if (!integrityOk(target)) {
    throw new Error("migration verification failed: integrity_check did not return ok");
  }
  for (const table of plan.tables) {
    const actual = countRows(target, `main.${quoteIdent(table.name)}`);
    if (actual !== table.rowCount) {
      throw new Error(
        `migration verification failed: table ${table.name} has ${actual} rows, source had ${table.rowCount}`
      );
    }
  }
  for (const vt of plan.virtualTables) {
    const actual = countRows(target, `main.${quoteIdent(vt.name)}`);
    if (actual !== vt.rowCount) {
      throw new Error(
        `migration verification failed: virtual table ${vt.name} has ${actual} rows, source had ${vt.rowCount}`
      );
    }
    if (vt.matchTerm !== null) {
      const hits = matchCount(target, `main.${quoteIdent(vt.name)}`, vt.name, vt.matchTerm);
      if (hits !== vt.matchCount) {
        throw new Error(
          `migration verification failed: virtual table ${vt.name} MATCH sanity check returned ${hits} rows, source returned ${vt.matchCount}`
        );
      }
    }
  }
}

/** A2 step 6: the promoted file must carry the idempotency marker. */
function writeMigrationMarker(target: DatabaseType): void {
  target.exec("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  target
    .prepare("INSERT OR REPLACE INTO schema_meta (key, value) VALUES (?, ?)")
    .run(MIGRATION_MARKER_KEY, "1");
}

/**
 * Build the encrypted copy of a plaintext DB in `<db>.enc.tmp`, verify it, then
 * replace the original atomically:
 *
 *   tmp → verify → bak = rename(db) → db = rename(tmp) → verify db → unlink(bak)
 *
 * The original is never deleted before a verified replacement exists.
 */
function runMigration(dbPath: string, key: Uint8Array, kdfIter: number): boolean {
  const keyHex = keyToHex(key);
  const tmpPath = `${dbPath}.enc.tmp`;
  const bakPath = `${dbPath}.enc.bak`;

  deleteSqliteFiles(tmpPath);
  deleteSqliteFiles(bakPath);
  checkpointPlaintext(dbPath);

  let failure: unknown = null;
  let target: DatabaseType | null = null;
  try {
    target = new Database(tmpPath) as DatabaseType;
    applyKeyPragmas(target, keyHex, kdfIter);
    // Delete-journal while building: the tmp file must be self-contained so a
    // later rename cannot strand pages in `tmp-wal`.
    target.pragma("journal_mode = DELETE");
    target.pragma("busy_timeout = 5000");
    target.pragma("foreign_keys = OFF");

    target.exec(`ATTACH DATABASE ${sqlString(dbPath)} AS src KEY ''`);
    let plan: CopyPlan | null = null;
    try {
      plan = planCopy(target);
      applySchema(target, plan);
      copyData(target, plan);
      copySequence(target);
    } finally {
      try {
        target.exec("DETACH DATABASE src");
      } catch {
        // keep the original failure as the reported one
      }
    }
    if (plan === null) throw new Error("migration failed: no copy plan produced");
    // Source is detached here: the MATCH operand is the bare table name, which
    // is only unambiguous against `main`.
    verifyCopy(target, plan);
    writeMigrationMarker(target);
    target.pragma("foreign_keys = ON");
  } catch (e) {
    failure = e;
  } finally {
    try {
      target?.close();
    } catch {
      // ignore
    }
  }

  if (failure !== null) {
    deleteSqliteFiles(tmpPath);
    throw failure;
  }

  // Replacement: original → bak → tmp → db. A crash at any point is repaired by
  // recoverEncryptionState() on the next start.
  try {
    renameSync(dbPath, bakPath);
  } catch (e) {
    deleteSqliteFiles(tmpPath);
    throw e;
  }
  moveSqliteSidecars(dbPath, bakPath);

  try {
    renameSync(tmpPath, dbPath);
  } catch (e) {
    // Restore the original so the tree is never left without a database.
    try {
      renameSync(bakPath, dbPath);
      moveSqliteSidecars(bakPath, dbPath);
    } catch {
      // ignore - recovery will restore bak on the next start
    }
    deleteSqliteFiles(tmpPath);
    throw e;
  }

  // Belt and braces: reopen the promoted file with the key and confirm the
  // marker. Anything wrong here falls back to the preserved original.
  let promoted: DatabaseType | null = null;
  try {
    promoted = openEncryptedDB(dbPath, key, kdfIter);
    readCanary(promoted);
    const marker = promoted.prepare("SELECT value FROM schema_meta WHERE key = ?").get(MIGRATION_MARKER_KEY) as
      | { value: string }
      | undefined;
    if (marker?.value !== "1") throw new Error("migration failed: marker missing after replacement");
  } catch (e) {
    try {
      promoted?.close();
    } catch {
      // ignore
    }
    promoted = null;
    deleteSqliteFiles(dbPath);
    try {
      renameSync(bakPath, dbPath);
      moveSqliteSidecars(bakPath, dbPath);
    } catch {
      // ignore - recovery will restore bak on the next start
    }
    throw e;
  } finally {
    try {
      promoted?.close();
    } catch {
      // ignore
    }
  }

  deleteSqliteFiles(bakPath);
  return true;
}

/**
 * Recovery must never mistake "could not look" for "corrupt": only an explicit
 * `integrity_check` failure condemns a file, so `unreadable` (wrong key, a lock
 * held by another process, an I/O error) is reported and nothing is renamed.
 */
type DatabaseFileState = "usable" | "corrupt" | "unreadable";

/** Bounded probe: a lock held by a live server must not stall startup. */
const RECOVERY_PROBE_TIMEOUT_MS = 500;

/** One stderr line must stay one bounded line, whatever the driver says. */
const REASON_MAX = 200;

function boundedReason(text: string): string {
  const flat = text.replace(/[\r\n]+/g, " ").trim();
  return flat.length > REASON_MAX ? flat.slice(0, REASON_MAX) : flat;
}

function inspectDatabaseFile(
  dbPath: string,
  key: Uint8Array,
  kdfIter: number
): { state: DatabaseFileState; reason?: string } {
  if (!existsSync(dbPath)) return { state: "unreadable", reason: "the file is missing" };

  if (isPlaintextDB(dbPath)) {
    let plain: DatabaseType | null = null;
    try {
      plain = new Database(dbPath, { timeout: RECOVERY_PROBE_TIMEOUT_MS }) as DatabaseType;
      const rows = plain.pragma("integrity_check") as { integrity_check: string }[];
      return rows.length === 1 && rows[0]?.integrity_check === "ok"
        ? { state: "usable" }
        : { state: "corrupt", reason: "integrity_check failed" };
    } catch (e) {
      return { state: "unreadable", reason: boundedReason(errText(e)) };
    } finally {
      try {
        plain?.close();
      } catch {
        // ignore
      }
    }
  }

  let encrypted: DatabaseType | null = null;
  try {
    encrypted = openEncryptedDB(dbPath, key, kdfIter);
    const rows = encrypted.pragma("integrity_check") as { integrity_check: string }[];
    return rows.length === 1 && rows[0]?.integrity_check === "ok"
      ? { state: "usable" }
      : { state: "corrupt", reason: "integrity_check failed" };
  } catch (e) {
    // Wrong key, a lock, or an unreadable header: say so, change nothing.
    return { state: "unreadable", reason: boundedReason(errText(e)) };
  } finally {
    try {
      encrypted?.close();
    } catch {
      // ignore
    }
  }
}

/**
 * A2: repair the states an interrupted migration can leave behind.
 *
 * | state              | action                                              |
 * |--------------------|-----------------------------------------------------|
 * | tmp, no db         | promote tmp when it verifies, else discard tmp       |
 * | bak, no db         | restore bak (crash between the two renames)          |
 * | bak + db           | keep db when it verifies, else restore bak           |
 * | tmp + db           | db is authoritative, discard tmp                     |
 * | rekey.tmp          | discard (never the only copy: rekey keeps db/bak)    |
 *
 * "Verifies" means an explicit `integrity_check` failure only: a wrong key, a
 * lock held by another process or an unreadable file is *not* corruption, so
 * both files are left untouched and one bounded line says why.
 * Idempotent; never deletes the only good copy; writes at most one stderr line.
 * Returns the actions taken (empty when nothing was found).
 */
export function recoverEncryptionState(
  dbPath: string,
  key: Uint8Array,
  kdfIter: number = KDF_ITER_DEFAULT
): string[] {
  const tmpPath = `${dbPath}.enc.tmp`;
  const bakPath = `${dbPath}.enc.bak`;
  const rekeyTmpPath = `${dbPath}.rekey.tmp`;
  const actions: string[] = [];

  // A rekey temp is a rebuild-from-source artifact: the database itself is
  // renamed aside only after that temp verifies, so it is never the only copy.
  if (existsSync(rekeyTmpPath)) {
    deleteSqliteFiles(rekeyTmpPath);
    actions.push("discarded stale .rekey.tmp");
  }

  const hasTmp = existsSync(tmpPath);
  const hasBak = existsSync(bakPath);
  if (!hasTmp && !hasBak) {
    if (actions.length > 0) {
      console.error(`[th-memory-mcp] encryption recovery: ${actions.join("; ")}`);
    }
    return actions;
  }

  if (hasTmp) {
    if (!existsSync(dbPath)) {
      const tmpState = inspectDatabaseFile(tmpPath, key, kdfIter);
      if (tmpState.state === "usable") {
        renameSync(tmpPath, dbPath);
        moveSqliteSidecars(tmpPath, dbPath);
        actions.push("promoted verified .enc.tmp to the database file (database file was missing)");
      } else if (tmpState.state === "corrupt") {
        deleteSqliteFiles(tmpPath);
        actions.push("discarded unreadable .enc.tmp (database file was missing)");
      } else {
        actions.push(
          `cannot inspect .enc.tmp (${tmpState.reason ?? "unknown reason"}); left it untouched`
        );
      }
    } else {
      deleteSqliteFiles(tmpPath);
      actions.push("discarded stale .enc.tmp (database file present)");
    }
  }

  if (hasBak) {
    if (!existsSync(dbPath)) {
      renameSync(bakPath, dbPath);
      moveSqliteSidecars(bakPath, dbPath);
      actions.push("restored .enc.bak (database file was missing)");
    } else {
      const liveState = inspectDatabaseFile(dbPath, key, kdfIter);
      if (liveState.state === "usable") {
        deleteSqliteFiles(bakPath);
        actions.push("removed .enc.bak (database file verified)");
      } else if (liveState.state === "corrupt") {
        const badPath = `${dbPath}.corrupt`;
        deleteSqliteFiles(badPath);
        renameSync(dbPath, badPath);
        moveSqliteSidecars(dbPath, badPath);
        renameSync(bakPath, dbPath);
        moveSqliteSidecars(bakPath, dbPath);
        actions.push("restored .enc.bak (database file unreadable; previous file kept as .corrupt)");
      } else {
        // Wrong key / locked / unreadable: neither file is condemned, so both
        // stay exactly as they are and the operator gets one bounded line.
        actions.push(
          `cannot inspect ${dbPath} (${liveState.reason ?? "unknown reason"}); left the database and ${bakPath} untouched`
        );
      }
    }
  }

  if (actions.length > 0) {
    console.error(`[th-memory-mcp] encryption recovery: ${actions.join("; ")}`);
  }
  return actions;
}

/**
 * Create a new encrypted DB (for fresh installs).
 * Just opens with key - SQLCipher creates encrypted file automatically.
 */
export function createEncryptedDB(dbPath: string, key: Uint8Array, kdfIter: number = KDF_ITER_DEFAULT): DatabaseType {
  return openEncryptedDB(dbPath, key, kdfIter);
}

/**
 * Prove a fresh vacuum target is a complete, intelligible encrypted copy:
 * non-empty, page-aligned, not plaintext SQLite, and readable with the
 * connection's key plus integrity-clean.
 *
 * Fail closed: without a key on record the structural checks cannot tell a
 * page-aligned partial VACUUM from a complete copy, so the backup is refused
 * instead of accepted. Every production caller vacuums from a connection this
 * module opened (`openEncryptedDB`), so the key is always known there.
 */
function verifyBackupCopy(tmpPath: string, known: { keyHex: string; kdfIter: number } | undefined): void {
  let size = 0;
  try {
    size = statSync(tmpPath).size;
  } catch {
    throw new Error("backup copy was not created");
  }
  if (size === 0) throw new Error("backup copy is empty");
  if (isPlaintextDB(tmpPath)) throw new Error("backup copy is not encrypted");
  if (size % PAGE_SIZE !== 0) {
    throw new Error(`backup copy is ${size} bytes, not a whole number of ${PAGE_SIZE}-byte pages`);
  }
  if (known === undefined) {
    throw new Error("cannot verify a backup copy without the database key");
  }

  let db: DatabaseType | null = null;
  try {
    db = new Database(tmpPath, { readonly: true }) as DatabaseType;
    db.pragma(`key = "x'${known.keyHex}'"`);
    db.pragma(`kdf_iter = ${known.kdfIter}`);
    db.prepare("SELECT count(*) AS c FROM sqlite_master").get();
    if (!integrityOk(db)) throw new Error("integrity_check did not return ok");
  } catch (e) {
    throw new Error(
      `backup copy does not open with the database key: ${e instanceof Error ? e.message : String(e)}`
    );
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** C3: what a backup file turned out to be. */
export interface BackupVerifyResult {
  exists: boolean;
  size: number;
  encrypted: boolean;
  integrityOk: boolean;
  tables: Record<string, number>;
}

/** Ordinary tables plus FTS virtual tables; FTS shadow tables stay out. */
function listedTables(db: DatabaseType): { ordinary: string[]; virtual: string[] } {
  const objects = db.prepare("SELECT type, name, sql FROM sqlite_master WHERE type = 'table'").all() as {
    name: string;
    sql: string | null;
  }[];
  const virtual = objects
    .filter((o) => o.sql !== null && CREATE_VIRTUAL_TABLE_RE.test(o.sql))
    .map((o) => o.name)
    .sort();
  const virtualNames = new Set(virtual);
  const shadowNames = new Set<string>();
  for (const name of virtualNames) {
    for (const suffix of SHADOW_SUFFIXES) shadowNames.add(name + suffix);
  }
  const ordinary = objects
    .filter((o) => !o.name.startsWith("sqlite_") && !virtualNames.has(o.name) && !shadowNames.has(o.name))
    .map((o) => o.name)
    .sort();
  return { ordinary, virtual };
}

/**
 * Row counts for every table present in an open handle. The rekey parity check
 * and `th-memory db drill` (live DB, read-only) both use it.
 */
export function countTableRows(db: DatabaseType): Record<string, number> {
  const { ordinary, virtual } = listedTables(db);
  const counts: Record<string, number> = {};
  for (const name of ordinary) counts[name] = countRows(db, quoteIdent(name));
  for (const name of virtual) counts[name] = countRows(db, quoteIdent(name));
  return counts;
}

/**
 * C3: prove a backup opens with the key, is integrity-clean, and report the row
 * count of every table it holds. Never throws on a damaged file — the result
 * says what is wrong and the caller owns the exit code.
 */
export function verifyEncryptedBackup(
  path: string,
  key: Uint8Array,
  kdfIter: number = KDF_ITER_DEFAULT
): BackupVerifyResult {
  const result: BackupVerifyResult = {
    exists: false,
    size: 0,
    encrypted: false,
    integrityOk: false,
    tables: {},
  };
  if (!existsSync(path)) return result;
  result.exists = true;
  try {
    result.size = statSync(path).size;
  } catch {
    result.size = 0;
  }
  if (result.size === 0) return result;
  if (isPlaintextDB(path)) return result;
  result.encrypted = true;

  let db: DatabaseType | null = null;
  try {
    db = new Database(path, { readonly: true }) as DatabaseType;
    applyKeyPragmas(db, keyToHex(key), kdfIter);
    readCanary(db);
    if (!integrityOk(db)) return result;
    result.tables = countTableRows(db);
    result.integrityOk = true;
    return result;
  } catch {
    return result;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }
}

/**
 * Build `VACUUM INTO` the rekey temp with the current key and report the source
 * row counts. Any row-count difference after re-encryption is data loss.
 */
function snapshotForRekey(
  dbPath: string,
  key: Uint8Array,
  kdfIter: number,
  tmpPath: string
): Record<string, number> {
  const source = openEncryptedDB(dbPath, key, kdfIter);
  try {
    const counts = countTableRows(source);
    source.exec(`VACUUM INTO ${sqlString(tmpPath)}`);
    return counts;
  } finally {
    try {
      source.close();
    } catch {
      // ignore
    }
  }
}

/**
 * C1: rotate the database key.
 *
 *   snapshot(out) → VACUUM INTO tmp (old key) → PRAGMA rekey (new key)
 *   → verify tmp with the new key + row-count parity
 *   → bak = rename(db) → db = rename(tmp) → verify db with the new key → unlink(bak)
 *
 * A kill leaves the original DB, or `.enc.bak` (old key) plus `.rekey.tmp`, so
 * at least one copy is always openable. `.rekey.tmp` is never a migration temp:
 * `recoverEncryptionState` deletes it and never promotes it.
 */
export function rekeyDatabase(
  dbPath: string,
  oldKey: Uint8Array,
  newKey: Uint8Array,
  kdfIter: number = KDF_ITER_DEFAULT
): { rotated: boolean } {
  const oldHex = keyToHex(oldKey);
  const newHex = keyToHex(newKey);
  if (oldHex === newHex) {
    throw new Error("rekey refused: the new key is identical to the current key");
  }
  if (!existsSync(dbPath)) {
    throw new Error(`rekey failed: database file not found: ${dbPath}`);
  }
  if (isPlaintextDB(dbPath)) {
    throw new Error("rekey refused: the database is plaintext, there is no key to rotate");
  }

  // `.enc.bak` is the promote slot below: finish or roll back an interrupted
  // migration before taking it over.
  recoverEncryptionState(dbPath, oldKey, kdfIter);
  if (!isEncrypted(dbPath, oldKey, kdfIter)) throw new Error(WRONG_KEY_ERROR);

  const tmpPath = `${dbPath}.rekey.tmp`;
  const bakPath = `${dbPath}.enc.bak`;
  deleteSqliteFiles(tmpPath);

  let expected: Record<string, number>;
  try {
    expected = snapshotForRekey(dbPath, oldKey, kdfIter, tmpPath);
  } catch (e) {
    deleteSqliteFiles(tmpPath);
    if (e instanceof Error && e.message === WRONG_KEY_ERROR) throw e;
    throw new Error(`rekey failed: cannot snapshot the database: ${errText(e)}`);
  }

  // Re-encrypt the copy in place. DELETE journal: the promoted file must be a
  // single self-contained file, never a main file plus a stranded `-wal`.
  let rekeyFailure: unknown = null;
  try {
    const holder = new Database(tmpPath) as DatabaseType;
    try {
      applyKeyPragmas(holder, oldHex, kdfIter);
      holder.pragma("journal_mode = DELETE");
      holder.pragma("busy_timeout = 5000");
      holder.pragma(`rekey = "x'${newHex}'"`);
    } finally {
      try {
        holder.close();
      } catch {
        // ignore
      }
    }
  } catch (e) {
    rekeyFailure = e;
  }
  if (rekeyFailure !== null) {
    deleteSqliteFiles(tmpPath);
    throw new Error(`rekey failed: cannot re-encrypt the copy: ${errText(rekeyFailure)}`);
  }

  const check = verifyEncryptedBackup(tmpPath, newKey, kdfIter);
  const mismatch = Object.entries(expected).find(([name, n]) => check.tables[name] !== n);
  if (!check.integrityOk || mismatch !== undefined) {
    deleteSqliteFiles(tmpPath);
    const reason =
      mismatch !== undefined
        ? `table ${mismatch[0]} lost rows`
        : "the copy does not open with the new key or fails integrity_check";
    throw new Error(`rekey failed: the re-encrypted copy did not verify: ${reason}`);
  }

  try {
    deleteSqliteFiles(bakPath);
    renameSync(dbPath, bakPath);
    moveSqliteSidecars(dbPath, bakPath);
  } catch (e) {
    deleteSqliteFiles(tmpPath);
    throw new Error(`rekey failed: cannot move the database aside: ${errText(e)}`);
  }

  try {
    renameSync(tmpPath, dbPath);
    moveSqliteSidecars(tmpPath, dbPath);
  } catch (e) {
    try {
      renameSync(bakPath, dbPath);
      moveSqliteSidecars(bakPath, dbPath);
    } catch {
      // ignore - recovery restores .enc.bak on the next start
    }
    deleteSqliteFiles(tmpPath);
    throw new Error(`rekey failed: cannot promote the re-encrypted database: ${errText(e)}`);
  }

  // Keep `.enc.bak` until the promoted file opens with the new key.
  const promoted = verifyEncryptedBackup(dbPath, newKey, kdfIter);
  const promotedMismatch =
    Object.entries(expected).find(([name, n]) => promoted.tables[name] !== n) ?? undefined;
  if (!promoted.integrityOk || promotedMismatch !== undefined) {
    deleteSqliteFiles(dbPath);
    try {
      renameSync(bakPath, dbPath);
      moveSqliteSidecars(bakPath, dbPath);
    } catch {
      // ignore - recovery restores .enc.bak on the next start
    }
    throw new Error("rekey failed: the promoted database did not verify (original restored)");
  }

  deleteSqliteFiles(bakPath);
  return { rotated: true };
}

/**
 * Backup encrypted DB via VACUUM INTO, atomically, keeping one generation.
 *
 *   stage → verify → out.1 = rename(out) → out = rename(stage)
 *
 * The vacuum writes to a hidden sibling `.<basename(out)>.staging-<pid>-<n>`: a
 * kill mid-vacuum can only ever leave a partial *staging* file behind, never a
 * partial backup at `out` — and, because the name starts with a dot, never a
 * file the `<db>.backup-*` scanners (`db drill`, `pruneOldBackups()`) accept.
 * A kill between the two renames leaves `out` missing but `out.1` intact, so the
 * previous good generation is never lost. Returns nothing; `backupPath` holds
 * the finished, verified backup.
 *
 * `known` is the key the copy is verified with. `undefined` keeps the copy
 * fail-closed: without a key the structural checks cannot distinguish a
 * page-aligned partial VACUUM from a complete copy, so no backup is promoted.
 */
function vacuumIntoVerifiedBackup(
  db: DatabaseType,
  backupPath: string,
  known: { keyHex: string; kdfIter: number } | undefined
): void {
  const tmpPath = stagePathFor(backupPath);
  const prevPath = `${backupPath}.1`;
  deleteSqliteFiles(tmpPath);

  try {
    db.exec(`VACUUM INTO ${sqlString(tmpPath)}`);
    verifyBackupCopy(tmpPath, known);
  } catch (e) {
    deleteSqliteFiles(tmpPath);
    throw new Error(`backup failed for ${backupPath}: ${errText(e)}`);
  }

  try {
    if (existsSync(backupPath)) {
      deleteSqliteFiles(prevPath);
      renameSync(backupPath, prevPath);
    }
    renameSync(tmpPath, backupPath);
    // The staging name is gone with the rename; its sidecars are not.
    deleteSqliteFiles(tmpPath);
  } catch (e) {
    deleteSqliteFiles(tmpPath);
    // Put the previous generation back: the caller must not be left without a
    // backup because the promotion rename failed.
    if (!existsSync(backupPath) && existsSync(prevPath)) {
      try {
        renameSync(prevPath, backupPath);
      } catch {
        // ignore - .1 is still the previous good generation
      }
    }
    throw new Error(`backup failed for ${backupPath}: cannot replace the destination: ${errText(e)}`);
  }
}

/**
 * Backup an encrypted DB with an explicitly supplied key.
 *
 * The key is passed in rather than looked up, so a caller holding a *proxy* over
 * the real connection (the public `db` export) can still produce a verified
 * backup. Callers must have resolved the key through config: this does not widen
 * the fail-closed guarantee, it only says where the key comes from.
 */
export function backupEncryptedDBWithKey(
  db: DatabaseType,
  backupPath: string,
  key: Uint8Array,
  kdfIter: number = KDF_ITER_DEFAULT
): void {
  vacuumIntoVerifiedBackup(db, backupPath, { keyHex: keyToHex(key), kdfIter });
}

/**
 * Backup an encrypted DB with the key recorded for this connection. A handle
 * this module did not open (no recorded key) is refused — fail-closed.
 */
export function backupEncryptedDB(db: DatabaseType, backupPath: string): void {
  vacuumIntoVerifiedBackup(db, backupPath, OPEN_KEYS.get(db));
}

/**
 * Get encryption status for diagnostics.
 */
export function getEncryptionStatus(
  dbPath: string,
  key?: Uint8Array,
  kdfIter: number = KDF_ITER_DEFAULT
): {
  exists: boolean;
  encrypted: boolean;
  migrated: boolean;
  plaintext: boolean;
} {
  const exists = existsSync(dbPath);
  if (!exists) return { exists: false, encrypted: false, migrated: false, plaintext: false };

  if (key) {
    const encrypted = isEncrypted(dbPath, key, kdfIter);
    return {
      exists: true,
      encrypted,
      migrated: encrypted && hasMigrationMarker(dbPath, key, kdfIter),
      plaintext: !encrypted && isPlaintextDB(dbPath),
    };
  }

  // Without key, can only check if it's plaintext
  const plaintext = isPlaintextDB(dbPath);
  return {
    exists: true,
    encrypted: !plaintext,
    migrated: false,
    plaintext,
  };
}
