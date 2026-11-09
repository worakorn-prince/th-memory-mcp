#!/usr/bin/env node
// thai-fts: tiny zero-dependency CLI over the pure Thai lexical libs
// (src/lib/thai-segment.ts + src/lib/thai-synonyms.ts). Purely standalone —
// no DB, no npm deps, no runtime arguments beyond text. Pipe-friendly:
// line-delimited output, no ANSI color.
import { hasThai, looseForm, wordTokens } from "./lib/thai-segment.js";
import { expandSynonyms } from "./lib/thai-synonyms.js";

const USAGE = `thai-fts - Thai lexical utilities (zero-dependency, standalone)

Usage:
  thai-fts segment "<text>"      word tokens (line-delimited)
  thai-fts loose "<text>"        tone-tolerant (de-accented) form
  thai-fts synonyms "<term>"     counterpart matches from THAI_SYNONYMS
  thai-fts check "<text>"        1 if Thai is present, else 0
  thai-fts --json <cmd> "<text>" wrap the output as { ok, data }
  thai-fts --help                show this help

Examples:
  thai-fts segment "ติดตั้งโปรแกรม"
  thai-fts loose "ติดตั้ง"
  thai-fts synonyms deploy
  thai-fts check "foo"`;

function jsonModeRequested(argv: string[]): boolean {
  for (const tok of argv) {
    if (tok === "--") break;
    if (tok === "--json") return true;
  }
  return false;
}

function fail(message: string, asJson: boolean): never {
  if (asJson) {
    process.stdout.write(JSON.stringify({ ok: false, data: message }) + "\n");
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exit(2);
}

function emit(data: string, asJson: boolean): void {
  if (asJson) {
    process.stdout.write(JSON.stringify({ ok: true, data }) + "\n");
  } else {
    process.stdout.write(data + "\n");
  }
}

function main(argv: string[]): number {
  const asJson = jsonModeRequested(argv);
  const args = argv.filter((t) => t !== "--json");
  const cmd = args[0];
  const text = args.slice(1).join(" ").trim();

  if (cmd === undefined || cmd === "-h" || cmd === "--help") {
    process.stdout.write(USAGE + "\n");
    return 0;
  }

  switch (cmd) {
    case "segment": {
      const tokens = wordTokens(text).filter(Boolean);
      emit(tokens.join("\n"), asJson);
      return 0;
    }
    case "loose": {
      emit(looseForm(text), asJson);
      return 0;
    }
    case "synonyms": {
      const partners = expandSynonyms(text).slice(1);
      emit(partners.join("\n"), asJson);
      return 0;
    }
    case "check": {
      emit(hasThai(text) ? "1" : "0", asJson);
      return 0;
    }
    default:
      fail(`unknown command "${cmd}" (run thai-fts --help)`, asJson);
  }
}

process.exitCode = main(process.argv.slice(2));
