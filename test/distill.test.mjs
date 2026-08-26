import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import {
  STOPWORDS,
  tokenize,
  computeStats,
  formatProfileSections,
} from "../dist/lib/distill-core.js";
import { runDistill } from "../dist/distill.js";

let failures = 0;
let step = 0;
function report(ok, name, detail = "") {
  const tag = ok ? "PASS" : "FAIL";
  console.log(`${tag.padEnd(4)} ${(step++ + "").padStart(2)} | ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
function check(name, fn) {
  try {
    fn();
    report(true, name);
  } catch (e) {
    report(false, name, e instanceof Error ? e.message : String(e));
  }
}

// --- 1. tokenize ---
check("1. tokenize Thai+English: keeps 'pnpm'/'ชอบ', drops stopword 'ฉัน'", () => {
  const toks = tokenize("จำไว้ว่าฉันชอบใช้ pnpm and my PNPM scripts");
  assert.ok(toks.includes("pnpm"), `expected token 'pnpm', got ${JSON.stringify(toks)}`);
  assert.ok(toks.includes("ชอบ"), `expected Thai word segmentation to keep 'ชอบ', got ${JSON.stringify(toks)}`);
  assert.ok(toks.includes("scripts"), `expected 'scripts', got ${JSON.stringify(toks)}`);
  assert.equal(toks.includes("ฉัน"), false, "stopword 'ฉัน' must be filtered");
  assert.equal(toks.includes("and"), false, "english stopword 'and' must be filtered");
});
check("1b. tokenize filters pure numbers + short tokens + is lowercase", () => {
  assert.deepEqual(tokenize("Run TEST 42 x A"), ["run", "test"]);
  assert.ok(STOPWORDS.has("the") && STOPWORDS.has("และ"));
});

// --- 2. computeStats ---
const DAY1 = "2026-08-20T10:00:00.000Z";
const DAY2 = "2026-08-21T10:00:00.000Z";
const syntheticRows = [
  { kind: "prompt", content: "love pnpm scripts", meta: null, ts: DAY1 },
  { kind: "prompt", content: "pnpm store prune today", meta: null, ts: DAY2 },
  { kind: "prompt", content: "fix sqlite lock issue", meta: null, ts: DAY2 },
  { kind: "tool_call", content: "tool=read title=a", meta: '{"tool":"read"}', ts: DAY1 },
  { kind: "tool_call", content: "tool=read title=b", meta: '{"tool":"read"}', ts: DAY1 },
  { kind: "tool_call", content: "tool=read title=c", meta: '{"tool":"read"}', ts: DAY2 },
  { kind: "tool_call", content: "tool=edit title=d", meta: '{"tool":"edit"}', ts: DAY2 },
];
check("2. computeStats counts prompts/days/tools/keywords", () => {
  const stats = computeStats(syntheticRows);
  assert.equal(stats.totalPrompts, 3);
  assert.equal(stats.promptDays, 2);
  assert.ok(Array.isArray(stats.topTools) && stats.topTools.length >= 2);
  assert.deepEqual(stats.topTools[0], ["read", 3], `topTools[0]=${JSON.stringify(stats.topTools[0])}`);
  assert.ok(
    stats.topKeywords.some(([w, c]) => w === "pnpm" && c === 2),
    `expected keyword pnpm count 2, got ${JSON.stringify(stats.topKeywords)}`
  );
});
check("2b. computeStats tolerates broken meta JSON", () => {
  const stats = computeStats([
    { kind: "tool_call", content: "x", meta: "{not json", ts: DAY1 },
    { kind: "prompt", content: "", meta: null, ts: DAY1 },
  ]);
  assert.equal(stats.totalPrompts, 1);
  assert.equal(stats.topTools.length, 0);
});

// --- 3. formatProfileSections ---
check("3. formatProfileSections returns usage_stats+topics mentioning tools", () => {
  const sections = formatProfileSections(computeStats(syntheticRows));
  assert.ok(typeof sections.usage_stats === "string" && sections.usage_stats.length > 0);
  assert.ok(typeof sections.topics === "string" && sections.topics.length > 0);
  assert.ok(sections.usage_stats.includes("prompts:"), "usage_stats should start with prompt count line");
  assert.ok(sections.usage_stats.includes("across 2 days"), `got: ${sections.usage_stats}`);
  assert.ok(sections.usage_stats.includes("read"), "usage_stats should mention tool 'read'");
  assert.ok(/top tools: read\(3\), edit\(1\)/.test(sections.usage_stats), `got: ${sections.usage_stats}`);
  assert.ok(sections.topics.includes("frequent topics:") && sections.topics.includes("pnpm"));
});

// --- 4. E2E: temp DB with full DDL -> runDistill -> profile written + prune ---
const tmp = mkdtempSync(join(tmpdir(), "distill-test-"));
try {
  const db = new Database(join(tmp, "t.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
CREATE TABLE IF NOT EXISTS interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  meta TEXT
);

CREATE TABLE IF NOT EXISTS preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence REAL DEFAULT 0.5,
  source TEXT DEFAULT 'explicit',
  updated_at TEXT NOT NULL,
  UNIQUE(category, key)
);

CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  situation TEXT NOT NULL,
  mistake TEXT NOT NULL,
  correction TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profile (
  section TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  ref_table, ref_id, title, body
);`);

  const insertStmt = db.prepare(
    "INSERT INTO interactions (ts, session_id, kind, content, meta) VALUES (?, ?, ?, ?, ?)"
  );
  const nowIso = (offsetDays) =>
    new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000).toISOString();

  const recentTs1 = nowIso(0);
  const recentTs2 = nowIso(1);
  const oldTs = nowIso(60); // beyond default RETENTION_DAYS=30

  insertStmt.run(recentTs1, "s1", "prompt", "remember that i like using pnpm daily", null);
  insertStmt.run(recentTs2, "s1", "prompt", "pnpm install failed with sqlite native error", null);
  insertStmt.run(recentTs2, "s1", "tool_call", "tool=read title=f", '{"tool":"read","directory":"D:/proj/a"}');
  insertStmt.run(recentTs2, "s1", "tool_call", "tool=edit title=g", '{"tool":"edit","directory":"D:/proj/a"}');
  const oldRes = insertStmt.run(oldTs, "s0", "prompt", "very old prompt about webpack", null);
  const oldId = Number(oldRes.lastInsertRowid);

  check("4a. setup: 5 interactions inserted, profile table starts empty", () => {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM interactions").get().n, 5);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM profile").get().n, 0);
  });

  let summary;
  check("4b. runDistill writes usage_stats+topics into profile", () => {
    summary = runDistill(db);
    const sections = db
      .prepare("SELECT section, content FROM profile ORDER BY section")
      .all();
    const names = sections.map((r) => r.section).sort();
    assert.deepEqual(names, ["topics", "usage_stats"], `profile sections=${JSON.stringify(names)}`);
    const byName = Object.fromEntries(sections.map((r) => [r.section, r.content]));
    assert.match(byName.usage_stats, /prompts:/);
    assert.match(byName.usage_stats, /read\(1\), edit\(1\)|edit\(1\), read\(1\)/);
    assert.match(byName.topics, /frequent topics:/);
    assert.ok(byName.topics.includes("pnpm"));
  });

  check("4c. old row (60d) pruned, recent rows kept", () => {
    assert.equal(summary.pruned, 1, `pruned=${summary.pruned}`);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM interactions").get().n, 4);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM interactions WHERE id = ?").get(oldId).n,
      0,
      "old interaction must be deleted"
    );
    const remaining = db
      .prepare("SELECT COUNT(*) AS n FROM interactions WHERE content LIKE '%pnpm%'")
      .get().n;
    assert.equal(remaining, 2, "recent pnpm prompts must survive");
  });

  check("4d. runDistill is idempotent on second call", () => {
    const s2 = runDistill(db);
    assert.equal(s2.pruned, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM profile").get().n, 2);
  });

  db.close();
} finally {
  for (const f of [join(tmp, "t.db"), join(tmp, "t.db-wal"), join(tmp, "t.db-shm")]) {
    try {
      rmSync(f, { force: true });
    } catch {}
  }
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {}
}

console.log(failures === 0 ? "\nDISTILL TEST: ALL PASSED" : `\nDISTILL TEST: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
