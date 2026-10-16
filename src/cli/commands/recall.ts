import { fail, loadHighlightFn, optBool, output, parseLimit, textOf, useColor, type CliOpts, type Globals } from "./shared.js";

export async function runRecall(opts: CliOpts, pos: string[], g: Globals): Promise<number> {
  if (pos.length === 0) fail("recall requires <topic>", g.json);
  const topic = pos.join(" ");
  const limit = parseLimit(opts["--limit"], 8, 1, 50, g);
  const { recallHandler } = await import("../../tools/recall.js");
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
