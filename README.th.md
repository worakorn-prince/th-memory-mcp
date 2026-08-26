# memory-mcp

MCP server ความจำระยะยาวสำหรับ OpenCode — เก็บ preferences, lessons, ประวัติการใช้งาน ลง SQLite ไฟล์เดียว (local 100%, ไม่มี external API) เพื่อให้ AI "จำและปรับตัว" กับผู้ใช้ผ่าน context-based learning

**สถานะ:** v1.1.0 — อิมพลีเมนต์ครบ 4 Phase, tests ผ่าน 70/70 assertions (smoke 53 + capture 8 + distill 9)

> English: [README.md](README.md)

## สถาปัตยกรรม

```
OpenCode ──┬─ Plugin learning-capture (Bun)  ── จับ prompt/tool/error ลง DB อัตโนมัติ
            │                                   └─ ฉีด profile กลับ context ตอน compaction
            └─ MCP memory-mcp (Node.js stdio)  ── tools 9 ตัว อ่าน/เขียน SQLite เดียวกัน
                                                      ▲
                               Global instructions (memory-protocol.md) สอน AI ใช้ tools
```

รายละเอียดเต็มอยู่ใน [design.md](design.md)

## Scripts

| Command | คำอธิบาย |
|---------|----------|
| `npm run build` | compile TypeScript → `dist/` |
| `npm start` | รัน MCP server (stdio) จาก `dist/index.js` |
| `npm run distill` | rule-based distill: interactions → profile sections + prune ข้อมูลเก่า (env `RETENTION_DAYS` default 30) |
| `npm test` | smoke test end-to-end ผ่าน JSON-RPC (`node test/smoke.mjs`) |
| `node test/capture.test.mjs` | ทดสอบ capture-core (filter secrets, dedupe, truncate, insert SQL) |
| `node test/distill.test.mjs` | ทดสอบ distill-core (tokenize ไทย, stats, profile sections, prune) |

## Tools (9)

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

## ติดตั้งกับ OpenCode

1. Merge `mcp` section จาก [`opencode.example.json`](opencode.example.json) เข้า `opencode.json` (global หรือ project-level)
   - **สำคัญ:** ตั้ง `MEMORY_DB_PATH` ให้ชี้ที่ไฟล์ DB เดียวกันทั้ง server และ plugin (ในตัวอย่างคือ `<ABSOLUTE_PATH>/memory-mcp/data/memory.db`) มิฉะนั้น auto-capture plugin จะเขียนลง DB คนละไฟล์กับที่ AI อ่าน
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
