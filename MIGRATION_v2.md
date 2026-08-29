# Migration to v2.0.0

`th-memory-mcp` v2 is a **non-destructive** upgrade over v1. Your existing
`data/memory.db` keeps working — v2 adds new tables and columns and backfills
them from your v1 data on first launch. No data is deleted or overwritten.

## What's new

| Area | v1 | v2 |
|------|----|----|
| Retrieval | `recall` (FTS5 only) | `get_context` (FTS5 + local vector + RRF fusion + scoring + token budget) |
| Memory model | flat preferences/lessons | typed memories with **lifecycle states**, confidence, importance, salience, decay |
| Time | none | **temporal validity** (valid_from / valid_until), historical retrieval, supersession chains |
| Conflicts | last-write-wins | **conflict & dedup** resolution (duplicate merge / update supersede / contradiction link) |
| Structure | none | **memory graph** (entities, relations, `memory_links`) |
| Maintenance | manual distill | **consolidation** (clustering → derived memories with provenance) |
| Tools | 9 | 11 (`get_context`, `consolidate` added) |

## How to upgrade

1. Stop the server (and any auto-capture plugin using the DB).
2. `npm install` then `npm run build` (or `npm install -g th-memory-mcp` for the published version).
3. Start the server. On first connect it runs the migration engine
   (`src/db/migrations.ts`), which:
   - creates `schema_meta`, `entities`, `relations`, `memory_links`;
   - adds `summary`, `status`, `confidence`, `importance`, `salience`,
     `valid_from`, `valid_until`, `supersedes_id`, `metadata` to `memories`;
   - backfills v1 `preferences`/`lessons` rows into the unified `memories`
     table (v1 tables are left intact for rollback safety).
4. Done. Your v1 `recall`/`remember`/`save_lesson` flows still work unchanged.

> The migration is idempotent: re-running only applies migrations not yet
> recorded in `schema_meta`. Existing v1 tables (`preferences`, `lessons`,
> `interactions`) are **never dropped**.

## New tools

- **`get_context`** — assemble relevant memories for the current task. Options:
  `query`, `projectId`, `limit`, `maxTokens`, `includeHistory`, `includeGraph`.
- **`consolidate`** — cluster similar memories (embedding cosine) and optionally
  create derived/consolidated memories linked via `derived_from`.

## Behavior changes to note

- `recall` is unchanged for backward compatibility, but new code should prefer
  `get_context` for richer, conflict-aware assembly.
- Semantic search now uses a corrected embedding (de)serialization — v1's
  semantic scores were silently corrupted by a buffer-offset bug; v2 fixes it
  (see `src/lib/embed.ts`).
- Memories can be `superseded`/`archived`; `get_context` filters to currently
  valid memories by default (use `includeHistory: true` to include superseded).

## Rollback

Because v1 tables are preserved, you can downgrade by checking out v1.2.x and
pointing `MEMORY_DB_PATH` at the same file — the v2-only tables are simply
ignored. (The unified `memories` rows created by v2 backfill are additive and
do not alter v1 tables.)
