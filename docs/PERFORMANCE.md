# Performance

Numbers below are measured on one Windows workstation (Node 26.12.1, `better-sqlite3` 12.x,
local SSD) with the internal benchmark harness: **20,000 memories / 5,000 queries** (`normal`
profile, `--suite all`, deterministic seed). Absolute numbers are machine-specific — the
*relative* deltas are what matter, and they are reproducible in direction.

The harness itself is local-only (it is not part of the published package), so the tables here are
the record of the measurements. Retrieval quality is measured on the same runs: scope selection
100%, cross-scope contamination 0%, temporal supersession 100%, storage correctness 100%,
semantic-hard MRR 0.955, retrieval R@5 0.906 — unchanged by every optimisation below.

## 2.5.2 — write path is no longer O(n) in database size

`syncSearchIndex()` / `removeSearchIndex()` deleted from the FTS5 tables with
`WHERE ref_table = ? AND ref_id = ?`. An FTS5 virtual table cannot carry a secondary index, so each
delete was a full scan: **10.6 ms per delete at 20k rows**, which made every write O(n) and a bulk
import O(n²).

A `search_index_keys(ref_table, ref_id, strict_rowid, loose_rowid)` side table now maps each ref to
its FTS rowids, so updates and deletes are point operations by rowid. Migration
`015_search_index_keys` backfills existing databases in one O(n) pass without re-segmenting (the
stored index text stays byte-identical).

| metric (20k memories) | 2.5.1 | 2.5.2 | Δ |
|---|---:|---:|---:|
| insert throughput | 73.6 mem/s | **320.5 mem/s** | **+335%** |
| wall-clock insert | 271.7 s | **62.4 s** | −77% |
| `cpuUser` (insert phase) | 222.0 s | 10.7 s | −95% |
| database size | 99.6 MB | 101.1 MB | +1.5% (the side table) |

## 2.5.2 — retrieval no longer re-reads every embedding per query

`vectorSearch()` and the semantic blend in `recall()` read every embedding BLOB per query —
20k × 2 KB = 40 MB — and decoded each row with a per-element `DataView` loop. Three steps fixed it:

1. **ids-only SQL + decoded-vector cache** (`src/retrieval/vector-cache.ts`) — vectors are decoded
   once and kept in a bounded cache; a write invalidates only its own key.
2. **Contiguous matrix** — the cache stores one `Float32Array` per `ref_table` bucket, so scoring is
   a single linear pass of contiguous dot products. This is an **exact** scan (no ANN, no
   approximation): ids, scores and ordering are identical to the uncached path.
3. **Zero-copy `deserialize()`** for 4-byte-aligned little-endian blobs.

| metric (20k memories) | 2.5.1 | 2.5.2 | Δ |
|---|---:|---:|---:|
| `vectorSearch` | 312 ms | **52 ms** | **−83%** |
| `retrieve` | 363 ms | **90 ms** | −75% |
| `get_context` | 357 ms | **86 ms** | −76% |
| `recall` p95 | 3 ms | **1 ms** | −67% |
| FTS keyword channel | 33 ms | 32 ms | unchanged |

Trade-offs, stated plainly:

- RAM: the decoded vectors live outside the JS heap — about `rows × 2 KB`, capped by
  `MEMORY_VECTOR_CACHE_MB` (default **64 MB**; `0` disables the cache and restores the previous
  full-BLOB path byte for byte). At 20k memories that is ~42 MB.
- The **first** query after process start (or after a migration) pays the cache fill: ~450 ms at
  20k. Every query after that is a steady-state hit.
- A single table may take at most 75% of the cache budget; rows beyond that are scored from the
  same batched read, so results stay exact and the table keeps a warm working set instead of being
  evicted every query.

## 2.5.2 — index compute per record halved

`expandIndexedText()` re-segmented each synonym candidate twice, rebuilt its Thai key set on every
call, re-resolved the synonym map per token, and extended Thai joins without an upper bound;
`embed()` allocated a three-element array per character n-gram.

| step | before | after | Δ |
|---|---:|---:|---:|
| compute total (index a record) | 420.6 µs | **202.8 µs** | **−51.8%** |
| `expandIndexedText` | 288.9 µs | 62.0 µs | −78.5% |
| `embed` | 116.4 µs | 104.0 µs | −10.7% |
| `segmentForIndex` | 49.6 µs | 54.6 µs | +10% (long documents bypass the memo) |

Because the write path is I/O-bound at this point, the throughput effect is small; what drops is CPU
(`cpuUser` 10.9 s → 9.8 s for 20k inserts). Output is **byte-identical** — the equivalence test keeps
a verbatim copy of the pre-change implementation and diffs all four functions over a 119-entry
corpus (Thai with tone marks, TH/EN mixed, English, punctuation, emoji/astral, every curated
synonym, edge-case whitespace, empty, long documents) on both the `Intl.Segmenter` and
dictionary-fallback paths.

## Reading the numbers

- **Insert**: one record per transaction. The remaining cost is the FTS5 segment write (~1.4 ms/tx)
  and the commit; the O(n) scan is gone, so throughput is now flat in database size (5K and 20K
  profiles reach the same ~350 mem/s on the same machine).
- **Retrieve**: the remaining cost is the ids-only SQL scan (~21 ms at 20k) plus the matrix pass;
  the BLOB read is amortised by the cache.
- Quality gates are part of the same benchmark run — an optimisation that moves a quality metric is
  rejected even if it is faster.
