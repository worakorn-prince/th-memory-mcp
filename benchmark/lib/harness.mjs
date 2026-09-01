import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

export function makeDbPath() {
  return path.join(
    os.tmpdir(),
    `th-bench-${Date.now()}-${Math.floor(Math.random() * 1e6)}.db`
  );
}

export function setupEnv(dbPath) {
  process.env.MEMORY_DB_PATH = dbPath;
}

export function cleanupDb(dbPath) {
  for (const s of ["", "-wal", "-shm"]) {
    try {
      fs.rmSync(dbPath + s, { force: true });
    } catch {}
  }
}

export function resetDb(db) {
  const tables = [
    "memories",
    "preferences",
    "lessons",
    "interactions",
    "search_index",
    "embeddings",
    "memory_links",
    "memory_graph",
    "users",
  ];
  for (const t of tables) {
    try {
      db.prepare(`DELETE FROM ${t}`).run();
    } catch {}
  }
}

function sh(cmd, cwd) {
  try {
    return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "n/a";
  }
}

export function envInfo(extra = {}) {
  let sqlite = "?";
  try {
    sqlite = JSON.parse(
      fs.readFileSync(
        path.resolve("node_modules/better-sqlite3/package.json"),
        "utf8"
      )
    ).version;
  } catch {}
  return {
    benchmarkVersion: "2.3.0-draft",
    projectVersion: JSON.parse(
      fs.readFileSync(path.resolve("package.json"), "utf8")
    ).version,
    gitCommit: sh("git rev-parse --short HEAD", path.resolve(".")),
    os: `${os.type()} ${os.release()}`,
    cpu: os.cpus()[0]?.model || "?",
    cpuCount: os.cpus().length,
    ramMB: Math.round(os.totalmem() / 1024 / 1024),
    node: process.version,
    pnpm: sh("pnpm -v", path.resolve(".")),
    betterSqlite3: sqlite,
    datasetVersion: extra.datasetVersion || "smoke-1.0/semantic-hard-1.0/graph-1.0/scope-1.0",
    seed: extra.seed ?? null,
    retrievalMode: process.env.MEMORY_RETRIEVAL_MODE || "rrf",
    runMode: extra.runMode || null,
    profile: extra.profile || null,
    timestamp: new Date().toISOString(),
  };
}

export async function measure(fn, { warmup = 20, iterations = 100 } = {}) {
  for (let i = 0; i < warmup; i++) {
    await fn();
  }
  const lat = [];
  for (let i = 0; i < iterations; i++) {
    const t = Date.now();
    await fn();
    lat.push(Date.now() - t);
  }
  return lat;
}
