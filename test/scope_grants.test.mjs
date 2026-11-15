import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));

const workDir = mkdtempSync(join(tmpdir(), "th-auth-p3-grants-"));
const dbPath = join(workDir, "grants.db");

process.env.MEMORY_DB_PATH = dbPath;
process.env.MEMORY_BACKUP_ON_MIGRATE = "0";
delete process.env.MEMORY_AUTH;

const { db } = await import("../dist/db/index.js");
const { runMigrations } = await import("../dist/db/migrations.js");
const { ensureUser } = await import("../dist/db/repositories/users.js");
const { addGrant, hasGrant, listGrants, removeGrant } = await import(
  "../dist/db/repositories/scope_grants.js"
);

const aliceUid = ensureUser("alice");
const bobUid = ensureUser("bob");

test.after(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  rmSync(workDir, { recursive: true, force: true });
});

const tableNames = () =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((r) => r.name);

const indexNames = () =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all()
    .map((r) => r.name);

const columnsOf = (table) =>
  db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

// ---------------------------------------------------------------- migration ---

test("017_scope: tables, owner columns and indexes exist", () => {
  const tables = tableNames();
  assert.equal(tables.includes("scope_grants"), true);
  assert.equal(tables.includes("audit_log"), true);

  for (const [table, index] of [
    ["interactions", "idx_interactions_user"],
    ["preferences", "idx_preferences_user"],
    ["lessons", "idx_lessons_user"],
    ["scope_grants", "idx_scope_grants_lookup"],
    ["audit_log", "idx_audit_ts"],
    ["audit_log", "idx_audit_user"],
  ]) {
    assert.equal(indexNames().includes(index), true, `${index} must exist`);
  }

  for (const table of ["interactions", "preferences", "lessons"]) {
    const cols = columnsOf(table);
    assert.equal(cols.includes("user_id"), true, `${table}.user_id must exist`);
    assert.equal(
      cols.filter((c) => c === "user_id").length,
      1,
      `${table}.user_id must exist exactly once`
    );
  }
});

test("017_scope: re-running the migration is a safe no-op", () => {
  db.prepare("DELETE FROM schema_meta WHERE key = '017_scope'").run();
  assert.doesNotThrow(() => runMigrations(db));

  for (const table of ["interactions", "preferences", "lessons"]) {
    assert.equal(
      columnsOf(table).filter((c) => c === "user_id").length,
      1,
      `${table}.user_id must not be duplicated on re-run`
    );
  }
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM schema_meta WHERE key = '017_scope'").get().n,
    1
  );
});

// ---------------------------------------------------------------- grant CRUD ---

test("addGrant/listGrants: rows are stored and listed oldest first", () => {
  addGrant(aliceUid, "USER", "bob", "read", aliceUid);
  const rows = listGrants(aliceUid);
  const row = rows.find((r) => r.scope_kind === "USER" && r.scope_ref === "bob");
  assert.ok(row, "USER grant on bob must be listed");
  assert.equal(row.permission, "read");
  assert.equal(row.grantee_user_id, aliceUid);
  assert.equal(row.granted_by, aliceUid);
  assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T/);

  const ids = rows.map((r) => r.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "list order is by id");
});

test("addGrant: UNIQUE target is idempotent (same id, one row)", () => {
  const first = addGrant(bobUid, "PROJECT", "proj-1", "write");
  const before = listGrants(bobUid).length;
  const second = addGrant(bobUid, "PROJECT", "proj-1", "write");
  assert.equal(second, first, "duplicate add returns the existing id");
  assert.equal(listGrants(bobUid).length, before, "no duplicate row");
});

test("permissions: write implies read, read never implies write", () => {
  addGrant(aliceUid, "USER", "bob", "write");
  assert.equal(hasGrant(aliceUid, "USER", "bob", "write"), true);
  assert.equal(hasGrant(aliceUid, "USER", "bob", "read"), true);

  addGrant(bobUid, "USER", "alice", "read");
  assert.equal(hasGrant(bobUid, "USER", "alice", "read"), true);
  assert.equal(hasGrant(bobUid, "USER", "alice", "write"), false);

  removeGrant(aliceUid, "USER", "bob", "write");
  assert.equal(hasGrant(aliceUid, "USER", "bob", "write"), false);
  assert.equal(
    hasGrant(aliceUid, "USER", "bob", "read"),
    true,
    "the earlier read grant survives"
  );
});

test("permissions: grants are scoped by grantee, kind and ref", () => {
  addGrant(aliceUid, "SESSION", "s-1", "read");
  assert.equal(hasGrant(aliceUid, "SESSION", "s-1", "read"), true);
  assert.equal(hasGrant(bobUid, "SESSION", "s-1", "read"), false, "other grantee");
  assert.equal(hasGrant(aliceUid, "PROJECT", "s-1", "read"), false, "other kind");
  assert.equal(hasGrant(aliceUid, "SESSION", "s-2", "read"), false, "other ref");
  removeGrant(aliceUid, "SESSION", "s-1", "read");
});

test("GLOBAL write is a grant on (GLOBAL, '*')", () => {
  assert.equal(hasGrant(aliceUid, "GLOBAL", "*", "write"), false);
  addGrant(aliceUid, "GLOBAL", "*", "write");
  assert.equal(hasGrant(aliceUid, "GLOBAL", "*", "write"), true);
  assert.equal(hasGrant(aliceUid, "GLOBAL", "*", "read"), true);
  removeGrant(aliceUid, "GLOBAL", "*", "write");
  assert.equal(hasGrant(aliceUid, "GLOBAL", "*", "write"), false);
});

test("removeGrant: returns true once, then false (idempotent)", () => {
  addGrant(aliceUid, "USER", "carol", "read");
  assert.equal(removeGrant(aliceUid, "USER", "carol", "read"), true);
  assert.equal(removeGrant(aliceUid, "USER", "carol", "read"), false);
  assert.equal(hasGrant(aliceUid, "USER", "carol", "read"), false);
});

test("validation: unknown kinds/permissions fail closed, bad adds throw", () => {
  assert.equal(hasGrant(aliceUid, "TENANT", "x", "read"), false);
  assert.equal(hasGrant(aliceUid, "USER", "bob", "admin"), false);
  assert.equal(hasGrant(aliceUid, "USER", "", "read"), false);
  assert.equal(hasGrant(0, "USER", "bob", "read"), false);
  assert.equal(hasGrant(aliceUid, "USER", "bad\nref", "read"), false);

  assert.throws(() => addGrant(aliceUid, "TENANT", "x", "read"), /invalid scope kind/);
  assert.throws(() => addGrant(aliceUid, "USER", "bob", "admin"), /invalid permission/);
  assert.throws(() => addGrant(aliceUid, "USER", "", "read"), /invalid scope ref/);
  assert.throws(() => addGrant(0, "USER", "bob", "read"), /grantee uid/);
  assert.throws(
    () => addGrant(aliceUid, "USER", "bob", "read", -1),
    /grantedBy must be/
  );

  assert.equal(removeGrant(aliceUid, "TENANT", "x", "read"), false);
  assert.equal(removeGrant(aliceUid, "USER", "bob", "admin"), false);
});

test("listGrants: whole table when no grantee is given", () => {
  const all = listGrants();
  assert.ok(all.length > 0);
  assert.equal(
    all.every((r) => typeof r.grantee_user_id === "number"),
    true
  );
  assert.equal(
    all.filter((r) => r.grantee_user_id === aliceUid).length,
    listGrants(aliceUid).length
  );
});
