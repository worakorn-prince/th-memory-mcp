// TASK-PERF-READ: decoded-vector cache.
//
// Gate: vectorSearch/recall must return exactly the same ids, scores, ordering
// and floor/scope behaviour as the full-BLOB read path. The reference below is
// an independently written copy of the pre-change algorithm (read every BLOB,
// deserialize, cosine, filter, stable sort, slice).
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { test, after } from "node:test";
import assert from "node:assert/strict";

const dbPath = join(tmpdir(), `th-mem-vec-cache-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;
process.env.MEMORY_BACKUP_ON_MIGRATE = "0";

const { db, upsertEmbedding, removeEmbedding, getAllEmbeddings, getAllEmbeddingKeys, withVectorSnapshot } =
  await import("../dist/db/index.js");
const { createMemory, setStatus } = await import(
  "../dist/db/repositories/memories.js"
);
const { resolveUserId } = await import("../dist/db/repositories/users.js");
const { vectorSearch } = await import("../dist/retrieval/vector.js");
const { recallHandler } = await import("../dist/tools/recall.js");
const { rememberHandler } = await import("../dist/tools/remember.js");
const { forgetHandler } = await import("../dist/tools/forget.js");
const { embed, cosine, deserialize, serialize, EMBED_DIM } = await import(
  "../dist/lib/embed.js"
);
const cache = await import("../dist/retrieval/vector-cache.js");

const TOPIC = "pnpm typescript deployment server";
const N = 300;

function referenceScored(query, opts = {}) {
  const uid = opts.userId ? resolveUserId(opts.userId) : null;
  const rows = db
    .prepare(
      `SELECT e.ref_id as id, e.vec as vec
       FROM embeddings e
       JOIN memories m ON m.id = e.ref_id
       WHERE e.ref_table = 'memories'
         AND (? OR m.status NOT IN ('deleted','archived','superseded'))
         AND (m.scope = 'GLOBAL'
           OR (m.scope = 'USER' AND ? IS NOT NULL AND m.user_id = ?)
           OR (m.scope = 'SESSION' AND ? IS NOT NULL AND m.session_id = ?)
           OR (m.scope = 'PROJECT' AND ? IS NOT NULL AND m.project_id = ?))`
    )
    .all(
      opts.includeArchived ? 1 : 0,
      uid,
      uid,
      opts.sessionId ?? null,
      opts.sessionId ?? null,
      opts.projectId ?? null,
      opts.projectId ?? null
    );
  const topicVec = embed(query);
  return rows.map((r) => ({
    id: r.id,
    score: cosine(topicVec, deserialize(r.vec)),
  }));
}

function referenceSearch(query, opts = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const floor = opts.floor ?? 0.15;
  return referenceScored(query, opts)
    .filter((r) => r.score >= floor)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

const textOf = (r) => r.content[0].text;

// --- seed (300 deterministic memories with exact ties, plus scoped rows) ---
cache.setVectorCacheBudgetMb(64);
for (let i = 0; i < N; i++) {
  const group = i % 6;
  createMemory({
    type: group % 2 === 0 ? "PREFERENCE" : "FACT",
    content:
      `memory group ${group} pnpm typescript deployment server` +
      (group === 0 ? " ติดตั้งโปรแกรมบนเซิร์ฟเวอร์" : ""),
  });
}
const projId = createMemory({
  type: "FACT",
  content: "project scoped pnpm deployment notes",
  projectId: "proj-vec",
});
const sessId = createMemory({
  type: "FACT",
  content: "session scoped pnpm deployment notes",
  sessionId: "sess-vec",
});
const userId = createMemory({
  type: "FACT",
  content: "user scoped pnpm deployment notes",
  userId: "user-vec",
});
const archivedId = createMemory({
  type: "FACT",
  content: "archived pnpm deployment row",
});
setStatus(archivedId, "archived");
await rememberHandler({
  category: "coding_pref",
  key: "vec_cache_pref",
  value: "prefer pnpm workspaces for typescript deployments",
});

// Planner statistics are what exposed the tie-order bug: with stats present,
// SQLite can switch a statement between a SCAN (rowid order) and a
// covering-index SEARCH (ref_id order). Collect them before the parity tests so
// the deterministic ORDER BY is what holds the tie order, not plan luck.
db.exec("ANALYZE");

after(() => {
  try {
    db.close();
  } catch {}
  for (const s of ["", "-wal", "-shm"]) rmSync(`${dbPath}${s}`, { force: true });
});

test("deserialize is zero-copy on aligned little-endian blobs and copies otherwise", () => {
  const vec = embed("hello cache world");
  const buf = serialize(vec);
  const fast = deserialize(buf);
  assert.equal(fast.length, EMBED_DIM);
  assert.equal(fast.buffer, buf.buffer, "aligned blob must be viewed in place");
  assert.equal(fast.byteOffset, buf.byteOffset);
  for (let i = 0; i < EMBED_DIM; i++) assert.equal(fast[i], vec[i]);

  const padded = Buffer.concat([Buffer.alloc(3), buf]);
  const unaligned = padded.subarray(3);
  assert.notEqual(unaligned.byteOffset % 4, 0);
  const slow = deserialize(unaligned);
  assert.notEqual(slow.buffer, unaligned.buffer, "unaligned blob must be copied");
  for (let i = 0; i < EMBED_DIM; i++) assert.equal(slow[i], vec[i]);
});

test("vectorSearch parity with the full-BLOB reference (limit 5/50, floor keeps and drops)", () => {
  const all = referenceScored(TOPIC).sort((a, b) => b.score - a.score);
  assert.ok(all.length >= N, `reference should see the seed rows, got ${all.length}`);
  const midFloor = all[Math.floor(all.length / 2)].score;
  const kept = all.filter((r) => r.score >= midFloor).length;
  assert.ok(kept > 0 && kept < all.length, "mid floor must both keep and drop rows");

  for (const limit of [5, 50]) {
    assert.deepStrictEqual(
      vectorSearch(TOPIC, { limit, floor: 0.15 }),
      referenceSearch(TOPIC, { limit, floor: 0.15 }),
      `limit ${limit} / floor 0.15 must match exactly`
    );
    assert.deepStrictEqual(
      vectorSearch(TOPIC, { limit, floor: midFloor }),
      referenceSearch(TOPIC, { limit, floor: midFloor }),
      `limit ${limit} / mid floor must match exactly`
    );
    assert.deepStrictEqual(
      vectorSearch(TOPIC, { limit, floor: 1.01 }),
      [],
      "unreachable floor must drop everything"
    );
  }
});

test("cache fill once, then steady-state hits return identical results", () => {
  cache.clearVectorCache();
  const before = cache.vectorCacheStats();
  assert.equal(before.entries, 0);

  const first = vectorSearch(TOPIC, { limit: 10 });
  const filled = cache.vectorCacheStats();
  assert.ok(filled.misses > 0, "cold query must miss");
  assert.ok(filled.entries > 0, "cold query must fill the cache");
  assert.ok(filled.bytes <= filled.budgetBytes);

  const second = vectorSearch(TOPIC, { limit: 10 });
  const steady = cache.vectorCacheStats();
  assert.equal(steady.misses, filled.misses, "warm query must not miss");
  assert.ok(steady.hits > filled.hits);
  assert.deepStrictEqual(second, first);
  assert.deepStrictEqual(second, referenceSearch(TOPIC, { limit: 10 }));
});

test("scope parity: project / session / user / archived", () => {
  const cases = [
    { projectId: "proj-vec" },
    { sessionId: "sess-vec" },
    { userId: "user-vec" },
    { includeArchived: true },
  ];
  for (const opts of cases) {
    const got = vectorSearch(TOPIC, { limit: 50, ...opts });
    const expected = referenceSearch(TOPIC, { limit: 50, ...opts });
    assert.deepStrictEqual(got, expected, `scope ${JSON.stringify(opts)} must match`);
  }
  assert.ok(
    vectorSearch("project scoped pnpm deployment", { limit: 5, projectId: "proj-vec" }).some(
      (r) => r.id === projId
    )
  );
  assert.ok(
    vectorSearch("session scoped pnpm deployment", { limit: 5, sessionId: "sess-vec" }).some(
      (r) => r.id === sessId
    )
  );
  assert.ok(
    vectorSearch("user scoped pnpm deployment", { limit: 5, userId: "user-vec" }).some(
      (r) => r.id === userId
    )
  );
  // The archived row scores ~0.43 against TOPIC and ranks last of 301 rows, so
  // any limit window would exclude it for ranking reasons, not scope reasons.
  // Probe it with a query it wins, so only the status filter can hide it.
  const archivedQuery = "archived pnpm deployment row";
  assert.ok(
    !vectorSearch(archivedQuery, { limit: 5 }).some((r) => r.id === archivedId),
    "archived row must stay hidden without includeArchived"
  );
  const archivedHit = vectorSearch(archivedQuery, {
    limit: 5,
    includeArchived: true,
  });
  assert.deepStrictEqual(
    archivedHit,
    referenceSearch(archivedQuery, { limit: 5, includeArchived: true })
  );
  assert.ok(
    archivedHit.some((r) => r.id === archivedId),
    "includeArchived must surface the archived row"
  );
});

test("re-embedding a memory invalidates the stale cached vector", () => {
  const oldContent = "zebracachelegacy";
  const id = createMemory({ type: "FACT", content: oldContent });
  const warm = vectorSearch(oldContent, { limit: 5 });
  assert.ok(warm.some((r) => r.id === id), "seeded row must be found before the update");
  assert.ok(cache.getVector(cache.vectorKey("memories", id)), "old vector must be cached");

  const newContent = "quartzphantom";
  db.prepare("UPDATE memories SET content = ? WHERE id = ?").run(newContent, id);
  upsertEmbedding("memories", id, embed(newContent));
  assert.equal(
    cache.getVector(cache.vectorKey("memories", id)),
    undefined,
    "write must invalidate the decoded cache"
  );

  assert.ok(
    !vectorSearch(oldContent, { limit: 50 }).some((r) => r.id === id),
    "old query must not surface the row via a stale vector"
  );
  const fresh = vectorSearch(newContent, { limit: 5 });
  assert.ok(fresh.some((r) => r.id === id), "new query must surface the row");
  const top = fresh.find((r) => r.id === id);
  assert.ok(top.score > 0.9, `self-similarity should be ~1, got ${top.score}`);

  const cached = cache.getVector(cache.vectorKey("memories", id));
  const expected = embed(newContent);
  assert.ok(cached, "cache must hold the fresh vector after re-read");
  for (let i = 0; i < EMBED_DIM; i++) assert.equal(cached[i], expected[i]);
});

test("a write invalidates only its own key, leaving the rest of the cache warm", () => {
  cache.setVectorCacheBudgetMb(64);
  vectorSearch(TOPIC, { limit: 10 });

  const id = createMemory({ type: "FACT", content: "perkeywrite sentinel row" });
  vectorSearch("perkeywrite sentinel row", { limit: 5 });
  assert.ok(cache.getVector(cache.vectorKey("memories", id)), "row must be cached");

  const before = cache.vectorCacheStats();
  const epochBefore = cache.getVectorEpoch();
  db.prepare("UPDATE memories SET content = ? WHERE id = ?").run("perkeywrite updated", id);
  upsertEmbedding("memories", id, embed("perkeywrite updated"));

  const afterUpsert = cache.vectorCacheStats();
  assert.equal(
    cache.getVector(cache.vectorKey("memories", id)),
    undefined,
    "the written key must be invalidated"
  );
  assert.equal(
    afterUpsert.entries,
    before.entries - 1,
    "only the written key may be dropped (a full clear would empty the cache)"
  );
  assert.ok(afterUpsert.entries > 1, "sibling entries must survive the write");
  assert.equal(afterUpsert.epoch, epochBefore, "single writes must not bump the epoch");

  const removeId = createMemory({ type: "FACT", content: "perkeyremove sentinel row" });
  vectorSearch("perkeyremove sentinel row", { limit: 5 });
  assert.ok(cache.getVector(cache.vectorKey("memories", removeId)), "row must be cached");
  const beforeRemove = cache.vectorCacheStats();
  removeEmbedding("memories", removeId);
  assert.equal(
    cache.getVector(cache.vectorKey("memories", removeId)),
    undefined,
    "the removed key must be invalidated"
  );
  assert.equal(
    cache.vectorCacheStats().entries,
    beforeRemove.entries - 1,
    "remove must drop only its own key"
  );
});

test("forget removes the row and drops it from the cache", async () => {
  const id = createMemory({ type: "FACT", content: "forgetcache doomed content token" });
  vectorSearch("forgetcache doomed content token", { limit: 5 });
  assert.ok(cache.getVector(cache.vectorKey("memories", id)), "vector must be cached");

  const res = await forgetHandler({ target_id: id, type: "memory" });
  assert.ok(!textOf(res).startsWith("error:"), `forget failed: ${textOf(res)}`);
  assert.equal(cache.getVector(cache.vectorKey("memories", id)), undefined);
  assert.ok(
    !vectorSearch("forgetcache doomed content token", { limit: 50 }).some((r) => r.id === id)
  );
});

test("tiny budget stays under the byte limit and still returns correct results", () => {
  const perEntry = EMBED_DIM * 4;
  cache.setVectorCacheBudgetMb(0.02); // ~20 KB -> ~10 entries of 2 KB
  try {
    const got = vectorSearch(TOPIC, { limit: 10 });
    const stats = cache.vectorCacheStats();
    assert.ok(stats.enabled);
    assert.ok(stats.bytes <= stats.budgetBytes, `bytes ${stats.bytes} > budget ${stats.budgetBytes}`);
    assert.ok(stats.entries <= Math.floor(stats.budgetBytes / perEntry) + 1);
    assert.deepStrictEqual(got, referenceSearch(TOPIC, { limit: 10 }));
  } finally {
    cache.setVectorCacheBudgetMb(64);
  }
});

test("a table larger than the capacity cap matches cache-off and stays warm", () => {
  cache.setVectorCacheBudgetMb(0);
  const reference = vectorSearch(TOPIC, { limit: 50 });

  cache.setVectorCacheBudgetMb(0.1); // ~105 KB -> 38 slots, below the ~300 rows
  try {
    const first = vectorSearch(TOPIC, { limit: 50 });
    assert.deepStrictEqual(first, reference, "over-cap rows must still be scored");
    const afterFirst = cache.vectorCacheStats();
    assert.ok(afterFirst.hits > 0, "the resident rows must come from the matrix");
    assert.ok(afterFirst.bytes > 0);
    assert.ok(
      afterFirst.bytes <= afterFirst.budgetBytes,
      `bytes ${afterFirst.bytes} > budget ${afterFirst.budgetBytes}`
    );

    const second = vectorSearch(TOPIC, { limit: 50 });
    assert.deepStrictEqual(second, reference, "the second query must be exact too");
    const afterSecond = cache.vectorCacheStats();
    assert.ok(
      afterSecond.hits > afterFirst.hits,
      "the resident rows must be hits on the second query, not a fresh fill"
    );
    assert.ok(
      afterSecond.misses > afterFirst.misses,
      "only the over-cap rows are refetched"
    );
    assert.equal(
      afterSecond.bytes,
      afterFirst.bytes,
      "the matrix must not be reallocated per query"
    );
    assert.ok(afterSecond.bytes <= afterSecond.budgetBytes);
  } finally {
    cache.setVectorCacheBudgetMb(64);
  }
});

test("a capacity cap that holds no vector still returns cache-off results", () => {
  cache.setVectorCacheBudgetMb(0);
  const reference = vectorSearch(TOPIC, { limit: 50 });

  cache.setVectorCacheBudgetMb(0.001); // ~1 KB, less than one 2 KB slot
  try {
    assert.deepStrictEqual(vectorSearch(TOPIC, { limit: 50 }), reference);
    const stats = cache.vectorCacheStats();
    assert.ok(stats.enabled);
    assert.equal(stats.entries, 0);
    assert.equal(stats.bytes, 0);
    assert.ok(stats.misses > 0, "every row must be a miss under a zero cap");
  } finally {
    cache.setVectorCacheBudgetMb(64);
  }
});

test("recall matches cache-off when the capacity cap holds only a few vectors", async () => {
  cache.setVectorCacheBudgetMb(0);
  const referenceText = textOf(await recallHandler({ topic: TOPIC, limit: 5 }));
  try {
    for (const mb of [0.1, 0.001]) {
      cache.setVectorCacheBudgetMb(mb);
      const text = textOf(await recallHandler({ topic: TOPIC, limit: 5 }));
      assert.equal(
        text,
        referenceText,
        `budget ${mb} MB must produce identical recall text`
      );
      const stats = cache.vectorCacheStats();
      assert.ok(stats.bytes <= stats.budgetBytes);
    }
  } finally {
    cache.setVectorCacheBudgetMb(64);
  }
});

test("MEMORY_VECTOR_CACHE_MB=0 path matches the cached path exactly", () => {
  const cachedResults = vectorSearch(TOPIC, { limit: 50 });
  cache.setVectorCacheBudgetMb(0);
  try {
    assert.equal(cache.isVectorCacheEnabled(), false);
    const disabled = vectorSearch(TOPIC, { limit: 50 });
    assert.deepStrictEqual(disabled, cachedResults);
    assert.deepStrictEqual(disabled, referenceSearch(TOPIC, { limit: 50 }));

    const scoped = vectorSearch(TOPIC, { limit: 50, projectId: "proj-vec" });
    assert.deepStrictEqual(scoped, referenceSearch(TOPIC, { limit: 50, projectId: "proj-vec" }));
  } finally {
    cache.setVectorCacheBudgetMb(64);
  }
});

test("getAllEmbeddingKeys preserves getAllEmbeddings row order", () => {
  const rows = getAllEmbeddings();
  const keys = getAllEmbeddingKeys();
  assert.equal(keys.length, rows.length);
  for (let i = 0; i < rows.length; i++) {
    assert.equal(keys[i].ref_table, rows[i].ref_table);
    assert.equal(keys[i].ref_id, rows[i].ref_id);
  }
});

test("cosine matches a hand-written dot product", () => {
  const a = embed("pnpm workspaces typescript deployment");
  const b = embed("deployment server notes");
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  const got = cosine(a, b);
  assert.ok(
    Math.abs(got - dot) < 1e-9,
    `cosine ${got} must match the reference dot product ${dot}`
  );
});

test("withVectorSnapshot passes values through, nests in a transaction, and rolls back on throw", () => {
  // (a) the callback's return value comes back unchanged.
  assert.equal(withVectorSnapshot(() => 41 + 1), 42);
  assert.deepStrictEqual(withVectorSnapshot(() => ({ nested: ["a", 1] })), {
    nested: ["a", 1],
  });
  assert.equal(db.inTransaction, false);

  // (b) nested inside db.transaction: the savepoint releases, the outer
  // transaction still commits, and the write is visible afterwards.
  const committed = db.transaction(() => {
    const id = createMemory({
      type: "FACT",
      content: "snapshot nested commit sentinel row",
    });
    const seenInside = withVectorSnapshot(
      () => db.prepare("SELECT content FROM memories WHERE id = ?").get(id).content
    );
    return { id, seenInside, inTransactionInside: db.inTransaction };
  })();
  assert.equal(committed.seenInside, "snapshot nested commit sentinel row");
  assert.equal(committed.inTransactionInside, true);
  assert.equal(db.inTransaction, false, "outer transaction must have committed");
  assert.equal(
    db.prepare("SELECT content FROM memories WHERE id = ?").get(committed.id).content,
    "snapshot nested commit sentinel row",
    "nested snapshot must not swallow the outer commit"
  );

  // (c) a throwing callback propagates and leaves no open transaction.
  const beforeThrow = db.prepare("SELECT COUNT(*) as n FROM memories").get().n;
  assert.throws(
    () =>
      withVectorSnapshot(() => {
        createMemory({ type: "FACT", content: "snapshot rollback sentinel row" });
        throw new Error("snapshot boom");
      }),
    /snapshot boom/
  );
  assert.equal(db.inTransaction, false, "a throw must not leave a transaction open");
  assert.equal(
    db.prepare("SELECT COUNT(*) as n FROM memories").get().n,
    beforeThrow,
    "the throwing snapshot must roll back its writes"
  );

  // (d) vectorSearch run inside an outer transaction sees the same snapshot and
  // returns exactly what it returns outside one.
  const outside = vectorSearch(TOPIC, { limit: 10 });
  const inside = db.transaction(() => vectorSearch(TOPIC, { limit: 10 }))();
  assert.deepStrictEqual(inside, outside);
  assert.deepStrictEqual(outside, referenceSearch(TOPIC, { limit: 10 }));
});

test("row order stays ref_id-ascending after ANALYZE and still matches the reference", () => {
  db.exec("ANALYZE");
  const keys = getAllEmbeddingKeys();
  const mem = keys.filter((k) => k.ref_table === "memories");
  const legacy = keys.filter((k) => k.ref_table !== "memories");
  assert.ok(mem.length >= N, `memories half should hold the seed rows, got ${mem.length}`);
  for (let i = 1; i < mem.length; i++) {
    assert.ok(
      mem[i].ref_id > mem[i - 1].ref_id,
      `memories half must ascend by ref_id (index ${i}: ${mem[i - 1].ref_id} -> ${mem[i].ref_id})`
    );
  }
  for (let i = 1; i < legacy.length; i++) {
    const prev = legacy[i - 1];
    const cur = legacy[i];
    assert.ok(
      prev.ref_table < cur.ref_table ||
        (prev.ref_table === cur.ref_table && prev.ref_id <= cur.ref_id),
      `legacy half must keep (ref_table, ref_id) order (index ${i})`
    );
  }
  assert.deepStrictEqual(
    vectorSearch(TOPIC, { limit: 50 }),
    referenceSearch(TOPIC, { limit: 50 }),
    "row order must not change the result set or its tie order"
  );
});

test("recall(topic) is identical with the cache enabled and disabled", async () => {
  cache.setVectorCacheBudgetMb(64);
  const topic = "pnpm typescript deployment server";
  const cached = textOf(await recallHandler({ topic, limit: 5 }));
  cache.setVectorCacheBudgetMb(0);
  try {
    const disabled = textOf(await recallHandler({ topic, limit: 5 }));
    assert.equal(cached, disabled);
  } finally {
    cache.setVectorCacheBudgetMb(64);
  }
  const again = textOf(await recallHandler({ topic, limit: 5 }));
  assert.equal(cached, again);
});
