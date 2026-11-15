import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import type { Database as DatabaseType } from "better-sqlite3-multiple-ciphers";
import { err, ok } from "../../db/index.js";
import { DEFAULT_DB_PATH, getEncryptionKdfIter, getEncryptionKey, getEncryptionMode } from "../../lib/config.js";
import { writeBackup } from "../../db/migrations.js";
import {
  PAGE_SIZE,
  WRONG_KEY_ERROR,
  BACKUP_STAGING_RE,
  countTableRows,
  isEncrypted,
  isPlaintextDB,
  keyToHex,
  registerDatabaseKey,
  rekeyDatabase,
  verifyEncryptedBackup,
  type BackupVerifyResult,
} from "../../db/encryption.js";
import { fail, optBool, optStr, output, type CliOpts, type Globals } from "./shared.js";

const KEY_BYTES = 32;
const REPORT_TABLES = ["memories", "preferences", "lessons", "interactions"];
const BACKUP_SUFFIX_MARKER = ".backup-";

/** Restore temp names are unique per process so two drills cannot collide. */
let restoreAttempt = 0;

function liveDbPath(): string {
  const fromEnv = process.env.MEMORY_DB_PATH;
  return fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : DEFAULT_DB_PATH;
}

function removeSqliteFiles(basePath: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const target = basePath + suffix;
    if (!existsSync(target)) continue;
    try {
      unlinkSync(target);
    } catch {
      // Windows may hold a handle briefly; the caller reports the failure.
    }
  }
}

/** Move a file's WAL/journal siblings with it (same order as the promote path). */
function moveSqliteSidecars(fromPath: string, toPath: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (!existsSync(fromPath + suffix)) continue;
    try {
      renameSync(fromPath + suffix, toPath + suffix);
    } catch {
      // Non-fatal: the displaced file is a recovery source, not the live DB.
    }
  }
}

/**
 * Strict base64 → 32 bytes, identical to `decodeKeyBase64()` in
 * `src/lib/config.ts`: the standard and URL-safe alphabets are accepted, and a
 * short/long decode or any character outside the alphabet is rejected. A key
 * accepted by `db rekey` is therefore always a key the server will accept.
 */
function decodeKey(raw: string, label: string, g: Globals): Uint8Array {
  const normalized = raw.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    return fail(`${label} must be base64-encoded ${KEY_BYTES} bytes`, g.json);
  }
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length !== KEY_BYTES) return fail(`${label} must be base64-encoded ${KEY_BYTES} bytes`, g.json);
  return new Uint8Array(decoded);
}

function requireEnvKey(g: Globals): Uint8Array {
  const key = getEncryptionKey();
  if (key === undefined) {
    return fail(
      `MEMORY_ENCRYPTION_KEY is missing or invalid (base64-encoded ${KEY_BYTES} bytes required)`,
      g.json
    );
  }
  return key;
}

/** Read the new key from a file; 0600 is enforced where the OS has modes. */
function readKeyFile(path: string, g: Globals): string {
  let text: string;
  try {
    const info = statSync(path);
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      return fail(`--new-key-file must not be group/other readable (chmod 600): ${path}`, g.json);
    }
    text = readFileSync(path, "utf8");
  } catch (e) {
    return fail(`cannot read --new-key-file ${path}: ${e instanceof Error ? e.message : String(e)}`, g.json);
  }
  if (text.trim().length === 0) return fail(`--new-key-file is empty: ${path}`, g.json);
  return text;
}

function verifyLine(result: BackupVerifyResult): string {
  const counts = REPORT_TABLES.map((name) => `${name}=${result.tables[name] ?? 0}`);
  return `ok: ${result.size} bytes, integrity ok, ${Object.keys(result.tables).length} tables, ${counts.join(" ")}`;
}

/** Shared gate: the file must exist, be encrypted, open with the key and verify. */
function checkBackup(path: string, key: Uint8Array, g: Globals): BackupVerifyResult {
  const result = verifyEncryptedBackup(path, key, getEncryptionKdfIter());
  if (!result.exists) fail(`backup not found: ${path}`, g.json);
  if (!result.encrypted) fail(`not an encrypted backup: ${path}`, g.json);
  if (!result.integrityOk) {
    fail(`backup failed verification (wrong key or corrupt file): ${path}`, g.json, 1);
  }
  return result;
}

