import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));

const workDir = mkdtempSync(join(tmpdir(), "th-auth-p3-audit-"));
const dbPath = join(workDir, "audit.db");

process.env.MEMORY_DB_PATH = dbPath;
process.env.MEMORY_BACKUP_ON_MIGRATE = "0";
delete process.env.MEMORY_AUTH;

const { db } = await import("../dist/db/index.js");
const { runMigrations } = await import("../dist/db/migrations.js");
const { ensureUser } = await import("../dist/db/repositories/users.js");
const { MAX_SCOPE_REF, listRecent, recordDecision } = await import(
  "../dist/db/repositories/audit_log.js"
);

const aliceUid = ensureUser("alice");

test.after(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  rmSync(workDir, { recursive: true, force: true });
});

async function captureStderr(fn) {
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const value = fn();
    return { value, stderr: chunks.join("") };
  } finally {
    process.stderr.write = original;
  }
}

const count = () => db.prepare("SELECT COUNT(*) AS n FROM audit_log").get().n;

// ------------------------------------------------------------- allow + deny ---

test("recordDecision: an allow row stores the decision fields", () => {
  recordDecision({
    uid: aliceUid,
    tool: "recall",
    kind: "read",
    decision: "allow",
    reason: null,
    scopeKind: "USER",
    scopeRef: "alice",
  });

  const row = listRecent(1)[0];
  assert.equal(row.user_id, aliceUid);
  assert.equal(row.tool, "recall");
  assert.equal(row.kind, "read");
  assert.equal(row.decision, "allow");
  assert.equal(row.reason, null);
  assert.equal(row.scope_kind, "USER");
  assert.equal(row.scope_ref, "alice");
  assert.match(row.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("recordDecision: a deny row keeps its enum reason", () => {
  recordDecision({
    uid: aliceUid,
    tool: "forget",
    kind: "write",
    decision: "deny",
    reason: "scope",
    scopeKind: "USER",
    scopeRef: "bob",
  });

  const row = listRecent(1)[0];
  assert.equal(row.decision, "deny");
  assert.equal(row.reason, "scope");
  assert.equal(row.kind, "write");
  assert.equal(row.scope_ref, "bob");
});

test("recordDecision: newest first and limit is clamped", () => {
  recordDecision({ uid: aliceUid, tool: "memory_stats", kind: "read", decision: "allow" });
  recordDecision({ uid: aliceUid, tool: "get_profile", kind: "read", decision: "allow" });

  const rows = listRecent(2);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].tool, "get_profile");
  assert.equal(rows[1].tool, "memory_stats");

  assert.equal(listRecent(0).length, 1, "limit is clamped to >= 1");
  assert.equal(listRecent(100000).length <= 500, true);
});

// ------------------------------------------------------------------ bounded ---

test("recordDecision: scope_ref is capped and CR/LF are flattened", () => {
  const hostile = "x".repeat(300) + "\r\n" + "y";
  recordDecision({
    uid: aliceUid,
    tool: "recall",
    kind: "read",
    decision: "deny",
    reason: `scope\r\ninjected`,
    scopeKind: "SESSION",
    scopeRef: hostile,
  });

  const row = listRecent(1)[0];
  assert.equal(row.scope_ref.length <= MAX_SCOPE_REF, true, `len=${row.scope_ref.length}`);
  assert.equal(MAX_SCOPE_REF, 120);
  assert.equal(/[\r\n]/.test(row.scope_ref), false, "no newline can forge a log line");
  assert.equal(/[\r\n]/.test(row.reason), false);

  recordDecision({
    uid: aliceUid,
    tool: `t\n${"z".repeat(200)}`,
    kind: "read",
    decision: "allow",
  });
  const toolRow = listRecent(1)[0];
  assert.equal(toolRow.tool.length <= 64, true);
  assert.equal(/[\r\n]/.test(toolRow.tool), false);
});

test("recordDecision: tool args/content are never stored", () => {
  const secret = "correct horse battery staple SECRET";
  recordDecision({
    uid: aliceUid,
    tool: "remember",
    kind: "write",
    decision: "allow",
    reason: null,
    scopeKind: "USER",
    scopeRef: "alice",
  });
  const row = listRecent(1)[0];
  const dump = JSON.stringify(row);
  assert.equal(dump.includes(secret), false);
  assert.deepEqual(
    Object.keys(row).sort(),
    [
      "decision",
      "id",
      "kind",
      "reason",
      "scope_kind",
      "scope_ref",
      "tool",
      "ts",
      "user_id",
    ].sort(),
    "no content column exists"
  );
});

// ----------------------------------------------------- failure is best-effort ---

test("recordDecision: an unknown uid still records the row (NULL owner)", async () => {
  const before = count();
  const { value, stderr } = await captureStderr(() =>
    recordDecision({
      uid: 999999,
      tool: "recall",
      kind: "read",
      decision: "allow",
      scopeKind: "GLOBAL",
      scopeRef: "*",
    })
  );

  assert.equal(value, undefined, "recordDecision returns nothing");
  assert.equal(stderr, "", "a recoverable FK failure must not print");
  assert.equal(count(), before + 1, "the decision is still audited");
  const row = listRecent(1)[0];
  assert.equal(row.user_id, null);
  assert.equal(row.tool, "recall");
});

test("recordDecision: a failed insert never throws, one bounded stderr line", async () => {
  db.exec("DROP TABLE audit_log");
  try {
    const { value, stderr } = await captureStderr(() =>
      recordDecision({
        uid: aliceUid,
        tool: "recall",
        kind: "read",
        decision: "deny",
        reason: "scope",
        scopeKind: "USER",
        scopeRef: "bob",
      })
    );

    assert.equal(value, undefined, "no throw escapes the audit sink");
    const lines = stderr.split("\n").filter((l) => l.length > 0);
    assert.equal(lines.length, 1, "exactly one stderr line");
    assert.equal(lines[0].includes("\r"), false);
    assert.equal(lines[0].length <= 200, true, `len=${lines[0].length}`);
    assert.match(lines[0], /^\[th-memory-mcp\] audit: insert failed/);

    // A second failure replaces rather than accumulates: still one line each.
    const second = await captureStderr(() =>
      recordDecision({ uid: aliceUid, tool: "recall", kind: "read", decision: "allow" })
    );
    assert.equal(second.stderr.split("\n").filter((l) => l.length > 0).length, 1);
  } finally {
    db.prepare("DELETE FROM schema_meta WHERE key = '017_scope'").run();
    runMigrations(db);
  }

  assert.equal(count(), 0, "restored table starts empty");
  recordDecision({
    uid: aliceUid,
    tool: "recall",
    kind: "read",
    decision: "allow",
  });
  assert.equal(count(), 1, "the sink works again after the table is restored");
});
