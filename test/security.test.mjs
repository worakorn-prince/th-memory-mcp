import { tmpdir } from "node:os";
import { join } from "node:path";

const dbPath = join(tmpdir(), `th-mcp-sec-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { createMemory } = await import("../dist/db/repositories/memories.js");
const { retrieve } = await import("../dist/core/retrieval-engine.js");
const { getContext } = await import("../dist/core/context-engine.js");
const { buildFtsMatch } = await import("../dist/db/index.js");

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

// FTS match builder must quote tokens (no raw SQL injection)
const inj = buildFtsMatch(`" OR 1=1; DROP TABLE memories; --`);
check(
  "security: buildFtsMatch quotes tokens",
  inj.includes('"') && !inj.toLowerCase().includes("drop table"),
  `match=${inj}`
);

// retrieve with injection-like query must not throw
let threw = false;
try {
  retrieve(`" OR 1=1; DROP TABLE; --`, { limit: 5 });
} catch {
  threw = true;
}
check("security: retrieve handles injection query safely", !threw);

// createMemory with malicious content (quotes, null byte) must not break
const id = createMemory({
  type: "FACT",
  content: "evil'); DROP TABLE memories; --\u0000",
  source: "explicit",
});
check("security: createMemory with injection content ok", typeof id === "number");

// getContext with extreme budget must not crash
let ctxThrew = false;
try {
  getContext({ query: "x", maxTokens: 100000 });
} catch {
  ctxThrew = true;
}
check("security: getContext extreme budget safe", !ctxThrew);

// all DB access is parameterized: a memory with literal SQL text is stored verbatim, not executed
const m = createMemory({
  type: "FACT",
  content: "SELECT * FROM memories WHERE 1=1",
  source: "explicit",
});
const back = (
  await import("../dist/db/index.js")
).db
  .prepare("SELECT content FROM memories WHERE id = ?")
  .get(m);
check(
  "security: SQL text stored verbatim (not executed)",
  back && back.content === "SELECT * FROM memories WHERE 1=1"
);

console.log(
  `\nSECURITY TEST: ${fail === 0 ? "ALL PASSED" : fail + " FAILURE(S)"} (${pass} passed)`
);
process.exit(fail === 0 ? 0 : 1);