function runRekey(opts: CliOpts, g: Globals): number {
  if (getEncryptionMode() !== "on") {
    return fail(
      "db rekey requires MEMORY_ENCRYPTION=on (MEMORY_ENCRYPTION_KEY holds the current key)",
      g.json
    );
  }
  const oldKey = requireEnvKey(g);
  const keyFile = optStr(opts, "--new-key-file");
  const inline = optStr(opts, "--new-key");
  if (keyFile !== undefined && inline !== undefined) {
    return fail("pass either --new-key-file or --new-key, not both", g.json);
  }
  if (keyFile === undefined && inline === undefined) {
    return fail("db rekey requires --new-key-file <path> (preferred) or --new-key <base64>", g.json);
  }
  const newKey = decodeKey(keyFile !== undefined ? readKeyFile(keyFile, g) : (inline as string), "the new key", g);

  const dbPath = liveDbPath();
  if (!existsSync(dbPath)) return fail(`database not found: ${dbPath}`, g.json);
  if (isPlaintextDB(dbPath)) {
    return fail("refusing to rekey a plaintext database (enable encryption first)", g.json);
  }
  const kdfIter = getEncryptionKdfIter();
  if (!isEncrypted(dbPath, oldKey, kdfIter)) return fail(WRONG_KEY_ERROR, g.json);
  if (Buffer.compare(Buffer.from(oldKey), Buffer.from(newKey)) === 0) {
    return fail("refusing to rekey: the new key is identical to the current key", g.json);
  }

  try {
    rekeyDatabase(dbPath, oldKey, newKey, kdfIter);
  } catch (e) {
    return output(err(e instanceof Error ? e.message : String(e)), g);
  }

  if (g.json) {
    return output(ok(JSON.stringify({ ok: true, db: dbPath, rotated: true })), g);
  }
  return output(ok(`db rekey: ok — re-encrypted ${dbPath} with the new key`), g);
}

function runVerifyBackup(opts: CliOpts, pos: string[], g: Globals): number {
  const path = pos[1] ?? optStr(opts, "--backup");
  if (path === undefined) return fail("db verify-backup requires <path> (or --backup <path>)", g.json);
  const result = checkBackup(path, requireEnvKey(g), g);
  if (g.json) return output(ok(JSON.stringify(result)), g);
  return output(ok(verifyLine(result)), g);
}

function runBackup(opts: CliOpts, pos: string[], g: Globals): number {
  const live = liveDbPath();
  if (!existsSync(live)) return fail(`database not found: ${live}`, g.json);
  const requested = pos[1] ?? optStr(opts, "--out") ?? optStr(opts, "--backup");
  const out = resolve(requested ?? `${live}.backup-${Date.now()}`);
  if (out === resolve(live)) return fail("refusing to back the database up onto itself", g.json);
  const dir = dirname(out);
  if (!existsSync(dir)) return fail(`destination directory does not exist: ${dir}`, g.json);

  const encrypted = !isPlaintextDB(live);
  const kdfIter = getEncryptionKdfIter();
  const key = encrypted ? requireEnvKey(g) : undefined;

  let handle: DatabaseType | null = null;
  try {
    handle = encrypted ? openLiveForRead(live, key as Uint8Array, kdfIter) : new Database(live, { readonly: true });
    handle.pragma("busy_timeout = 5000");
    writeBackup(handle, live, out);
  } catch (e) {
    return output(err(e instanceof Error ? e.message : String(e)), g);
  } finally {
    try {
      handle?.close();
    } catch {
      // ignore
    }
  }

  const size = statSync(out).size;
  const tables = encrypted ? verifyEncryptedBackup(out, key as Uint8Array, kdfIter).tables : {};
  if (g.json) {
    return output(ok(JSON.stringify({ ok: true, from: live, to: out, size, encrypted, tables })), g);
  }
  const detail = encrypted ? `${Object.keys(tables).length} tables` : "plaintext copy";
  return output(ok(`backup: ok — ${live} -> ${out} (${size} bytes, ${detail})`), g);
}

