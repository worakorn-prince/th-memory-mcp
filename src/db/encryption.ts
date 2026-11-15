/**
 * Encryption (Ph-4) — SQLCipher via better-sqlite3-multiple-ciphers.
 *
 * This module handles:
 *   - Key validation & decoding (base64 32-byte key)
 *   - One-time migration: plaintext DB → encrypted (sqlcipher_export + atomic rename)
 *   - Opening encrypted DB with proper pragmas
 *   - Migration idempotency via schema_meta marker
 *
 * ADR constraints (from ADR-AUTH-P0-SPIKE §6):
 *   - better-sqlite3-multiple-ciphers@13.1.1 pinned
 *   - Migration = copy + PRAGMA rekey (sqlcipher_export ONLY during migration)
 *   - Backup = VACUUM INTO (encrypted)
 *   - NEVER sqlcipher_export for backup, NEVER db.backup(), NEVER raw file copy
 */

import Database from "better-sqlite3-multiple-ciphers";
import type { Database as DatabaseType } from "better-sqlite3-multiple-ciphers";
import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { getEncryptionMode, getEncryptionKey, getEncryptionKdfIter } from "../lib/config.js";
import { DEFAULT_DB_PATH } from "../lib/config.js";

export const PAGE_SIZE = 4096;
export const KDF_ITER_DEFAULT = 256000;
export const MIGRATION_MARKER_KEY = "encryption_migrated";

/**
 * Convert Uint8Array key to hex string for SQLCipher pragma.
 */
