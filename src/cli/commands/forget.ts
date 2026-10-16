import { FORGET_TYPES } from "../help.js";
import { fail, optStr, output, type CliOpts, type Globals } from "./shared.js";

export async function runForget(opts: CliOpts, pos: string[], g: Globals): Promise<number> {
  if (pos.length === 0) fail("forget requires <id>", g.json);
  if (pos.length > 1) fail("forget takes a single <id>", g.json);
  const id = Number(pos[0]);
  if (!Number.isInteger(id) || id <= 0) fail(`invalid <id> "${pos[0]}" (expected positive integer)`, g.json);
  const type = optStr(opts, "--type");
  if (type !== undefined && !FORGET_TYPES.includes(type))
    fail(`invalid --type "${type}" (expected ${FORGET_TYPES.join("|")})`, g.json);
  const { forgetHandler } = await import("../../tools/forget.js");
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
