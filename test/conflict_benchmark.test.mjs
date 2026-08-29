import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const dbPath = join(tmpdir(), `th-mem-conflict-bench-${Date.now()}.db`);
process.env.MEMORY_DB_PATH = dbPath;

const { createMemory } = await import("../dist/db/repositories/memories.js");
const { classifyRelationship } = await import("../dist/memory/conflict-resolver.js");
const { db } = await import("../dist/db/index.js");

// Labeled pairs covering all 7 §27 categories. Expected relation is one of
// duplicate / update / contradiction / unrelated (the system's vocabulary).
// Ambiguous opposite-preference pairs are expected to be preserved as
// "contradiction" (linked, never silently superseded).
const CASES = [
  // exact duplicate
  ["Use pnpm as the package manager", "Use pnpm as the package manager", "duplicate"],
  ["I prefer tabs for indentation", "I prefer tabs for indentation", "duplicate"],
  // paraphrase duplicate
  ["pnpm is the package manager", "Use pnpm as the package manager", "duplicate"],
  ["Use React for the web frontend", "Use React on the frontend", "duplicate"],
  // preference update / clarification
  ["Use pnpm", "Use pnpm for CI builds", "update"],
  ["Deploy to AWS", "Deploy the app to AWS us-east-1", "update"],
  // direct contradiction
  ["I like TypeScript", "I do not like TypeScript", "contradiction"],
  ["Use Vim", "I never use Vim", "contradiction"],
  // temporary exception (preserved, unrelated)
  ["I use Vim normally", "This week I am using VS Code", "unrelated"],
  ["We usually meet at 9am", "Tomorrow we meet at 3pm", "unrelated"],
  // two valid but different scoped memories
  ["Use React for the web frontend", "Use Flutter for mobile apps", "unrelated"],
  ["Store config in environment variables", "Store secrets in a vault", "unrelated"],
  // ambiguous conflict (opposite preference, preserved as contradiction)
  ["Prefer tabs", "Prefer spaces", "contradiction"],
  ["I like Vim", "I prefer Emacs", "contradiction"],
];

test("conflict classification meets >=95% accuracy (§27)", async () => {
  let correct = 0;
  const misses = [];
  for (const [rel, cand, exp] of CASES) {
    const id = createMemory({ type: "PREFERENCE", content: rel, importance: 0.8 });
    const got = classifyRelationship({ type: "PREFERENCE", content: cand, id }, id);
    if (got === exp) correct++;
    else misses.push({ exp, got, rel, cand });
  }
  const accuracy = correct / CASES.length;
  assert.ok(
    accuracy >= 0.95,
    `conflict classification accuracy ${accuracy.toFixed(2)} < 0.95; misses: ${JSON.stringify(misses)}`
  );
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await import("node:fs").then((fs) => fs.rmSync(`${dbPath}${suffix}`, { force: true }));
    } catch {}
  }
});
