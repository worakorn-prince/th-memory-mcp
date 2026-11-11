# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Performance
- **Write path is no longer O(n) in database size.** `syncSearchIndex()` / `removeSearchIndex()` used to run `DELETE FROM search_index WHERE ref_table = ? AND ref_id = ?` (and the `search_index_loose` twin) before every write. FTS5 virtual tables have no secondary index, so that delete was a full table scan (10.6 ms for a single delete at 20k rows) and a bulk insert became O(n²). A new `search_index_keys(ref_table, ref_id, strict_rowid, loose_rowid)` side table now maps each ref to its FTS rowids, so updates/deletes are point operations by rowid (`UPDATE`/`DELETE ... WHERE rowid = ?`), and creates capture `lastInsertRowid` and write the mapping in the same transaction. Migration `015_search_index_keys` backfills the mapping on existing databases in one O(n) pass (no re-segmentation; stored index text is byte-identical).
- Measured on a 20k-memory database (insert benchmark, same machine): insert throughput **73.6 → 351.2 mem/s**, wall time **271.7 s → 56.9 s**, `cpuUser` **222 s → 10.7 s**, database size **+1.5%** (the side table). Retrieval quality is unchanged.
- Re-running `M015` is idempotent and fully recomputes the mapping (the table is a pure derivative of the FTS content); the legacy scan-delete is kept only as the no-mapping fallback in `removeSearchIndex`.
- **Read path no longer deserializes every embedding per query.** `vectorSearch()` and the semantic blend in `recall()` now read ids only from SQLite (`getAllEmbeddingKeys()`, the ids-only twin of `getAllEmbeddings()` — same SQL, same row order, so equally-scored ties keep their order) and take the decoded vectors from a bounded in-process cache (`src/retrieval/vector-cache.ts`). Cache misses are filled by one batched point-read (`getEmbeddingsByKeys()`, chunks of 400); `upsertEmbedding()` / `removeEmbedding()` invalidate exactly their own key (`invalidateVector()`), so a re-embedded or deleted memory can never be scored from a stale vector while every other decoded vector stays warm — the whole-cache `bumpVectorEpoch()` now runs only for bulk rewrites (after `runMigrations()`) and in tests. Scope of the write-then-read freshness guarantee: it holds for every path that goes through `upsertEmbedding()` / `removeEmbedding()`. The two paths that rewrite `memories.content` **without** touching the embedding — `update_memory` in place (`supersede: false`, which only re-syncs the FTS index) and `scrub` (which redacts `memories.content` and re-indexes but does not re-embed) — keep the vector of the old text; that mismatch is pre-existing behaviour, not a regression of this change, and no cache bug can surface it because the stale vector would be read from the database too. `deserialize()` gained a zero-copy fast path — a 4-byte-aligned little-endian blob is viewed as a `Float32Array` in place instead of a per-element `DataView` loop (unaligned or big-endian blobs keep the copying path), and the cache copies any view that aliases a larger buffer so the memory bound stays exact.
- **The 20k-row scan is Map-bound, not key-bound.** *(Superseded by the matrix bullet below — kept for the record.)* This intermediate layout stored one decoded `Float32Array` per entry in a `Map`, with FIFO eviction over insertion order and a `${refTable}:${refId}` string build per row. `TASK-PERF-MATRIX` removed that layout: the hot path no longer builds a key or touches a per-row object, eviction is whole-bucket LRU, and the byte bound is per bucket capacity, so neither this Map structure nor its FIFO behaviour exists in the shipped code.
- The cache is bounded by `MEMORY_VECTOR_CACHE_MB` (default **64 MB**; `0` disables it). Accounting is per bucket **capacity** — `capacity × EMBED_DIM × 4` = 2,048 B (~2 KB) per slot — not per live entry, because that capacity is what is actually allocated. No single bucket may allocate more than **75%** of the budget, so one large table can never consume the whole budget and force every other bucket out on each query. Eviction drops whole buckets in LRU order, never individual entries. `MEMORY_VECTOR_CACHE_MB=0` disables it and both read paths fall back to the previous full-BLOB read + decode, with identical ids, scores and order.
- Measured on a 20k-memory database (Map layout above; superseded by the interleaved matrix measurements below, kept for the record): `vectorSearch(topic, {limit: 10})` **276.9 → 66.1 ms/query** at steady state (54–91 ms across 10 queries; the first call after a fill costs **380.5 ms**, 380–478 ms across runs), `createMemory()` (1.1 ms) followed immediately by `vectorSearch()` costs **52.4 ms** (52–68 ms across runs) with **0 fewer cache entries** and exactly one miss — the new row — instead of the ~380 ms refill the old epoch clear forced on every write, and `recall(topic, {limit: 10})` goes **342.0 → 140.9 ms/query**. Ids, scores and ordering are identical between the cached and uncached paths (limit 200: 200 rows, `Object.is` on every score; the `recall` text is identical too).
- **The decoded-vector cache is now a slot-based contiguous matrix per `ref_table`.** `src/retrieval/vector-cache.ts` replaces the per-entry `Map` with one `Float32Array` of `capacity * EMBED_DIM` plus an `Int32Array` of slot → `ref_id`, so scoring is a single linear pass of contiguous dot products — the same arithmetic `cosine()` performs (same index order, same float64 accumulator), so ids, scores (`Object.is`) and ordering are unchanged. This is an **exact** full scan, not an ANN index. Freed rows go on a free list and are reused (`invalidateVector()` parks the slot; the next stored vector takes it before the matrix grows), and growth is amortized at **1.5x** for the one-at-a-time `putVector()` path while `ensureVectors()` — handed the full id list on a query — allocates **exactly the live row count** instead of the next power of two. Byte accounting is per bucket capacity, `bytes = capacity × EMBED_DIM × 4` (2,048 B/slot), because that capacity is what is actually allocated: a 20k query now holds 20,000 memory slots plus the 256-slot `preferences` and `lessons` buckets = **42,008,576 B of the 64 MiB budget**, leaving 23.9 MiB of headroom, where power-of-two growth would have allocated 32,768 slots = 67,108,864 B (the entire budget) and evicted the other buckets on every query. A single bucket may allocate at most **75%** of the budget, so a table larger than that cap does not thrash: the rows that still get slots are scored from the matrix and the overflow rows are scored from the same batched fetch with `cosine()` + `deserialize()`, so a table above the cap stays exact and keeps a warm working set instead of evicting every query. Queries pin their buckets (`withVectorQuery()`) so a mid-fill eviction can never invalidate an already-resolved slot, the budget is re-applied when the outermost query ends, and buckets left empty by `invalidateVector()` are pruned. `MEMORY_VECTOR_CACHE_MB=0` still disables the cache and keeps the previous full-BLOB read + `deserialize()` path, with identical results.
- Measured **interleaved** on the same 20k database (three `before → after` rounds, 9 timed calls per round, pooled median of 27 calls per side; the two builds ran alternately so machine noise hits both sides): `vectorSearch(topic, {limit: 10})` **63.4 → 40.9 ms/query** (−35%; per-round medians 67.7/63.7/53.2 → 44.2/40.0/39.9) and `recall(topic, {limit: 10})` **95.1 → 71.0 ms/query** (−25%; 106.9/78.8/98.5 → 73.7/71.1/68.2), with the cold fill unchanged (≈449 → ≈448 ms, dominated by the batched BLOB read). Output is identical: the limit-200 list (200 rows) and the `recall` text (2,194 chars) hash to the same SHA-256 on both sides, and the top-5 ids and scores match exactly.
- **The index-compute pass stops redoing work it can reuse.** `segmentForIndex()` memoises short inputs (≤ 64 chars — the synonym counterparts re-segmented once per indexed record) in a bounded 512-entry map; the epoch is bumped by `forceSegmenter()` / `setSegmentOverrideProvider()`, so a test-forced segmenter or a provider refresh can never be served a stale tokenisation, and longer document inputs bypass the memo instead of churning it. `expandIndexedText()` caches the Thai key set and its longest key per lookup-map identity (`WeakMap` keyed by the map `lookupFor()` already returns), stops extending a join once it passes the longest Thai key (no key can be longer, so every extension was a guaranteed miss), and reads counterparts from the already-resolved map instead of calling `expandSynonyms()` per token — which also cuts the `segmentForIndex()` calls per candidate from two to one. `embed()` builds each trigram by concatenating three already-materialised code points instead of `slice(i, i + 3).join("")` per character.
- Measured with the same probe on the same machine (µs/doc, before → after): compute total **420.6 → 202.8 (−51.8%)**, `expandIndexedText` **288.9 → 62.0 (−78.5%)**, `embed` **116.4 → 104.0 (−10.7%)**, `segmentForIndex` **49.6 → 54.6 (+10%)** because long documents now bypass the memo. `createMemory()` per insert: **323 → 398 (+23%)** with `synchronous = OFF` (CPU-isolated probe, write-path noise) and unchanged with `synchronous = NORMAL` (fsync-dominated). Output is **byte-identical**: `test/index_payload_equivalence.test.mjs` keeps a verbatim copy of the pre-change `segmentForIndex` / `expandIndexedText` / `looseForm` / `embed` from `edf13d5` and diffs all four against the current implementation over a 119-entry corpus (Thai with tone marks, TH/EN mixed, English-only, digits/punctuation, every curated synonym on both sides, repeats, double/leading/trailing spaces, tabs/newlines, emoji and astral code points, empty, single-character, hundreds-of-characters documents) — strings byte-for-byte, `embed` on all 512 dimensions (`Object.is` plus raw buffer bytes) — on both the `Intl.Segmenter` and dictionary-fallback paths, plus idempotency of `expandIndexedText` / `looseForm` / `segmentForIndex` and coverage of the `join.length > maxThaiKeyLen` break.

