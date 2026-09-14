import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const core = readFileSync(join(repoRoot, "src", "lib", "capture-core.ts"), "utf8");
const plugin = readFileSync(join(repoRoot, "src", "plugin", "learning-capture.ts"), "utf8");

function extractPatterns(src) {
  const m = src.match(/SECRET_PATTERNS\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(m, "SECRET_PATTERNS block not found");
  const out = [];
  const re = /\/((?:\\.|[^/])+)\/([gimsuy]*)/g;
  let hit;
  while ((hit = re.exec(m[1])) !== null) out.push(`/${hit[1]}/${hit[2]}`);
  return out;
}

function extractLimits(src) {
  const m = src.match(
    /LIMITS[^=]*=\s*\{[^}]*prompt\s*:\s*(\d+)[^}]*tool_call\s*:\s*(\d+)[^}]*error\s*:\s*(\d+)[^}]*\}/
  );
  assert.ok(m, "LIMITS block not found");
  return { prompt: Number(m[1]), tool_call: Number(m[2]), error: Number(m[3]) };
}

function extractInsertSql(src) {
  const m = src.match(/INSERT INTO interactions[\s\S]*?\)/);
  assert.ok(m, "INSERT_SQL not found");
  return m[0].replace(/\s+/g, " ").trim();
}

let failures = 0;
let step = 0;
function report(ok, name, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${(step++ + "").padStart(2)} | ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
function check(name, fn) {
  try {
    fn();
    report(true, name);
  } catch (e) {
    report(false, name, e instanceof Error ? e.message : String(e));
  }
}

check("capture-sync: SECRET_PATTERNS identical (count+order+source)", () => {
  const a = extractPatterns(core);
  const b = extractPatterns(plugin);
  assert.equal(b.length, a.length, `core=${a.length} plugin=${b.length}`);
  assert.deepEqual(b, a);
});

check("capture-sync: LIMITS identical", () => {
  assert.deepEqual(extractLimits(plugin), extractLimits(core));
});

check("capture-sync: INSERT_SQL identical", () => {
  assert.equal(extractInsertSql(plugin), extractInsertSql(core));
});

check("capture-sync: filterSecrets redacts with [REDACTED] in both", () => {
  for (const [label, src] of [
    ["core", core],
    ["plugin", plugin],
  ]) {
    assert.ok(src.includes("function filterSecrets"), `${label} missing filterSecrets`);
    assert.ok(src.includes("[REDACTED]"), `${label} missing [REDACTED]`);
  }
});

console.log(
  failures === 0 ? "\nCAPTURE-SYNC TEST: ALL PASSED" : `\nCAPTURE-SYNC TEST: ${failures} FAILURE(S)`
);
process.exit(failures === 0 ? 0 : 1);
