import { fail, optBool, optStr, output, readStdin, type CliOpts, type Globals } from "./shared.js";

export async function runExport(opts: CliOpts, pos: string[], g: Globals): Promise<number> {
  if (pos.length > 0) fail("export takes no positional args (see export --help)", g.json);
  const { exportMemoryHandler } = await import("../../tools/export_memory.js");
  return output(
    await exportMemoryHandler({
      includeInteractions: optBool(opts, "--include-interactions"),
      ...(optStr(opts, "--filename") === undefined ? {} : { filename: optStr(opts, "--filename") as string }),
    }),
    g
  );
}

export async function runImport(opts: CliOpts, pos: string[], g: Globals): Promise<number> {
  if (pos.length > 0) fail("import takes no positional args (see import --help)", g.json);
  let file = optStr(opts, "--file");
  let json = optStr(opts, "--json");
  if ((file === undefined) === (json === undefined))
    fail("import requires exactly one of --file <path> or --json <string>", g.json);
  if (json === "-") json = readStdin();
  const userId = optStr(opts, "--user-id");
  const { importMemoryHandler } = await import("../../tools/import_memory.js");
  return output(
    importMemoryHandler({
      ...(file === undefined ? {} : { file }),
      ...(json === undefined ? {} : { json }),
      apply: optBool(opts, "--apply"),
      ...(userId === undefined ? {} : { userId }),
    }),
    g
  );
}
