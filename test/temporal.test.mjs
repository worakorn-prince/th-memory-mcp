import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbPath = join(tmpdir(), `th-mcp-temp-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { createMemory } = await import("../dist/db/repositories/memories.js");
const temp = await import("../dist/core/temporal-engine.js");

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

// --- validity intervals (spec §5, §201) ---
const m = createMemory({
  type: "DECISION",
  content: "Use SQLite for local persistence",
  source: "explicit",
});
temp.setValidity(m, "2026-01-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z");
const atValid = temp.memoriesValidAt("2026-03-01T00:00:00.000Z");
check("valid at time inside interval", atValid.some((r) => r.id === m));
const atBefore = temp.memoriesValidAt("2025-12-01T00:00:00.000Z");
check("excluded before valid_from", !atBefore.some((r) => r.id === m));
const atAfter = temp.memoriesValidAt("2026-07-01T00:00:00.000Z");
check("excluded after valid_until", !atAfter.some((r) => r.id === m));

// open-ended memory is always valid
const open = createMemory({ type: "FACT", content: "open fact", source: "explicit" });
const openValid = temp.memoriesValidAt("1999-01-01T00:00:00.000Z");
check("open-ended memory valid at any time", openValid.some((r) => r.id === open));

// --- supersession chain (spec §5, §201) ---
const a = createMemory({ type: "PREFERENCE", content: "old v1", source: "explicit" });
const b = createMemory({ type: "PREFERENCE", content: "new v2", source: "explicit" });
const c = createMemory({ type: "PREFERENCE", content: "newest v3", source: "explicit" });
const life = await import("../dist/core/lifecycle-engine.js");
life.supersede(a, b);
life.supersede(b, c);
const chain = temp.supersessionChain(c).map((r) => r.id);
check(
  "supersession chain oldest->newest = [a,b,c]",
  chain.length === 3 && chain[0] === a && chain[1] === b && chain[2] === c,
  `got [${chain}]`
);
const chainMid = temp.supersessionChain(b).map((r) => r.id);
check(
  "chain from middle still yields full [a,b,c]",
  chainMid.length === 3 && chainMid[0] === a && chainMid[2] === c,
  `got [${chainMid}]`
);

// --- change detection ---
const t1 = "2020-01-01T00:00:00.000Z";
const t2 = "2030-01-01T00:00:00.000Z";
const changes = temp.changesBetween(t1, t2);
check(
  "changesBetween wide window includes created memories",
  changes.length >= 4,
  `got ${changes.length}`
);

console.log(
  `\nTEMPORAL TEST: ${fail === 0 ? "ALL PASSED" : fail + " FAILURE(S)"} (${pass} passed)`
);
process.exit(fail === 0 ? 0 : 1);
