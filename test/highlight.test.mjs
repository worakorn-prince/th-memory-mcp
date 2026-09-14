import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const dbPath = join(tmpdir(), `th-mem-hl-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { findMemorySpans, renderHighlighted, highlightTextWithMemory } = await import(
  "../dist/lib/highlight.js"
);
const { rememberHandler } = await import("../dist/tools/remember.js");
const { db } = await import("../dist/db/index.js");

test("findMemorySpans matches English literally", () => {
  const spans = findMemorySpans("I like pnpm a lot", ["pnpm"]);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].start, 7);
  assert.equal(spans[0].end, 11);
});

test("findMemorySpans matches Thai literally", () => {
  const spans = findMemorySpans("สวัสดีชาวโลกวันนี้", ["ชาวโลก"]);
  assert.equal(spans.length, 1);
  assert.equal("สวัสดีชาวโลกวันนี้".slice(spans[0].start, spans[0].end), "ชาวโลก");
});

test("findMemorySpans returns [] on no match", () => {
  assert.deepEqual(findMemorySpans("hello world", ["xyz"]), []);
});

test("findMemorySpans prefers longest on overlap", () => {
  const spans = findMemorySpans("use tabs for indent", ["tabs", "tabs for indent"]);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].source, "tabs for indent");
  assert.equal("use tabs for indent".slice(spans[0].start, spans[0].end), "tabs for indent");
});

test("renderHighlighted color:true uses ANSI underline", () => {
  const out = renderHighlighted("hello world", [{ start: 6, end: 11 }], { color: true });
  assert.ok(out.includes("[4m"), `missing ANSI underline: ${JSON.stringify(out)}`);
  assert.ok(out.includes("world"));
});

test("renderHighlighted color:false uses [mem] tags", () => {
  const out = renderHighlighted("hello world", [{ start: 6, end: 11 }], { color: false });
  assert.ok(out.includes("[mem]world[/mem]"), `output: ${out}`);
});

test("highlightTextWithMemory highlights remembered phrase", async () => {
  const r = await rememberHandler({
    category: "coding_pref",
    key: "hl_key",
    value: "use tabs for indent",
  });
  assert.ok(!r.content[0].text.startsWith("error:"), `remember: ${r.content[0].text}`);
  const out = await highlightTextWithMemory(
    "please use tabs for indent here",
    "tabs indent"
  );
  assert.ok(
    out.includes("[mem]use tabs for indent[/mem]"),
    `highlight output: ${out}`
  );
});

test("highlightTextWithMemory returns original on no-topic match", async () => {
  const out = await highlightTextWithMemory("hello world", "zzz-no-match-xyz-123");
  assert.equal(out, "hello world");
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await import("node:fs").then((fs) => fs.rmSync(`${dbPath}${suffix}`, { force: true }));
    } catch {}
  }
});
