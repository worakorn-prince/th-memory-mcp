// Batch C security hardening: profile scope isolation (SEC-01), update trust
// preservation (SEC-06), fail-closed scope (SEC-14) and context metadata caps.
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, after } from "node:test";
import assert from "node:assert/strict";

const dbPath = join(tmpdir(), `th-mem-sec-batch-c-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;
process.env.MEMORY_RETRIEVAL_MODE = "fts-only";

const { createMemory } = await import("../dist/db/repositories/memories.js");
const { getProfileHandler } = await import("../dist/tools/profile.js");
const { updateMemoryHandler } = await import("../dist/tools/update_memory.js");
const { contextHandler } = await import("../dist/tools/context.js");
const { isScopeVisible } = await import("../dist/lib/scope.js");
const { db } = await import("../dist/db/index.js");

after(() => {
  try {
    db.close();
  } catch {}
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`, { force: true });
    } catch {}
  }
});

function textOf(r) {
  return r.content[0].text;
}

function metadataOf(id) {
  const row = db.prepare("SELECT metadata FROM memories WHERE id = ?").get(id);
  return row?.metadata ? JSON.parse(row.metadata) : null;
}

test("SEC-01: get_profile filters memories by scope and fails closed without args", async () => {
  createMemory({
    type: "FACT",
    content: "GLOBAL profile marker global-c-marker",
    importance: 1,
    confidence: 1,
  });
  createMemory({
    type: "FACT",
    content: "ALICE profile marker alice-c-marker",
    userId: "alice",
    importance: 1,
    confidence: 1,
  });
  createMemory({
    type: "FACT",
    content: "BOB profile marker bob-c-marker",
    userId: "bob",
    importance: 1,
    confidence: 1,
  });
  createMemory({
    type: "FACT",
    content: "PROJECT profile marker project-c-marker",
    projectId: "p1",
    importance: 1,
    confidence: 1,
  });
  createMemory({
    type: "FACT",
    content: "SESSION profile marker session-c-marker",
    sessionId: "s1",
    importance: 1,
    confidence: 1,
  });

  const unscoped = textOf(await getProfileHandler());
  assert.ok(unscoped.includes("global-c-marker"), unscoped);
  for (const marker of [
    "alice-c-marker",
    "bob-c-marker",
    "project-c-marker",
    "session-c-marker",
  ]) {
    assert.ok(
      !unscoped.includes(marker),
      `unscoped profile must exclude ${marker}: ${unscoped}`
    );
  }

  const asAlice = textOf(await getProfileHandler({ userId: "alice" }));
  assert.ok(asAlice.includes("global-c-marker"));
  assert.ok(asAlice.includes("alice-c-marker"));
  for (const marker of ["bob-c-marker", "project-c-marker", "session-c-marker"]) {
    assert.ok(
      !asAlice.includes(marker),
      `alice profile must exclude ${marker}: ${asAlice}`
    );
  }

  const asP1 = textOf(await getProfileHandler({ projectId: "p1" }));
  assert.ok(asP1.includes("global-c-marker"));
  assert.ok(asP1.includes("project-c-marker"));
  for (const marker of ["alice-c-marker", "bob-c-marker", "session-c-marker"]) {
    assert.ok(!asP1.includes(marker), `p1 profile must exclude ${marker}`);
  }

  const asS1 = textOf(await getProfileHandler({ sessionId: "s1" }));
  assert.ok(asS1.includes("global-c-marker"));
  assert.ok(asS1.includes("session-c-marker"));
  for (const marker of ["alice-c-marker", "bob-c-marker", "project-c-marker"]) {
    assert.ok(!asS1.includes(marker), `s1 profile must exclude ${marker}`);
  }

  const asGhost = textOf(await getProfileHandler({ userId: "ghost" }));
  assert.ok(asGhost.includes("global-c-marker"));
  assert.ok(!asGhost.includes("alice-c-marker"));
  assert.ok(!asGhost.includes("bob-c-marker"));

  assert.ok(unscoped.includes("<memory-reference>"));
  assert.ok(unscoped.includes("</memory-reference>"));
});

