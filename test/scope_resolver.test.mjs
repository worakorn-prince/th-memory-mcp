import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

const workDir = mkdtempSync(join(tmpdir(), "th-auth-p3-resolver-"));
const dbPath = join(workDir, "resolver.db");

process.env.MEMORY_DB_PATH = dbPath;
process.env.MEMORY_BACKUP_ON_MIGRATE = "0";
delete process.env.MEMORY_AUTH;

const { db } = await import("../dist/db/index.js");
const { ensureUser } = await import("../dist/db/repositories/users.js");
const { addGrant, removeGrant } = await import(
  "../dist/db/repositories/scope_grants.js"
);
const {
  bindScopeToIdentity,
  describeScope,
  getEffectiveScope,
  runWithScope,
} = await import("../dist/auth/scope-resolver.js");

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

const LEGACY = { mode: "legacy", roles: [] };

function enforced(roles, externalId = "alice", uid = aliceUid) {
  return { mode: "enforced", userId: externalId, uid, roles };
}

function bind(identity, args, toolName) {
  return bindScopeToIdentity(identity, args, toolName);
}

function assertDenied(result, reason) {
  assert.equal(result.ok, false, "expected a deny");
  assert.equal(result.reason, reason);
  assert.equal("scope" in result, false, "a deny must never carry a scope");
}

// ------------------------------------------------------- legacy passthrough ---

test("legacy: pass-through scope, no DB work, caller args untouched", () => {
  const args = { userId: "bob", sessionId: "s-1", topic: "anything" };
  const before = JSON.parse(JSON.stringify(args));
  const result = bind(LEGACY, args, "recall");

  assert.equal(result.ok, true);
  assert.equal(result.scope.mode, "legacy");
  assert.equal(result.scope.allowGlobalWrite, true);
  assert.deepEqual(args, before, "legacy must not rewrite the caller's args");
  assert.deepEqual(Object.keys(args).sort(), ["sessionId", "topic", "userId"]);
});

test("legacy: writes are allowed for any tool name", () => {
  for (const tool of ["consolidate", "import_memory", "remember"]) {
    const result = bind(LEGACY, {}, tool);
    assert.equal(result.ok, true, `${tool} must pass in legacy mode`);
  }
});

// ------------------------------------------------------------- own userId ---

test("enforced: own userId is ok and resolves to the identity uid", () => {
  const result = bind(enforced(["reader"]), { userId: "alice" }, "recall");
  assert.equal(result.ok, true);
  assert.equal(result.scope.mode, "enforced");
  assert.equal(result.scope.externalId, "alice");
  assert.equal(result.scope.uid, aliceUid);
  assert.equal(result.scope.userId, "alice");
  assert.equal(result.scope.resolvedUid, aliceUid);
  assert.equal(result.scope.sessionId, null);
  assert.equal(result.scope.projectId, null);
});

test("enforced: absent userId defaults to the caller's own scope", () => {
  const write = bind(enforced(["writer"]), { category: "c", key: "k" }, "remember");
  assert.equal(write.ok, true);
  assert.equal(write.scope.userId, "alice");
  assert.equal(write.scope.resolvedUid, aliceUid);
  assert.equal(write.scope.allowGlobalWrite, false, "writer has no GLOBAL grant");

  const read = bind(enforced(["reader"]), {}, "recall");
  assert.equal(read.ok, true);
  assert.equal(read.scope.userId, "alice");
});

test("enforced: non-string scope args are ignored (never trusted)", () => {
  const result = bind(enforced(["reader"]), { userId: 42, sessionId: 7 }, "recall");
  assert.equal(result.ok, true);
  assert.equal(result.scope.userId, "alice");
  assert.equal(result.scope.sessionId, null);
});

// ---------------------------------------------------- foreign userId + grants ---

test("enforced: foreign userId is denied without a grant", () => {
  assertDenied(bind(enforced(["reader"]), { userId: "bob" }, "recall"), "scope");
  assertDenied(
    bind(enforced(["writer"]), { userId: "bob" }, "update_memory"),
    "scope"
  );
});

test("enforced: a read grant allows reading the foreign USER scope", () => {
  addGrant(aliceUid, "USER", "bob", "read");
  const result = bind(enforced(["reader"]), { userId: "bob" }, "recall");
  assert.equal(result.ok, true);
  assert.equal(result.scope.userId, "bob");
  assert.equal(result.scope.resolvedUid, bobUid);
  assert.equal(result.scope.allowGlobalWrite, false);
});

test("enforced: a read grant never authorizes a write on the same target", () => {
  assertDenied(
    bind(enforced(["writer"]), { userId: "bob" }, "update_memory"),
    "scope"
  );
  // The same call succeeds once a write grant exists.
  addGrant(aliceUid, "USER", "bob", "write");
  const result = bind(enforced(["writer"]), { userId: "bob" }, "update_memory");
  assert.equal(result.ok, true);
  assert.equal(result.scope.resolvedUid, bobUid);
  removeGrant(aliceUid, "USER", "bob", "write");
});

test("enforced: a grant naming an unknown user still fails closed", () => {
  addGrant(aliceUid, "USER", "ghost", "read");
  assertDenied(bind(enforced(["reader"]), { userId: "ghost" }, "recall"), "scope");
  removeGrant(aliceUid, "USER", "ghost", "read");
});

// ------------------------------------------------- project / session grants ---

