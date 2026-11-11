// TASK-PERF-MATRIX: slot-based contiguous matrix behind the decoded-vector
// cache. These tests pin the invariants the matrix introduced — free-slot
// reuse, growth past the initial capacity, the per-bucket capacity cap, whole-
// bucket eviction and refill, epoch reset, and the capacity-based byte bound —
// on the cache API directly (no database), while test/vector_cache.test.mjs
// keeps pinning end-to-end parity with the full-BLOB reference (including the
// capacity-cap fallback in vectorSearch/recall) and
// test/vector_bigtable.test.mjs covers a table far larger than one bucket.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { embed, cosine, EMBED_DIM } = await import("../dist/lib/embed.js");
const cache = await import("../dist/retrieval/vector-cache.js");

const VECTOR_BYTES = EMBED_DIM * 4;
const INITIAL_CAPACITY = 256;
// Mirrors MAX_BUCKET_BUDGET_SHARE in src/retrieval/vector-cache.ts: one bucket
// may never allocate more than this share of the budget.
const MAX_BUCKET_SHARE = 0.75;

function vec(seed) {
  return embed(`matrix cache probe ${seed}`);
}

function capSlotsFor(budgetBytes) {
  return Math.floor((budgetBytes * MAX_BUCKET_SHARE) / VECTOR_BYTES);
}

function assertSameVector(actual, expected, label) {
  assert.ok(actual, `${label}: vector must be present`);
  assert.equal(actual.length, EMBED_DIM);
  for (let i = 0; i < EMBED_DIM; i++) {
    assert.equal(actual[i], expected[i], `${label}: component ${i} must match`);
  }
}

function assertSameScore(actual, query, expected, label) {
  assert.ok(
    Object.is(actual, cosine(query, expected)),
    `${label}: score must be the exact dot product`
  );
}

beforeEach(() => {
  cache.setVectorCacheBudgetMb(64);
  cache.clearVectorCache();
});

test("initial capacity is 256 slots and the byte accounting counts capacity", () => {
  cache.putVector("memories", 1, vec(1));
  const stats = cache.vectorCacheStats();
  assert.equal(stats.entries, 1);
  assert.equal(
    stats.bytes,
    INITIAL_CAPACITY * VECTOR_BYTES,
    "a one-row bucket still accounts for its whole allocation"
  );
  assert.ok(stats.bytes <= stats.budgetBytes);
});

test("invalidateVector frees the slot and the next stored vector reuses it", () => {
  const a = vec("alpha");
  const b = vec("beta");
  const slotA = cache.putVector("memories", 11, a);
  assert.ok(slotA >= 0);
  assert.equal(
    cache.getVector(cache.vectorKey("memories", 11)).length,
    EMBED_DIM
  );

  cache.invalidateVector("memories", 11);
  assert.equal(cache.getVector(cache.vectorKey("memories", 11)), undefined);
  assert.equal(cache.vectorCacheStats().entries, 0);

  const slotB = cache.putVector("memories", 12, b);
  assert.equal(slotB, slotA, "the freed slot must be reused before growing");
  assertSameVector(
    cache.getVector(cache.vectorKey("memories", 12)),
    b,
    "reused slot must hold the new vector, not the stale row"
  );
  assert.equal(
    cache.vectorCacheStats().bytes,
    INITIAL_CAPACITY * VECTOR_BYTES,
    "reusing a slot must not allocate a second one"
  );
  assert.equal(cache.getVectorEpoch(), 0, "single writes must not bump the epoch");
});

