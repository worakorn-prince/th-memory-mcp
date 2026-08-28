# th-memory-mcp on Cursor

Cursor loads MCP servers from a project file and applies **Rules** (not hooks),
so the **9 memory tools work** but background auto-capture (OpenCode plugin /
Claude hooks) is not available. The AI uses the tools per the memory-protocol
rules you attach.

## 1. Build

```bash
cd <repo>
npm install
npm run build
```

## 2. Register the MCP server

Create `.cursor/mcp.json` in your project (or `~/.cursor/mcp.json` globally):

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["<ABSOLUTE_REPO>/dist/index.js"],
      "env": { "MEMORY_DB_PATH": "<ABSOLUTE_REPO>/data/memory.db" }
    }
  }
}
```

Use the **same** `MEMORY_DB_PATH` across harnesses so memory is shared.

## 3. Attach the memory protocol as a Rule

Create `.cursor/rules/memory.mdc`:

```markdown
---
description: Use the th-memory-mcp memory tools to remember and recall the user across sessions
alwaysApply: true
---

You have a local long-term memory MCP server called `memory` with 9 tools
(`remember`, `recall`, `get_profile`, `save_lesson`, `search_history`,
`forget`, `memory_stats`, `get_recent_interactions`, `export_memory`).

Rules:
- Before starting a non-trivial task, call `recall` to pull relevant preferences/lessons.
- When the user states a durable preference or corrects your work, call
  `remember` / `save_lesson`. Never store secrets (api_key, password, token).
```

## 4. Restart Cursor and test

Open the chat and say *"Remember that I prefer pnpm"* → new session →
*"What package manager do I prefer?"*

## Feature parity

| Feature | OpenCode | Claude Code | Cursor |
|---|---|---|---|
| 9 MCP tools | ✅ | ✅ | ✅ |
| Auto-capture (background) | ✅ plugin | ✅ hooks | ❌ manual (Rules) |
| Profile injection | ✅ compaction | ✅ UserPromptSubmit | ❌ (call `get_profile`) |

The SQLite DB is identical, so memory captured on OpenCode/Claude Code is
readable in Cursor.
