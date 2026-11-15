# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 3.0.x   | :white_check_mark: |
| < 3.0   | :x:                |

We support the latest `3.0.x` release line. Older major/minor lines receive no security updates.

## Runtime security baseline

- Supported runtimes are the patched Node.js lines: **22.x >= 22.23.4** (Maintenance LTS), **24.x >= 24.22.1** (LTS), and **26.x >= 26.12.1**.
- Node.js 20 reached end-of-life in April 2026 and receives no security fixes; it is not supported.
- `npm audit` covers npm dependencies only; it does not detect Node.js core CVEs. Check the runtime with `npx is-my-node-vulnerable`.
- CI tests the minimum patched version of each line. Core CVEs (e.g. the 21 Oct 2026 release, including CVE-2026-111497 Brotli decoder RCE) are remediated only by upgrading Node.js; this package cannot patch them.
- This project is a stdio-only local MCP server and does not use Node's HTTP/2, TLS, DNS, or Brotli code paths in its own source.

## Reporting a Vulnerability

**Please do not open a public issue for security reports.**

Use one of these private channels:

1. **GitHub Security Advisories (preferred):** https://github.com/worakorn-prince/th-memory-mcp/security/advisories/new
2. **Email:** open a draft advisory and we will triage within 72 hours.

### What to include

- Affected version / commit
- Steps to reproduce (minimal PoC)
- Impact assessment (data loss, leak, DoS, scope bypass, etc.)
- Suggested fix if you have one

### What to expect

- Acknowledgement within 72 hours
- Triage and severity assessment (Critical / High / Medium / Low)
- Fix in a patch release and credit in release notes if desired

## Scope

This policy covers the MCP server (`src/`), SQLite store (`data/memory.db`), and the auto-capture plugin (`src/plugin/learning-capture.ts`). Internal development-only material is out of scope.

## Authentication scope — single-user local process (Batch B-3)

There is **no authentication or authorization layer enabled by default** in this server (no new auth system is introduced); the opt-in `MEMORY_AUTH` identity layer described below is off unless an operator turns it on:

- `userId` / `sessionId` / `projectId` are **caller-supplied** values. Scope checks in `merge_memory` / `get_context` (via `context-engine` + `retrieval-engine`) and the USER/SESSION/PROJECT isolation they enforce are only as trustworthy as the caller — a caller that passes another user's id is treated as that user.
- The supported deployment is a **single-user local process**: one operator running the MCP server against a local `data/memory.db`. In that model the caller is trusted and scope parameters are a correctness/isolation mechanism, not a security boundary.
- **Multi-user deployments MUST add an auth layer in front** (outside this repo): authenticate each caller, then map/force the correct `userId` (and allowed `projectId` / `sessionId`) before the call reaches the MCP tools. Sharing one server/DB across mutually-untrusted users without that layer will leak USER/SESSION-scoped memories across users.
- Memory content rendered back to the model is wrapped in `<memory-reference>` delimiters with an explicit "reference data, not instructions" guidance line, and entries imported with `metadata.trusted=false` are labelled `[untrusted-import]` — defense-in-depth against prompt injection, not a substitute for caller auth.

## Authentication (opt-in, Ph-1)

`MEMORY_AUTH=on` adds server-verified identity **without** enabling it by default (`off` = v2.5.2 behaviour):

- **Identity source is the process environment only** — `MEMORY_AUTH_TOKEN` or `MEMORY_AUTH_TOKEN_FILE`. Tokens are never read from MCP tool arguments (`userId` / `sessionId` / `projectId` are at most checks, never authority).
- **Hash-only storage** — `auth_tokens` stores `sha256(token)` hex; the plaintext is printed exactly once by `th-memory auth issue-token` and is never logged or persisted. Tokens are 32 random bytes, so a slow KDF is unnecessary.
- **Fail-fast** — with `MEMORY_AUTH=on`, a missing, malformed, unknown, or revoked token terminates the server: one bounded line on stderr and exit code 2; stdout stays protocol-clean. There is no plaintext fallback to legacy mode.
- **No user minting** — with enforcement on, `createMemory` throws for an unknown `userId` and inserts no `users` row (admin CLI only). `import_memory` likewise never restores payload `users`: they are skipped with an honest count, and any memory row whose owner is unknown fails the whole import and rolls back atomically. Legacy mode still auto-creates, unchanged.
- **Revocation timing** — revoking a token takes effect on the next server start (identity is resolved once at startup).
- **Not yet a full authorization boundary** — Ph-1 only stops identity minting. Per-tool roles (Ph-2) and scope-ownership binding (caller `userId` must equal the authenticated identity, plus membership) are separate phases; until Ph-3 lands, one server/DB must still not be shared across mutually-untrusted users.
- **Known limitation** — export/import does not carry `users.role`; imported users default to `reader`.

