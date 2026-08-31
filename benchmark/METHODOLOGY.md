# th-memory-mcp Benchmark — Methodology

Methodology for the benchmark per `TH_MEMORY_MCP_BENCHMARK_SPEC.md`.

## Principles

- **LLM-free by default** (§2.2): measured via public MCP operations / internal engines without calling an LLM
- **Deterministic**: dataset is generated with a fixed seed (`datasets/smoke.mjs`) → repeated runs yield identical results on the same machine
- **Reproducible** (§2.1): every result records environment (git/node/OS/CPU/RAM/better-sqlite3) in `environment`
- **Separated Quality / Speed / Resource / Token** (§2.4): report dimensions separately, do not collapse into a single score

## Suite ↔ Spec mapping

| Suite | File | Spec | Measures |
|-------|------|------|----------|
| A.storage | suites/storage.mjs | §4 | insertion / round-trip / forget correctness |
| B.retrieval | suites/retrieval.mjs | §5 | Recall@K / Precision@K / MRR / NDCG@K |
| C.temporal | suites/temporal.mjs | §7 | current / historical / supersession |
| C.conflict | suites/temporal.mjs | §8 | true conflict + false conflict by scope |
| C.scope | suites/temporal.mjs | §9 | USER/SESSION/PROJECT/GLOBAL selection + contamination |
| D.context | suites/context.mjs | §11,§16,§17 | token-budget sweep, critical coverage, noise, info density |
| E.performance | suites/performance.mjs | §12 | latency per operation (warm) |
| E.cold | suites/cold.mjs | §12.2 | latency from fresh process + fresh DB |
| B.ablation | suites/ablation.mjs | §6 | FTS / Vector / FTS+Vector / FTS+Vector+RRF / +Graph |
| F.scalability | suites/scalability.mjs | §13,§14,§15 | throughput, DB size, CPU/RAM |

## Metric definitions

- **Recall@K** = (# relevant in top-K) / (total relevant)
- **Precision@K** = (# relevant in top-K) / K
- **MRR** = mean of 1/rank of the first relevant
- **NDCG@K** = DCG@K divided by IDCG@K (graded relevance = 1 if relevant)
- **Latency** (§12.2): reported as `min / mean / median / p50 / p95 / p99 / max` over N runs (warmup before measurement)
- **Token** (§16): uses deterministic estimator `ceil(len/4)+8` per memory; `relevantTokenRatio = relevantTokens / totalTokens`, `noiseRatio = 1 - relevantTokenRatio`, `infoDensity = relevantUnits / (tokens/1000)`, `accuracyPerToken = coverage / tokens`

## Running

See `README.md` (aggregate commands). Important: run `npm run build` first because the runner imports `../dist/*`.

## Retrieval Mode Switch

`src/core/retrieval-engine.ts` reads env `MEMORY_RETRIEVAL_MODE`:

- `rrf` (default) — FTS + Vector + RRF
- `fts-only` — FTS only (skip vector → fastest, no embedding cost)
- `vector-only` — Vector only

Can be switched instantly to find the balance for a specific workload without code changes.

## Results and Versioning (§28, §23)

- `results/latest.json` + `latest.md` — latest run
- `results/history.jsonl` — aggregated history (with `projectVersion` + `gitCommit`)
- `results/versions/<version>/latest.json` and `<gitCommit>-<ts>.json` — per-version results
- Compare regression:

  ```powershell
  node benchmark/compare.mjs --a 2.2.2 --b 2.3.0 --out benchmark/results
  ```

  Prints a table `metric | A | B | delta | %` with arrows ▲/▼

## Extending

- Add dataset: edit `datasets/smoke.mjs` (builder returns array per case)
- Add suite: create `suites/<name>.mjs` exporting `runXSuite(mods)` then register in `run.mjs`
- `mods` passed to suites: `createMemory, retrieve, getContext, ftsSearch, vectorSearch, rrfFuse, rememberHandler, recallHandler, contextHandler, saveLessonHandler, forgetHandler, updateMemoryHandler, mergeMemoryHandler, linkMemoryHandler, reset, dbPath`

## System notes (baseline v2.2.2)

1. `retrieve` does not filter `valid_until` (only `get_context` does) and does not filter `superseded` memories → stale data may leak (low supersession accuracy)
2. Cold-state is significantly heavier than warm (recall ~4ms vs <1ms, get_context ~10ms vs <1ms) due to process + embedding load
3. Ablation: FTS-only Recall@5 = 1.0 beats Vector-only (0.62); RRF is close to sum-rank but stronger semantically
4. `+Graph` in ablation equals RRF because the dataset has no memory links yet