function runRestore(opts: CliOpts, pos: string[], g: Globals): number {
  const backup = pos[1] ?? optStr(opts, "--backup");
  if (backup === undefined) return fail("db restore requires <backup> (or --backup <path>)", g.json);
  const to = optStr(opts, "--to");
  if (to === undefined) return fail("db restore requires --to <path>", g.json);
  const force = optBool(opts, "--force");
  const key = requireEnvKey(g);
  const result = checkBackup(backup, key, g);

  const target = resolve(to);
  if (target === resolve(liveDbPath()) && !force) {
    return fail("refusing to restore over the live database without --force", g.json);
  }
  if (existsSync(target) && !force) {
    return fail(`refusing to overwrite an existing file: ${to} (use --force)`, g.json);
  }
  const dir = dirname(target);
  if (!existsSync(dir)) return fail(`destination directory does not exist: ${dir}`, g.json);

  const tmp = join(dir, `.${basename(target)}.restore-${process.pid}-${restoreAttempt++}`);
  removeSqliteFiles(tmp);
  try {
    copyFileSync(backup, tmp);
  } catch (e) {
    removeSqliteFiles(tmp);
    return fail(`restore failed: cannot copy the backup: ${e instanceof Error ? e.message : String(e)}`, g.json, 1);
  }

  const copied = verifyEncryptedBackup(tmp, key, getEncryptionKdfIter());
  if (!copied.integrityOk) {
    removeSqliteFiles(tmp);
    return fail("restore failed: the copied backup did not verify", g.json, 1);
  }

  // Promote like runMigration/rekey: target → target.bak → tmp → target. The
  // original is renamed aside with its -wal/-shm/-journal siblings, never
  // deleted, so a failed promotion can always put it (and its sidecars) back;
  // `.bak` is only removed after the new file is in place.
  const displaced = `${target}.bak`;
  let movedAside = false;
  try {
    if (existsSync(target)) {
      removeSqliteFiles(displaced);
      renameSync(target, displaced);
      moveSqliteSidecars(target, displaced);
      movedAside = true;
    }
    renameSync(tmp, target);
  } catch (e) {
    removeSqliteFiles(tmp);
    let restored = true;
    if (movedAside) {
      try {
        renameSync(displaced, target);
        moveSqliteSidecars(displaced, target);
      } catch {
        restored = false;
      }
    }
    const reason = e instanceof Error ? e.message : String(e);
    const kept = !movedAside
      ? "the destination was not modified"
      : restored
        ? "the previous file was restored"
        : `the previous file is kept at ${displaced}`;
    return fail(`restore failed: cannot move the copy into place: ${reason} (${kept})`, g.json, 1);
  }
  if (movedAside) removeSqliteFiles(displaced);

  const size = statSync(target).size;
  if (g.json) {
    return output(ok(JSON.stringify({ ok: true, from: backup, to: target, size, tables: copied.tables })), g);
  }
  return output(ok(`restore: ok — ${backup} -> ${target} (${size} bytes, ${result.tables.memories ?? 0} memories)`), g);
}

/**
 * Newest `<db>.backup-*` next to the live database. These are the migration
 * backups (`migrations.ts` names them with a millisecond timestamp).
 *
 * Staging artifacts (`.…staging-<pid>-<n>`, plus the legacy `….tmp-<pid>-<n>`)
 * are never backups: a killed backup must not be picked by `db drill` nor count
 * as a generation for pruning.
 */
function newestBackup(livePath: string): string | undefined {
  const dir = dirname(livePath);
  const prefix = `${basename(livePath)}${BACKUP_SUFFIX_MARKER}`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return undefined;
  }
  const candidates = names.filter(
    (name) =>
      name.startsWith(prefix) &&
      !/-(wal|shm|journal)$/.test(name) &&
      !BACKUP_STAGING_RE.test(name) &&
      !basename(name).startsWith(".")
  );
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => {
    try {
      const delta = statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs;
      if (delta !== 0) return delta;
    } catch {
      // fall through to the name order
    }
    return b.localeCompare(a);
  });
  return join(dir, candidates[0] as string);
}

function encryptedHandle(path: string, key: Uint8Array, kdfIter: number, readonly: boolean): DatabaseType {
  const keyHex = keyToHex(key);
  const db = new Database(path, { readonly }) as DatabaseType;
  db.pragma(`key = "x'${keyHex}'"`);
  db.pragma(`kdf_iter = ${kdfIter}`);
  db.pragma(`page_size = ${PAGE_SIZE}`);
  // Verification of the copy this handle produces needs the key on record.
  registerDatabaseKey(db, key, kdfIter);
  return db;
}

/**
 * Read the live DB without writing: a read-only handle first (WAL with a live
 * server keeps `-shm` present), read-write only when the read-only open cannot
 * attach to a WAL that has no `-shm` yet. Nothing is ever written.
 */
function openLiveForRead(path: string, key: Uint8Array, kdfIter: number): DatabaseType {
  if (isPlaintextDB(path)) {
    const db = new Database(path, { readonly: true }) as DatabaseType;
    db.pragma("busy_timeout = 5000");
    return db;
  }
  let handle: DatabaseType | null = null;
  try {
    handle = encryptedHandle(path, key, kdfIter, true);
    handle.prepare("SELECT count(*) AS c FROM sqlite_master").get();
    handle.pragma("busy_timeout = 5000");
    return handle;
  } catch (e) {
    try {
      handle?.close();
    } catch {
      // ignore
    }
    try {
      const writable = encryptedHandle(path, key, kdfIter, false);
      writable.pragma("busy_timeout = 5000");
      return writable;
    } catch {
      throw e;
    }
  }
}

