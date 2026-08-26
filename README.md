# memory-mcp

Long-term memory MCP server for OpenCode — stores preferences, lessons, and usage history in a single local SQLite file (100% local, no external API) so the AI can "remember and adapt" to the user through context-based learning.

**Status:** v1.1.0 — all 4 phases implemented, tests passing 70/70 assertions (smoke 53 + capture 8 + distill 9)

> ไทย / Thai: [README.th.md](README.th.md)

## Architecture

```
OpenCode ──┬─ Plugin learning-capture (Bun)  ── auto-captures prompts/tool/error into DB
            │                                   └─ injects profile back into context on compaction
            └─ MCP memory-mcp (Node.js stdio)  ── 9 tools read/write the same SQLite DB
                                                      ▲
                               Global instructions (memory-protocol.md) teach the AI to use the tools
```

See [design.md](design.md) for full details.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | compile TypeScript → `dist/` |
| `npm start` | run the MCP server (stdio) from `dist/index.js` |
| `npm run distill` | rule-based distill: interactions → profile sections + prune old data (env `RETENTION_DAYS` default 30) |
| `npm test` | end-to-end smoke test over JSON-RPC (`node test/smoke.mjs`) |
| `node test/capture.test.mjs` | test capture-core (filter secrets, dedupe, truncate, insert SQL) |
| `node test/distill.test.mjs` | test distill-core (Thai tokenize, stats, profile sections, prune) |

## Tools (9)

| Tool | Description |
|------|-------------|
| `remember` | upsert preference (category+key) — re-saving the same key increases confidence by 0.1 (cap 1.0) |
| `recall` | search preferences + lessons (FTS5) + recent matching interactions. Use before starting a new task |
| `get_profile` | user profile overview: profile sections + top preferences + 5 most recent lessons |
| `save_lesson` | record a lesson learned from a correction (situation / mistake / correction) |
| `search_history` | search past user prompts by keyword (200-char snippets per row) |
| `forget` | delete one memory row (preference/lesson/interaction) by id (+type prevents cross-table id clash) |
| `memory_stats` | memory statistics: counts by kind, DB size, oldest/newest interaction, profile sections |
| `get_recent_interactions` | list recent raw interactions (filter by kind) — feedstock for Smart Distill |
| `export_memory` | export memory to JSON under `data/exports/` only (filename auto-sanitized) |

## Install with OpenCode

1. Merge the `mcp` section from [`opencode.example.json`](opencode.example.json) into your `opencode.json` (global or project-level)
   - **Important:** set `MEMORY_DB_PATH` to the SAME database file for both the server and the plugin (the example uses `<ABSOLUTE_PATH>/memory-mcp/data/memory.db`), otherwise the auto-capture plugin writes to a different DB than the one the AI reads
   - How to set it (pick one):
     - define it in the mcp `environment` (see example) — covers the MCP server only
     - **or** set it as a system/user-level environment variable (e.g. `setx MEMORY_DB_PATH "D:/path/to/memory.db"` on Windows) — covers both server and plugin, since the plugin runs in the same process as OpenCode
2. Attach the global memory rules — add to `opencode.json`:
   ```json
   "instructions": ["C:/Users/<user>/.config/opencode/memory-protocol.md"]
   ```
   (example rule content is in [`AGENTS.memory.example.md`](AGENTS.memory.example.md) — can be attached at project level instead)
3. (Optional) Deploy the auto-capture plugin: copy `src/plugin/learning-capture.ts` → `~/.config/opencode/plugins/learning-capture.ts`
4. **Restart OpenCode** (config loads at startup only)
5. Test: *"Remember that I prefer pnpm"* → open a new session and ask back

## Daily usage

The AI accepts both Thai and English interchangeably — you can switch languages at any time without warning.

| Thai | English | Effect |
|------|---------|--------|
| "จำไว้ว่า..." | "Remember that..." | `remember` — save a preference |
| "สรุปความจำ" / "distill memory" | "Summarize memory" / "distill memory" | **Smart Distill** — AI reads `get_recent_interactions`, finds patterns, and saves insights itself |
| "ระบบความจำเป็นไงบ้าง" | "How is my memory?" / "memory status" | `memory_stats` |
| "สำรองความจำ" | "Export memory" / "backup memory" | `export_memory` |
| "ค้นประวัติ..." | "Search history..." | `search_history` |
| "ลืม..." | "Forget..." | `forget` |

Long-term care: run `npm run distill` occasionally to summarize stats and prune interactions older than 30 days.

## data/ structure

```
data/
├── memory.db          # SQLite (WAL mode) — main DB (+ .db-wal, .db-shm)
└── exports/           # JSON files from export_memory (writeable only in this dir)
```

- DB path can be overridden via the `MEMORY_DB_PATH` env var
- everything in `data/` is git-ignored
