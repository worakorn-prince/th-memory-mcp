# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 2.2.x   | :white_check_mark: |
| < 2.2   | :x:                |

We support the latest `2.2.x` release line. Older major/minor lines receive no security updates.

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
- Triage and severity assessment using the same legend as `HealthCheck_Final.md` (Critical / High / Medium / Low)
- Fix in a patch release and credit in release notes if desired

## Scope

This policy covers the MCP server (`src/`), SQLite store (`data/memory.db`), and the auto-capture plugin (`src/plugin/learning-capture.ts`). The benchmark harness (`benchmark/`, `repro/`) and result files (`result/`) are out of scope.

## Disclosure

We follow coordinated disclosure. Please give us reasonable time to release a fix before public disclosure. We will publish a GitHub Release and update `SECURITY.md` with the fix version.
