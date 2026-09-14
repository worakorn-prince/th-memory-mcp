import { tmpdir } from "node:os";
import { join } from "node:path";

const dbPath = join(tmpdir(), `th-mcp-consol-scope-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { createMemory } = await import("../dist/db/repositories/memories.js");
const cons = await import("../dist/core/consolidation-engine.js");
const { consolidateHandler } = await import("../dist/tools/consolidate.js");
const { db } = await import("../dist/db/index.js");

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

function clusterIds(clusters) {
  return new Set(clusters.flat());
}

// Batch B-1: USER memories must not leak into GLOBAL (or another user's)
// clusters, and derived memories must inherit the source scope.
const a1 = createMemory({
  type: "PREFERENCE",
  content: "Use pnpm for Node projects at home",
  source: "explicit",
  userId: "alice",
});
const a2 = createMemory({
  type: "PREFERENCE",
  content: "Use pnpm for Node projects at home and CI",
  source: "explicit",
  userId: "alice",
});
const b1 = createMemory({
  type: "PREFERENCE",
  content: "Use pnpm for Node projects at home",
  source: "explicit",
  userId: "bob",
});
const g1 = createMemory({
  type: "PREFERENCE",
  content: "Use pnpm for Node projects at home",
  source: "explicit",
});
const g2 = createMemory({
  type: "PREFERENCE",
  content: "Use pnpm for Node projects at home and CI",
  source: "explicit",
});
const p1a = createMemory({
  type: "FACT",
  content: "Deploy backend with docker compose setup",
  source: "explicit",
  projectId: "p1",
});
const p1b = createMemory({
  type: "FACT",
  content: "Deploy backend with docker compose setup and logs",
  source: "explicit",
  projectId: "p1",
});
const p2 = createMemory({
  type: "FACT",
  content: "Deploy backend with docker compose setup",
  source: "explicit",
  projectId: "p2",
});

// 1. Unscoped clustering sees only GLOBAL — USER/PROJECT excluded.
const unscoped = cons.clusterMemories({ threshold: 0.5, minClusterSize: 2 });
const unscopedIds = clusterIds(unscoped);
check(
  "scope: unscoped cluster excludes alice USER",
  !unscopedIds.has(a1) && !unscopedIds.has(a2)
);
check("scope: unscoped cluster excludes bob USER", !unscopedIds.has(b1));
check(
  "scope: unscoped cluster excludes PROJECT",
  !unscopedIds.has(p1a) && !unscopedIds.has(p1b) && !unscopedIds.has(p2)
);
check(
  "scope: unscoped cluster still groups GLOBAL pair",
  unscoped.some((c) => c.includes(g1) && c.includes(g2)),
  `clusters=${JSON.stringify(unscoped)}`
);

// 2. Scoped to alice: her pair clusters, bob never appears.
const aliceClusters = cons.clusterMemories({
  threshold: 0.5,
  minClusterSize: 2,
  userId: "alice",
});
const aliceIds = clusterIds(aliceClusters);
check(
  "scope: alice cluster contains her pair",
  aliceClusters.some((c) => c.includes(a1) && c.includes(a2)),
  `clusters=${JSON.stringify(aliceClusters)}`
);
check(
  "scope: alice cluster excludes bob",
  !aliceIds.has(b1),
  `ids=${JSON.stringify([...aliceIds])}`
);

// 3. Scoped to project p1: p1 pair clusters, p2 excluded.
const p1Clusters = cons.clusterMemories({
  threshold: 0.5,
  minClusterSize: 2,
  projectId: "p1",
});
check(
  "scope: p1 cluster contains p1 pair without p2",
  p1Clusters.some((c) => c.includes(p1a) && c.includes(p1b)) &&
    !clusterIds(p1Clusters).has(p2),
  `clusters=${JSON.stringify(p1Clusters)}`
);

// 4. resolveDerivedScope never escalates: mixed USER+GLOBAL inherits USER.
const mixed = cons.resolveDerivedScope(
  [
    { scope: "USER", project_id: null, session_id: null, user_id: 1 },
    { scope: "GLOBAL", project_id: null, session_id: null, user_id: null },
  ],
  {}
);
// user_id 1 does not exist in the users table in this scenario only if alice
// was never created — but createMemory ensured it. Look the owner up.
const owner = db
  .prepare("SELECT external_id FROM users WHERE id = ?")
  .get(1);
check(
  "scope: mixed USER+GLOBAL does not become GLOBAL",
  mixed !== null && mixed.userId === (owner?.external_id ?? "alice"),
  `scope=${JSON.stringify(mixed)}`
);

// 5. Direct derived from USER sources with owner stays USER, not GLOBAL.
const dId = cons.createDerivedMemory({
  content: "Consolidated alice pnpm usage",
  sourceIds: [a1, a2],
  userId: "alice",
});
const dRow = db
  .prepare("SELECT scope, user_id FROM memories WHERE id = ?")
  .get(dId);
const aliceUid = db
  .prepare("SELECT id FROM users WHERE external_id = ?")
  .get("alice");
check(
  "scope: USER-derived memory stays USER (not GLOBAL)",
  dRow && dRow.scope === "USER" && dRow.user_id === aliceUid.id,
  `row=${JSON.stringify(dRow)}`
);

// 6. Handler-level: derive under alice scope creates no GLOBAL derived.
const beforeMax = db
  .prepare("SELECT COALESCE(MAX(id), 0) AS m FROM memories")
  .get().m;
consolidateHandler({ threshold: 0.5, derive: true, userId: "alice" });
const derived = db
  .prepare("SELECT id, scope FROM memories WHERE id > ? AND type = 'DERIVED'")
  .all(beforeMax);
check(
  "scope: handler derive under alice creates no GLOBAL derived",
  derived.length > 0 && derived.every((r) => r.scope !== "GLOBAL"),
  `derived=${JSON.stringify(derived)}`
);

console.log(
  `\nCONSOLIDATION SCOPE TEST: ${fail === 0 ? "ALL PASSED" : fail + " FAILURE(S)"} (${pass} passed)`
);
process.exit(fail === 0 ? 0 : 1);
