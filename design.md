# th-memory-mcp — Design Notes (ปัจจุบัน)

เอกสารนี้อัปเดตล่าสุดสอดคล้องกับสถานะจริงของโค้ด (หลังจบแผนฟีเจอร์อนาคตทั้งหมด ยกเว้น AI-assisted extraction ที่ตัดออก)
สเปคฉบับเต็มอยู่ที่ `ARCHITECTURE_v2.md` (canonical spec) ไฟล์นี้สรุปภาพรวมและสถานะปัจจุบันเพื่อความสะดวก

## สถานะปัจจุบัน
- **เวอร์ชัน:** `package.json` = `2.2.0`
- **MCP tools:** 16 tools (`remember`, `recall`, `get_context`, `link_memory`, `merge_memory`, `update_memory`, `import_memory`, `extract_memories`, `consolidate`, `forget`, `history`, `recent_interactions`, `profile`, `lesson`, `memory_stats`, `export_memory`)
- **ชุดเทสต์:** 20 suites ผ่านหมด (0 fail) — รันผ่าน `npm test` (มี CI บน GitHub Actions)

## องค์ประกอบหลัก (src/)
- `db/` — better-sqlite3 (WAL mode), migrations เชิงเส้น (M001–M007), repositories (`memories`, `users`, `preferences`, `lessons`)
- `lib/embed.ts` — semantic vector แบบ hashing-trick (ไม่พึ่ง LLM/network)
- `retrieval/` — FTS5 + vector → RRF fusion → scorer (confidence × importance × recency × scope)
- `memory/` — types, lifecycle-engine (decay/source-weights), conflict-resolver, deduplicator
- `core/` — retrieval-engine, context-engine, graph-engine, consolidation-engine, entity-extractor
- `tools/` — 16 MCP tool handlers
- `index.ts` — MCP stdio server

## ฟีเจอร์ที่ทำเสร็จแล้ว
- ✅ Temporal model — validity intervals, point-in-time retrieval, supersession chains, change detection
- ✅ Conflict/dedup — normalize → exact → similar → classify (duplicate/update/contradiction/unrelated); ambiguous conflicts ถูกเก็บไว้ (link `contradicts`) ไม่เขียนทับเงียบๆ
- ✅ Hybrid retrieval (FTS + vector, RRF)
- ✅ Memory graph — entities/relations + bounded traversal (`link_memory`)
- ✅ Context engine — `get_context` with token budgeting, temporal filter, graph expansion
- ✅ Consolidation — clustering + derived memories (`derived_from` provenance)
- ✅ Scope hierarchy — `USER` / `SESSION` / `PROJECT` / `GLOBAL` (migrations 006 + 007)
  - `createMemory` อนุมาน scope ตามลำดับ SESSION > PROJECT > USER > GLOBAL
  - `scopeFactorFor` boost ความจำที่เข้าข่ายบริบทปัจจุบัน (USER=1.0, PROJECT/SESSION ตามบริบท, GLOBAL เป็น base)
- ✅ Profile auto-projection — `profile.ts` ดึงความจำสำคัญมาแทรกใน `[memories]`
- ✅ Auto entity extraction — `entity-extractor.ts` สกัด entity แบบ heuristic (ไม่ใช้ LLM) ผูกเข้า graph ตอน consolidate
- ✅ Benchmark in-repo:
  - Retrieval quality (§26) — `test/retrieval_benchmark.test.mjs` (Recall@5=1.00, Precision@5=0.92, MRR=1.00)
  - Perf (§29) — `test/benchmark.test.mjs` วัด latency ต่อ op ผ่าน CI
  - Conflict quality (§27) — `test/conflict_benchmark.test.mjs` (100% บนชุด 14 เคส ครบ 7 หมวด)
  - E2E transport — `test/e2e_transport.test.mjs` (spawn server ผ่าน StdioClientTransport)
- ✅ CI pipeline — `.github/workflows/ci.yml` (ubuntu-latest, node 20, `npm ci`, `npm test`)

## Scope model (รายละเอียด)
| Scope | เงื่อนไข | พฤติกรรม |
|-------|----------|----------|
| SESSION | มี `sessionId` | ผูกกับ session นั้น |
| PROJECT | มี `projectId` (ไม่มี session) | ผูกกับ project นั้น |
| USER | มี `userId` (ไม่มี session/project) | ผูกกับ user นั้น (auto-create row ใน `users`) |
| GLOBAL | ไม่มีอะไรเลย | ความจำร่วมกันทั้งระบบ |

`userId` ที่รับจาก client เป็น external identity (string) — ระบบไม่มีการ authenticate; ตัวตัดความเป็นของ client ทั้งหมด
`preferences` และ `lessons` ยังคงเป็น global (ไม่มี user column)

## ข้อจำกัดที่รู้อยู่ (known limitations)
- **Trust model:** ไม่มี user authentication — `userId` คือสิ่งที่ client แจ้งมา (client-declared) เหมาะกับการ deploy แบบ local single-user ที่ไฟล์ SQLite เป็นของเจ้าของคนเดียว หากต้องการแยกผู้ใช้หลายคน แนะนำแก้ที่ระดับไฟล์ DB (หนึ่ง DB ต่อผู้ใช้) ไม่ใช่เพิ่ม auth ลงใน engine
- `preferences` / `lessons` ไม่ถูกแบ่งตาม user (ยังเป็น global) — ยอมรับได้สำหรับ single-user
- Semantic embedding ใช้ hashing-trick (deterministic, offline) — ไม่ใช่ embedding ระดับ LLM จึงมีขีดจำกัดเรื่อง paraphrase ที่ห่างกันมาก
- **AI-assisted extraction ไม่พัฒนาต่อ** — เจ้าของตัดสินใจตัดหัวข้อนี้ออก `extract_memories` จึงเป็น deterministic heuristic เท่านั้น (ไม่ใช้ LLM) ตามหลักการออกแบบที่ว่า core engine ต้องไม่พึ่งพา external LLM API

## Release
- v2.0.0 ปล่อยแล้ว (npm, GitHub Release, Official MCP Registry, Glama)
- v2.2.0 — tag + GitHub Release สร้างโดย build agent; `npm` / Official MCP Registry / Glama publish รอเจ้าของ re-auth (publish token หมดอายุ)
