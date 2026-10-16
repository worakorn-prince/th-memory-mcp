import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const pkgVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;

const VERSION_POINT_FILES = [
  "README.md",
  "README.th.md",
  "ARCHITECTURE_v2.md",
  "design.md",
  "server.json",
  "src/lib/config.ts",
].filter((f) => existsSync(join(root, f)));

test("sync-version --check passes for all version reference points", () => {
  const r = spawnSync(process.execPath, [join(root, "scripts", "sync-version.mjs"), "--check"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `sync-version --check failed:\n${r.stdout}\n${r.stderr}`);
  const covered = VERSION_POINT_FILES.every((f) => r.stdout.includes(f));
  assert.ok(covered, `sync-version --check output should mention all version points: ${r.stdout}`);
});

test("src/lib/config.ts VERSION matches package.json", () => {
  const src = readFileSync(join(root, "src", "lib", "config.ts"), "utf8");
  const m = src.match(/export const VERSION = "(\d+\.\d+\.\d+)"/);
  assert.ok(m, "VERSION constant not found in src/lib/config.ts");
  assert.equal(m[1], pkgVersion);
});
