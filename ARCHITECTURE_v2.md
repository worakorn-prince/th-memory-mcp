# th-memory-mcp v2 — Architecture & Implementation Specification

**Status:** ✅ Released — `th-memory-mcp v2.0.0` is published (npm + Official MCP Registry + Glama).  
**Baseline:** v1.2.2 → **Current:** v2.0.0  
**Primary goal:** evolve th-memory-mcp from a structured local memory MCP into a durable, temporal, conflict-aware, hybrid-retrieval memory engine for AI agents.

> **Audience guide:** End users should read [README.md](README.md) (install, tools, usage). This document is the **canonical architecture & agent-rules spec** for developers and AI coding agents — the single source of truth for structure and behavior. The former `design.md` build log has been folded into §40 Implementation Status.

---

## 0. Executive Decision

v2 is a **refactor + controlled expansion**, not a rewrite and not a clone of Mem0, Zep/Graphiti, or Letta.

The project must retain these v1 properties:

- Local-first and offline by default.
- SQLite as the primary persistence layer.
- FTS5 and local semantic search.
- Thai/English support.
- Auto-capture and cross-harness compatibility.
- Secret filtering and safe export.
- Graceful degradation when memory is unavailable.
- Small MCP surface and bounded output.

v2 adds five core capabilities:

1. Unified memory model.
2. Temporal state and supersession.
3. Duplicate/conflict resolution.
4. Hybrid retrieval with ranking/fusion.
5. Context assembly with token budgeting.

Optional AI-assisted extraction/consolidation must never make the core memory engine dependent on an external LLM API.

---

# 1. Design Principles

## 1.1 Memory is data, not instructions

Stored memory must never override the agent's system/developer instructions or become executable instructions merely because it contains imperative text.

## 1.2 Event != memory

Raw interactions are evidence/feedstock. Long-term memories are derived, structured records.

```text
Interaction/Event
      ↓
Capture + filtering
      ↓
Extraction/classification
      ↓
Memory candidate
      ↓
Dedup/conflict resolution
      ↓
Persistent memory
```

## 1.3 Current truth and historical truth are both valuable

Old memories are not automatically deleted because they became stale. They can remain available for historical queries.

## 1.4 Deterministic-first

Core operations must work without an LLM:

- persistence
- FTS search
- semantic search
- metadata filtering
- scoring
- RRF fusion
- lifecycle transitions
- basic duplicate detection
- basic conflict detection

LLM assistance is optional for:

- difficult extraction
- ambiguous conflict resolution
- consolidation
- summarization/compression

## 1.5 Context is a projection of memory

The database is not the prompt. `get_context` selects a small, relevant, safe projection from persistent memory.

## 1.6 Failure must be non-fatal

Memory failures must not crash the host agent. MCP operations should return bounded diagnostic text where appropriate and continue gracefully.

---

# 2. High-Level Architecture

```text
                         AI AGENT
                            │
                           MCP
                            │
                    ┌───────▼────────┐
                    │  MEMORY API    │
                    └───────┬────────┘
                            │
              ┌─────────────┼─────────────┐
              │             │             │
              ▼             ▼             ▼
        CAPTURE ENGINE  RETRIEVAL      LIFECYCLE
              │          ENGINE         ENGINE
              │             │             │
              │      ┌──────┼──────┐      │
              │      │      │      │      │
              │     FTS   VECTOR  GRAPH  │
              │      │      │      │      │
              │      └──────┼──────┘      │
              │             │             │
              └─────────────┼─────────────┘
                            ▼
                     MEMORY STORE
                ┌─────────────────────┐
                │ SQLite              │
                │ FTS5                │
                │ local vectors       │
                │ entities/relations  │
                │ temporal metadata   │
                └──────────┬──────────┘
                           │
                     CONTEXT ENGINE
                           │
                           ▼
                        AI AGENT
```

---

# 3. Memory Taxonomy

Canonical memory types:

```text
FACT
PREFERENCE
GOAL
DECISION
CONSTRAINT
LESSON
PROCEDURE
EPISODE
RELATION
PROFILE
```

### Semantics

| Type | Purpose |
|---|---|
| FACT | durable factual information |
| PREFERENCE | user/project preference |
| GOAL | desired future outcome |
| DECISION | chosen approach and rationale |
| CONSTRAINT | hard requirement or prohibition |
| LESSON | correction-derived knowledge |
| PROCEDURE | reusable method/workflow |
| EPISODE | meaningful historical event |
| RELATION | entity relationship information |
| PROFILE | high-value compact user/project summary |

Types must be extensible internally, but these ten are the stable v2 vocabulary.

---

# 4. Memory Lifecycle

Every memory has a lifecycle state:

```text
NEW → ACTIVE
ACTIVE → REINFORCED → ACTIVE
ACTIVE → STALE
ACTIVE → SUPERSEDED
STALE → ARCHIVED
SUPERSEDED → ARCHIVED
ACTIVE → DELETED
ARCHIVED → DELETED
```

