# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security
- Tool errors, server/CLI/plugin logs, and capture-plugin `meta` payloads are now redacted before output/storage, so secrets in failing inputs or error messages are no longer echoed back.
- `search_history`, `get_recent_interactions`, and `extract_memories` now accept an optional `sessionId` filter (max 200 chars) that limits interaction rows to one captured session. Unscoped calls intentionally keep the legacy all-sessions default for backward compatibility (single-user local model), and no other tool or default behavior changed.
- Export files are now written atomically (same-directory temp + rename) and the export handler refuses to follow a symlink at the destination; partial writes no longer become visible exports.
- Added `npm run scrub-secrets` (dry-run by default, `--apply` to rewrite) to redact secrets from rows written before write-boundary redaction existed, covering memories, preferences, lessons, profile, interactions, entities, relations, memory links, and user names, with FTS/embedding re-sync for touched rows. `users.external_id` is never rewritten.
- Graph write paths now redact secrets: `createEntity` covers name/canonical/type/aliases, `addRelation` and `linkMemories` cover predicates/relations, and import apply covers entity/relation/link metadata plus user names. `users.external_id` remains unchanged as an identity key.
- get_recent_interactions reserves wrapper overhead so the final response stays within 4000 chars; consolidate labels untrusted members with [untrusted-import] while keeping one wrapper per response.
- Memory-reference sanitization now matches whitespace/attribute tag variants (`</memory-reference >`, `</memory-reference foo>`, newline forms, `<memory-reference data-x="1">`) in both `src/lib/memory-format.ts` and the capture plugin, using the hardened `/<\/?memory-reference\b[^>]*>/gi` pattern; `check:capture-sync` now requires that hardened form in both copies.
- `forget(type="memory")` is now a true hard purge inside the existing transaction: it deletes the `memories` row, deletes `memory_links` on both sides, removes `search_index`/`embeddings` rows, nulls `relations.source_memory_id` (shared graph relations survive) and `memories.supersedes_id` on surviving rows. This intentionally breaks supersession chains, and legacy rows already marked `status='deleted'` can be purged.
- `export_memory` now excludes `status='deleted'` memories, memory links touching deleted memories, and relations whose `source_memory_id` points at a deleted memory; relations with a `NULL` source remain. The `th-memory-mcp/v2` format is unchanged.
- `search_history`, `get_recent_interactions`, `consolidate`, and the `extract_memories` dry-run preview now wrap returned memory text in `<memory-reference>` guidance and neutralize embedded delimiter payloads.
- `isUntrustedMetadata` now fails closed: unparseable JSON and non-object metadata are treated as untrusted.
- Secrets are now redacted at explicit write boundaries: memory content/summary, preference key/value, lesson fields, `update_memory` in-place fields, and trusted-import auxiliary rows pass through `filterSecrets` before persistence and FTS/embedding indexing; metadata strings are recursively redacted. Graph entity/relation fields remain out of scope.
- Metadata redaction no longer passes non-plain objects (class instances, `Date`, `Map`, etc.) through untouched: they are JSON-serialized and recursively redacted, and cyclic/unserializable values collapse to `[REDACTED]`. Plain objects/arrays keep the depth-10 limit and `[Circular]` marker.
- Closed remaining legacy write paths: `merge_memory` now recursively redacts parsed target metadata before adding `merged_from`, so pre-existing raw secrets are not carried forward; the `distill` CLI now redacts each formatted profile section before upserting it (stats and pruning unchanged).

## [2.3.6] - 2026-10-23

### Security
- Raised the supported runtime baseline to patched Node.js lines 22.23.4+, 24.22.1+, and 26.12.1+; Node.js 20 is EOL (April 2026) and no longer supported.
- CI now tests the minimum patched version of each supported line and runs `npm audit --omit=dev --audit-level=high`.
- Documented the 21 Oct 2026 Node.js security release (including CVE-2026-111497 Brotli decoder RCE) and runtime verification with `is-my-node-vulnerable`. No source-code change: the stdio-only server does not use the affected HTTP/TLS/DNS/Brotli paths.

## [2.3.5] - 2026-10-21

### Fixed
- Learning-capture plugin now resolves `node:sqlite` first and falls back to `bun:sqlite`, so OpenCode Desktop's Node ESM loader no longer fails with `Received protocol 'bun:'`. The deployed plugin and project source stay in sync.

## [2.3.4] - 2026-10-21

### Security
- Import hardening: untrusted imports gate only `preferences`/`lessons`/`profile`; users/entities/relations/memories are still imported by design (use trusted exports). Per-item `trusted` is ignored for the gate, tool-level `userId` wins, and untrusted imports remain labelled.
- `get_profile` with no arguments now returns GLOBAL scope only; optional scope args widen it, and an unknown scope resolves to GLOBAL-only and never widens to an arbitrary scope.
- Delimiter sanitization prevents stored content from breaking out of `<memory-reference>` wrappers.
- Secrets are redacted before truncation in both the core and capture plugin.
- Export previews are wrapped as reference data; export files/directories are created with `0600`/`0700` on POSIX.
- Migration backups use `VACUUM INTO` for a consistent WAL-safe snapshot (still opt-out via `MEMORY_BACKUP_ON_MIGRATE=0|false`).
- Raised `@modelcontextprotocol/sdk` to `^1.32.1` and added overrides for `hono`, `fast-uri`, `proxy-addr`, `ip-address`, and `qs`.

