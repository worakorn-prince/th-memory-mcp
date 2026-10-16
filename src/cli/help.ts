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
  import (--file <p>|--json <s>) [--apply] [--user-id <id>]  import backup (dry-run by default)
  stats                                             memory statistics
  profile                                           distilled user profile
  history [--query <q>] [--limit <n>]               search past prompts (no query = recent prompts)
  recent [--limit <n>] [--kind <k>]                 recent interactions
  highlight [text...] -q <topic> [--limit <n>]      highlight topic matches (empty text = stdin)

Examples:
  th-memory remember --category coding_pref --key package_manager --value pnpm
  th-memory recall pnpm --limit 5
  th-memory forget 3 --type preference
  th-memory export --include-interactions --filename backup.json
  th-memory --db ./tmp.db --json stats`;

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
  import: `Usage: th-memory import (--file <p>|--json <s>) [--apply] [--user-id <id>]

  --file <p>       .json export file inside data/exports/
  --json <s>       inline JSON array or {memories:[...]} ("-" reads from stdin)
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
