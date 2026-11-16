# th-memory-mcp on Claude Code

Use th-memory-mcp's full feature set (auto-capture + profile injection) on
**Claude Code** via Hooks. Claude Code has no OpenCode-style plugin runtime, but
its Hooks system (31 events) lets us replicate the `learning-capture` plugin by
writing into the **same SQLite DB** the MCP server reads/writes.

What you get, equivalent to OpenCode:

| OpenCode plugin behavior | Claude Code equivalent |
|---|---|
| capture `prompt` on `message.updated` | `UserPromptSubmit` hook |
| capture `tool_call` on `tool.execute.after` | `PostToolUse` hook |
| capture `error` on `session.error` | `PostToolUse` error detection (best-effort) |
| inject profile on `experimental.session.compacting` | `additionalContext` on `UserPromptSubmit` |

## 1. Build & install the MCP server

```bash
cd <repo>
npm install
npm run build
```

> The MCP server requires `npm run build`. Plaintext hook capture does not:
> it only needs the installed dependencies. Encrypted hook capture
> (`MEMORY_ENCRYPTION=on`) reuses the compiled server modules in `dist/`, so
> run `npm run build` before using that mode.

Add the MCP server (points at the built binary — same on every harness):

```bash
claude mcp add memory --env MEMORY_DB_PATH="$PWD/data/memory.db" -- node "$PWD/dist/index.js"
```

Or in `~/.claude/settings.json`:
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

## 2. Register the hooks

Append to `~/.claude/settings.json` (merge with the `mcpServers` block above):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          { "type": "command", "command": "node <ABSOLUTE_REPO>/scripts/claude-capture.mjs" }
        ]
      }
    ],
    "PostToolUse": [
      {
        "hooks": [
          { "type": "command", "command": "node <ABSOLUTE_REPO>/scripts/claude-capture.mjs" }
        ]
      }
    ]
  }
}
```

> Replace `<ABSOLUTE_REPO>` with the absolute clone path. The hook reads its
> event JSON from stdin and writes to `MEMORY_DB_PATH` (falls back to the repo's
> `data/memory.db`). Use the **same** `MEMORY_DB_PATH` as the MCP server so
> capture and recall share one database.

## 3. Attach the memory protocol

Copy `AGENTS.memory.example.md` (or `memory-protocol.md`) into Claude Code's
memory so the AI knows when to call the tools:

```bash
cp AGENTS.memory.example.md ~/.claude/AGENTS.memory.md
```

(or paste its contents into your `CLAUDE.md`).

## 4. Restart Claude Code and test

```
Remember that I prefer pnpm
```
→ open a new session → `What package manager do I prefer?`

The auto-capture hooks will have stored your prompt + tool activity in
`data/memory.db` without you calling any tool manually.

## How it works

`scripts/claude-capture.mjs` mirrors `src/lib/capture-core.ts`:

- secret lines (`api_key=`, `password:`, `token`, `secret`) are filtered
- content is truncated (`prompt` 4000 / `tool_call` 500 chars)
- a 3-second same-content dedupe avoids double inserts from hook re-fires
- opens the DB with `WAL` + `busy_timeout=5000` so it coexists with the MCP server
- uses the `better-sqlite3-multiple-ciphers` driver installed by `npm install`
- supports encrypted databases with the same key providers and KDF settings as the MCP server
- **never blocks** Claude Code — every error is logged and it exits 0

## Notes / limits vs OpenCode

- **Session errors**: Claude Code has no dedicated error event; tool failures are
  captured via `PostToolUse` when the response looks like an error. True
  `session.error` events (as on OpenCode) are not surfaced.
- **Injection timing**: OpenCode injects on compaction; Claude Code injects on
  every `UserPromptSubmit` via `additionalContext`. This is slightly more eager
  but functionally equivalent for keeping memory in context.
- The `better-sqlite3-multiple-ciphers` native binary must be present (it is, after `npm install`).
- Plaintext hook capture does not require `npm run build`. When `MEMORY_ENCRYPTION=on`, the hook dynamically loads the server's compiled encryption helpers from `dist/`, so that mode requires `npm run build`.
- If `MEMORY_ENCRYPTION=on`, the hook must receive the same key as the MCP server. Providers are tried in the same order: `MEMORY_ENCRYPTION_KEY`, then `MEMORY_ENCRYPTION_KEY_FILE`, then `MEMORY_ENCRYPTION_KEY_CMD`. `MEMORY_ENCRYPTION_KDF_ITER` is also shared (default `256000`).
- The hook never falls back to plaintext and never runs the plaintext-to-encrypted migration. If the key is missing or wrong, or the database is still plaintext, the hook disables itself, writes the error to `hook-errors.log` beside `MEMORY_DB_PATH` (`data/hook-errors.log` with the default path), emits valid JSON, and exits 0.
