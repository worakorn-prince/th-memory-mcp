import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const cliPath = join(root, "dist", "cli.js");
const serverPath = join(root, "dist", "index.js");

const workDir = mkdtempSync(join(tmpdir(), "th-auth-p1-"));
const dbPath = join(workDir, "auth.db");

// Default mode for the whole file: MEMORY_AUTH off (v2.5.2 behaviour).
process.env.MEMORY_DB_PATH = dbPath;
delete process.env.MEMORY_AUTH;
delete process.env.MEMORY_AUTH_TOKEN;
delete process.env.MEMORY_AUTH_TOKEN_FILE;

const { db } = await import("../dist/db/index.js");
const migrations = await import("../dist/db/migrations.js");
const { createMemory } = await import("../dist/db/repositories/memories.js");
const { ensureUser, getUserByExternalId, listUsers } = await import(
  "../dist/db/repositories/users.js"
);
const { listTokens, findActiveByHash } = await import(
  "../dist/db/repositories/auth_tokens.js"
);
const { resolveIdentity, setIdentity, getIdentity, AuthError } = await import(
  "../dist/auth/identity.js"
);
const { generateToken } = await import("../dist/auth/token.js");
const { getAuthMode, getAuthToken, getAuthTokenFile } = await import(
  "../dist/lib/config.js"
);
const { importMemoryHandler } = await import("../dist/tools/import_memory.js");

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const countUsers = () => db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
const countMemories = () =>
  db.prepare("SELECT COUNT(*) AS n FROM memories").get().n;
const resultText = (r) => r?.content?.[0]?.text ?? "";

function cli(args, extraEnv = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    env: { ...process.env, MEMORY_DB_PATH: dbPath, ...extraEnv },
    encoding: "utf8",
  });
}

const IDENTITY_SCRIPT = `
const { resolveIdentity } = await import("./dist/auth/identity.js");
try {
  const identity = resolveIdentity();
  process.stdout.write(JSON.stringify({ ok: true, identity }) + "\\n");
} catch (e) {
  process.stderr.write((e && e.message ? e.message : String(e)) + "\\n");
  process.exit(3);
}
`;

function resolveInChild(extraEnv) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", IDENTITY_SCRIPT], {
    cwd: root,
    env: { ...process.env, MEMORY_DB_PATH: dbPath, ...extraEnv },
    encoding: "utf8",
  });
}

