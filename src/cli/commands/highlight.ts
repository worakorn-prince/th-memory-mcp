import { fail, loadHighlightFn, optStr, output, readStdin, useColor, type CliOpts, type Globals } from "./shared.js";

export async function runHighlight(opts: CliOpts, pos: string[], g: Globals): Promise<number> {
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
