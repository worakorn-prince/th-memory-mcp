import { VERSION } from "../lib/config.js";

export const CATEGORIES = ["work_style", "coding_pref", "language", "domain", "other"];
export const FORGET_TYPES = ["memory", "preference", "lesson", "interaction"];
export const KINDS = ["prompt", "tool_call", "error"];
export const COMMANDS = [
  "remember",
  "recall",
  "forget",
  "export",
  "import",
  "stats",
  "profile",
  "history",
  "recent",
  "highlight",
  "thai-dict",
  "auth",
  "grant",
  "db",
];

export const GLOBAL_HELP = `th-memory ${VERSION} - local memory CLI (zero-dep)

Usage: th-memory [--db <path>] [--json] [--plain] <command> [options]

Global flags (every command):
  --db <path>       use this SQLite file (sets MEMORY_DB_PATH)
  --json            print JSON {ok,data} instead of plain text
  --plain           disable colors (also: --no-color)
  -h, --help        show help (global or per-command: <command> --help)
  -V, --version     print version

Commands:
  remember --category <c> --key <k> --value <v|->   save a preference (--value - = stdin)
  recall <topic> [--limit <n>] [--highlight]        search memory
  forget <id> [--type <t>]                          delete by id (t: memory|preference|lesson|interaction)
  export [--include-interactions] [--filename <n>]  export to data/exports/*.json
  import (--file <p>|--json ) [--apply] [--user-id <id>]  import backup (dry-run by default)
  stats                                             memory statistics
  profile                                           distilled user profile
  history [--query <q>] [--limit <n>]               search past prompts (no query = recent prompts)
  recent [--limit <n>] [--kind <k>]                 recent interactions
  highlight [text...] -q <topic> [--limit <n>]      highlight topic matches (empty text = stdin)
  thai-dict <list|add|rm|learn> [opts]              personal Thai lexeme registry
  auth <add-user|issue-token|list|revoke|backfill-interactions> [opts]  opt-in identity/token admin (MEMORY_AUTH)
  grant <add|remove|list> [opts]                    scope grants admin (MEMORY_AUTH)
  db <backup|rekey|verify-backup|restore|drill> [opts]  encryption admin: backup, rotate key, verify/restore

Examples:
  th-memory remember --category coding_pref --key package_manager --value pnpm
  th-memory recall pnpm --limit 5
  th-memory forget 3 --type preference
  th-memory export --include-interactions --filename backup.json
  th-memory --db ./tmp.db --json stats
  th-memory grant add --user alice --kind USER --ref bob --permission read
  th-memory auth backfill-interactions --user alice
  th-memory db verify-backup data/memory.db.backup-1700000000000
  th-memory db drill`;

