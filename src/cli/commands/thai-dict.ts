import { err, ok } from "../../db/index.js";
import { fail, output, optStr, type CliOpts, type Globals } from "./shared.js";

interface DictEntry {
  term: string;
  kind: string;
  pair: string;
  source: string;
  project_id: string | null;
  created_at: string;
}

/**
 * thai-dict <list|add|rm> — inspect/extend the personal Thai lexeme registry.
 *   list                       show every entry (term, kind, pair, source, project)
 *   add --kind <s|segment> --term <t> --pair <p> [--project <id>]
 *   rm --term <t>  (or positional)
 */
export async function runThaiDict(opts: CliOpts, pos: string[], g: Globals): Promise<number> {
  const {
    addSynonym,
    addSegmentOverride,
    removeTerm,
    getDictEntries,
    learnFromLessons,
  } = await import("../../db/thai-dict.js");

  const sub = pos[0];
  if (sub === undefined) fail("thai-dict requires <list|add|rm> (see help)", g.json);

  switch (sub) {
    case "list":
    case "ls": {
      const rows = (() => {
        try {
          return getDictEntries() as DictEntry[];
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return fail(`thai_dict unavailable: ${msg}`, g.json);
        }
      })();
      if (g.json) return output(ok(JSON.stringify(rows)), g);
      if (rows.length === 0) return output(ok("(empty thai_dict)"), g);
      const text = rows
        .map(
          (r) =>
            `${r.term}\t${r.kind}\t${r.pair}\t${r.source}${r.project_id ? `\t${r.project_id}` : ""}`
        )
        .join("\n");
      return output(ok(text), g);
    }
    case "learn": {
      try {
        const learned = learnFromLessons();
        return output(ok(`thai_dict: learned ${learned} synonym(s) from lessons`), g);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return output(err(msg), g);
      }
    }
    case "add": {
      const kind = optStr(opts, "--kind") ?? "synonym";
      if (kind !== "synonym" && kind !== "segment")
        fail(`--kind must be synonym|segment (got "${kind}")`, g.json);
      const term = optStr(opts, "--term");
      const pair = optStr(opts, "--pair");
      if (!term) fail("add requires --term <t>", g.json);
      if (!pair) fail("add requires --pair <p>", g.json);
      const projectId = optStr(opts, "--project") ?? null;
      try {
        if (kind === "synonym") addSynonym(term, pair, { projectId });
        else addSegmentOverride(term, pair, { projectId });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return output(err(msg), g);
      }
      return output(ok(`thai_dict: added ${kind} ${term} = ${pair}`), g);
    }
    case "rm":
    case "remove": {
      const term = optStr(opts, "--term") ?? pos[1];
      if (!term) fail("rm requires --term <t>", g.json);
      try {
        const { removed } = removeTerm(term);
        return output(
          ok(removed ? `thai_dict: removed ${term}` : `thai_dict: no entry for ${term}`),
          g
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return output(err(msg), g);
      }
    }
    default:
      fail(`unknown thai-dict subcommand "${sub}" (see help)`, g.json);
  }
}
