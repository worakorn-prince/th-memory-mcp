# th-memory-mcp on DeepSeek Harness (dsh)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) is
DeepSeek AI's open-source agent harness built on an everything-is-a-plugin
(Cordis) architecture. It ships a first-class MCP client
(`@deepseek-ai/dsh-mcp-client`), so th-memory-mcp connects as an external MCP
server through a small `cordis.yml` patch — no dsh plugin to write.

dsh's own memory surface is session-scoped (session persistence, compaction,
`session-query` FTS over sessions); it intentionally delegates **cross-session
long-term memory** to a memory MCP server (its [third-party memory MCP guide]
matches this case). So dsh + th-memory-mcp are complementary, not redundant.

> **Preview caveat:** dsh is in developer preview with compatibility-breaking
> changes. The MCP bridge is a stable boundary — prefer it over a native Cordis
> plugin for now. As with Cursor/Codex, the OpenCode auto-capture plugin does
> **not** run on dsh; rely on explicit `remember`/`recall` calls (see below).

## 1. Build

```bash
cd <repo>
npm install
npm run build
```

## 2. Install the MCP server (optional)

Either globally — `npm install -g th-memory-mcp` — or run straight from the
repo with `node "<REPO>/dist/index.js"` (the example patch has both variants).

## 3. Apply the MCP bridge patch

Use the ready-made patch [`dsh/cordis.memory.example.yml`](dsh/cordis.memory.example.yml).

One-shot (doesn't persist):

```bash
dsh web --patch "$PWD/dsh/cordis.memory.example.yml"
```

To keep it across runs, merge the single `insert` row into
`$DSH_HOME/cordis.patch.yml` (every profile) or
`$DSH_HOME/profiles/<name>/cordis.patch.yml` (one profile) — copy the row, don't
overwrite an existing file. The key fields:

```yaml
- insert:
    - id: memory-th-memory-mcp
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: memory
        transport: stdio
        command: th-memory-mcp        # or ["node", "<REPO>/dist/index.js"]
        args: []
        env:
          MEMORY_DB_PATH: "<ABSOLUTE_REPO>/data/memory.db"
        cwd: !!js process.cwd()
```

Use the **same** `MEMORY_DB_PATH` as every other harness so memory is shared
(capture on OpenCode/Claude Code is readable here). dsh scrubs ambient env names
that look like credentials (`KEY`/`PASSWORD`/`SECRET`/`TOKEN`, and `DSH_*`)
before launching stdio children, so set `MEMORY_DB_PATH` in `config.env` (as
above) rather than relying on the parent env.

## 4. Attach the memory protocol

The 16 tools appear as `mcp__memory__<tool>` (e.g. `mcp__memory__remember`,
`mcp__memory__recall`, `mcp__memory__get_context`). Add this short, vendor-neutral
instruction to your model prompt so the tools get used reliably:

> When the user asks you to remember something, call a memory write tool. When
> historical information may be relevant, search memory and use relevant results.

## 5. Restart and test

Tool discovery is asynchronous — wait for the `mcp__memory__*` tools before the
first prompt. Then:

1. In dsh session A: *"Remember that I prefer pnpm."* Confirm the model called
   `mcp__memory__remember` and it returned success.
2. New dsh session B (no restart needed): *"What package manager do I prefer?
   Check memory."* Confirm the model called `mcp__memory__recall` and returned
   the value.
3. *"Use that preference for the next install command."* Confirm it applies it.

## Feature parity

| Feature | OpenCode | Claude Code | DeepSeek Harness (dsh) |
|---|---|---|---|
| 16 MCP tools | ✅ | ✅ | ✅ (`mcp__memory__*`) |
| Auto-capture (background) | ✅ plugin | ✅ hooks | ❌ manual (model instruction) |
| Profile injection | ✅ compaction | ✅ UserPromptSubmit | ❌ (call `get_context`/`get_profile`) |

The SQLite DB is identical, so memory captured on OpenCode/Claude Code is
readable in dsh and vice versa.

[third-party memory MCP guide]: https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/mcp-memory.md
