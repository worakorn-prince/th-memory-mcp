import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { after, test } from "node:test";
import assert from "node:assert/strict";

const dbPath = join(
  tmpdir(),
  `th-sec-write-${process.pid}-${Date.now()}.db`
);
process.env.MEMORY_DB_PATH = dbPath;

const { db } = await import("../dist/db/index.js");
const { createMemory } = await import("../dist/db/repositories/memories.js");
const { rememberHandler } = await import("../dist/tools/remember.js");
const { saveLessonHandler } = await import("../dist/tools/lesson.js");
const { updateMemoryHandler } = await import("../dist/tools/update_memory.js");
const { importMemoryHandler } = await import("../dist/tools/import_memory.js");
const { filterSecrets } = await import("../dist/lib/capture-core.js");

const OPENAI_KEY = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";

after(() => {
  try {
    db.close();
  } catch {}
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      rmSync(`${dbPath}${suffix}`, { force: true });
    } catch {}
  }
});

function text(r) {
  return r?.content?.[0]?.text ?? "";
}

function isErr(r) {
  return r?.isError === true || text(r).startsWith("error:");
}

test("createMemory redacts content, summary, and nested metadata strings", () => {
  const stamp = Date.now();
  const id = createMemory({
    type: "FACT",
    content: `ops note ${stamp} password: hunter2-content`,
    summary: `summary ${OPENAI_KEY}`,
    metadata: {
      note: "password: hunter2-meta",
      nested: { token: OPENAI_KEY },
      list: ["token: abc123list", 7, true, null],
      clean: "kept",
    },
  });

  const row = db
    .prepare("SELECT content, summary, metadata FROM memories WHERE id = ?")
    .get(id);
  assert.ok(!row.content.includes("hunter2-content"), row.content);
  assert.ok(row.content.includes("[REDACTED]"));
  assert.ok(!row.summary.includes(OPENAI_KEY), row.summary);
  assert.ok(row.summary.includes("[REDACTED]"));
  assert.ok(!row.metadata.includes("hunter2-meta"), row.metadata);
  assert.ok(!row.metadata.includes(OPENAI_KEY), row.metadata);

  const meta = JSON.parse(row.metadata);
  assert.equal(meta.note, "[REDACTED]");
  assert.equal(meta.nested.token, "[REDACTED]");
  assert.equal(meta.list[1], 7);
  assert.equal(meta.list[2], true);
  assert.equal(meta.list[3], null);
  assert.equal(meta.clean, "kept");

  const fts = db
    .prepare(
      "SELECT body FROM search_index WHERE ref_table = 'memories' AND ref_id = ?"
    )
    .get(id);
  assert.ok(!fts.body.includes("hunter2-content"), fts.body);
  assert.ok(fts.body.includes("[REDACTED]"));
});

test("rememberHandler redacts a secret in value (row + response)", async () => {
  const stamp = Date.now();
  const key = `write_pref_${stamp}`;
  const res = await rememberHandler({
    category: "other",
    key,
    value: "routing password: hunter2",
  });
  assert.ok(!isErr(res), text(res));
  assert.ok(!text(res).includes("hunter2"), text(res));
  assert.ok(text(res).includes("[REDACTED]"), text(res));

  const row = db
    .prepare(
      "SELECT id, value FROM preferences WHERE category = 'other' AND key = ?"
    )
    .get(key);
  assert.ok(row, "preference row exists");
  assert.ok(!row.value.includes("hunter2"), row.value);
  assert.ok(row.value.includes("[REDACTED]"), row.value);

  const fts = db
    .prepare(
      "SELECT body FROM search_index WHERE ref_table = 'preferences' AND ref_id = ?"
    )
    .get(row.id);
  assert.ok(!fts.body.includes("hunter2"), fts.body);
  assert.ok(fts.body.includes("[REDACTED]"));
});

test("saveLessonHandler redacts secrets in all three fields", async () => {
  const stamp = Date.now();
  const res = await saveLessonHandler({
    situation: `situation password: hunter2-sit-${stamp}`,
    mistake: `mistake ${OPENAI_KEY}`,
    correction: "correction password: hunter2-corr",
  });
  assert.ok(!isErr(res), text(res));

  const row = db
    .prepare(
      "SELECT id, situation, mistake, correction FROM lessons ORDER BY id DESC LIMIT 1"
    )
    .get();
  assert.ok(!row.situation.includes("hunter2-sit"), row.situation);
  assert.ok(!row.mistake.includes(OPENAI_KEY), row.mistake);
  assert.ok(!row.correction.includes("hunter2-corr"), row.correction);
  assert.ok(row.situation.includes("[REDACTED]"), row.situation);
  assert.ok(row.mistake.includes("[REDACTED]"), row.mistake);
  assert.ok(row.correction.includes("[REDACTED]"), row.correction);

  const fts = db
    .prepare(
      "SELECT body FROM search_index WHERE ref_table = 'lessons' AND ref_id = ?"
    )
    .get(row.id);
  assert.ok(!fts.body.includes("hunter2-sit"), fts.body);
  assert.ok(!fts.body.includes(OPENAI_KEY), fts.body);
});

