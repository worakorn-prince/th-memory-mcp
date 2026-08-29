import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const dbPath = join(tmpdir(), `th-mem-scope-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { createMemory } = await import("../dist/db/repositories/memories.js");
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

  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await import("node:fs").then((fs) =>
        fs.rmSync(`${dbPath}${suffix}`, { force: true })
      );
    } catch {}
  }
});