export const COMMAND_HELP: Record<string, string> = {
  remember: `Usage: th-memory remember --category <c> --key <k> --value <v|->

  --category <c>   one of: ${CATEGORIES.join("|")}
  --key <k>        short stable key (1-200 chars)
  --value <v>      preference value (1-2000 chars); "-" reads from stdin`,
  recall: `Usage: th-memory recall <topic> [--limit <n>] [--highlight]

  <topic>          search topic (required)
  --limit <n>      max matches, 1-50 (default 8)
  --highlight      pipe the result through memory highlight for <topic>`,
  forget: `Usage: th-memory forget <id> [--type <t>]

  <id>             numeric row id (required, positive integer)
  --type <t>       one of: ${FORGET_TYPES.join("|")} (recommended: ids collide across tables)`,
  export: `Usage: th-memory export [--include-interactions] [--filename <n>]

  --include-interactions   embed raw interaction rows (bigger file)
  --filename <n>           name inside data/exports/ ([A-Za-z0-9._-], must end .json)`,
  import: `Usage: th-memory import (--file <p>|--json ) [--apply] [--user-id <id>]

  --file <p>       .json export file inside data/exports/
  --json        inline JSON array or {memories:[...]} ("-" reads from stdin)
  --apply          write to DB (default: dry-run, report only)
  --user-id <id>   scope imported memories to a user`,
  stats: `Usage: th-memory stats`,
  profile: `Usage: th-memory profile`,
  history: `Usage: th-memory history [--query <q>] [--limit <n>]

  --query <q>      keyword for past prompts (a bare positional also works)
  --limit <n>      max rows (default 10 with --query, 20 without)
  (no --query: lists recent prompts instead)`,
  recent: `Usage: th-memory recent [--limit <n>] [--kind <k>]

  --limit <n>      max rows, 1-100 (default 20)
  --kind <k>       one of: ${KINDS.join("|")}`,
  highlight: `Usage: th-memory highlight [text...] -q <topic> [--limit <n>]

  [text...]        text to highlight (empty = read from stdin pipe)
  -q, --topic <t>  topic to highlight (required)
  --limit <n>      max highlight matches (positive integer)`,
  "thai-dict": `Usage: th-memory thai-dict <list|add|rm|learn> [opts]

  list                            show every registry entry (term, kind, pair, source)
  add --kind <synonym|segment> --term <t> --pair <p> [--project <id>]
                                   add or replace a registry entry (default kind: synonym)
  rm --term <t>                   remove a registry entry by surface term
  learn                           re-run auto-learn from lessons now`,
  auth: `Usage: th-memory auth <add-user|issue-token|list|revoke|backfill-interactions> [opts]

  add-user <userId> [--name <n>] [--role <r>]
                                   create a user (role: ${["reader", "writer", "owner", "admin"].join("|")}; default reader)
  issue-token <userId> [--label <l>]
                                   create a token; prints it ONCE (store it now)
  list                            users + token labels/hash prefixes + revoked flag
  revoke <hash-prefix|label>      set revoked_at (hash prefixes need >= 6 chars)
  backfill-interactions --user <external_id> [--session <id>] [--limit <n>] [--dry-run]
                                   attribute NULL interaction rows to a user (admin, idempotent)

  Admin runs locally against MEMORY_DB_PATH and does not need MEMORY_AUTH=on.
  The server (MEMORY_AUTH=on) needs MEMORY_AUTH_TOKEN or MEMORY_AUTH_TOKEN_FILE.`,
  grant: `Usage: th-memory grant <add|remove|list> [opts]

  add --user <external_id> --kind <USER|PROJECT|SESSION|GLOBAL> --ref <target_id> --permission <read|write>
                                   add a scope grant for a user
  remove --user <external_id> --kind <USER|PROJECT|SESSION|GLOBAL> --ref <target_id> --permission <read|write>
                                   remove a scope grant
  list [--user <external_id>]     list all grants (or for one user)

  Admin runs locally against MEMORY_DB_PATH and does not need MEMORY_AUTH=on.
  Grants are the ONLY way to act outside your own identity-derived scope.
  USER kind: --ref is the target user's external_id
  GLOBAL kind: --ref must be *`,
  db: `Usage: th-memory db <backup|rekey|verify-backup|restore|drill> [opts]

  backup [--out <path>]            write a verified backup of the live DB
                                   (MEMORY_ENCRYPTION=on for an encrypted DB)
  rekey [--new-key-file <path>] [--new-key <base64>]
                                   re-encrypt the live DB with a new key
                                   current key: MEMORY_ENCRYPTION_KEY (MEMORY_ENCRYPTION=on required)
                                   --new-key-file is preferred: base64 of 32 bytes, mode 0600
  verify-backup <path> [--json]    open a backup with MEMORY_ENCRYPTION_KEY, integrity_check + row counts
  restore <backup> --to <path> [--force]
                                   verify, then copy a backup to <path> (temp + rename);
                                   refuses an existing target or the live DB without --force
  drill [--backup <path>]          restore the newest <db>.backup-* (or --backup) into a temp
                                   directory, verify it, compare row counts with the live DB
                                   and delete the temp copy

  Exit codes: 0 ok · 2 refused (missing key/backup, same key, plaintext DB, existing target)
              · 1 failure or corrupt backup.
  No subcommand prints or echoes a key. Local admin: MEMORY_AUTH is not required.`,
};

export function printHelp(cmd: string | undefined): void {
  if (cmd === undefined || !(cmd in COMMAND_HELP)) {
    process.stdout.write(GLOBAL_HELP + "\n");
    return;
  }
  process.stdout.write(`th-memory ${VERSION}\n\n${COMMAND_HELP[cmd]}\n`);
}

export function printVersion(asJson: boolean): void {
  if (asJson) {
    process.stdout.write(JSON.stringify({ ok: true, data: VERSION }) + "\n");
    return;
  }
  process.stdout.write(`th-memory ${VERSION}\n`);
}