### Fixed
- `removeSearchIndex()` now scopes its rowid deletes by `ref_table`/`ref_id` and checks `changes`, so a stale mapping that points at a rowid reassigned to another ref can no longer delete that ref's row; the scan fallback runs only on that exceptional path. The key row is deleted last, so a throwing fallback can never leave "no mapping but FTS rows" behind.
- `M015` pairs the strict/loose halves by ref and rewrites a loose row from its strict counterpart with `looseForm()` when the two came from different generations, keeping the loose channel in lockstep with the strict payload.
- `syncSearchIndex()` and `removeSearchIndex()` wrap their FTS + mapping writes in one `BEGIN IMMEDIATE` transaction (nested as a `SAVEPOINT` when a caller already has one), so no FTS row can be left behind without its key row and a read-then-write sequence cannot fail with `SQLITE_BUSY_SNAPSHOT`.
- `test/search_index_keys.test.mjs` — coverage for the mapping table: create/update/remove, idempotent re-sync, rowid-stability on update, both self-heal directions, ownership-safe remove, `M015` backfill/recompute/orphan/duplicate/generation repair.

### Known limitations
- **Pre-existing, not a regression of TASK-PERF-COMPUTE:** `expandIndexedText()` is not a one-pass fixed point for the one-to-many curated pairs (`memory → ความจำ, หน่วยความจำ`; `repository → รีโพสิทอรี, รีโพ`), although its doc comment claims a byte-idempotent second pass. A payload that holds one TH variant appends the EN term on the first pass, and the now-present EN *token* makes the second pass append the missing sibling (`" ความ จำ "` → `" ความ จำ memory"` → `" ความ จำ memory หน่วย ความ จำ"`, stable from there). The new equivalence gate pins this exact behaviour against the pre-change implementation, so it cannot widen unnoticed.
- If a `search_index_keys` mapping is lost for reasons outside the write path (manual DB edits, or a crash of a pre-M015 writer), the next `syncSearchIndex()` for that ref writes a fresh FTS row pair **without scanning for the old rows** — that scan is exactly the O(n) cost this change removes, so it is not paid on the hot path, and the orphan rows are left in place. They do not surface to users: `ftsSearch` joins the source table on `ref_id`, so stale text cannot outrank or duplicate a live document. The one visible gap is the `forget` hard purge, which deletes only the mapped rowids and may leave those orphan rows behind. The repair path is re-running `M015`: it recomputes the mapping from the FTS content and dedupes rows per ref by `MAX(rowid)`. There is no dedicated CLI for it yet, so the supported way is to delete the `schema_meta` row `015_search_index_keys` (e.g. `DELETE FROM schema_meta WHERE key = '015_search_index_keys';`) and reopen the database, which re-runs the migration.

