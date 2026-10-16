import { readFileSync } from "node:fs";
import type { ToolResult } from "../../db/index.js";

export type HighlightFn = (
  text: string,
  topic: string,
  opts?: { limit?: number; color?: boolean }
) => Promise<string>;

export interface Globals {
  json: boolean;
  plain: boolean;
  db?: string;
}

export type CliOpts = Record<string, string | boolean | undefined>;

export function fail(message: string, asJson: boolean, code = 2): never {
  if (asJson) {
    process.stdout.write(JSON.stringify({ ok: false, data: message }) + "\n");
  } else {
    process.stderr.write(`error: ${message}\n`);
  }
  process.exit(code);
}

export function useColor(g: Globals): boolean {
  return !g.plain && !g.json && process.stdout.isTTY === true;
}

export function readStdin(): string {
  return readFileSync(0, "utf8");
}

export function textOf(result: ToolResult): string {
  return result.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

export function output(result: ToolResult, g: Globals): number {
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

export function parseLimit(raw: unknown, def: number, min: number, max: number, g: Globals): number {
  if (raw === undefined) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max)
    fail(`--limit must be an integer ${min}-${max} (got "${String(raw)}")`, g.json);
  return n;
}

export function optStr(opts: Record<string, string | boolean | undefined>, name: string): string | undefined {
  const v = opts[name];
  if (typeof v === "string") return v;
  return undefined;
}

export function optBool(opts: Record<string, string | boolean | undefined>, name: string): boolean {
  return opts[name] === true;
}

export async function loadHighlightFn(): Promise<HighlightFn> {
  let mod: unknown;
  try {
    // @ts-ignore contract owned by sibling workstream: export async function highlightTextWithMemory(text, topic, opts?): Promise<string>
    mod = await import("../../lib/highlight.js");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`highlight module unavailable (src/lib/highlight.js): ${msg}`);
  }
  const fn = (mod as { highlightTextWithMemory?: unknown }).highlightTextWithMemory;
  if (typeof fn !== "function") throw new Error("highlight module has no highlightTextWithMemory export");
  return fn as HighlightFn;
}