### Rules

- `ACTIVE`: eligible for normal retrieval.
- `STALE`: low priority; eligible when historical context is useful.
- `SUPERSEDED`: replaced by another memory; normally excluded from current-context retrieval.
- `ARCHIVED`: retained but excluded from default retrieval.
- `DELETED`: logically deleted unless hard-delete is explicitly requested.

A superseded memory should retain a pointer to the replacement.

---

# 5. Temporal Model

Each memory may have both record time and validity time:

```text
created_at
updated_at
last_accessed_at
valid_from
valid_until
```

`valid_until = NULL` means currently valid unless lifecycle state says otherwise.

Temporal questions must be supported conceptually:

- What is true now?
- What was true at time T?
- What changed?
- Which memory superseded this one?

Do not physically delete historical truth merely because it is no longer current.

---

# 6. Database Schema

The following is the logical v2 schema. Migration SQL may implement equivalent SQLite details, but semantics must remain compatible.

## 6.1 `memories`

```sql
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'explicit',
  confidence REAL NOT NULL DEFAULT 0.5,
  importance REAL NOT NULL DEFAULT 0.5,
  salience REAL NOT NULL DEFAULT 0.5,
  project_id TEXT,
  session_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_accessed_at TEXT,
  access_count INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT,
  valid_until TEXT,
  supersedes_id INTEGER,
  metadata TEXT,
  FOREIGN KEY (supersedes_id) REFERENCES memories(id)
);
```

### Required indexes

```sql
CREATE INDEX idx_memories_type_status ON memories(type, status);
CREATE INDEX idx_memories_project_status ON memories(project_id, status);
CREATE INDEX idx_memories_updated ON memories(updated_at);
CREATE INDEX idx_memories_validity ON memories(valid_from, valid_until);
CREATE INDEX idx_memories_supersedes ON memories(supersedes_id);
```

## 6.2 `interactions`

Retain raw behavior/event storage:

```sql
CREATE TABLE interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  meta TEXT
);
```

Interactions are not automatically long-term memories.

## 6.3 `entities`

```sql
CREATE TABLE entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  type TEXT,
  metadata TEXT
);
CREATE UNIQUE INDEX idx_entities_canonical ON entities(canonical_name);
```

## 6.4 `relations`

```sql
CREATE TABLE relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_entity_id INTEGER NOT NULL,
  relation TEXT NOT NULL,
  target_entity_id INTEGER NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  valid_from TEXT,
  valid_until TEXT,
  source_memory_id INTEGER,
  metadata TEXT,
  FOREIGN KEY (source_entity_id) REFERENCES entities(id),
  FOREIGN KEY (target_entity_id) REFERENCES entities(id),
  FOREIGN KEY (source_memory_id) REFERENCES memories(id)
);
```

## 6.5 `memory_links`

```sql
CREATE TABLE memory_links (
  source_memory_id INTEGER NOT NULL,
  relation TEXT NOT NULL,
  target_memory_id INTEGER NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  created_at TEXT NOT NULL,
  PRIMARY KEY (source_memory_id, relation, target_memory_id),
  FOREIGN KEY (source_memory_id) REFERENCES memories(id),
  FOREIGN KEY (target_memory_id) REFERENCES memories(id)
);
```

Supported link relations:

```text
supports
contradicts
supersedes
derived_from
related_to
caused_by
depends_on
```

## 6.6 `profile`

Retain compact profile sections for backward compatibility and fast injection:

```sql
CREATE TABLE profile (
  section TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

In v2, profile is a projection/cache of important memories, not the canonical source of truth.

---

# 7. Search Indexes

FTS5 remains mandatory.

Logical indexed fields:

```text
memory id
memory type
content
summary
project_id
```

The implementation may use a maintained FTS5 virtual table or separate indexes, but every mutation of searchable memory must keep indexes synchronized transactionally where possible.

Local semantic search remains supported. The implementation must preserve the dependency-light/offline property of v1.

---

# 8. Memory Source Model

Canonical source values:

```text
explicit
corrected
inferred
captured
consolidated
imported
system
```

Recommended source weights for confidence calculation:

| Source | Weight |
|---|---:|
| explicit | 1.00 |
| corrected | 0.95 |
| captured | 0.30 |
| inferred | 0.50 |
| consolidated | 0.75 |
| imported | 0.70 |
| system | 0.80 |

These are defaults, not immutable constants.

---

# 9. Confidence, Importance, Salience

All three values are normalized to `[0,1]`.

## 9.1 Confidence

Confidence reflects how trustworthy the memory is.

Recommended conceptual model:

```text
confidence = f(source_weight,
               confirmation_count,
               consistency,
               conflict_penalty)
```

Do not blindly increase confidence forever from duplicate saves. Repeated identical events should have diminishing returns.

## 9.2 Importance

Importance is durable significance. It should not decay merely because the memory is old.

Examples:

- hard project constraint: high
- architectural decision: high
- temporary debugging detail: low

## 9.3 Salience

Salience determines usefulness for a particular retrieval/context operation.

Recommended baseline:

```text
salience =
  0.30 * semantic_relevance +
  0.20 * importance +
  0.15 * confidence +
  0.15 * recency +
  0.10 * access_frequency +
  0.10 * project_relevance
