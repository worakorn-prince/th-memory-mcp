// Decoded-vector cache (TASK-PERF-READ).
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
// Budget: MEMORY_VECTOR_CACHE_MB (default 64 MB, 0 disables the cache). Each
// entry costs EMBED_DIM * 4 bytes. Eviction is FIFO over Map insertion order:
// a read is a single `Map.get` (no reordering), a write reinserts the key so
// it becomes the newest entry. That keeps the 20k-row scan to one Map op per
// row instead of the three a read-touch LRU cost.
import { EMBED_DIM } from "../lib/embed.js";

const VECTOR_BYTES = EMBED_DIM * 4;
const DEFAULT_BUDGET_MB = 64;

interface CacheEntry {
  vec: Float32Array;
}

const cache = new Map<string, CacheEntry>();
let budgetBytes = readBudgetBytes();
let epoch = 0;
let hits = 0;
let misses = 0;
let warnedBadBudget = false;

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
  cache.clear();
}

/**
 * Look up a decoded vector.
 *
 * The returned Float32Array is shared read-only state: the cache hands out the
 * same array to every caller (scoring must not allocate per row), so callers
 * must never mutate it. A caller that needs to transform a vector copies it
 * first (e.g. `new Float32Array(vec)`).
 */
export function getVector(key: string): Float32Array | undefined {
  if (budgetBytes <= 0) return undefined;
  const entry = cache.get(key);
  if (!entry) {
    misses++;
    return undefined;
  }
  hits++;
  return entry.vec;
}

/**
 * Store a decoded vector. Returns the array actually held by the cache, or
 * undefined when the cache is disabled or too small to hold a single entry
 * (callers still use their own copy for the current query).
 *
 * Whatever is returned — the stored array or the caller's own copy — is shared
 * read-only state once it is in the cache; callers must not mutate it. The
 * cache may keep the caller's array by reference when it is exact-sized, so
 * mutating that array in place would silently corrupt every later read.
 *
 * A view that aliases a larger buffer (a pooled Buffer, byteOffset != 0) is
 * copied to an exact EMBED_DIM array so the budget stays a true byte bound.
 */
export function setVector(
  key: string,
  vec: Float32Array
): Float32Array | undefined {
  if (budgetBytes <= 0) return undefined;
  const stored =
    vec.byteOffset === 0 &&
    vec.buffer.byteLength === vec.byteLength &&
    vec.length === EMBED_DIM
      ? vec
      : new Float32Array(vec);
  cache.delete(key);
  cache.set(key, { vec: stored });
  while (cache.size * VECTOR_BYTES > budgetBytes) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
  return cache.get(key)?.vec;
}

export function clearVectorCache(): void {
  cache.clear();
}

/**
 * Drop the decoded vector for one embedding row. A write only makes that one
 * key stale, so the rest of the cache stays warm; callers that rewrite many
 * rows at once (migrations) should keep using `bumpVectorEpoch()`.
 */
export function invalidateVector(refTable: string, refId: number): void {
  cache.delete(vectorKey(refTable, refId));
}

export function bumpVectorEpoch(): void {
  epoch++;
  cache.clear();
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
  return {
    entries: cache.size,
    bytes: cache.size * VECTOR_BYTES,
    budgetBytes,
    epoch,
    enabled: budgetBytes > 0,
    hits,
    misses,
  };
}
