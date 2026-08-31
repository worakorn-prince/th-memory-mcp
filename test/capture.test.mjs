import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Database from "better-sqlite3";
import {
  SECRET_LINE,
  LIMITS,
  filterSecrets,
  truncate,
  createDedupe,
  buildRow,
  INSERT_SQL,
} from "../dist/lib/capture-core.js";

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

// --- 2. filterSecrets ---
check("2. filterSecrets redacts secret lines, keeps normal lines", () => {
  const dirty = "step one\nAPI_KEY=abc123\npassword: hunter2\nstep two";
  const cleaned = filterSecrets(dirty);
  assert.ok(!SECRET_LINE.test(cleaned), "cleaned text still matches SECRET_LINE");
  assert.equal(cleaned.includes("abc123"), false);
  assert.ok(cleaned.includes("[REDACTED]"), "should contain [REDACTED]");
  assert.equal(cleaned.split("\n").length, 4);
});
check("2b. filterSecrets keeps clean text unchanged", () => {
  assert.equal(filterSecrets("a\nb\nc"), "a\nb\nc");
});

// --- 3. truncate ---
check("3. truncate yields exactly max chars (max-1 content + 1 ellipsis)", () => {
  const s = "x".repeat(100);
  const t = truncate(s, 10);
  // actual behavior: slice(0, max-1) + "\u2026" -> total length === max
  assert.equal(t.length, 10);
  assert.ok(t.endsWith("\u2026"));
});
check("3b. truncate passes short text through", () => {
  assert.equal(truncate("short", 10), "short");
});

// --- 4. createDedupe ---
check("4. createDedupe first seen=false then true", () => {
  const d = createDedupe();
  assert.equal(d.seen("m1"), false);
  assert.equal(d.seen("m1"), true);
});
check("4b. createDedupe FIFO evicts beyond maxSize", () => {
  const d = createDedupe(3);
  d.seen("a");
  d.seen("b");
  d.seen("c");
  d.seen("d"); // exceeds maxSize -> "a" evicted
  assert.equal(d.seen("a"), false, "expected 'a' evicted (FIFO)");
  assert.equal(d.seen("d"), true);
});

// --- 5. buildRow ---
check("5. buildRow(prompt) truncates to <= limit+1 and strips secrets", () => {
  let content = "normal line\n";
  while (content.length < 5000) content += "filler filler filler filler filler filler\n";
  content += "API_KEY=topsecret123\nend marker";
  assert.ok(content.length >= 5000, "test setup: content should be >= 5000 chars");
  const row = buildRow("prompt", content, { sessionId: "sess-1" });
  assert.ok(row.content.length <= LIMITS.prompt + 1, `content length ${row.content.length} > ${LIMITS.prompt + 1}`);
  assert.ok(!SECRET_LINE.test(row.content), "secret line survived in row.content");
  assert.equal(row.kind, "prompt");
  assert.equal(row.session_id, "sess-1");
  assert.ok(!Number.isNaN(Date.parse(row.ts)), "ts is not ISO parseable");
  assert.equal(row.meta, null, "meta should be null when omitted");
});

// --- 6. End-to-end SQL ---
const tmp = mkdtempSync(join(tmpdir(), "memcap-test-"));
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
);`);

  check("6. insert 3 rows via buildRow+INSERT_SQL and read back", () => {
    const r1 = buildRow("prompt", "first prompt about pnpm", { sessionId: "sess-A" });
    const r2 = buildRow("tool_call", "tool=bash title=list files", {
      sessionId: "sess-A",
      meta: { callID: "c-1", status: "success" },
    });
    const r3 = buildRow("error", "boom\nAPI_KEY=leak-me", { sessionId: "sess-B" });

    const stmt = db.prepare(INSERT_SQL);
    for (const r of [r1, r2, r3]) {
      stmt.run(r.ts, r.session_id, r.kind, r.content, r.meta);
    }

    const rows = db.prepare("SELECT ts, session_id, kind, content, meta FROM interactions ORDER BY id").all();
    assert.equal(rows.length, 3);

    assert.equal(rows[0].kind, "prompt");
    assert.equal(rows[0].session_id, "sess-A");
    assert.equal(rows[0].content, "first prompt about pnpm");
    assert.equal(rows[0].meta, null);
    assert.equal(rows[0].ts, r1.ts);

    assert.equal(rows[1].kind, "tool_call");
    assert.deepEqual(JSON.parse(rows[1].meta), { callID: "c-1", status: "success" });

    assert.equal(rows[2].kind, "error");
    assert.ok(!SECRET_LINE.test(rows[2].content), "secret leaked into DB row");
    assert.equal(rows[2].session_id, "sess-B");
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

console.log(failures === 0 ? "\nCAPTURE TEST: ALL PASSED" : `\nCAPTURE TEST: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
