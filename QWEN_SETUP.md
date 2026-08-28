# th-memory-mcp on Qwen Code

Qwen Code (Alibaba's CLI, a fork of Gemini CLI) speaks MCP over stdio, so the
**9 memory tools work**. Its hook system uses the **Gemini-CLI schema**, which
differs from Claude Code's (different event names + I/O), so the Claude hooks
bridge (`scripts/claude-capture.mjs`) is **not** a drop-in — see Hooks below.

## 1. Build

```bash
cd <repo>
npm install
npm run build
```

## 2. Register the MCP server

Qwen Code ships a `qwen mcp` command similar to Claude Code:

```bash
qwen mcp add memory --env MEMORY_DB_PATH="$PWD/data/memory.db" -- node "$PWD/dist/index.js"
```

Or edit `~/.qwen/settings.json` (user scope) / `.qwen/settings.json` (project):

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

## 3. Attach the memory protocol

Point Qwen Code's system instructions at the memory rules
(`AGENTS.memory.example.md` / `memory-protocol.md`) so the model knows when to
call the tools — e.g. add it to your Qwen Code `instruction` / project AGENTS
file, or copy its contents into `.qwen/settings.json`'s instruction field.

## 4. Restart Qwen Code and test

```
Remember that I prefer pnpm
```
→ new session → `What package manager do I prefer?`

## Hooks (auto-capture) — status

Qwen Code inherits Gemini CLI's hook model: hooks live under `hooks` in
`settings.json` and fire on events like `BeforeTool` / `AfterTool` plus lifecycle
events. The **I/O schema is not the same as Claude Code's** — event names and the
stdin/stdout JSON differ — so `scripts/claude-capture.mjs` cannot be reused as-is.

What works today:
- **9 MCP tools**: ✅ full
- **Tool-call auto-capture**: possible via an `AfterTool` hook, but needs a
  small Qwen/Gemini-style adapter script (different payload fields). Available on
  request — tell me your Qwen Code hook event names and I'll add
  `scripts/qwen-capture.mjs`.
- **Prompt auto-capture / profile injection**: no direct `UserPromptSubmit`
  equivalent in the Gemini-CLI schema, so capture-and-inject is manual (the AI
  calls `remember` / `get_profile` per the protocol).

Because the SQLite DB is identical, memory captured on OpenCode / Claude Code is
fully readable here.

## Feature parity

| Feature | OpenCode | Claude Code | Qwen Code |
|---|---|---|---|
| 9 MCP tools | ✅ | ✅ | ✅ |
| Auto-capture (background) | ✅ plugin | ✅ hooks | ⚠️ needs adapter (AfterTool) |
| Profile injection | ✅ compaction | ✅ UserPromptSubmit | ❌ manual (`get_profile`) |
| Local semantic search | ✅ | ✅ | ✅ |
