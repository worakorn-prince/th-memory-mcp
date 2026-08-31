import fs from "node:fs";
import path from "node:path";

function flattenSuites(suites, out = {}, prefix = "") {
  for (const [name, suite] of Object.entries(suites || {})) {
    if (suite && suite.metrics && typeof suite.metrics === "object") {
      for (const [k, v] of Object.entries(suite.metrics)) {
        if (typeof v === "number") out[`${prefix}${name}.metrics.${k}`] = v;
        else if (v && typeof v === "object") {
          for (const [k2, v2] of Object.entries(v)) {
            if (typeof v2 === "number") out[`${prefix}${name}.metrics.${k}.${k2}`] = v2;
          }
        }
      }
    }
    if (suite && suite.latency && typeof suite.latency === "object") {
      for (const [op, lat] of Object.entries(suite.latency)) {
        if (lat && typeof lat === "object") {
          for (const [k, v] of Object.entries(lat)) {
            if (typeof v === "number") out[`${prefix}${name}.latency.${op}.${k}`] = v;
          }
        }
      }
    }
  }
  return out;
}

function load(spec, baseDir) {
  const p = path.resolve(spec);
  let file = null;
  if (fs.existsSync(p) && p.endsWith(".json")) file = p;
  else {
    const cand = path.join(baseDir, "versions", spec, "latest.json");
    if (fs.existsSync(cand)) file = cand;
  }
  if (!file) throw new Error(`cannot resolve version/file: ${spec}`);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  return { flat: flattenSuites(data.suites), meta: data.environment };
}

function parseArgs(argv) {
  const a = { a: null, b: null, out: path.join(process.cwd(), "results") };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--a") a.a = argv[++i];
    else if (argv[i] === "--b") a.b = argv[++i];
    else if (argv[i] === "--out") a.out = path.resolve(argv[++i]);
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.a || !args.b) {
    console.error("usage: node benchmark/compare.mjs --a <version|file> --b <version|file> [--out results]");
    process.exit(1);
  }
  const A = load(args.a, args.out);
  const B = load(args.b, args.out);
  const paths = new Set([...Object.keys(A.flat), ...Object.keys(B.flat)]);

  console.log(`A: ${A.meta.projectVersion} (${A.meta.gitCommit})  vs  B: ${B.meta.projectVersion} (${B.meta.gitCommit})`);
  console.log("metric".padEnd(48), "A".padStart(12), "B".padStart(12), "delta".padStart(12), "%".padStart(8));
  for (const p of [...paths].sort()) {
    const va = A.flat[p];
    const vb = B.flat[p];
    if (va == null || vb == null) continue;
    const d = vb - va;
    const pct = va !== 0 ? (d / Math.abs(va)) * 100 : 0;
    const arrow = d > 0 ? "▲" : d < 0 ? "▼" : "=";
    console.log(
      p.padEnd(48),
      va.toFixed(4).padStart(12),
      vb.toFixed(4).padStart(12),
      `${arrow}${Math.abs(d).toFixed(4)}`.padStart(12),
      `${pct.toFixed(1)}%`.padStart(8)
    );
  }
}

main();
