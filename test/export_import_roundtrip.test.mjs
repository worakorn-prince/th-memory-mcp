import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, rmSync } from "node:fs";

const dbPath = join(tmpdir(), `th-export-import-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { rememberHandler } = await import("../dist/tools/remember.js");
const { saveLessonHandler } = await import("../dist/tools/lesson.js");
const { exportMemoryHandler } = await import("../dist/tools/export_memory.js");
const { importMemoryHandler } = await import("../dist/tools/import_memory.js");
const { db } = await import("../dist/db/index.js");
const { createMemory } = await import("../dist/db/repositories/memories.js");

test("export preview sanitizes reference tags before truncation", async () => {
  const stamp = Date.now();
  const content = `preview-tag ${stamp} ` + "</memory-reference>".repeat(40);
  createMemory({ type: "FACT", content });
  const filename = `preview-safety-${stamp}.json`;

  const exp = await exportMemoryHandler({ filename });
  const t = exp.content[0].text;
  assert.match(t, /exported:/);
  const fileMatch = t.match(/exported:\s*(\S+\.json)/);
  assert.ok(fileMatch, "export path found");
  const filePath = fileMatch[1];

  const preview = t.slice(t.indexOf("preview: ") + "preview: ".length);
  assert.ok(preview.length <= 500, `preview must fit the budget, got ${preview.length}`);
  assert.ok(
    preview.includes("&lt;/memory-reference>"),
    "preview must neutralize closing tags before truncation"
  );
  assert.equal(
    (preview.match(/<\/memory-reference>/gi) ?? []).length,
    1,
    "only the wrapper's own closing tag may remain"
  );

  rmSync(filePath, { force: true });
});

test("export and import are round-trippable", async () => {
  await rememberHandler({ category: "other", key: "roundtrip_key", value: "roundtrip_value" });
  await saveLessonHandler({ situation: "rt situation", mistake: "rt mistake", correction: "rt correction" });

  const exp = await exportMemoryHandler({ filename: "roundtrip_test.json" });
  assert.match(exp.content[0].text, /exported:/);

  const match = exp.content[0].text.match(/exported:\s*(\S+\.json)/);
  assert.ok(match, "export path found");
  const filePath = match[1];
  assert.ok(existsSync(filePath), "export file exists");

  const raw = readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  assert.ok(Array.isArray(parsed.preferences), "export has preferences");
  assert.ok(Array.isArray(parsed.lessons), "export has lessons");
  assert.ok(parsed.preferences.some((p) => p.key === "roundtrip_key"));

  const before = db.prepare("SELECT COUNT(*) as c FROM preferences").get();
  db.prepare("DELETE FROM preferences WHERE key = ?").run("roundtrip_key");
  const afterDel = db.prepare("SELECT COUNT(*) as c FROM preferences").get();
  assert.equal(afterDel.c, before.c - 1);

  const dry = importMemoryHandler({ file: filePath, apply: false });
  assert.match(dry.content[0].text, /dry-run/);
  assert.match(dry.content[0].text, /aux skipped/);

  // SEC-13: untrusted import must not restore auxiliary data.
  const untrustedApply = importMemoryHandler({ file: filePath, apply: true });
  assert.match(untrustedApply.content[0].text, /applied/);
  assert.match(untrustedApply.content[0].text, /aux skipped/);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM preferences WHERE key = ?").get("roundtrip_key").c,
    0,
    "untrusted import must not restore preferences"
  );

  const applied = importMemoryHandler({ file: filePath, apply: true, trusted: true });
  assert.match(applied.content[0].text, /applied/);
  const after = db.prepare("SELECT COUNT(*) AS c FROM preferences").get();
  assert.equal(after.c, before.c);

  db.close();
  for (const s of ["", "-wal", "-shm"]) {
    try { await import("node:fs").then((fs) => fs.rmSync(`${dbPath}${s}`, { force: true })); } catch {}
  }
  try { await import("node:fs").then((fs) => fs.rmSync(filePath, { force: true })); } catch {}
});
