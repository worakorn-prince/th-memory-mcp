# Contributing to th-memory-mcp

Thanks for your interest in contributing!

## Language
- This file and the README are bilingual (Thai + English); issues/PRs may be written in either language.

## Dev setup
```bash
git clone https://github.com/worakorn-prince/th-memory-mcp.git
cd th-memory-mcp
npm install
npm run build
npm test
```
- Requires Node.js >= 20 (see README > Requirements)

## Code conventions
- Main language: TypeScript (strict mode)
- No comments in code unless necessary or explicitly requested
- Use Thai+English technical terms in communication (e.g. build, debug, plugin)
- Every MCP tool must degrade gracefully and cap its output (< 10 ms per call target)

## Adding a new tool
1. Register in `src/index.ts` (register tool + handler)
2. Add tests under `test/` (aim for `npm test` to pass 70+ assertions)
3. Update README (Tools section) and `design.md` if needed
4. Add it to the Smart Distill rule if relevant

## Pull request workflow
- Branch off `master` (e.g. `feat/...`, `fix/...`), or fork and open a PR
- Ensure `npm test` and `npm run build` pass before opening a PR
- Use conventional commits (e.g. `feat:`, `fix:`, `docs:`, `chore:`)
- CI (Node 20.x / 22.x) must pass

## License
- This project is MIT licensed, copyright holder `worakorn-prince`
- By opening a PR you agree your contribution is released under the MIT License.
