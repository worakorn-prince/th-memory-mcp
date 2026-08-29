# th-memory-mcp v2 — Implementation Plan (design.md)

**Source of truth:** `ARCHITECTURE_v2.md` (on GitHub, baseline v1.2.2).
This file is the working plan for the Building Agent — read it before continuing implementation.

## Goal
Evolve th-memory-mcp from a structured local memory MCP into a durable, temporal,
conflict-aware, hybrid-retrieval memory engine. Local-first, offline, SQLite, no
mandatory cloud/LLM. Keep v1 behavior working during the transition.

## Current v1 state (summary)
- 9 MCP tools: remember, recall, get_profile, save_lesson, search_history, forget, memory_stats, get_recent_interactions, export_memory.
- Schema (inline `CREATE TABLE IF NOT EXISTS` in `src/db.ts`): `interactions`, `preferences`, `lessons`, `profile`, FTS5 `search_index`, `embeddings` (BLOB, 512-dim hashing-trick vectors).
- No migration system; no schema version table.
- Capture logic triplicated: `src/lib/capture-core.ts`, `src/plugin/learning-capture.ts` (Bun), `scripts/claude-capture.mjs`.
- Semantic search = full in-memory linear scan over all embeddings every `recall`.
- Version metadata inconsistent: `package.json` 1.2.2 vs `config.ts` VERSION 1.1.0 vs `smoke.mjs` assertion 1.1.0 (fix in Phase 10).

## Decisions (Phase 1)
- **Migrations are TS modules** (`src/db/migrations.ts`) exporting an ordered `MIGRATIONS` array + `runMigrations(db)`. Each `up(db)` is idempotent (`CREATE TABLE IF NOT EXISTS`) and tracked in `schema_meta`. This avoids `.sql` file-copy issues under `tsc` while keeping deterministic order (spec allows implementation differences).
- **Reuse existing `search_index` + `embeddings`** for v2 `memories` (ref_table = `'memories'`). No new FTS table needed.
- **Non-destructive:** v1 tables (`preferences`, `lessons`, `interactions`, `profile`) are preserved. v2 adds `memories`, `entities`, `relations`, `memory_links`, `schema_meta`.
- **Backfill (M005):** map `preferences → memories(type=PREFERENCE)`, `lessons → memories(type=LESSON)`, sync FTS+embeddings. Guarded by `v1_backfilled` flag so it runs once. `recall` is unaffected because it filters by `ref_table IN ('preferences','lessons')`.
- **No dual-write yet.** v1 tools keep writing only to v1 tables. v2 `memories` is seeded by backfill; new v2 tools (later phases) write to `memories`. Dedup/merge of backfilled vs new entries is Phase 4.
- **Repository layer** (`src/db/repositories/memories.ts`) provides `createMemory`, `getMemoryById`, `setStatus`, `softDelete`, `syncMemoryIndex`, `searchMemories` (FTS + semantic blend, status/project filtering). Not yet wired to a public tool (that is Phase 7 `get_context`).

## Phased roadmap
See `ARCHITECTURE_v2.md` §35 for the canonical phase list. Status tracked in the session todo list.

## This session (deliverables so far)

### Phase 1 — Core abstraction (DONE)
- [x] `src/memory/types.ts` — unified `MemoryType`, `SourceType`, `LifecycleState`, `Scope`, `LinkRelation`, `MemoryRecord`.
- [x] `src/db/migrations.ts` — migration engine + 5 migrations (schema_meta, memories+indexes, entities/relations, memory_links, v1 backfill).
- [x] `src/db/repositories/memories.ts` — core CRUD + index sync + `searchMemories` (hybrid FTS + semantic blend).
- [x] `src/db/index.ts` — call `runMigrations(db)` after existing DDL (non-destructive).
- [x] Build + full test suite green (capture/distill/smoke).

### Phase 2 — Lifecycle engine (DONE)
- [x] `src/memory/decay.ts` — `recencyFactor`, per-type `DECAY_LAMBDA_BY_TYPE` (policy classes, not constants).
- [x] `src/memory/source-weights.ts` — `SOURCE_WEIGHTS` map (spec §8).
- [x] `src/memory/scorer.ts` — `computeSalience` (weighted, configurable), `computeConfidence` (source weight + diminishing returns), `salienceForMemory`.
- [x] `src/core/lifecycle-engine.ts` — `canTransition`, `transitionStatus`, `reinforce`, `touch`, `supersede` (sets old=superseded, new=active + `supersedes_id` + `memory_links`), `archive`, `softDelete`, `LifecycleError`.
- [x] `test/lifecycle.test.mjs` — 17 checks (decay, scorer, transitions, supersession, archive). Added to `npm test`.

### Phase 3 — Temporal model (DONE)
- [x] `src/core/temporal-engine.ts` — `setValidity`, `memoriesValidAt` (point-in-time truth), `supersessionChain` (oldest→newest), `changesBetween` (change detection).
- [x] `test/temporal.test.mjs` — 7 checks (validity intervals, historical retrieval, supersession chains, change detection). Added to `npm test`.

