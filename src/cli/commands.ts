import { readFileSync } from "node:fs";
import { VERSION } from "../lib/config.js";
import type { ToolResult } from "../db/index.js";

type HighlightFn = (
  text: string,
  topic: string,
  opts?: { limit?: number; color?: boolean }
) => Promise<string>;

interface Globals {
  json: boolean;
  plain: boolean;
  db?: string;
}

interface Parsed {
  cmd: string;
  globals: Globals;
  opts: Record<string, string | boolean | undefined>;
  positionals: string[];
}

const CATEGORIES = ["work_style", "coding_pref", "language", "domain", "other"];
const FORGET_TYPES = ["memory", "preference", "lesson", "interaction"];
const KINDS = ["prompt", "tool_call", "error"];
const COMMANDS = [
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

const GLOBAL_HELP = `th-memory ${VERSION} - local memory CLI (zero-dep)

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

const COMMAND_HELP: Record<string, string> = {
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

function splitEq(token: string): [string, string | undefined] {
  const i = token.indexOf("=");
  if (i < 0) return [token, undefined];
  return [token.slice(0, i), token.slice(i + 1)];
}

function parseBoolValue(raw: string | undefined, name: string): boolean {
  if (raw === undefined) return true;
  const v = raw.toLowerCase();
  if (["true", "1", "yes", "y"].includes(v)) return true;
  if (["false", "0", "no", "n"].includes(v)) return false;
  throw new Error(`invalid value for ${name}: "${raw}" (expected true/false)`);
}

function fail(message: string, asJson: boolean, code = 2): never {
  if (asJson) {
    process.stdout.write(JSON.stringify({ ok: false, data: message }) + "\n");
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exit(code);
}

function parseArgv(argv: string[]): Parsed {
  const globals: Globals = { json: false, plain: false };
  let i = 0;
  while (i < argv.length) {
    const tok = argv[i] as string;
    if (tok === "--db") {
      const v = argv[i + 1];
      if (v === undefined || (v.startsWith("--") && v !== "-"))
        fail("--db requires a <path> value", globals.json);
      globals.db = v;
      i += 2;
    } else if (tok.startsWith("--db=")) {
      globals.db = tok.slice("--db=".length);
      if (!globals.db) fail("--db requires a <path> value", globals.json);
      i += 1;
    } else if (tok === "--json") {
      globals.json = true;
      i += 1;
    } else if (tok === "--plain" || tok === "--no-color") {
      globals.plain = true;
      i += 1;
    } else if (tok === "-h" || tok === "--help") {
      printHelp(undefined);
      process.exit(0);
    } else if (tok === "-V" || tok === "--version") {
      printVersion(globals.json);
      process.exit(0);
    } else if (tok === "--") {
      i += 1;
      break;
    } else if (tok.startsWith("-")) {
      fail(`unknown global option "${tok}" (see --help)`, globals.json);
    } else {
      break;
    }
  }
  const cmd = argv[i];
  if (cmd === undefined) {
    process.stderr.write(GLOBAL_HELP + "\n");
    process.exit(2);
  }
  if (!COMMANDS.includes(cmd)) fail(`unknown command "${cmd}" (see --help)`, globals.json);
  const rest = argv.slice(i + 1);
  const opts: Record<string, string | boolean | undefined> = {};
  const positionals: string[] = [];
  const valueOpts = new Set([
    "--category",
    "--key",
    "--value",
    "--limit",
    "--type",
    "--filename",
    "--file",
    "--user-id",
    "--query",
    "--kind",
    "--topic",
    "-q",
    "--db",
  ]);
  const boolOpts = new Set([
    "--json",
    "--plain",
    "--no-color",
    "--highlight",
    "--include-interactions",
    "--apply",
  ]);
  let j = 0;
  const takeValue = (name: string, inline: string | undefined): string => {
    if (inline !== undefined && inline !== "") return inline;
    const next = rest[j + 1];
    if (next === undefined || (next.startsWith("--") && next !== "-"))
      fail(`${name} requires a value`, globals.json);
    j += 1;
    return next as string;
  };
  while (j < rest.length) {
    const tok = rest[j] as string;
    if (tok === "--") {
      positionals.push(...(rest.slice(j + 1) as string[]));
      break;
    }
    if (tok === "-h" || tok === "--help") {
      printHelp(cmd);
      process.exit(0);
    }
    if (tok === "-V" || tok === "--version") {
      printVersion(globals.json);
      process.exit(0);
    }
    if (tok === "-q") {
      opts["--topic"] = takeValue("-q", undefined);
      j += 1;
      continue;
    }
    if (tok.startsWith("--")) {
      const [name, inline] = splitEq(tok);
      if (name === "--db") {
        globals.db = takeValue("--db", inline);
        j += 1;
        continue;
      }
      if (name === "--json") {
        globals.json = parseBoolValue(inline, "--json");
        j += 1;
        continue;
      }
      if (name === "--plain" || name === "--no-color") {
        globals.plain = true;
        j += 1;
        continue;
      }
      if (name === "--topic") {
        opts["--topic"] = takeValue("--topic", inline);
        j += 1;
        continue;
      }
      if (valueOpts.has(name)) {
        opts[name] = takeValue(name, inline);
        j += 1;
        continue;
      }
      if (boolOpts.has(name)) {
        opts[name] = parseBoolValue(inline, name);
        j += 1;
        continue;
      }
      if (name.startsWith("--no-")) {
        opts["--" + name.slice("--no-".length)] = false;
        j += 1;
        continue;
      }
      fail(`unknown option "${name}" for "${cmd}" (see ${cmd} --help)`, globals.json);
    } else if (tok === "-" || !tok.startsWith("-")) {
      positionals.push(tok);
      j += 1;
    } else {
      fail(`unknown option "${tok}" for "${cmd}" (see ${cmd} --help)`, globals.json);
    }
  }
  if (cmd === "import" && typeof opts["--json"] === "boolean") {
    fail("import --json requires an inline JSON string (or use --file <path>)", globals.json);
  }
  return { cmd, globals, opts, positionals };
}

function printHelp(cmd: string | undefined): void {
  if (cmd === undefined || !(cmd in COMMAND_HELP)) {
    process.stdout.write(GLOBAL_HELP + "\n");
    return;
  }
  process.stdout.write(`th-memory ${VERSION}\n\n${COMMAND_HELP[cmd]}\n`);
}

function printVersion(asJson: boolean): void {
  if (asJson) {
    process.stdout.write(JSON.stringify({ ok: true, data: VERSION }) + "\n");
    return;
  }
  process.stdout.write(`th-memory ${VERSION}\n`);
}

function useColor(g: Globals): boolean {
  return !g.plain && !g.json && process.stdout.isTTY === true;
}

function readStdin(): string {
  return readFileSync(0, "utf8");
}

function textOf(result: ToolResult): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

function output(result: ToolResult, g: Globals): number {
  const text = textOf(result);
  const isError = (result as { isError?: boolean }).isError === true;
  if (g.json) {
    process.stdout.write(JSON.stringify({ ok: !isError, data: text }) + "\n");
    return isError ? 1 : 0;
  }
  if (isError) {
    process.stderr.write((text.startsWith("error:") ? text : `error: ${text}`) + "\n");
    return 1;
  }
  process.stdout.write(text + "\n");
  return 0;
}

function parseLimit(raw: unknown, def: number, min: number, max: number, g: Globals): number {
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max)
    fail(`--limit must be an integer ${min}-${max} (got "${String(raw)}")`, g.json);
  return n;
}

function optStr(opts: Record<string, string | boolean | undefined>, name: string): string | undefined {
  const v = opts[name];
  if (typeof v === "string") return v;
  return undefined;
}

function optBool(opts: Record<string, string | boolean | undefined>, name: string): boolean {
  return opts[name] === true;
}

async function loadHighlightFn(): Promise<HighlightFn> {
  let mod: unknown;
  try {
    // @ts-ignore contract owned by sibling workstream: export async function highlightTextWithMemory(text, topic, opts?): Promise<string>
    mod = await import("../lib/highlight.js");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`highlight module unavailable (src/lib/highlight.js): ${msg}`);
  }
  const fn = (mod as { highlightTextWithMemory?: unknown }).highlightTextWithMemory;
  if (typeof fn !== "function") throw new Error("highlight module has no highlightTextWithMemory export");
  return fn as HighlightFn;
}

export async function runCli(argv: string[]): Promise<number> {
  const { cmd, globals: g, opts, positionals: pos } = parseArgv(argv);
  if (g.db !== undefined) process.env.MEMORY_DB_PATH = g.db;

  switch (cmd) {
    case "remember": {
      const category = optStr(opts, "--category");
      const key = optStr(opts, "--key");
      let value = optStr(opts, "--value");
      if (pos.length > 0) fail(`remember takes no positional args (see remember --help)`, g.json);
      if (category === undefined) fail("remember requires --category (work_style|coding_pref|language|domain|other)", g.json);
      if (!CATEGORIES.includes(category)) fail(`invalid --category "${category}" (expected ${CATEGORIES.join("|")})`, g.json);
      if (key === undefined) fail("remember requires --key <key>", g.json);
      if (value === undefined) fail("remember requires --value <value> (use - for stdin)", g.json);
      if (value === "-") value = readStdin().replace(/\r?\n$/, "");
      if (value.length === 0) fail("--value must not be empty", g.json);
      const { rememberHandler } = await import("../tools/remember.js");
      return output(
        await rememberHandler({
          category: category as "work_style" | "coding_pref" | "language" | "domain" | "other",
          key,
          value,
        }),
        g
      );
    }
    case "recall": {
      if (pos.length === 0) fail("recall requires <topic>", g.json);
      const topic = pos.join(" ");
      const limit = parseLimit(opts["--limit"], 8, 1, 50, g);
      const { recallHandler } = await import("../tools/recall.js");
      const result = await recallHandler({ topic, limit });
      if (optBool(opts, "--highlight") && (result as { isError?: boolean }).isError !== true) {
        try {
          const highlight = await loadHighlightFn();
          const highlighted = await highlight(textOf(result), topic, { limit, color: useColor(g) });
          return output({ content: [{ type: "text", text: highlighted }] }, g);
        } catch (e) {
          return output(
            { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true },
            g
          );
        }
      }
      return output(result, g);
    }
    case "forget": {
      if (pos.length === 0) fail("forget requires <id>", g.json);
      if (pos.length > 1) fail("forget takes a single <id>", g.json);
      const id = Number(pos[0]);
      if (!Number.isInteger(id) || id <= 0) fail(`invalid <id> "${pos[0]}" (expected positive integer)`, g.json);
      const type = optStr(opts, "--type");
      if (type !== undefined && !FORGET_TYPES.includes(type))
        fail(`invalid --type "${type}" (expected ${FORGET_TYPES.join("|")})`, g.json);
      const { forgetHandler } = await import("../tools/forget.js");
      return output(
        await forgetHandler({
          target_id: id,
          ...(type === undefined
            ? {}
            : { type: type as "memory" | "preference" | "lesson" | "interaction" }),
        }),
        g
      );
    }
    case "export": {
      if (pos.length > 0) fail("export takes no positional args (see export --help)", g.json);
      const { exportMemoryHandler } = await import("../tools/export_memory.js");
      return output(
        await exportMemoryHandler({
          includeInteractions: optBool(opts, "--include-interactions"),
          ...(optStr(opts, "--filename") === undefined ? {} : { filename: optStr(opts, "--filename") as string }),
        }),
        g
      );
    }
    case "import": {
      if (pos.length > 0) fail("import takes no positional args (see import --help)", g.json);
      let file = optStr(opts, "--file");
      let json = optStr(opts, "--json");
      if ((file === undefined) === (json === undefined))
        fail("import requires exactly one of --file <path> or --json <string>", g.json);
      if (json === "-") json = readStdin();
      const userId = optStr(opts, "--user-id");
      const { importMemoryHandler } = await import("../tools/import_memory.js");
      return output(
        importMemoryHandler({
          ...(file === undefined ? {} : { file }),
          ...(json === undefined ? {} : { json }),
          apply: optBool(opts, "--apply"),
          ...(userId === undefined ? {} : { userId }),
        }),
        g
      );
    }
    case "stats": {
      if (pos.length > 0) fail("stats takes no positional args", g.json);
      const { memoryStatsHandler } = await import("../tools/memory_stats.js");
      return output(await memoryStatsHandler(), g);
    }
    case "profile": {
      if (pos.length > 0) fail("profile takes no positional args", g.json);
      const { getProfileHandler } = await import("../tools/profile.js");
      return output(await getProfileHandler(), g);
    }
    case "history": {
      const query = optStr(opts, "--query") ?? (pos.length > 0 ? pos.join(" ") : undefined);
      const limit = parseLimit(opts["--limit"], query === undefined ? 20 : 10, 1, query === undefined ? 100 : 50, g);
      if (query === undefined) {
        const { getRecentInteractionsHandler } = await import("../tools/recent_interactions.js");
        return output(await getRecentInteractionsHandler({ limit, kind: "prompt" }), g);
      }
      const { searchHistoryHandler } = await import("../tools/history.js");
      return output(await searchHistoryHandler({ query, limit }), g);
    }
    case "recent": {
      if (pos.length > 0) fail("recent takes no positional args (use --kind/--limit)", g.json);
      const limit = parseLimit(opts["--limit"], 20, 1, 100, g);
      const kind = optStr(opts, "--kind");
      if (kind !== undefined && !KINDS.includes(kind))
        fail(`invalid --kind "${kind}" (expected ${KINDS.join("|")})`, g.json);
      const { getRecentInteractionsHandler } = await import("../tools/recent_interactions.js");
      return output(
        await getRecentInteractionsHandler({
          limit,
          ...(kind === undefined ? {} : { kind: kind as "prompt" | "tool_call" | "error" }),
        }),
        g
      );
    }
    case "highlight": {
      const topic = optStr(opts, "--topic");
      if (topic === undefined || topic.length === 0) fail("highlight requires -q <topic>", g.json);
      const limitRaw = opts["--limit"];
      let limit: number | undefined;
      if (limitRaw !== undefined) {
        const n = Number(limitRaw);
        if (!Number.isInteger(n) || n <= 0) fail(`--limit must be a positive integer (got "${String(limitRaw)}")`, g.json);
        limit = n;
      }
      let text = pos.join(" ");
      if (text.length === 0) {
        if (process.stdin.isTTY) fail("highlight needs [text...] or piped stdin", g.json);
        text = readStdin();
        if (text.length === 0) fail("highlight received empty input", g.json);
      }
      try {
        const highlight = await loadHighlightFn();
        const out = await highlight(text, topic, { ...(limit === undefined ? {} : { limit }), color: useColor(g) });
        return output({ content: [{ type: "text", text: out }] }, g);
      } catch (e) {
        return output(
          { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true },
          g
        );
      }
    }
    default:
      fail(`unknown command "${cmd}" (see --help)`, g.json);
  }
}
