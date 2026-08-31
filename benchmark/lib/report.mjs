import fs from "node:fs";
import path from "node:path";

function fmt(v) {
  if (typeof v === "number") {
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(4);
  }
  if (v && typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function toMarkdown(r) {
  const e = r.environment;
  const lines = [
    "# th-memory-mcp Benchmark Report",
    "",
    `- Project: v${e.projectVersion} (${e.gitCommit})`,
    `- Benchmark spec: v${e.benchmarkVersion}`,
    `- Run mode: ${r.runMode}`,
    `- Timestamp: ${e.timestamp}`,
    `- Node: ${e.node} | OS: ${e.os}`,
    `- CPU: ${e.cpu} (x${e.cpuCount}) | RAM: ${e.ramMB}MB`,
    `- better-sqlite3: ${e.betterSqlite3}`,
    "",
  ];
  for (const [name, suite] of Object.entries(r.suites || {})) {
    lines.push(`## ${name}`);
    if (suite.metrics) {
      for (const [k, v] of Object.entries(suite.metrics)) {
        if (v && typeof v === "object" && !Array.isArray(v)) {
          lines.push(`- ${k}:`);
          for (const [k2, v2] of Object.entries(v)) {
            lines.push(`  - ${k2}: ${fmt(v2)}`);
          }
        } else {
          lines.push(`- ${k}: ${fmt(v)}`);
        }
      }
    }
    if (suite.latency) {
      if (suite.latency.min !== undefined) {
        lines.push(
          `- latency(ms): min=${fmt(suite.latency.min)} mean=${fmt(
            suite.latency.mean
          )} p95=${fmt(suite.latency.p95)} p99=${fmt(suite.latency.p99)} max=${fmt(
            suite.latency.max
          )}`
        );
      } else {
        for (const [op, l] of Object.entries(suite.latency)) {
          lines.push(
            `- latency[${op}](ms): min=${fmt(l.min)} mean=${fmt(l.mean)} p95=${fmt(
              l.p95
            )} p99=${fmt(l.p99)} max=${fmt(l.max)}`
          );
        }
      }
    }
    if (suite.notes) lines.push(`- notes: ${suite.notes}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function writeReport(results, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "latest.json");
  const mdPath = path.join(outDir, "latest.md");
  const histPath = path.join(outDir, "history.jsonl");
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));
  fs.writeFileSync(mdPath, toMarkdown(results));
  fs.appendFileSync(
    histPath,
    JSON.stringify({
      ts: results.environment.timestamp,
      projectVersion: results.environment.projectVersion,
      gitCommit: results.environment.gitCommit,
      runMode: results.runMode,
      suites: results.suites,
    }) + "\n"
  );

  const ver = results.environment.projectVersion;
  const git = results.environment.gitCommit;
  const ts = results.environment.timestamp;
  const verDir = path.join(outDir, "versions", ver);
  fs.mkdirSync(verDir, { recursive: true });
  const safeTs = ts.replace(/[:.]/g, "-");
  const runFile = path.join(verDir, `${git}-${safeTs}.json`);
  fs.writeFileSync(runFile, JSON.stringify(results, null, 2));
  fs.writeFileSync(path.join(verDir, "latest.json"), JSON.stringify(results, null, 2));
  fs.appendFileSync(
    path.join(verDir, "history.jsonl"),
    JSON.stringify({
      ts,
      gitCommit: git,
      runMode: results.runMode,
      suites: results.suites,
    }) + "\n"
  );

  const resultDir = path.resolve("result");
  fs.mkdirSync(resultDir, { recursive: true });
  const resultMd = path.join(resultDir, `v${ver}_benchmark_result.md`);
  fs.writeFileSync(resultMd, toMarkdown(results));

  return { jsonPath, mdPath, histPath, runFile, verDir, resultMd };
}
