# th-memory-mcp Benchmark (own framework)

Benchmark per `TH_MEMORY_MCP_BENCHMARK_SPEC.md` to measure memory system performance in an LLM-free, deterministic, reproducible way.

Methodology, metrics, suite-to-spec mapping and interpretation are in **[METHODOLOGY.md](./METHODOLOGY.md)**.

## Quick run

```powershell
cd D:\Coding_Project\mcp
npm run build
node benchmark/run.mjs --suite all --out benchmark/results
```

Run specific suites:

```powershell
node benchmark/run.mjs --suite storage
node benchmark/run.mjs --suite retrieval --topics 120 --distractors 100
node benchmark/run.mjs --suite temporal
node benchmark/run.mjs --suite context
node benchmark/run.mjs --suite performance --warmup 20 --iterations 100
node benchmark/run.mjs --suite cold --iterations 20
node benchmark/run.mjs --suite ablation --topics 50 --distractors 50
node benchmark/run.mjs --suite scalability --scale 10000
```

Options: `--suite {all|storage|retrieval|temporal|context|performance|cold|ablation|scalability}`,
`--topics`, `--distractors`, `--warmup`, `--iterations`, `--scale`, `--out`

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
