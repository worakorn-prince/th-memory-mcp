# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 2.5.x   | :white_check_mark: |
| < 2.5   | :x:                |

We support the latest `2.5.x` release line. Older major/minor lines receive no security updates.

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
- **Deny trail (interim)** — one redacted, newline-stripped stderr line capped at 240 chars: `[th-memory-mcp] authz: deny <tool> user=<externalId> needs=<minRole>`. Structured `audit_log` rows are Ph-3.
- **Interim gap — interactions are not scoped** — `search_history` and `get_recent_interactions` are `reader`-level but read rows that carry no owner today, so in enforced mode any authenticated role can read the shared interaction history. Ph-3 adds `interactions.user_id` and scope binding; raising these two tools to `writer` would not isolate anything while the data is unscoped, so the gap is documented rather than hidden.
- **Still not a full authorization boundary** — Ph-2 gates *which tool* a caller may invoke. It does not yet bind caller-supplied `userId` / `sessionId` / `projectId` to the authenticated identity, enforce project/session membership or grants, or audit decisions (all Ph-3). Identity is also resolved once per server process, so one server/DB still must not be shared across mutually-untrusted users.

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

## Disclosure

We follow coordinated disclosure. Please give us reasonable time to release a fix before public disclosure. We will publish a GitHub Release and update `SECURITY.md` with the fix version.
