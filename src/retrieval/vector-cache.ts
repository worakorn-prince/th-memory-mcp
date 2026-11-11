// Decoded-vector cache (TASK-PERF-READ, contiguous matrix in TASK-PERF-MATRIX).
//
// The retrieval hot path needs every embedding's decoded Float32Array per
// query. Reading the BLOBs back from SQLite and decoding them costs ~356 ms at
// 20k memories; holding the decoded vectors in memory drops that to ~40 ms.
// This module is a bounded cache over exactly that decoded form: pure
// in-memory, no DB imports (the DB layer feeds it). A single write invalidates
// only its own key (`invalidateVector`), so a write-then-read loop keeps every
// other decoded vector; `bumpVectorEpoch()` remains for bulk rewrites
// (migrations) and tests, where dropping everything is the correct action.
//
// Layout: one slot-based `MatrixStore` per `ref_table` bucket — a contiguous
// `Float32Array` of `capacity * EMBED_DIM` plus an `Int32Array` of slot ->
// ref_id. Scoring scans the matrix with a monotonically increasing offset, so
// the hot loop touches neither a Map nor a per-row object: the score of a slot
// is one contiguous dot product, exactly the arithmetic `cosine()` performs
// (same index order, same float64 accumulator), so ids, scores (`Object.is`)
// and ordering are unchanged. Freed slots go on a free list and are reused; the
// matrix grows by 1.5x from 256 slots on the one-at-a-time path, and to the
// exact row count when a query knows it up front (`ensureVectors`): doubling a
// 20k-row table to 32,768 slots costs 64 MB and evicts every other bucket on
// each query, while 20,000 slots cost 40.9 MB and leave room for them.
//
// Budget: MEMORY_VECTOR_CACHE_MB (default 64 MB, 0 disables the cache). Byte
// accounting is per bucket capacity — `capacity * EMBED_DIM * 4` — not the live
// entry count, because that capacity is what is actually allocated. A bucket is
// never evicted while it is part of an in-flight query (`withVectorQuery`): a
// slot resolved before the miss fill must still hold its vector when the scores
// are read. Over-budget buckets are dropped whole (and rebuilt on the next
// query) once the query ends; a budget too small to hold even one bucket means
// nothing stays cached, which is correct but not warm.
//
// Capacity cap (TASK-PERF-MATRIX review, S2): no single bucket may allocate
// more than `MAX_BUCKET_BUDGET_SHARE` of the budget. Without it, a table larger
// than the budget grows its matrix to the budget (or the next 1.5x step) and
// then every query is over budget, so `enforceBudget` drops the whole bucket on
// release and the next query refills it from scratch — permanently cold, i.e.
// cache-off latency with extra bookkeeping. With the cap the first
// `cap` rows (in `ORDER BY ref_id` order) stay resident and warm, and the
// remainder is scored from the vectors the miss fill already fetched
// (`ensureVectors` reports those ids as `-1`, the caller falls back to
// `cosine()`), so results stay exact and later queries still hit the matrix.
import { EMBED_DIM } from "../lib/embed.js";

const VECTOR_BYTES = EMBED_DIM * 4;
const DEFAULT_BUDGET_MB = 64;
const INITIAL_CAPACITY = 256;
// One bucket may claim at most 3/4 of the budget. The remaining quarter keeps
// the small tables (`preferences`, `lessons`) resident and leaves headroom, so
// one large table can never consume the whole budget and force the eviction of
// every other bucket on each query.
const MAX_BUCKET_BUDGET_SHARE = 0.75;

interface MatrixStore {
  /** `capacity * EMBED_DIM` floats; slot `s` owns `[s * EMBED_DIM, (s+1) * EMBED_DIM)`. */
  data: Float32Array;
  /** slot -> ref_id, `-1` when the slot is free. */
  ids: Int32Array;
  /** ref_id -> slot. */
  slotOf: Map<number, number>;
  /** Freed slots, reused before the matrix grows. */
  free: number[];
  /** Slots ever handed out; `[0, highWater)` is the only region that can be live. */
  highWater: number;
  /** Live entry count. */
  live: number;
  capacity: number;
  lastUsed: number;
}