### Verification
- `npm run build` — exit 0
- `node --test test/index_payload_equivalence.test.mjs` — 11 tests, 11 pass, 0 fail
- `node --test test/vector_matrix.test.mjs` — 15 tests, 15 pass, 0 fail
- `node --test test/vector_bigtable.test.mjs` — 2 tests, 2 pass, 0 fail
- `npm run version:check` — exit 0
- `npm test` — 255 tests, 254 pass, 0 fail, 1 skip

## [2.5.1] - 2026-11-10

### Added
- **Thai lexical layer v2** — zero-dependency follow-up to the 2.5.0 Thai-aware FTS5, making Thai retrieval word-aware, typo-tolerant, cross-language, and personal:
  - `src/lib/thai-segment.ts` — `looseForm()` (de-accented/tone-tolerant form, keeps vowels), a built-in ~230-word dictionary fallback for runtimes without `Intl.Segmenter`, and `wordTokens()` as the single mixed TH/EN word tokenizer. `Intl.Segmenter` stays the primary path; `test/thai_segment_core.test.mjs` covers both paths.
  - **Word-aware embeddings** — `src/lib/embed.ts` feeds Thai runs through `wordTokens` (≈ word vectors instead of one opaque run); migration `011_embeddings_segmenter` recomputes stored vectors (batched, idempotent, row-count-preserving). `test/embed_thai.test.mjs`.
  - **TH↔EN transliteration synonyms** — `src/lib/thai-synonyms.ts` (deploy↔ดีพลอย, install↔ติดตั้ง, … ) applied at index and query (whole-term only, precision-first); migration `012_search_index_synonyms` re-expands existing rows. `test/thai_synonyms.test.mjs`.
  - **Tone-tolerant search** — `search_index_loose` fallback channel lets a tone-mark typo (ติดตัง) still surface the correctly-marked document, always ranked below the tone-exact strict channel; migration `013_search_index_loose`; merged in `ftsSearch` and `recall` (deterministic strict-then-loose). `test/thai_loose.test.mjs`.
  - **Personal Thai dictionary** — `src/db/thai-dict.ts` stores synonym/segment overrides in a new `thai_dict` table (migration `014_thai_dict`), auto-learns known transliterations from `lessons`, and injects them into the pure modules through provider seams (no DB imports in lib/); `th-memory thai-dict` CLI subcommand. `test/thai_learn.test.mjs`.
  - **`thai-fts` CLI + docs** — a zero-dependency standalone CLI (`segment`/`loose`/`synonyms`/`check`, `--json`) registered as `bin.thai-fts`, plus `docs/thai-fts.md` documenting how to copy the reusable module into any Node project. `test/thai_cli.test.mjs`.