## [2.3.3] - 2026-10-21

### Changed
- Docs: README refreshed — project banner added, mcprush badge added, Glama badge switched to the score variant, and badges regrouped (package/CI row + directory-listing row). No code change.

## [2.3.2] - 2026-10-18

### Changed
- Performance: consolidation clustering hot loop iterates sparse non-zero entries and skips already-connected pairs — ~2.2x faster at the 2K-candidate cap with bit-identical clustering results (N=1000: 429→198 ms; N=2000: 1967→888 ms).
- Performance: `get_context` fetches candidate memories with batched `WHERE id IN (...)` queries (chunked, cached statements) instead of one prepared statement per id; graph traversal and entity/relation writers reuse cached prepared statements.
- Performance: conflict resolver `findRelated` uses a single embeddings⋈memories join instead of a per-row lookup; `consolidate` no longer re-queries member content.
- No behavior change — verified by the full test suite (75/75) and a behavior-equivalence review (bit-identical vector math on 780/780 real pairs, identical join plan and row order).

## [2.3.1] - 2026-10-17

### Added
- Version guard — `npm run version:check` (`scripts/sync-version.mjs`) fails when version references diverge across files.
- CLI top-level error handling — `th-memory` commands now exit with a clear message instead of a raw stack trace.
- Tests for the scope helper, write-path transactions, and the version guard.

### Changed
- Scope visibility logic centralized into a single helper (`src/lib/scope.ts`), replacing duplicated copies — privacy hardening: vector scope filtering now happens in SQL (aligned with FTS), and `getAllEmbeddings` no longer falls back silently.
- Multi-step writes (main row + FTS index + embeddings) wrapped in a single `db.transaction`, so a mid-way error can no longer leave half-written state.
- `src/tools/import_memory.ts` and `src/cli/commands.ts` split into sub-modules (`src/tools/import/`, `src/cli/commands/`) — behavior unchanged.
- Docs synced with reality: 16 tools everywhere, real test counts, current publish status, and non-broken benchmark references.
- Repo scope: the public repo ships the program and user-facing docs only; internal architecture, design, migration, and benchmark material is local-only.

### Removed
- Dead code removed; legacy paths that must stay documented as PARKED instead of silently kept.

## [2.3.0] - 2026-09-14

### Added
- `th-memory` CLI (`bin`) with per-command implementations and help text.
- Highlight underline for retrieved memory content (`src/lib/highlight.ts`, `src/lib/memory-format.ts`).
- `check-capture-sync` guard script for the OpenCode capture plugin.
- Consolidation engine extensions (derived memories, graph links) and new migrations.
- Hardened Codex batch capture.
- `npm run quickstart` improvements.

### Changed
- README / PUBLISH docs refreshed; README notes the GitHub Packages retirement (`install from npmjs instead`).

### Fixed
- Import/dedup refinements plus consolidate, merge, and forget tool fixes.

## [2.2.9] - 2026-09-13

### Added
- `export_memory`: entities / users / relations export.
- Fail-closed migration behavior — migrations stop instead of continuing on inconsistent state.

### Fixed
- `forget` now also removes memory-graph links.
- Eliminated FTS N+1 queries.
- `npm test` now includes the smoke suite.

### Docs
- Version references synced to v2.2.8; benchmark results refreshed from the 2026-09-13 run.

## [2.2.8] - 2026-09-02

### Fixed
- Benchmark scope metric 0.75 → 0 (critical) and conflict 0 → 1; profiles rescaled to 5K / 20K / 100K; graph hop-1 0.52 → 1.0.
- Benchmark viewer: header + `detectProfile` synced to the rescaled profiles.

[Unreleased]: https://github.com/worakorn-prince/th-memory-mcp/compare/v2.3.6...HEAD
[2.3.6]: https://github.com/worakorn-prince/th-memory-mcp/releases/tag/v2.3.6
[2.3.3]: https://github.com/worakorn-prince/th-memory-mcp/releases/tag/v2.3.3
[2.3.2]: https://github.com/worakorn-prince/th-memory-mcp/releases/tag/v2.3.2
[2.3.1]: https://github.com/worakorn-prince/th-memory-mcp/releases/tag/v2.3.1
[2.3.0]: https://github.com/worakorn-prince/th-memory-mcp/releases/tag/v2.3.0
[2.2.9]: https://github.com/worakorn-prince/th-memory-mcp/releases/tag/v2.2.9
[2.2.8]: https://github.com/worakorn-prince/th-memory-mcp/releases/tag/v2.2.8