const buckets = new Map<string, MatrixStore>();
let budgetBytes = readBudgetBytes();
let epoch = 0;
let hits = 0;
let misses = 0;
let warnedBadBudget = false;
let useClock = 0;
// Query pinning: buckets touched by an in-flight query are exempt from
// eviction, so a slot resolved before the miss fill stays valid while the
// scores are read. `queryDepth` supports nesting; the budget is re-applied when
// the outermost query ends.
let queryDepth = 0;
const activeTables = new Set<string>();

function readBudgetBytes(): number {
  const raw = process.env.MEMORY_VECTOR_CACHE_MB;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_BUDGET_MB * 1024 * 1024;
  }
  const mb = Number(raw);
  if (!Number.isFinite(mb) || mb < 0) {
    // Warn once (not per read): a typo'd/negative budget silently falls back to
    // the default, and the operator should still see why the setting is ignored.
    if (!warnedBadBudget) {
      warnedBadBudget = true;
      console.error(
        `[vector-cache] invalid MEMORY_VECTOR_CACHE_MB=${JSON.stringify(
          String(raw).slice(0, 40)
        )}; using the default ${DEFAULT_BUDGET_MB} MB`
      );
    }
    return DEFAULT_BUDGET_MB * 1024 * 1024;
  }
  return Math.floor(mb * 1024 * 1024);
}

/** Cache key shape shared by every read/write path: `${refTable}:${refId}`. */
export function vectorKey(refTable: string, refId: number): string {
  return `${refTable}:${refId}`;
}

function splitKey(
  key: string
): { refTable: string; refId: number } | null {
  const sep = key.lastIndexOf(":");
  // No separator, an empty table or an empty ref is a malformed key: report a
  // plain cache miss instead of building a bucket named "" for `NaN`.
  if (sep <= 0 || sep === key.length - 1) return null;
  const refId = Number(key.slice(sep + 1));
  if (!Number.isInteger(refId)) return null;
  return { refTable: key.slice(0, sep), refId };
}

export function isVectorCacheEnabled(): boolean {
  return budgetBytes > 0;
}

export function getVectorCacheBudgetBytes(): number {
  return budgetBytes;
}

/** Test hook: re-scale the budget (and drop everything). 0 disables the cache. */
export function setVectorCacheBudgetMb(mb: number): void {
  const next = Number.isFinite(mb) && mb >= 0 ? Math.floor(mb * 1024 * 1024) : readBudgetBytes();
  budgetBytes = next;
  buckets.clear();
}

function newBucket(capacity: number): MatrixStore {
  return {
    data: new Float32Array(capacity * EMBED_DIM),
    ids: new Int32Array(capacity).fill(-1),
    slotOf: new Map(),
    free: [],
    highWater: 0,
    live: 0,
    capacity,
    lastUsed: 0,
  };
}

/**
 * Largest capacity one bucket may allocate: a share of the budget, not all of
 * it, so one table cannot crowd out every other bucket. Floored to whole slots;
 * 0 means the budget cannot hold even one vector and nothing may be allocated.
 */
function bucketCapacityCap(): number {
  if (budgetBytes <= 0) return 0;
  return Math.floor((budgetBytes * MAX_BUCKET_BUDGET_SHARE) / VECTOR_BYTES);
}

function initialCapacity(): number {
  return Math.min(INITIAL_CAPACITY, bucketCapacityCap());
}

function getBucket(refTable: string): MatrixStore {
  let bucket = buckets.get(refTable);
  if (!bucket) {
    bucket = newBucket(initialCapacity());
    buckets.set(refTable, bucket);
  }
  return bucket;
}

