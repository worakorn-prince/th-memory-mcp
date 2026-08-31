import { execFileSync } from "node:child_process";
import path from "node:path";
import { summarizeLatencies } from "../lib/metrics.mjs";

const OPS = ["remember", "recall", "getContext", "retrieve", "createMemory", "updateMemory", "mergeMemory", "linkMemory", "forget"];
const SAMPLES = 5;

export function runColdSuite(_mods, opts = {}) {
  const samples = opts.coldSamples || SAMPLES;
  const worker = path.resolve("benchmark/lib/cold_worker.mjs");
  const out = {};
  for (const op of OPS) {
    const runs = [];
    for (let i = 0; i < samples; i++) {
      const res = JSON.parse(
        execFileSync("node", [worker, op], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      );
      runs.push(res.ms);
    }
    out[op] = summarizeLatencies(runs);
  }
  return {
    metrics: { operations: OPS.length, samples },
    latency: out,
    notes: `cold = fresh process + fresh DB per call; reports min/mean/p95/max over ${samples} spawns (§12.2)`,
  };
}
