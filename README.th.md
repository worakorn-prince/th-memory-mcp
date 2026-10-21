<div align="center">
  <img src="access/Banner.png" alt="th-memory-mcp Banner" width="100%" />
</div>

# th-memory-mcp

<div align="center">

[![npm version](https://img.shields.io/npm/v/th-memory-mcp.svg)](https://www.npmjs.com/package/th-memory-mcp)
[![npm downloads](https://img.shields.io/npm/dm/th-memory-mcp.svg)](https://www.npmjs.com/package/th-memory-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)

[![th-memory-mcp MCP server – quality and maintenance score on Glama](https://glama.ai/mcp/servers/worakorn-prince/th-memory-mcp/badges/score.svg)](https://glama.ai/mcp/servers/worakorn-prince/th-memory-mcp)
[![Th Memory MCP on mcprush](https://mcprush.com/badge/th-memory-mcp/score.svg)](https://mcprush.com/to/th-memory-mcp?ref=badge)

</div>

MCP server ความจำระยะยาวสำหรับ OpenCode — เก็บ preferences, lessons และประวัติการใช้งานลง SQLite ไฟล์เดียว (local 100%, ไม่มี external API) ให้ AI ปรับตัวกับคุณผ่าน context-based learning

> English: [README.md](README.md)

## Requirements (ความต้องการระบบ)

- **Node.js >= 20 + npm** — server ใช้ API เฉพาะของ Node (`better-sqlite3` native build, `import.meta.url`), CI บน Node 20.x/22.x; ติดตั้ง dependencies และรัน build/test ด้วย npm (`npm install`, `npm run build`, `npm test`); ไม่ต้องมี external services, บัญชี หรือ API key — ทุกอย่างอยู่ในไฟล์ SQLite เดียวในเครื่อง
- **OpenCode** — โปรแกรมหลักที่โหลด MCP server และ plugin auto-capture (รองรับ MCP over stdio + plugins; plugin รันบน Bun ที่มากับ OpenCode)
- **OS: Windows / macOS / Linux** — ข้ามแพลตฟอร์ม (Node); Windows ตั้ง `MEMORY_DB_PATH` ด้วย `setx`, macOS/Linux ใช้ `export` ใน shell profile

## Quick Start (เริ่มใช้งานไว)

**ทางที่เร็วที่สุด:** `npm run quickstart` (หลัง clone) — build, ต่อไฟล์ `opencode.json`, วาง plugin และตั้ง `MEMORY_DB_PATH` ให้ในคำสั่งเดียว (ขั้นตอนด้านล่างคือสิ่งที่สคริปต์ทำ) **ติดตั้งผ่าน npm (อีกทาง):** `npm install -g th-memory-mcp` (หรือ `npx th-memory-mcp`) แล้วชี้ `mcp.command` ไปที่ `th-memory-mcp` แทน `dist/index.js` (plugin ยังมาจาก repo นี้; ไม่พับลิชขึ้น GitHub Packages แล้ว)

```bash
# 1. Clone และ build
git clone https://github.com/worakorn-prince/th-memory-mcp.git
cd th-memory-mcp && npm install && npm run build
# 2. ให้ server และ plugin ใช้ DB เดียวกัน (Windows; macOS/Linux ใช้ export แบบบรรทัดล่าง)
setx MEMORY_DB_PATH "$PWD/data/memory.db"      # Windows (PowerShell)
# export MEMORY_DB_PATH="$PWD/data/memory.db"  # macOS/Linux — เพิ่มใน shell profile (~/.zshrc)
```

3. Merge นี่เข้า `~/.config/opencode/opencode.json` (แทน `<REPO>` ด้วย path เต็มของโฟลเดอร์ที่ clone; บล็อกสำเร็จรูปดู [`opencode.example.json`](opencode.example.json)) — `MEMORY_DB_PATH` ต้องชี้ไฟล์ DB เดียวกันทั้ง server และ plugin:

```json
{ "instructions": ["<REPO>/AGENTS.memory.example.md"],
  "mcp": { "memory": { "type": "local", "command": ["node", "<REPO>/dist/index.js"], "enabled": true, "environment": { "MEMORY_DB_PATH": "<REPO>/data/memory.db" } } } }
```

4. (Optional) เปิด auto-capture: คัดลอก `src/plugin/learning-capture.ts` → `~/.config/opencode/plugins/`
5. **Restart OpenCode** (config โหลดตอน start เท่านั้น) แล้วลองใช้: *"จำไว้ว่าฉันชอบใช้ pnpm"* → เปิด session ใหม่ → *"ฉันชอบ package manager อะไร?"*

## สถาปัตยกรรม

OpenCode โหลดสองส่วน: **plugin** `learning-capture` (Bun) — จับ prompt/tool/error ลง DB อัตโนมัติและฉีด profile กลับตอน compaction — และ **MCP server** `th-memory-mcp` (Node stdio) เปิด 16 tools บน SQLite DB เดียวกัน; กฎกลาง (`memory-protocol.md`) สอน AI ให้ใช้ tools

## ทำไมต้องใช้ th-memory-mcp?

- **Context-based learning, local 100%** — จับความชอบ/การถูกแก้/พฤติกรรม แล้วเรียกกลับเข้า context ครั้งหน้า โดยไม่ส่งข้อมูลออกนอกเครื่อง; SQLite ไฟล์เดียว ไม่มีคลาวด์/external API และกรอง secret (`api_key=`, `password:`, `token`) ก่อนบันทึกเสมอ
- **เบา ทนทาน เปิดกว้าง** — tool calls มีเพดาน (latency < 10 ms, ขนาด output จำกัด) และ graceful degradation เมื่อ DB ไม่พร้อม; Node + `better-sqlite3` เท่านั้น; MIT license, 16 tools, rule-based distill, plugin auto-capture
- **Lifecycle & temporal** — states (active/stale/superseded/archived), confidence/importance/salience, decay ต่อ type, validity intervals รองรับ point-in-time truth และ supersession chains
- **Conflict-aware & consolidation** — ตรวจจับ duplicate/contradiction และเก็บทั้งสองฝ่ายของหลักฐานที่ขัดแย้ง; คลัสเตอร์ความจำที่คล้ายกันเป็น derived memory พร้อม provenance (`derived_from`)
- **Hybrid retrieval & ไทย** — `get_context` ผสาน FTS5 + local vector embedding (RRF fusion) แบบ token budget พร้อมขยายผ่าน memory graph; tokenize ไทยใน distill และรับไทย/อังกฤษสลับกันได้

## Scripts

| คำสั่ง | คำอธิบาย |
|-------|----------|
| `npm run build` | compile TypeScript → `dist/` |
| `npm start` | รัน MCP server (stdio) จาก `dist/index.js` |
| `npm run distill` | interactions → profile sections + prune ข้อมูลเก่า (env `RETENTION_DAYS` default 30) |
| `npm test` | build + เทสทั้งชุด (32 ไฟล์, 75 tests) |
| `node test/<name>.test.mjs` | รันทีละ suite: `capture`, `distill`, `lifecycle`, `temporal`, `conflict`, `retrieval`, `graph`, `context`, `consolidation`, `benchmark`, `security` |
| `node test/smoke.mjs` | smoke test end-to-end ผ่าน JSON-RPC (16 tools) |

## Tools (16)

| Tool | คำอธิบาย |
|------|----------|
| `remember` | upsert preference (category+key); ยืนยันซ้ำ +0.1 confidence (cap 1.0) |
| `recall` | ค้น preferences + lessons (FTS5) + interactions ล่าสุดที่ match — ใช้ก่อนเริ่มงานใหม่ |
| `get_profile` | profile sections + top preferences + lessons ล่าสุด 5 รายการ |
| `save_lesson` | บันทึกบทเรียนจากการถูกแก้ (situation / mistake / correction) |
| `search_history` | ค้น prompt เก่าด้วย keyword (snippet 200 chars) |
| `forget` | ลบ row เดียว (preference/lesson/interaction) ตาม id (+type กัน id ชนข้ามตาราง) |
| `memory_stats` | counts แยก kind, ขนาด DB, interaction เก่า/ใหม่สุด, profile sections |
| `get_recent_interactions` | interactions ล่าสุดแบบดิบ (กรองตาม kind) — วัตถุดิบของ Smart Distill |
| `export_memory` | export เป็น JSON ลง `data/exports/` เท่านั้น (sanitize filename) |
| `get_context` | ประกอบความจำที่เกี่ยวข้องผ่าน hybrid retrieval (+ ขยายผ่าน graph), token budgeting |
| `consolidate` | คลัสเตอร์ความจำที่คล้ายกันด้วย embedding; สร้าง derived memory ผูกด้วย `derived_from` ได้ |
| `link_memory` | ลิงก์แบบมีประเภทระหว่างความจำสองอัน: supports/contradicts/supersedes/derived_from/related_to/caused_by/depends_on |
| `merge_memory` | รวมความจำซ้ำเข้า canonical (ต้นทาง superseded; provenance ใน `metadata.merged_from`) |
| `update_memory` | แก้ฟิลด์ที่เปลี่ยนได้ในที่ หรือสร้างความจำแทนที่เมื่อ `content` เปลี่ยน (`supersede=false` = แก้ในที่) |
| `import_memory` | นำเข้าจาก JSON (ตรวจ type, dedup, ไม่เขียนทับมืดบอด); dry-run by default, `apply=true` เพื่อเพิ่ม |
| `extract_memories` | สแกน interactions หาเจตนาบันทึกความจำ เสนอ candidates (ไม่ใช้ LLM); dry-run, `apply=true` เพื่อสร้าง (source=captured) |

## CLI (`th-memory`)

ไบนารี 2 ตัวใน `package.json` (`bin`): `th-memory-mcp` — MCP server (stdio) จาก `dist/index.js` (tools 16 ตัวข้างบน) และ `th-memory` — CLI ภายในเครื่องแบบ zero-dep (`dist/cli.js`, ใช้ DB เดียวกันผ่าน `MEMORY_DB_PATH`)

วิธีใช้: `th-memory [--db <path>] [--json] [--plain] <command> [options]` — help รายคำสั่ง: `th-memory <command> --help`; `highlight`/`recall --highlight` ขีดเส้นใต้ส่วนที่ตรง (`ESC[4m`) บน TTY สี มิฉะนั้นใช้ `[mem]`…`[/mem]` (pipe, `--plain`, `--json`)

| แฟล็ก | ผล |
|------|-----|
| `--db <path>` | ใช้ไฟล์ SQLite นี้ (ตั้งค่า `MEMORY_DB_PATH`) |
| `--json` | พิมพ์ JSON `{ok,data}` แทนข้อความธรรมดา |
| `--plain` / `--no-color` | ปิดสี |
| `-h, --help` / `-V, --version` | แสดง help / เวอร์ชัน |

| คำสั่ง | วิธีใช้ |
|--------|---------|
| `remember` | `remember --category <c> --key <k> --value <v\|->` — บันทึก preference (`--value -` อ่านจาก stdin) |
| `recall` | `recall <topic> [--limit <n>] [--highlight]` — ค้นความจำ |
| `forget` | `forget <id> [--type <t>]` — ลบตาม id (`t`: `memory\|preference\|lesson\|interaction`) |
| `export` | `export [--include-interactions] [--filename <n>]` — export ไป `data/exports/*.json` |
| `import` | `import (--file <p>\|--json <s>) [--apply] [--user-id <id>]` — นำเข้า backup (dry-run by default) |
| `stats` / `profile` | `stats` — สถิติความจำ; `profile` — โปรไฟล์ผู้ใช้ที่กลั่นแล้ว |
| `history` | `history [--query <q>] [--limit <n>]` — ค้น prompt เก่า (ไม่ใส่ query = ล่าสุด) |
| `recent` | `recent [--limit <n>] [--kind <k>]` — interactions ล่าสุด (`k`: `prompt\|tool_call\|error`) |
| `highlight` | `highlight [text...] -q <topic> [--limit <n>]` — ไฮไลต์คำที่ match (ไม่ใส่ text = อ่านจาก stdin) |

```bash
th-memory remember --category coding_pref --key package_manager --value pnpm
echo "I prefer pnpm for installs" | th-memory highlight -q pnpm
```

## ติดตั้งกับ OpenCode

จุดเพิ่มเติมจาก Quick Start: ตั้ง `MEMORY_DB_PATH` เป็น env var ระดับระบบ/ผู้ใช้ (เช่น `setx MEMORY_DB_PATH "D:/path/to/memory.db"`) จะครอบทั้ง server และ plugin โดยอัตโนมัติทุกโปรเจกต์ (plugin รันใน process เดียวกับ OpenCode); ส่วน `environment` ใน mcp ครอบเฉพาะ server — ใช้ [`opencode.example.json`](opencode.example.json) เป็นบล็อกสำเร็จรูป (global หรือ project) และกฎความจำตัวอย่างใน [`AGENTS.memory.example.md`](AGENTS.memory.example.md) (แนบระดับโปรเจกต์แทนได้)

## การใช้งานประจำวัน

AI รับไทย/อังกฤษสลับกันได้ตลอด; ดูแลระยะยาว: รัน `npm run distill` เป็นครั้งคราวเพื่อสรุปสถิติ + ลบ interactions เก่าเกิน 30 วัน

- "จำไว้ว่า..." / "Remember that..." → `remember` — บันทึกความชอบ
- "สรุปความจำ" / "Summarize memory" / "distill memory" → **Smart Distill** — AI อ่าน `get_recent_interactions` วิเคราะห์ pattern แล้วบันทึก insight เอง
- "ระบบความจำเป็นไงบ้าง" / "memory status" → `memory_stats`
- "สำรองความจำ" / "Export memory" → `export_memory`
- "ค้นประวัติ..." / "Search history..." → `search_history` · "ลืม..." / "Forget..." → `forget`

## โครงสร้าง data/

```
data/
├── memory.db          # SQLite (WAL mode) — DB หลัก (+ .db-wal, .db-shm); override path ได้ผ่าน MEMORY_DB_PATH
└── exports/           # ไฟล์ JSON จาก tool export_memory (เขียนได้เฉพาะ dir นี้); นอกนั้นใน data/ ถูก git ignore
```

## License

[MIT](LICENSE) © 2026 worakorn-prince — อ่านข้อความฉบับเต็มได้ในไฟล์ [LICENSE](LICENSE)