test("SEC-06: update_memory cannot escalate or drop the trusted flag", () => {
  const untrusted = createMemory({
    type: "FACT",
    content: "untrusted update probe",
    metadata: { trusted: false, note: "orig" },
  });

  let r = updateMemoryHandler({
    id: untrusted,
    metadata: { trusted: true, note: "tampered" },
  });
  assert.ok(!textOf(r).startsWith("error:"), textOf(r));
  let meta = metadataOf(untrusted);
  assert.equal(meta.trusted, false, "false -> true must be blocked");
  assert.equal(meta.note, "tampered");

  r = updateMemoryHandler({ id: untrusted, metadata: null });
  assert.ok(!textOf(r).startsWith("error:"), textOf(r));
  meta = metadataOf(untrusted);
  assert.equal(meta?.trusted, false, "null metadata must keep the untrusted label");

  const trusted = createMemory({
    type: "FACT",
    content: "trusted update probe",
    metadata: { trusted: true, note: "orig" },
  });
  r = updateMemoryHandler({
    id: trusted,
    metadata: { trusted: false, note: "downgrade" },
  });
  assert.ok(!textOf(r).startsWith("error:"), textOf(r));
  meta = metadataOf(trusted);
  assert.equal(meta.trusted, true, "trusted true must be preserved");

  const legacyUntrusted = createMemory({
    type: "FACT",
    content: "legacy object without trust flag",
    metadata: { note: "legacy" },
  });
  r = updateMemoryHandler({
    id: legacyUntrusted,
    metadata: { trusted: true, note: "escalate" },
  });
  assert.ok(!textOf(r).startsWith("error:"), textOf(r));
  meta = metadataOf(legacyUntrusted);
  assert.equal(meta.trusted, undefined, "missing flag must stay absent, never escalate");
});

test("SEC-06: malformed legacy metadata is safe in the supersede path", () => {
  const plain = createMemory({
    type: "FACT",
    content: "malformed legacy metadata v1",
  });
  db.prepare("UPDATE memories SET metadata = ? WHERE id = ?").run(
    "not-json{",
    plain
  );

  let r = updateMemoryHandler({
    id: plain,
    content: "malformed legacy metadata v2",
  });
  assert.ok(!textOf(r).startsWith("error:"), textOf(r));
  const superseded = db
    .prepare("SELECT id, metadata FROM memories WHERE content = ?")
    .get("malformed legacy metadata v2");
  assert.ok(superseded, "superseding memory must be created");
  assert.equal(superseded.metadata, null);

  const escalated = createMemory({
    type: "FACT",
    content: "malformed legacy escalate v1",
  });
  db.prepare("UPDATE memories SET metadata = ? WHERE id = ?").run(
    "{broken",
    escalated
  );

  r = updateMemoryHandler({
    id: escalated,
    content: "malformed legacy escalate v2",
    metadata: { trusted: true, note: "nope" },
  });
  assert.ok(!textOf(r).startsWith("error:"), textOf(r));
  const newRow = db
    .prepare("SELECT id, metadata FROM memories WHERE content = ?")
    .get("malformed legacy escalate v2");
  assert.ok(newRow, "superseding memory must be created");
  const meta = JSON.parse(newRow.metadata);
  assert.equal(meta.trusted, undefined, "malformed legacy cannot authorize trust");
  assert.equal(meta.note, "nope");
});

test("SEC-14: isScopeVisible fails closed on unknown scope values", () => {
  const record = (scope) => ({
    scope,
    project_id: null,
    session_id: null,
    user_id: null,
  });
  assert.equal(isScopeVisible(record("GLOBAL"), {}), true);
  assert.equal(isScopeVisible(record("FUTURE_SCOPE"), {}), false);
  assert.equal(
    isScopeVisible(record("FUTURE_SCOPE"), {
      userId: "alice",
      resolvedUid: 1,
      sessionId: "s1",
      projectId: "p1",
    }),
    false
  );
});

test("context caps metadata so it cannot bypass the content token budget", () => {
  const body = "floodprobeuniquetoken memory body";
  createMemory({
    type: "FACT",
    content: body,
    importance: 1,
    confidence: 1,
    metadata: { note: "Z".repeat(5000), nested: "Y".repeat(5000) },
  });

  const text = textOf(
    contextHandler({ query: "floodprobeuniquetoken", limit: 5, maxTokens: 1000 })
  );
  assert.ok(text.includes(body), `flood memory must be returned: ${text}`);
  assert.ok(text.includes("<memory-reference>"));
  assert.ok(text.includes("</memory-reference>"));
  assert.ok(text.includes("meta="), "metadata is rendered (truncated)");
  assert.ok(
    !text.includes("Z".repeat(400)),
    "huge metadata must be truncated per line"
  );
  assert.ok(
    text.length < body.length + 1000,
    `context output must stay bounded (got ${text.length} chars)`
  );
});
