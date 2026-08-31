# repro — Reproducible benchmark (internal, small-N)

ชุดข้อมูลและ harness สำหรับทำซ้ำผล benchmark `result/v2.2.4_benchmark_result.md` บนเครื่องตัวเอง

- **ขนาด:** 180 records (30 topics × 5 relevant + 30 distractors) — `datasetVersion: 1.0`
- **ลักษณะ:** internal, small-N, single-machine self-run — **not a third-party benchmark** ห้ามเทียบเท่ากับ LongMemEval

## วิธีรัน

```powershell
npm run build
node repro/run.mjs --out repro/results
```

ตัวเลือก: `--k 10` กำหนด top-K (default 10), `--out` กำหนดโฟลเดอร์ผลลัพธ์

## ผลลัพธ์

- `repro/results/latest.json` — raw metrics
- พิมพ์สรุป Recall@K / Precision@K / MRR / NDCG ทาง stdout