test.after(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  rmSync(workDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- config ---

test("config getters: MEMORY_AUTH defaults off, parses on/off, fail-closed", () => {
  assert.equal(getAuthMode({}), "off");
  assert.equal(getAuthMode({ MEMORY_AUTH: "" }), "off");
  assert.equal(getAuthMode({ MEMORY_AUTH: "off" }), "off");
  assert.equal(getAuthMode({ MEMORY_AUTH: "OFF" }), "off");
  assert.equal(getAuthMode({ MEMORY_AUTH: "0" }), "off");
  assert.equal(getAuthMode({ MEMORY_AUTH: "on" }), "on");
  assert.equal(getAuthMode({ MEMORY_AUTH: "yes" }), "on");
  assert.equal(getAuthMode({ MEMORY_AUTH: "ture" }), "on", "unknown value fails closed");
  assert.equal(getAuthToken({ MEMORY_AUTH_TOKEN: "  thm_a_b  " }), "thm_a_b");
  assert.equal(getAuthToken({}), undefined);
  assert.equal(getAuthTokenFile({ MEMORY_AUTH_TOKEN_FILE: "C:/t.txt" }), "C:/t.txt");
  assert.equal(getAuthTokenFile({}), undefined);
});

// ------------------------------------------------------------- migration ---

test("016_auth is additive, defaults users.role to reader, and is idempotent", () => {
  // Run against the shared db: src/db/index.ts creates search_index during
  // bootstrap, so a bare raw Database would fail earlier at M005. This db has
  // already applied every migration, 016_auth included.
  const authTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auth_tokens'")
    .get();
  assert.ok(authTable, "auth_tokens table must exist");

  const idx = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_auth_tokens_user'")
    .get();
  assert.ok(idx, "idx_auth_tokens_user must exist");

  const cols = db.prepare("PRAGMA table_info(users)").all();
  const roles = cols.filter((c) => c.name === "role");
  assert.equal(roles.length, 1, "users.role must exist exactly once");
  assert.equal(roles[0].notnull, 1);
  assert.equal(roles[0].dflt_value, "'reader'");

  db.prepare("INSERT INTO users (external_id, created_at) VALUES ('mig-user', 'now')").run();
  assert.equal(
    db.prepare("SELECT role FROM users WHERE external_id = 'mig-user'").get().role,
    "reader",
    "role default must apply to inserts"
  );

  assert.ok(
    db.prepare("SELECT 1 FROM schema_meta WHERE key = '016_auth'").get(),
    "016_auth must be recorded in schema_meta"
  );

  // Idempotency: clear only the 016 marker, then re-run. The guarded ALTER and
  // IF NOT EXISTS DDL must be safe on an already-migrated DB.
  db.prepare("DELETE FROM schema_meta WHERE key = '016_auth'").run();
  migrations.runMigrations(db);

  const colsAfter = db.prepare("PRAGMA table_info(users)").all();
  assert.equal(colsAfter.filter((c) => c.name === "role").length, 1, "role must not be duplicated");
  assert.ok(
    db.prepare("SELECT 1 FROM schema_meta WHERE key = '016_auth'").get(),
    "016_auth must be recorded again"
  );
  assert.equal(
    db.prepare("SELECT role FROM users WHERE external_id = 'mig-user'").get().role,
    "reader",
    "existing role must survive the re-run"
  );
  assert.ok(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'auth_tokens'").get(),
    "auth_tokens must survive the re-run"
  );
});

// -------------------------------------------------------------- identity ---

test("resolveIdentity: off/unset is legacy and touches no DB", () => {
  assert.deepEqual(resolveIdentity({}), { mode: "legacy", roles: [] });
  assert.deepEqual(resolveIdentity({ MEMORY_AUTH: "off" }), { mode: "legacy", roles: [] });
});

test("resolveIdentity: on without a token throws AuthError (fail-fast input)", () => {
  assert.throws(() => resolveIdentity({ MEMORY_AUTH: "on" }), AuthError);
  assert.throws(() => resolveIdentity({ MEMORY_AUTH: "on" }), /no token/);
});

test("resolveIdentity: on with malformed or unknown token fails generically", () => {
  const env = { MEMORY_AUTH: "on", MEMORY_AUTH_TOKEN: "thm_nobody_short" };
  assert.throws(() => resolveIdentity(env), /authentication failed/);
  const unknown = { MEMORY_AUTH: "on", MEMORY_AUTH_TOKEN: generateToken("nobody") };
  assert.throws(() => resolveIdentity(unknown), /authentication failed/);
});

// ------------------------------------------------------- legacy write path ---

test("legacy mode: createMemory still auto-creates an unknown userId", () => {
  setIdentity({ mode: "legacy", roles: [] });
  const before = countUsers();
  const id = createMemory({ type: "FACT", content: "legacy auto-create probe", userId: "legacy-auto" });
  assert.ok(id > 0);
  const user = getUserByExternalId("legacy-auto");
  assert.ok(user, "legacy mode must mint the user (v2.5.2 behaviour)");
  assert.equal(countUsers(), before + 1);
  const row = db.prepare("SELECT user_id, scope FROM memories WHERE id = ?").get(id);
  assert.equal(row.user_id, user.id);
  assert.equal(row.scope, "USER");
});

// ------------------------------------------------ CLI: add-user/issue-token ---

let aliceToken;
let aliceUid;

test("CLI auth add-user creates a user with a role and never duplicates", () => {
  const r1 = cli(["auth", "add-user", "alice", "--name", "Alice", "--role", "writer"]);
  assert.equal(r1.status, 0, `add-user failed: ${r1.stderr}`);
  assert.match(r1.stdout, /added user alice \(role=writer\)/);

  const r2 = cli(["auth", "add-user", "alice"]);
  assert.equal(r2.status, 0, `add-user (existing) failed: ${r2.stderr}`);
  assert.match(r2.stdout, /already exists \(role=writer\)/);

  const matches = listUsers().filter((u) => u.external_id === "alice");
  assert.equal(matches.length, 1, "add-user must not duplicate");
  assert.equal(matches[0].role, "writer");
  aliceUid = matches[0].id;

  const badRole = cli(["auth", "add-user", "alice", "--role", "superuser"]);
  assert.equal(badRole.status, 2, "invalid role must fail");
});

test("CLI auth issue-token prints the token once and stores only its sha256", () => {
  const r = cli(["auth", "issue-token", "alice", "--label", "laptop"]);
  assert.equal(r.status, 0, `issue-token failed: ${r.stderr}`);
  aliceToken = r.stdout.trim();
  assert.match(aliceToken, /^thm_alice_[A-Za-z0-9_-]{43}$/);

  const expectedHash = sha256(aliceToken);
  const row = db
    .prepare("SELECT token_hash, user_id, label, revoked_at FROM auth_tokens WHERE token_hash = ?")
    .get(expectedHash);
  assert.ok(row, "token must be stored under sha256(token)");
  assert.equal(row.user_id, aliceUid);
  assert.equal(row.label, "laptop");
  assert.equal(row.revoked_at, null);

  // Column set is hash-only: no plaintext column exists at all.
  const cols = db.prepare("PRAGMA table_info(auth_tokens)").all().map((c) => c.name);
  assert.deepEqual(
    cols.slice().sort(),
    ["created_at", "label", "revoked_at", "token_hash", "user_id"].sort()
  );

  assert.equal(findActiveByHash(expectedHash) !== undefined, true);
  assert.equal(findActiveByHash(aliceToken), undefined, "plaintext must never match a lookup");

  const dump = JSON.stringify(listTokens());
  assert.ok(!dump.includes(aliceToken), "list must not expose the token");

  // The raw DB bytes must not contain the plaintext token.
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      const bytes = readFileSync(dbPath + suffix);
      assert.equal(
        bytes.includes(Buffer.from(aliceToken, "utf8")),
        false,
        `plaintext token found in DB file${suffix || ""}`
      );
    } catch {
      /* file may not exist */
    }
  }

  const missing = cli(["auth", "issue-token", "nobody-here"]);
  assert.notEqual(missing.status, 0, "unknown user must not get a token");
  assert.match(missing.stderr, /unknown user/);
});

