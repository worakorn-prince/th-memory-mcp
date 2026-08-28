# Design: Adaptive Memory MCP — behavior-learning memory system for OpenCode

> Project: D:\Coding_Project\mcp
> Date: 2026-08-26 (rev.3 — as-built updated after all phases implemented)
> Status: **implementation complete** — server v1.1.0, 9 tools, tests passing 70/70 assertions

## 1. Overview

A system that lets OpenCode "remember and adapt" to the user, composed of 3 parts:

1. **MCP Server (th-memory-mcp v1.1.0)** — stores/retrieves preferences, lessons, and usage history in SQLite, exposing 9 tools the AI can call
2. **OpenCode Plugin (learning-capture)** — hooks events to auto-capture prompts/tool usage and injects the profile back into context on compaction
3. **Global Instructions (memory-protocol.md)** — the Memory Protocol rules, attached to every agent/session via `"instructions"` in the global opencode.json

### Important constraints
LLM APIs are **not trained on our data** — the only real "learning" possible is **context-based learning**:
- capture behavior → distill into preferences/lessons
- recall into context at the start of a new session (AI calls `recall` / plugin injects)
This is the same mechanism behind the memory features of leading AI products.

## 2. Architecture

```
┌────────────────────────────────────────────┐
│                  OpenCode                  │
│                                            │
│  ┌──────────────────┐   ┌───────────────┐  │
│  │ learning-capture │   │   AI Agent    │  │
│  │ Plugin (Bun)     │   │               │  │
│  │ - message.updated│   │  calls MCP    │  │
│  │ - tool.execute.* │   │  tools        │  │
│  │ - compacting*    │   │               │  │
│  └────────┬─────────┘   └──────┬────────┘  │
└───────────┼─────────────────────┼──────────┘
             │ write (bun:sqlite)  │ read/write (stdio JSON-RPC)
             ▼                     ▼
    ┌─────────────────────────────────────┐
    │   th-memory-mcp v1.1.0 (Node+SDK)   │
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

(*) compaction hook = `experimental.session.compacting` used in Phase 3

### Learning loop
1. **Capture** — plugin auto-writes prompts/tool usage to `interactions`; AI also saves preferences/lessons via tools
2. **Distill** — summarize raw logs into profile: rule-based via `npm run distill` (Thai tokenization with Intl.Segmenter + prune older than 30 days) and AI-assisted via the Smart Distill workflow in the protocol
3. **Recall** — new session: AI calls `get_profile` + `recall(topic)` per the Memory Protocol (global instructions)
4. **Inject** — plugin auto-injects the profile on session compaction (`experimental.session.compacting`)

## 3. Data Model (SQLite)

DB file: `data/memory.db` (path overridable via `MEMORY_DB_PATH`)
WAL mode + busy_timeout=5000 on every connection

```sql
-- raw behavior (plugin writes)
CREATE TABLE interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,                -- ISO datetime
  session_id TEXT,
  kind TEXT NOT NULL,              -- 'prompt' | 'tool_call' | 'error'
  content TEXT NOT NULL,           -- text (truncated per rules)
  meta TEXT                        -- JSON extra, e.g. tool name, project dir
);

-- user preferences/requirements (AI/plugin writes)
CREATE TABLE preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,          -- work_style | coding_pref | language | domain | other
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence REAL DEFAULT 0.5,     -- 0..1, +0.1 per repeated confirmation
  source TEXT DEFAULT 'explicit',  -- explicit | corrected | inferred
  updated_at TEXT NOT NULL,
  UNIQUE(category, key)
);

-- lessons from corrections
CREATE TABLE lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  situation TEXT NOT NULL,         -- original situation
  mistake TEXT NOT NULL,           -- what was done wrong
  correction TEXT NOT NULL,        -- correct approach
  created_at TEXT NOT NULL
);

