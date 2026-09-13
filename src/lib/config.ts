// config: shared constants. Pure module — no side effects, no I/O.
import { fileURLToPath } from "node:url";

// Keep this in sync with package.json.  It is surfaced in the MCP handshake
// and in export files, so a stale value makes backups harder to diagnose.
export const VERSION = "2.2.9";

// dist/lib/config.js -> <project>/data/memory.db (independent of cwd).
export const DEFAULT_DB_PATH = fileURLToPath(
  new URL("../../data/memory.db", import.meta.url)
);

export const EXPORTS_DIRNAME = "exports";
