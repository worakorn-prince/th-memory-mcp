# th-memory-mcp

[![npm version](https://img.shields.io/npm/v/th-memory-mcp.svg)](https://www.npmjs.com/package/th-memory-mcp)
[![npm downloads](https://img.shields.io/npm/dm/th-memory-mcp.svg)](https://www.npmjs.com/package/th-memory-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![Listed on mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/worakorn-prince/th-memory-mcp)

[![th-memory-mcp MCP server](https://glama.ai/mcp/servers/worakorn-prince/th-memory-mcp/badges/card.svg)](https://glama.ai/mcp/servers/worakorn-prince/th-memory-mcp)


**Status:** v2.2.3 — a temporal, conflict-aware, hybrid-retrieval memory engine. 16 MCP tools, 25 passing test suites. Non-destructive schema migration from v1 (all v1 data preserved). New in v2.2: lifecycle states, temporal validity, conflict/dedup resolution with USER/SESSION/PROJECT/GLOBAL scope, hybrid FTS+vector retrieval (RRF), memory graph, `get_context` assembly, periodic consolidation, and `link_memory` / `merge_memory` / `update_memory` / `import_memory` / `extract_memories`. New in v2.2.3: scope-enforced retrieval, graph scope isolation, export/import round-trip, hardened import path (realpath), strict import validation, N+1 query elimination, cold/ablation benchmark, and `MEMORY_RETRIEVAL_MODE` switch.

## Requirements

- **Node.js >= 20** — the server uses Node-only APIs (the `better-sqlite3` native build and `import.meta.url` resolution) and the MCP SDK requires a modern runtime. CI tests on Node 20.x and 22.x.
- **npm** — to install dependencies and run the build/test scripts (`npm install`, `npm run build`, `npm test`).
- **OpenCode** — the host that loads this MCP server and the auto-capture plugin. Any build supporting MCP over stdio + plugins works; the plugin runs on OpenCode's bundled Bun runtime.
- **OS: Windows / macOS / Linux** — the server is cross-platform (Node). The auto-capture plugin runs wherever OpenCode's Bun runtime runs. Windows note: `MEMORY_DB_PATH` is easiest to set with `setx`; on macOS/Linux use `export` in your shell profile.

No external services, accounts, or API keys are required — everything lives in a single local SQLite file.

## Quick Start

**Fastest path:** after cloning, run `npm run quickstart` — it builds, wires `opencode.json`, deploys the plugin, and sets `MEMORY_DB_PATH` for you in one command. The steps below show exactly what it does (use them if you prefer manual control).

**Install via npm (alternative):** install the server globally with `npm install -g th-memory-mcp` (or run it on demand with `npx th-memory-mcp`), then point the `mcp` `command` in `opencode.json` to `th-memory-mcp` instead of the built `dist/index.js`. The auto-capture plugin still comes from this repo (copy `src/plugin/learning-capture.ts` as described in step 4 below).

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
             └─ MCP th-memory-mcp (Node.js stdio)  ── 16 tools read/write the same SQLite DB
                                                      ▲
                               Global instructions (memory-protocol.md) teach the AI to use the tools
```

See [ARCHITECTURE_v2.md](ARCHITECTURE_v2.md) for the full architecture spec.

## Why th-memory-mcp?

LLMs don't remember you between sessions — every new chat starts blank. th-memory-mcp gives your AI a private, local long-term memory:

- **Context-based learning, not fine-tuning** — it captures your preferences, corrections, and habits, then recalls them into context next time. Same mechanism as the memory features of leading AI products, without sending any data off your machine.
- **100% local & private** — a single SQLite file, no cloud, no external API. Secrets are filtered before anything is stored.
- **Low overhead** — each tool call is capped (latency < 10 ms, bounded output size) and the AI only queries memory when it's actually useful, so it never bloats your context.
- **Resilient** — every tool degrades gracefully; if the DB is unavailable the AI keeps working instead of crashing.
- **Open & extensible** — MIT licensed, 16 documented tools, a rule-based distill, and an auto-capture plugin you can adapt.

## Works with other harnesses

th-memory-mcp is a standard MCP server, so the 9 tools run anywhere MCP-over-stdio
is supported. Full **auto-capture** (background prompt/tool/error capture + profile
injection) needs a hook runtime — OpenCode has it built in; Claude Code gets it via
our hooks bridge; Codex and Cursor use the tools manually (no hook runtime yet).

| Feature | OpenCode | Claude Code | Qwen Code | Codex | Cursor |
|---|---|---|---|---|---|
| 16 MCP tools | ✅ | ✅ | ✅ | ✅ | ✅ |
| Auto-capture (background) | ✅ plugin | ✅ [hooks](CLAUDE_CODE_HOOKS.md) | ⚠️ adapter | ❌ manual | ❌ Rules |
| Profile injection | ✅ compaction | ✅ UserPromptSubmit | ❌ `get_profile` | ❌ `get_profile` | ❌ `get_profile` |
| Local semantic search | ✅ (v2.0) | ✅ (v2.0) | ✅ (v2.0) | ✅ (v2.0) | ✅ (v2.0) |

- **Claude Code:** see [CLAUDE_CODE_HOOKS.md](CLAUDE_CODE_HOOKS.md) — drop-in hooks replicate the OpenCode plugin (capture + profile injection on `UserPromptSubmit`/`PreCompact`, rule-based distill on `SessionEnd`).
- **Qwen Code:** see [QWEN_SETUP.md](QWEN_SETUP.md) — MCP works fully; hooks use the Gemini-CLI schema so auto-capture needs a small adapter.
- **Codex:** see [CODEX_SETUP.md](CODEX_SETUP.md)
- **Cursor:** see [CURSOR_SETUP.md](CURSOR_SETUP.md)

All harnesses share one SQLite file via `MEMORY_DB_PATH`, so memory captured
anywhere is readable everywhere.

## Highlights

- **Structured memory** — preferences with confidence scoring plus dedicated
  `lesson` records (situation → mistake → correction) for capturing corrections,
  not just flat facts.
- **Lifecycle & temporal** — every memory has a lifecycle state
  (active/stale/superseded/archived), confidence/importance/salience scoring,
  per-type decay, and validity intervals so the AI can reason about
  point-in-time truth and supersession chains.
- **Conflict-aware** — duplicate detection, contradiction detection, and
  update/supersession resolution preserve both sides of ambiguous evidence
  instead of silently overwriting.
- **Hybrid retrieval** — `get_context` blends FTS5 keyword search with a
  dependency-free local vector embedding (RRF fusion + scoring), then assembles
  a token-budgeted context with optional memory-graph expansion.
- **Consolidation** — periodic clustering of similar memories into derived
  memories with full provenance (`derived_from` links).
- **First-class Thai / i18n** — Thai-aware tokenization in distill; the AI
  accepts Thai and English interchangeably.
- **Private by default** — a single local SQLite file, no cloud, no API keys,
  with secret lines (`api_key=`, `password:`, `token`) filtered before storage.
- **Cross-harness** — runs on OpenCode, Claude Code, Codex, and Cursor sharing
  one DB; auto-capture + profile injection via OpenCode plugin or Claude hooks.
- **Lightweight & resilient** — Node + `better-sqlite3`, no extra native
  extensions; every tool degrades gracefully so the AI keeps working if the DB
  is unavailable.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | compile TypeScript → `dist/` |
| `npm start` | run the MCP server (stdio) from `dist/index.js` |
| `npm run distill` | rule-based distill: interactions → profile sections + prune old data (env `RETENTION_DAYS` default 30) |
| `npm test` | full suite: capture, distill, lifecycle, temporal, conflict, retrieval, graph, context, consolidation, benchmark, security, tools_v21, smoke, e2e_transport, retrieval_benchmark, recall_regression, scope, profile, entity_extraction, conflict_benchmark |
| `node test/capture.test.mjs` | test capture-core (filter secrets, dedupe, truncate, insert SQL) |
| `node test/distill.test.mjs` | test distill-core (Thai tokenize, stats, profile sections, prune) |
| `node test/lifecycle.test.mjs` | test lifecycle engine (states, decay, supersession) |
| `node test/temporal.test.mjs` | test temporal model (validity, historical retrieval) |
| `node test/conflict.test.mjs` | test conflict & dedup resolution |
| `node test/retrieval.test.mjs` | test hybrid FTS+vector+RRF retrieval |
| `node test/graph.test.mjs` | test memory graph (entities, relations, traversal) |
| `node test/context.test.mjs` | test context assembly + token budgeting |
| `node test/consolidation.test.mjs` | test clustering + derived memories |
| `node test/benchmark.test.mjs` | latency benchmark over 300 memories |
| `node test/security.test.mjs` | injection / safety checks |
| `node test/smoke.mjs` | end-to-end smoke test over JSON-RPC (16 tools) |

## Tools (16)

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
| `get_context` | assemble relevant memories for the current task via hybrid retrieval (+ optional graph expansion) with token budgeting |
| `consolidate` | cluster similar memories via embedding similarity; optionally create derived/consolidated memories linked via `derived_from` |
| `link_memory` | create a typed relationship between two memories in the graph (supports/contradicts/supersedes/derived_from/related_to/caused_by/depends_on) |
| `merge_memory` | merge a duplicate/near-duplicate into a canonical memory (source becomes superseded, provenance in `metadata.merged_from`) |
| `update_memory` | update mutable fields in place, or create a superseding memory when `content` changes (set `supersede=false` to edit in place) |
| `import_memory` | import memories from JSON (validates type, dedupes against existing, never overwrites blindly); dry-run by default, `apply=true` to insert |
| `extract_memories` | scan recent captured interactions for memory-intent phrases and propose memory candidates (deterministic, no LLM); dry-run by default, `apply=true` to create (source=captured) |

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

## License

[MIT](LICENSE) © 2026 worakorn-prince

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for the full text.
