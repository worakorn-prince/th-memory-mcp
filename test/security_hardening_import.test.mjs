import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { after, test } from "node:test";
import assert from "node:assert/strict";

const dbPath = join(tmpdir(), `th-sec-import-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { db } = await import("../dist/db/index.js");
const { createMemory } = await import("../dist/db/repositories/memories.js");
const { importMemoryHandler } = await import("../dist/tools/import_memory.js");
const { rememberHandler } = await import("../dist/tools/remember.js");
const { saveLessonHandler } = await import("../dist/tools/lesson.js");

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

// --- SEC-03: tool-level userId wins over the per-item owner ---
test("SEC-03: per-item userId cannot override tool-level userId", () => {
  const stamp = Date.now();
  const content = `sec03 owned ${stamp}`;
  const res = importMemoryHandler({
    json: JSON.stringify({
      memories: [{ type: "FACT", content, userId: "mallory" }],
      memoryLinks: [],
    }),
    userId: "alice",
    apply: true,
  });
  assert.ok(!isErr(res), text(res));
  const row = db.prepare("SELECT user_id, scope FROM memories WHERE content = ?").get(content);
  const alice = db.prepare("SELECT id FROM users WHERE external_id = 'alice'").get();
  assert.ok(alice, "tool-level user created");
  assert.equal(row.user_id, alice.id, "memory owner is the tool-level user");
  assert.equal(row.scope, "USER");
  const mallory = db.prepare("SELECT id FROM users WHERE external_id = 'mallory'").get();
  assert.ok(!mallory || row.user_id !== mallory.id, "row owner is not the item user");
});

// --- SEC-04: imported links use the same scope rule as link_memory ---
test("SEC-04: cross-user link rejected; same-scope and PROJECT->GLOBAL allowed", () => {
  const stamp = Date.now();

  const aliceContent = `sec04 alice ${stamp}`;
  const bobContent = `sec04 bob ${stamp}`;
  const cross = importMemoryHandler({
    json: JSON.stringify({
      memories: [
        { id: 1, type: "FACT", content: aliceContent, userId: "alice" },
        { id: 2, type: "FACT", content: bobContent, userId: "bob" },
      ],
      memoryLinks: [{ sourceId: 1, targetId: 2, relation: "supports" }],
    }),
    apply: true,
  });
  assert.ok(!isErr(cross), text(cross));
  assert.match(text(cross), /0 link\(s\) imported, 1 invalid link\(s\)/);
  assert.match(text(cross), /scope mismatch/);
  const aliceId = db.prepare("SELECT id FROM memories WHERE content = ?").get(aliceContent).id;
  const bobId = db.prepare("SELECT id FROM memories WHERE content = ?").get(bobContent).id;
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS c FROM memory_links WHERE source_memory_id = ? AND target_memory_id = ?")
      .get(aliceId, bobId).c,
    0,
    "cross-user link not written"
  );

  const sameA = `sec04 same a ${stamp}`;
  const sameB = `sec04 same b ${stamp}`;
  const same = importMemoryHandler({
    json: JSON.stringify({
      memories: [
        { id: 3, type: "FACT", content: sameA, userId: "alice" },
        { id: 4, type: "FACT", content: sameB, userId: "alice" },
      ],
      memoryLinks: [{ sourceId: 3, targetId: 4, relation: "related_to" }],
    }),
    apply: true,
  });
  assert.ok(!isErr(same), text(same));
  assert.match(text(same), /1 link\(s\) imported, 0 invalid link\(s\)/);
  const sameAId = db.prepare("SELECT id FROM memories WHERE content = ?").get(sameA).id;
  const sameBId = db.prepare("SELECT id FROM memories WHERE content = ?").get(sameB).id;
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS c FROM memory_links WHERE source_memory_id = ? AND target_memory_id = ?")
      .get(sameAId, sameBId).c,
    1,
    "same-scope link written"
  );

  const projContent = `sec04 project ${stamp}`;
  const globalContent = `sec04 global ${stamp}`;
  const proj = importMemoryHandler({
    json: JSON.stringify({
      memories: [
        { id: 5, type: "FACT", content: projContent, projectId: `sec-proj-${stamp}` },
        { id: 6, type: "FACT", content: globalContent },
      ],
      memoryLinks: [{ sourceId: 5, targetId: 6, relation: "supports" }],
    }),
    apply: true,
  });
  assert.ok(!isErr(proj), text(proj));
  assert.match(text(proj), /1 link\(s\) imported, 0 invalid link\(s\)/);
  const projId = db.prepare("SELECT id FROM memories WHERE content = ?").get(projContent).id;
  const globalId = db.prepare("SELECT id FROM memories WHERE content = ?").get(globalContent).id;
  assert.equal(
    db
      .prepare("SELECT COUNT(*) AS c FROM memory_links WHERE source_memory_id = ? AND target_memory_id = ?")
      .get(projId, globalId).c,
    1,
    "PROJECT -> GLOBAL link stays allowed"
  );
});

// --- SEC-05: trust comes from the tool-level flag only ---
test("SEC-05: per-item trusted:true ignored; tool trusted:true honored", () => {
  const stamp = Date.now();
  const spoofContent = `sec05 spoof ${stamp}`;
  const spoof = importMemoryHandler({
    json: JSON.stringify({
      memories: [{ type: "FACT", content: spoofContent, trusted: true }],
      memoryLinks: [],
    }),
    apply: true,
  });
  assert.ok(!isErr(spoof), text(spoof));
  const spoofRow = db.prepare("SELECT metadata FROM memories WHERE content = ?").get(spoofContent);
  assert.equal(JSON.parse(spoofRow.metadata).trusted, false, "row trusted flag ignored");

  const trustedContent = `sec05 trusted ${stamp}`;
  const trusted = importMemoryHandler({
    json: JSON.stringify({
      memories: [{ type: "FACT", content: trustedContent, trusted: false }],
      memoryLinks: [],
    }),
    trusted: true,
    apply: true,
  });
  assert.ok(!isErr(trusted), text(trusted));
  const trustedRow = db.prepare("SELECT metadata FROM memories WHERE content = ?").get(trustedContent);
  assert.equal(JSON.parse(trustedRow.metadata).trusted, true, "tool trusted flag applied");
});

// --- SEC-13: aux is skipped unless trusted === true ---
test("SEC-13: untrusted import skips prefs/lessons/profile; trusted applies them", async () => {
  const stamp = Date.now();
  const prefKey = `sec13_key_${stamp}`;
  const lessonSituation = `sec13 seed ${stamp}`;
  const section = `sec13_section_${stamp}`;
  await rememberHandler({ category: "other", key: prefKey, value: "original" });
  await saveLessonHandler({ situation: lessonSituation, mistake: "seed mistake", correction: "seed correction" });
  db.prepare("INSERT INTO profile (section, content, updated_at) VALUES (?, ?, ?)").run(
    section,
    "original profile",
    new Date().toISOString()
  );
  const lessonsBefore = db.prepare("SELECT COUNT(*) AS c FROM lessons").get().c;

  const payload = JSON.stringify({
    preferences: [{ category: "other", key: prefKey, value: "hacked" }],
    lessons: [{ situation: `sec13 imported ${stamp}`, mistake: "m", correction: "c" }],
    profile: [{ section, content: "hacked profile" }],
  });

  const dry = importMemoryHandler({ json: payload, apply: false });
  assert.match(text(dry), /dry-run/);
  assert.match(text(dry), /aux skipped/);

  const untrusted = importMemoryHandler({ json: payload, apply: true });
  assert.ok(!isErr(untrusted), text(untrusted));
  assert.match(text(untrusted), /aux skipped/);
  assert.equal(
    db.prepare("SELECT value FROM preferences WHERE category = 'other' AND key = ?").get(prefKey).value,
    "original",
    "untrusted import must not overwrite preferences"
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM lessons").get().c,
    lessonsBefore,
    "untrusted import must not append lessons"
  );
  assert.equal(
    db.prepare("SELECT content FROM profile WHERE section = ?").get(section).content,
    "original profile",
    "untrusted import must not overwrite profile"
  );

  const trusted = importMemoryHandler({ json: payload, apply: true, trusted: true });
  assert.ok(!isErr(trusted), text(trusted));
  assert.doesNotMatch(text(trusted), /aux skipped/);
  assert.equal(
    db.prepare("SELECT value FROM preferences WHERE category = 'other' AND key = ?").get(prefKey).value,
    "hacked",
    "trusted import applies preferences"
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM lessons").get().c,
    lessonsBefore + 1,
    "trusted import appends lessons"
  );
  assert.equal(
    db.prepare("SELECT content FROM profile WHERE section = ?").get(section).content,
    "hacked profile",
    "trusted import applies profile"
  );
});

// --- SEC-08: row-count and metadata caps ---
test("SEC-08: 10001 rows rejected before validation", () => {
  const rows = Array.from({ length: 10001 }, (_, i) => ({
    type: "FACT",
    content: `sec08 row ${i}`,
  }));
  const res = importMemoryHandler({ json: JSON.stringify({ memories: rows }), apply: false });
  assert.ok(isErr(res), "oversized import must be rejected");
  assert.match(text(res), /10001 rows exceeds the maximum of 10000 rows/);
});

test("SEC-08: oversized item metadata is rejected as invalid", () => {
  const stamp = Date.now();
  const content = `sec08 metadata ${stamp}`;
  const res = importMemoryHandler({
    json: JSON.stringify({
      memories: [
        { type: "FACT", content, metadata: "x".repeat(64 * 1024 + 1) },
      ],
      memoryLinks: [],
    }),
    apply: true,
  });
  assert.ok(!isErr(res), text(res));
  assert.match(text(res), /0 to import/);
  assert.match(text(res), /1 invalid/);
  assert.equal(
    db.prepare("SELECT id FROM memories WHERE content = ?").get(content),
    undefined,
    "oversized metadata row not imported"
  );
});

// --- SEC-09: dedup is scoped; no cross-user id leak ---
test("SEC-09: dedup is per user; bob imports, alice skips without leaking ids", () => {
  const stamp = Date.now();
  const content = `sec09 shared ${stamp}`;
  const aliceId = createMemory({ type: "FACT", content, userId: "alice" });
  const payload = JSON.stringify({
    memories: [{ type: "FACT", content }],
    memoryLinks: [],
  });

  const bobDry = importMemoryHandler({ json: payload, userId: "bob", apply: false });
  assert.ok(!isErr(bobDry), text(bobDry));
  assert.match(text(bobDry), /1 to import/);
  assert.ok(
    !text(bobDry).includes(`existing ${aliceId}`),
    `cross-user id must not leak in dry-run log: ${text(bobDry)}`
  );

  const bobApply = importMemoryHandler({ json: payload, userId: "bob", apply: true });
  assert.ok(!isErr(bobApply), text(bobApply));
  assert.match(text(bobApply), /1 to import/);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM memories WHERE content = ?").get(content).c,
    2,
    "bob got his own copy"
  );

  const aliceDry = importMemoryHandler({ json: payload, userId: "alice", apply: false });
  assert.ok(!isErr(aliceDry), text(aliceDry));
  assert.match(text(aliceDry), /1 duplicate\(s\) skipped/);
  assert.match(text(aliceDry), new RegExp(`existing ${aliceId}`));
});

// --- Intra-batch dedup is scope-qualified: same content, different owners ---
test("intra-batch dupe guard keeps identical content for different owners", () => {
  const stamp = Date.now();
  const content = `batch scope ${stamp}`;
  const res = importMemoryHandler({
    json: JSON.stringify({
      memories: [
        { type: "FACT", content, userId: "alice" },
        { type: "FACT", content, userId: "bob" },
      ],
      memoryLinks: [],
    }),
    apply: true,
  });
  assert.ok(!isErr(res), text(res));
  assert.match(text(res), /2 to import/);
  assert.match(text(res), /0 duplicate\(s\) skipped/);
  const rows = db
    .prepare(
      `SELECT u.external_id AS owner
       FROM memories m JOIN users u ON u.id = m.user_id
       WHERE m.content = ? ORDER BY u.external_id`
    )
    .all(content);
  assert.equal(rows.length, 2, "both owners got a row");
  assert.deepEqual(rows.map((r) => r.owner), ["alice", "bob"]);
});

test("SEC-09: per-item userId cannot probe another user's dedup scope", () => {
  const stamp = Date.now();
  const content = `sec09 victim probe ${stamp}`;
  const victimId = createMemory({ type: "FACT", content, userId: "victim" });
  const dry = importMemoryHandler({
    json: JSON.stringify({
      memories: [{ type: "FACT", content, userId: "victim" }],
      memoryLinks: [],
    }),
    apply: false,
  });
  assert.ok(!isErr(dry), text(dry));
  assert.match(text(dry), /1 to import/);
  assert.match(text(dry), /0 duplicate\(s\) skipped/);
  assert.ok(
    !text(dry).includes(`existing ${victimId}`),
    `per-item userId leaked another scope's id: ${text(dry)}`
  );
});
