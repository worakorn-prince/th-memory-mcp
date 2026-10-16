# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[Unreleased]: https://github.com/worakorn-prince/th-memory-mcp/compare/v2.3.1...HEAD
[2.3.1]: https://github.com/worakorn-prince/th-memory-mcp/releases/tag/v2.3.1
[2.3.0]: https://github.com/worakorn-prince/th-memory-mcp/releases/tag/v2.3.0
[2.2.9]: https://github.com/worakorn-prince/th-memory-mcp/releases/tag/v2.2.9
[2.2.8]: https://github.com/worakorn-prince/th-memory-mcp/releases/tag/v2.2.8
