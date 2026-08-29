import { tmpdir } from "node:os";
import { join } from "node:path";

const dbPath = join(tmpdir(), `th-mcp-retrieval-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { createMemory } = await import("../dist/db/repositories/memories.js");
const { retrieve } = await import("../dist/core/retrieval-engine.js");

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

const pnpmId = createMemory({
  type: "PREFERENCE",
  content: "Use pnpm for Node projects",
  source: "explicit",
  confidence: 0.9,
  importance: 0.8,
});
const tsId = createMemory({
  type: "PREFERENCE",
  content: "Use TypeScript for type safety",
  source: "explicit",
  confidence: 0.9,
  importance: 0.7,
});
createMemory({
  type: "FACT",
  content: "Boil water at 100C to cook pasta",
  source: "explicit",
  confidence: 0.8,
  importance: 0.3,
});

// hybrid retrieval: query about pnpm
const res = retrieve("pnpm package manager", { limit: 5 });
check("retrieve returns results", res.length > 0, `len=${res.length}`);
check(
  "retrieve: pnpm memory ranked first",
  res[0] && res[0].id === pnpmId,
  `top=${res[0]?.id} expected=${pnpmId}`
);
check(
  "retrieve: top final_score > 0",
  res[0] && res[0].final_score > 0,
  `score=${res[0]?.final_score}`
);
check(
  "retrieve: rrf field present",
  res[0] && typeof res[0].rrf === "number" && res[0].rrf > 0,
  `rrf=${res[0]?.rrf}`
);

// semantic-only query still finds pnpm (vector path)
const resSem = retrieve("package manager pnpm", { limit: 5 });
check(
  "retrieve semantic: pnpm found",
  resSem.some((r) => r.id === pnpmId)
);

// scope factor: project-scoped query includes matching project memory
const projId = createMemory({
  type: "PREFERENCE",
  content: "Use pnpm in this repo",
  source: "explicit",
  confidence: 0.9,
  importance: 0.9,
  projectId: "projX",
});
const resProj = retrieve("pnpm", { limit: 5, projectId: "projX" });
check(
  "scope: project memory present",
  resProj.some((r) => r.id === projId),
  `ids=${resProj.map((r) => r.id)}`
);

// limit is respected
const resLimit = retrieve("pnpm", { limit: 2 });
check("retrieve: limit respected", resLimit.length <= 2, `len=${resLimit.length}`);

console.log(
  `\nRETRIEVAL TEST: ${fail === 0 ? "ALL PASSED" : fail + " FAILURE(S)"} (${pass} passed)`
);
process.exit(fail === 0 ? 0 : 1);
