// P1-A: matrix + parity tests for the shared scope helper (src/lib/scope.ts).
//
// The helper is DB-free, but the SQL clause it produces is exercised against
// an in-memory better-sqlite3 database to prove the SQL predicate filters
// exactly like the JS helper (no project DB is touched).
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

const { isScopeVisible, buildScopeClause } = await import(
  "../dist/lib/scope.js"
);

const rec = (scope, extra = {}) => ({
  scope,
  project_id: null,
  session_id: null,
  user_id: null,
  ...extra,
});

const GLOBAL = rec("GLOBAL");
const USER7 = rec("USER", { user_id: 7 });
const USER9 = rec("USER", { user_id: 9 });
const SESSION_S1 = rec("SESSION", { session_id: "s1" });
const SESSION_S2 = rec("SESSION", { session_id: "s2" });
const PROJECT_P1 = rec("PROJECT", { project_id: "p1" });
const PROJECT_P2 = rec("PROJECT", { project_id: "p2" });

test("isScopeVisible matrix: scope x ctx presence x match/mismatch", () => {
  const full = {
    userId: "alice",
    resolvedUid: 7,
    sessionId: "s1",
    projectId: "p1",
  };
  const matrix = [
    // GLOBAL passes with ctx present or absent.
    ["GLOBAL / empty ctx", GLOBAL, {}, true],
    ["GLOBAL / full ctx", GLOBAL, full, true],
    // USER: external userId presence gate + resolved numeric comparison.
    ["USER match own uid", USER7, { userId: "alice", resolvedUid: 7 }, true],
    ["USER mismatch foreign uid", USER7, { userId: "alice", resolvedUid: 9 }, false],
    ["USER hidden when ctx has no userId", USER7, {}, false],
    ["USER hidden when only resolvedUid present", USER7, { resolvedUid: 7 }, false],
    ["USER hidden when caller scoped to another user", USER9, { userId: "alice", resolvedUid: 7 }, false],
    // SESSION.
    ["SESSION match", SESSION_S1, { sessionId: "s1" }, true],
    ["SESSION mismatch", SESSION_S1, { sessionId: "s2" }, false],
    ["SESSION hidden without sessionId", SESSION_S1, {}, false],
    // PROJECT.
    ["PROJECT match", PROJECT_P1, { projectId: "p1" }, true],
    ["PROJECT mismatch", PROJECT_P1, { projectId: "p2" }, false],
    ["PROJECT hidden without projectId", PROJECT_P1, {}, false],
    // Unknown scope values are hidden (SEC-14 fail-closed).
    ["unknown scope hidden", rec("FUTURE_SCOPE"), {}, false],
    ["unknown scope hidden with full ctx", rec("FUTURE_SCOPE"), full, false],
  ];
  for (const [name, record, ctx, expected] of matrix) {
    assert.equal(isScopeVisible(record, ctx), expected, name);
  }
});

test("isScopeVisible: resolvedUid and null edge behaviors (legacy parity)", () => {
  // userId present but unresolvable (resolvedUid null) falls back to the
  // legacy `record.user_id === resolvedUid` comparison — null matches null.
  // Kept exactly as the duplicated JS copies behaved before P1-A.
  assert.equal(
    isScopeVisible(rec("USER", { user_id: null }), { userId: "ghost" }),
    true,
    "null owner matches unresolved uid"
  );
  assert.equal(isScopeVisible(USER7, { userId: "ghost" }), false);
  assert.equal(isScopeVisible(USER7, { userId: "ghost", resolvedUid: null }), false);
  // Empty-string external id still passes the presence gate (legacy `!= null`).
  assert.equal(isScopeVisible(USER7, { userId: "", resolvedUid: 7 }), true);
  // Empty-string session/project ids are real values, not "absent".
  assert.equal(
    isScopeVisible(rec("SESSION", { session_id: "" }), { sessionId: "" }),
    true
  );
  assert.equal(isScopeVisible(SESSION_S1, { sessionId: "" }), false);
  assert.equal(
    isScopeVisible(rec("PROJECT", { project_id: "" }), { projectId: "" }),
    true
  );
});