test("the matrix grows by 1.5x on the one-at-a-time path and keeps every slot intact", () => {
  const total = INITIAL_CAPACITY + 44; // 300 -> grows 256 -> 384 (1.5x)
  const vectors = [];
  for (let i = 0; i < total; i++) {
    const v = vec(`growth ${i}`);
    vectors.push(v);
    assert.ok(cache.putVector("memories", 1000 + i, v) >= 0);
  }
  const stats = cache.vectorCacheStats();
  assert.equal(stats.entries, total);
  assert.equal(
    stats.bytes,
    Math.ceil(INITIAL_CAPACITY * 1.5) * VECTOR_BYTES,
    "capacity must grow by 1.5x once for 300 entries"
  );
  assert.ok(stats.bytes <= stats.budgetBytes);

  // Every stored vector must survive the reallocation (the grow copies the
  // whole matrix, so a partial copy would surface here).
  for (let i = 0; i < total; i += 37) {
    assertSameVector(
      cache.getVector(cache.vectorKey("memories", 1000 + i)),
      vectors[i],
      `row ${1000 + i} after growth`
    );
  }

  // Dot products must be bit-identical to cosine() for every live slot.
  const query = vec("growth query");
  const ids = new Int32Array(total);
  for (let i = 0; i < total; i++) ids[i] = 1000 + i;
  const slots = cache.ensureVectors("memories", ids);
  assert.equal(
    cache.patchVectorSlots("memories", ids, slots),
    0,
    "a fully warm matrix has no misses"
  );
  const scores = cache.accumulateScores("memories", query);
  for (let i = 0; i < total; i++) {
    assertSameScore(scores[slots[i]], query, vectors[i], `score ${i}`);
  }
});

test("a slot beyond the caller's out buffer still gets a score", () => {
  const vectors = [];
  for (let i = 0; i < 10; i++) {
    const v = vec(`out ${i}`);
    vectors.push(v);
    cache.putVector("memories", i + 1, v);
  }
  const tooSmall = new Float64Array(2);
  const query = vec("out query");
  const scores = cache.accumulateScores("memories", query, tooSmall);
  assert.notEqual(scores, tooSmall, "an undersized out buffer must be replaced");
  assert.ok(scores.length >= 10);

  const ids = Int32Array.from({ length: 10 }, (_, i) => i + 1);
  const slots = cache.ensureVectors("memories", ids);
  assert.equal(cache.patchVectorSlots("memories", ids, slots), 0);
  for (let i = 0; i < 10; i++) {
    assertSameScore(scores[slots[i]], query, vectors[i], `out-buffer score ${i}`);
  }
});

test("a bucket never allocates past its share of the budget", () => {
  cache.setVectorCacheBudgetMb(1); // 512 slots of budget, cap 384
  const budgetSlots = cache.getVectorCacheBudgetBytes() / VECTOR_BYTES;
  assert.equal(budgetSlots, 512);
  const cap = capSlotsFor(cache.getVectorCacheBudgetBytes());
  assert.equal(cap, 384);

  const ids = new Int32Array(budgetSlots);
  for (let i = 0; i < ids.length; i++) ids[i] = 5000 + i;
  cache.ensureVectors("memories", ids);
  let accepted = 0;
  for (let i = 0; i < ids.length; i++) {
    if (cache.putVector("memories", ids[i], vec(`cap ${i}`)) >= 0) accepted++;
  }
  assert.equal(accepted, cap, "rows past the cap must be reported as not resident");
  let stats = cache.vectorCacheStats();
  assert.equal(stats.entries, cap);
  assert.equal(stats.bytes, cap * VECTOR_BYTES);
  assert.ok(stats.bytes <= stats.budgetBytes);
  assert.equal(cache.getVector(cache.vectorKey("memories", 5000 + cap)), undefined);

  // A second bucket pushes the total over the budget; the least recently used
  // bucket is dropped whole, and the surviving one keeps its allocation.
  for (let i = 0; i < INITIAL_CAPACITY; i++) {
    cache.putVector("lessons", i + 1, vec(`lessons ${i}`));
  }
  stats = cache.vectorCacheStats();
  assert.equal(stats.entries, INITIAL_CAPACITY);
  assert.equal(stats.bytes, INITIAL_CAPACITY * VECTOR_BYTES);
  assert.ok(stats.bytes <= stats.budgetBytes);
  assert.equal(
    cache.getVector(cache.vectorKey("memories", 5000)),
    undefined,
    "the over-budget bucket is dropped whole"
  );

  // Refill through the path a query uses, then check exact scores.
  const refillVectors = [];
  const refillIds = new Int32Array(cap);
  for (let i = 0; i < cap; i++) {
    refillVectors.push(vec(`refill ${i}`));
    refillIds[i] = 7000 + i;
  }
  const query = vec("refill query");
  const { scores, slots } = cache.withVectorQuery(["memories"], () => {
    const slots = cache.ensureVectors("memories", refillIds);
    for (let i = 0; i < cap; i++) {
      assert.ok(
        cache.putVector("memories", refillIds[i], refillVectors[i]) >= 0,
        `refill ${i} must fit the cap`
      );
    }
    assert.equal(cache.patchVectorSlots("memories", refillIds, slots), 0);
    return { scores: cache.accumulateScores("memories", query), slots };
  });
  for (const i of [0, cap >> 1, cap - 1]) {
    assertSameScore(scores[slots[i]], query, refillVectors[i], `refill score ${i}`);
  }
  stats = cache.vectorCacheStats();
  assert.ok(stats.bytes <= stats.budgetBytes);
});