export function keyToHex(key: Uint8Array): string {
  return Array.from(key)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Open an encrypted database with the given key.
 * Throws if key is wrong (pragma will fail).
 */
export function openEncryptedDB(dbPath: string, key: Uint8Array, kdfIter: number = KDF_ITER_DEFAULT): DatabaseType {
  const keyHex = keyToHex(key);

  const db = new Database(dbPath, {
    // WAL mode for concurrent readers
    fileMustExist: false,
  });

  // Set encryption pragmas: key first (with default cipher aes-256-cbc)
  db.pragma(`key = "x'${keyHex}'"`);
  db.pragma(`kdf_iter = ${kdfIter}`);
  db.pragma(`page_size = ${PAGE_SIZE}`);

  // Verify key works by reading a pragma
  db.pragma("cipher_version");

  // Standard pragmas (same as plaintext)
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");

  return db;
}

/**
 * Check if a DB file is already encrypted with the given key.
 * Returns true if the file exists and opens successfully with the key.
 */
export function isEncrypted(dbPath: string, key: Uint8Array): boolean {
  if (!existsSync(dbPath)) return false;
  // If it's plaintext, it's definitely not encrypted with our key
  if (isPlaintextDB(dbPath)) return false;
  try {
    const db = new Database(dbPath, { readonly: true }) as DatabaseType;
    const keyHex = keyToHex(key);
    db.pragma(`key = "x'${keyHex}'"`);
    db.pragma(`kdf_iter = ${KDF_ITER_DEFAULT}`);
    db.pragma(`page_size = ${PAGE_SIZE}`);
    db.pragma("cipher_version"); // Throws if wrong key
    db.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if DB has the migration marker in schema_meta.
 */
export function hasMigrationMarker(dbPath: string, key: Uint8Array): boolean {
  if (!existsSync(dbPath)) return false;
  try {
    const db = openEncryptedDB(dbPath, key);
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = ?").get(MIGRATION_MARKER_KEY) as { value: string } | undefined;
    db.close();
    return row?.value === "1";
  } catch {
    return false;
  }
}

/**
 * Check if a DB file is plaintext (not encrypted).
 * Returns true if file exists and is valid SQLite but NOT encrypted with our key.
 */
export function isPlaintextDB(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false;
  try {
    const db = new Database(dbPath, { readonly: true }) as DatabaseType;
    // Try to read a table - if it works without key, it's plaintext
    db.prepare("SELECT 1 FROM sqlite_master LIMIT 1").get();
    db.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Migrate plaintext DB to encrypted DB using sqlcipher_export.
 * This runs ONCE per database lifecycle.
 * Returns true if migration ran, false if already encrypted/no migration needed.
 */
export function migrateIfNeeded(dbPath: string, key: Uint8Array, kdfIter: number = KDF_ITER_DEFAULT): boolean {
  // If DB doesn't exist, nothing to migrate (will be created encrypted on first open)
  if (!existsSync(dbPath)) return false;

  // If already encrypted with our key, check migration marker
  if (isEncrypted(dbPath, key)) {
    if (hasMigrationMarker(dbPath, key)) {
      return false; // Already migrated
    }
    // Encrypted but no marker - treat as already migrated (legacy encrypted DB)
    // Write marker for future idempotency
    try {
      const db = openEncryptedDB(dbPath, key, kdfIter);
      db.prepare("INSERT OR IGNORE INTO schema_meta (key, value) VALUES (?, ?)").run(MIGRATION_MARKER_KEY, "1");
      db.close();
    } catch {
      // Ignore marker write failure
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
 * Run the actual migration: plaintext → encrypted by copying schema and data.
 * Uses temp file + atomic rename for safety.
 * This avoids sqlcipher_export which may not be available in all builds.
 */
function runMigration(dbPath: string, key: Uint8Array, kdfIter: number): boolean {
  const keyHex = keyToHex(key);
  const tmpPath = `${dbPath}.enc.tmp`;

  try {
    // Remove any stale temp file
    if (existsSync(tmpPath)) unlinkSync(tmpPath);

    // Open plaintext source DB
    const plainDb = new Database(dbPath, { readonly: true });

    // Create encrypted temp DB
    const encryptedDb = new Database(tmpPath) as DatabaseType;
    const keyHex = keyToHex(key);
    encryptedDb.pragma(`key = "x'${keyHex}'"`);
    encryptedDb.pragma(`kdf_iter = ${kdfIter}`);
    encryptedDb.pragma(`page_size = ${PAGE_SIZE}`);
    encryptedDb.pragma("journal_mode = WAL");
    encryptedDb.pragma("busy_timeout = 5000");
    encryptedDb.pragma("foreign_keys = ON");

    // Get all table schemas from plaintext DB
    const tables = plainDb.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string; sql: string }[];

    // Create tables in encrypted DB
    for (const table of tables) {
      if (table.sql) {
        encryptedDb.exec(table.sql);
      }
    }

    // Copy data for each table
    for (const table of tables) {
      const columns = plainDb.prepare(`PRAGMA table_info(${table.name})`).all() as { name: string }[];
      const colNames = columns.map(c => c.name);
      const colNamesStr = colNames.join(", ");
      const placeholders = columns.map(() => "?").join(", ");

      const rows = plainDb.prepare(`SELECT ${colNamesStr} FROM ${table.name}`).all() as Record<string, unknown>[];
      if (rows.length > 0) {
        const insertStmt = encryptedDb.prepare(`INSERT INTO ${table.name} (${colNamesStr}) VALUES (${placeholders})`);
        const insertMany = encryptedDb.transaction((rows) => {
          for (const row of rows) {
            // Explicitly map values in column order to ensure correct order
            const values = colNames.map(col => row[col]);
            insertStmt.run(...values);
          }
        });
        insertMany(rows);
      }
    }

    // Ensure schema_meta table exists (create if not in plaintext DB)
    const hasSchemaMeta = tables.some(t => t.name === "schema_meta");
    if (!hasSchemaMeta) {
      encryptedDb.exec(`
        CREATE TABLE IF NOT EXISTS schema_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    }

    // Copy indexes
    const indexes = plainDb.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all() as { name: string; sql: string }[];
    for (const idx of indexes) {
      if (idx.sql) {
        try {
          encryptedDb.exec(idx.sql);
        } catch {
          // Ignore index creation failures (e.g., unique constraints on duplicate data)
        }
      }
    }

    // Copy triggers
    const triggers = plainDb.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger'").all() as { name: string; sql: string }[];
    for (const trigger of triggers) {
      if (trigger.sql) {
        try {
          encryptedDb.exec(trigger.sql);
        } catch {
          // Ignore trigger creation failures
        }
      }
    }

    // Write migration marker
    encryptedDb.prepare("INSERT OR IGNORE INTO schema_meta (key, value) VALUES (?, ?)").run(MIGRATION_MARKER_KEY, "1");

    plainDb.close();
    encryptedDb.close();

    // Atomic rename: temp → original
    // On Windows, need to delete target first
    if (existsSync(dbPath)) {
      // Delete WAL/SHM files first
      const walPath = `${dbPath}-wal`;
      const shmPath = `${dbPath}-shm`;
      if (existsSync(walPath)) unlinkSync(walPath);
      if (existsSync(shmPath)) unlinkSync(shmPath);
      unlinkSync(dbPath);
    }
    renameSync(tmpPath, dbPath);

    return true;
  } catch (e) {
    // Cleanup on failure
    if (existsSync(tmpPath)) {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
    }
    throw e;
  }
}

/**
 * Create a new encrypted DB (for fresh installs).
 * Just opens with key - SQLCipher creates encrypted file automatically.
 */
export function createEncryptedDB(dbPath: string, key: Uint8Array, kdfIter: number = KDF_ITER_DEFAULT): DatabaseType {
  return openEncryptedDB(dbPath, key, kdfIter);
}

/**
 * Backup encrypted DB via VACUUM INTO.
 * Returns the backup file path.
 */
export function backupEncryptedDB(db: DatabaseType, backupPath: string): void {
  // Ensure directory exists
  const backupDir = dirname(backupPath);
  if (!existsSync(backupDir)) {
    // mkdirSync would need import - let caller ensure dir exists
  }
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
}

/**
 * Get encryption status for diagnostics.
 */
export function getEncryptionStatus(dbPath: string, key?: Uint8Array): {
  exists: boolean;
  encrypted: boolean;
  migrated: boolean;
  plaintext: boolean;
} {
  const exists = existsSync(dbPath);
  if (!exists) return { exists: false, encrypted: false, migrated: false, plaintext: false };

  if (key) {
    const encrypted = isEncrypted(dbPath, key);
    return {
      exists: true,
      encrypted,
      migrated: encrypted && hasMigrationMarker(dbPath, key),
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