/**
 * Grow towards `needed`, never past `bucketCapacityCap()`.
 *
 * `ensureVectors` already knows how many rows the table holds (`needed`), so it
 * lands on exactly that capacity (when it fits): doubling to the next power of
 * two would allocate 32,768 slots for 20k live rows (64 MB) and push every
 * other bucket out of the budget. The 1.5x floor is what keeps the
 * one-vector-at-a-time path (`putVector`) amortized O(1) instead of copying the
 * matrix per row.
 *
 * At the cap the growth is a no-op and the matrix keeps its current capacity;
 * `putVector` then reports `-1` for rows that do not fit, and `ensureVectors`
 * leaves their slots at `-1`. Capacity stays a plain integer — nothing indexes
 * it with bit arithmetic.
 */
function growBucket(bucket: MatrixStore, needed: number): void {
  const target = Math.min(
    Math.max(needed, Math.ceil(bucket.capacity * 1.5)),
    bucketCapacityCap()
  );
  if (target <= bucket.capacity) return;
  const capacity = target;
  const data = new Float32Array(capacity * EMBED_DIM);
  data.set(bucket.data);
  const ids = new Int32Array(capacity).fill(-1);
  ids.set(bucket.ids);
  bucket.data = data;
  bucket.ids = ids;
  bucket.capacity = capacity;
}

function totalBytes(): number {
  let bytes = 0;
  for (const bucket of buckets.values()) bytes += bucket.capacity * VECTOR_BYTES;
  return bytes;
}

/**
 * Drop whole buckets (least recently used first) until the accounting fits the
 * budget. A bucket that is part of an in-flight query is never a victim, so the
 * budget can be exceeded for the duration of one query and is restored when the
 * outermost `withVectorQuery` ends. Empty buckets (no live row) are pruned
 * first: they account for a whole allocation but can never score anything, so
 * they would otherwise evict a warm neighbour. Evicting per slot is deliberately
 * not attempted: a dense matrix cannot hand individual rows back to the
 * allocator, and a dropped bucket is rebuilt by the next query with the same
 * vectors.
 */
function enforceBudget(): void {
  if (budgetBytes <= 0) {
    buckets.clear();
    return;
  }
  for (const [table, bucket] of buckets) {
    if (bucket.live === 0 && !activeTables.has(table)) buckets.delete(table);
  }
  let bytes = totalBytes();
  while (bytes > budgetBytes) {
    let victimTable: string | null = null;
    let victimUsed = Infinity;
    for (const [table, bucket] of buckets) {
      if (activeTables.has(table)) continue;
      if (bucket.lastUsed < victimUsed) {
        victimTable = table;
        victimUsed = bucket.lastUsed;
      }
    }
    if (victimTable === null) break;
    const victim = buckets.get(victimTable);
    if (!victim) break;
    bytes -= victim.capacity * VECTOR_BYTES;
    buckets.delete(victimTable);
  }
}

/**
 * Pin the buckets a query is about to score, then re-apply the budget when the
 * outermost query finishes. Every path that resolves slots and later reads the
 * scores must run inside it: without the pin, filling misses could evict the
 * bucket whose slots were already resolved.
 */
export function withVectorQuery<T>(refTables: readonly string[], fn: () => T): T {
  for (const table of refTables) activeTables.add(table);
  queryDepth++;
  try {
    return fn();
  } finally {
    queryDepth--;
    if (queryDepth <= 0) {
      queryDepth = 0;
      activeTables.clear();
      enforceBudget();
    }
  }
}

function resolveSlots(
  refTable: string,
  ids: ArrayLike<number>,
  slots: Int32Array,
  countStats: boolean
): number {
  const bucket = buckets.get(refTable);
  let missing = 0;
  for (let i = 0; i < ids.length; i++) {
    const slot = bucket ? bucket.slotOf.get(ids[i]!) : undefined;
    if (slot === undefined) {
      slots[i] = -1;
      missing++;
      if (countStats) misses++;
    } else {
      slots[i] = slot;
      if (countStats) hits++;
    }
  }
  return missing;
}

/**
 * Resolve the matrix slot of every requested id, in request order, and reserve
 * room for the misses up front (growing one row at a time would copy the whole
 * matrix once per growth step during a cold fill).
 *
 * `slots[i] === -1` means "not in the cache": the caller fetches those ids with
 * one batched read (`getEmbeddingsByKeys`, which stores them via `setVector`)
 * and then calls `patchVectorSlots` to learn their new slots. An id the
 * database has no vector for stays `-1` and is skipped, exactly as the previous
 * `if (!vec) continue` did. An id that does not fit under the per-bucket
 * capacity cap also stays `-1`; the caller must score that row from the vector
 * it fetched (see `src/retrieval/vector.ts`), not drop it.
 */
