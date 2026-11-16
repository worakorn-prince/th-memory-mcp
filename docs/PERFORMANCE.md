# Performance

The latest benchmark snapshot is **v3.0.1 (recorded 2026-11-16; runs 2026-11-15 UTC)**. The `benchmark/` harness and generated
result files are local-only and are not shipped with the package, so this document is the durable
record of the measurements.

**“Latest 3 values per version”** means the three most recent measured runs for that version and
profile, ordered oldest → newest. The main tables compare v2.5.1, v3.0.0, and v3.0.1. Older
versions are not mixed into those tables because their runs used an older benchmark framework or
contain incomplete fields. Absolute values depend on the machine; with n=3 per comparable
version/profile, use the direction and proportion of the changes rather than any single value.

## v3.0.1 — latest benchmark (recorded 2026-11-16; runs 2026-11-15 UTC)

**Environment:** Windows_NT 10.0.19045 · Node v26.12.1 · AMD Ryzen 7 2700U (8 logical CPUs) ·
RAM 15,261 MB · seed 42 · benchmark framework 2.3.0-draft. The v2.5.1 baseline reported
`better-sqlite3` 12.11.1; v3.0.0 (`5beb859`) and v3.0.1 (`9cdf93c`) use native
`better-sqlite3-multiple-ciphers` 13.1.1 (the harness recorded its runtime version field as `?`).
All three versions were measured on the same workstation.

### Headline (profile normal = 20,000 memories / 5,000 queries)

Each cell contains the latest three runs, oldest → newest.

| metric | 2.5.1 (3 latest) | 3.0.0 (3 latest) | 3.0.1 (3 latest) |
|---|---:|---:|---:|
| insert throughput (mem/s) | 352.6 / 331.9 / 320.5 | 331.7 / 277.4 / 361.5 | 348.0 / 337.4 / 352.9 |
| `retrieve` @20k (ms) | 103.9 / 106.2 / 90.3 | 75.8 / 87.2 / 82.2 | 76.7 / 74.4 / 73.5 |
| `get_context` @20k (ms) | 102.5 / 116.5 / 86.2 | 70.3 / 70.7 / 80.5 | 70.5 / 68.5 / 69.5 |
| `recall` p95 (ms) | 1.00 / 2.00 / 1.00 | 1.00 / 2.00 / 1.00 | 2.00 / 2.00 / 1.00 |
| cold `recall` p95 (ms) | 8.6 / 5.0 / 14.8 | 8.8 / 11.4 / 11.6 | 9.6 / 9.6 / 10.0 |
| DB size (MB) | 101.1 / 101.1 / 101.1 | 101.1 / 101.3 / 100.7 | 100.7 / 100.7 / 100.7 |
| peak RSS (MB) | 119.5 / 112.8 / 202.8 | 434.4 / 432.1 / 432.5 | 432.7 / 432.7 / 432.3 |

### Last 3 runs per version — profile quick

Profile quick = 5,000 memories / 1,000 queries.

| version | run | timestamp (UTC) | git | insert mem/s | insert wall (s) | cpuUser (s) | retrieve ms | get_context ms | recall p95 ms | cold recall p95 ms | db size MB | peak RSS MB |
|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2.5.1 | 5 | 2026-11-11 16:36 | `fd9acf4` | 346.4 | 14.4 | 2.8 | 28.2 | 24.2 | 1.05 | 8.0 | 28.8 | 115.3 |
| 2.5.1 | 6 | 2026-11-11 17:11 | `edf13d5` | 333.4 | 15.0 | 2.4 | 30.6 | 24.2 | 1.00 | 5.8 | 28.8 | 109.6 |
| 2.5.1 | 7 | 2026-11-11 17:39 | `5c08551` | 325.3 | 15.4 | 2.1 | 21.7 | 21.6 | 1.00 | 14.4 | 28.8 | 198.9 |
| 3.0.0 | 1 | 2026-11-15 19:50 | `5beb859` | 286.8 | 17.4 | 3.2 | 21.7 | 22.9 | 1.05 | 8.8 | 28.8 | 262.1 |
| 3.0.0 | 2 | 2026-11-15 20:03 | `5beb859` | 349.1 | 14.3 | 2.3 | 21.1 | 19.9 | 1.00 | 9.0 | 28.8 | 305.5 |
| 3.0.0 | 3 | 2026-11-15 20:07 | `5beb859` | 345.8 | 14.5 | 2.5 | 18.3 | 17.5 | 1.00 | 8.8 | 28.8 | 306.0 |
| 3.0.1 | 1 | 2026-11-15 19:34 | `9cdf93c` | 309.9 | 16.1 | 3.0 | 21.4 | 20.6 | 1.00 | 8.0 | 28.8 | 305.5 |
| 3.0.1 | 2 | 2026-11-15 19:55 | `9cdf93c` | 355.7 | 14.1 | 2.1 | 22.7 | 25.6 | 1.00 | 10.6 | 28.8 | 262.8 |
| 3.0.1 | 3 | 2026-11-15 19:59 | `9cdf93c` | 345.0 | 14.5 | 2.3 | 19.9 | 17.7 | 2.00 | 8.8 | 28.8 | 262.3 |

### Last 3 runs per version — profile normal

Profile normal = 20,000 memories / 5,000 queries.