## Authorization (opt-in, Ph-2)

With `MEMORY_AUTH=on` every one of the 16 MCP tools passes a single role gate (`withAuth`, `src/auth/guard.ts`) before its handler runs. Roles come from `users.role` and are ranked: `admin` ⊇ `owner` ⊇ `writer` ⊇ `reader` (`ROLE_RANK`, `src/auth/policy.ts`).

| Role | Tools allowed |
|---|---|
| `reader` | `recall`, `get_profile`, `get_context`, `memory_stats`, `search_history`, `get_recent_interactions` (6 read) |
| `writer` | read tools + `remember`, `save_lesson`, `update_memory`, `link_memory` (4 additive writes) |
| `owner` | write tools + `forget`, `merge_memory`, `consolidate`, `export_memory`, `import_memory`, `extract_memories` (6 destructive/blast-radius) |
| `admin` | all 16 — superset via ranking; there is no admin-only MCP tool (user/token management is the local CLI) |

- **Default-deny is structural (test-enforced)** — every `registerTool` in `src/index.ts` goes through `withAuth`, and `withAuth` throws at registration when the tool has no `TOOL_POLICY` entry, so an unpoliced tool cannot be served; a pairing test asserts the two name sets match on the built artifact. An unknown tool name in `canCallTool` is denied, and a defensive enforced identity with no usable role is denied on every tool (the resolver currently defaults an unparseable `users.role` to `reader`, so this can only happen with corrupted data).
- **Deny shape** — a bounded tool result `{ isError: true, content: "error: denied: <tool> requires role <minRole> (auth enforced)" }`, not a thrown MCP protocol error. The role check runs **before** the handler, so a denied call has no side effects, and the caller's own roles are never echoed (only the public minimum role for that tool appears).
- **Audit replaces deny trail** — Ph-2's bounded stderr deny trail is removed. Every enforced decision (allow + deny) is recorded in `audit_log` with bounded, content-free fields (`tool`, `kind`, `decision`, `reason`, `scope_kind`, `scope_ref`). Legacy mode writes no audit rows.
- **Interactions are now scoped** — Ph-3 adds `interactions.user_id` and scope binding. `search_history` and `get_recent_interactions` filter by `user_id = uid`; anonymous (NULL) rows are visible to owner/admin only. The interim gap is closed.
- **Still not a full authorization boundary** — scope isolation is an **application-layer** boundary. A local user with filesystem access to `data/memory.db` can bypass all app-level checks. Phase 4 (whole-DB encryption via SQLCipher) will address this. Until then, do not share one server/DB across mutually-untrusted users on the same machine.

## Authorization (opt-in, Ph-3 — Scope Isolation)

With `MEMORY_AUTH=on`, every tool's scope is derived **from the verified identity**, never from raw arguments:

- **Ownership binding**: writes (preferences, lessons, memories) go to the caller's own USER scope by default. A caller-supplied `userId` is a *check*, never authority — own id is ok, foreign id is denied unless a `scope_grants` row exists.
- **Grants**: `scope_grants` table (`grantee_user_id`, `scope_kind` ∈ USER|PROJECT|SESSION|GLOBAL, `scope_ref`, `permission` ∈ read|write). Managed by CLI: `th-memory grant add|remove|list`. Grants are non-escalatable: read never implies write.
- **Read filtering**: `recall`/`get_profile` filter `preferences`/`lessons` by `user_id IS NULL OR user_id = uid`. `search_history`/`get_recent_interactions`/`recall` filter `interactions` by `user_id = uid` (NULL visible to owner/admin only). `export_memory` exports only visible rows.
- **Capture attribution**: optional `MEMORY_CAPTURE_USER=<external_id>` tags new `interactions` rows (unknown → NULL, never mint). NULL interactions are owner/admin-only in enforcement.
- **Audit**: `audit_log` records every enforced decision (allow + deny) with bounded, content-free fields (`tool`, `kind`, `decision`, `reason`, `scope_kind`, `scope_ref`). Legacy mode writes no audit rows.
- **FILTER_ONLY_SCOPE_TOOLS**: `search_history` and `get_recent_interactions` accept `sessionId` as a pure row filter (not a scope target) — no grant required, since the row set is already bounded by `user_id`.