```

Weights must be configurable and benchmarked.

---

# 10. Recency and Decay

Use a bounded exponential recency factor:

```text
recency = exp(-lambda * age_days)
```

Decay policy must depend on memory type.

| Type | Default decay |
|---|---|
| CONSTRAINT | very low |
| DECISION | low |
| LESSON | low |
| PREFERENCE | low |
| FACT | low/medium |
| GOAL | medium |
| PROCEDURE | low/medium |
| EPISODE | medium |
| RELATION | low/medium |
| PROFILE | derived |

These are policy classes, not fixed numeric constants.

---

# 11. Deduplication

Every `remember` candidate must pass duplicate detection before insertion.

Pipeline:

```text
normalize
  ↓
exact match
  ↓
canonical/key match
  ↓
FTS similarity
  ↓
semantic similarity (if available)
  ↓
DUPLICATE / UPDATE / DISTINCT
```

Duplicate detection must avoid merging memories that are merely similar but semantically different.

---

# 12. Conflict Resolution

This is a first-class v2 subsystem.

When a new candidate arrives:

```text
candidate
   ↓
find related active memories
   ↓
classify relationship
   ├── duplicate
   ├── update
   ├── contradiction
   └── unrelated
```

### Update/supersession

For a direct change:

```text
old memory: status = superseded
new memory: status = active
new memory.supersedes_id = old.id
```

Create a `supersedes` memory link when useful.

### Ambiguous conflict

If deterministic rules cannot safely decide, preserve both records and mark the relationship `contradicts`; do not silently destroy information.

---

# 13. Hybrid Retrieval

`recall` and `get_context` must use more than one retrieval signal.

```text
QUERY
 │
 ├── FTS5 keyword retrieval
 │
 ├── local semantic retrieval
 │
 ├── metadata/scope filtering
 │
 └── optional graph expansion
 │
 ▼
Candidate pool
 │
 ▼
RRF fusion
 │
▼
Scoring/reranking
 │
▼
Conflict/status filtering
 │
▼
Top K
```

## 13.1 Reciprocal Rank Fusion

Use RRF rather than directly mixing incompatible raw search scores:

```text
RRF(m) = Σ 1 / (k + rank_i(m))
```

Then apply memory-specific factors:

```text
final_score =
  RRF * confidence * importance_factor * recency_factor * scope_factor
```

The exact formula must be benchmarked.

---

# 14. Graph Retrieval

Graph is an augmentation, not the sole retrieval mechanism.

Default traversal should be shallow and bounded:

```text
seed entities/memories
      ↓
1-hop related entities
      ↓
related memories
```

Do not perform unbounded graph traversal during normal `recall`.

Graph boost should improve relationship queries without allowing weak graph edges to dominate strong direct evidence.

---

# 15. Context Engine

Introduce a first-class `get_context` operation.

Input concept:

```json
{
  "query": "current task",
  "project": "optional-project-id",
  "limit": 12,
  "token_budget": 1500,
  "include_history": false
}
```

Pipeline:

```text
query
 ↓
retrieve candidate memories
 ↓
filter stale/superseded records
 ↓
deduplicate
 ↓
resolve conflicts
 ↓
rank
 ↓
fit token budget
 ↓
assemble structured context
```

Output should be concise and machine-readable enough for agents to consume.

Recommended sections:

```text
Current Profile
Relevant Preferences
Constraints
Decisions
Lessons
Relevant Facts
Historical Context (only when requested/useful)
```

Default context should prioritize current project + active user constraints.

---

# 16. Persistent vs Archival Memory

Two logical tiers:

## Tier A — Persistent/Pinned

Small, high-value context that may be injected without retrieval:

- identity/profile essentials
- active goals
- critical constraints
- current project decisions

Target size: approximately 500–1500 tokens depending on host/context budget.

## Tier B — Archival

Searchable persistent memory:

- facts
- episodes
- lessons
- procedures
- historical decisions
- relations

Tier A is a projection/cache; Tier B remains the source of truth.

---

# 17. MCP Tool Surface

Do not expand to dozens of tools. v2.1.0 ships **16 tools** (the original spec targeted 14; the extra 2 are `consolidate` and `extract_memories`, which extend the v2 engine).

## Shipped (16 tools)

### Core / compatibility (carried from v1)
1. `remember` — store a memory using the unified model (type + metadata)
2. `recall` — hybrid FTS + semantic search (v1 behavior preserved)
3. `forget` — soft delete by default
4. `get_profile` — compact profile projection/cache
5. `search_history` — search raw interactions
6. `get_recent_interactions` — recent raw events
7. `memory_stats` — lifecycle/retrieval/storage metrics
8. `export_memory` — safe export confined to the allowed directory
9. `save_lesson` — compatibility alias/wrapper over `remember(type=LESSON)`

### v2 engine tools
10. `get_context` — token-budgeted context assembly (preferred agent-facing retrieval)
11. `consolidate` — cluster related memories + optional derived memory
12. `link_memory` — typed relationship between two memories in the graph
13. `merge_memory` — merge a duplicate into a canonical memory (source superseded, provenance in `metadata.merged_from`)
14. `update_memory` — update mutable fields in place, or create a superseding memory when `content` changes
15. `import_memory` — import memories from JSON (validates type, dedupes, dry-run by default)
16. `extract_memories` — scan recent interactions for memory-intent and propose/create memories (deterministic, no LLM; dry-run by default)

All 16 are documented in README.md. The four tools originally marked "deferred" in this spec (`update_memory`, `merge_memory`, `link_memory`, `import_memory`) plus `extract_memories` were implemented in v2.1.0.

---

# 18. Tool Contracts

## `remember`

```text
content: string
 type?: MemoryType
