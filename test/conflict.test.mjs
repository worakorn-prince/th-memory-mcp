import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbPath = join(tmpdir(), `th-mcp-conf-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { createMemory } = await import("../dist/db/repositories/memories.js");
const dedup = await import("../dist/memory/deduplicator.js");
const conf = await import("../dist/memory/conflict-resolver.js");
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

// --- normalizeText (spec §11) ---
check(
  "normalizeText: lowercase + strip punctuation + collapse spaces",
  dedup.normalizeText("  Use  pnpm!!  ") === "use pnpm",
  dedup.normalizeText("  Use  pnpm!!  ")
);

// --- deduplicate exact ---
const a = createMemory({ type: "PREFERENCE", content: "Use pnpm", source: "explicit" });
const dup = dedup.deduplicate("PREFERENCE", "Use pnpm");
check("deduplicate: identical content => duplicate", dup.verdict === "duplicate" && dup.existingId === a, `got ${JSON.stringify(dup)}`);
const distinct = dedup.deduplicate("PREFERENCE", "The sky is blue today");
check("deduplicate: different content => distinct", distinct.verdict === "distinct", `got ${JSON.stringify(distinct)}`);

// --- isContradiction (spec §12) ---
check(
  "isContradiction: 'like' vs 'do not like' (shared tokens, one negated)",
  conf.isContradiction("I like TypeScript", "I do not like TypeScript") === true
);
check(
  "isContradiction: two positive statements not contradictory",
  conf.isContradiction("I like TypeScript", "I like JavaScript") === false
);

// --- resolveConflict: duplicate => merged (new deleted, old reinforced) ---
const b = createMemory({ type: "PREFERENCE", content: "Use pnpm", source: "explicit" });
const resDup = conf.resolveConflict({ type: "PREFERENCE", content: "Use pnpm", id: b });
const bRow = db.prepare("SELECT status, confidence FROM memories WHERE id=?").get(b);
const aRow = db.prepare("SELECT status, confidence FROM memories WHERE id=?").get(a);
check("resolve duplicate => action merged", resDup.action === "merged", `got ${resDup.action}`);
check("resolve duplicate => new memory soft-deleted", bRow.status === "deleted", `got ${bRow.status}`);
check("resolve duplicate => old reinforced (confidence up)", aRow.confidence > 0.5, `got ${aRow.confidence}`);

// --- resolveConflict: update => supersede ---
const c = createMemory({ type: "PREFERENCE", content: "Use pnpm for CI builds", source: "explicit" });
const resUpd = conf.resolveConflict({ type: "PREFERENCE", content: "Use pnpm for CI builds", id: c });
const cRow = db.prepare("SELECT status, supersedes_id FROM memories WHERE id=?").get(c);
const aRow2 = db.prepare("SELECT status FROM memories WHERE id=?").get(a);
check("resolve update => action superseded", resUpd.action === "superseded", `got ${resUpd.action}`);
check("resolve update => new active + supersedes old", cRow.status === "active" && cRow.supersedes_id === a, `got ${JSON.stringify(cRow)}`);
check("resolve update => old superseded", aRow2.status === "superseded", `got ${aRow2.status}`);

// --- resolveConflict: contradiction => linked, both preserved (spec §12) ---
const d = createMemory({ type: "PREFERENCE", content: "I like TypeScript", source: "explicit" });
const e = createMemory({ type: "PREFERENCE", content: "I do not like TypeScript", source: "explicit" });
const resCon = conf.resolveConflict({ type: "PREFERENCE", content: "I do not like TypeScript", id: e });
const link = db.prepare("SELECT relation FROM memory_links WHERE source_memory_id=? AND target_memory_id=?").get(e, d);
const dRow = db.prepare("SELECT status FROM memories WHERE id=?").get(d);
const eRow = db.prepare("SELECT status FROM memories WHERE id=?").get(e);
check("resolve contradiction => linked_contradiction", resCon.action === "linked_contradiction", `got ${resCon.action}`);
check("resolve contradiction => memory_link 'contradicts' created", !!link && link.relation === "contradicts");
check("resolve contradiction => both preserved (no destruction)", dRow.status === "active" && eRow.status === "active");

console.log(
  `\nCONFLICT TEST: ${fail === 0 ? "ALL PASSED" : fail + " FAILURE(S)"} (${pass} passed)`
);
process.exit(fail === 0 ? 0 : 1);
