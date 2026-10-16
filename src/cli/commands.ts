import { COMMANDS, GLOBAL_HELP, printHelp, printVersion } from "./help.js";
import { runForget } from "./commands/forget.js";
import { runExport, runImport } from "./commands/import-export.js";
import { runHighlight } from "./commands/highlight.js";
import { runHistory, runProfile, runRecent, runStats } from "./commands/reports.js";
import { runRecall } from "./commands/recall.js";
import { runRemember } from "./commands/remember.js";
import { fail, type Globals } from "./commands/shared.js";

interface Parsed {
  cmd: string;
  globals: Globals;
  opts: Record<string, string | boolean | undefined>;
  positionals: string[];
}

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

export async function runCli(argv: string[]): Promise<number> {
  const { cmd, globals: g, opts, positionals: pos } = parseArgv(argv);
  if (g.db !== undefined) process.env.MEMORY_DB_PATH = g.db;

  switch (cmd) {
    case "remember":
      return runRemember(opts, pos, g);
    case "recall":
      return runRecall(opts, pos, g);
    case "forget":
      return runForget(opts, pos, g);
    case "export":
      return runExport(opts, pos, g);
    case "import":
      return runImport(opts, pos, g);
    case "stats":
      return runStats(opts, pos, g);
    case "profile":
      return runProfile(opts, pos, g);
    case "history":
      return runHistory(opts, pos, g);
    case "recent":
      return runRecent(opts, pos, g);
    case "highlight":
      return runHighlight(opts, pos, g);
    default:
      fail(`unknown command "${cmd}" (see --help)`, g.json);
  }
}