importance?: 0..1
confidence?: 0..1
project_id?: string
session_id?: string
source?: SourceType
valid_from?: ISO timestamp
valid_until?: ISO timestamp
metadata?: object
```

Returns:

```text
created | reinforced | updated | superseded | duplicate | conflict
memory id
short summary
```

## `recall`

```text
query: string
limit?: 1..50
project_id?: string
include_archived?: boolean
include_history?: boolean
```

Uses hybrid retrieval.

## `get_context`

```text
query?: string
project_id?: string
token_budget?: integer
limit?: integer
include_history?: boolean
```

This should be the preferred agent-facing retrieval operation for complex tasks.

## `update_memory`

Updates mutable fields without silently changing identity/history.

Changes to factual content that represent a new truth should create a superseding memory where appropriate. (Implemented in v2.1.0 — see `src/tools/update_memory.ts`.)

## `merge_memory`

Combines duplicate/near-duplicate memories while preserving provenance and source IDs. (Implemented in v2.1.0 — see `src/tools/merge_memory.ts`.)

## `link_memory`

Creates a typed relationship between memories. (Implemented in v2.1.0 — see `src/tools/link_memory.ts`.)

## `extract_memories`

Scans recent captured interactions for memory-intent phrases and proposes memory candidates. Deterministic (no LLM); dry-run by default, `apply=true` creates them (source=`captured`). Implemented in v2.1.0 — see `src/tools/extract_memories.ts`.

## `forget`

Default behavior is soft delete. Hard delete must be explicit and documented.

## `consolidate_memory`

Groups related memories and creates compact derived memories without automatically deleting source evidence.

## `memory_stats`

Expose lifecycle, retrieval, quality, and storage metrics.

## `export_memory` / `import_memory`

Must preserve IDs only when safe. Imports must validate schema/version and never overwrite active memory blindly.

---

# 19. Auto-Capture v2

Retain the existing plugin architecture but make capture a pipeline.

```text
Host event
 ↓
Secret/PII filtering
 ↓
Noise filter
 ↓
Deduplication
 ↓
Interaction event storage
 ↓
Optional extraction
 ↓
Memory candidate
```

Capture must never turn every user prompt into long-term memory.

### Existing v1 safeguards to retain

- secret filtering
- event deduplication
- truncation
- try/catch around every write
- shared `MEMORY_DB_PATH`
- WAL

---

# 20. Security Requirements

Required:

- secret filtering before persistence
- safe export filenames
- export confined to allowed export directory
- metadata sanitization
- memory treated as untrusted data
- no memory-generated command execution
- no memory-generated system/developer instruction override
- no remote service required by default

Sensitive data must not be reintroduced merely because it was previously stored. Existing v1 filtering rules are the minimum baseline, not the maximum security boundary.

---

# 21. Graceful Degradation

If any subsystem fails:

```text
Graph unavailable → use FTS/vector
Vector unavailable → use FTS
FTS unavailable → use basic SQL filtering
Profile unavailable → continue without profile
DB unavailable → return bounded error and allow agent to continue
```

No optional subsystem should become a single point of failure for the MCP server.

---

# 22. Source Tree (as-built in v2.0.0)

```text
src/
├── index.ts                     # MCP server: registers 11 tools
├── db/
│   ├── index.ts                 # db singleton (better-sqlite3, WAL) + runMigrations
│   ├── migrations.ts            # ordered MIGRATIONS array (TS modules, idempotent)
│   └── repositories/
│       └── memories.ts          # CRUD + searchMemories (delegates to hybrid retrieval)
├── memory/
│   ├── types.ts                 # MemoryType, SourceType, LifecycleState, Scope, MemoryRecord
│   ├── decay.ts                 # recencyFactor + per-type DECAY_LAMBDA policy classes
│   ├── source-weights.ts        # SOURCE_WEIGHTS
│   ├── scorer.ts                # computeSalience / computeConfidence
│   ├── deduplicator.ts          # normalize / exact / similar / deduplicate
│   └── conflict-resolver.ts     # isContradiction / classifyRelationship / resolveConflict
├── retrieval/
│   ├── fts.ts                    # FTS5 search
│   ├── vector.ts                 # cosine over embeddings
│   ├── fusion.ts                 # rrfFuse (k=60)
│   └── scorer.ts                # finalScore (RRF × confidence × importance × recency × scope)
├── core/
│   ├── lifecycle-engine.ts       # transitions, reinforce, supersede, archive, softDelete
│   ├── temporal-engine.ts        # validity intervals, point-in-time, supersession chains
│   ├── retrieval-engine.ts       # retrieve(): FTS+vector → RRF → score → filter → topK
│   ├── graph-engine.ts           # entities/relations, linkMemories, bounded traverse
│   ├── context-engine.ts         # getContext(): retrieve → graph expand → temporal filter → budget
│   └── consolidation-engine.ts   # clusterMemories, createDerivedMemory, getProvenance
├── tools/
│   ├── context.ts                # get_context tool
│   └── consolidate.ts            # consolidate tool
├── lib/
│   └── embed.ts                  # hashing-trick embed + DataView serialize/deserialize (fixed in v2)
└── plugin/
    └── learning-capture.ts        # Bun auto-capture plugin (OpenCode)
