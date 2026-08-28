# Design: Adaptive Memory MCP — ระบบความจำเรียนรู้พฤติกรรมผู้ใช้สำหรับ OpenCode

> โปรเจกต์: D:\Coding_Project\mcp
> วันที่: 2026-08-26 (rev.3 — อัปเดต as-built หลังอิมพลีเมนต์ครบทุก Phase)
> สถานะ: **อิมพลีเมนต์เสร็จสมบูรณ์** — server v1.1.0, tools 9 ตัว, tests ผ่าน 70/70 assertions

## 1. ภาพรวม

สร้างระบบให้ OpenCode "จำและปรับตัว" กับผู้ใช้ได้ ประกอบด้วย 3 องค์ประกอบ:

1. **MCP Server (th-memory-mcp v1.1.0)** — เก็บ/ค้น preferences, lessons, ประวัติการใช้งาน ลง SQLite พร้อม tools 9 ตัวให้ AI เรียกใช้
2. **OpenCode Plugin (learning-capture)** — hook events จับ prompt/tool usage อัตโนมัติ และฉีด profile กลับเข้า context ตอน compaction
3. **Global Instructions (memory-protocol.md)** — กฎ Memory Protocol ผูกเข้าทุก agent/session ผ่าน `"instructions"` ใน global opencode.json

### ข้อจำกัดที่ต้องเข้าใจ (สำคัญ)
LLM API **ไม่ได้เทรนต่อจากข้อมูลเรา** — การ "เรียนรู้" ที่ทำได้จริงคือ **context-based learning**:
- เก็บพฤติกรรม → distill เป็น preferences/lessons
- ดึงกลับเข้า context ตอน session ใหม่ (AI เรียก tool recall / plugin inject)
วิธีนี้คือกลไกเดียวกับฟีเจอร์ memory ของผลิตภัณฑ์ AI ชั้นนำ

## 2. สถาปัตยกรรม

```
┌────────────────────────────────────────────┐
│                  OpenCode                  │
│                                            │
│  ┌──────────────────┐   ┌───────────────┐  │
│  │ learning-capture │   │   AI Agent    │  │
│  │ Plugin (Bun)     │   │               │  │
│  │ - message.updated│   │  เรียก MCP    │  │
│  │ - tool.execute.* │   │  tools        │  │
│  │ - compacting*    │   │               │  │
│  └────────┬─────────┘   └──────┬────────┘  │
└───────────┼─────────────────────┼──────────┘
            │ write (bun:sqlite)  │ read/write (stdio JSON-RPC)
            ▼                     ▼
   ┌─────────────────────────────────────┐
   │      th-memory-mcp v1.1.0 (Node+SDK)   │
   │  better-sqlite3 (WAL) ◀── shared ── │
   │  Tools (9): remember, recall,       │
   │  get_profile, save_lesson,          │
   │  search_history, forget,            │
   │  memory_stats,                      │
   │  get_recent_interactions,           │
   │  export_memory                      │
   └─────────────────────────────────────┘
              │
              ▼
   D:/Coding_Project/mcp/data/memory.db
```

(*) compaction hook = `experimental.session.compacting` ใช้ใน Phase 3

### วงจรการเรียนรู้ (Learning Loop)
1. **Capture** — plugin จับ prompt/tool usage ลงตาราง `interactions` อัตโนมัติ + AI บันทึก preferences/lessons ผ่าน tools
2. **Distill** — สรุป raw log เป็น preference/profile: rule-based ผ่าน `npm run distill` (tokenize ไทยด้วย Intl.Segmenter + prune เกิน 30 วัน) และ AI-assisted ผ่าน Smart Distill workflow ใน protocol
3. **Recall** — session ใหม่: AI เรียก `get_profile` + `recall(topic)` ตาม Memory Protocol (global instructions)
4. **Inject** — plugin ฉีด profile อัตโนมัติตอน session compaction (`experimental.session.compacting`)

## 3. Data Model (SQLite)

ไฟล์ DB: `data/memory.db` (path override ได้ผ่าน env `MEMORY_DB_PATH`)
เปิด WAL mode + busy_timeout=5000 ทุก connection

