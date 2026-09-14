import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "dist", "cli.js");
const dir = mkdtempSync(join(tmpdir(), "th-mem-cli-"));
const dbPath = join(dir, "test.db");

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, MEMORY_DB_PATH: dbPath },
    encoding: "utf8",
  });
}

test("cli --help exits 0", () => {
  const r = run(["--help"]);
  assert.equal(r.status, 0);
  assert.ok((r.stdout + r.stderr).toLowerCase().includes("usage"));
});

test("cli --version shows 2.3.0", () => {
  const r = run(["--version"]);
  assert.equal(r.status, 0);
  assert.ok((r.stdout + r.stderr).includes("2.3.0"));
});

test("cli remember then recall finds value", () => {
  const r1 = run([
    "remember",
    "--category",
    "coding_pref",
    "--key",
    "cli_key",
    "--value",
    "cli_value_xyz",
  ]);
  assert.equal(r1.status, 0, `remember failed: ${r1.stdout} ${r1.stderr}`);
  const r2 = run(["recall", "cli_key"]);
  assert.equal(r2.status, 0, `recall failed: ${r2.stdout} ${r2.stderr}`);
  assert.ok(r2.stdout.includes("cli_value_xyz"), `recall output: ${r2.stdout}`);
});

test("cli stats mentions preferences", () => {
  const r = run(["stats"]);
  assert.equal(r.status, 0, `stats failed: ${r.stdout} ${r.stderr}`);
  assert.ok(
    (r.stdout + r.stderr).toLowerCase().includes("preferences"),
    `stats output: ${r.stdout}`
  );
});

test("cli forget removes entry", () => {
  const r1 = run([
    "remember",
    "--category",
    "coding_pref",
    "--key",
    "cli_forget_key",
    "--value",
    "cli_forget_val_xyz",
  ]);
  assert.equal(r1.status, 0, `remember failed: ${r1.stdout} ${r1.stderr}`);
  const m = (r1.stdout + r1.stderr).match(/id=(\d+)/);
  assert.ok(m, `no id in remember output: ${r1.stdout}`);
  const id = m[1];
  const r2 = run(["forget", id, "--type", "preference"]);
  assert.equal(r2.status, 0, `forget failed: ${r2.stdout} ${r2.stderr}`);
  const r3 = run(["recall", "cli_forget_val_xyz"]);
  assert.equal(r3.status, 0, `recall failed: ${r3.stdout} ${r3.stderr}`);
  assert.ok(
    !r3.stdout.includes("cli_forget_val_xyz"),
    `forgotten value still recalled: ${r3.stdout}`
  );
});

test("cli unknown command exits non-zero", () => {
  const r = run(["badcmd"]);
  assert.notEqual(r.status, 0);
});