export function ensureVectors(refTable: string, ids: ArrayLike<number>): Int32Array {
  const slots = new Int32Array(ids.length);
  if (budgetBytes <= 0 || ids.length === 0) {
    slots.fill(-1);
    return slots;
  }
  const bucket = getBucket(refTable);
  bucket.lastUsed = ++useClock;
  const missing = resolveSlots(refTable, ids, slots, true);
  if (missing > 0) {
    growBucket(bucket, bucket.live + bucket.free.length + missing);
  }
  return slots;
}

/**
 * Re-resolve only the still-missing slots (after a fill) without touching the
 * hit/miss counters — the miss was already counted by `ensureVectors`, and a
 * second count would report the just-filled rows as warm reads.
 */
export function patchVectorSlots(
  refTable: string,
  ids: ArrayLike<number>,
  slots: Int32Array
): number {
  return resolveSlots(refTable, ids, slots, false);
}

/**
 * Store one decoded vector and return its slot. `-1` means the vector is not
 * resident: the cache is disabled, the bucket is at its capacity cap, or the
 * write pushed the accounting over budget and `enforceBudget` dropped this
 * bucket (only possible outside a query). The vector is copied into the matrix;
 * the caller's array is never retained. A repeated id overwrites its existing
 * slot, so a re-embedding that already invalidated the key cannot leave a
 * second copy behind.
 */
export function putVector(
  refTable: string,
  refId: number,
  vec: Float32Array
): number {
  if (budgetBytes <= 0) return -1;
  const bucket = getBucket(refTable);
  const existing = bucket.slotOf.get(refId);
  let slot: number;
  if (existing !== undefined) {
    slot = existing;
  } else if (bucket.free.length > 0) {
    slot = bucket.free.pop()!;
    bucket.live++;
  } else {
    if (bucket.highWater >= bucket.capacity) {
      growBucket(bucket, bucket.capacity + 1);
      // At the cap the matrix cannot grow: report the row as not resident
      // instead of writing past the end of the allocation.
      if (bucket.highWater >= bucket.capacity) return -1;
    }
    slot = bucket.highWater++;
    bucket.live++;
  }
  const base = slot * EMBED_DIM;
  if (vec.length === EMBED_DIM) {
    bucket.data.set(vec, base);
  } else {
    for (let k = 0; k < EMBED_DIM; k++) bucket.data[base + k] = vec[k] ?? 0;
  }
  bucket.ids[slot] = refId;
  bucket.slotOf.set(refId, slot);
  bucket.lastUsed = ++useClock;
  if (queryDepth === 0) {
    enforceBudget();
    // enforceBudget may have dropped this very bucket to fit the budget; the
    // slot then points into freed memory, so report it as not stored.
    if (buckets.get(refTable) !== bucket) return -1;
  }
  return slot;
}

/**
 * Exact dot product of `queryVec` against every live slot, written to
 * `scores[slot]`. Both vectors are normalized by construction, so the dot
 * product is the cosine — identical arithmetic (and therefore identical
 * floats) to `cosine(queryVec, vec)`, just read from one contiguous buffer.
 * `scores` is a Float64Array because a Float32Array would round the scores.
 *
 * Free slots are skipped and their entries are explicitly zeroed, so a reused
 * `out` buffer can never leak a previous query's score through an index the
 * caller has no live slot for. Callers must only read slots they resolved.
 * Returns null when the bucket does not exist.
 */
