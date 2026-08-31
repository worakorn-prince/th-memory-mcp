# th-memory-mcp Benchmark — Methodology

รายละเอียดวิธีการทำ benchmark ตาม `TH_MEMORY_MCP_BENCHMARK_SPEC.md` (โฟลเดอร์นี้ถูก gitignore)

## หลักการ

- **LLM-free โดย default** (§2.2): วัดผ่าน public MCP operations / internal engines โดยไม่เรียก LLM
- **Deterministic**: dataset ถูกสร้างแบบมี seed คงที่ (`datasets/smoke.mjs`) → รันซ้ำได้ผลเท่ากันบนเครื่องเดียวกัน
- **Reproducible** (§2.1): ทุกผลบันทึก environment (git/node/OS/CPU/RAM/better-sqlite3) ลงใน `environment`
- **แยก Quality / Speed / Resource / Token** (§2.4): รายงานแยกมิติ ไม่ยุบเป็นคะแนนเดียว

## แผนที่ Suite ↔ Spec

| Suite | ชื่อไฟล์ | สเปก | วัดอะไร |
|-------|----------|------|---------|
| A.storage | suites/storage.mjs | §4 | insertion / round-trip / forget correctness |
| B.retrieval | suites/retrieval.mjs | §5 | Recall@K / Precision@K / MRR / NDCG@K |
| C.temporal | suites/temporal.mjs | §7 | current / historical / supersession |
| C.conflict | suites/temporal.mjs | §8 | true conflict + false conflict by scope |
| C.scope | suites/temporal.mjs | §9 | USER/SESSION/PROJECT/GLOBAL selection + contamination |
| D.context | suites/context.mjs | §11,§16,§17 | token-budget sweep, critical coverage, noise, info density |
| E.performance | suites/performance.mjs | §12 | latency ต่อ operation (warm) |
| E.cold | suites/cold.mjs | §12.2 | latency จาก fresh process + fresh DB |
| B.ablation | suites/ablation.mjs | §6 | FTS / Vector / FTS+Vector / FTS+Vector+RRF / +Graph |
| F.scalability | suites/scalability.mjs | §13,§14,§15 | throughput, DB size, CPU/RAM |

## นิยาม Metric

- **Recall@K** = (# relevant ใน top-K) / (relevant ทั้งหมด)
- **Precision@K** = (# relevant ใน top-K) / K
- **MRR** = ค่าเฉลี่ยของ 1/rank ของ relevant ตัวแรก
- **NDCG@K** = DCG@K แบ่งด้วย IDCG@K (graded relevance = 1 ถ้าเกี่ยวข้อง)
- **Latency** (§12.2): รายงาน `min / mean / median / p50 / p95 / p99 / max` จาก N รอบ (warmup ก่อนวัดจริง)
- **Token** (§16): ใช้ตัวประมาณ deterministic `ceil(len/4)+8` ต่อความทรงจำ; `relevantTokenRatio = relevantTokens / totalTokens`, `noiseRatio = 1 - relevantTokenRatio`, `infoDensity = relevantUnits / (tokens/1000)`, `accuracyPerToken = coverage / tokens`

## การรัน

ดู `README.md` (คำสั่งรวม). สำคัญ: ต้อง `npm run build` ก่อน เพราะ runner เรียก `../dist/*`

## Retrieval Mode Switch

`src/core/retrieval-engine.ts` อ่าน env `MEMORY_RETRIEVAL_MODE`:

- `rrf` (default) — FTS + Vector + RRF
- `fts-only` — ใช้แค่ FTS (ข้าม vector → เร็วสุด ไม่เสีย embedding)
- `vector-only` — ใช้แค่ Vector

สลับได้ทันทีเพื่อหาจุดสมดุลเฉพาะภาระงาน โดยไม่เปลี่ยนโค้ดอื่น

## ผลลัพธ์และ Versioning (§28, §23)

- `results/latest.json` + `latest.md` — รันล่าสุด
- `results/history.jsonl` — ประวัติรวม (มี `projectVersion` + `gitCommit`)
- `results/versions/<version>/latest.json` และ `<gitCommit>-<ts>.json` — ผลแยกตาม version
- เปรียบเทียบ regression:

  ```powershell
  node benchmark\compare.mjs --a 2.2.2 --b 2.3.0 --out benchmark\results
  ```

  พิมพ์ตาราง `metric | A | B | delta | %` พร้อมลูกศร ▲/▼

## การขยาย

- เพิ่ม dataset: แก้ `datasets/smoke.mjs` (ฟังก์ชัน builder คืน array ต่อกรณี)
- เพิ่ม suite: สร้าง `suites/<name>.mjs` export `runXSuite(mods)` แล้วลงทะเบียนใน `run.mjs`
- `mods` ที่ส่งให้ suite: `createMemory, retrieve, getContext, ftsSearch, vectorSearch, rrfFuse, rememberHandler, recallHandler, contextHandler, saveLessonHandler, forgetHandler, updateMemoryHandler, mergeMemoryHandler, linkMemoryHandler, reset, dbPath`

## ข้อสังเกตจากระบบ (baseline v2.2.2)

1. `retrieve` ไม่กรอง `valid_until` (กรองเฉพาะใน `get_context`) และไม่กรอง memory สถานะ `superseded` → ข้อมูลเก่าอาจหลุดเข้ามา (supersession accuracy ต่ำ)
2. Cold-state หนักกว่า warm ชัดเจน (recall ~4ms vs <1ms, get_context ~10ms vs <1ms) จากโหลด process + embedding
3. Ablation: FTS-only Recall@5 = 1.0 ดีกว่า Vector-only (0.62); RRF ใกล้เคียง sum-rank แต่แข็งแกร่งกว่าด้าน semantic
4. `+Graph` ใน ablation เท่ากับ RRF เพราะ dataset ยังไม่มี memory links
