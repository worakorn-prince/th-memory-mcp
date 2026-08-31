# repro — Reproducible benchmark (internal, small-N)

Dataset and harness to reproduce the benchmark in `result/v2.2.4_benchmark_result.md` on your machine.

- **Size:** 180 records (30 topics × 5 relevant + 30 distractors) — `datasetVersion: 1.0`
- **Nature:** internal, small-N, single-machine self-run — **not a third-party benchmark**, do not compare as if from an external evaluator

## How to run

```powershell
npm run build
node repro/run.mjs --out repro/results
```

Options: `--k 10` sets top-K (default 10), `--out` sets output folder

## Output

- `repro/results/latest.json` — raw metrics
- Prints summary Recall@K / Precision@K / MRR / NDCG to stdout
