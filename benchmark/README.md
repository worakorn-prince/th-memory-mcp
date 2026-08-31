# th-memory-mcp Benchmark (own framework)

Benchmark ตาม `TH_MEMORY_MCP_BENCHMARK_SPEC.md` เพื่อวัดประสิทธิภาพของระบบความจำแบบ LLM-free, deterministic, reproducible (โฟลเดอร์นี้ถูก gitignore)

รายละเอียดวิธีการ ตัวชี้วัด สาแผนที่ suite↔spec และการแปลผลอยู่ใน **[METHODOLOGY.md](./METHODOLOGY.md)**

## รันอย่างเร็ว

```powershell
cd D:\Coding_Project\mcp
npm run build
node benchmark\run.mjs --suite all --out benchmark\results
```

รันบาง suite:

```powershell
node benchmark\run.mjs --suite storage
node benchmark\run.mjs --suite retrieval --topics 120 --distractors 100
node benchmark\run.mjs --suite temporal
node benchmark\run.mjs --suite context
node benchmark\run.mjs --suite performance --warmup 20 --iterations 100
node benchmark\run.mjs --suite cold --iterations 20
node benchmark\run.mjs --suite ablation --topics 50 --distractors 50
node benchmark\run.mjs --suite scalability --scale 10000
```

ตัวเลือก: `--suite {all|storage|retrieval|temporal|context|performance|cold|ablation|scalability}`,
`--topics`, `--distractors`, `--warmup`, `--iterations`, `--scale`, `--out`

## Output (§28) และ Versioning (§23)

- `benchmark/results/latest.json` + `latest.md` — รันล่าสุด
- `benchmark/results/history.jsonl` — ประวัติรันรวม (มี `projectVersion` + `gitCommit`)
- `benchmark/results/versions/<version>/` — ผลแยกตาม version (`latest.json` และไฟล์รันละไฟล์)
- เปรียบเทียบสอง version:

  ```powershell
  node benchmark\compare.mjs --a 2.2.2 --b 2.3.0 --out benchmark\results
  ```

## หมายเหตุ

- สลับ retrieval mode ได้ทันทีด้วย env `MEMORY_RETRIEVAL_MODE` (`rrf`|`fts-only`|`vector-only`) — ดูรายละเอียดใน METHODOLOGY.md
- ทุกไฟล์อยู่ใน `benchmark/` ที่ถูก gitignore ไม่หลุดเข้า git
