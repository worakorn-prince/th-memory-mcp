# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.4.3] - 2026-11-08

### Security
- `package-lock.json` now resolves the transitive `@hono/node-server` at `2.1.6` (was `2.1.1`), clearing GHSA-rmxm-3fg6-px4f (`moderate`); `npm audit --omit=dev` reports 0 vulnerabilities at every severity.
- No dependency ranges changed for this lockfile refresh — `dependencies` are untouched and no override was removed. The published `2.4.2` already resolved `@hono/node-server@2.1.6` on fresh installs; this release aligns the repo lockfile with that tree.
- Cleared the remaining dev-only advisories by adding `glob` `^14.0.4` and `minimatch` `^11.0.5` to both `overrides` and `pnpm.overrides` in `package.json` (GHSA-3g3m-2fjr-6pw4, GHSA-g3hv-75wg-m249); full `npm audit` now reports 0 vulnerabilities at every severity, dev dependencies included. The affected tree is reached only through `@opencode/plugin` → `@opencode/util` → `@npmcli/*` / `pacote` / `sigstore` → `rimraf` → `glob`, and `@opencode/plugin` is imported with `import type` only, so none of it is executed at build, test, or runtime.

### Changed
- Harness notice on stderr is now prefixed `[th-memory-mcp] note:` instead of `[th-memory-mcp] warning:` when running outside OpenCode/Claude Code. The rest of the message (including the README pointer) is unchanged, and no tool behavior changed.

### Added
- `README.md` / `README.th.md`: "Audited by AddonAudit" badge in the directory/aggregator badge row, plus a short note near the security note — independent automated smoke audit by AddonAudit (an automated test, not a security guarantee). The 9 Nov 2026 re-audit of `2.4.3` passed every published check with 0 advisories (critical/high/medium/low).

### Verification
- `npm run version:check` — exit 0 (`package.json` 2.4.3 matches `ARCHITECTURE_v2.md`, `design.md`, `server.json`, `src/lib/config.ts`)
- `npm run build` — exit 0
- `npm run typecheck:plugin` — exit 0
- `node scripts/check-capture-sync.mjs` — exit 0 (12 `SECRET_PATTERNS`, limits in sync)
- `npm test` — 148 tests, 147 pass, 0 fail, 1 skip (unchanged)
- `npm audit --omit=dev --audit-level=high` — exit 0, found 0 vulnerabilities
- `npm audit --omit=dev` — 0 vulnerabilities (info 0 / low 0 / moderate 0 / high 0 / critical 0)
- `npm audit` (full, dev dependencies included) — 0 vulnerabilities (info 0 / low 0 / moderate 0 / high 0 / critical 0)
- `npm ls glob minimatch` — `glob@14.0.4` and `minimatch@11.0.5` everywhere, all `deduped`, no `invalid`
- `npm ls @hono/node-server` — `@hono/node-server@2.1.6` under `@modelcontextprotocol/sdk@1.32.1`

## [2.4.2] - 2026-11-03

### Security
- Bumped `zod` from `^3.25.0` to `^4.6.7` to resolve GHSA-mrhx-c7xc-m3w5 (memory exhaustion while validating oversized constrained collections). `zod` is a direct dependency, so the fix is applied in `dependencies` rather than `overrides`.
- Added `body-parser: ^2.4.0` to `overrides` to resolve GHSA-27r3-jxmh-p828 (denial of service via trailing bytes after a compressed request body). `body-parser` is a transitive dependency, so the fix is applied via `overrides`.
- `npm audit --omit=dev --audit-level=high` now exits 0; the only remaining advisory is a `moderate` one in `@hono/node-server` (GHSA-rmxm-3fg6-px4f), which the CI gate does not fail on.

### Changed
- `package-lock.json` regenerated for the new dependency ranges.
- Version references synced to `2.4.2` across `package.json`, `package-lock.json`, `server.json`, `src/lib/config.ts`, `ARCHITECTURE_v2.md`, and `design.md`.
- This release restores green CI on `master`: the `v2.4.1` push failed `npm audit` on all three Node versions (22 / 24 / 26), and the fix commit is included here.

### Verification
- `npm run version:check` — exit 0
- `npm run build` — exit 0
- `npx tsc -p tsconfig.plugin.json` — exit 0
- `node scripts/check-capture-sync.mjs` — exit 0
- `npm test` — 148 tests, 147 pass, 0 fail, 1 skip (unchanged; `zod` v4 required no API changes)
- `npm audit --omit=dev --audit-level=high` — exit 0

## [2.4.1] - 2026-10-28

### Added
- Learning-capture plugin is now dual-mode: the default export exposes `id` + `setup(ctx)` for OpenCode V2 (domain hooks for `prompt`, `tool.execute.after`, `compaction`, plus a `session.execution.failed` subscription for errors) and keeps `server()` for OpenCode V1 (1.18.29+). The named `LearningCapture` export is unchanged, and `@opencode/plugin` is imported with `import type` only, so the standalone deploy still has no runtime dependency on it.
- `npm run typecheck:plugin` (`tsconfig.plugin.json`) typechecks `src/plugin/**/*.ts` with `noEmit`, separate from the main build that excludes the plugin.
- New `test/plugin_v2.test.mjs` (fake V2 context: prompt/tool/error capture, compaction `<memory-reference>` injection, dedupe, cleanup abort) and extended `test/plugin_runtime_compat.test.mjs` to assert both V1 (`server`) and V2 (`id`/`setup`) entrypoints.
- `src/plugin/bun-sqlite.d.ts` declares the optional Bun driver so the dynamic `bun:sqlite` fallback typechecks without Bun installed.