function runDrill(opts: CliOpts, g: Globals): number {
  const key = requireEnvKey(g);
  const kdfIter = getEncryptionKdfIter();
  const livePath = liveDbPath();
  const explicit = optStr(opts, "--backup");
  const backup = explicit ?? newestBackup(livePath);
  if (backup === undefined) {
    return fail(
      `no backup found next to ${livePath} (pass --backup <path>; expected ${basename(livePath)}${BACKUP_SUFFIX_MARKER}*)`,
      g.json
    );
  }
  if (!existsSync(backup)) return fail(`backup not found: ${backup}`, g.json);

  // Everything that can refuse the run happens before any temp directory
  // exists, so a refusal never leaves one behind.
  const fromBackup = checkBackup(backup, key, g);
  const dir = mkdtempSync(join(tmpdir(), "th-memory-drill-"));
  try {
    const restoredPath = join(dir, "drill.db");
    try {
      copyFileSync(backup, restoredPath);
    } catch (e) {
      return output(err(`drill failed: cannot copy the backup: ${e instanceof Error ? e.message : String(e)}`), g);
    }
    const restored = verifyEncryptedBackup(restoredPath, key, kdfIter);
    if (!restored.integrityOk) {
      return output(err("drill failed: the restored copy did not verify"), g);
    }

    const liveExists = existsSync(livePath);
    let liveCounts: Record<string, number> | null = null;
    let liveNote = "not present (comparison skipped)";
    if (liveExists) {
      let handle: DatabaseType | null = null;
      try {
        handle = openLiveForRead(livePath, key, kdfIter);
        liveCounts = countTableRows(handle);
        liveNote = `${Object.keys(liveCounts).length} tables`;
      } catch (e) {
        liveNote = `unreadable (${e instanceof Error ? e.message : String(e)})`;
      } finally {
        try {
          handle?.close();
        } catch {
          // ignore
        }
      }
    }

    const tables = [...new Set([...Object.keys(fromBackup.tables), ...Object.keys(restored.tables)])].sort();
    const parity = tables.every((name) => (fromBackup.tables[name] ?? 0) === (restored.tables[name] ?? 0));
    const liveReadable = !liveExists || liveCounts !== null;
    const passed = fromBackup.integrityOk && restored.integrityOk && parity && liveReadable;

    if (g.json) {
      const data = {
        ok: passed,
        backup,
        restored: { path: restoredPath, integrityOk: restored.integrityOk, tables: restored.tables },
        live: { path: livePath, present: liveExists, readable: liveCounts !== null, tables: liveCounts },
        parity,
      };
      return passed ? output(ok(JSON.stringify(data)), g) : output(err(JSON.stringify(data)), g);
    }

    const lines: string[] = [];
    lines.push(`drill: ${backup}`);
    lines.push(`  backup   : ${fromBackup.size} bytes, integrity ok, ${Object.keys(fromBackup.tables).length} tables`);
    lines.push(`  restored : integrity ok, ${Object.keys(restored.tables).length} tables (temp copy verified)`);
    lines.push(`  live     : ${liveExists ? livePath : "(none)"} — ${liveNote}`);
    lines.push("  table                 backup  restored  live  delta");
    for (const name of tables) {
      const backupCount = fromBackup.tables[name] ?? 0;
      const restoredCount = restored.tables[name] ?? 0;
      const liveCount = liveCounts === null ? null : (liveCounts[name] ?? 0);
      const diff = liveCount === null ? null : restoredCount - liveCount;
      const deltaText = diff === null ? "-" : diff > 0 ? `+${diff}` : String(diff);
      lines.push(
        `  ${name.padEnd(20)} ${String(backupCount).padStart(7)} ${String(restoredCount).padStart(
          9
        )} ${String(liveCount ?? "-").padStart(5)}  ${deltaText}`
      );
    }
    lines.push("  checks   : backup verified, restore verified, counts match the backup");
    lines.push(`  result   : ${passed ? "PASS" : "FAIL"} (row-count deltas vs the live DB are informational)`);
    return passed ? output(ok(lines.join("\n")), g) : output(err(lines.join("\n")), g);
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore - the temp directory is inside the OS temp root
    }
  }
}

/**
 * th-memory db <backup|rekey|verify-backup|restore|drill> — encryption admin.
 *
 * Local admin like `auth`/`grant`: MEMORY_AUTH is irrelevant. No subcommand
 * prints or echoes a key; `--new-key-file` is preferred over `--new-key`.
 */
export async function runDb(opts: CliOpts, pos: string[], g: Globals): Promise<number> {
  const sub = pos[0];
  if (sub === undefined) fail("db requires <backup|rekey|verify-backup|restore|drill> (see help)", g.json);

  switch (sub) {
    case "backup":
      return runBackup(opts, pos, g);
    case "rekey":
      return runRekey(opts, g);
    case "verify-backup":
      return runVerifyBackup(opts, pos, g);
    case "restore":
      return runRestore(opts, pos, g);
    case "drill":
      return runDrill(opts, g);
    default:
      fail(`unknown db subcommand "${sub}" (see help)`, g.json);
  }
}