test("a table larger than the per-bucket cap keeps the resident rows warm", () => {
  cache.setVectorCacheBudgetMb(4); // 2,048 slots of budget, cap 1,536
  const total = 3000;
  const cap = capSlotsFor(cache.getVectorCacheBudgetBytes());
  assert.equal(cap, 1536);
  assert.ok(total > cap, "the fixture must exceed the cap");

  const ids = new Int32Array(total);
  for (let i = 0; i < total; i++) ids[i] = i + 1;
  const query = vec("over cap query");
  const { scores, slots } = cache.withVectorQuery(["memories"], () => {
    const slots = cache.ensureVectors("memories", ids);
    for (let i = 0; i < total; i++) {
      const stored = cache.putVector("memories", ids[i], vec(`over cap ${i}`));
      if (i < cap) assert.ok(stored >= 0, `row ${i} must fit the cap`);
      else assert.equal(stored, -1, `row ${i} must stay out of the matrix`);
    }
    const missing = cache.patchVectorSlots("memories", ids, slots);
    assert.equal(missing, total - cap);
    for (let i = 0; i < cap; i++) assert.ok(slots[i] >= 0);
    for (let i = cap; i < total; i++) assert.equal(slots[i], -1);
    return { scores: cache.accumulateScores("memories", query), slots };
  });
  for (const i of [0, 1, cap - 1]) {
    assertSameScore(scores[slots[i]], query, vec(`over cap ${i}`), `cap score ${i}`);
  }

  const first = cache.vectorCacheStats();
  assert.equal(first.entries, cap);
  assert.equal(first.bytes, cap * VECTOR_BYTES);
  assert.ok(first.bytes <= first.budgetBytes);

  // Second query: the resident rows are hits, nothing grows, nothing is
  // evicted, and the over-cap rows are still resolvable through the fill.
  cache.withVectorQuery(["memories"], () => {
    const again = cache.ensureVectors("memories", ids);
    assert.equal(cache.patchVectorSlots("memories", ids, again), total - cap);
    for (let i = 0; i < cap; i++) assert.ok(again[i] >= 0);
    assert.ok(cache.accumulateScores("memories", query));
  });
  const second = cache.vectorCacheStats();
  assert.ok(second.hits > first.hits, "second query must hit the resident rows");
  assert.equal(second.misses - first.misses, total - cap);
  assert.equal(second.bytes, first.bytes, "the matrix must not be reallocated per query");
  assert.ok(second.bytes <= second.budgetBytes);
});

