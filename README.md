# th-memory-mcp

Long-term memory MCP server for OpenCode — stores preferences, lessons, and usage history in a single local SQLite file (100% local, no external API) so the AI can "remember and adapt" to the user through context-based learning.

**Status:** v1.1.0 — all 4 phases implemented, tests passing 70/70 assertions (smoke 53 + capture 8 + distill 9)

## Requirements

- **Node.js >= 20** — the server uses Node-only APIs (the `better-sqlite3` native build and `import.meta.url` resolution) and the MCP SDK requires a modern runtime. CI tests on Node 20.x and 22.x.
- **npm** — to install dependencies and run the build/test scripts (`npm install`, `npm run build`, `npm test`).
- **OpenCode** — the host that loads this MCP server and the auto-capture plugin. Any build supporting MCP over stdio + plugins works; the plugin runs on OpenCode's bundled Bun runtime.
- **OS: Windows / macOS / Linux** — the server is cross-platform (Node). The auto-capture plugin runs wherever OpenCode's Bun runtime runs. Windows note: `MEMORY_DB_PATH` is easiest to set with `setx`; on macOS/Linux use `export` in your shell profile.

No external services, accounts, or API keys are required — everything lives in a single local SQLite file.

## Quick Start

**Fastest path:** after cloning, run `npm run quickstart` — it builds, wires `opencode.json`, deploys the plugin, and sets `MEMORY_DB_PATH` for you in one command. The steps below show exactly what it does (use them if you prefer manual control).

```bash
# 1. Clone and build
git clone https://github.com/worakorn-prince/th-memory-mcp.git
cd th-memory-mcp
npm install
npm run build

# 2. Share one DB between the server and the plugin
#    Windows (PowerShell):
setx MEMORY_DB_PATH "$PWD/data/memory.db"
#    macOS / Linux (add to your shell profile, e.g. ~/.zshrc):
# export MEMORY_DB_PATH="$PWD/data/memory.db"
```

3. Merge this into your `~/.config/opencode/opencode.json` (replace `<REPO>` with the absolute clone path):

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

4. (Optional) Auto-capture: copy `src/plugin/learning-capture.ts` → `~/.config/opencode/plugins/`
5. **Restart OpenCode**
6. Try it: *"Remember that I prefer pnpm"* → new session → *"What package manager do I prefer?"*

## Architecture

```
OpenCode ──┬─ Plugin learning-capture (Bun)  ── auto-captures prompts/tool/error into DB
            │                                   └─ injects profile back into context on compaction
            └─ MCP th-memory-mcp (Node.js stdio)  ── 9 tools read/write the same SQLite DB
                                                      ▲
                               Global instructions (memory-protocol.md) teach the AI to use the tools
```

See [design.md](design.md) for full details.

## Why th-memory-mcp?

LLMs don't remember you between sessions — every new chat starts blank. th-memory-mcp gives your AI a private, local long-term memory:

- **Context-based learning, not fine-tuning** — it captures your preferences, corrections, and habits, then recalls them into context next time. Same mechanism as the memory features of leading AI products, without sending any data off your machine.
- **100% local & private** — a single SQLite file, no cloud, no external API. Secrets are filtered before anything is stored.
- **Low overhead** — each tool call is capped (latency < 10 ms, bounded output size) and the AI only queries memory when it's actually useful, so it never bloats your context.
- **Resilient** — every tool degrades gracefully; if the DB is unavailable the AI keeps working instead of crashing.
- **Open & extensible** — MIT licensed, 9 documented tools, a rule-based distill, and an auto-capture plugin you can adapt.

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
   - **Important:** set `MEMORY_DB_PATH` to the SAME database file for both the server and the plugin (the example uses `<ABSOLUTE_PATH>/th-memory-mcp/data/memory.db`), otherwise the auto-capture plugin writes to a different DB than the one the AI reads
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

| Example command | Tool / effect |
|-----------------|---------------|
| "Remember that..." | `remember` — save a preference |
| "Summarize memory" / "distill memory" | **Smart Distill** — AI reads `get_recent_interactions`, finds patterns, and saves insights itself |
| "How is my memory?" / "memory status" | `memory_stats` |
| "Export memory" / "backup memory" | `export_memory` |
| "Search history..." | `search_history` |
| "Forget..." | `forget` |

Long-term care: run `npm run distill` occasionally to summarize stats and prune interactions older than 30 days.

## data/ structure

```
data/
├── memory.db          # SQLite (WAL mode) — main DB (+ .db-wal, .db-shm)
└── exports/           # JSON files from export_memory (writeable only in this dir)
```

- DB path can be overridden via the `MEMORY_DB_PATH` env var
- everything in `data/` is git-ignored