## Hardening changes (unreleased)

These changes harden the single-user local model above; they do **not** add authentication. A caller that can invoke the tools is still trusted.

- **Import `trusted` gate:** untrusted imports skip only auxiliary `preferences`/`lessons`/`profile` records; users/entities/relations/memories are still imported by design and should only come from trusted exports. A per-item `metadata.trusted` value is ignored for this gate, and a tool-level `userId` wins over ids embedded in the payload. Untrusted imports stay labelled `[untrusted-import]`.
- **`get_profile` scoping:** calling it with no arguments returns GLOBAL-scope content only. Optional scope arguments (`userId` / `sessionId` / `projectId`) widen the query explicitly. An unknown/invalid scope resolves to GLOBAL-only and never widens to an arbitrary scope.
- **Delimiter sanitization:** user/imported content is stripped of the `<memory-reference>` delimiter sequences before rendering, so stored memories cannot break out of the reference wrapper and pose as instructions. Matching covers case-insensitive whitespace/attribute variants (`</memory-reference >`, `</memory-reference foo>`, newline forms, `<memory-reference data-x="1">`) via `/<\/?memory-reference\b[^>]*>/gi`; the capture plugin mirrors the same pattern and `check:capture-sync` guards drift.
- **Read budget and trust labels (P1):** get_recent_interactions reserves the wrapper guidance/tag overhead before truncating rows so the final response stays within 4000 chars; consolidate labels members whose metadata is untrusted with [untrusted-import] while keeping one wrapper per response.
- **Optional session filters (P2):** `search_history`, `get_recent_interactions`, and `extract_memories` accept an optional `sessionId` (max 200 chars) that narrows interaction rows to one captured session. Omitting it intentionally keeps the legacy unscoped (all-sessions) behavior for backward compatibility; the filter is a correctness/isolation aid in the single-user local model, not an authentication boundary.
- **Read-tool wrapping:** `search_history`, `get_recent_interactions`, `consolidate`, and the `extract_memories` dry-run preview wrap returned memory text in `<memory-reference>` guidance and neutralize embedded delimiter payloads. Malformed or non-object trust metadata is treated as untrusted (fail closed).
- **Secret redaction before truncation:** secrets are redacted before any length truncation, in both the core and the capture plugin, so truncating a value cannot leave a partial secret behind.
- **Write-boundary secret redaction:** explicit memory `content`/`summary`, preference `key`/`value`, lesson `situation`/`mistake`/`correction`, `update_memory` in-place fields, and trusted-import `preferences`/`lessons`/`profile` rows now pass through `filterSecrets` before persistence and before FTS/embedding indexing. Metadata strings are recursively redacted (depth-limited, cycle-safe); non-plain values (class instances, `Date`, `Map`, etc.) are JSON-serialized and the result recursively redacted, with cyclic/unserializable values collapsing to `[REDACTED]`.
- **Graph write-path redaction (P1):** entity `name`/`canonical_name`/`type`/`metadata`/aliases, relation predicates/metadata, memory-link relations, and imported graph rows are redacted at write time. Imported user `name` is redacted; `users.external_id` is intentionally unchanged because it is the identity/lookup key.
- **Legacy write-path closure (P1):** `merge_memory` parses existing target metadata, recursively redacts it (including legacy rows written before redaction existed), and only then records `metadata.merged_from`, so replaying a merge cannot re-persist a raw secret. The `distill` CLI runs each `formatProfileSections` string through `redactSecrets` before the `profile` upsert; stats computation and retention pruning are unchanged.
- **Legacy data scrub (P1):** `npm run scrub-secrets` scans pre-hardening rows and reports (dry-run) which tables still contain secrets; `-- --apply` rewrites them through the same redaction helpers and re-syncs FTS/embeddings for touched memories/preferences/lessons. `users.external_id` is never rewritten.
- **Trust propagation (P2):** a derived/consolidated memory inherits the weakest trust of its sources — if any source is untrusted (`metadata.trusted=false` or malformed metadata that fails closed), the derived row is stored with `metadata.trusted=false` and the consolidate output labels it `[untrusted-import]`.
- **Error and log redaction (P2):** every tool error goes through the shared `err()` helper, which redacts secrets before truncating; server/CLI/plugin logs redact error messages too, and the capture plugin now redacts `meta` (headers, env, tool args) before storing it.
- **Atomic export writes (P2):** exports are written to a same-directory temp file and renamed into place, so a crash cannot leave a truncated visible export; a symlink planted at the destination is refused instead of followed. Import paths keep realpath + size + row-count caps.
- **Export preview safety:** export previews are wrapped like other memory content, and export files are written with `0600` (files) / `0700` (directories) on POSIX.
- **Hard purge on `forget`:** `forget(type="memory")` now hard-deletes the `memories` row inside the existing transaction instead of setting `status='deleted'`. Before the delete it removes `memory_links` on both sides, removes the `search_index` and `embeddings` rows, sets `relations.source_memory_id = NULL` for shared graph relations, and sets `memories.supersedes_id = NULL` on surviving rows. The supersession chain is intentionally broken so surviving memories keep no dangling reference to purged content; legacy rows already marked `status='deleted'` are purgeable too. Preference/lesson/interaction hard-delete behavior and the type/ambiguity safeguards are unchanged.
- **Export excludes deleted rows:** `export_memory` omits memories with `status='deleted'`, memory links whose source or target memory is deleted, and relations whose `source_memory_id` points at a deleted memory (relations with a `NULL` source stay). The v2 payload format and additive keys are unchanged, so legacy soft-deleted content cannot leak through a backup/export.
- **Consistent migration backup:** pre-migration backups use SQLite `VACUUM INTO` (safe with WAL) instead of copying the main DB file, so a backup is never a torn snapshot. `MEMORY_BACKUP_ON_MIGRATE=0|false` still opts out.
- **Dependency floor/overrides:** `@modelcontextprotocol/sdk` is pinned to `^1.32.1`, with transitive `overrides` for `hono`, `fast-uri`, `proxy-addr`, `ip-address`, and `qs` to keep patched versions installed.
- **Residual risk (local storage):** DB/WAL/export confidentiality depends on OS ACLs and/or full-disk encryption. Import/export path checks are not a sandbox against a concurrent local attacker (TOCTOU/symlink).