### Verification
- `npm run build` — exit 0
- `npm run version:check` — exit 0
- `npm test` — 194 tests, 193 pass, 0 fail, 1 skip

## [2.5.0] - 2026-11-09

### Fixed
- Thai words inside unspaced Thai text are now found by keyword search in `recall`, `get_context`, and `ftsSearch`. The default FTS5 `unicode61` tokenizer treated Thai combining marks (Unicode category M — vowels and tone marks) as separators, so a word like `ติดตั้ง` was stored as consonant fragments and matched nothing; only the vector blend could surface it. `search_index` now uses `tokenize = "unicode61 categories 'L* N* Co M*'"` so marks stay inside tokens, and Thai text is word-segmented with the built-in `Intl.Segmenter("th")` before indexing. Matching is tone-mark sensitive (`ติดตัง` ≠ `ติดตั้ง`, `ขาวผัด` ≠ `ข้าวผัด`, `นัง` ≠ `นั่ง`, `ดือ` ≠ `ดื้อ`). Non-Thai text and query behavior is unchanged.

### Added
- `src/lib/thai-segment.ts` — zero-dependency Thai word segmentation for indexing and query building; falls back to the previous behavior when `Intl.Segmenter` is unavailable.
- `src/db/search-index-schema.ts` — single source of truth for the `search_index` DDL and its mark-aware tokenizer.
- Migration `010_search_index_thai` — rebuilds the existing `search_index` once with the new tokenizer and re-segments stored rows; rows stream through a TEMP table, the row count is preserved, and re-running is idempotent.
- `test/thai_fts.test.mjs` — segmentation/idempotency, phrase query building, Thai word lookup, tone-mark precision, ranking, migration, and a tokenizer schema guard.

### Verification
- `npm run build` — exit 0
- `npm run version:check` — exit 0
- `npm test` — 155 tests, 154 pass, 0 fail, 1 skip (47 files)

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

[Unreleased]: https://github.com/worakorn-prince/th-memory-mcp/compare/v2.5.1...HEAD
[2.5.1]: https://github.com/worakorn-prince/th-memory-mcp/compare/v2.5.0...v2.5.1
[2.5.0]: https://github.com/worakorn-prince/th-memory-mcp/compare/v2.4.3...v2.5.0
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
