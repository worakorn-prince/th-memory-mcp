# Publishing th-memory-mcp

Example of how to prepare and publish th-memory-mcp to npm and register it as an OpenCode plugin.

> Note: not actually published yet — this file only demonstrates the steps.

## 1. Prepare package.json
These fields are already set in `package.json`:
```json
{
  "bin": { "th-memory-mcp": "dist/index.js" },
  "files": ["dist", "README.md", "LICENSE", "ARCHITECTURE_v2.md", "opencode.example.json", "AGENTS.memory.example.md"],
  "engines": { "node": ">=20" }
}
```
- `bin` lets users run `npx th-memory-mcp` without cloning
- `files` limits what is published (excludes `test/`, `node_modules/`, and the local-only Thai docs)
- `engines` requires Node >= 20

## 2. Publish to npm
```bash
npm login
npm version patch      # or minor / major as appropriate
npm publish --access public
```
After publishing, users can install with:
```bash
npm install -g th-memory-mcp
# or run immediately
npx th-memory-mcp
```

## 3. Register as an OpenCode plugin
OpenCode loads plugins from a path or git repo — there is no central plugin registry:

- **Method A (local):** point `plugins` in `opencode.json` to the file `plugins/learning-capture.ts`
- **Method B (git):** fork/clone the repo and point to the folder
- **Method C (url):** reference via a git URL in `opencode.json`

Example `opencode.json`:
```json
{
  "plugins": ["/absolute/path/to/th-memory-mcp/plugins/learning-capture.ts"]
}
```

## Pre-publish checklist
- [ ] `npm test` passes (70/70)
- [ ] `npm run build` succeeds
- [ ] LICENSE is correct (MIT, copyright `worakorn-prince`)
- [ ] `README.md` version and install instructions are updated
- [ ] Create a Git tag matching the version (e.g. `v1.2.0`) and a GitHub Release
