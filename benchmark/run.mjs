import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

import { setupEnv, cleanupDb, envInfo, makeDbPath, resetDb } from "./lib/harness.mjs";
import { writeReport } from "./lib/report.mjs";
import { runStorageSuite } from "./suites/storage.mjs";
import { runRetrievalSuite } from "./suites/retrieval.mjs";
import { runPerformanceSuite } from "./suites/performance.mjs";
import {
  runTemporalSuite,
  runConflictSuite,
  runScopeSuite,
} from "./suites/temporal.mjs";
import { runContextSuite } from "./suites/context.mjs";
import { runScalabilitySuite } from "./suites/scalability.mjs";
import { runColdSuite } from "./suites/cold.mjs";
import { runAblationSuite } from "./suites/ablation.mjs";

function parseArgs(argv) {
  const a = {
    suite: "all",
    warmup: 20,
    iterations: 100,
    k: 10,
    topics: 120,
    distractors: 100,
    out: path.join(process.cwd(), "results"),
    runMode: "warm",
    scale: 1000,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--suite") a.suite = argv[++i];
    else if (arg === "--warmup") a.warmup = Number(argv[++i]);
    else if (arg === "--iterations") a.iterations = Number(argv[++i]);
    else if (arg === "--k") a.k = Number(argv[++i]);
    else if (arg === "--topics") a.topics = Number(argv[++i]);
    else if (arg === "--distractors") a.distractors = Number(argv[++i]);
    else if (arg === "--scale") a.scale = Number(argv[++i]);
    else if (arg === "--out") a.out = path.resolve(argv[++i]);
    else if (arg === "--cold") a.runMode = "cold";
  }
  return a;
}

function ensureBuilt() {
  if (fs.existsSync(path.resolve("dist/index.js"))) return;
  console.error("[run] dist/ not found, building project (npm run build)...");
  execSync("npm run build", { stdio: "inherit" });
}

async function main() {
  const args = parseArgs(process.argv);
  ensureBuilt();

  const dbPath = makeDbPath();
  setupEnv(dbPath);

  const dbMod = await import("../dist/db/index.js");
  const reset = () => resetDb(dbMod.db);

  const mods = {
    dbPath,
    reset,
    rememberHandler: (await import("../dist/tools/remember.js")).rememberHandler,
    recallHandler: (await import("../dist/tools/recall.js")).recallHandler,
    contextHandler: (await import("../dist/tools/context.js")).contextHandler,
    getContext: (await import("../dist/core/context-engine.js")).getContext,
    saveLessonHandler: (await import("../dist/tools/lesson.js")).saveLessonHandler,
    forgetHandler: (await import("../dist/tools/forget.js")).forgetHandler,
    updateMemoryHandler: (await import("../dist/tools/update_memory.js")).updateMemoryHandler,
    mergeMemoryHandler: (await import("../dist/tools/merge_memory.js")).mergeMemoryHandler,
    linkMemoryHandler: (await import("../dist/tools/link_memory.js")).linkMemoryHandler,
    createMemory: (await import("../dist/db/repositories/memories.js")).createMemory,
    retrieve: (await import("../dist/core/retrieval-engine.js")).retrieve,
    ftsSearch: (await import("../dist/retrieval/fts.js")).ftsSearch,
    vectorSearch: (await import("../dist/retrieval/vector.js")).vectorSearch,
    rrfFuse: (await import("../dist/retrieval/fusion.js")).rrfFuse,
  };

  const suites = {};
  const perfOpts = { warmup: args.warmup, iterations: args.iterations };

  if (args.suite === "all" || args.suite === "storage") {
    console.error("[run] storage suite...");
    suites["A.storage"] = await runStorageSuite(mods);
    reset();
  }
  if (args.suite === "all" || args.suite === "retrieval") {
    console.error("[run] retrieval suite...");
    suites["B.retrieval"] = runRetrievalSuite(mods, {
      k: args.k,
      topics: args.topics,
      distractors: args.distractors,
    });
    reset();
  }
  if (args.suite === "all" || args.suite === "temporal") {
    console.error("[run] temporal/conflict/scope suites...");
    suites["C.temporal"] = runTemporalSuite(mods);
    reset();
    suites["C.conflict"] = runConflictSuite(mods);
    reset();
    suites["C.scope"] = runScopeSuite(mods);
    reset();
  }
  if (args.suite === "all" || args.suite === "context") {
    console.error("[run] context + token suite...");
    suites["D.context"] = runContextSuite(mods);
    reset();
  }
  if (args.suite === "all" || args.suite === "performance") {
    console.error("[run] performance suite...");
    suites["E.performance"] = await runPerformanceSuite(mods, perfOpts);
    reset();
  }
  if (args.suite === "all" || args.suite === "scalability") {
    console.error("[run] scalability suite...");
    suites["F.scalability"] = runScalabilitySuite(mods, { scale: args.scale });
    reset();
  }
  if (args.suite === "all" || args.suite === "cold") {
    console.error("[run] cold-state suite...");
    suites["E.cold"] = runColdSuite(mods, { coldSamples: args.iterations });
    reset();
  }
  if (args.suite === "all" || args.suite === "ablation") {
    console.error("[run] retrieval ablation suite...");
    suites["B.ablation"] = runAblationSuite(mods, {
      k: args.k,
      topics: args.topics,
      distractors: args.distractors,
    });
    reset();
  }

  const results = {
    environment: envInfo(),
    runMode: args.runMode,
    args: {
      suite: args.suite,
      warmup: args.warmup,
      iterations: args.iterations,
      k: args.k,
      topics: args.topics,
      distractors: args.distractors,
    },
    suites,
  };

  const written = writeReport(results, args.out);
  console.error(
    `[run] wrote ${written.jsonPath}\n${fs.readFileSync(written.mdPath, "utf8")}`
  );

  cleanupDb(dbPath);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