test("buckets used by an in-flight query are pinned, and the budget is restored on exit", () => {
  cache.setVectorCacheBudgetMb(1); // 512 slots of budget, cap 384 per bucket
  const cap = capSlotsFor(cache.getVectorCacheBudgetBytes());
  const perBucket = cap; // each bucket lands on the cap
  const totalPerBucket = 500;
  const scores = cache.withVectorQuery(["memories", "lessons"], () => {
    for (let i = 0; i < totalPerBucket; i++) {
      cache.putVector("memories", i + 1, vec(`pinned memory ${i}`));
      cache.putVector("lessons", i + 1, vec(`pinned lesson ${i}`));
    }
    assert.equal(
      cache.vectorCacheStats().entries,
      2 * perBucket,
      "both pinned buckets must reach the cap without being evicted mid-query"
    );
    return cache.accumulateScores("memories", vec("pinned"));
  });
  assert.ok(scores);
  const stats = cache.vectorCacheStats();
  assert.ok(
    stats.bytes <= stats.budgetBytes,
    `after the query bytes ${stats.bytes} must be back under ${stats.budgetBytes}`
  );
  assert.equal(
    stats.entries,
    perBucket,
    "one of the two over-budget buckets is dropped on release"
  );
});

test("bumpVectorEpoch resets the matrix and a refill reproduces the same scores", () => {
  const total = 40;
  const ids = new Int32Array(total);
  for (let i = 0; i < total; i++) {
    ids[i] = i + 1;
    cache.putVector("memories", ids[i], vec(`epoch ${i}`));
  }
  const query = vec("epoch query");
  const first = cache.accumulateScores("memories", query);
  const slotsBefore = cache.ensureVectors("memories", ids);
  const before = [];
  for (let i = 0; i < total; i++) before.push(first[slotsBefore[i]]);

  const epochBefore = cache.getVectorEpoch();
  cache.bumpVectorEpoch();
  assert.equal(cache.getVectorEpoch(), epochBefore + 1);
  let stats = cache.vectorCacheStats();
  assert.equal(stats.entries, 0);
  assert.equal(stats.bytes, 0);
  assert.equal(cache.getVector(cache.vectorKey("memories", 1)), undefined);

  const refill = new Int32Array(total);
  for (let i = 0; i < total; i++) {
    refill[i] = i + 1;
    cache.putVector("memories", refill[i], vec(`epoch ${i}`));
  }
  const slotsAfter = cache.ensureVectors("memories", ids);
  const second = cache.accumulateScores("memories", query);
  for (let i = 0; i < total; i++) {
    assert.ok(
      Object.is(before[i], second[slotsAfter[i]]),
      `score ${i} must be bit-identical after the epoch reset and refill`
    );
    assert.ok(
      Object.is(refill[i], ids[i]),
      "refilled ids must keep their original order and values"
    );
  }
  stats = cache.vectorCacheStats();
  assert.ok(stats.bytes <= stats.budgetBytes);
});

