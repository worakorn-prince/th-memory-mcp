# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 2.3.x   | :white_check_mark: |
| < 2.3   | :x:                |

We support the latest `2.3.x` release line. Older major/minor lines receive no security updates.

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

There is **no authentication or authorization layer** in this server by design (no new auth system is introduced):

- `userId` / `sessionId` / `projectId` are **caller-supplied** values. Scope checks in `merge_memory` / `get_context` (via `context-engine` + `retrieval-engine`) and the USER/SESSION/PROJECT isolation they enforce are only as trustworthy as the caller — a caller that passes another user's id is treated as that user.
- The supported deployment is a **single-user local process**: one operator running the MCP server against a local `data/memory.db`. In that model the caller is trusted and scope parameters are a correctness/isolation mechanism, not a security boundary.
- **Multi-user deployments MUST add an auth layer in front** (outside this repo): authenticate each caller, then map/force the correct `userId` (and allowed `projectId` / `sessionId`) before the call reaches the MCP tools. Sharing one server/DB across mutually-untrusted users without that layer will leak USER/SESSION-scoped memories across users.
- Memory content rendered back to the model is wrapped in `<memory-reference>` delimiters with an explicit "reference data, not instructions" guidance line, and entries imported with `metadata.trusted=false` are labelled `[untrusted-import]` — defense-in-depth against prompt injection, not a substitute for caller auth.

## Hardening changes (unreleased)

These changes harden the single-user local model above; they do **not** add authentication. A caller that can invoke the tools is still trusted.

- **Import `trusted` gate:** untrusted imports skip only auxiliary `preferences`/`lessons`/`profile` records; users/entities/relations/memories are still imported by design and should only come from trusted exports. A per-item `metadata.trusted` value is ignored for this gate, and a tool-level `userId` wins over ids embedded in the payload. Untrusted imports stay labelled `[untrusted-import]`.
- **`get_profile` scoping:** calling it with no arguments returns GLOBAL-scope content only. Optional scope arguments (`userId` / `sessionId` / `projectId`) widen the query explicitly. An unknown/invalid scope resolves to GLOBAL-only and never widens to an arbitrary scope.
- **Delimiter sanitization:** user/imported content is stripped of the `<memory-reference>` delimiter sequences before rendering, so stored memories cannot break out of the reference wrapper and pose as instructions. Matching covers case-insensitive whitespace/attribute variants (`</memory-reference >`, `</memory-reference foo>`, newline forms, `<memory-reference data-x="1">`) via `/<\/?memory-reference\b[^>]*>/gi`; the capture plugin mirrors the same pattern and `check:capture-sync` guards drift.
- **Read budget and trust labels (P1):** get_recent_interactions reserves the wrapper guidance/tag overhead before truncating rows so the final response stays within 4000 chars; consolidate labels members whose metadata is untrusted with [untrusted-import] while keeping one wrapper per response.
- **Read-tool wrapping:** `search_history`, `get_recent_interactions`, `consolidate`, and the `extract_memories` dry-run preview wrap returned memory text in `<memory-reference>` guidance and neutralize embedded delimiter payloads. Malformed or non-object trust metadata is treated as untrusted (fail closed).
- **Secret redaction before truncation:** secrets are redacted before any length truncation, in both the core and the capture plugin, so truncating a value cannot leave a partial secret behind.
- **Write-boundary secret redaction:** explicit memory `content`/`summary`, preference `key`/`value`, lesson `situation`/`mistake`/`correction`, `update_memory` in-place fields, and trusted-import `preferences`/`lessons`/`profile` rows now pass through `filterSecrets` before persistence and before FTS/embedding indexing. Metadata strings are recursively redacted (depth-limited, cycle-safe); non-plain values (class instances, `Date`, `Map`, etc.) are JSON-serialized and the result recursively redacted, with cyclic/unserializable values collapsing to `[REDACTED]`. Graph entity/relation names, predicates, link metadata, and external user IDs remain out of scope.
- **Legacy write-path closure (P1):** `merge_memory` parses existing target metadata, recursively redacts it (including legacy rows written before redaction existed), and only then records `metadata.merged_from`, so replaying a merge cannot re-persist a raw secret. The `distill` CLI runs each `formatProfileSections` string through `redactSecrets` before the `profile` upsert; stats computation and retention pruning are unchanged.
- **Export preview safety:** export previews are wrapped like other memory content, and export files are written with `0600` (files) / `0700` (directories) on POSIX.
- **Hard purge on `forget`:** `forget(type="memory")` now hard-deletes the `memories` row inside the existing transaction instead of setting `status='deleted'`. Before the delete it removes `memory_links` on both sides, removes the `search_index` and `embeddings` rows, sets `relations.source_memory_id = NULL` for shared graph relations, and sets `memories.supersedes_id = NULL` on surviving rows. The supersession chain is intentionally broken so surviving memories keep no dangling reference to purged content; legacy rows already marked `status='deleted'` are purgeable too. Preference/lesson/interaction hard-delete behavior and the type/ambiguity safeguards are unchanged.
- **Export excludes deleted rows:** `export_memory` omits memories with `status='deleted'`, memory links whose source or target memory is deleted, and relations whose `source_memory_id` points at a deleted memory (relations with a `NULL` source stay). The v2 payload format and additive keys are unchanged, so legacy soft-deleted content cannot leak through a backup/export.
- **Consistent migration backup:** pre-migration backups use SQLite `VACUUM INTO` (safe with WAL) instead of copying the main DB file, so a backup is never a torn snapshot. `MEMORY_BACKUP_ON_MIGRATE=0|false` still opts out.
- **Dependency floor/overrides:** `@modelcontextprotocol/sdk` is pinned to `^1.32.1`, with transitive `overrides` for `hono`, `fast-uri`, `proxy-addr`, `ip-address`, and `qs` to keep patched versions installed.
- **Residual risk (local storage):** DB/WAL/export confidentiality depends on OS ACLs and/or full-disk encryption. Import/export path checks are not a sandbox against a concurrent local attacker (TOCTOU/symlink).

## Disclosure

We follow coordinated disclosure. Please give us reasonable time to release a fix before public disclosure. We will publish a GitHub Release and update `SECURITY.md` with the fix version.