```sql
-- บันทึกพฤติกรรมดิบ (plugin เขียน)
CREATE TABLE interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,                -- ISO datetime
  session_id TEXT,
  kind TEXT NOT NULL,              -- 'prompt' | 'tool_call' | 'error'
  content TEXT NOT NULL,           -- ข้อความ (truncate ตามกฎ)
  meta TEXT                        -- JSON เสริม เช่น tool name, project dir
);

-- ความชอบ/ข้อกำหนดของผู้ใช้ (AI/plugin เขียน)
CREATE TABLE preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,          -- work_style | coding_pref | language | domain | other
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence REAL DEFAULT 0.5,     -- 0..1 เพิ่มทุกครั้งที่ยืนยันซ้ำ
  source TEXT DEFAULT 'explicit',  -- explicit | corrected | inferred
  updated_at TEXT NOT NULL,
  UNIQUE(category, key)
);

-- บทเรียนจากการถูกแก้
CREATE TABLE lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  situation TEXT NOT NULL,         -- สถานการณ์เดิม
  mistake TEXT NOT NULL,           -- สิ่งที่ทำผิด
  correction TEXT NOT NULL,        -- วิธีที่ถูกต้อง
  created_at TEXT NOT NULL
);

-- โปรไฟล์สรุป (distilled)
CREATE TABLE profile (
  section TEXT PRIMARY KEY,        -- identity | goals | style | notes
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Virtual table สำหรับค้นหา
CREATE VIRTUAL TABLE search_index USING fts5(
  ref_table, ref_id, title, body
);
```

## 4. สเปค MCP Tools

Server name: `th-memory-mcp`, version **1.1.0**, transport stdio
ทุก tool return `{ content: [{ type: "text", text }] }`, error ต้อง catch แล้วคืนข้อความ error (ห้าม crash)

| Tool | Args (zod) | พฤติกรรม |
|------|-----------|----------|
| `remember` | `category` enum, `key`: string, `value`: string | upsert preferences; ถ้า key เดิม → confidence += 0.1 (cap 1.0), update value+updated_at |
| `recall` | `topic`: string, `limit`?: number (default 8) | FTS5 ค้น search_index (preferences+lessons) + interactions ล่าสุด 20 รายการที่ match; คืนข้อความจัดกลุ่ม ไม่เกิน ~2000 chars |
| `get_profile` | (ไม่มี) | รวม profile sections + top preferences (sort confidence desc, limit 15) + lessons ล่าสุด 5 รายการ |
| `save_lesson` | `situation`, `mistake`, `correction`: string | insert lessons + update search_index |
| `search_history` | `query`: string, `limit`?: number (default 10) | FTS5 ใน interactions (kind='prompt') คืน ts + content ตัด 200 chars/รายการ |
| `forget` | `target_id`: number, `type`? enum("preference","lesson","interaction") | ลบจากตารางตาม id (+type กัน id ชนข้ามตาราง — autoincrement แยกกัน) + sync search_index |
| `memory_stats` | (ไม่มี) | counts interactions แยก kind + ขนาดไฟล์ DB + oldest/newest interaction + profile sections; ≤1500 chars |
| `get_recent_interactions` | `limit`? (default 20, max 100), `kind`? enum("prompt","tool_call","error") | rows ล่าสุด format `[id] ts [kind] content(300)`; ≤4000 chars |
| `export_memory` | `includeInteractions`? bool (default false), `filename`? string | เขียน JSON ลง `data/exports/` เท่านั้น (sanitize filename `[A-Za-z0-9._-]`, ห้าม `..`); return path+size+preview ≤500 chars |

## 5. สเปค Plugin (learning-capture)

ไฟล์: `src/plugin/learning-capture.ts` → deploy ไปที่ `~/.config/opencode/plugins/learning-capture.ts`
Runtime: Bun (plugin ของ OpenCode รันด้วย Bun) → ใช้ `bun:sqlite` เปิด DB เดียวกัน (WAL รองรับ multi-process)