test("a 20k-row table allocates exactly its row count and leaves the other buckets cached", () => {
  const total = 20000;
  const ids = new Int32Array(total);
  for (let i = 0; i < total; i++) ids[i] = i + 1;
  const shared = vec("capacity shared");
  const mid = vec("capacity mid");
  const tail = vec("capacity tail");
  const query = vec("capacity query");
  const vectorAt = (i) => {
    if (i === total - 1 || i === total - 2) return tail;
    if (i === 12345) return mid;
    return shared;
  };
  assert.notEqual(
    cosine(query, tail),
    cosine(query, shared),
    "the tail probe must be distinguishable from the shared vector"
  );

  // Same shape as `recall()`'s semantic blend: the memories matrix plus the
  // preference and lesson buckets, all pinned by one query. The fill uses the
  // query's known row count, so the matrix must land on 20,000 slots — not the
  // 32,768 a power-of-two doubling would allocate (64 MB, the whole budget).
  const scores = cache.withVectorQuery(
    ["memories", "preferences", "lessons"],
    () => {
      const slots = cache.ensureVectors("memories", ids);
      for (let i = 0; i < total; i++) {
        assert.ok(
          cache.putVector("memories", ids[i], vectorAt(i)) >= 0,
          `row ${i} must be cached`
        );
      }
      assert.equal(cache.patchVectorSlots("memories", ids, slots), 0);
      for (let i = 0; i < 40; i++) cache.putVector("preferences", i + 1, shared);
      for (let i = 0; i < 40; i++) cache.putVector("lessons", i + 1, shared);
      return cache.accumulateScores("memories", query);
    }
  );
  assert.ok(scores);
  // Spot-check the high slots with their own vectors: a matrix that only copied
  // the first rows (or that reused one row's vector for every slot) would still
  // pass a slot-0-only assertion.
  assertSameScore(scores[0], query, shared, "slot 0");
  assertSameScore(scores[12345], query, mid, "slot 12345");
  assertSameScore(scores[19998], query, tail, "slot 19998");
  assertSameScore(scores[19999], query, tail, "slot 19999");

  let stats = cache.vectorCacheStats();
  assert.equal(stats.entries, total + 80);
  assert.equal(
    stats.bytes,
    total * VECTOR_BYTES + 2 * INITIAL_CAPACITY * VECTOR_BYTES,
    "the memories bucket must account for exactly 20,000 slots"
  );
  assert.ok(
    stats.bytes < 64 * 1024 * 1024,
    `20k rows must not fill the 64 MB budget (got ${stats.bytes} bytes)`
  );
  assert.ok(
    stats.budgetBytes - stats.bytes >= 20 * 1024 * 1024,
    "the row-count capacity must leave room for the other buckets"
  );

  // A second query is all-hits, so nothing grows and no bucket is evicted.
  cache.withVectorQuery(["memories", "preferences", "lessons"], () => {
    const again = cache.ensureVectors("memories", ids);
    assert.equal(cache.patchVectorSlots("memories", ids, again), 0);
    assert.ok(cache.accumulateScores("memories", query));
  });
  stats = cache.vectorCacheStats();
  assert.equal(stats.entries, total + 80);
  assert.equal(
    stats.bytes,
    total * VECTOR_BYTES + 2 * INITIAL_CAPACITY * VECTOR_BYTES
  );
  assert.ok(
    cache.getVector(cache.vectorKey("preferences", 1)),
    "the preferences bucket must survive a memories query"
  );
  assert.ok(
    cache.getVector(cache.vectorKey("lessons", 1)),
    "the lessons bucket must survive a memories query"
  );
});

test("nested withVectorQuery releases the pin even when the callback throws", () => {
  cache.setVectorCacheBudgetMb(1);
  const cap = capSlotsFor(cache.getVectorCacheBudgetBytes());
  assert.equal(cap, 384);

  assert.throws(
    () =>
      cache.withVectorQuery(["memories", "lessons"], () => {
        cache.withVectorQuery(["memories"], () => {
          for (let i = 0; i < cap; i++) {
            cache.putVector("memories", i + 1, vec(`nested memory ${i}`));
            cache.putVector("lessons", i + 1, vec(`nested lesson ${i}`));
          }
          assert.equal(
            cache.vectorCacheStats().entries,
            2 * cap,
            "both buckets are pinned while the nested query is in flight"
          );
          throw new Error("nested boom");
        });
      }),
    /nested boom/
  );

  // The throw propagated through both `finally` blocks: the budget is applied
  // and the query depth is back to 0, so one bucket is gone.
  let stats = cache.vectorCacheStats();
  assert.equal(stats.entries, cap);
  assert.ok(
    stats.bytes <= stats.budgetBytes,
    `after the throw bytes ${stats.bytes} must fit ${stats.budgetBytes}`
  );

  // A write that runs past the budget now evicts immediately, proving the
  // depth counter did not stay above 0.
  for (let i = 0; i < INITIAL_CAPACITY; i++) {
    cache.putVector("preferences", i + 1, vec(`after throw ${i}`));
  }
  stats = cache.vectorCacheStats();
  assert.equal(stats.entries, INITIAL_CAPACITY);
  assert.ok(stats.bytes <= stats.budgetBytes);
});