test("resolveIdentity on a valid token yields enforced identity with uid + role", () => {
  const identity = resolveIdentity({ MEMORY_AUTH: "on", MEMORY_AUTH_TOKEN: aliceToken });
  assert.equal(identity.mode, "enforced");
  assert.equal(identity.userId, "alice");
  assert.equal(identity.uid, aliceUid);
  assert.deepEqual(identity.roles, ["writer"]);

  const child = resolveInChild({ MEMORY_AUTH: "on", MEMORY_AUTH_TOKEN: aliceToken });
  assert.equal(child.status, 0, `child resolve failed: ${child.stderr}`);
  const parsed = JSON.parse(child.stdout.trim().split("\n").pop());
  assert.deepEqual(parsed.identity, {
    mode: "enforced",
    userId: "alice",
    uid: aliceUid,
    roles: ["writer"],
  });
  assert.ok(!child.stdout.includes(aliceToken), "identity output must not echo the token");
});

test("CLI auth list shows users, labels and hash prefixes but no token", () => {
  const r = cli(["auth", "list"]);
  assert.equal(r.status, 0, `list failed: ${r.stderr}`);
  assert.match(r.stdout, /user\talice\twriter/);
  assert.match(r.stdout, /token\talice\twriter\tlaptop\t[0-9a-f]{12}\tactive/);
  assert.ok(!r.stdout.includes(aliceToken), "list must not print the token");
});

// ------------------------------------------------ enforced write-path (T2) ---

