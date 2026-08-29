import { tmpdir } from "node:os";
import { join } from "node:path";

const dbPath = join(tmpdir(), `th-mcp-context-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { createMemory } = await import("../dist/db/repositories/memories.js");
const { getContext } = await import("../dist/core/context-engine.js");
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

const pnpm = createMemory({
  type: "PREFERENCE",
  content: "Use pnpm for Node projects",
  source: "explicit",
  confidence: 0.9,
  importance: 0.8,
});
const ts = createMemory({
  type: "PREFERENCE",
  content: "Use TypeScript for type safety",
  source: "explicit",
});
const ci = createMemory({
  type: "FACT",
  content: "CI runs on GitHub Actions",
  source: "explicit",
});
graph.linkMemories(pnpm, ci, "related");

// basic context assembly
const ctx = getContext({ query: "pnpm package manager", limit: 5 });
check("context: returns memories", ctx.memories.length > 0, `len=${ctx.memories.length}`);
check(
  "context: pnpm seed ranked first",
  ctx.memories[0] && ctx.memories[0].id === pnpm,
  `top=${ctx.memories[0]?.id}`
);
check("context: token estimate > 0", ctx.tokenEstimate > 0, `tok=${ctx.tokenEstimate}`);

// graph expansion pulls in linked CI memory
const ctxGraph = getContext({
  query: "pnpm",
  limit: 5,
  includeGraph: true,
});
check(
  "context: graph expansion includes CI memory",
  ctxGraph.memories.some((m) => m.id === ci),
  `ids=${ctxGraph.memories.map((m) => m.id)}`
);

// token budget truncation
const ctxBudget = getContext({ query: "pnpm", limit: 50, maxTokens: 30 });
check(
  "context: token budget truncates",
  ctxBudget.truncated === true || ctxBudget.memories.length <= 1,
  `truncated=${ctxBudget.truncated} len=${ctxBudget.memories.length}`
);

// temporal validity: a memory valid only in the future is excluded unless includeHistory
const future = createMemory({
  type: "FACT",
  content: "Future-only fact",
  source: "explicit",
  validFrom: new Date(Date.now() + 864e5).toISOString(),
});
const ctxNow = getContext({ query: "future", limit: 10 });
check(
  "context: future memory excluded by default",
  !ctxNow.memories.some((m) => m.id === future),
  `ids=${ctxNow.memories.map((m) => m.id)}`
);
const ctxHist = getContext({ query: "future", limit: 10, includeHistory: true });
check(
  "context: future memory included with includeHistory",
  ctxHist.memories.some((m) => m.id === future)
);

console.log(
  `\nCONTEXT TEST: ${fail === 0 ? "ALL PASSED" : fail + " FAILURE(S)"} (${pass} passed)`
);
process.exit(fail === 0 ? 0 : 1);