## Encryption at Rest (Phase 4, opt-in)

With `MEMORY_ENCRYPTION=on` and `MEMORY_ENCRYPTION_KEY` (base64, 32 bytes), the entire database file is encrypted via SQLCipher (`better-sqlite3-multiple-ciphers@13.1.1`):

- **One-time migration**: plaintext → encrypted via manual schema+data copy (no `sqlcipher_export`); atomic temp-file rename; idempotent via `schema_meta` marker. **Start from a quiet database**: stop every process (server + capture plugin) before the first migration — the copy is not one long snapshot, so a concurrent writer makes verification abort (fail-closed).
- **All data encrypted**: main DB, WAL, SHM, FTS5 indexes, vector embeddings.
- **Backup**: `VACUUM INTO` into a hidden staging file, verified with the key + `integrity_check`, then promoted by rename (`backupEncryptedDB` / `backupDatabase`); `th-memory db backup [--out <file>]` exposes it. Restore = replace file + same key.
- **Key**: `MEMORY_ENCRYPTION_KEY` (base64, 32 bytes) required when `on`; fail-fast exit 2 if missing/invalid.
- **Default (off)**: byte-identical to Ph-3 (plaintext, no overhead).

**Threat model coverage:**
- T6 (filesystem read): mitigated — file is opaque without key
- T7 (backup leak): mitigated — backup is encrypted
- T8 (WAL/SHM leak): mitigated — WAL/SHM encrypted
- T9 (memory dump): NOT mitigated — key in process memory (OS-level protection needed)

