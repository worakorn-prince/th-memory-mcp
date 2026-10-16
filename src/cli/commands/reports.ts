import { KINDS } from "../help.js";
import { fail, optStr, output, parseLimit, type CliOpts, type Globals } from "./shared.js";

export async function runStats(opts: CliOpts, pos: string[], g: Globals): Promise<number> {
  if (pos.length > 0) fail("stats takes no positional args", g.json);
  const { memoryStatsHandler } = await import("../../tools/memory_stats.js");
  return output(await memoryStatsHandler(), g);
}

export async function runProfile(opts: CliOpts, pos: string[], g: Globals): Promise<number> {
  if (pos.length > 0) fail("profile takes no positional args", g.json);
  const { getProfileHandler } = await import("../../tools/profile.js");
  return output(await getProfileHandler(), g);
}

export async function runHistory(opts: CliOpts, pos: string[], g: Globals): Promise<number> {
  const query = optStr(opts, "--query") ?? (pos.length > 0 ? pos.join(" ") : undefined);
  const limit = parseLimit(opts["--limit"], query === undefined ? 20 : 10, 1, query === undefined ? 100 : 50, g);
  if (query === undefined) {
    const { getRecentInteractionsHandler } = await import("../../tools/recent_interactions.js");
    return output(await getRecentInteractionsHandler({ limit, kind: "prompt" }), g);
  }
  const { searchHistoryHandler } = await import("../../tools/history.js");
  return output(await searchHistoryHandler({ query, limit }), g);
}

export async function runRecent(opts: CliOpts, pos: string[], g: Globals): Promise<number> {
  if (pos.length > 0) fail("recent takes no positional args (use --kind/--limit)", g.json);
  const limit = parseLimit(opts["--limit"], 20, 1, 100, g);
  const kind = optStr(opts, "--kind");
  if (kind !== undefined && !KINDS.includes(kind))
    fail(`invalid --kind "${kind}" (expected ${KINDS.join("|")})`, g.json);
  const { getRecentInteractionsHandler } = await import("../../tools/recent_interactions.js");
  return output(
    await getRecentInteractionsHandler({
      limit,
      ...(kind === undefined ? {} : { kind: kind as "prompt" | "tool_call" | "error" }),
    }),
    g
  );
}