```ts
// as-built: self-contained 1 ไฟล์ — logic inline sync กับ src/lib/capture-core.ts
// (ประกาศ minimal type เอง ไม่ import @opencode-ai/plugin กันปัญหา module resolution)
import { Database } from "bun:sqlite"

export const LearningCapture = async (ctx) => {
  const db = new Database(process.env.MEMORY_DB_PATH ?? "D:/Coding_Project/mcp/data/memory.db")
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")
  // CREATE TABLE IF NOT EXISTS interactions (...) กัน DB ยังไม่เคยถูกสร้าง
  const dedupe = createDedupe()
  return {
    event: async ({ event }) => {
      // message.updated (role=user) → insert kind='prompt' (truncate 4000, dedupe ด้วย message id)
      // session.error → insert kind='error'
    },
    "tool.execute.after": async (input, output) => {
      // insert kind='tool_call' (dedupe ด้วย callID, truncate 500)
    },
    "experimental.session.compacting": async (input, output) => {
      // buildProfileText(db): profile sections + top preferences (confidence desc, 15)
      //   + lessons ล่าสุด 5 → ≤3000 chars → output.context.push(txt)
      // ห่อ try/catch เงียบทั้งหมด — injection ล้ม = ไม่มีอะไรเสียหาย
    },
  }
}
```

กฎการ capture:
- Dedupe ด้วย message id (กัน event ยิงซ้ำ) — เก็บ Set ของ id ที่บันทึกแล้วใน memory ของ process
- ห้ามเก็บ secret: กรองบรรทัดที่ match `/(api[_-]?key|secret|token|password)\s*[=:]/i` ออกก่อนบันทึก
- ทุก write ต้อง try/catch — plugin ห้ามทำให้ OpenCode ล้ม

## 6. การทำให้ AI ใช้ความจำ (Memory Protocol)

ติดตั้งแล้ว 2 ระดับ:

1. **Global (ใช้งานจริง)** — ไฟล์ `~/.config/opencode/memory-protocol.md` ผูกผ่าน `"instructions"` ใน global opencode.json → ครอบคลุม**ทุก agent ทุก session** โดยไม่ต้องสลับ agent
2. **Project-level (ทางเลือก)** — copy จาก `AGENTS.memory.example.md` ไปแนบ AGENTS.md ของโปรเจกต์เฉพาะที่

สาระสำคัญของ protocol:
- เรียก `get_profile` + `recall` ก่อน task ใหม่ที่ซับซ้อน
- `save_lesson` ทันทีเมื่อถูกผู้ใช้แก้ / `remember` ทันทีเมื่อผู้ใช้บอกความชอบ / ห้ามเดา — recall ไม่เจอต้องถาม
- `search_history` เมื่อสงสัยว่าเคยคุย / `forget` เมื่อยืนยันกับผู้ใช้แล้ว
- เรียก memory tools เฉพาะจุดจำเป็น (ไม่ใช่ทุก message) / ห้ามเก็บ secret / memory offline → ทำงานต่อแบบ graceful

**Smart Distill**: เมื่อผู้ใช้ขอ "สรุปความจำ" → `get_recent_interactions(limit=50)` → วิเคราะห์ pattern จริง → บันทึก insight ด้วย `remember`/`save_lesson` → สรุปให้ผู้ใช้ฟังพร้อมรายการสิ่งที่บันทึกใหม่

## 7. โครงสร้างไฟล์

```
D:\Coding_Project\mcp\
├── design.md                   # เอกสารนี้ (rev.3 as-built)
├── README.md                   # คู่มือใช้งาน + scripts + tools
├── package.json                # type: module, scripts: build/start/distill/test
├── tsconfig.json               # NodeNext, ES2022, strict; exclude src/plugin + test
├── .gitignore                  # node_modules, dist, data/
├── data\                       # memory.db (+wal/shm) และ exports\ (git ignore)
├── src\
│   ├── index.ts                # McpServer v1.1.0 + registerTool ×9 + StdioServerTransport
│   ├── db.ts                   # schema init, WAL, helper query, FTS sync
│   ├── lib\
│   │   ├── capture-core.ts     # pure logic: filterSecrets/truncate/dedupe/buildRow/INSERT_SQL
│   │   └── distill-core.ts     # pure logic: tokenize(ไทย)/computeStats/formatProfileSections
│   ├── distill.ts              # CLI: runDistill(db) + prune (RETENTION_DAYS default 30)
│   ├── tools\
│   │   ├── remember.ts recall.ts profile.ts lesson.ts history.ts forget.ts
│   │   ├── memory_stats.ts recent_interactions.ts export_memory.ts
│   └── plugin\
│       └── learning-capture.ts # self-contained Bun plugin → deploy copy ไป ~/.config/opencode/plugins/
├── test\
│   ├── smoke.mjs               # 53 checks end-to-end JSON-RPC (spawn server จริง)
│   ├── capture.test.mjs        # 8 checks (capture-core + SQL insert)
│   └── distill.test.mjs        # 9 checks (tokenize/stats/runDistill/prune/idempotent)
├── AGENTS.memory.example.md    # Memory Protocol + Smart Distill (ฉบับ project-level)
└── opencode.example.json       # config mcp ตัวอย่าง
```

