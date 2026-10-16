import { CATEGORIES } from "../help.js";
import { fail, optStr, output, readStdin, type CliOpts, type Globals } from "./shared.js";

export async function runRemember(opts: CliOpts, pos: string[], g: Globals): Promise<number> {
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
  const { rememberHandler } = await import("../../tools/remember.js");
  return output(
    await rememberHandler({
      category: category as "work_style" | "coding_pref" | "language" | "domain" | "other",
      key,
      value,
    }),
    g
  );
}
