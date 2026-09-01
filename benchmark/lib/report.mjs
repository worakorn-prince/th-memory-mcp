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
    `- Dataset: ${e.datasetVersion || "n/a"} | Seed: ${e.seed ?? "n/a"} | Retrieval: ${e.retrievalMode || "n/a"}`,
    `- Run mode: ${r.runMode}${r.profile ? ` | Profile: ${r.profile}` : ""}`,
    `- Timestamp: ${e.timestamp}`,
    `- Node: ${e.node} | OS: ${e.os}`,
    `- CPU: ${e.cpu} (x${e.cpuCount}) | RAM: ${e.ramMB}MB`,
    `- better-sqlite3: ${e.betterSqlite3}`,
    `- Args: ${JSON.stringify(r.args || {})}`,
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
    if (suite.byCategory) {
      lines.push(`- byCategory:`);
      for (const [cat, vals] of Object.entries(suite.byCategory)) {
        lines.push(`  - ${cat}:`);
        for (const [k2, v2] of Object.entries(vals)) lines.push(`    - ${k2}: ${fmt(v2)}`);
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
    if (suite.latencyMs) {
      lines.push(`- latencyMs:`);
      for (const [k2, v2] of Object.entries(suite.latencyMs)) lines.push(`  - ${k2}: ${fmt(v2)}ms`);
    }
    if (suite.cases) {
      lines.push(`- cases: ${suite.cases.length} total`);
      for (const c of suite.cases.slice(0, 5)) lines.push(`  - ${c.label}: ok=${c.ok} crashed=${c.crashed}${c.error ? ` err=${c.error.slice(0,80)}` : ""}`);
      if (suite.cases.length > 5) lines.push(`  - ... and ${suite.cases.length - 5} more`);
    }
    if (suite.notes) lines.push(`- notes: ${suite.notes}`);
    lines.push("");
  }
  const gates = [];
  const scopeOk = Object.values(r.suites || {}).some((s) => s.metrics && s.metrics.crossScopeContaminationRate === 0);
  if (scopeOk) gates.push("Scope contamination 0: PASS");
  const temporal = r.suites?.["C.temporal"]?.metrics;
  if (temporal && temporal.currentStateAccuracy === 1 && temporal.historicalStateAccuracy === 1) gates.push("Temporal 1.0: PASS");
  const storage = r.suites?.["A.storage"]?.metrics;
  if (storage && storage.storageCorrectness === 1) gates.push("Storage 1.0: PASS");
  const reliability = r.suites?.["M.reliability"]?.metrics;
  if (reliability && reliability.crashCount === 0) gates.push("Reliability no crash: PASS");
  if (gates.length) {
    lines.push("## Release Gates");
    for (const g of gates) lines.push(`- ${g}`);
    lines.push("");
  }
  lines.push("## Regression Summary");
  lines.push("- Improved: (compare with previous version via `node benchmark/compare.mjs --a <old> --b <new>`)");
  lines.push("- Unchanged: n/a");
  lines.push("- Regressed: n/a");
  lines.push("");
  lines.push("## Engineering Recommendation");
  lines.push("- See gates above; if all critical gates PASS → RELEASE, else DO NOT RELEASE");
  lines.push("");
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
      profile: results.profile || null,
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
      profile: results.profile || null,
      suites: results.suites,
    }) + "\n"
  );

  const resultDir = path.resolve("result");
  fs.mkdirSync(resultDir, { recursive: true });
  const resultMd = path.join(resultDir, `v${ver}_benchmark_result.md`);
  fs.writeFileSync(resultMd, toMarkdown(results));

  return { jsonPath, mdPath, histPath, runFile, verDir, resultMd };
}
