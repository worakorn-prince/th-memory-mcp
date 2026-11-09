// thai-fts standalone CLI: end-to-end over the BUILT zero-dep binary.
// Spawns node dist/thai-cli.js via child_process (cwd = repo root), so every
// assertion hits the shipped surface the same way a real pipe user would.
// Must run after `npm run build` (npm test builds first).
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "thai-cli.js");

function run(args) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cli, ...args],
      { cwd: root, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (err) {
          reject(
            new Error(
              `thai-fts ${args.join(" ")} failed: ${err.message}\nstdout: ${stdout}\nstderr: ${stderr}`
            )
          );
        } else {
          resolve(stdout);
        }
      }
    );
  });
}

test("dist/thai-cli.js retains the shebang", () => {
  const firstLine = readFileSync(cli, "utf8").split("\n")[0];
  assert.equal(firstLine, "#!/usr/bin/env node");
});

test("thai-fts segment splits unspaced Thai into >=2 words that rejoin to the source", async () => {
  const source = "ติดตั้งโปรแกรม";
  const out = await run(["segment", source]);
  const lines = out.trim().split("\n").filter(Boolean);
  assert.ok(lines.length >= 2, `expected >=2 tokens, got: ${JSON.stringify(lines)}`);
  assert.equal(lines.join(""), source, "tokens must rejoin to the original characters");
});

test("thai-fts loose prints the de-accented form", async () => {
  const { looseForm } = await import("../dist/lib/thai-segment.js");
  const out = await run(["loose", "ติดตั้ง"]);
  assert.equal(out.trim(), looseForm("ติดตั้ง"));
  assert.equal(out.trim(), "ติดตัง");
});

test("thai-fts synonyms resolves a known transliteration", async () => {
  const out = await run(["synonyms", "deploy"]);
  assert.ok(out.includes("ดีพลอย"), `expected ดีพลอย in: ${JSON.stringify(out)}`);
});

test("thai-fts check returns 1/0 for Thai presence", async () => {
  assert.equal((await run(["check", "abc"])).trim(), "0");
  assert.equal((await run(["check", "ติดตั้ง"])).trim(), "1");
  assert.equal((await run(["check", "npm run build"])).trim(), "0");
});

test("thai-fts --json wraps output as { ok, data }", async () => {
  const check = JSON.parse(await run(["--json", "check", "ติดตั้ง"]));
  assert.deepEqual(check, { ok: true, data: "1" });

  const seg = JSON.parse(await run(["--json", "segment", "ติดตั้ง"]));
  assert.equal(seg.ok, true);
  assert.ok(typeof seg.data === "string" && seg.data.length > 0);
});
