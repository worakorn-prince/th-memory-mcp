<img src="access/Banner.png" alt="th-memory-mcp Banner" width="100%" />

[![npm version](https://img.shields.io/npm/v/th-memory-mcp.svg)](https://www.npmjs.com/package/th-memory-mcp) [![npm downloads](https://img.shields.io/npm/dm/th-memory-mcp.svg)](https://www.npmjs.com/package/th-memory-mcp) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE) [![Node](https://img.shields.io/badge/node-22%20%7C%2024%20%7C%2026-brightgreen.svg)](https://nodejs.org) [![CI](https://github.com/worakorn-prince/th-memory-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/worakorn-prince/th-memory-mcp/actions/workflows/ci.yml)

[![Listed on mcpservers.org](https://mcpservers.org/badge.svg)](https://mcpservers.org/servers/worakorn-prince/th-memory-mcp) [![Glama score](https://glama.ai/mcp/servers/worakorn-prince/th-memory-mcp/badges/score.svg)](https://glama.ai/mcp/servers/worakorn-prince/th-memory-mcp) [![mcprush](https://mcprush.com/badge/th-memory-mcp/score.svg)](https://mcprush.com/to/th-memory-mcp?ref=badge) [![Audited by AddonAudit](https://addonaudit.com/badges/audited.svg)](https://addonaudit.com/addon/io-github-worakorn-prince-th-memory-mcp/)

# th-memory-mcp

**Local-first memory for AI coding agents, over MCP.** One SQLite file remembers your
preferences, lessons, decisions and project context, then hands the right slice back to the
agent before each task. Hybrid FTS5 + local vectors, Thai/English aware, no cloud, no API keys.

## What you get

| | |
|---|---|
| 🧠 **16 MCP tools** | `remember`, `recall`, `get_context`, `get_profile`, `save_lesson`, `consolidate`, `link_memory`, `merge_memory`, `update_memory`, `forget`, `search_history`, `get_recent_interactions`, `memory_stats`, `export_memory`, `import_memory`, `extract_memories` |
| 🔎 **Hybrid retrieval** | FTS5 (Thai word-segmented, tone-tolerant) fused with 512-dim local vectors via RRF, then rescored by confidence, importance, recency and scope |
| 🕰 **Temporal + conflict-aware** | validity windows, supersession chains, duplicate/contradiction classification; ambiguous evidence is preserved, never silently destroyed |
| 🔌 **Works with your harness** | OpenCode plugin with background capture; Claude Code hooks; Codex, Cursor, Qwen Code, DeepSeek Harness via MCP |
| 🔐 **Opt-in security** | RBAC over every tool, identity-derived scope isolation with grants, a content-free `audit_log`, whole-DB SQLCipher encryption with rotation/backups/drills, and per-user capture attribution |
| 📴 **Offline by default** | no network calls, no accounts, no API keys — the database is a single local file |

## Install in 60 seconds

```bash
git clone https://github.com/worakorn-prince/th-memory-mcp.git
cd th-memory-mcp && npm install && npm run build

# one DB shared by the server and the plugin
setx MEMORY_DB_PATH "%CD%\data\memory.db"          # Windows
# export MEMORY_DB_PATH="$PWD/data/memory.db"      # macOS/Linux (add to your shell profile)
```

Then register the MCP server with the ready-made block in
[`setup/opencode.example.json`](setup/opencode.example.json) (or run `npm run quickstart`).
Optional agent rules: [`setup/AGENTS.memory.example.md`](setup/AGENTS.memory.example.md).

## Documentation

| Topic | Where |
|---|---|
| **Full documentation** — requirements, architecture, every tool, the CLI, daily usage | [`docs/Docs.md`](docs/Docs.md) |
| Full documentation (ไทย) | [`docs/Docs.th.md`](docs/Docs.th.md) |
| Authentication, RBAC and scope isolation | [docs/Docs.md § Authentication](docs/Docs.md#authentication-opt-in) |
| Encryption at rest, key rotation, backup / verify / restore / drill | [docs/Docs.md § Encryption](docs/Docs.md#encryption-at-rest-phase-4-opt-in-requires-memory_encryptionon) |
| Threat model and residual risks | [`SECURITY.md`](SECURITY.md) |
| Upgrade from 2.x | [`MIGRATION_v3.md`](MIGRATION_v3.md) |
| Performance measurements | [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) |
| Thai search internals (reusable module) | [`docs/thai-fts.md`](docs/thai-fts.md) |
| Changelog | [`CHANGELOG.md`](CHANGELOG.md) |

## Harness setup

| Harness | Guide |
|---|---|
| OpenCode | [`setup/opencode.example.json`](setup/opencode.example.json) + `npm run quickstart` |
| Claude Code | [`setup/CLAUDE_CODE_HOOKS.md`](setup/CLAUDE_CODE_HOOKS.md) |
| Codex | [`setup/CODEX_SETUP.md`](setup/CODEX_SETUP.md) |
| Cursor | [`setup/CURSOR_SETUP.md`](setup/CURSOR_SETUP.md) |
| Qwen Code | [`setup/QWEN_SETUP.md`](setup/QWEN_SETUP.md) |
| DeepSeek Harness | [`setup/DSH_SETUP.md`](setup/DSH_SETUP.md) |

## Security in one paragraph

With no environment variables set, the server behaves exactly like 2.5.x: no auth, plaintext
database, no extra I/O. Security is opt-in and independent: `MEMORY_AUTH=on` adds a verified
identity, a single role gate over all 16 tools, identity-derived scope isolation with explicit
grants, and an `audit_log`; `MEMORY_ENCRYPTION=on` encrypts the whole database (SQLCipher via
`better-sqlite3-multiple-ciphers`) and adds `db rekey`, `db verify-backup`, `db restore` and
`db drill`. Details, threat model and residual risks: [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE) © 2026 worakorn-prince