scripts/
└── claude-capture.mjs            # Claude Code hook capture
test/
└── *.test.mjs                     # 20 suites (capture, distill, lifecycle, temporal, conflict,
                                   #   retrieval, graph, context, consolidation, benchmark, security,
                                   #   tools_v21, smoke, e2e_transport, retrieval_benchmark, recall_regression, scope, profile, entity_extraction, conflict_benchmark)
```

Compatibility wrappers keep the old `remember`/`recall`/etc. tool names; v2 internals live under `core/`, `memory/`, `retrieval/`.

---

# 23. Migration Strategy v1 → v2

Migration must be non-destructive.

## Phase M0 — Backup

Before any schema migration:

1. Verify DB exists.
2. Create timestamped backup.
3. Verify SQLite integrity.
4. Record current schema version.

## Phase M1 — Introduce migration metadata

Create:

```sql
CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

Store `schema_version`.

## Phase M2 — Preserve old tables

Do not immediately delete:

```text
preferences
lessons
interactions
profile
```

## Phase M3 — Convert

Map:

```text
preferences → memories(type=PREFERENCE)
lessons → memories(type=LESSON)
profile → profile projection/cache
interactions → interactions unchanged
```

Preserve original IDs in metadata when IDs cannot be retained directly.

## Phase M4 — Rebuild indexes

Recreate FTS and semantic indexes from canonical v2 memory records.

## Phase M5 — Validate

Checks:

- row counts
- content hashes/sample comparisons
- FTS availability
- memory type mapping
- profile availability
- export availability

Only after validation may v2 consider old tables deprecated.

---

# 24. Migration Files (as-built)

Migrations are **TypeScript modules** in `src/db/migrations.ts`, not `.sql` files. Each entry is an idempotent `up(db)` (`CREATE TABLE IF NOT EXISTS`) tracked in `schema_meta`. This avoids `.sql` file-copy issues under `tsc` while keeping deterministic order. The logical schema in §6 is the contract; the TS implementation realizes it.

Ordered migrations applied in v2.0.0:

1. `schema_meta` table
2. `memories` + indexes
3. `entities` / `relations`
4. `memory_links`
5. v1 backfill (`preferences → PREFERENCE`, `lessons → LESSON`, sync FTS + embeddings; guarded by `v1_backfilled` flag, runs once)

The spec allowed implementation differences ("Exact SQL can differ if implementation constraints require it"); the TS approach is the chosen realization.

---

# 25. Testing Strategy

Tests must be layered.

## Unit tests

- classification
- secret filtering
- normalization
- duplicate detection
- conflict classification
- confidence
- decay
- scoring
- RRF
- token budgeting
- filename sanitization

## Integration tests

- SQLite migration
- FTS sync
- semantic retrieval
- graph relations
- lifecycle transitions
- import/export

## MCP E2E

Run real JSON-RPC against the built server.

## Plugin tests

- prompt capture
- tool event capture
- dedupe
- secret filter
- graceful DB failure
- profile/context injection

---

# 26. Retrieval Benchmark

Create:

```text
benchmark/
├── datasets/
├── retrieval/
├── conflict/
├── temporal/
├── lifecycle/
└── performance/
```

Baseline dataset should contain:

- at least 500 memories
- at least 100 distractors
- at least 100 duplicates
- at least 100 contradictions/updates
- at least 100 temporal changes

Measure:

```text
Recall@1
Recall@5
Recall@10
Precision@5
MRR
NDCG
```

Initial engineering targets:

```text
Recall@5 >= 0.90
Precision@5 >= 0.85
MRR >= 0.85
```

Targets are project acceptance goals, not claims about competitor performance.

---

# 27. Conflict Benchmark

Target:

