# Migration Guide: v2.5.x → v3.0.0

This guide covers the breaking changes and migration steps for upgrading from v2.5.x to v3.0.0.

## ⚠️ Breaking Changes

### 1. New Dependency: `better-sqlite3-multiple-ciphers`

**What changed:** `better-sqlite3` replaced with `better-sqlite3-multiple-ciphers@13.1.1` (SQLCipher support).

**Impact:** 
- Native module rebuild required: `npm rebuild` or `npm install`
- Windows users: ensure Visual Studio Build Tools installed
- Linux/macOS: `python3` and `make` required for native build

**Action:**
```bash
npm install
# or if using pnpm:
pnpm install
```

### 2. New Optional Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MEMORY_ENCRYPTION` | No | `off` | Set to `on` to enable whole-DB encryption |
| `MEMORY_ENCRYPTION_KEY` | Yes (if encryption=on) | — | Base64-encoded 32-byte encryption key |
| `MEMORY_ENCRYPTION_KDF_ITER` | No | `256000` | SQLCipher KDF iterations |

**Example:**
```bash
# Generate a key
openssl rand -base64 32

# Enable encryption
export MEMORY_ENCRYPTION=on
export MEMORY_ENCRYPTION_KEY="your-base64-key-here"
```

### 3. Migration: Plaintext → Encrypted Database

When `MEMORY_ENCRYPTION=on` is enabled for the first time with a valid key:

1. **Automatic migration** runs on first startup
2. **One-time operation** — copies schema + data to encrypted database
3. **Atomic** — uses temp file + atomic rename; original DB untouched until success
4. **Idempotent** — re-running with same key = no-op (schema_meta marker)

**Migration details:**
- Schema + data copied table-by-table (no `sqlcipher_export` — not available in build)
- Indexes, triggers, `schema_meta` copied
- `schema_meta.encryption_migrated='1'` marker written
- Original DB replaced atomically (temp file → original)

**Rollback:** Not supported (irreversible). Keep plaintext backup before enabling.

### 3. New CLI Commands

```bash
# Grant management
th-memory grant add --user <id> --kind USER|PROJECT|SESSION|GLOBAL --ref <target> --permission read|write
th-memory grant remove --user <id> --kind USER|PROJECT|SESSION|GLOBAL --ref <target> --permission read|write
th-memory grant list [--user <id>]

# Backfill interaction ownership
th-memory auth backfill-interactions --user <external_id> [--session <id>] [--limit <n>] [--dry-run]
```

### 4. New Environment Variables (Optional)

| Variable | Description |
|----------|-------------|
| `MEMORY_CAPTURE_USER` | Optional capture attribution (sets `interactions.user_id`) |
| `MEMORY_ENCRYPTION_KDF_ITER` | KDF iterations (default 256000) |

---

## 🔄 Migration Steps (for existing users)

### If NOT using encryption (default):
```bash
# No action needed — default behavior unchanged
npm install
npm run build
npm test
```

### If enabling encryption:
```bash
# 1. Backup your database
cp data/memory.db data/memory.db.backup.$(date +%Y%m%d)

# 2. Generate encryption key
openssl rand -base64 32
# Copy the output

# 3. Set environment variables
export MEMORY_ENCRYPTION=on
export MEMORY_ENCRYPTION_KEY="your-base64-key-from-openssl"

# 4. Run migration (automatic on first startup)
npm run build
npm start  # or th-memory-mcp

# 5. Verify
th-memory stats
```

### For multi-user deployments:
```bash
# 1. Enable auth
export MEMORY_AUTH=on
export MEMORY_AUTH_TOKEN=your-token

# 2. Create users
th-memory auth add-user alice --role writer
th-memory auth issue-token alice --label "alice-token"

# 3. Grant cross-scope access
th-memory grant add --user alice --kind USER --ref bob --permission read
th-memory grant add --user alice --kind PROJECT --ref my-project --permission write

# 4. Backfill existing interactions
th-memory auth backfill-interactions --user alice
```

---

## 📦 Backup & Restore (Encrypted DB)

### Create encrypted backup:
```bash
# Automatic (via export)
th-memory export --include-interactions --filename backup-$(date +%Y%m%d).json

# Manual (VACUUM INTO - produces encrypted copy)
sqlite3 data/memory.db "VACUUM INTO 'backup-$(date +%Y%m%d).db';"
```

### Restore:
```bash
# 1. Stop server
# 2. Replace database file
cp backup-20261116.db data/memory.db
# 3. Delete WAL/SHM if present
rm -f data/memory.db-wal data/memory.db-shm
# 4. Start with same key
export MEMORY_ENCRYPTION=on
export MEMORY_ENCRYPTION_KEY="your-key"
npm start
```

---

## ⚠️ Rollback (Plaintext)

**Not supported directly.** Encryption is irreversible without a plaintext backup.

To revert to plaintext:
```bash
# 1. Restore from plaintext backup
cp data/memory.db.backup.$(date +%Y%m%d) data/memory.db

# 2. Disable encryption
unset MEMORY_ENCRYPTION
unset MEMORY_ENCRYPTION_KEY

# 3. Restart
npm start
```

---

## 🔐 Key Management Best Practices

1. **Generate strong key:** `openssl rand -base64 32`
2. **Store securely:** Password manager, OS keyring, or `.env` (not committed)
3. **Never commit keys** — add `.env` to `.gitignore`
4. **Rotate keys?** Not supported in v3.0.0 — requires full re-encryption (dump → re-encrypt → restore)
5. **Backup key** — lose key = lose all data

---

## 🔧 Troubleshooting

### "MEMORY_ENCRYPTION_KEY is missing or invalid"
- Key must be base64-encoded 32 bytes (44 chars with padding)
- Generate: `openssl rand -base64 32`

### "file is not a database" on startup
- Wrong key for encrypted DB
- Or DB corrupted — restore from backup

### Migration stuck / fails
- Check disk space (need ~2x DB size for temp file)
- Check permissions on `data/` directory
- Check `data/memory.db-wal`/`.shm` not locked

### Tests fail after upgrade
```bash
npm run build
npm test
# If smoke test flakes (pre-existing): 
# npm run test -- --test-concurrency=1
```

---

## 📚 Related Documentation

- [SECURITY.md](SECURITY.md) — Full threat model & encryption details
- [README.md](README.md) — Usage & CLI reference
- [SECURITY.md](SECURITY.md#encryption-at-rest-phase-4-opt-in) — Encryption threat model
- [GitHub Issues](https://github.com/worakorn-prince/th-memory-mcp/issues) — Report migration issues

---

## 📞 Support

- **Migration issues:** Open GitHub issue with `migration` label
- **Security issues:** Use GitHub Security Advisories (private)
- **General questions:** GitHub Discussions

---

*Migration guide for th-memory-mcp v3.0.0 — Phase 4 Encryption Release*