test("enforced mode: unknown userId throws and creates no users row", () => {
  setIdentity({ mode: "enforced", userId: "alice", uid: aliceUid, roles: ["writer"] });
  const before = countUsers();
  assert.throws(
    () => createMemory({ type: "FACT", content: "minted by ghost", userId: "ghost-writer" }),
    /unknown user \(auth enforced; no auto-create\)/
  );
  assert.equal(getUserByExternalId("ghost-writer"), undefined, "no minting");
  assert.equal(countUsers(), before, "users table unchanged");

  const id = createMemory({ type: "FACT", content: "known writer probe", userId: "alice" });
  assert.ok(id > 0);
  const row = db.prepare("SELECT user_id, scope FROM memories WHERE id = ?").get(id);
  assert.equal(row.user_id, aliceUid);
  assert.equal(row.scope, "USER");
});

test("enforced mode: anonymous writes (no userId) still work", () => {
  setIdentity({ mode: "enforced", userId: "alice", uid: aliceUid, roles: ["writer"] });
  const id = createMemory({ type: "FACT", content: "anonymous global probe" });
  assert.ok(id > 0);
  assert.equal(db.prepare("SELECT scope FROM memories WHERE id = ?").get(id).scope, "GLOBAL");
});

// ---------------------------------------------------------- revoke / fail ---

test("CLI auth revoke by hash prefix disables the token", () => {
  const prefix = sha256(aliceToken).slice(0, 12);
  const revoked = cli(["auth", "revoke", prefix]);
  assert.equal(revoked.status, 0, `revoke failed: ${revoked.stderr}`);
  assert.match(revoked.stdout, /revoked [0-9a-f]{12}/);
  assert.ok(!revoked.stdout.includes(aliceToken));

  // Verify through the CLI's own read path: each `cli()` call is a fresh
  // process with a fresh connection, so this does not depend on the test
  // process's long-lived connection observing another process's write.
  const listed = cli(["auth", "list", "--json"]);
  assert.equal(listed.status, 0, `list failed: ${listed.stderr}`);
  const listedData = JSON.parse(JSON.parse(listed.stdout).data);
  const row = listedData.tokens.find((t) => t.hash_prefix === prefix);
  assert.ok(row, `revoked row must still be listed: ${listed.stdout}`);
  assert.equal(row.revoked, true, "token must be marked revoked");

  const child = resolveInChild({ MEMORY_AUTH: "on", MEMORY_AUTH_TOKEN: aliceToken });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /authentication failed/);
  assert.ok(!child.stderr.includes(aliceToken), "failure line must not leak the token");

  const again = cli(["auth", "revoke", prefix]);
  assert.notEqual(again.status, 0, "already revoked is not an active match");
  assert.match(again.stderr, /no active token matches/);
});

function resolveIdentityLengthSafe(token) {
  try {
    resolveIdentity({ MEMORY_AUTH: "on", MEMORY_AUTH_TOKEN: token });
    return true;
  } catch {
    return false;
  }
}

test("CLI auth revoke by label works; unknown target fails", () => {
  const issued = cli(["auth", "issue-token", "alice", "--label", "phone"]);
  assert.equal(issued.status, 0, `issue-token failed: ${issued.stderr}`);
  const phoneToken = issued.stdout.trim();

  // Resolve in a fresh process so the check does not depend on the test
  // process's own connection seeing another process's write.
  const valid = resolveInChild({ MEMORY_AUTH: "on", MEMORY_AUTH_TOKEN: phoneToken });
  assert.equal(valid.status, 0, `fresh token must resolve: ${valid.stderr}`);

  const revoked = cli(["auth", "revoke", "phone"]);
  assert.equal(revoked.status, 0, `revoke by label failed: ${revoked.stderr}`);
  const afterRevoke = resolveInChild({ MEMORY_AUTH: "on", MEMORY_AUTH_TOKEN: phoneToken });
  assert.notEqual(afterRevoke.status, 0, "revoked token must not resolve");

  const unknown = cli(["auth", "revoke", "no-such-token"]);
  assert.notEqual(unknown.status, 0);
  assert.match(unknown.stderr, /no active token matches/);
});

// --------------------------------------------------- token file source ---