### Changed
- Plugin deploy path is now the V2 directory layout `~/.config/opencode/plugins/learning-capture/index.ts`; a legacy single-file `plugins/learning-capture.ts` is renamed to `.bak-<timestamp>` (never deleted) by `npm run quickstart`.
- `scripts/quickstart.mjs` now prefers an existing `opencode.jsonc`, parses JSONC comment/trailing-comma safe, and leaves the config untouched with a warning when parsing fails; `--dry-run` performs no filesystem or environment changes.
- Documentation consistency pass for the release: version references (`package.json`, `server.json`, `src/lib/config.ts`, `ARCHITECTURE_v2.md`, `design.md`), `SECURITY.md` supported line (`2.4.x`), `PUBLISH.md`/`PUBLISH.th.md` plugin registration (V2 directory layout), and test counts across docs now match the shipped tree (46 test files / 148 tests: 147 pass, 1 skip).

## [2.4.0] - 2026-10-24

### Security
- Derived/consolidated memories now inherit the weakest trust of their sources: if any source memory is untrusted, the derived row is stored with `metadata.trusted=false` and the consolidate output labels it `[untrusted-import]`.
- Tool errors, server/CLI/plugin logs, and capture-plugin `meta` payloads are now redacted before output/storage, so secrets in failing inputs or error messages are no longer echoed back.
- `search_history`, `get_recent_interactions`, and `extract_memories` now accept an optional `sessionId` filter (max 200 chars) that limits interaction rows to one captured session. Unscoped calls intentionally keep the legacy all-sessions default for backward compatibility (single-user local model), and no other tool or default behavior changed.
- Export files are now written atomically (same-directory temp + rename) and the export handler refuses to follow a symlink at the destination; partial writes no longer become visible exports.
- Added `npm run scrub-secrets` (dry-run by default, `--apply` to rewrite) to redact secrets from rows written before write-boundary redaction existed, covering memories, preferences, lessons, profile, interactions, entities, relations, memory links, and user names, with FTS/embedding re-sync for touched rows. `users.external_id` is never rewritten.
- Graph write paths now redact secrets: `createEntity` covers name/canonical/type/aliases, `addRelation` and `linkMemories` cover predicates/relations, and import apply covers entity/relation/link metadata plus user names. `users.external_id` remains unchanged as an identity key.
- `get_recent_interactions` reserves wrapper overhead so the final response stays within 4000 chars; `consolidate` labels untrusted members with `[untrusted-import]` while keeping one wrapper per response.
- Memory-reference sanitization now matches whitespace/attribute tag variants (`</memory-reference >`, `</memory-reference foo>`, newline forms, `<memory-reference data-x="1">`) in both `src/lib/memory-format.ts` and the capture plugin, using the hardened `/<\/?memory-reference\b[^>]*>/gi` pattern; `check:capture-sync` now requires that hardened form in both copies.
- `forget(type="memory")` is now a true hard purge inside the existing transaction: it deletes the `memories` row, deletes `memory_links` on both sides, removes `search_index`/`embeddings` rows, nulls `relations.source_memory_id` (shared graph relations survive) and `memories.supersedes_id` on surviving rows. This intentionally breaks supersession chains, and legacy rows already marked `status='deleted'` can be purged.
- `export_memory` now excludes `status='deleted'` memories, memory links touching deleted memories, and relations whose `source_memory_id` points at a deleted memory; relations with a `NULL` source remain. The `th-memory-mcp/v2` format is unchanged.
- `search_history`, `get_recent_interactions`, `consolidate`, and the `extract_memories` dry-run preview now wrap returned memory text in `<memory-reference>` guidance and neutralize embedded delimiter payloads.
- `isUntrustedMetadata` now fails closed: unparseable JSON and non-object metadata are treated as untrusted.
- Secrets are now redacted at explicit write boundaries: memory content/summary, preference key/value, lesson fields, `update_memory` in-place fields, and trusted-import auxiliary rows pass through `filterSecrets` before persistence and FTS/embedding indexing; metadata strings are recursively redacted. Graph entity/relation fields are covered separately below.
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

[Unreleased]: https://github.com/worakorn-prince/th-memory-mcp/compare/v2.4.3...HEAD
[2.4.3]: https://github.com/worakorn-prince/th-memory-mcp/compare/v2.4.2...v2.4.3
[2.4.2]: https://github.com/worakorn-prince/th-memory-mcp/compare/v2.4.1...v2.4.2
[2.4.1]: https://github.com/worakorn-prince/th-memory-mcp/compare/v2.4.0...v2.4.1
[2.4.0]: https://github.com/worakorn-prince/th-memory-mcp/compare/v2.3.6...v2.4.0
[2.3.6]: https://github.com/worakorn-prince/th-memory-mcp/releases/tag/v2.3.6
[2.3.3]: https://github.com/worakorn-prince/th-memory-mcp/releases/tag/v2.3.3
[2.3.2]: https://github.com/worakorn-prince/th-memory-mcp/releases/tag/v2.3.2
[2.3.1]: https://github.com/worakorn-prince/th-memory-mcp/releases/tag/v2.3.1
[2.3.0]: https://github.com/worakorn-prince/th-memory-mcp/releases/tag/v2.3.0
[2.2.9]: https://github.com/worakorn-prince/th-memory-mcp/releases/tag/v2.2.9
[2.2.8]: https://github.com/worakorn-prince/th-memory-mcp/releases/tag/v2.2.8