```text
>= 95% correct classification/resolution
```

Test cases must include:

- exact duplicate
- paraphrase duplicate
- preference update
- direct contradiction
- temporary exception
- two valid but different scoped memories
- ambiguous conflict

Ambiguous cases must prefer preservation over destructive guessing.

---

# 28. Temporal Benchmark

Queries must test:

```text
current truth
historical truth
change detection
supersession chain
```

No stale record may override an active current record in default current-context retrieval.

---

# 29. Performance Targets

On a normal local development machine, initial targets are:

| Operation | Target |
|---|---:|
| remember | <20 ms typical |
| recall | <50 ms typical |
| get_context | <100 ms typical |
| get_profile | <20 ms typical |
| search_history | <30 ms typical |

These are engineering targets, not guaranteed SLAs.

Benchmark both cold-cache and warm-cache behavior where practical.

---

# 30. Token Efficiency

Every retrieval operation must have a bounded output.

`get_context` must support an explicit token/character budget.

Do not return all matching memories merely because they match.

Target behavior:

```text
candidate pool: 50
 ↓
rank: 20
 ↓
filter: 12
 ↓
budget: 5–15 useful memories
 ↓
compact context
```

---

# 31. Consolidation

Consolidation creates higher-level semantic memories from clusters of related evidence.

Example:

```text
User prefers TypeScript.
User chooses TypeScript for projects.
User corrected code examples from Python to TypeScript.
```

Can produce:

```text
User prefers TypeScript for software projects.
```

The derived memory must retain provenance:

```text
derived_from → source memories
```

Source evidence must not be deleted automatically.

---

# 32. Decision Memory

`DECISION` should support optional rationale and alternatives in metadata.

Example:

```json
{
  "type": "DECISION",
  "content": "Use SQLite for local persistence",
  "metadata": {
    "reason": [
      "local-first",
      "simple deployment",
      "sufficient performance"
    ],
    "alternatives": ["PostgreSQL", "Neo4j"]
  }
}
```

This prevents agents from repeatedly reopening already-settled architecture decisions.

---

# 33. Scope Resolution

Supported scope hierarchy:

```text
GLOBAL
  ↓
USER
  ↓
PROJECT
  ↓
SESSION
```

For current project queries, prefer:

```text
PROJECT > USER > GLOBAL > ARCHIVED
```

Session-specific temporary information should not silently become global memory.

---

# 34. Compatibility Requirements

v2 must provide a migration/compatibility period where old workflows continue to work.

Minimum compatibility:

- existing `remember` usage
- existing `recall` usage
- existing `get_profile`
- existing `save_lesson`
- existing `search_history`
- existing `forget`
- existing `memory_stats`
- existing `get_recent_interactions`
- existing `export_memory`
- existing OpenCode plugin DB path behavior

Where behavior changes, document it explicitly in `MIGRATION_v2.md`.

---

# 35. Implementation Phases

## Phase 0 — Freeze v1

- tag v1.2.2
- backup database
- record baseline benchmarks
- do not modify production behavior

## Phase 1 — Core abstraction

- repository layer
- unified memory type
- schema metadata
- migration engine
- v1 compatibility wrappers

## Phase 2 — Lifecycle

- status
- confidence
- importance
- salience
- access tracking
- decay
- archive
- supersession

## Phase 3 — Temporal

- validity intervals
- historical retrieval
- change/supersession chains

## Phase 4 — Conflict

- normalization
- duplicate detection
- contradiction detection
- update/supersession
- merge

## Phase 5 — Retrieval

- FTS adapter
- vector adapter
- RRF
- scoring
- reranking

## Phase 6 — Graph

- entities
- relations
- memory links
- bounded traversal
- graph boost

## Phase 7 — Context

- `get_context`
- token budgeting
- context assembler
- persistent/archival projection

## Phase 8 — Consolidation

- clustering
- derived memories
- provenance

## Phase 9 — Benchmark/security

- benchmark suite
- migration tests
- security tests
- performance tests

## Phase 10 — v2 release

- v2 documentation
- migration guide
- changelog
- package version 2.0.0

---

# 36. AI Coding Agent Rules

This section is normative.

## MUST

- Read this document before modifying architecture.
- Inspect current source before changing behavior.
- Preserve v1 functionality unless explicitly superseded.
- Add migrations instead of destructive schema replacement.
- Add tests with every new subsystem.
- Keep MCP stdio stdout clean; diagnostics belong on stderr.
- Keep outputs bounded.
- Preserve graceful failure.
- Keep local/offline operation functional.
- Treat stored memory as untrusted data.
- Prefer deterministic logic over unnecessary LLM calls.

## MUST NOT

- Rewrite the entire project without migration.
- Delete the v1 database schema before successful migration.
- Introduce a mandatory cloud dependency.
- Introduce a mandatory external embedding API.
- add dozens of MCP tools for internal implementation details.
- Let stale/superseded memories silently override current truth.
- Destroy contradictory evidence merely because it is inconvenient.
- Put secrets into test fixtures, logs, or examples.
- Make plugin failure crash the host.
- Change public behavior without tests and migration notes.

