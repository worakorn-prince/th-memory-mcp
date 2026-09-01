# th-memory-mcp Benchmark (own framework) — v2.3 (draft)

Benchmark per `TH_MEMORY_MCP_BENCHMARK_SPEC.md` (v1.0) and `review/benchmark_v2.2.7.md` (v2.3 draft) to measure memory system quality, scope safety, and token efficiency in an LLM-free, deterministic, reproducible way.

Methodology, metrics, suite-to-spec mapping and interpretation are in **[METHODOLOGY.md](./METHODOLOGY.md)**.

## Quick run

```powershell
cd D:\Coding_Project\mcp
npm run build
node benchmark/run.mjs --suite all --out benchmark/results
node benchmark/run.mjs --profile quick --out benchmark/results   # 5K/1K quick (dev) — 2 profiles before commit
node benchmark/run.mjs --profile normal --out benchmark/results  # 20K/5K normal
```

Run specific suites:

```powershell
node benchmark/run.mjs --suite storage
node benchmark/run.mjs --suite retrieval --topics 120 --distractors 100
node benchmark/run.mjs --suite semantic-hard --topics 100 --distractors 20 --seed 42
node benchmark/run.mjs --suite temporal
node benchmark/run.mjs --suite context
node benchmark/run.mjs --suite graph --scenarios 100
node benchmark/run.mjs --suite performance --warmup 20 --iterations 100
node benchmark/run.mjs --suite cold --iterations 30
node benchmark/run.mjs --suite ablation --topics 50 --distractors 50
node benchmark/run.mjs --suite scalability --scale 5000
node benchmark/run.mjs --suite scalability --profile stress   # 500K/25K (resumable)
node benchmark/run.mjs --suite reliability
```

Options: `--suite {all|storage|retrieval|semantic-hard|temporal|context|graph|performance|cold|ablation|scalability|reliability}`,
`--profile {quick|normal|heavy|stress|extreme}`, `--topics`, `--distractors`, `--warmup`, `--iterations`, `--scale`, `--queries`, `--scenarios`, `--seed`, `--k`, `--out`

## Output (§28) and Versioning (§23)

- `benchmark/results/latest.json` + `latest.md` — latest run
- `benchmark/results/history.jsonl` — aggregated history (with `projectVersion` + `gitCommit`)
- `benchmark/results/versions/<version>/` — per-version results (`latest.json` and per-run files)
- Compare two versions:

  ```powershell
  node benchmark/compare.mjs --a 2.2.2 --b 2.3.0 --out benchmark/results
  ```

## Notes

- Switch retrieval mode instantly with env `MEMORY_RETRIEVAL_MODE` (`rrf`|`fts-only`|`vector-only`) — see METHODOLOGY.md for details
