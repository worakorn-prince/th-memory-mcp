// scripts/check-capture-sync.mjs
// Guards secret-filtering drift between capture core and the deployed hook.
// Compares src/lib/capture-core.ts (single source of truth, built) with
// src/plugin/learning-capture.ts (standalone dual-mode V1/V2 plugin, checked
// separately via tsconfig.plugin.json and excluded from the main tsc build via
// tsconfig.json "exclude": ["src/plugin"]).
//
// Why not re-include src/plugin in build: learning-capture.ts resolves
// "node:sqlite"/"bun:sqlite" at runtime and imports @opencode/plugin types
// only, so its typecheck uses a dedicated noEmit config
// (`npm run typecheck:plugin`) instead of the main build. The lighter guard
// here is this sync check (+ test/).
//
// The checks live in runCaptureSyncChecks() so test/capture-sync.test.mjs
// can import the same logic (single source of truth) instead of duplicating
// the regex extraction. Running this file directly keeps the CLI behavior
// (`npm run check:capture-sync`).
//
// Checks (secret filtering only):
//   1. SECRET_PATTERNS regex list identical (order + source + flags)
//   2. LIMITS prompt/tool_call/error identical
//   3. INSERT_SQL normalized identical
//   4. filterSecrets redacts with "[REDACTED]" in both files
//   5. memory-format constants (MEMORY_REF_OPEN/CLOSE/GUIDANCE) mirrored in plugin
// NOTE: SECRET_LINE is intentionally NOT compared — capture-core keeps a
// narrow SECRET_LINE for tests while the plugin aliases PATTERNS[0]; neither
// is used in the redaction path (filterSecrets loops SECRET_PATTERNS).
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corePath = join(repoRoot, "src", "lib", "capture-core.ts");
const pluginPath = join(repoRoot, "src", "plugin", "learning-capture.ts");
const fmtPath = join(repoRoot, "src", "lib", "memory-format.ts");

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

function readSource(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function runCaptureSyncChecks() {
  const checks = [];
  const summary = { secretPatternCount: null, limits: null };

  const check = (name, fn) => {
    const result = { name, ok: false, detail: "" };
    try {
      const detail = fn();
      result.ok = true;
      if (detail) result.detail = detail;
    } catch (e) {
      result.detail = e instanceof Error ? e.message : String(e);
    }
    checks.push(result);
  };

  const core = readSource(corePath);
  const plugin = readSource(pluginPath);
  const fmt = readSource(fmtPath);

  const requireFiles = (...pairs) => {
    for (const [path, src] of pairs) {
      if (!src) throw new Error(`cannot read ${path}`);
    }
  };

  check("SECRET_PATTERNS identical (count+order+source)", () => {
    requireFiles([corePath, core], [pluginPath, plugin]);
    const corePats = extractPatterns(core);
    const pluginPats = extractPatterns(plugin);
    if (!corePats || !pluginPats) {
      throw new Error("SECRET_PATTERNS block not found in one of the files");
    }
    if (
      corePats.length !== pluginPats.length ||
      corePats.some((p, i) => p !== pluginPats[i])
    ) {
      throw new Error(
        `drift: core(${corePats.length}) vs plugin(${pluginPats.length})\ncore:   ${JSON.stringify(corePats)}\nplugin: ${JSON.stringify(pluginPats)}`
      );
    }
    summary.secretPatternCount = corePats.length;
    return `${corePats.length} patterns`;
  });

  check("LIMITS identical", () => {
    requireFiles([corePath, core], [pluginPath, plugin]);
    const coreLim = extractLimits(core);
    const pluginLim = extractLimits(plugin);
    if (!coreLim || !pluginLim) {
      throw new Error("LIMITS block not found in one of the files");
    }
    if (
      coreLim.prompt !== pluginLim.prompt ||
      coreLim.tool_call !== pluginLim.tool_call ||
      coreLim.error !== pluginLim.error
    ) {
      throw new Error(
        `drift: core=${JSON.stringify(coreLim)} plugin=${JSON.stringify(pluginLim)}`
      );
    }
    summary.limits = coreLim;
    return JSON.stringify(coreLim);
  });

  check("INSERT_SQL identical", () => {
    requireFiles([corePath, core], [pluginPath, plugin]);
    const coreSql = extractInsertSql(core);
    const pluginSql = extractInsertSql(plugin);
    if (!coreSql || !pluginSql) {
      throw new Error("INSERT_SQL not found in one of the files");
    }
    if (coreSql !== pluginSql) {
      throw new Error(`drift:\ncore:   ${coreSql}\nplugin: ${pluginSql}`);
    }
  });

  check("filterSecrets redacts with [REDACTED] in both", () => {
    requireFiles([corePath, core], [pluginPath, plugin]);
    for (const [label, src] of [
      ["core", core],
      ["plugin", plugin],
    ]) {
      if (!src.includes("[REDACTED]") || !src.includes("function filterSecrets")) {
        throw new Error(`${label}: filterSecrets missing [REDACTED] redaction`);
      }
    }
  });

  check("memory-format constants (MEMORY_REF_*/GUIDANCE) mirrored in plugin", () => {
    requireFiles([fmtPath, fmt], [pluginPath, plugin]);
    const fmtConsts = [
      "MEMORY_REF_OPEN",
      "MEMORY_REF_CLOSE",
      "MEMORY_REF_GUIDANCE",
    ];
    for (const name of fmtConsts) {
      const fmtVal = fmt.match(new RegExp(`export const ${name}\\s*=\\s*([^;]+);`));
      const pluginVal = plugin.match(new RegExp(`const ${name}\\s*=\\s*([^;]+);`));
      if (!fmtVal || !pluginVal) {
        throw new Error(`const ${name} not found in one of the files`);
      }
      if (fmtVal[1].trim() !== pluginVal[1].trim()) {
        throw new Error(
          `const ${name} drift:\nmemory-format: ${fmtVal[1].trim()}\nplugin:        ${pluginVal[1].trim()}`
        );
      }
    }
    // SEC-07: both copies must neutralize memory-reference tags before wrapping.
    for (const [label, src] of [
      ["memory-format", fmt],
      ["plugin", plugin],
    ]) {
      if (!src.includes("function sanitizeMemoryText")) {
        throw new Error(`${label}: sanitizeMemoryText missing`);
      }
      if (
        !src.includes("&lt;") ||
        !src.includes("memory-reference\\b[^>]*>/gi")
      ) {
        throw new Error(
          `${label}: sanitizeMemoryText must neutralize memory-reference tags via &lt; and the hardened /<\\/?memory-reference\\b[^>]*>/gi pattern`
        );
      }
    }
  });

  return { checks, summary };
}

const isMain = (() => {
  if (!process.argv[1]) return false;
  const invoked = resolve(process.argv[1]);
  const self = fileURLToPath(import.meta.url);
  return process.platform === "win32"
    ? invoked.toLowerCase() === self.toLowerCase()
    : invoked === self;
})();

if (isMain) {
  const { checks, summary } = runCaptureSyncChecks();
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.error("[check-capture-sync] DRIFT DETECTED:");
    for (const f of failed) console.error(` - ${f.name}: ${f.detail}`);
    console.error(
      "[check-capture-sync] fix: copy SECRET_PATTERNS/LIMITS/INSERT_SQL/filterSecrets from src/lib/capture-core.ts into src/plugin/learning-capture.ts"
    );
    process.exit(1);
  }
  console.log(
    `[check-capture-sync] ok: ${summary.secretPatternCount} SECRET_PATTERNS, LIMITS ${JSON.stringify(summary.limits)} in sync`
  );
}
