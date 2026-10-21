import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const { backupDatabase } = await import("../dist/db/migrations.js");

test("backupDatabase creates a consistent WAL-safe snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-backup-"));
  const dbPath = join(dir, "memory.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  db.prepare("INSERT INTO notes (body) VALUES (?)").run("hello snapshot");

  let backupPath;
  try {
    backupPath = backupDatabase(db, dbPath);
    assert.ok(
      backupPath.startsWith(`${dbPath}.backup-`),
      `unexpected backup path: ${backupPath}`
    );

    const backup = new Database(backupPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const row = backup.prepare("SELECT body FROM notes WHERE id = 1").get();
      assert.equal(row.body, "hello snapshot");
      const integrity = backup.pragma("integrity_check", { simple: true });
      assert.equal(integrity, "ok");
    } finally {
      backup.close();
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backupDatabase fails closed on an invalid target directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "memory-backup-bad-"));
  const dbPath = join(dir, "missing-subdir", "memory.db");
  const db = new Database(":memory:");
  db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY)");
  try {
    assert.throws(
      () => backupDatabase(db, dbPath),
      /migration backup failed for/
    );
    assert.deepEqual(
      readdirSync(dir).filter((name) => name.includes(".backup-")),
      []
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
