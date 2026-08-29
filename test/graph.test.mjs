import { tmpdir } from "node:os";
import { join } from "node:path";

const dbPath = join(tmpdir(), `th-mcp-graph-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { createMemory } = await import("../dist/db/repositories/memories.js");
const graph = await import("../dist/core/graph-engine.js");

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

const a = createMemory({
  type: "PREFERENCE",
  content: "Use pnpm",
  source: "explicit",
});
const b = createMemory({
  type: "PREFERENCE",
  content: "Use pnpm in CI",
  source: "explicit",
});
const c = createMemory({
  type: "FACT",
  content: "CI runs on GitHub Actions",
  source: "explicit",
});

graph.linkMemories(a, b, "supersedes");
graph.linkMemories(b, c, "related");

// neighbors
const nb = graph.neighbors(a);
check("neighbors: a -> b", nb.some((n) => n.memoryId === b && n.relation === "supersedes"));

// bounded traversal depth 2 reaches c
const trav = graph.traverse(a, { maxDepth: 2 });
check(
  "traverse depth2: reaches c",
  trav.some((n) => n.memoryId === c),
  `ids=${trav.map((n) => n.memoryId)}`
);
check(
  "traverse: b at depth 1, c at depth 2",
  trav.find((n) => n.memoryId === b)?.depth === 1 &&
    trav.find((n) => n.memoryId === c)?.depth === 2
);

// relation filter excludes 'related'
const travFiltered = graph.traverse(a, {
  maxDepth: 2,
  relationFilter: ["supersedes"],
});
check(
  "traverse: relationFilter excludes c",
  !travFiltered.some((n) => n.memoryId === c),
  `ids=${travFiltered.map((n) => n.memoryId)}`
);

// maxDepth=1 stops at b
const travShallow = graph.traverse(a, { maxDepth: 1 });
check(
  "traverse: maxDepth=1 stops at b",
  travShallow.length === 1 && travShallow[0].memoryId === b
);

// entities + relations
const e1 = graph.createEntity({ name: "pnpm", type: "tool", aliases: ["pnpm.js"] });
const e2 = graph.createEntity({ name: "PNPM", type: "tool" }); // canonical dup -> same id
check("entity: canonical dedup", e1 === e2, `e1=${e1} e2=${e2}`);
const rel = graph.addRelation({
  subjectId: e1,
  predicate: "manages",
  objectId: e2,
  confidence: 0.9,
});
check("relation: created", typeof rel === "number" && rel > 0);

console.log(
  `\nGRAPH TEST: ${fail === 0 ? "ALL PASSED" : fail + " FAILURE(S)"} (${pass} passed)`
);
process.exit(fail === 0 ? 0 : 1);