test("putVector returns -1 instead of a slot that does not exist", () => {
  cache.setVectorCacheBudgetMb(1);
  const cap = capSlotsFor(cache.getVectorCacheBudgetBytes());
  assert.equal(cap, 384);

  let lastSlot = -1;
  for (let i = 0; i < cap; i++) {
    lastSlot = cache.putVector("memories", i + 1, vec(`reject ${i}`));
    assert.ok(lastSlot >= 0);
  }
  assert.equal(lastSlot, cap - 1);

  assert.equal(
    cache.putVector("memories", cap + 1, vec("rejected")),
    -1,
    "a row past the cap has no slot"
  );
  assert.equal(
    cache.getVector(cache.vectorKey("memories", cap + 1)),
    undefined,
    "the rejected row must not be readable through a stale slot"
  );
  assert.equal(
    cache.setVector(cache.vectorKey("memories", cap + 2), vec("rejected set")),
    undefined,
    "setVector propagates the missing slot"
  );

  // Overwriting a resident row still works at the cap.
  assert.ok(cache.putVector("memories", 1, vec("rewritten")) >= 0);
  // A second bucket pushes the accounting over budget: the older bucket is
  // dropped and its ids are misses, never dangling slots.
  for (let i = 0; i < INITIAL_CAPACITY; i++) {
    assert.ok(cache.putVector("lessons", i + 1, vec(`evict ${i}`)) >= 0);
  }
  const stats = cache.vectorCacheStats();
  assert.equal(stats.entries, INITIAL_CAPACITY);
  assert.equal(cache.getVector(cache.vectorKey("memories", 1)), undefined);
  assert.ok(cache.getVector(cache.vectorKey("lessons", 1)));
});

test("a bucket emptied by invalidateVector during a query is pruned when the query ends", () => {
  cache.putVector("memories", 1, vec("prune"));
  assert.equal(cache.vectorCacheStats().entries, 1);

  cache.withVectorQuery(["memories"], () => {
    cache.invalidateVector("memories", 1);
    const inside = cache.vectorCacheStats();
    assert.equal(inside.entries, 0);
    assert.ok(
      inside.bytes > 0,
      "the pinned bucket keeps its allocation for the duration of the query"
    );
  });

  const stats = cache.vectorCacheStats();
  assert.equal(stats.entries, 0);
  assert.equal(
    stats.bytes,
    0,
    "an empty bucket must not keep evicting its warm neighbours"
  );
});

test("malformed cache keys are plain misses", () => {
  assert.equal(cache.getVector("memories"), undefined);
  assert.equal(cache.getVector("memories:"), undefined);
  assert.equal(cache.getVector(":1"), undefined);
  assert.equal(cache.getVector("memories:not-a-number"), undefined);
  assert.equal(cache.setVector("nonsense", vec("malformed")), undefined);
  assert.equal(cache.vectorCacheStats().entries, 0);
});

test("a budget below one initial bucket retains only the cap's worth of rows", () => {
  cache.setVectorCacheBudgetMb(0.02); // ~20 KB -> cap 7 slots
  const cap = capSlotsFor(cache.getVectorCacheBudgetBytes());
  assert.equal(cap, 7);
  let accepted = 0;
  for (let i = 0; i < 50; i++) {
    if (cache.putVector("memories", i + 1, vec(i)) >= 0) accepted++;
  }
  const stats = cache.vectorCacheStats();
  assert.ok(stats.enabled);
  assert.equal(accepted, cap);
  assert.equal(stats.entries, cap);
  assert.equal(stats.bytes, cap * VECTOR_BYTES);
  assert.ok(stats.bytes <= stats.budgetBytes);
});

test("a budget below one vector allocates nothing and keeps nothing", () => {
  cache.setVectorCacheBudgetMb(0.001); // ~1 KB, less than one 2 KB slot
  for (let i = 0; i < 50; i++) {
    assert.equal(
      cache.putVector("memories", i + 1, vec(i)),
      -1,
      "a slot that does not fit the budget must not be allocated"
    );
  }
  const stats = cache.vectorCacheStats();
  assert.ok(stats.enabled);
  assert.equal(stats.entries, 0);
  assert.equal(stats.bytes, 0);
  assert.ok(stats.bytes <= stats.budgetBytes);
});