export function accumulateScores(
  refTable: string,
  queryVec: Float32Array,
  out?: Float64Array
): Float64Array | null {
  const bucket = buckets.get(refTable);
  if (!bucket) return null;
  bucket.lastUsed = ++useClock;
  let scores = out;
  if (!scores || scores.length < bucket.highWater) {
    scores = new Float64Array(bucket.highWater);
  }
  const data = bucket.data;
  const ids = bucket.ids;
  for (let slot = 0; slot < bucket.highWater; slot++) {
    if (ids[slot]! < 0) {
      scores[slot] = 0;
      continue;
    }
    const base = slot * EMBED_DIM;
    let dot = 0;
    for (let k = 0; k < EMBED_DIM; k++) dot += queryVec[k]! * data[base + k]!;
    scores[slot] = dot;
  }
  return scores;
}

/**
 * Look up a decoded vector by `${refTable}:${refId}`.
 *
 * The returned Float32Array is a view into the matrix (zero copy), shared
 * read-only state: callers must never mutate it, and it is only valid until the
 * bucket grows or is evicted — copy it (`new Float32Array(vec)`) to keep it.
 * The scoring hot path does not use this (it goes through `ensureVectors` +
 * `accumulateScores`); this is for callers that need a single vector.
 */
export function getVector(key: string): Float32Array | undefined {
  if (budgetBytes <= 0) return undefined;
  const parsed = splitKey(key);
  if (!parsed) {
    misses++;
    return undefined;
  }
  const { refTable, refId } = parsed;
  const bucket = buckets.get(refTable);
  const slot = bucket?.slotOf.get(refId);
  if (slot === undefined) {
    misses++;
    return undefined;
  }
  hits++;
  const base = slot * EMBED_DIM;
  return bucket!.data.subarray(base, base + EMBED_DIM);
}

/**
 * Store a decoded vector under `${refTable}:${refId}`. Returns a view of the
 * stored vector, or undefined when the cache is disabled. Once it is in the
 * cache the data is shared read-only state: callers must not mutate the
 * returned view, and must copy it if they need it after the bucket grows.
 */
export function setVector(
  key: string,
  vec: Float32Array
): Float32Array | undefined {
  if (budgetBytes <= 0) return undefined;
  const parsed = splitKey(key);
  if (!parsed) return undefined;
  const { refTable, refId } = parsed;
  const slot = putVector(refTable, refId, vec);
  if (slot < 0) return undefined;
  const bucket = buckets.get(refTable);
  // Defensive: putVector reports -1 when its own write was evicted, so this
  // branch is not reachable today; if the bucket is gone anyway, hand the
  // caller its own copy rather than a view into freed memory.
  if (!bucket) return vec.length === EMBED_DIM ? vec : new Float32Array(vec);
  const base = slot * EMBED_DIM;
  return bucket.data.subarray(base, base + EMBED_DIM);
}

export function clearVectorCache(): void {
  buckets.clear();
}

/**
 * Drop the decoded vector for one embedding row. A write only makes that one
 * key stale, so the rest of the cache stays warm; callers that rewrite many
 * rows at once (migrations) should keep using `bumpVectorEpoch()`. The freed
 * slot goes on the free list and is reused by the next stored vector.
 */
export function invalidateVector(refTable: string, refId: number): void {
  const bucket = buckets.get(refTable);
  if (!bucket) return;
  const slot = bucket.slotOf.get(refId);
  if (slot === undefined) return;
  bucket.slotOf.delete(refId);
  bucket.ids[slot] = -1;
  bucket.live--;
  bucket.free.push(slot);
  if (bucket.live === 0 && queryDepth === 0) buckets.delete(refTable);
}

export function bumpVectorEpoch(): void {
  epoch++;
  buckets.clear();
}

export function getVectorEpoch(): number {
  return epoch;
}

export interface VectorCacheStats {
  entries: number;
  bytes: number;
  budgetBytes: number;
  epoch: number;
  enabled: boolean;
  hits: number;
  misses: number;
}

export function vectorCacheStats(): VectorCacheStats {
  let entries = 0;
  let bytes = 0;
  for (const bucket of buckets.values()) {
    entries += bucket.live;
    bytes += bucket.capacity * VECTOR_BYTES;
  }
  return {
    entries,
    bytes,
    budgetBytes,
    epoch,
    enabled: budgetBytes > 0,
    hits,
    misses,
  };
}
