import { tmpdir } from "node:os";
import { join } from "node:path";

const dbPath = join(tmpdir(), `th-mcp-bench-${Date.now()}.db`);
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

const N = 300;
for (let i = 0; i < N; i++) {
  createMemory({
    type: "FACT",
    content: `benchmark memory number ${i} about topic ${i % 20}`,
    source: "explicit",
  });
}

const t0 = Date.now();
const res = retrieve("benchmark memory topic", { limit: 10 });
const dt = Date.now() - t0;

check("benchmark: retrieve returns results", res.length > 0, `len=${res.length}`);
check("benchmark: latency < 2000ms", dt < 2000, `dt=${dt}ms`);

console.log(
  `\nBENCHMARK TEST: ${fail === 0 ? "ALL PASSED" : fail + " FAILURE(S)"} (${pass} passed)`
);
process.exit(fail === 0 ? 0 : 1);