test("MEMORY_AUTH_TOKEN_FILE works and trims surrounding whitespace", () => {
  const issued = cli(["auth", "issue-token", "alice", "--label", "file-token"]);
  assert.equal(issued.status, 0, `issue-token failed: ${issued.stderr}`);
  const token = issued.stdout.trim();

  const tokenFile = join(workDir, "token.txt");
  writeFileSync(tokenFile, `  ${token}\n`, "utf8");

  const fromFile = resolveInChild({
    MEMORY_AUTH: "on",
    MEMORY_AUTH_TOKEN: "",
    MEMORY_AUTH_TOKEN_FILE: tokenFile,
  });
  assert.equal(fromFile.status, 0, `file token failed: ${fromFile.stderr}`);
  const parsed = JSON.parse(fromFile.stdout.trim().split("\n").pop());
  assert.equal(parsed.identity.mode, "enforced");
  assert.equal(parsed.identity.userId, "alice");

  const missingFile = resolveInChild({
    MEMORY_AUTH: "on",
    MEMORY_AUTH_TOKEN: "",
    MEMORY_AUTH_TOKEN_FILE: join(workDir, "does-not-exist.txt"),
  });
  assert.notEqual(missingFile.status, 0);
  assert.match(missingFile.stderr, /unreadable/);
});

// ------------------------------------------------- server fail-fast (exit 2) ---

