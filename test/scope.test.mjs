import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const dbPath = join(tmpdir(), `th-mem-scope-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { createMemory, getMemoryById } = await import("../dist/db/repositories/memories.js");
const { retrieve } = await import("../dist/core/retrieval-engine.js");
const { db } = await import("../dist/db/index.js");

function rankOf(results, id) {
  const i = results.findIndex((r) => r.id === id);
  return i === -1 ? Infinity : i;
}

test("scope hierarchy isolates SESSION/PROJECT/GLOBAL in retrieval", async () => {
  const g = createMemory({ type: "FACT", content: "global memory G", importance: 0.9 });
  const p1 = createMemory({
    type: "FACT",
    content: "project p1 memory",
    projectId: "p1",
    importance: 0.9,
  });
  const s1 = createMemory({
    type: "FACT",
    content: "session s1 memory",
    projectId: "p1",
    sessionId: "s1",
    importance: 0.9,
  });
  const s2 = createMemory({
    type: "FACT",
    content: "session s2 memory",
    sessionId: "s2",
    importance: 0.9,
  });
  const p2 = createMemory({
    type: "FACT",
    content: "project p2 memory",
    projectId: "p2",
    importance: 0.9,
  });

  // Project-scoped query: PROJECT(p1) should outrank GLOBAL and other sessions.
  const projRes = retrieve("memory", { projectId: "p1", limit: 10 });
  assert.ok(
    rankOf(projRes, p1) < rankOf(projRes, g),
    `PROJECT(p1) should rank above GLOBAL: p1=${rankOf(projRes, p1)} g=${rankOf(projRes, g)}`
  );
  assert.ok(
    rankOf(projRes, p1) < rankOf(projRes, s2),
    `PROJECT(p1) should rank above SESSION(s2): p1=${rankOf(projRes, p1)} s2=${rankOf(projRes, s2)}`
  );

  // Session-scoped query: SESSION(s1) should rank first.
  const sessRes = retrieve("memory", { projectId: "p1", sessionId: "s1", limit: 10 });
  assert.equal(
    rankOf(sessRes, s1),
    0,
    `SESSION(s1) should be top result: rank=${rankOf(sessRes, s1)}`
  );
  assert.ok(
    rankOf(sessRes, s1) < rankOf(sessRes, p1),
    `SESSION(s1) should outrank PROJECT(p1)`
  );

  // Global query: GLOBAL should outrank a foreign SESSION.
  const globRes = retrieve("memory", { limit: 10 });
  assert.ok(
    rankOf(globRes, g) < rankOf(globRes, s2),
    `GLOBAL should outrank foreign SESSION in global query: g=${rankOf(globRes, g)} s2=${rankOf(globRes, s2)}`
  );
});

test("USER scope isolates per-user memories in retrieval", async () => {
  const a = createMemory({
    type: "FACT",
    content: "user alice secret setting",
    userId: "alice",
    importance: 0.9,
  });
  const b = createMemory({
    type: "FACT",
    content: "user bob secret setting",
    userId: "bob",
    importance: 0.9,
  });
  const g = createMemory({
    type: "FACT",
    content: "global setting shared by all",
    importance: 0.9,
  });

  const ma = getMemoryById(a);
  const mb = getMemoryById(b);
  assert.equal(ma?.scope, "USER");
  assert.equal(mb?.scope, "USER");
  assert.ok(typeof ma?.user_id === "number" && typeof mb?.user_id === "number");
  assert.notEqual(ma?.user_id, mb?.user_id, "different users get distinct ids");

  // As alice: her USER memory should outrank bob's and global.
  const asAlice = retrieve("setting", { userId: "alice", limit: 10 });
  assert.ok(
    rankOf(asAlice, a) < rankOf(asAlice, b),
    `alice's memory should outrank bob's: a=${rankOf(asAlice, a)} b=${rankOf(asAlice, b)}`
  );
  assert.ok(
    rankOf(asAlice, a) < rankOf(asAlice, g),
    `alice's memory should outrank global: a=${rankOf(asAlice, a)} g=${rankOf(asAlice, g)}`
  );

  // As bob: his USER memory should outrank alice's and global.
  const asBob = retrieve("setting", { userId: "bob", limit: 10 });
  assert.ok(
    rankOf(asBob, b) < rankOf(asBob, a),
    `bob's memory should outrank alice's: b=${rankOf(asBob, b)} a=${rankOf(asBob, a)}`
  );
  assert.ok(
    rankOf(asBob, b) < rankOf(asBob, g),
    `bob's memory should outrank global: b=${rankOf(asBob, b)} g=${rankOf(asBob, g)}`
  );

  // Global context (no userId): global should outrank foreign USER memories.
  const glob = retrieve("setting", { limit: 10 });
  assert.ok(
    rankOf(glob, g) < rankOf(glob, a),
    `global should outrank alice's USER memory in global query: g=${rankOf(glob, g)} a=${rankOf(glob, a)}`
  );
  assert.ok(
    rankOf(glob, g) < rankOf(glob, b),
    `global should outrank bob's USER memory in global query: g=${rankOf(glob, g)} b=${rankOf(glob, b)}`
  );

  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await import("node:fs").then((fs) =>
        fs.rmSync(`${dbPath}${suffix}`, { force: true })
      );
    } catch {}
  }
});
