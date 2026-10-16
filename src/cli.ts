#!/usr/bin/env node
import { runCli } from "./cli/commands.js";

function jsonModeRequested(argv: string[]): boolean {
  let json = false;
  for (const tok of argv) {
    if (tok === "--") break;
    if (tok === "--json") {
      json = true;
    } else if (tok.startsWith("--json=")) {
      const v = tok.slice("--json=".length).toLowerCase();
      if (["true", "1", "yes", "y"].includes(v)) json = true;
      else if (["false", "0", "no", "n"].includes(v)) json = false;
      else break;
    }
  }
  return json;
}

try {
  const code = await runCli(process.argv.slice(2));
  process.exitCode = code;
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  if (jsonModeRequested(process.argv.slice(2))) {
    process.stdout.write(JSON.stringify({ ok: false, data: message }) + "\n");
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exitCode = 2;
}