-- distilled profile
CREATE TABLE profile (
  section TEXT PRIMARY KEY,        -- identity | goals | style | notes
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- virtual table for search
CREATE VIRTUAL TABLE search_index USING fts5(
  ref_table, ref_id, title, body
);
```

## 4. MCP Tools spec

Server name: `th-memory-mcp`, version **1.1.0**, transport stdio
Every tool returns `{ content: [{ type: "text", text }] }`; errors must be caught and returned as a message (never crash)

| Tool | Args (zod) | Behavior |
|------|-----------|----------|
| `remember` | `category` enum, `key`: string, `value`: string | upsert preferences; same key → confidence += 0.1 (cap 1.0), update value+updated_at |
| `recall` | `topic`: string, `limit`?: number (default 8) | FTS5 search search_index (preferences+lessons) + latest 20 matching interactions; grouped text, ≤ ~2000 chars |
| `get_profile` | (none) | profile sections + top preferences (confidence desc, limit 15) + latest 5 lessons |
| `save_lesson` | `situation`, `mistake`, `correction`: string | insert lessons + update search_index |
| `search_history` | `query`: string, `limit`?: number (default 10) | FTS5 in interactions (kind='prompt'), 200-char snippets per row |
| `forget` | `target_id`: number, `type`? enum("preference","lesson","interaction") | delete from table by id (+type prevents cross-table id clash) + sync search_index |
| `memory_stats` | (none) | counts by kind + DB size + oldest/newest interaction + profile sections; ≤1500 chars |
| `get_recent_interactions` | `limit`? (default 20, max 100), `kind`? enum("prompt","tool_call","error") | latest rows formatted `[id] ts [kind] content(300)`; ≤4000 chars |
| `export_memory` | `includeInteractions`? bool (default false), `filename`? string | write JSON only under `data/exports/` (sanitize filename `[A-Za-z0-9._-]`, no `..`); return path+size+preview ≤500 chars |

## 5. Plugin spec (learning-capture)

File: `src/plugin/learning-capture.ts` → deploy to `~/.config/opencode/plugins/learning-capture.ts`
Runtime: Bun (OpenCode plugins run on Bun) → uses `bun:sqlite` on the same DB (WAL supports multi-process)

```ts
// as-built: self-contained single file — logic inline, synced with src/lib/capture-core.ts
// (declares minimal types itself; does not import @opencode-ai/plugin to avoid module resolution issues)
import { Database } from "bun:sqlite"

export const LearningCapture = async (ctx) => {
  const db = new Database(process.env.MEMORY_DB_PATH ?? "D:/Coding_Project/mcp/data/memory.db")
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")
  // CREATE TABLE IF NOT EXISTS interactions (...) in case DB was never created
  const dedupe = createDedupe()
  return {
    event: async ({ event }) => {
      // message.updated (role=user) → insert kind='prompt' (truncate 4000, dedupe by message id)
      // session.error → insert kind='error'
    },
    "tool.execute.after": async (input, output) => {
      // insert kind='tool_call' (dedupe by callID, truncate 500)
    },
    "experimental.session.compacting": async (input, output) => {
      // buildProfileText(db): profile sections + top preferences (confidence desc, 15)
      //   + latest 5 lessons → ≤3000 chars → output.context.push(txt)
      // wrap everything in try/catch silently — failed injection does no harm
    },
  }
}
```

Capture rules:
- Dedupe by message id (prevent duplicate events) — keep a Set of recorded ids in process memory
- Never store secrets: filter lines matching `/(api[_-]?key|secret|token|password)\s*[=:]/i` before saving
- Every write must try/catch — the plugin must never crash OpenCode

## 6. Making the AI use memory (Memory Protocol)

Installed at 2 levels:

1. **Global (in use)** — `~/.config/opencode/memory-protocol.md` attached via `"instructions"` in global opencode.json → covers **every agent, every session** without switching agents
2. **Project-level (alternative)** — copy from `AGENTS.memory.example.md` into a project's AGENTS.md

Protocol essentials:
- call `get_profile` + `recall` before a new/complex task
- `save_lesson` immediately when the user corrects you / `remember` immediately when the user states a preference / never guess — if recall finds nothing, ask
- `search_history` when suspecting a prior conversation / `forget` after confirming with the user
- call memory tools only when necessary (not every message) / never store secrets / if memory is offline, continue gracefully

**Smart Distill**: when the user asks "summarize memory" → `get_recent_interactions(limit=50)` → analyze real patterns → save insights via `remember`/`save_lesson` → summarize to the user with the list of new items

## 7. File structure

```
D:\Coding_Project\mcp\
├── design.md                   # this document (rev.3 as-built)
├── README.md                   # usage guide + scripts + tools
├── package.json                # type: module, scripts: build/start/distill/test
├── tsconfig.json               # NodeNext, ES2022, strict; exclude src/plugin + test
├── .gitignore                  # node_modules, dist, data/
├── data\                       # memory.db (+wal/shm) and exports\ (git ignored)
├── src\
│   ├── index.ts                # McpServer v1.1.0 + registerTool ×9 + StdioServerTransport
│   ├── db.ts                   # schema init, WAL, helper query, FTS sync
│   ├── lib\
│   │   ├── capture-core.ts     # pure logic: filterSecrets/truncate/dedupe/buildRow/INSERT_SQL
│   │   └── distill-core.ts     # pure logic: tokenize(Thai)/computeStats/formatProfileSections
│   ├── distill.ts              # CLI: runDistill(db) + prune (RETENTION_DAYS default 30)
│   ├── tools\
│   │   ├── remember.ts recall.ts profile.ts lesson.ts history.ts forget.ts
│   │   ├── memory_stats.ts recent_interactions.ts export_memory.ts
│   └── plugin\
│       └── learning-capture.ts # self-contained Bun plugin → deploy copy to ~/.config/opencode/plugins/
├── test\
│   ├── smoke.mjs               # 53 checks end-to-end JSON-RPC (spawns real server)
│   ├── capture.test.mjs        # 8 checks (capture-core + SQL insert)
│   └── distill.test.mjs        # 9 checks (tokenize/stats/runDistill/prune/idempotent)
├── AGENTS.memory.example.md    # Memory Protocol + Smart Distill (project-level)
└── opencode.example.json       # example mcp config
```

## 8. Technology

| Part | Choice | Reason |
|------|---------|--------|
| MCP Server | Node.js ≥ 20 + TypeScript + `@modelcontextprotocol/sdk@1.30.0` + zod | official standard |
| DB (server) | `better-sqlite3@12.x` + FTS5 | fast sync API, easy, prebuilt binary (no compile) |
| DB (plugin) | `bun:sqlite` (built-in) | plugin runs on Bun, no native module install |
| Thai tokenization | `Intl.Segmenter("th", { granularity: "word" })` + whitespace fallback | segment Thai (no spaces) built into Node |

> as-built note: the plugin is **self-contained** (declares minimal types in-file), so `@opencode-ai/plugin` is not required

## 9. Sub-tasks

### Phase 1 — MVP: MCP Server ✅ 2026-08-25
1. Init project: `"type": "module"`, deps: `@modelcontextprotocol/sdk`, `zod`, `better-sqlite3`; devDeps: `typescript`, `@types/node`, `@types/better-sqlite3`, `@opencode-ai/plugin`
2. `src/db.ts`: schema per §3, WAL, busy_timeout, helper + FTS sync
3. First 6 tools per §4 spec (separate files in `src/tools/` — later expanded to 9 in Phase 4)
4. `src/index.ts`: McpServer("th-memory-mcp") + register + StdioServerTransport (**no console.log — stderr only**)
5. Build + smoke test with MCP Inspector (`npx @modelcontextprotocol/inspector node dist/index.js`) — remember → recall → forget
6. Create `opencode.example.json`:

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

7. Create `AGENTS.memory.example.md` per §6
8. Guide user: merge config → restart OpenCode → test "remember I prefer pnpm" then ask back in a new session

### Phase 2 — Plugin auto-capture ✅ 2026-08-26
9. `src/plugin/learning-capture.ts` per §5 (dedupe + secret filter + try/catch everywhere)
10. Copy to `~/.config/opencode/plugins/learning-capture.ts` → restart OpenCode → use a while → verify `interactions` has data (`search_history` finds old prompts)

### Phase 3 — Inject + Distill ✅ 2026-08-26
11. Add hook `"experimental.session.compacting"` to plugin: `output.context.push(profile text)` from get_profile logic
12. Distill script: rule-based summarize interactions → profile sections (`npm run distill`, Thai tokenize via Intl.Segmenter) + prune older than RETENTION_DAYS

### Phase 4 — Insight & Safety ✅ 2026-08-26
13. 3 new tools: `memory_stats` / `get_recent_interactions` / `export_memory` (sanitize filename + write only under data/exports/) — server bump v1.1.0
14. Smart Distill workflow added to memory-protocol.md (global) + AGENTS.memory.example.md + README.md

> as-built note: global instructions (`memory-protocol.md` via `"instructions"` in opencode.json) replace a dedicated agent — covers every agent without switching; smoke test expanded to 53 checks including security cases (unsafe filename rejected)

## 10. Risks and mitigation

| Risk | Impact | Mitigation |
|------|--------|-----------|
| Context bloat from long recall | token waste | cap 2000 chars/tool call, default limit |
| Wrong/stale memory | AI goes wrong | confidence + updated_at + tool forget + user review |
| SQLite accessed by 2 processes (Bun+Node) | lock error | WAL mode + busy_timeout=5000 |
| `message.updated` fires often | DB bloat/duplicate | dedupe by message id + truncate |
| Secret leaks to DB | security | regex filter before every write |
| stdout mixed with logs | protocol breaks | stderr only in server code |
| Invalid config | OpenCode won't start | add `$schema` validated against https://opencode.ai/config.json |

## 11. Dependencies

- Node.js ≥ 20, npm
- OpenCode supporting plugins + MCP (current version)
- No external service/API — 100% local (privacy by design)

## 12. Performance Budget (acceptance criteria)

Building Agent must implement within this budget:

| Item | Budget | Check |
|------|--------|-------|
| Query latency per tool call | < 100 ms (local SQLite) | time in smoke test |
| Max output per tool | `recall` ≤ 2000 chars, `search_history` ≤ 200 chars/row, `get_profile` ≤ 3000 chars | assert in code (always truncate) |
| Default limit | recall=8, search_history=10 rows | default in zod schema |
| Plugin write per event | < 5 ms, fire-and-forget (no event-loop block) | code review |
| Server startup | < 2 s to ready for initialize | time it |

**Measured (2026-08-26):** latency per tool call **1–9 ms**, startup **792–997 ms**, every tool within budget, tests **70/70** (smoke 53 + capture 8 + distill 9)

### Overhead prevention
- Memory Protocol calls memory **only on new/complex tasks**, never every message
- Graceful degradation: if DB/server errors, return a short error message and let the AI continue immediately; no tight retry until timeout
- Never auto-inject profile every turn — inject only on compaction (Phase 3)

### Long-term risks to monitor
- Memory quality decay (self-contradiction) → use confidence + updated_at + forget + distill (Phase 3)
- DB growth → FTS5 index supports it; plan periodic VACUUM/optimize

## 13. Next phases (Optional / Future)

- Semantic search with embeddings (local model or API) instead of FTS5
- Usage statistics dashboard (small web app reading the DB)
- Multi-project memory scoping (by directory/worktree)
- Import memory from export file (export side done in Phase 4)
- Automatic LLM-assisted distill via OpenCode SDK (instead of user-triggered command)
