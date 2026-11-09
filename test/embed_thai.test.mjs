// Thai word-aware embeddings (TASK-THAI-EMBED):
//   - tokenize() feeds Thai runs through the shared thai-segment wordTokens(),
//     so word-level signal enters the vector instead of a single opaque run,
//   - EMBED_DIM stays 512; cosine / serialize / deserialize unchanged,
//   - migration 011_embeddings_segmenter recomputes stale stored embeddings
//     from their source rows (batched, idempotent, preserves row count).
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { test, after } from "node:test";
import assert from "node:assert/strict";

const dbPath = join(tmpdir(), `th-mem-embed-thai-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;
process.env.MEMORY_BACKUP_ON_MIGRATE = "0";

const { embed, cosine, serialize, EMBED_DIM } = await import(
  "../dist/lib/embed.js"
);
const { MIGRATIONS } = await import("../dist/db/migrations.js");
const { db } = await import("../dist/db/index.js");
const { createMemory } = await import("../dist/db/repositories/memories.js");
const { rememberHandler } = await import("../dist/tools/remember.js");
const { saveLessonHandler } = await import("../dist/tools/lesson.js");

// Deterministic re-implementation of the PRE-TASK-THAI-EMBED tokenizer (whole
// Thai run = one token + char n-grams) so the test can prove the new vector is
// strictly better for Thai without depending on any installed model.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
function oldEmbed(text) {
  const lower = text.toLowerCase();
  const tokens = [];
  const matches = lower.match(/[a-z0-9ก-์]+/gi);
  if (matches) {
    for (const m of matches) tokens.push(m);
  }
  const chars = Array.from(lower.replace(/\s+/g, ""));
  if (chars.length >= 3) {
    for (let i = 0; i < chars.length - 2; i++) {
      tokens.push("g:" + chars.slice(i, i + 3).join(""));
    }
  } else if (chars.length > 0) {
    tokens.push("g:" + chars.join(""));
  }
  const vec = new Float32Array(EMBED_DIM);
  for (const t of tokens) {
    const idx = fnv1a(t) % EMBED_DIM;
    vec[idx] += 1;
  }
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBED_DIM; i++) vec[i] /= norm;
  return vec;
}

after(() => {
  try {
    db.close();
  } catch {}
  for (const s of ["", "-wal", "-shm"]) rmSync(`${dbPath}${s}`, { force: true });
});

test("Thai word-level vectors: related pair >> unrelated pair, above the semantic floor", () => {
  assert.equal(EMBED_DIM, 512, "EMBED_DIM must stay 512");

  const a = "ติดตั้งโปรแกรม";
  const related = "ติดตั้งซอฟต์แวร์";
  const unrelated = "ซื้อข้าวในตลาด";

  const newRelated = cosine(embed(a), embed(related));
  const newUnrelated = cosine(embed(a), embed(unrelated));
  const oldRelated = cosine(oldEmbed(a), oldEmbed(related));
  const oldUnrelated = cosine(oldEmbed(a), oldEmbed(unrelated));

  // The explicitly desired "real assertion" from the task contract: the
  // related pair must score clearly above the dissimilar pair.
  assert.ok(
    newRelated > 0.3,
    `word-aware related similarity should be comfortably above SEMANTIC_FLOOR 0.15, got ${newRelated.toFixed(3)}`
  );
  assert.ok(
    newRelated > newUnrelated + 0.2,
    `related(${newRelated.toFixed(3)}) must clearly beat unrelated(${newUnrelated.toFixed(3)})`
  );
  assert.ok(
    newUnrelated < 0.15,
    `dissimilar pair should stay below SEMANTIC_FLOOR 0.15 so recall never surfaces it, got ${newUnrelated.toFixed(3)}`
  );
  // Strict improvement over the old whole-run tokenizer for the SAME pair.
  assert.ok(
    newRelated > oldRelated,
    `word-aware related(${newRelated.toFixed(3)}) must beat old whole-run related(${oldRelated.toFixed(3)})`
  );
});

test("English alpha-numeric tokens are unchanged (no blast radius)", () => {
  const en = "Use pnpm for Node projects";
  const same = cosine(embed(en), oldEmbed(en));
  assert.ok(
    same > 0.999999,
    `English embedding must be byte-identical under the new tokenizer, got ${same.toFixed(6)}`
  );
});

test("011_embeddings_segmenter recomputes rows from source, idempotent, preserves count", async () => {
  const stamp = Date.now();
  const memId = createMemory({
    type: "FACT",
    content: `ต้องติดตั้งโปรแกรมบนเซิร์ฟเวอร์ ${stamp}`,
  });
  await rememberHandler({
    category: "coding_pref",
    key: `thai_embed_${stamp}`,
    value: "ติดตั้งซอฟต์แวร์ด้วย pnpm",
  });
  await saveLessonHandler({
    situation: `การติดตั้งโปรแกรมล้มเหลว ${stamp}`,
    mistake: "ลืมอัปเดตแพ็กเกจ",
    correction: "รัน pnpm install ก่อน",
  });

  const pref = db
    .prepare("SELECT id, category, key, value FROM preferences WHERE key = ?")
    .get(`thai_embed_${stamp}`);
  const lesson = db
    .prepare("SELECT id FROM lessons WHERE situation LIKE ?")
    .get(`%การติดตั้งโปรแกรมล้มเหลว ${stamp}%`);
  assert.ok(memId > 0 && pref && lesson, "seed rows must exist");

  const sourceText = (refTable, refId) => {
    if (refTable === "memories") {
      const r = db
        .prepare("SELECT content FROM memories WHERE id = ?")
        .get(refId);
      return r.content;
    }
    if (refTable === "preferences") {
      const r = db
        .prepare("SELECT category, key, value FROM preferences WHERE id = ?")
        .get(refId);
      return `${r.category} ${r.key} ${r.value}`;
    }
    if (refTable === "lessons") {
      const r = db
        .prepare("SELECT situation, mistake, correction FROM lessons WHERE id = ?")
        .get(refId);
      return `${r.situation} ${r.mistake} ${r.correction}`;
    }
    return null;
  };

  // Simulate stale vectors (whatever the old runtime stored) by overwriting.
  const stale = serialize(oldEmbed("stale placeholder to be recomputed"));
  assert.notEqual(
    stale.toString("hex"),
    serialize(
      embed(sourceText("memories", memId))
    ).toString("hex"),
    "stale vector must differ from fresh embed() of the source"
  );
  for (const [refTable, refId] of [
    ["memories", memId],
    ["preferences", pref.id],
    ["lessons", lesson.id],
  ]) {
    db.prepare(
      "UPDATE embeddings SET vec = ? WHERE ref_table = ? AND ref_id = ?"
    ).run(stale, refTable, refId);
  }

  const allRows = () =>
    db
      .prepare("SELECT ref_table, ref_id, vec FROM embeddings ORDER BY ref_table, ref_id")
      .all();
  const countBefore = allRows().length;
  assert.ok(countBefore >= 3, `expected at least 3 seeded embeddings, got ${countBefore}`);

  const migration = MIGRATIONS.find((m) => m.id === "011_embeddings_segmenter");
  assert.ok(migration, "011_embeddings_segmenter must be registered in MIGRATIONS");

  migration.up(db);
  const after1 = allRows();
  assert.equal(after1.length, countBefore, "recomputed row count must be preserved");
  for (const row of after1) {
    const expect = serialize(embed(sourceText(row.ref_table, row.ref_id)));
    assert.ok(
      row.vec.equals(expect),
      `row ${row.ref_table}/${row.ref_id} must equal fresh embed() of its source row`
    );
  }

  // Idempotency: second run keeps count and yields byte-identical vectors.
  migration.up(db);
  const after2 = allRows();
  assert.equal(after2.length, countBefore, "second run must not change row count");
  assert.deepStrictEqual(after2, after1, "second run must yield identical vectors");
});
