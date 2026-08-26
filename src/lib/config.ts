// config: shared constants. Pure module — no side effects, no I/O.
import { fileURLToPath } from "node:url";

export const VERSION = "1.1.0";

// dist/lib/config.js -> <project>/data/memory.db (independent of cwd).
export const DEFAULT_DB_PATH = fileURLToPath(
  new URL("../../data/memory.db", import.meta.url)
);

export const EXPORTS_DIRNAME = "exports";
