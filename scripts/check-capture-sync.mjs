// scripts/check-capture-sync.mjs
// Guards secret-filtering drift between capture core and the deployed hook.
// Compares src/lib/capture-core.ts (single source of truth, built) with
// src/plugin/learning-capture.ts (standalone bun:sqlite plugin, excluded
// from tsc build via tsconfig.json "exclude": ["src/plugin"]).
//
// Why not re-include src/plugin in build: learning-capture.ts imports
// "bun:sqlite", which tsc/node CI cannot resolve — re-including breaks
// `npm run build`. The lighter guard is this sync check (+ test/).
//
// Checks (secret filtering only):
//   1. SECRET_PATTERNS regex list identical (order + source + flags)
//   2. LIMITS prompt/tool_call/error identical
//   3. INSERT_SQL normalized identical
//   4. filterSecrets redacts with "[REDACTED]" in both files
// NOTE: SECRET_LINE is intentionally NOT compared — capture-core keeps a
// narrow SECRET_LINE for tests while the plugin aliases PATTERNS[0]; neither
// is used in the redaction path (filterSecrets loops SECRET_PATTERNS).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corePath = join(repoRoot, "src", "lib", "capture-core.ts");
const pluginPath = join(repoRoot, "src", "plugin", "learning-capture.ts");

function extractPatterns(src) {
  const m = src.match(/SECRET_PATTERNS\s*=\s*\[([\s\S]*?)\];/);
  if (!m) return null;
  const block = m[1];
  const out = [];
  const re = /\/((?:\\.|[^/])+)\/([gimsuy]*)/g;
  let hit;
  while ((hit = re.exec(block)) !== null) out.push(`/${hit[1]}/${hit[2]}`);
  return out;
}

function extractLimits(src) {
  const m = src.match(
    /LIMITS[^=]*=\s*\{[^}]*prompt\s*:\s*(\d+)[^}]*tool_call\s*:\s*(\d+)[^}]*error\s*:\s*(\d+)[^}]*\}/
  );
  if (!m) return null;
  return { prompt: Number(m[1]), tool_call: Number(m[2]), error: Number(m[3]) };
}

function extractInsertSql(src) {
  const m = src.match(/INSERT INTO interactions[\s\S]*?\)/);
  if (!m) return null;
  return m[0].replace(/\s+/g, " ").trim();
}

const failures = [];
let core;
let plugin;
try {
  core = readFileSync(corePath, "utf8");
} catch (e) {
  console.error(`[check-capture-sync] cannot read ${corePath}: ${e.message}`);
  process.exit(1);
}
try {
  plugin = readFileSync(pluginPath, "utf8");
} catch (e) {
  console.error(`[check-capture-sync] cannot read ${pluginPath}: ${e.message}`);
  process.exit(1);
}

// 1. SECRET_PATTERNS
const corePats = extractPatterns(core);
const pluginPats = extractPatterns(plugin);
if (!corePats || !pluginPats) {
  failures.push("SECRET_PATTERNS block not found in one of the files");
} else if (
  corePats.length !== pluginPats.length ||
  corePats.some((p, i) => p !== pluginPats[i])
) {
  failures.push(
    `SECRET_PATTERNS drift: core(${corePats.length}) vs plugin(${pluginPats.length})\ncore:   ${JSON.stringify(corePats)}\nplugin: ${JSON.stringify(pluginPats)}`
  );
}

// 2. LIMITS
const coreLim = extractLimits(core);
const pluginLim = extractLimits(plugin);
if (!coreLim || !pluginLim) {
  failures.push("LIMITS block not found in one of the files");
} else if (
  coreLim.prompt !== pluginLim.prompt ||
  coreLim.tool_call !== pluginLim.tool_call ||
  coreLim.error !== pluginLim.error
) {
  failures.push(
    `LIMITS drift: core=${JSON.stringify(coreLim)} plugin=${JSON.stringify(pluginLim)}`
  );
}

// 3. INSERT_SQL
const coreSql = extractInsertSql(core);
const pluginSql = extractInsertSql(plugin);
if (!coreSql || !pluginSql) {
  failures.push("INSERT_SQL not found in one of the files");
} else if (coreSql !== pluginSql) {
  failures.push(`INSERT_SQL drift:\ncore:   ${coreSql}\nplugin: ${pluginSql}`);
}

// 4. filterSecrets redaction marker
for (const [label, src] of [
  ["core", core],
  ["plugin", plugin],
]) {
  if (!src.includes("[REDACTED]") || !src.includes("function filterSecrets")) {
    failures.push(`${label}: filterSecrets missing [REDACTED] redaction`);
  }
}

// 5. memory-format constants drift: learning-capture.ts ships standalone and
// mirrors MEMORY_REF_*/GUIDANCE/UNTRUSTED_* from src/lib/memory-format.ts.
// Guard the mirror so a guidance change in memory-format.ts cannot silently
// diverge from the deployed hook.
const fmtPath = join(repoRoot, "src", "lib", "memory-format.ts");
let fmt;
try {
  fmt = readFileSync(fmtPath, "utf8");
} catch (e) {
  console.error(`[check-capture-sync] cannot read ${fmtPath}: ${e.message}`);
  process.exit(1);
}
const fmtConsts = [
  "MEMORY_REF_OPEN",
  "MEMORY_REF_CLOSE",
  "MEMORY_REF_GUIDANCE",
];
for (const name of fmtConsts) {
  const fmtVal = fmt.match(new RegExp(`export const ${name}\\s*=\\s*([^;]+);`));
  const pluginVal = plugin.match(new RegExp(`const ${name}\\s*=\\s*([^;]+);`));
  if (!fmtVal || !pluginVal) {
    failures.push(`memory-format const ${name} not found in one of the files`);
  } else if (fmtVal[1].trim() !== pluginVal[1].trim()) {
    failures.push(
      `memory-format const ${name} drift:\nmemory-format: ${fmtVal[1].trim()}\nplugin:        ${pluginVal[1].trim()}`
    );
  }
}

if (failures.length > 0) {
  console.error("[check-capture-sync] DRIFT DETECTED:");
  for (const f of failures) console.error(` - ${f}`);
  console.error(
    "[check-capture-sync] fix: copy SECRET_PATTERNS/LIMITS/INSERT_SQL/filterSecrets from src/lib/capture-core.ts into src/plugin/learning-capture.ts"
  );
  process.exit(1);
}

console.log(
  `[check-capture-sync] ok: ${corePats.length} SECRET_PATTERNS, LIMITS ${JSON.stringify(coreLim)} in sync`
);