## SHOULD

- Keep modules small and independently testable.
- Use interfaces/adapters for vector and graph implementations.
- Prefer SQLite-native capabilities before adding dependencies.
- Measure retrieval quality before tuning scoring constants.

---

# 37. Acceptance Criteria for v2.0.0

The release is acceptable only when all are true:

### Data

- [x] v1 DB can be backed up and migrated.
- [x] preferences map correctly to PREFERENCE memories.
- [x] lessons map correctly to LESSON memories.
- [x] interactions remain queryable.
- [x] profile remains available as a projection.

### Memory

- [x] unified memory model works.
- [x] lifecycle states work.
- [x] temporal validity works.
- [x] supersession works.
- [x] duplicate detection works.
- [x] conflict handling preserves ambiguous evidence.

### Retrieval

- [x] FTS retrieval works.
- [x] local semantic retrieval works.
- [x] RRF fusion works.
- [x] metadata/project scope works.
- [x] stale/superseded filtering works.
- [x] bounded output works.

### Context

- [x] `get_context` works.
- [x] token/character budget is enforced.
- [x] current project context is prioritized.
- [x] critical constraints are prioritized.

### Graph

- [x] entity/relation persistence works.
- [x] memory links work.
- [x] graph traversal is bounded.
- [x] graph failure does not break retrieval.

### Security

- [x] secrets are filtered before storage.
- [x] exports are confined to the allowed directory.
- [x] memory cannot become executable instructions.
- [x] import validates schema/version.

### Reliability

- [x] DB errors do not crash the MCP server.
- [x] plugin errors do not crash the host.
- [x] stdout remains protocol-safe.

### Quality

- [x] retrieval benchmark passes project targets.
- [x] conflict benchmark meets >=95% target.
- [x] migration tests pass.
- [x] performance targets are measured and documented.

---

# 38. Recommended v2 Positioning

Do not market v2 as "another Mem0".

Position it as:

> **A local-first, privacy-focused, temporal memory MCP for AI coding agents, with hybrid retrieval, conflict-aware memory, and token-efficient context assembly.**

The differentiators are:

1. Local-first.
2. SQLite simplicity.
3. No mandatory API/cloud.
4. Thai/English friendliness.
5. Cross-harness portability.
6. Temporal + conflict-aware memory.
7. Small MCP interface.
8. Agent-oriented context assembly.

---

# 39. Final Architecture Contract

The canonical v2 flow is:

```text
                    ┌──────────────────┐
                    │    AI AGENT      │
                    └────────┬─────────┘
                             │ MCP
                    ┌────────▼─────────┐
                    │  MEMORY API      │
                    └────────┬─────────┘
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
          ▼                  ▼                  ▼
       CAPTURE          RETRIEVAL          LIFECYCLE
          │                  │                  │
          │        ┌─────────┼─────────┐        │
          │        │         │         │        │
          │       FTS      VECTOR     GRAPH     │
          │        │         │         │        │
          │        └─────────┼─────────┘        │
          │                  │                  │
          └──────────────────┼──────────────────┘
                             ▼
                    ┌────────────────┐
                    │ MEMORY STORE   │
                    │ SQLite + FTS5  │
                    │ vectors + graph│
                    │ temporal state │
                    └───────┬────────┘
                            │
                    ┌───────▼────────┐
                    │ CONTEXT ENGINE │
                    │ rank/filter    │
                    │ dedupe/compress│
                    │ token budget   │
                    └───────┬────────┘
                            │
                            ▼
                         AI AGENT
```

**This document is the implementation source of truth for th-memory-mcp v2 unless a later version explicitly supersedes it.**

---

# 40. Implementation Status (as-built, v2.1.0)

This section folds in the former `design.md` build log. All v2 engine phases are complete and tested. v2.1.0 adds the five previously-deferred tools.

## What shipped (v2.0.0 + v2.1.0)
- **16 MCP tools** (see §17). `save_lesson` retained as a compatibility wrapper. The four tools originally marked deferred (`update_memory`, `merge_memory`, `link_memory`, `import_memory`) plus `extract_memories` landed in v2.1.0.
- **Non-destructive migration** from v1.2.2: v1 tables preserved; `memories`/`entities`/`relations`/`memory_links`/`schema_meta` added; one-time backfill of preferences + lessons.
- **Hybrid retrieval**: FTS5 + local semantic (hashing-trick vectors) fused via RRF, then scored by confidence × importance × recency × scope.
- **Temporal model**: validity intervals, point-in-time retrieval, supersession chains, change detection.
- **Conflict/dedup**: normalize → exact → similar → classify (duplicate/update/contradiction/unrelated); ambiguous conflicts preserved, never silently destroyed.
- **Graph**: entities/relations + bounded memory-link traversal (maxDepth 1–5); `link_memory` exposes it publicly.
- **Context engine**: `get_context` with token budgeting, temporal filtering, optional graph expansion.
- **Consolidation**: clustering + derived memories with `derived_from` provenance.
- **Auto-extraction**: `extract_memories` scans recent interactions for memory-intent (deterministic, no LLM) and proposes/creates memories.
- **Security**: secret filtering, parameterized SQL, FTS-injection quoting, memory treated as untrusted data, bounded output.

