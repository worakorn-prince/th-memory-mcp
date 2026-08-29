import { tmpdir } from "node:os";
import { join } from "node:path";

const dbPath = join(tmpdir(), `th-mcp-consol-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { createMemory } = await import("../dist/db/repositories/memories.js");
const cons = await import("../dist/core/consolidation-engine.js");

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

const m1 = createMemory({
  type: "PREFERENCE",
  content: "Use pnpm for Node projects",
  source: "explicit",
});
const m2 = createMemory({
  type: "PREFERENCE",
  content: "Use pnpm for Node projects and CI",
  source: "explicit",
});
createMemory({
  type: "FACT",
  content: "The sky is blue",
  source: "explicit",
});

// clustering groups the two pnpm memories (threshold 0.5)
const clusters = cons.clusterMemories({ threshold: 0.5, minClusterSize: 2 });
check(
  "cluster: one cluster of the two pnpm memories",
  clusters.length === 1 && clusters[0].length === 2,
  `clusters=${JSON.stringify(clusters)}`
);
check(
  "cluster: contains m1 and m2",
  clusters.length === 1 &&
    clusters[0].includes(m1) &&
    clusters[0].includes(m2)
);

// derived memory + provenance
const dId = cons.createDerivedMemory({
  content: "Consolidated pnpm usage",
  sourceIds: [m1, m2],
});
check("derived: created with id", typeof dId === "number" && dId > 0);
const prov = cons.getProvenance(dId);
check(
  "provenance: links both sources",
  prov.includes(m1) && prov.includes(m2),
  `prov=${JSON.stringify(prov)}`
);

// derived memory type is DERIVED and source consolidated
const dRow = (
  await import("../dist/db/index.js")
).db
  .prepare("SELECT type, source FROM memories WHERE id = ?")
  .get(dId);
check(
  "derived: type=DERIVED source=consolidated",
  dRow && dRow.type === "DERIVED" && dRow.source === "consolidated",
  `row=${JSON.stringify(dRow)}`
);

console.log(
  `\nCONSOLIDATION TEST: ${fail === 0 ? "ALL PASSED" : fail + " FAILURE(S)"} (${pass} passed)`
);
process.exit(fail === 0 ? 0 : 1);
