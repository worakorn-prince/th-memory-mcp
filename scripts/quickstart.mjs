// scripts/quickstart.mjs
// One-command installer for th-memory-mcp.
// Chained from `npm run quickstart` (which runs `npm run build` first).
// Wires opencode.json/opencode.jsonc, deploys the dual-mode (V1 + V2) capture
// plugin, and sets MEMORY_DB_PATH.
//
// OpenCode V2 loads local plugins from a DIRECTORY, so the plugin is deployed
// to ~/.config/opencode/plugins/learning-capture/index.ts. A legacy single-file
// install (~/.config/opencode/plugins/learning-capture.ts) is renamed to
// .bak-<timestamp> (never deleted) so V1 keeps working from the new location
// via the `server` hook.
//
// Safe to inspect with: node scripts/quickstart.mjs --dry-run
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  renameSync,
} from "node:fs";
import { spawnSync } from "node:child_process";

const dryRun = process.argv.includes("--dry-run");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = join(repoRoot, "data", "memory.db");
const pluginSrc = join(repoRoot, "src", "plugin", "learning-capture.ts");
const opencodeDir = join(homedir(), ".config", "opencode");
const pluginsDir = join(opencodeDir, "plugins");
const pluginDst = join(pluginsDir, "learning-capture", "index.ts");
const legacyPluginDst = join(pluginsDir, "learning-capture.ts");
const opencodeJsonc = join(opencodeDir, "opencode.jsonc");
const opencodeJson = join(opencodeDir, "opencode.json");
const instructionsPath = join(repoRoot, "AGENTS.memory.example.md");

const log = (m) => console.log(`[quickstart] ${m}`);
const warn = (m) => console.warn(`[quickstart] WARNING: ${m}`);

// Fail fast BEFORE touching the user's config/plugins: a missing plugin source
// would otherwise leave a half-applied install (config written, plugin absent).
if (!existsSync(pluginSrc)) {
  warn(`plugin source not found: ${pluginSrc}`);
  warn(`run "npm run build" first, then re-run: npm run quickstart`);
  process.exit(1);
}

const ensureDir = (p) => {
  if (dryRun) log(`(dry-run) would mkdir ${p}`);
  else mkdirSync(p, { recursive: true });
};
const backupFile = (p) => {
  if (!existsSync(p)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const bak = `${p}.bak-${stamp}`;
  if (dryRun) log(`(dry-run) would backup ${p} -> ${bak}`);
  else {
    copyFileSync(p, bak);
    log(`backup ${p} -> ${bak}`);
  }
};
const renameToBackup = (p) => {
  if (!existsSync(p)) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const bak = `${p}.bak-${stamp}`;
  if (dryRun) log(`(dry-run) would move legacy plugin ${p} -> ${bak}`);
  else {
    renameSync(p, bak);
    log(`moved legacy plugin ${p} -> ${bak}`);
  }
};
const write = (p, c) => {
  if (dryRun) log(`(dry-run) would write ${p}`);
  else writeFileSync(p, c, "utf8");
};
const copy = (s, d) => {
  if (dryRun) log(`(dry-run) would copy ${s} -> ${d}`);
  else copyFileSync(s, d);
};

// --- JSONC (comment/trailing-comma safe) ---
function stripJsonComments(input) {
  let out = "";
  let inString = false;
  let escaped = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

function stripTrailingCommas(input) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j])) j++;
      if (input[j] === "}" || input[j] === "]") continue;
    }
    out += ch;
  }
  return out;
}

function parseJsonc(text) {
  return JSON.parse(stripTrailingCommas(stripJsonComments(text)));
}

// 1. ensure data dir exists so the DB path is valid (no-op under --dry-run)
ensureDir(dirname(dbPath));

// 2. read / merge existing config (prefer opencode.jsonc, then opencode.json)
const existingCfg = [opencodeJsonc, opencodeJson].find((p) => existsSync(p));
const cfgPath = existingCfg ?? opencodeJson;
let cfg = {};
let cfgWritable = true;
if (existingCfg) {
  const isJsonc = existingCfg === opencodeJsonc;
  log(`found existing ${isJsonc ? "opencode.jsonc" : "opencode.json"}`);
  try {
    const raw = readFileSync(existingCfg, "utf8");
    cfg = isJsonc ? parseJsonc(raw) : JSON.parse(raw);
  } catch (e) {
    cfgWritable = false;
    warn(
      `could not parse ${existingCfg}: ${e.message}; leaving it untouched (fix the file or merge mcp.memory manually)`
    );
  }
} else {
  log(`no opencode.json/opencode.jsonc yet - will create opencode.json`);
}

if (cfgWritable) {
  if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg)) {
    cfgWritable = false;
    warn(`existing config is not a JSON object; leaving it untouched`);
  }
}

if (cfgWritable) {
  cfg.mcp = cfg.mcp && typeof cfg.mcp === "object" ? cfg.mcp : {};
  if (cfg.mcp.memory) warn(`replacing existing mcp.memory config`);
  cfg.mcp.memory = {
    type: "local",
    command: ["node", join(repoRoot, "dist", "index.js")],
    enabled: true,
    environment: { MEMORY_DB_PATH: dbPath },
  };

  // instructions: normalize to array, dedupe, append our protocol file
  let instructions = cfg.instructions;
  if (typeof instructions === "string") instructions = [instructions];
  if (!Array.isArray(instructions)) instructions = [];
  if (!instructions.includes(instructionsPath)) instructions.push(instructionsPath);
  cfg.instructions = instructions;

  ensureDir(opencodeDir);
  // Backup existing config before overwrite (normal mode only; dry-run just logs).
  backupFile(cfgPath);
  write(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  log(`${cfgPath} ${dryRun ? "would be written" : "written"}`);
}

// 3. deploy plugin to the V2 directory layout
//    ~/.config/opencode/plugins/learning-capture/index.ts
ensureDir(dirname(pluginDst));
// Legacy V1 single-file install would shadow/conflict with the directory.
renameToBackup(legacyPluginDst);
// Re-deploying over an existing install: keep a copy of the previous file.
backupFile(pluginDst);
copy(pluginSrc, pluginDst);
log(`plugin (dual V1/V2) ${dryRun ? "would be deployed" : "deployed"} -> ${pluginDst}`);

// 4. set MEMORY_DB_PATH so the plugin (OpenCode process) sees the same DB
const isWindows = process.platform === "win32";
if (isWindows) {
  if (dryRun) {
    log(`(dry-run) would setx MEMORY_DB_PATH=${dbPath}`);
  } else {
    const r = spawnSync("setx", ["MEMORY_DB_PATH", dbPath], { stdio: "inherit" });
    if (r.status === 0) log(`set MEMORY_DB_PATH (user env) -> ${dbPath}`);
    else warn(`failed to setx MEMORY_DB_PATH; set it manually`);
  }
} else {
  warn(`please add to your shell profile: export MEMORY_DB_PATH="${dbPath}"`);
}

log("done.");
log('Next: restart OpenCode, then try: "Remember that I prefer pnpm"');