## Phase checklist
- [x] Phase 1 — Core abstraction (types, migrations, repository, index wiring)
- [x] Phase 2 — Lifecycle engine (decay, source-weights, scorer, transitions)
- [x] Phase 3 — Temporal model
- [x] Phase 4 — Conflict & dedup (+ fixed v1 `embed.ts` DataView bug)
- [x] Phase 5 — Hybrid retrieval (FTS/vector/fusion/scorer/engine)
- [x] Phase 6 — Graph engine
- [x] Phase 7 — Context engine (`get_context`)
- [x] Phase 8 — Consolidation (`consolidate`)
- [x] Phase 9 — Benchmark + security suites (20 test suites total)
- [x] Phase 10 — Docs + v2.0.0 release (npm, GitHub Release, Official MCP Registry, Glama)
- [x] v2.1.0 — `link_memory` / `merge_memory` / `update_memory` / `import_memory` / `extract_memories` (16 tools, 20 suites)

## Test status
All 20 test suites pass (capture, distill, lifecycle 17, temporal 7, conflict 14, retrieval 7, graph 7, context 7, consolidation 5, benchmark 2, security 5, tools_v21 21, smoke 16-tool, e2e_transport, retrieval_benchmark, recall_regression, scope, profile, entity_extraction, conflict_benchmark).

## Resolved gaps vs original spec (all addressed — no regressions)
- ✅ DONE — Retrieval quality benchmark (§26): measured in-repo (`test/retrieval_benchmark.test.mjs`), meets targets (Recall@5=1.00, Precision@5=0.92, MRR=1.00 on a 700-memory baseline).
- ✅ DONE — Conflict-resolution quality benchmark (§27, ≥95% correct classification): measured in-repo (`test/conflict_benchmark.test.mjs`), 100% accuracy on a 14-case labeled set covering all 7 required categories (exact/paraphrase duplicate, preference update, direct contradiction, temporary exception, two valid scoped memories, ambiguous conflict). Ambiguous opposite-preference pairs preserved as `contradiction` (linked), never silently superseded.
- ✅ DONE — Perf targets (§29): measured in CI via the perf benchmark suite (`test/benchmark.test.mjs`); all per-op latencies meet targets.
- ✅ DONE — USER scope (migration 007: `users` table + `memories.user_id`). Clients pass `userId` (external identity) to `import_memory`, `extract_memories`, and `get_context`; `createMemory` derives `USER` scope and auto-creates the user row. `scopeFactorFor` boosts USER-scoped memories (1.0) for the matching user and penalizes foreign ones (0.3); SESSION/PROJECT/GLOBAL isolation unchanged. Preferences and lessons remain global (no user column).
- Trust model: `userId` is client-declared (no authentication). This is acceptable for the intended single-user local deployment where the SQLite DB file is private to its owner. Multi-user isolation, if ever required, should be solved at the DB-file level (one DB per user/session), not by adding auth to the engine.
- ✅ DONE — Auto entity extraction in consolidation (`src/core/entity-extractor.ts`, wired into `consolidate`).

## Future-feature backlog (resolved)
All previously-deferred future features are implemented. AI-assisted extraction was dropped by owner decision and is not developed.
- [x] E2E MCP transport test — `test/e2e_transport.test.mjs`
- [x] Retrieval quality benchmark (§26) — `test/retrieval_benchmark.test.mjs`
- [x] Perf benchmark (§29) in CI — `test/benchmark.test.mjs` + `.github/workflows/ci.yml`
- [x] CI pipeline — `.github/workflows/ci.yml` (ubuntu-latest, node 20, `npm ci`, `npm test`)
- [x] Scope hierarchy USER/SESSION/PROJECT/GLOBAL — migrations 006 + 007
- [x] Profile auto-projection — `src/tools/profile.ts`
- [x] Auto entity extraction in consolidation — `src/core/entity-extractor.ts`
- [x] Conflict-resolution quality benchmark (§27) — `test/conflict_benchmark.test.mjs`

## Release
- v2.0.0: released — npm `th-memory-mcp@2.0.0` (latest), GitHub Release `v2.0.0`, Official MCP Registry `io.github.worakorn-prince/th-memory-mcp@2.0.0`, Glama listed.
- v2.1.0: implemented and tested locally; publish skipped (superseded by v2.2.0).
- v2.2.0: fully released — tag + GitHub Release, **npm published** (`th-memory-mcp@2.2.0`), Official MCP Registry auto-ingested from npm (manual `mcp-publisher publish` is redundant and errors `duplicate version`), Glama synced. Only `npm publish` + Glama Sync are required.