test("buildScopeClause: parameterized predicate, named params, alias validation", () => {
  const clause = buildScopeClause("m");
  assert.match(clause.sql, /^\(m\.scope = 'GLOBAL'/);
  assert.equal(clause.sql.includes("m.user_id = @uid"), true);
  assert.equal(clause.sql.includes("m.session_id = @sid"), true);
  assert.equal(clause.sql.includes("m.project_id = @pid"), true);
  assert.equal(clause.sql.includes("IS NOT NULL"), true);
  assert.deepEqual(clause.params, { uid: null, sid: null, pid: null });

  const filled = buildScopeClause("m", {
    resolvedUid: 42,
    sessionId: "s1",
    projectId: "p1",
  });
  assert.deepEqual(filled.params, { uid: 42, sid: "s1", pid: "p1" });

  const aliased = buildScopeClause("e2", { resolvedUid: 1 });
  assert.equal(aliased.sql.includes("e2.scope = 'GLOBAL'"), true);
  assert.equal(aliased.sql.includes("m."), false);
  assert.deepEqual(aliased.params, { uid: 1, sid: null, pid: null });

  for (const bad of [
    "",
    "m; DROP TABLE memories --",
    "m m",
    "m.user_id = 1 OR 1=1",
    "1abc",
  ]) {
    assert.throws(
      () => buildScopeClause(bad),
      /invalid SQL alias/,
      `alias must be rejected: ${JSON.stringify(bad)}`
    );
  }
});

test("SQL clause filters identically to isScopeVisible (in-memory parity)", () => {
  const raw = new Database(":memory:");
  try {
    raw.exec(
      `CREATE TABLE memories (
         id INTEGER PRIMARY KEY,
         scope TEXT NOT NULL,
         project_id TEXT,
         session_id TEXT,
         user_id INTEGER
       );`
    );
    const fixtures = [
      ["GLOBAL", null, null, null],
      ["USER", null, null, 7],
      ["USER", null, null, 9],
      ["SESSION", null, "s1", null],
      ["SESSION", null, "s2", null],
      ["PROJECT", "p1", null, null],
      ["PROJECT", "p2", null, null],
      ["FUTURE_SCOPE", null, null, null],
    ];
    const insert = raw.prepare(
      "INSERT INTO memories (id, scope, project_id, session_id, user_id) VALUES (?, ?, ?, ?, ?)"
    );
    fixtures.forEach((row, i) => insert.run(i + 1, ...row));

    const allRows = raw
      .prepare("SELECT id, scope, project_id, session_id, user_id FROM memories")
      .all();

    const contexts = [
      { userId: "alice", resolvedUid: 7, sessionId: "s1", projectId: "p1" },
      { userId: "alice", resolvedUid: 9, sessionId: "s2", projectId: "p2" },
      { userId: "alice", resolvedUid: 7 },
      { userId: "ghost", resolvedUid: null },
      { userId: "alice" },
      { sessionId: "s1" },
      { projectId: "p2" },
      {},
    ];
    for (const ctx of contexts) {
      const scope = buildScopeClause("m", ctx);
      const sqlIds = raw
        .prepare(`SELECT id FROM memories m WHERE ${scope.sql} ORDER BY id`)
        .all(scope.params)
        .map((r) => r.id);
      const jsIds = allRows
        .filter((row) => isScopeVisible(row, ctx))
        .map((r) => r.id);
      assert.deepEqual(
        sqlIds,
        jsIds,
        `parity for ctx ${JSON.stringify(ctx)}`
      );
    }
  } finally {
    raw.close();
  }
});

test("unknown scope is fail-closed in SQL and JS; corrupt USER row is the remaining divergence", () => {
  // Unknown scope (SEC-14): both the SQL clause and isScopeVisible hide a row
  // whose scope is not one of the four writer constants (e.g. 'FUTURE').
  // Remaining divergence: legacy JS can match `null === null` for a corrupt
  // USER row when the caller passed an external userId that did not resolve;
  // the SQL clause hides such rows instead. Production USER rows always carry
  // a resolved user_id (createMemory), so this only affects corrupt data —
  // and hiding is the safe direction.
  const raw = new Database(":memory:");
  try {
    raw.exec(
      `CREATE TABLE memories (
         id INTEGER PRIMARY KEY,
         scope TEXT NOT NULL,
         project_id TEXT,
         session_id TEXT,
         user_id INTEGER
       );`
    );
    raw.prepare("INSERT INTO memories (id, scope, user_id) VALUES (1, 'USER', NULL)").run();
    raw.prepare("INSERT INTO memories (id, scope) VALUES (2, 'FUTURE')").run();
    const ctx = { userId: "ghost" };
    const scope = buildScopeClause("m", ctx);
    const sqlIds = raw
      .prepare(`SELECT id FROM memories m WHERE ${scope.sql}`)
      .all(scope.params);
    assert.deepEqual(
      sqlIds,
      [],
      "SQL hides null-owner USER and unknown-scope rows (fail-closed)"
    );
    assert.equal(
      isScopeVisible(rec("USER", { user_id: null }), ctx),
      true,
      "JS legacy path still matches null owner (kept for parity)"
    );
    assert.equal(
      isScopeVisible(rec("FUTURE"), ctx),
      false,
      "JS helper hides unknown scopes (SEC-14 fail-closed)"
    );
  } finally {
    raw.close();
  }
});
