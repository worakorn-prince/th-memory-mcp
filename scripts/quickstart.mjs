// scripts/quickstart.mjs
// One-command installer for th-memory-mcp.
// Chained from `npm run quickstart` (which runs `npm run build` first).
// Wires opencode.json, deploys the auto-capture plugin, and sets MEMORY_DB_PATH.
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
} from "node:fs";
import { spawnSync } from "node:child_process";

const dryRun = process.argv.includes("--dry-run");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = join(repoRoot, "data", "memory.db");
const pluginSrc = join(repoRoot, "src", "plugin", "learning-capture.ts");
const opencodeDir = join(homedir(), ".config", "opencode");
const pluginDst = join(opencodeDir, "plugins", "learning-capture.ts");
const opencodeCfg = join(opencodeDir, "opencode.json");
const instructionsPath = join(repoRoot, "AGENTS.memory.example.md");

const log = (m) => console.log(`[quickstart] ${m}`);
const warn = (m) => console.warn(`[quickstart] WARNING: ${m}`);
const write = (p, c) => {
  if (dryRun) log(`(dry-run) would write ${p}`);
  else writeFileSync(p, c, "utf8");
};
const copy = (s, d) => {
  if (dryRun) log(`(dry-run) would copy ${s} -> ${d}`);
  else copyFileSync(s, d);
};

// 1. ensure data dir exists so the DB path is valid
mkdirSync(dirname(dbPath), { recursive: true });

// 2. read / merge opencode.json
let cfg = {};
if (existsSync(opencodeCfg)) {
  try {
    cfg = JSON.parse(readFileSync(opencodeCfg, "utf8"));
    log(`found existing opencode.json`);
  } catch (e) {
    warn(`could not parse ${opencodeCfg}: ${e.message}; starting fresh`);
    cfg = {};
  }
} else {
  log(`no opencode.json yet - will create one`);
}

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

mkdirSync(opencodeDir, { recursive: true });
write(opencodeCfg, JSON.stringify(cfg, null, 2) + "\n");
log(`opencode.json ${dryRun ? "would be written" : "written"} at ${opencodeCfg}`);

// 3. deploy plugin
mkdirSync(dirname(pluginDst), { recursive: true });
copy(pluginSrc, pluginDst);
log(`plugin ${dryRun ? "would be deployed" : "deployed"} -> ${pluginDst}`);

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
