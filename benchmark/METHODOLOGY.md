# th-memory-mcp Benchmark — Methodology

Methodology for the benchmark per `TH_MEMORY_MCP_BENCHMARK_SPEC.md` (v1.0 baseline v2.2.2) and `review/benchmark_v2.2.7.md` (v2.3 draft baseline v2.2.6 → target v2.3.x, upgraded in v2.2.7).

## Principles

- **LLM-free by default** (§2.2): measured via public MCP operations / internal engines without calling an LLM
- **Deterministic**: dataset is generated with a fixed seed (`datasets/smoke.mjs`) → repeated runs yield identical results on the same machine
- **Reproducible** (§2.1): every result records environment (git/node/OS/CPU/RAM/better-sqlite3) in `environment`
- **Separated Quality / Speed / Resource / Token** (§2.4): report dimensions separately, do not collapse into a single score

## Suite ↔ Spec mapping

| Suite | File | Spec | Measures |
|-------|------|------|----------|
| A.storage | suites/storage.mjs | v1 §4 + v2.3 §5 | insertion / round-trip / forget correctness, scope/type/timestamp/provenance |
| B.retrieval | suites/retrieval.mjs | v1 §5 + v2.3 §6 | Recall@K / Precision@K / MRR / NDCG@K (standard lexical) |
| C.semantic-hard | suites/semantic-hard.mjs | v2.3 §7-9 | 8 categories: exact/variation/typo/thai_paraphrase/synonym/thai_english/indirect/conceptual, per-category Recall/MRR/NDCG |
| C.temporal | suites/temporal.mjs | v1 §7 + v2.3 §10 | current / historical / supersession, valid_from/until, stale/archived |
| C.conflict | suites/temporal.mjs | v1 §8 + v2.3 §11 | true/false/scope-separated/temporal conflicts, unsafe merge rate |
| C.scope | suites/temporal.mjs | v1 §9 + v2.3 §12-14 | USER/SESSION/PROJECT/GLOBAL selection, retrieval vs context contamination |
| D.context | suites/context.mjs | v1 §11,§16,§17 + v2.3 §18-20 | token-budget sweep 128→8192, criticalCoverage/relevantTokenRatio/noiseRatio/contextRelevance/infoDensity/accuracyPerToken |
| E.performance | suites/performance.mjs | v1 §12 + v2.3 §21-23 | latency per operation warm (remember/recall/get_context/...), p50/p95/p99 |
| E.cold | suites/cold.mjs | v1 §12.2 + v2.3 §23 | cold fresh process+DB via subprocess, 30 samples, startup + first op |
| B.ablation | suites/ablation.mjs | v1 §6 + v2.3 §30 | FTS / Vector / FTS+Vector / +RRF / +Graph / +Graph+Scope / Full + latency trade-off |
| F.scalability | suites/scalability.mjs | v1 §13-15 + v2.3 §24-29 | 5 profiles quick(10K)→extreme(10M) + queries, throughput/DB/index/RSS/CPU, resumable |
| G.graph | suites/graph.mjs | v2.3 §15-17 | 100 scenarios 5-20 nodes 1-3 hops 7 relations, Graph Recall/Precision/MRR/NDCG/1-3hop accuracy/noise |
| M.reliability | suites/reliability.mjs | v2.3 §28 + §29 | graceful degradation, secret filtering, host non-fatal |

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

## Profiles (v2.3 §24 §27)

| Profile | Memories | Queries | Purpose | Frequency |
|---------|---------:|--------:|---------|-----------|
| quick   | 10K | 1K | Development fast regression | Every change |
| normal  | 100K | 5K | Routine regression | Regular |
| heavy   | 1M | 10K | Large workload | Major changes |
| stress  | 5M | 25K | Stress / degradation | Pre-release |
| extreme | 10M | 50K | Maximum validation | Release |

Official v2.3 max is 10M; 50M intentionally excluded. Large generation is resumable via `*.scalability-state.json`.

## System notes (baseline v2.2.6 → v2.2.7)

1. `retrieve` does not filter `valid_until` (only `get_context` does) and does not filter `superseded` memories → stale data may leak (low supersession accuracy) — unchanged from v2.2.2
2. Cold-state is significantly heavier than warm (recall ~4ms vs <1ms, get_context ~10ms vs <1ms) due to process + embedding load — warmup 20/100, cold 30 samples
3. Ablation v2.2.6: FTS-only Recall@5 = 1.0 beats Vector-only (0.62); RRF is close to sum-rank but stronger semantically — v2.2.7 adds +Graph+Scope/Full variants and reports latency trade-off
4. `+Graph` in ablation equals RRF on standard dataset (no links) — use `G.graph` suite (100 linked scenarios) for real graph benefit
5. v2.2.7 scope contamination baseline 75% (before hardening) → target 0% after hard filtering (§14)
6. BenchmarkVersion bumped `1.0 → 2.3.0-draft` in `benchmark/lib/harness.mjs`; datasetVersion now `smoke-1.0/semantic-hard-1.0/graph-1.0/scope-1.0`
