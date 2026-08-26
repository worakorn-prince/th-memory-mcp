# AGENTS.md — Memory Protocol

โปรเจกต์นี้มี MCP server `memory-mcp` ให้ความจำระยะยาว (SQLite local) ใช้ protocol นี้ทุก session:

```markdown
## Memory Protocol
- ก่อนเริ่ม task ใหม่ที่ซับซ้อน: เรียก get_profile() และ recall("<ประเด็น>") ก่อนเสมอ
- เมื่อผู้ใช้แก้ไขวิธีทำงานหรือตำหนิผลลัพธ์: เรียก save_lesson(situation, mistake, correction) ทันที
- เมื่อผู้ใช้ระบุความชอบ/ข้อกำหนดตายตัว: เรียก remember(category, key, value)
- อย่าเดาความชอบผู้ใช้ ถ้า recall ไม่เจอให้ถามแล้ว remember ไว้
- รับคำสั่งความจำได้ทั้งภาษาไทยและอังกฤษ (ผู้ใช้สลับภาษาได้เสมอ โดยไม่ต้องแจ้งล่วงหน้า)
```

## Tools

| Tool | ใช้เมื่อ |
|------|---------|
| `remember(category, key, value)` | ผู้ใช้บอกความชอบ/ข้อกำหนดตายตัว (category: work_style / coding_pref / language / domain / other) |
| `recall(topic, limit?)` | ก่อน task ใหม่ — ค้น preferences + lessons + interactions ล่าสุด |
| `get_profile()` | ต้องการภาพรวมผู้ใช้ (sections + top preferences + lessons ล่าสุด) |
| `save_lesson(situation, mistake, correction)` | ถูกแก้/ถูกตำหนิ — บันทึกบทเรียนทันที |
| `search_history(query, limit?)` | อยากรู้ context จาก prompt เก่าของผู้ใช้ |
| `memory_stats()` | ต้องการสถิติความจำ (counts แยกตาม kind, ขนาด DB, oldest/newest, profile sections) |
| `get_recent_interactions(limit?, kind?)` | ดู log interactions ล่าสุดแบบดิบ (ใช้ก่อน distill / audit) |
| `export_memory(includeInteractions?, filename?)` | export ความจำทั้งหมดเป็นไฟล์ JSON ใน data/exports/ |
| `forget(target_id)` | ลบความจำที่ผิด/ล้าสมัย (id ได้จาก output ของ remember/save_lesson) |

## Smart Distill

เมื่อผู้ใช้ขอ "สรุปความจำ / distill memory / summarize memory":

1. เรียก `get_recent_interactions(limit=50)`
2. วิเคราะห์หา pattern จริงจากข้อมูล — ความชอบที่เกิดซ้ำ ๆ, บทเรียนจากการถูกแก้, สไตล์การทำงาน
3. บันทึก pattern ที่ชัดเจนด้วย `remember(category, key, value)` / `save_lesson(...)`
4. สรุปสิ่งที่พบให้ผู้ใช้ฟังสั้น ๆ

## Setup

1. Copy config จาก `opencode.example.json` ไป merge ใน `opencode.json` ของเครื่อง
2. Restart OpenCode
3. ทดสอบ: "จำไว้ว่าฉันชอบใช้ pnpm" → session ใหม่ถามกลับว่า package manager ที่ฉันชอบคืออะไร