## 8. เทคโนโลยี

| ส่วน | เลือกใช้ | เหตุผล |
|------|---------|--------|
| MCP Server | Node.js ≥ 20 + TypeScript + `@modelcontextprotocol/sdk@1.30.0` + zod | มาตรฐาน official |
| DB (server) | `better-sqlite3@12.x` + FTS5 | sync API เร็ว ใช้ง่าย, prebuilt binary ไม่ต้อง compile |
| DB (plugin) | `bun:sqlite` (built-in) | plugin รันบน Bun ไม่ต้องติดตั้ง native module |
| Tokenize ภาษาไทย | `Intl.Segmenter("th", { granularity: "word" })` + fallback split whitespace | segment คำไทยไร้ช่องว่าง (built-in Node) |

> หมายเหตุ as-built: plugin เขียนแบบ **self-contained** (ประกาศ minimal type ในไฟล์เอง) จึงไม่ต้องติดตั้ง `@opencode-ai/plugin`

## 9. รายการงานย่อย

### Phase 1 — MVP: MCP Server ✅ เสร็จ 2026-08-25
1. Init project: `"type": "module"`, deps: `@modelcontextprotocol/sdk`, `zod`, `better-sqlite3`; devDeps: `typescript`, `@types/node`, `@types/better-sqlite3`, `@opencode-ai/plugin`
2. `src/db.ts`: สร้าง schema ตามข้อ 3, เปิด WAL, busy_timeout, ฟังก์ชัน helper + FTS sync
3. Tools 6 ตัวแรกตามสเปคข้อ 4 (แยกไฟล์ใน `src/tools/` — ภายหลังขยายเป็น 9 ตัวใน Phase 4)
4. `src/index.ts`: McpServer("th-memory-mcp") + register + StdioServerTransport (**ห้าม console.log — ใช้ stderr เท่านั้น**)
5. Build + smoke test ด้วย MCP Inspector (`npx @modelcontextprotocol/inspector node dist/index.js`) ทดสอบ remember → recall → forget ครบ
6. สร้าง `opencode.example.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "memory": {
      "type": "local",
      "command": ["node", "D:/Coding_Project/mcp/dist/index.js"],
      "enabled": true,
      "environment": {}
    }
  }
}
```

7. สร้าง `AGENTS.memory.example.md` ตามข้อ 6 ของสถาปัตยกรรม
8. แนะนำผู้ใช้: merge config → restart OpenCode → ทดสอบ "จำไว้ว่าฉันชอบใช้ pnpm" แล้วถามกลับ session ใหม่

### Phase 2 — Plugin auto-capture ✅ เสร็จ 2026-08-26
9. `src/plugin/learning-capture.ts` ตามสเปคข้อ 5 (dedupe + กรอง secret + try/catch ทุกจุด)
10. Copy ไป `~/.config/opencode/plugins/learning-capture.ts` → restart OpenCode → ใช้งานสักพัก → เช็คว่าตาราง interactions มีข้อมูลไหลเข้า (`search_history` ต้องค้นเจอ prompt เก่า)

### Phase 3 — Inject + Distill ✅ เสร็จ 2026-08-26
11. เพิ่ม hook `"experimental.session.compacting"` ใน plugin: `output.context.push(profile text)` จาก get_profile logic
12. Script distill: rule-based สรุป interactions → profile sections (`npm run distill`, tokenize ไทยด้วย Intl.Segmenter) + prune เกิน RETENTION_DAYS

### Phase 4 — Insight & Safety ✅ เสร็จ 2026-08-26
13. Tools ใหม่ 3 ตัว: `memory_stats` / `get_recent_interactions` / `export_memory` (sanitize filename + เขียนได้เฉพาะ data/exports/) — server bump v1.1.0
14. Smart Distill workflow เพิ่มใน memory-protocol.md (global) + AGENTS.memory.example.md + README.md

