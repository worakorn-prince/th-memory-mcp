import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const dbPath = join(tmpdir(), `th-memory-security-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { createMemory } = await import("../dist/db/repositories/memories.js");
const { retrieve } = await import("../dist/core/retrieval-engine.js");
const { getContext } = await import("../dist/core/context-engine.js");
const { linkMemoryHandler } = await import("../dist/tools/link_memory.js");
const { db } = await import("../dist/db/index.js");

test("security: foreign USER records are not returned", async () => {
  const alice = createMemory({ type: "FACT", content: "alice secret alpha", userId: "alice", importance: 0.9 });
  const bob = createMemory({ type: "FACT", content: "bob secret beta", userId: "bob", importance: 0.9 });
  const g = createMemory({ type: "FACT", content: "global shared secret gamma", importance: 0.9 });

  const asAlice = retrieve("secret", { userId: "alice", limit: 10 });
  const idsAlice = new Set(asAlice.map((r) => r.id));
  assert.ok(idsAlice.has(alice), "alice sees own record");
  assert.ok(!idsAlice.has(bob), "alice must not see bob's USER memory");
  assert.ok(idsAlice.has(g), "alice can see GLOBAL");

  const asBob = retrieve("secret", { userId: "bob", limit: 10 });
  const idsBob = new Set(asBob.map((r) => r.id));
  assert.ok(idsBob.has(bob));
  assert.ok(!idsBob.has(alice));

  const ctxAlice = getContext({ query: "secret", userId: "alice", limit: 10 });
  assert.ok(ctxAlice.memories.some((m) => m.id === alice));
  assert.ok(!ctxAlice.memories.some((m) => m.id === bob));

  const globalCtx = getContext({ query: "secret", limit: 10 });
  assert.ok(!globalCtx.memories.some((m) => m.id === alice), "global must not see USER alice");
  assert.ok(!globalCtx.memories.some((m) => m.id === bob));
});

test("security: foreign SESSION records are not returned", async () => {
  const s1 = createMemory({ type: "FACT", content: "session s1 delta", sessionId: "s1", importance: 0.9 });
  const s2 = createMemory({ type: "FACT", content: "session s2 delta", sessionId: "s2", importance: 0.9 });

  const asS1 = retrieve("delta", { sessionId: "s1", limit: 10 });
  assert.ok(new Set(asS1.map((r) => r.id)).has(s1));
  assert.ok(!new Set(asS1.map((r) => r.id)).has(s2), "s1 must not see s2");

  const ctxS1 = getContext({ query: "delta", sessionId: "s1", limit: 10 });
  assert.ok(ctxS1.memories.some((m) => m.id === s1));
  assert.ok(!ctxS1.memories.some((m) => m.id === s2));
});

test("security: graph expansion does not leak cross-scope neighbors", async () => {
  const aliceMem = createMemory({ type: "FACT", content: "alice graph root", userId: "alice", importance: 0.9 });
  const bobMem = createMemory({ type: "FACT", content: "bob graph neighbor", userId: "bob", importance: 0.9 });
  const aliceLink = linkMemoryHandler({ sourceId: aliceMem, targetId: bobMem, relation: "related_to" });
  assert.match(aliceLink.content[0].text, /cannot link memories across different users/);

  const a = createMemory({ type: "FACT", content: "graph seed shared", importance: 0.9 });
  const b = createMemory({ type: "FACT", content: "graph neighbor shared", importance: 0.9 });
  const ok = linkMemoryHandler({ sourceId: a, targetId: b, relation: "related_to" });
  assert.match(ok.content[0].text, /linked memory/);

  const ctx = getContext({ query: "shared", includeGraph: true, limit: 10 });
  assert.ok(ctx.memories.some((m) => m.id === a));
});

test("security: PROJECT isolation", async () => {
  const p1 = createMemory({ type: "FACT", content: "project p1 epsilon", projectId: "p1", importance: 0.9 });
  const p2 = createMemory({ type: "FACT", content: "project p2 epsilon", projectId: "p2", importance: 0.9 });

  const asP1 = retrieve("epsilon", { projectId: "p1", limit: 10 });
  assert.ok(new Set(asP1.map((r) => r.id)).has(p1));
  assert.ok(!new Set(asP1.map((r) => r.id)).has(p2), "p1 must not see p2");

  const ctxP1 = getContext({ query: "epsilon", projectId: "p1", limit: 10 });
  assert.ok(ctxP1.memories.some((m) => m.id === p1));
  assert.ok(!ctxP1.memories.some((m) => m.id === p2));

  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await import("node:fs").then((fs) => fs.rmSync(`${dbPath}${suffix}`, { force: true }));
    } catch {}
  }
});
