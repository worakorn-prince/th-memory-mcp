import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbPath = join(tmpdir(), `th-mcp-life-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { db } = await import("../dist/db/index.js");
const { createMemory } = await import("../dist/db/repositories/memories.js");
const life = await import("../dist/core/lifecycle-engine.js");
const decay = await import("../dist/memory/decay.js");
const scorer = await import("../dist/memory/scorer.js");

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${extra ? " — " + extra : ""}`);
  }
}

// --- decay (spec §10) ---
check(
  "decay: CONSTRAINT decays slower than EPISODE",
  decay.decayLambdaFor("CONSTRAINT") < decay.decayLambdaFor("EPISODE")
);
check(
  "recency: fresh memory ~= 1",
  Math.abs(decay.recencyFactorFor("FACT", new Date().toISOString()) - 1) < 1e-6
);
check(
  "recency: 30-day-old FACT < 1",
  decay.recencyFactorFor("FACT", new Date(Date.now() - 30 * 864e5).toISOString()) <
    1
);

// --- scorer (spec §9) ---
const sAll = scorer.computeSalience({
  relevance: 1,
  importance: 1,
  confidence: 1,
  recency: 1,
  accessFrequency: 1,
  projectRelevance: 1,
});
check("salience: all-1 => 1", Math.abs(sAll - 1) < 1e-9, `got ${sAll}`);
const cExp = scorer.computeConfidence({ source: "explicit", confirmations: 0 });
check(
  "confidence: explicit n=0 => source weight 1.0",
  Math.abs(cExp - 1.0) < 1e-9,
  `got ${cExp}`
);
const cCap0 = scorer.computeConfidence({ source: "captured", confirmations: 0 });
check(
  "confidence: captured n=0 => 0.3",
  Math.abs(cCap0 - 0.3) < 1e-9,
  `got ${cCap0}`
);
const cCap5 = scorer.computeConfidence({ source: "captured", confirmations: 5 });
check(
  "confidence: captured rises with confirmations but < 1.0",
  cCap5 > cCap0 && cCap5 < 1.0,
  `got ${cCap5}`
);
const d1 =
  scorer.computeConfidence({ source: "captured", confirmations: 1 }) - cCap0;
const d2 =
  scorer.computeConfidence({ source: "captured", confirmations: 2 }) -
  scorer.computeConfidence({ source: "captured", confirmations: 1 });
check(
  "confidence: diminishing returns (delta shrinks)",
  d2 < d1,
  `d1=${d1} d2=${d2}`
);

// --- lifecycle transitions (spec §4) ---
const id = createMemory({
  type: "FACT",
  content: "lifecycle test fact",
  source: "explicit",
  confidence: 0.8,
});
check("canTransition active->stale allowed", life.canTransition("active", "stale") === true);
check(
  "illegal transition rejected",
  (() => {
    try {
      life.transitionStatus(id, "new");
      return false;
    } catch {
      return true;
    }
  })()
);
const reinf = life.reinforce(id);
check(
  "reinforce -> active + confidence bump",
  reinf.status === "active" && reinf.confidence > 0.8,
  `status=${reinf.status} conf=${reinf.confidence}`
);
const arch = life.archive(id);
check("archive from active allowed", arch.status === "archived");
check(
  "archived cannot -> active",
  (() => {
    try {
      life.transitionStatus(id, "active");
      return false;
    } catch {
      return true;
    }
  })()
);

// --- supersession (spec §12) ---
const oldId = createMemory({
  type: "PREFERENCE",
  content: "old pref",
  source: "explicit",
});
const newId = createMemory({
  type: "PREFERENCE",
  content: "new pref",
  source: "explicit",
});
life.supersede(oldId, newId);
const oldM = db
  .prepare("SELECT status, supersedes_id FROM memories WHERE id=?")
  .get(oldId);
const newM = db
  .prepare("SELECT status, supersedes_id FROM memories WHERE id=?")
  .get(newId);
check("supersede: old is superseded", oldM.status === "superseded");
check("supersede: new is active", newM.status === "active");
check(
  "supersede: new.supersedes_id = old",
  newM.supersedes_id === oldId,
  `got ${newM.supersedes_id}`
);
const link = db
  .prepare(
    "SELECT relation FROM memory_links WHERE source_memory_id=? AND target_memory_id=?"
  )
  .get(newId, oldId);
check(
  "supersede: memory_link created",
  !!link && link.relation === "supersedes"
);

console.log(
  `\nLIFECYCLE TEST: ${fail === 0 ? "ALL PASSED" : fail + " FAILURE(S)"} (${pass} passed)`
);
process.exit(fail === 0 ? 0 : 1);
