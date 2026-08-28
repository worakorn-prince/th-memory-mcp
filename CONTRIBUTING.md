# Contributing to th-memory-mcp / ข้อควรรู้สำหรับผู้ร่วมพัฒนา

ขอบคุณที่สนใจร่วมพัฒนา! — Thanks for your interest in contributing!

## ภาษา / Language
- ไฟล์นี้และ README เป็นสองภาษา (ไทย + อังกฤษ) คุณสามารถเขียน issue / PR ได้ทั้งสองภาษา
- This file and the README are bilingual (Thai + English); issues/PRs may be written in either language.

## การตั้งค่าสภาพแวดล้อมพัฒนา / Dev setup
```bash
git clone https://github.com/worakorn-prince/th-memory-mcp.git
cd th-memory-mcp
npm install
npm run build
npm test
```
- ต้องใช้ Node.js >= 20 (ดูรายละเอียดใน README > Requirements)
- Requires Node.js >= 20 (see README > Requirements)

## กฎการเขียนโค้ด / Code conventions
- ภาษาหลัก: TypeScript (strict mode)
- Main language: TypeScript (strict mode)
- ห้ามเพิ่ม comment ในโค้ด เว้นแต่จำเป็น หรือผู้ใช้ร้องขอ
- No comments in code unless necessary or explicitly requested
- ใช้คำทับศัพท์ภาษาไทยผสมอังกฤษในการสื่อสาร (เช่น build, debug, plugin)
- Use Thai+English technical terms in communication
- ทุก MCP tool ต้องมี graceful degradation และจำกัดขนาด output (เป้าหมาย < 10 ms ต่อ call)
- Every MCP tool must degrade gracefully and cap its output

## การเพิ่ม tool ใหม่ / Adding a new tool
1. ลงทะเบียนใน `src/server/index.ts` (register tool + handler)
2. เพิ่ม test ใน `test/` (เป้าหมายให้ `npm test` ผ่าน 70+ assertions)
3. อัปเดต README (หัวข้อ Tools) และ `design.md` ถ้าจำเป็น
4. เพิ่มเข้าไปใน Smart Distill rule ถ้าเกี่ยวข้อง

## กระบวนการ PR / Pull request workflow
- แตก branch จาก `master` (เช่น `feat/...`, `fix/...`) หรือ fork แล้วเปิด PR
- Branch off `master` (e.g. `feat/...`, `fix/...`), or fork and open a PR
- ทดสอบให้ผ่าน `npm test` และ `npm run build` ก่อนเปิด PR
- ใช้ conventional commit (เช่น `feat:`, `fix:`, `docs:`, `chore:`)
- CI (Node 20.x / 22.x) ต้องผ่าน
- CI (Node 20.x / 22.x) must pass

## License
- โปรเจกต์นี้ใช้ MIT — copyright holder `worakorn-prince`
- This project is MIT licensed, copyright holder `worakorn-prince`
- การเปิด PR ถือว่าคุณยอมรับให้โค้ดเผยแพร่ภายใต้ MIT
- By opening a PR you agree your contribution is released under the MIT License.