### Phase 4 — Conflict & dedup (DONE)
- [x] `src/memory/deduplicator.ts` — `normalizeText`, `findExactMatch`, `findSimilar`, `deduplicate` (spec §11).
- [x] `src/memory/conflict-resolver.ts` — `isContradiction`, `classifyRelationship` (duplicate/update/contradiction/unrelated), `findRelated`, `resolveConflict` (merge duplicate / supersede update / link contradiction, preserving ambiguous evidence per §12).
- [x] `test/conflict.test.mjs` — 14 checks. Added to `npm test`.
- [x] **Bug fix (v1 too):** `src/lib/embed.ts` `serialize`/`deserialize` rewrote with `DataView` + explicit `byteOffset`. Old code used `Buffer.from(buf).buffer` which can carry a non-zero pool `byteOffset`, corrupting vectors (magnitude ~1e37). This silently broke v1 semantic search.

### Phase 5 — Hybrid retrieval (DONE)
- [x] `src/retrieval/fts.ts` — `ftsSearch` (FTS5 over `search_index`, status/project filters, `ORDER BY rank`).
- [x] `src/retrieval/vector.ts` — `vectorSearch` (cosine over `embeddings`, floor 0.15, filters).
- [x] `src/retrieval/fusion.ts` — `rrfFuse` (Reciprocal Rank Fusion, k=60).
- [x] `src/retrieval/scorer.ts` — `finalScore` (RRF × confidence × importance × recency × scope) + `scopeFactorFor`.
- [x] `src/core/retrieval-engine.ts` — `retrieve` (FTS + vector → RRF → scoring/rerank → filter → topK).
- [x] `searchMemories` in repository now delegates to `retrieve` (hybrid). `buildFtsMatch` switched to OR for better recall.
- [x] `test/retrieval.test.mjs` — 7 checks. Added to `npm test`.

### Phase 6 — Graph engine (DONE)
- [x] `src/core/graph-engine.ts` — `createEntity` (canonical dedup, aliases in metadata), `addRelation` (source_entity_id/relation/target_entity_id), `linkMemories`, `traverse` (bounded BFS over `memory_links`, maxDepth 1–5, relationFilter), `neighbors`.
- [x] `test/graph.test.mjs` — 7 checks (linking, bounded traversal depth, relation filter, entity dedup, relation insert). Added to `npm test`.
- [x] Note: `entities` columns are `(name, canonical_name, type, metadata)`; `relations` use `source_entity_id/relation/target_entity_id`; `memory_links` PK `(source_memory_id, relation, target_memory_id)`.

### Phase 7 — Context engine (DONE)
- [x] `src/core/context-engine.ts` — `getContext` (hybrid retrieve → optional graph expansion → temporal validity filter → token budgeting/truncation).
- [x] `src/tools/context.ts` — `contextInput` (zod) + `contextHandler` (returns assembled context text).
- [x] Wired `get_context` MCP tool into `index.ts` (now 10 tools total).
- [x] `test/context.test.mjs` — 7 checks (assembly, graph expansion, token budget, temporal validity). Added to `npm test`.
- [x] Updated `test/smoke.mjs` to expect 10 tools.

### Phase 8 — Consolidation (DONE)
- [x] `src/core/consolidation-engine.ts` — `clusterMemories` (embedding cosine + union-find), `createDerivedMemory` (type DERIVED, source consolidated, links `derived_from`), `getProvenance`.
- [x] `src/tools/consolidate.ts` — `consolidateInput` + `consolidateHandler` (read-only cluster listing + optional `derive`).
- [x] Wired `consolidate` MCP tool into `index.ts` (now 11 tools total).
- [x] `test/consolidation.test.mjs` — 5 checks. Added to `npm test`.
- [x] Added `DERIVED` to `MEMORY_TYPES`; added `DERIVED` lambda to `decay.ts`.

### Phase 9 — Benchmark & security suite (DONE)
- [x] `test/benchmark.test.mjs` — 2 checks (retrieve over 300 memories < 2000ms).
- [x] `test/security.test.mjs` — 5 checks (FTS injection quoting, safe retrieve, malicious content stored verbatim, extreme budget, parameterized SQL).
- [x] Both added to `npm test` (now 12 suites).

### Phase 10 — v2 release (DOCS DONE; PUBLISH PENDING USER)
- [x] `MIGRATION_v2.md` written (non-destructive upgrade guide, rollback notes).
- [x] `README.md` updated to v2.0.0 (11 tools, v2 architecture, new test scripts).
- [ ] Version bump to `2.0.0` + `npm publish --otp=CODE` (needs user OTP).
- [ ] `git commit` + `git push` + GitHub Release v2.0.0 (needs user).
- [ ] `.\mcp-publisher.exe publish` (Official MCP Registry; needs user GitHub OAuth + OTP).
- [ ] Glama: claim ownership + sync from GitHub.

## Next
All v2 engine phases (0–9) complete and tested. Remaining: user-driven release steps above. After release, future work could include automatic entity extraction in consolidation and a periodic auto-consolidate scheduler.