> หมายเหตุ as-built เพิ่มเติม: global instructions (`memory-protocol.md` ผ่าน `"instructions"` ใน opencode.json) แทนการใช้ dedicated agent — ครอบคลุมทุก agent โดยไม่ต้องสลับ; smoke test ขยายเป็น 53 checks รวม security case (filename ไม่ปลอดภัยถูก reject)

## 10. ความเสี่ยงและการรับมือ

| ความเสี่ยง | ผลกระทบ | รับมือ |
|-----------|---------|--------|
| Context bloat จาก recall ยาว | เปลือง token | cap 2000 chars/tool call, limit default |
| ความจำผิด/ค้างสมัย | AI ทำงานผิดไปทาง | confidence + updated_at + tool forget + user review |
| SQLite access พร้อมกัน 2 process (Bun+Node) | lock error | WAL mode + busy_timeout=5000 |
| Event `message.updated` ยิงถี่ | DB บวม/duplicate | dedupe ด้วย message id + truncate |
| Secret หลุดลง DB | ความปลอดภัย | regex filter ก่อนเขียนทุก record |
| stdout ปน log | protocol พัง | stderr เท่านั้นใน server code |
| Config invalid | OpenCode ไม่ start | ใส่ `$schema` ตรวจกับ https://opencode.ai/config.json |

## 11. การพึ่งพา

- Node.js ≥ 20, npm
- OpenCode ที่รองรับ plugin + MCP (เวอร์ชันปัจจุบัน)
- ไม่มี external service/API — ข้อมูลอยู่ local 100% (privacy by design)

## 12. Performance Budget (ข้อกำหนดตรวจสอบ)

Building Agent ต้องอิมพลีเมนต์ให้ตรงงบนี้:

| รายการ | งบประมาณ | วิธีตรวจ |
|--------|----------|----------|
| Query latency ต่อ tool call | < 100 ms (SQLite local) | จับเวลาใน smoke test |
| ขนาด output สูงสุดต่อ tool | `recall` ≤ 2000 chars, `search_history` ≤ 200 chars/รายการ, `get_profile` ≤ 3000 chars | assert ในโค้ด (truncate เสมอ) |
| Default limit | recall=8, search_history=10 รายการ | ค่า default ใน zod schema |
| Plugin write ต่อ event | < 5 ms, fire-and-forget (ไม่ block event loop) | code review |
| Startup server | < 2 s ถึงพร้อมรับ initialize | จับเวลา |

**ผลวัดจริง (2026-08-26):** latency ต่อ tool call **1–9 ms**, startup **792–997 ms**, output ทุก tool อยู่ในงบ, tests ผ่าน **70/70** (smoke 53 + capture 8 + distill 9)

### แนวปฏิบัติป้องกัน overhead
- Memory Protocol กำหนดให้เรียก memory **เฉพาะ task ใหม่/ซับซ้อน** ห้ามเรียกทุก message
- Graceful degradation: หาก DB/server error ต้อง return error message สั้น ๆ แล้วให้ AI ทำงานต่อได้ทันที ห้าม retry ถี่จน timeout
- ห้าม auto-inject profile ทุก turn — inject เฉพาะตอน compaction (Phase 3)

### ความเสี่ยงระยะยาวที่ต้อง monitor
- คุณภาพความจำเสื่อม (ความจำขัดกันเอง) → ใช้ confidence + updated_at + forget + distill (Phase 3)
- DB โต → FTS5 index รองรับ, วางแผน VACUUM/optimize เป็นระยะ

## 13. Phase ถัดไป (Optional / Future)

- Semantic search ด้วย embedding (local model หรือ API) แทน FTS5
- Dashboard สถิติการใช้งาน (เว็บเล็ก ๆ อ่าน DB)
- Multi-project memory scoping (แยกตาม directory/worktree)
- Import memory จากไฟล์ export (ฝั่ง export เสร็จแล้วใน Phase 4)
- LLM-assisted distill อัตโนมัติผ่าน OpenCode SDK (แทน trigger ด้วยคำสั่งผู้ใช้)