test("enforced: project scope is denied, then allowed with a grant", () => {
  const identity = enforced(["writer"]);
  assertDenied(bind(identity, { projectId: "proj-1" }, "get_context"), "scope");

  addGrant(aliceUid, "PROJECT", "proj-1", "read");
  const granted = bind(identity, { projectId: "proj-1" }, "get_context");
  assert.equal(granted.ok, true);
  assert.equal(granted.scope.projectId, "proj-1");
  assert.equal(granted.scope.userId, "alice");
  removeGrant(aliceUid, "PROJECT", "proj-1", "read");
});

test("enforced: session scope is denied, then allowed with a grant", () => {
  const identity = enforced(["reader"]);
  assertDenied(bind(identity, { sessionId: "sess-9" }, "recall"), "scope");

  addGrant(aliceUid, "SESSION", "sess-9", "read");
  const granted = bind(identity, { sessionId: "sess-9" }, "recall");
  assert.equal(granted.ok, true);
  assert.equal(granted.scope.sessionId, "sess-9");
  removeGrant(aliceUid, "SESSION", "sess-9", "read");
});

test("enforced: a session write needs a write grant on the session", () => {
  const identity = enforced(["writer"]);
  addGrant(aliceUid, "SESSION", "sess-w", "read");
  assertDenied(bind(identity, { sessionId: "sess-w" }, "extract_memories"), "scope");
  addGrant(aliceUid, "SESSION", "sess-w", "write");
  const result = bind(identity, { sessionId: "sess-w" }, "extract_memories");
  assert.equal(result.ok, true);
  assert.equal(result.scope.sessionId, "sess-w");
  removeGrant(aliceUid, "SESSION", "sess-w", "write");
  removeGrant(aliceUid, "SESSION", "sess-w", "read");
});

// ------------------------------------------------------------- GLOBAL write ---

test("enforced: GLOBAL write is allowed for owner and admin", () => {
  for (const role of ["owner", "admin"]) {
    const result = bind(enforced([role]), {}, "consolidate");
    assert.equal(result.ok, true, `${role} must be allowed`);
    assert.equal(result.scope.allowGlobalWrite, true);
    assert.equal(result.scope.userId, "alice");
  }
});

test("enforced: GLOBAL write is denied for a writer without a grant", () => {
  assertDenied(bind(enforced(["writer"]), {}, "consolidate"), "global-write");
  assertDenied(bind(enforced(["writer"]), {}, "import_memory"), "global-write");
});

test("enforced: GLOBAL write is allowed for a writer with the explicit grant", () => {
  addGrant(aliceUid, "GLOBAL", "*", "write");
  const result = bind(enforced(["writer"]), {}, "consolidate");
  assert.equal(result.ok, true);
  assert.equal(result.scope.allowGlobalWrite, true);
  removeGrant(aliceUid, "GLOBAL", "*", "write");
});

test("enforced: a writer's own-scope write and GLOBAL read stay allowed", () => {
  const ownWrite = bind(enforced(["writer"]), { key: "k" }, "save_lesson");
  assert.equal(ownWrite.ok, true, "own USER write is not a GLOBAL write");

  const globalRead = bind(enforced(["reader"]), {}, "memory_stats");
  assert.equal(globalRead.ok, true);
  assert.equal(globalRead.scope.allowGlobalWrite, false);
});

// ------------------------------------------------------- unusable identity ---

test("enforced: identity without uid/userId is denied (fail closed)", () => {
  assertDenied(bind({ mode: "enforced", roles: ["admin"] }, {}, "recall"), "scope");
  assertDenied(
    bind({ mode: "enforced", userId: "alice", roles: ["admin"] }, {}, "recall"),
    "scope"
  );
});

// --------------------------------------------------------------- ALS scope ---

test("runWithScope: getEffectiveScope is null outside and bound inside", () => {
  assert.equal(getEffectiveScope(), null, "no scope outside the guard");

  const bound = bind(enforced(["reader"]), { userId: "alice" }, "recall");
  assert.equal(bound.ok, true);

  const seen = runWithScope(bound.scope, () => getEffectiveScope());
  assert.equal(seen, bound.scope);
  assert.equal(getEffectiveScope(), null, "context must not leak after the call");
});

test("runWithScope: the scope survives awaits inside the handler", async () => {
  const bound = bind(enforced(["reader"]), { userId: "alice" }, "recall");
  assert.equal(bound.ok, true);

  const result = await runWithScope(bound.scope, async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    const mid = getEffectiveScope();
    await Promise.resolve();
    return { mid, end: getEffectiveScope() };
  });

  assert.equal(result.mid?.userId, "alice");
  assert.equal(result.end?.uid, aliceUid);
  assert.equal(getEffectiveScope(), null);
});

test("runWithScope: concurrent contexts stay isolated", async () => {
  const first = bind(enforced(["reader"]), { userId: "alice" }, "recall");
  const second = bind(enforced(["writer"]), { userId: "bob" }, "recall");
  assert.equal(first.ok && second.ok, true);

  const [a, b] = await Promise.all([
    runWithScope(first.scope, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return getEffectiveScope()?.userId;
    }),
    runWithScope(second.scope, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return getEffectiveScope()?.userId;
    }),
  ]);

  assert.equal(a, "alice");
  assert.equal(b, "bob");
});

// ---------------------------------------------------------------- hardened ---

test("scope is frozen and audited without argument content", () => {
  const bound = bind(enforced(["reader"]), { userId: "alice", topic: "secret" }, "recall");
  assert.equal(bound.ok, true);
  assert.equal(Object.isFrozen(bound.scope), true);
  assert.throws(() => {
    bound.scope.allowGlobalWrite = true;
  }, TypeError);

  const fields = describeScope(bound.scope);
  assert.equal(fields.scopeKind, "USER");
  assert.equal(fields.scopeRef, "alice");
  assert.equal(JSON.stringify(fields).includes("secret"), false);
});
