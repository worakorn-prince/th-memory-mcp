import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dbPath = join(tmpdir(), `th-mcp-tools21-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { db, nowISO } = await import("../dist/db/index.js");
const { createMemory } = await import("../dist/db/repositories/memories.js");
const { linkMemoryHandler } = await import("../dist/tools/link_memory.js");
const { mergeMemoryHandler } = await import("../dist/tools/merge_memory.js");
const { updateMemoryHandler } = await import("../dist/tools/update_memory.js");
const { importMemoryHandler } = await import("../dist/tools/import_memory.js");
const { extractMemoriesHandler } = await import("../dist/tools/extract_memories.js");

let pass = 0;
let fail = 0;
function isErr(r) {
  return r?.content?.[0]?.text?.startsWith("error:") === true;
}
function text(r) {
  return r?.content?.[0]?.text ?? "";
}
function check(name, cond, extra) {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${extra ? " — " + extra : ""}`);
  }
}

// --- link_memory ---
const la = createMemory({ type: "FACT", content: "link source" });
const lb = createMemory({ type: "FACT", content: "link target" });
const lr = linkMemoryHandler({ sourceId: la, targetId: lb, relation: "related_to" });
check("link_memory: ok", !isErr(lr), text(lr));
const lrow = db
  .prepare(
    "SELECT relation FROM memory_links WHERE source_memory_id=? AND target_memory_id=?"
  )
  .get(la, lb);
check(
  "link_memory: link row exists",
  !!lrow && lrow.relation === "related_to",
  JSON.stringify(lrow)
);
const lbad = linkMemoryHandler({ sourceId: 999999, targetId: lb, relation: "related_to" });
check("link_memory: missing source errors", isErr(lbad), text(lbad));

// --- merge_memory ---
const ma = createMemory({ type: "PREFERENCE", content: "merge old" });
const mb = createMemory({ type: "PREFERENCE", content: "merge new" });
const mr = mergeMemoryHandler({ sourceId: ma, targetId: mb });
check("merge_memory: ok", !isErr(mr), text(mr));
const msrc = db.prepare("SELECT status FROM memories WHERE id=?").get(ma);
const mtgt = db.prepare("SELECT status, metadata FROM memories WHERE id=?").get(mb);
check("merge_memory: source superseded", msrc.status === "superseded");
check("merge_memory: target active", mtgt.status === "active");
check(
  "merge_memory: provenance recorded on target",
  !!mtgt.metadata && JSON.parse(mtgt.metadata).merged_from.includes(ma),
  mtgt.metadata
);

// --- update_memory (in place) ---
const ua = createMemory({ type: "FACT", content: "orig content" });
const ur = updateMemoryHandler({ id: ua, summary: "new summary", importance: 0.9 });
check("update_memory in-place: ok", !isErr(ur), text(ur));
const urow = db
  .prepare("SELECT summary, importance, status FROM memories WHERE id=?")
  .get(ua);
check("update_memory: summary changed", urow.summary === "new summary");
check("update_memory: importance changed", Math.abs(urow.importance - 0.9) < 1e-9);
check("update_memory: still active", urow.status === "active");

// --- update_memory (supersede) ---
const ub = createMemory({ type: "FACT", content: "v1 content" });
const ur2 = updateMemoryHandler({ id: ub, content: "v2 content", supersede: true });
check("update_memory supersede: ok", !isErr(ur2), text(ur2));
const ubOld = db.prepare("SELECT status FROM memories WHERE id=?").get(ub);
check("update_memory supersede: old superseded", ubOld.status === "superseded");
const ubNew = db
  .prepare(
    "SELECT id, content, supersedes_id FROM memories WHERE content='v2 content' AND status='active'"
  )
  .get();
check(
  "update_memory supersede: new active points to old",
  !!ubNew && ubNew.supersedes_id === ub,
  JSON.stringify(ubNew)
);

// --- import_memory ---
const impJson = JSON.stringify([
  { type: "FACT", content: "imported fact one" },
  { type: "PREFERENCE", content: "imported pref one" },
  { type: "BADTYPE", content: "invalid" },
]);
const beforeImp = db.prepare("SELECT COUNT(*) c FROM memories").get().c;
const impDry = importMemoryHandler({ json: impJson, apply: false });
check("import_memory dry-run: ok", !isErr(impDry), text(impDry));
const impApply = importMemoryHandler({ json: impJson, apply: true });
check("import_memory apply: ok", !isErr(impApply), text(impApply));
const afterImp = db.prepare("SELECT COUNT(*) c FROM memories").get().c;
check(
  "import_memory: 2 valid inserted (1 invalid skipped)",
  afterImp - beforeImp === 2,
  `delta=${afterImp - beforeImp}`
);

// --- extract_memories ---
db.prepare(
  "INSERT INTO interactions (ts, session_id, kind, content, meta) VALUES (?,?,?,?,?)"
).run(nowISO(), "s1", "prompt", "I prefer pnpm over npm", "{}");
const extDry = extractMemoriesHandler({ apply: false, kind: "prompt" });
check("extract_memories dry-run: ok", !isErr(extDry), text(extDry));
check(
  "extract_memories: proposes candidate",
  /PREFERENCE/.test(text(extDry)),
  text(extDry).slice(0, 200)
);
const beforeExt = db
  .prepare("SELECT COUNT(*) c FROM memories WHERE source='captured'")
  .get().c;
const extApply = extractMemoriesHandler({ apply: true, kind: "prompt" });
check("extract_memories apply: ok", !isErr(extApply), text(extApply));
const afterExt = db
  .prepare("SELECT COUNT(*) c FROM memories WHERE source='captured'")
  .get().c;
check(
  "extract_memories: created >=1 captured memory",
  afterExt > beforeExt,
  `delta=${afterExt - beforeExt}`
);

console.log(
  `\nTOOLS v2.1 TEST: ${fail === 0 ? "ALL PASSED" : fail + " FAILURE(S)"} (${pass} passed)`
);
process.exit(fail === 0 ? 0 : 1);