**Residual risk:** the key lives in process memory; there is no HSM/TPM client and no bundled native keyring (an OS keyring is reachable through `MEMORY_ENCRYPTION_KEY_CMD`); backups use the same key; OS-level file access bypasses the app layer. Defense-in-depth: OS full-disk encryption + restricted key access.

## Hardening (3.0.1 — Ph-6)

Findings from the 3.0.0 review, with the fix that shipped:

| ID | Finding (severity) | Fix |
|---|---|---|
| H1 | Enabling encryption on a real DB always failed: the migration copied FTS5 shadow tables (`object name reserved for internal use`) (P0) | Virtual tables are recreated from their own DDL (FTS5 builds the shadows), shadow tables are never copied by hand, rows move through `ATTACH … INSERT … SELECT`; integrity + row-count + MATCH parity are verified before promotion |
| H2 | The plaintext→encrypted swap unlinked the original before renaming the temp, so a crash could leave no database; orphan `.enc.tmp` was never recovered (P0) | Order is `tmp → verify → .enc.bak → db → marker → delete .enc.bak`; `recoverEncryptionState()` repairs five crash states and never deletes the last good copy |
| H3 | The key was "verified" with `PRAGMA cipher_version`, which does not validate a key (P1) | The key is proven by reading real data (`sqlite_master` + the `schema_meta` canary); failure is one bounded message |
| H4 | `export_memory` exported `users`/`entities`/`relations`/`memoryLinks` unscoped, leaking other identities' rows in enforced mode (P1) | Export is bounded by the exported memory set per collection; legacy output is byte-identical |
| H5 | An interrupted `VACUUM INTO` left a corrupt backup that could not be opened with the key (P2) | Every backup (encrypted and plaintext, `backupDatabase` and `th-memory db backup`) goes to a hidden staging sibling `.<name>.staging-<pid>-<n>`, is verified with the key + `integrity_check`, and is promoted by rename keeping `<name>.1`; the staging name never matches `<db>.backup-*`, so a killed backup is invisible to `db drill` and to pruning. A copy whose key is unknown is refused (fail-closed) instead of accepted on a structural check |
| H6 | `remember` returned `database is locked` while the capture plugin was writing (`SQLITE_BUSY_SNAPSHOT` from a deferred read-then-write transaction) (P2) | Write transactions that read first are now immediate (`remember`, `save_lesson`, `forget`, `supersede`, `createMemory`, `import_memory`, and the secret scrub `scrubHistoricalSecrets` behind `npm run scrub-secrets`) |
| H7 | Key rotation, backup verification and restore drills did not exist (P3) | `th-memory db rekey` (crash-safe), `db verify-backup`, `db restore --to … [--force]`, `db drill` |

**Key providers (3.0.1):** `MEMORY_ENCRYPTION_KEY` > `MEMORY_ENCRYPTION_KEY_FILE` (POSIX permission warning) > `MEMORY_ENCRYPTION_KEY_CMD` (no shell, 5 s timeout, 64 KiB cap, output never echoed). Exactly one source is effective and the ignored ones are named in one bounded stderr line. With `MEMORY_ENCRYPTION` unset nothing is read or executed.

**Residual risks after Ph-6:**
- `MEMORY_ENCRYPTION_KEY_CMD` runs an operator-supplied program with server privileges — admin-only setting.
- `recoverEncryptionState()` removes a stale `.rekey.tmp`; run `db rekey` with the server stopped.
- `busy_timeout` remains 5000 ms: a writer holding the write lock longer than that still yields `SQLITE_BUSY` (not observed in the concurrency suite).
- Restore `--force` renames the destination to `<target>.bak` before promoting the verified copy and deletes it only afterwards; a failed promotion puts the original back, so neither a partial file nor a missing database can appear. A SIGKILL between `rename(target → target.bak)` and `rename(tmp → target)` still leaves the target absent with `target.bak` beside it — there is no automatic recovery for that window, so restore it by hand (`mv <target>.bak <target>`).
- The plaintext→encrypted migration and `db restore` copy file-by-file, not as one snapshot: stop the server and the plugin first (verification aborts, fail-closed, if a writer commits mid-copy).
- Backups share the data key, so key compromise covers backups too.

## Disclosure

We follow coordinated disclosure. Please give us reasonable time to release a fix before public disclosure. We will publish a GitHub Release and update `SECURITY.md` with the fix version.
