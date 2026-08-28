# th-memory-mcp on Codex CLI

Codex CLI speaks MCP, so the **9 memory tools work**, but it has **no
Claude-Code-style Hooks runtime** — background auto-capture (the OpenCode plugin
/ Claude hooks) is not available. The AI still uses the tools via the
`memory-protocol` instructions; it just captures manually rather than
automatically.

## 1. Build

```bash
cd <repo>
npm install
npm run build
```

## 2. Register the MCP server

In `~/.codex/config.toml` (or your project's `codex.toml`):

```toml
[mcp_servers.memory]
command = "node"
args = ["<ABSOLUTE_REPO>/dist/index.js"]
env = { MEMORY_DB_PATH = "<ABSOLUTE_REPO>/data/memory.db" }
```

(Codex also accepts `claude mcp add` style registration in some builds; the
TOML form above is the portable one. Use the **same** `MEMORY_DB_PATH` the
server and any other harness share.)

## 3. Attach the memory protocol

Paste `AGENTS.memory.example.md` (or `memory-protocol.md`) into Codex's
instructions so the model knows when to call the tools:

```toml
# in codex.toml / config.toml
instructions = ["<ABSOLUTE_REPO>/AGENTS.memory.example.md"]
```

## 4. Restart Codex and test

```
Remember that I prefer pnpm
```
→ new session → `What package manager do I prefer?`

## Feature parity vs OpenCode

| Feature | OpenCode | Claude Code | Codex |
|---|---|---|---|
| 9 MCP tools | ✅ | ✅ | ✅ |
| Auto-capture (background) | ✅ plugin | ✅ hooks | ❌ manual |
| Profile injection | ✅ compaction | ✅ UserPromptSubmit | ❌ (call `get_profile`) |

To get auto-capture on Codex too, drive the tools from a wrapper or wait for
Codex hook support. The underlying SQLite DB is identical, so memory captured
on OpenCode/Claude Code is readable here.
