#!/usr/bin/env node
// Test entry point.
//
// Why this exists: every suite owns its database and sets MEMORY_DB_PATH to a
// temp file. If the *ambient* environment already has MEMORY_DB_PATH (a shell
// that exported it, an editor launch config, a CI job that reused a machine),
// any suite that forgets to override it would read and write the operator's
// live store — and behave differently from a clean checkout. That makes
// `npm test` non-reproducible and can corrupt real data.
//
// This runner removes that one variable before spawning the test process and
// leaves the mode switches alone, so an encrypted run stays encrypted
// (MEMORY_ENCRYPTION / MEMORY_ENCRYPTION_KEY) while no test can inherit a
// live database path.
//
// Usage: node scripts/run-tests.mjs [node --test args...]
import { spawnSync } from "node:child_process";

const env = { ...process.env };
delete env.MEMORY_DB_PATH;

if (env.MEMORY_DB_PATH === undefined) {
  // Nothing else to sanitise: each suite sets its own MEMORY_DB_PATH,
  // MEMORY_AUTH and MEMORY_ENCRYPTION explicitly when it cares.
}

const args = process.argv.slice(2);
const result = spawnSync(process.execPath, ["--test", ...args], {
  stdio: "inherit",
  env,
  windowsHide: true,
});

if (result.error) {
  process.stderr.write(`[run-tests] cannot start the test runner: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
