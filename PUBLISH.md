# Publishing memory-mcp / วิธีเผยแพร่ (ตัวอย่าง)

นี่คือตัวอย่างการเตรียมและเผยแพร่ memory-mcp ลง npm และการลงทะเบียนเป็น OpenCode plugin
This is an example of how to prepare and publish memory-mcp to npm and register it as an OpenCode plugin.

> หมายเหตุ: ยังไม่ได้เผยแพร่จริง — ไฟล์นี้เพื่อแสดงวิธีเท่านั้น
> Note: not actually published yet — this file only demonstrates the steps.

## 1. เตรียม package.json (ตัวอย่าง)
Add these fields to `package.json` (example):
```json
{
  "bin": { "memory-mcp": "dist/index.js" },
  "files": ["dist", "README.md", "README.th.md", "LICENSE", "design.md"],
  "engines": { "node": ">=20" }
}
```
- `bin` ให้ผู้ใช้รัน `npx memory-mcp` ได้โดยไม่ต้อง clone
- `files` จำกัดไฟล์ที่เผยแพร่ (ไม่เอา `test/`, `node_modules/`)
- `engines` บังคับ Node >= 20

## 2. เผยแพร่ลง npm
```bash
npm login
npm version patch      # หรือ minor / major ตามความเหมาะสม
npm publish --access public
```
หลังเผยแพร่ ผู้ใช้ติดตั้งได้ด้วย:
```bash
npm install -g memory-mcp
# หรือรันทันที
npx memory-mcp
```

## 3. ลงทะเบียนเป็น OpenCode plugin
OpenCode โหลด plugin จาก path หรือ git repo — ไม่มี central registry กลาง:
OpenCode loads plugins from a path or git repo — there is no central plugin registry:

- **วิธี A (local):** ชี้ `plugins` ใน `opencode.json` ไปที่ไฟล์ `plugins/learning-capture.ts`
- **วิธี B (git):** fork/clone repo แล้วชี้ path ไปที่โฟลเดอร์
- **วิธี C (url):** อ้างอิงผ่าน git URL ใน `opencode.json`

ตัวอย่าง `opencode.json`:
```json
{
  "plugins": ["/absolute/path/to/th-memory-mcp/plugins/learning-capture.ts"]
}
```

## Checklist ก่อนเผยแพร่จริง / Pre-publish checklist
- [ ] `npm test` ผ่าน (70/70)
- [ ] `npm run build` สำเร็จ
- [ ] LICENSE ถูกต้อง (MIT, copyright `worakorn-prince`)
- [ ] `README.md` / `README.th.md` อัปเดตเวอร์ชันและวิธีติดตั้ง
- [ ] สร้าง Git tag ตรงกับเวอร์ชัน (เช่น `v1.2.0`) และสร้าง GitHub Release
