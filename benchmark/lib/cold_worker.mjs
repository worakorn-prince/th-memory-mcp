import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const op = process.argv[2] || "retrieve";
const db = path.join(os.tmpdir(), `cold-${Date.now()}-${Math.random()}.db`);
process.env.MEMORY_DB_PATH = db;

const { createMemory } = await import("../../dist/db/repositories/memories.js");
const { retrieve } = await import("../../dist/core/retrieval-engine.js");
const { getContext } = await import("../../dist/core/context-engine.js");
const { rememberHandler } = await import("../../dist/tools/remember.js");
const { recallHandler } = await import("../../dist/tools/recall.js");
const { updateMemoryHandler } = await import("../../dist/tools/update_memory.js");
const { mergeMemoryHandler } = await import("../../dist/tools/merge_memory.js");
const { linkMemoryHandler } = await import("../../dist/tools/link_memory.js");
const { forgetHandler } = await import("../../dist/tools/forget.js");

for (let i = 0; i < 50; i++) {
  createMemory({
    type: "FACT",
    content: `cold seed memory ${i} about topic ${i % 10}`,
    source: "explicit",
  });
}

let t = Date.now();
if (op === "remember") {
  await rememberHandler({ category: "other", key: `cold_${Date.now()}`, value: "x" });
} else if (op === "recall") {
  await recallHandler({ topic: "cold", limit: 5 });
} else if (op === "getContext") {
  getContext({ query: "cold", maxTokens: 500 });
} else if (op === "retrieve") {
  retrieve("cold seed topic", { limit: 10 });
} else if (op === "createMemory") {
  createMemory({ type: "FACT", content: "cold op memory", source: "explicit" });
} else if (op === "updateMemory") {
  const id = createMemory({ type: "FACT", content: "cold update base", source: "explicit" });
  updateMemoryHandler({ id, content: "cold updated" });
} else if (op === "mergeMemory") {
  const a = createMemory({ type: "FACT", content: "cold merge a", source: "explicit" });
  const b = createMemory({ type: "FACT", content: "cold merge b", source: "explicit" });
  mergeMemoryHandler({ sourceId: a, targetId: b });
} else if (op === "linkMemory") {
  const a = createMemory({ type: "FACT", content: "cold link a", source: "explicit" });
  const b = createMemory({ type: "FACT", content: "cold link b", source: "explicit" });
  linkMemoryHandler({ sourceId: a, targetId: b, relation: "related_to" });
} else if (op === "forget") {
  const r = await rememberHandler({ category: "other", key: `cold_forget_${Date.now()}`, value: "x" });
  const m = /preference id=(\d+)/.exec(r.content?.[0]?.text || "");
  if (m) await forgetHandler({ target_id: Number(m[1]), type: "preference" });
}
const ms = Date.now() - t;

process.stdout.write(JSON.stringify({ op, ms }));

for (const s of ["", "-wal", "-shm"]) {
  try {
    fs.rmSync(db + s, { force: true });
  } catch {}
}