test("updateMemoryHandler in-place redacts content, summary, and metadata", () => {
  const stamp = Date.now();
  const id = createMemory({
    type: "FACT",
    content: `original clean ${stamp}`,
    summary: "original summary",
  });

  const res = updateMemoryHandler({
    id,
    content: "updated password: hunter2-upd",
    summary: `updated summary ${OPENAI_KEY}`,
    metadata: {
      note: "password: hunter2-meta-upd",
      nested: { note: OPENAI_KEY },
      list: ["token: abc123list", 3, false, null],
    },
    supersede: false,
  });
  assert.ok(!isErr(res), text(res));

  const row = db
    .prepare("SELECT content, summary, metadata FROM memories WHERE id = ?")
    .get(id);
  assert.ok(!row.content.includes("hunter2-upd"), row.content);
  assert.ok(!row.summary.includes(OPENAI_KEY), row.summary);
  assert.ok(!row.metadata.includes("hunter2-meta-upd"), row.metadata);
  assert.ok(!row.metadata.includes(OPENAI_KEY), row.metadata);
  assert.ok(row.content.includes("[REDACTED]"), row.content);
  assert.ok(row.summary.includes("[REDACTED]"), row.summary);

  const meta = JSON.parse(row.metadata);
  assert.equal(meta.note, "[REDACTED]");
  assert.equal(meta.nested.note, "[REDACTED]");
  assert.equal(meta.list[1], 3);
  assert.equal(meta.list[2], false);
  assert.equal(meta.list[3], null);

  const fts = db
    .prepare(
      "SELECT body FROM search_index WHERE ref_table = 'memories' AND ref_id = ?"
    )
    .get(id);
  assert.ok(!fts.body.includes("hunter2-upd"), fts.body);
  assert.ok(fts.body.includes("[REDACTED]"));

  const cleanId = createMemory({
    type: "FACT",
    content: `clean before ${stamp}`,
    summary: "clean summary",
  });
  updateMemoryHandler({
    id: cleanId,
    content: `clean after ${stamp}`,
    summary: "clean summary updated",
    metadata: { note: "plain metadata", count: 5 },
    supersede: false,
  });
  const cleanRow = db
    .prepare("SELECT content, summary, metadata FROM memories WHERE id = ?")
    .get(cleanId);
  assert.equal(cleanRow.content, `clean after ${stamp}`);
  assert.equal(cleanRow.summary, "clean summary updated");
  assert.deepEqual(JSON.parse(cleanRow.metadata), {
    note: "plain metadata",
    count: 5,
  });
});

test("trusted import applies redacted preferences, lessons, and profile", async () => {
  const stamp = Date.now();
  const prefKey = `imp_pref_${stamp}`;
  const newPrefKey = `imp_key_${stamp}`;
  const section = `imp_section_${stamp}`;
  await rememberHandler({ category: "other", key: prefKey, value: "original" });

  const res = importMemoryHandler({
    json: JSON.stringify({
      preferences: [
        {
          category: "other",
          key: prefKey,
          value: "imported password: hunter2-pref",
        },
        { category: "other", key: newPrefKey, value: OPENAI_KEY },
      ],
      lessons: [
        {
          situation: `import sit password: hunter2-les-sit-${stamp}`,
          mistake: "import mis password: hunter2-les-mis",
          correction: `import corr ${OPENAI_KEY}`,
        },
      ],
      profile: [
        {
          section,
          content: "import profile password: hunter2-profile",
        },
      ],
    }),
    apply: true,
    trusted: true,
  });
  assert.ok(!isErr(res), text(res));

  const pref = db
    .prepare(
      "SELECT value FROM preferences WHERE category = 'other' AND key = ?"
    )
    .get(prefKey);
  assert.ok(!pref.value.includes("hunter2-pref"), pref.value);
  assert.ok(pref.value.includes("[REDACTED]"), pref.value);

  const newPref = db
    .prepare(
      "SELECT value FROM preferences WHERE category = 'other' AND key = ?"
    )
    .get(newPrefKey);
  assert.equal(newPref.value, "[REDACTED]");

  const lesson = db
    .prepare(
      "SELECT situation, mistake, correction FROM lessons ORDER BY id DESC LIMIT 1"
    )
    .get();
  assert.ok(!lesson.situation.includes("hunter2-les-sit"), lesson.situation);
  assert.ok(!lesson.mistake.includes("hunter2-les-mis"), lesson.mistake);
  assert.ok(!lesson.correction.includes(OPENAI_KEY), lesson.correction);
  assert.ok(lesson.situation.includes("[REDACTED]"), lesson.situation);
  assert.ok(lesson.mistake.includes("[REDACTED]"), lesson.mistake);
  assert.ok(lesson.correction.includes("[REDACTED]"), lesson.correction);

  const profile = db
    .prepare("SELECT content FROM profile WHERE section = ?")
    .get(section);
  assert.ok(!profile.content.includes("hunter2-profile"), profile.content);
  assert.ok(profile.content.includes("[REDACTED]"), profile.content);
});

test("filterSecrets leaves clean text unchanged", () => {
  assert.equal(filterSecrets("normal note"), "normal note");
});