| version | run | timestamp (UTC) | git | insert mem/s | insert wall (s) | cpuUser (s) | retrieve ms | get_context ms | recall p95 ms | cold recall p95 ms | db size MB | peak RSS MB |
|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2.5.1 | 4 | 2026-11-11 16:39 | `fd9acf4` | 352.6 | 56.7 | 10.9 | 103.9 | 102.5 | 1.00 | 8.6 | 101.1 | 119.5 |
| 2.5.1 | 5 | 2026-11-11 17:14 | `edf13d5` | 331.9 | 60.3 | 9.8 | 106.2 | 116.5 | 2.00 | 5.0 | 101.1 | 112.8 |
| 2.5.1 | 6 | 2026-11-11 17:41 | `5c08551` | 320.5 | 62.4 | 12.3 | 90.3 | 86.2 | 1.00 | 14.8 | 101.1 | 202.8 |
| 3.0.0 | 1 | 2026-11-15 19:53 | `5beb859` | 331.7 | 60.3 | 11.4 | 75.8 | 70.3 | 1.00 | 8.8 | 101.1 | 434.4 |
| 3.0.0 | 2 | 2026-11-15 20:05 | `5beb859` | 277.4 | 72.1 | 13.4 | 87.2 | 70.7 | 2.00 | 11.4 | 101.3 | 432.1 |
| 3.0.0 | 3 | 2026-11-15 20:09 | `5beb859` | 361.5 | 55.3 | 8.5 | 82.2 | 80.5 | 1.00 | 11.6 | 100.7 | 432.5 |
| 3.0.1 | 1 | 2026-11-15 19:36 | `9cdf93c` | 348.0 | 57.5 | 9.6 | 76.7 | 70.5 | 2.00 | 9.6 | 100.7 | 432.7 |
| 3.0.1 | 2 | 2026-11-15 19:57 | `9cdf93c` | 337.4 | 59.3 | 10.8 | 74.4 | 68.5 | 2.00 | 9.6 | 100.7 | 432.7 |
| 3.0.1 | 3 | 2026-11-15 20:01 | `9cdf93c` | 352.9 | 56.7 | 9.3 | 73.5 | 69.5 | 1.00 | 10.0 | 100.7 | 432.3 |

### Last 3 runs per version — profile heavy

Profile heavy = 100,000 memories / 10,000 queries. Only one comparable current-framework heavy run
exists, so it is shown as-is; no value is inferred or filled in.

| version | run | timestamp (UTC) | git | insert mem/s | insert wall (s) | cpuUser (s) | retrieve ms | get_context ms | recall p95 ms | cold recall p95 ms | db size MB | peak RSS MB |
|---|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 3.0.1 | 1 | 2026-11-15 19:48 | `9cdf93c` | 333.2 | 300.1 | 57.1 | 1,761.3 | 1,754.9 | 1.00 | 10.5 | 486.7 | 1,515.4 |

### Quality gates (last run per version/profile)

| version | profile | timestamp (UTC) | git | storage | scope selection | cross-scope contamination | supersession | R@5 | MRR | semantic-hard MRR | non-crash | graph hop1 |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 2.5.1 | quick | 2026-11-11 17:39 | `5c08551` | 100.0% | 100.0% | 0.0% | 100.0% | 90.6% | 1.000 | 0.955 | 100.0% | 100.0% |
| 2.5.1 | normal | 2026-11-11 17:41 | `5c08551` | 100.0% | 100.0% | 0.0% | 100.0% | 90.6% | 1.000 | 0.955 | 100.0% | 100.0% |
| 3.0.0 | quick | 2026-11-15 20:07 | `5beb859` | 100.0% | 100.0% | 0.0% | 100.0% | 90.6% | 1.000 | 0.955 | 100.0% | 100.0% |
| 3.0.0 | normal | 2026-11-15 20:09 | `5beb859` | 100.0% | 100.0% | 0.0% | 100.0% | 90.6% | 1.000 | 0.955 | 100.0% | 100.0% |
| 3.0.1 | quick | 2026-11-15 19:59 | `9cdf93c` | 100.0% | 100.0% | 0.0% | 100.0% | 90.6% | 1.000 | 0.955 | 100.0% | 100.0% |
| 3.0.1 | normal | 2026-11-15 20:01 | `9cdf93c` | 100.0% | 100.0% | 0.0% | 100.0% | 90.6% | 1.000 | 0.955 | 100.0% | 100.0% |
| 3.0.1 | heavy | 2026-11-15 19:48 | `9cdf93c` | 100.0% | 100.0% | 0.0% | 100.0% | 90.6% | 1.000 | 0.955 | 100.0% | 100.0% |

### Observations

- In profile normal, `retrieve` / `get_context` for v3.0.0 and v3.0.1 took about **68–87 ms**,
  faster than the **86–116 ms** measured for v2.5.1.
- **Peak RSS is materially higher for v3.0.x** than for v2.5.1: about **262–306 MB vs 110–199 MB**
  in profile quick, and about **432 MB vs 113–203 MB** in profile normal. This coincides with the addition
  of the auth/encryption modules and native `better-sqlite3-multiple-ciphers`. These runs did not
  isolate the components, so the measurements do not establish which one consumed the extra memory.
- Every latest v3.0.0 and v3.0.1 run has the same quality results: storage 100%, scope selection
  100%, cross-scope contamination 0%, supersession 100%, R@5 90.6%, MRR 1.000, semantic-hard MRR
  0.955, non-crash 100%, and graph hop1 100%.

### Reproduce

Run the benchmarks serially; concurrent runs can contend for CPU and distort latency/throughput.

```powershell
npm run build
npm run benchmark:all-profiles          # quick + normal + heavy
node benchmark/history-retro.mjs --versions v3.0.0 --profiles quick,normal --force
```

`--force` makes the retro benchmark measure a fresh round instead of reusing a completed state in `benchmark/results/.retro-state.json`.

The following historical sections retain the original v2.5.2 measurements. They explain the earlier
optimisations but are not part of the current three-run-per-version comparison.

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