test("server exits 2 with one bounded stderr line when MEMORY_AUTH=on and no token", () => {
  const r = spawnSync(process.execPath, [serverPath], {
    cwd: root,
    env: { ...process.env, MEMORY_DB_PATH: dbPath, MEMORY_AUTH: "on" },
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}; stderr=${r.stderr}`);
  assert.equal(r.stdout, "", "stdout must stay protocol-clean");
  const lines = r.stderr.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1, `expected exactly one stderr line, got: ${r.stderr}`);
  assert.match(lines[0], /^\[th-memory-mcp\] auth: MEMORY_AUTH is on but no token was provided/);
});

test("server exits 2 on an unknown token, without echoing it", () => {
  const stranger = generateToken("stranger-danger");
  const r = spawnSync(process.execPath, [serverPath], {
    cwd: root,
    env: {
      ...process.env,
      MEMORY_DB_PATH: dbPath,
      MEMORY_AUTH: "on",
      MEMORY_AUTH_TOKEN: stranger,
    },
    encoding: "utf8",
    timeout: 20000,
  });
  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /authentication failed/);
  assert.ok(!r.stderr.includes(stranger), "token must never be logged");
});

test("getIdentity falls back to env resolution and caches the singleton", () => {
  setIdentity(null);
  assert.equal(getIdentity().mode, "legacy");
  setIdentity({ mode: "enforced", userId: "alice", uid: aliceUid, roles: ["admin"] });
  assert.deepEqual(getIdentity(), {
    mode: "enforced",
    userId: "alice",
    uid: aliceUid,
    roles: ["admin"],
  });
  setIdentity(null);
});

// ------------------------------------- amendment1: import_memory × auth ---

test("enforced mode: import_memory never mints payload users and rolls back unknown owners", () => {
  setIdentity({ mode: "enforced", userId: "alice", uid: aliceUid, roles: ["writer"] });
  const usersBefore = countUsers();
  const memoriesBefore = countMemories();
  const payload = JSON.stringify({
    users: [
      {
        externalId: "ghost-import",
        name: "Ghost",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    memories: [{ type: "FACT", content: "ghost import probe", userId: "ghost-import" }],
  });
  const r = importMemoryHandler({ json: payload, apply: true });
  const out = resultText(r);
  assert.equal(r?.isError, true, `import must fail, got: ${out}`);
  assert.match(out, /unknown user \(auth enforced; no auto-create\)/);
  assert.match(out, /rolled back/);
  assert.equal(countUsers(), usersBefore, "users table must be untouched");
  assert.equal(countMemories(), memoriesBefore, "no memory row may survive the rollback");
  assert.equal(getUserByExternalId("ghost-import"), undefined, "no minted user row");
});

test("enforced mode: import for an existing user succeeds; payload users are skipped, not imported", () => {
  setIdentity({ mode: "enforced", userId: "alice", uid: aliceUid, roles: ["writer"] });
  const usersBefore = countUsers();
  const payload = JSON.stringify({
    users: [{ externalId: "alice", name: "Alice (from export)" }],
    memories: [{ type: "FACT", content: "alice import probe", userId: "alice" }],
  });
  const r = importMemoryHandler({ json: payload, apply: true });
  const out = resultText(r);
  assert.ok(!r?.isError, `import failed: ${out}`);
  assert.match(out, /users 0 ok/, "summary must not count payload users as imported");
  assert.match(
    out,
    /users 1 skipped \(auth enforced: create via 'th-memory auth add-user'\)/
  );
  assert.equal(countUsers(), usersBefore, "no users row added (alice already existed)");
  const row = db
    .prepare("SELECT user_id, scope FROM memories WHERE content = 'alice import probe'")
    .get();
  assert.ok(row, "memory must be imported for the existing user");
  assert.equal(row.user_id, aliceUid);
  assert.equal(row.scope, "USER");
});

test("legacy mode: import still restores payload users (v2.5.2 behaviour preserved)", () => {
  setIdentity({ mode: "legacy", roles: [] });
  const usersBefore = countUsers();
  const payload = JSON.stringify({
    users: [
      {
        externalId: "ghost2",
        name: "Legacy Ghost",
        createdAt: "2026-02-02T00:00:00.000Z",
      },
    ],
    memories: [{ type: "FACT", content: "legacy import probe", userId: "ghost2" }],
  });
  const r = importMemoryHandler({ json: payload, apply: true });
  const out = resultText(r);
  assert.ok(!r?.isError, `import failed: ${out}`);
  assert.match(out, /users 1 ok/, "legacy summary must count the restored payload user");
  assert.ok(!out.includes("skipped (auth enforced"), "legacy must not skip payload users");
  const ghost = getUserByExternalId("ghost2");
  assert.ok(ghost, "payload user must be restored in legacy mode");
  assert.equal(countUsers(), usersBefore + 1);
  const row = db
    .prepare("SELECT user_id FROM memories WHERE content = 'legacy import probe'")
    .get();
  assert.equal(row?.user_id, ghost.id);
});

// ---------------------------------- amendment1: list --json / ambiguity ---

test("CLI auth list --json exposes hash prefixes only (no 64-hex hash, no plaintext token)", () => {
  const issued = cli(["auth", "issue-token", "alice", "--label", "jsonprobe"]);
  assert.equal(issued.status, 0, `issue-token failed: ${issued.stderr}`);
  const probeToken = issued.stdout.trim();

  const r = cli(["auth", "list", "--json"]);
  assert.equal(r.status, 0, `list --json failed: ${r.stderr}`);
  assert.ok(!/\b[0-9a-f]{64}\b/.test(r.stdout), "no full sha256 hash may appear");
  assert.ok(!r.stdout.includes(probeToken), "plaintext token must not appear");
  assert.ok(!r.stdout.includes(aliceToken), "earlier plaintext token must not appear");

  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.ok, true);
  const data = JSON.parse(parsed.data);
  assert.ok(Array.isArray(data.tokens) && data.tokens.length > 0, "tokens must be listed");
  for (const t of data.tokens) {
    assert.deepEqual(
      Object.keys(t).sort(),
      ["created_at", "external_id", "hash_prefix", "label", "revoked", "role"].sort(),
      `unexpected token field set: ${Object.keys(t).join(",")}`
    );
    assert.match(t.hash_prefix, /^[0-9a-f]{12}$/);
    assert.equal(typeof t.revoked, "boolean");
  }
  const probe = data.tokens.find((t) => t.label === "jsonprobe");
  assert.ok(probe, "the freshly issued token must be listed");
  assert.equal(probe.revoked, false);
  assert.equal(probe.external_id, "alice");
});

test("CLI auth revoke with two active tokens sharing one label fails as ambiguous", () => {
  const t1 = cli(["auth", "issue-token", "alice", "--label", "dupe"]);
  assert.equal(t1.status, 0, `issue-token 1 failed: ${t1.stderr}`);
  const t2 = cli(["auth", "issue-token", "alice", "--label", "dupe"]);
  assert.equal(t2.status, 0, `issue-token 2 failed: ${t2.stderr}`);

  const r = cli(["auth", "revoke", "dupe"]);
  assert.notEqual(r.status, 0, "ambiguous revoke must fail");
  assert.match(r.stderr, /ambiguous "dupe": 2 active tokens match/);
});

// -------------------------------- amendment1: sanitized names and labels ---

test("CLI add-user/issue-token strip control characters and cap names/labels at 100 chars", () => {
  const weirdName = `ok\x1f\x7f${"x".repeat(150)}`;
  const added = cli(["auth", "add-user", "sanitized", "--name", weirdName]);
  assert.equal(added.status, 0, `add-user failed: ${added.stderr}`);

  // Read back through the CLI (fresh process, fresh connection).
  const listed = cli(["auth", "list", "--json"]);
  assert.equal(listed.status, 0, `list failed: ${listed.stderr}`);
  const data = JSON.parse(JSON.parse(listed.stdout).data);
  const user = data.users.find((u) => u.external_id === "sanitized");
  assert.ok(user, `user must exist: ${listed.stdout}`);
  assert.equal(user.name, `ok${"x".repeat(98)}`, "control chars stripped, capped at 100");

  const labeled = cli(["auth", "issue-token", "alice", "--label", "tab\there"]);
  assert.equal(labeled.status, 0, `issue-token failed: ${labeled.stderr}`);
  const listed2 = cli(["auth", "list", "--json"]);
  assert.equal(listed2.status, 0, `list failed: ${listed2.stderr}`);
  const data2 = JSON.parse(JSON.parse(listed2.stdout).data);
  const tokens = data2.tokens.filter((t) => t.label !== null);
  assert.equal(
    tokens.some((t) => /[\x00-\x1f\x7f]/.test(t.label)),
    false,
    "no stored label may contain control characters"
  );
  assert.ok(
    tokens.every((t) => (t.label ?? "").length <= 100),
    "no stored label may exceed 100 chars"
  );
  assert.equal(
    tokens.some((t) => t.label === "tabhere"),
    true,
    "label 'tab\\there' must be stored as 'tabhere'"
  );
});

// ------------------------------------ amendment1: positive enforced boot ---

test("server boots in enforced mode with a valid token (ready on stdio, does not exit 2)", async () => {
  const issued = cli(["auth", "issue-token", "alice", "--label", "boot"]);
  assert.equal(issued.status, 0, `issue-token failed: ${issued.stderr}`);
  const bootToken = issued.stdout.trim();

  const child = spawn(process.execPath, [serverPath], {
    cwd: root,
    env: {
      ...process.env,
      MEMORY_DB_PATH: dbPath,
      MEMORY_AUTH: "on",
      MEMORY_AUTH_TOKEN: bootToken,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  // `exit` can be observed before the last stderr `data` event is delivered, so
  // wait for the stream to close before deciding the server never reported
  // ready. (stdin is ignored here, so the server sees EOF and exits on its own.)
  const stderrClosed = new Promise((resolve) => child.stderr.on("close", resolve));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));

  let ready = false;
  const deadline = Date.now() + 15000;
  while (!ready && Date.now() < deadline) {
    if (stderr.includes("ready on stdio")) {
      ready = true;
      break;
    }
    const settled = await Promise.race([
      new Promise((resolve) => setTimeout(resolve, 50, "tick")),
      exited.then((code) => `exit:${code}`),
    ]);
    if (typeof settled === "string" && settled.startsWith("exit:")) {
      // Drain pending stderr data before evaluating readiness.
      await Promise.race([
        stderrClosed,
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
      ready = stderr.includes("ready on stdio");
      break;
    }
  }

  try {
    assert.ok(ready, `server never reported ready; exit stderr=${stderr}`);
    assert.ok(!stderr.includes("auth:"), `no auth error expected, got: ${stderr}`);
  } finally {
    child.kill();
  }
  const code = await exited;
  assert.notEqual(code, 2, `must not exit 2 with a valid token (code=${code})`);
  assert.ok(!stderr.includes(bootToken), "token must never be logged");
});
