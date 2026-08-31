# th-memory-mcp — Design Notes (Current)

This document is up-to-date with the actual codebase state (after completing all future feature plans except AI-assisted extraction, which was removed). The full specification is at `ARCHITECTURE_v2.md` (canonical spec); this file summarizes the overview and current status for convenience.

## Current Status
- **Version:** `package.json` = `2.2.4`
- **MCP tools:** 16 tools (`remember`, `recall`, `get_context`, `link_memory`, `merge_memory`, `update_memory`, `import_memory`, `extract_memories`, `consolidate`, `forget`, `history`, `recent_interactions`, `profile`, `lesson`, `memory_stats`, `export_memory`)
- **Test suites:** 25 suites passing (0 fail) — run via `npm test` (CI on GitHub Actions)

## Core Components (src/)
- `db/` — better-sqlite3 (WAL mode), linear migrations (M001–M007), repositories (`memories`, `users`, `preferences`, `lessons`)
- `lib/embed.ts` — hashing-trick lexical fuzzy matching (hashed n-gram similarity, 512-dim FNV-1a) (no LLM/network dependency)
- `retrieval/` — FTS5 + lexical fuzzy matching (hashed n-gram similarity, 512-dim FNV-1a) → RRF fusion → scorer (confidence × importance × recency × scope)
- `memory/` — types, lifecycle-engine (decay/source-weights), conflict-resolver, deduplicator
- `core/` — retrieval-engine, context-engine, graph-engine, consolidation-engine, entity-extractor
- `tools/` — 16 MCP tool handlers
- `index.ts` — MCP stdio server

## Completed Features
- ✅ Temporal model — validity intervals, point-in-time retrieval, supersession chains, change detection
- ✅ Conflict/dedup — normalize → exact → similar → classify (duplicate/update/contradiction/unrelated); ambiguous conflicts are kept (link `contradicts`) instead of silently overwriting
- ✅ Hybrid retrieval (FTS + lexical fuzzy matching (hashed n-gram similarity, 512-dim FNV-1a), RRF)
- ✅ Memory graph — entities/relations + bounded traversal (`link_memory`)
- ✅ Context engine — `get_context` with token budgeting, temporal filtering, graph expansion
- ✅ Consolidation — clustering + derived memories (`derived_from` provenance)
- ✅ Scope hierarchy — `USER` / `SESSION` / `PROJECT` / `GLOBAL` (migrations 006 + 007)
  - `createMemory` infers scope in order SESSION > PROJECT > USER > GLOBAL
  - `scopeFactorFor` boosts memories matching the current context (USER=1.0, PROJECT/SESSION depending on context, GLOBAL as base)
- ✅ Profile auto-projection — `profile.ts` injects important memories into `[memories]`
- ✅ Auto entity extraction — `entity-extractor.ts` extracts entities heuristically (no LLM) and links them into the graph during consolidation
- ✅ In-repo benchmark:
  - Retrieval quality (§26) — `test/retrieval_benchmark.test.mjs` (Recall@5=1.00, Precision@5=0.92, MRR=1.00)
  - Perf (§29) — `test/benchmark.test.mjs` measures latency per operation via CI
  - Conflict quality (§27) — `test/conflict_benchmark.test.mjs` (100% on 14 cases across 7 categories)
  - E2E transport — `test/e2e_transport.test.mjs` (spawn server via StdioClientTransport)
- ✅ CI pipeline — `.github/workflows/ci.yml` (ubuntu-latest, node 20, `npm ci`, `npm test`)

## Scope Model (Details)
| Scope | Condition | Behavior |
|-------|-----------|----------|
| SESSION | has `sessionId` | bound to that session |
| PROJECT | has `projectId` (no session) | bound to that project |
| USER | has `userId` (no session/project) | bound to that user (auto-creates row in `users`) |
| GLOBAL | none | shared system-wide memory |

`userId` received from the client is an external identity (string) — the system does not authenticate; it is entirely client-declared.
`preferences` and `lessons` remain global (no user column).

## Known Limitations
- **Trust model:** No user authentication — `userId` is client-declared. Suitable for local single-user deployment where the SQLite file is owned by a single user. For multi-user separation, use one DB file per user instead of adding auth to the engine.
- `preferences` / `lessons` are not partitioned by user (still global) — acceptable for single-user.
- Lexical fuzzy matching uses hashing-trick (hashed n-gram similarity, 512-dim FNV-1a, deterministic, offline) — not LLM-level / concept-level embedding, so distant paraphrases without shared tokens or 3-grams will not be linked (affects RRF vector signal and conflict-resolver threshold).
- **AI-assisted extraction discontinued** — the owner decided to remove this; `extract_memories` is therefore deterministic heuristic only (no LLM), per the design principle that the core engine must not depend on an external LLM API.
- **No encryption at rest (plaintext-at-rest) — Md-4:** `data/memory.db` (WAL mode, `better-sqlite3`) is a plain, unencrypted SQLite file. `100% local & private` means no cloud or network exfiltration — it does **not** mean encrypted at rest. Anyone with filesystem access (shared machine, backup, malware, stolen device) can read preferences/lessons/interactions in plaintext. For sensitive data, use OS-level full-disk encryption (BitLocker / FileVault / LUKS) or an opt-in SQLCipher build (requires native rebuild and key management). No SQLCipher/in-code encryption is applied by default and `src/db/index.ts` documents this explicitly.

## Release
- v2.0.0 released (npm, GitHub Release, Official MCP Registry, Glama)
- v2.2.0 — full release: tag + GitHub Release, **npm publish done**, Official MCP Registry auto-pulls from npm (no separate mcp-publisher run), Glama Sync done
- v2.2.1 — Glama quality fix: added `pnpm.onlyBuiltDependencies: ["better-sqlite3"]` so pnpm runs the native binary download script for Node 24, bumped better-sqlite3 to `^12.9.0`, added override `ip-address@^10.2.0` (npm+pnpm) to patch XSS via MCP SDK — no code change, waiting for `npm publish` + Glama re-test
- v2.2.3 — security + performance hardening per `report_checkup.md`: enforced scope filtering (no foreign USER/SESSION returned), graph scope isolation, disallow cross-scope links, round-trip export/import, `realpath` against symlink, strict import validation (enum/0..1/ISO), eliminated N+1 queries (vector JOIN, bulk fetch, cap consolidation), cold/ablation benchmark and `MEMORY_RETRIEVAL_MODE` switch, added 5 new tests to 25/25, benchmark runs all suites
- v2.2.4 — docs: tidy README badge layout
