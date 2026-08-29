# th-memory-mcp

[![npm version](https://img.shields.io/npm/v/th-memory-mcp.svg)](https://www.npmjs.com/package/th-memory-mcp)
[![npm downloads](https://img.shields.io/npm/dm/th-memory-mcp.svg)](https://www.npmjs.com/package/th-memory-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

MCP server ความจำระยะยาวสำหรับ OpenCode — เก็บ preferences, lessons, ประวัติการใช้งาน ลง SQLite ไฟล์เดียว (local 100%, ไม่มี external API) เพื่อให้ AI "จำและปรับตัว" กับผู้ใช้ผ่าน context-based learning

**สถานะ:** v2.1.0 — engine ความจำแบบ temporal, conflict-aware, hybrid-retrieval 16 MCP tools, 13 ชุดเทสผ่าน อัปเกรด schema แบบ non-destructive จาก v1 (ข้อมูล v1 ทั้งหมดถูกเก็บรักษา) ฟีเจอร์ใหม่ใน v2: lifecycle states, temporal validity, การแก้ conflict/dedup, hybrid FTS+vector retrieval (RRF), memory graph, ประกอบ `get_context`, consolidation, และ `link_memory` / `merge_memory` / `update_memory` / `import_memory` / `extract_memories`

> English: [README.md](README.md)

## Requirements (ความต้องการระบบ)

- **Node.js >= 20** — server ใช้ API ของ Node โดยเฉพาะ (better-sqlite3 แบบ native build และการหา path ด้วย `import.meta.url`) และ MCP SDK ต้องการ runtime สมัยใหม่ CI ของเราทดสอบบน Node 20.x และ 22.x
- **npm** — สำหรับติดตั้ง dependencies และรัน build/test (`npm install`, `npm run build`, `npm test`)
- **OpenCode** — โปรแกรมหลักที่โหลด MCP server นี้และ plugin auto-capture ใช้ OpenCode รุ่นที่รองรับ MCP (stdio) + plugins (plugin รันบน Bun ที่มากับ OpenCode)
- **OS: Windows / macOS / Linux** — server ข้ามแพลตฟอร์มได้ (Node) plugin auto-capture รันได้ทุกที่ที่มี Bun ของ OpenCode หมายเหตุสำหรับ Windows: ตั้ง `MEMORY_DB_PATH` ง่ายสุดด้วย `setx` ส่วน macOS/Linux ใช้ `export` ใน shell profile

ไม่ต้องมีบริการภายนอก บัญชี หรือ API key — ทุกอย่างอยู่ในไฟล์ SQLite ภายในเครื่อง

## Quick Start (เริ่มใช้งานไว)

**ทางที่เร็วที่สุด:** หลัง clone ให้รัน `npm run quickstart` — มันจะ build, ต่อไฟล์ `opencode.json`, วาง plugin และตั้ง `MEMORY_DB_PATH` ให้ในคำสั่งเดียว ขั้นตอนด้านล่างคือสิ่งที่สคริปต์ทำ (ใช้ได้หากอยากควบคุมเองทีละขั้น)

**ติดตั้งผ่าน npm (อีกทางเลือก):** ติดตั้ง server แบบ global ด้วย `npm install -g th-memory-mcp` (หรือรันทันทีด้วย `npx th-memory-mcp`) แล้วชี้ `command` ของ `mcp` ใน `opencode.json` ไปที่ `th-memory-mcp` แทน `dist/index.js` ที่ build แล้ว plugin auto-capture ยังคงมาจาก repo นี้ (คัดลอก `src/plugin/learning-capture.ts` ตามขั้นตอน 4 ด้านล่าง)

```bash
# 1. Clone และ build
git clone https://github.com/worakorn-prince/th-memory-mcp.git
cd th-memory-mcp
npm install
npm run build

# 2. ให้ server และ plugin ใช้ DB เดียวกัน
#    Windows (PowerShell):
setx MEMORY_DB_PATH "$PWD/data/memory.db"
#    macOS / Linux (เพิ่มใน shell profile เช่น ~/.zshrc):
# export MEMORY_DB_PATH="$PWD/data/memory.db"
```

3. นำไป merge ใน `~/.config/opencode/opencode.json` (แทน `<REPO>` ด้วย path เต็มของโฟลเดอร์ที่ clone):

```json
{
  "instructions": ["<REPO>/AGENTS.memory.example.md"],
  "mcp": {
    "memory": {
      "type": "local",
      "command": ["node", "<REPO>/dist/index.js"],
      "enabled": true,
      "environment": { "MEMORY_DB_PATH": "<REPO>/data/memory.db" }
    }
  }
}
```

4. (Optional) เปิด auto-capture: คัดลอก `src/plugin/learning-capture.ts` → `~/.config/opencode/plugins/`
5. **Restart OpenCode**
6. ลองใช้: *"จำไว้ว่าฉันชอบใช้ pnpm"* → เปิด session ใหม่ → *"ฉันชอบ package manager อะไร?"*

## สถาปัตยกรรม

```
OpenCode ──┬─ Plugin learning-capture (Bun)  ── จับ prompt/tool/error ลง DB อัตโนมัติ
            │                                   └─ ฉีด profile กลับ context ตอน compaction
              └─ MCP th-memory-mcp (Node.js stdio)  ── tools 16 ตัว อ่าน/เขียน SQLite เดียวกัน
                                                      ▲
                               Global instructions (memory-protocol.md) สอน AI ใช้ tools
```

รายละเอียดสถาปัตยกรรมเต็มอยู่ใน [ARCHITECTURE_v2.md](ARCHITECTURE_v2.md) — คู่มืออัปเกรดจาก v1 ดูได้ที่ [MIGRATION_v2.md](MIGRATION_v2.md)

## ทำไมต้องใช้ th-memory-mcp?

LLM ไม่ได้จำคุณข้าม session — แชทใหม่ทุกครั้งเริ่มจากศูนย์ th-memory-mcp มอบความจำระยะยาวแบบส่วนตัว ภายในเครื่อง ให้ AI ของคุณ:

- **เรียนรู้แบบ context-based ไม่ใช่ fine-tuning** — จับความชอบ/การถูกแก้/พฤติกรรม ของคุณ แล้วเรียกกลับเข้า context ครั้งหน้า กลไกเดียวกับฟีเจอร์ความจำของ AI ชั้นนำ โดยไม่ส่งข้อมูลออกนอกเครื่อง
- **local 100% และเป็นส่วนตัว** — ไฟล์ SQLite เดียว ไม่มีคลาวด์ ไม่มี external API มีการกรอง secret ก่อนบันทึกเสมอ
- **โอเวอร์เฮดต่ำ** — ทุก tool call มีเพดาน (latency < 10 ms, ขนาด output จำกัด) และ AI ค้นความจำเฉพาะตอนจำเป็น จึงไม่บวม context
- **ทนทาน** — ทุก tool ทำ graceful degradation ถ้า DB ไม่ได้เปิด AI ก็ทำงานต่อได้แทนที่จะพัง
- **Lifecycle & temporal** — ทุกความจำมี lifecycle state (active/stale/superseded/archived), คะแนน confidence/importance/salience, decay ต่อ type, และ validity intervals ให้ AI เหตุผลเรื่อง point-in-time truth และ supersession chains ได้
- **Conflict-aware** — ตรวจจับ duplicate / contradiction และแก้ด้วย update/supersession โดยเก็บทั้งสองฝ่ายของหลักฐานที่ขัดแย้งแทนการเขียนทับเงียบๆ
- **Hybrid retrieval** — `get_context` ผสาน FTS5 + local vector embedding (RRF fusion + scoring) แล้วประกอบ context แบบมี token budget พร้อมขยายผ่าน memory graph
- **Consolidation** — จัดคลัสเตอร์ความจำที่คล้ายกันเป็น derived memory พร้อม provenance (`derived_from` links)
- **เปิดกว้างและต่อยอดได้** — MIT license, 11 tools ที่อธิบายครบ, มี rule-based distill และ plugin auto-capture ที่คุณปรับแต่งได้

## Scripts

| Command | คำอธิบาย |
|---------|----------|
| `npm run build` | compile TypeScript → `dist/` |
| `npm start` | รัน MCP server (stdio) จาก `dist/index.js` |
| `npm run distill` | rule-based distill: interactions → profile sections + prune ข้อมูลเก่า (env `RETENTION_DAYS` default 30) |
| `npm test` | ชุดเทสครบ: capture, distill, lifecycle, temporal, conflict, retrieval, graph, context, consolidation, benchmark, security, smoke |
| `node test/capture.test.mjs` | ทดสอบ capture-core (filter secrets, dedupe, truncate, insert SQL) |
| `node test/distill.test.mjs` | ทดสอบ distill-core (tokenize ไทย, stats, profile sections, prune) |
| `node test/lifecycle.test.mjs` | ทดสอบ lifecycle engine (states, decay, supersession) |
| `node test/temporal.test.mjs` | ทดสอบ temporal model (validity, historical retrieval) |
| `node test/conflict.test.mjs` | ทดสอบ conflict & dedup resolution |
| `node test/retrieval.test.mjs` | ทดสอบ hybrid FTS+vector+RRF retrieval |
| `node test/graph.test.mjs` | ทดสอบ memory graph (entities, relations, traversal) |
| `node test/context.test.mjs` | ทดสอบ context assembly + token budgeting |
| `node test/consolidation.test.mjs` | ทดสอบ clustering + derived memories |
| `node test/benchmark.test.mjs` | เทสความเร็วบนความจำ 300 รายการ |
| `node test/security.test.mjs` | ตรวจการ injection / ความปลอดภัย |
| `node test/smoke.mjs` | smoke test end-to-end ผ่าน JSON-RPC (11 tools) |

## Tools (16)

| Tool | คำอธิบาย |
|------|----------|
| `remember` | upsert preference (category+key) — ยืนยันซ้ำ confidence +0.1 (cap 1.0) |
| `recall` | ค้น preferences + lessons (FTS5) + interactions ล่าสุดที่ match ตาม topic |
| `get_profile` | ภาพรวมผู้ใช้: profile sections + top preferences + lessons ล่าสุด 5 รายการ |
| `save_lesson` | บันทึกบทเรียนจากการถูกแก้ (situation / mistake / correction) |
| `search_history` | ค้น prompt เก่าด้วย keyword (snippet 200 chars/รายการ) |
| `forget` | ลบ row เดียว (preference/lesson/interaction) ตาม id (+type กัน id ชนข้ามตาราง) |
| `memory_stats` | สถิติความจำ: counts แยก kind, ขนาด DB, oldest/newest interaction, profile sections |
| `get_recent_interactions` | ดึง interactions ล่าสุดแบบดิบ (กรองตาม kind ได้) — วัตถุดิบของ Smart Distill |
| `export_memory` | export ความจำเป็น JSON ลง `data/exports/` เท่านั้น (sanitize filename ให้เอง) |
| `get_context` | ประกอบความจำที่เกี่ยวข้องกับงานปัจจุบันผ่าน hybrid retrieval (+ ขยายผ่าน memory graph ได้) พร้อม token budgeting |
| `consolidate` | จัดคลัสเตอร์ความจำที่คล้ายกันด้วย embedding cosine และสร้าง derived/consolidated memory ที่ผูกด้วย `derived_from` ได้ |
| `link_memory` | สร้างความสัมพันธ์แบบมีประเภทระหว่างความจำสองอันในกราฟ |
| `merge_memory` | รวมความจำที่ซ้ำเข้ากับความจำหลัก (ต้นทางถูก superseded, เก็บ provenance ไว้ใน `metadata.merged_from`) |
| `update_memory` | อัปเดตฟิลด์ที่เปลี่ยนได้แบบไม่เปลี่ยนตัวตน หรือสร้างความจำแทนที่เมื่อ `content` เปลี่ยน (ตั้ง `supersede=false` เพื่อแก้ในที่) |
| `import_memory` | นำเข้าความจำจาก JSON (ตรวจสอบ type, dedup กับของเดิม, ไม่เขียนทับแบบมืดบอด); ค่าเริ่มต้น dry-run, ตั้ง `apply=true` เพื่อเพิ่ม |
| `extract_memories` | สแกน interactions ล่าสุดหาเจตนาบันทึกความจำ และเสนอ/สร้างความจำ (ไม่ใช้ LLM); ค่าเริ่มต้น dry-run, ตั้ง `apply=true` เพื่อสร้าง (source=captured) |

## ติดตั้งกับ OpenCode

1. Merge `mcp` section จาก [`opencode.example.json`](opencode.example.json) เข้า `opencode.json` (global หรือ project-level)
   - **สำคัญ:** ตั้ง `MEMORY_DB_PATH` ให้ชี้ที่ไฟล์ DB เดียวกันทั้ง server และ plugin (ในตัวอย่างคือ `<ABSOLUTE_PATH>/th-memory-mcp/data/memory.db`) มิฉะนั้น auto-capture plugin จะเขียนลง DB คนละไฟล์กับที่ AI อ่าน
   - วิธีตั้ง (เลือกหนึ่ง):
     - กำหนดใน `environment` ของ mcp (ดูตัวอย่าง) — ครอบคลุมเฉพาะ MCP server
     - **หรือ** กำหนดเป็น environment variable ระดับระบบ/ผู้ใช้ (เช่น `setx MEMORY_DB_PATH "D:/path/to/memory.db"` บน Windows) — ครอบคลุมทั้ง server และ plugin เพราะ plugin รันใน process เดียวกับ OpenCode
2. ผูกกฎความจำระดับ global — เพิ่มใน `opencode.json`:
   ```json
   "instructions": ["C:/Users/<user>/.config/opencode/memory-protocol.md"]
   ```
   (ตัวอย่างเนื้อหากฎอยู่ใน [`AGENTS.memory.example.md`](AGENTS.memory.example.md) — ใช้แนบระดับโปรเจกต์แทนได้)
3. (Optional) Deploy plugin auto-capture: copy `src/plugin/learning-capture.ts` → `~/.config/opencode/plugins/learning-capture.ts`
4. **Restart OpenCode** (config โหลดตอน start เท่านั้น)
5. ทดสอบ: *"จำไว้ว่าฉันชอบใช้ pnpm"* → เปิด session ใหม่ถามกลับ

## การใช้งานประจำวัน

AI รองรับสองภาษา (ไทย/อังกฤษ) สลับกันได้ตลอด โดยไม่ต้องแจ้งล่วงหน้า

| ไทย | English | สิ่งที่เกิด |
|------|---------|-----------|
| "จำไว้ว่า..." | "Remember that..." | `remember` — บันทึกความชอบ |
| "สรุปความจำ" / "distill memory" | "Summarize memory" / "distill memory" | **Smart Distill** — AI อ่าน `get_recent_interactions` วิเคราะห์ pattern แล้วบันทึก insight เอง |
| "ระบบความจำเป็นไงบ้าง" | "How is my memory?" / "memory status" | `memory_stats` |
| "สำรองความจำ" | "Export memory" / "backup memory" | `export_memory` |
| "ค้นประวัติ..." | "Search history..." | `search_history` |
| "ลืม..." | "Forget..." | `forget` |

ดูแลระยะยาว: รัน `npm run distill` เป็นครั้งคราวเพื่อสรุปสถิติ + ลบ interactions เก่าเกิน 30 วัน

## โครงสร้าง data/

```
data/
├── memory.db          # SQLite (WAL mode) — DB หลัก (+ .db-wal, .db-shm)
└── exports/           # ไฟล์ JSON จาก tool export_memory (เขียนได้เฉพาะ dir นี้)
```

- path ของ DB override ได้ผ่าน env `MEMORY_DB_PATH`
- ทุกอย่างใน `data/` ถูก git ignore
