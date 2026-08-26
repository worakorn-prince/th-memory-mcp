import { spawn } from "node:child_process";
import { rmSync, existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverPath = resolve(root, "dist", "index.js");
// Test DB lives in an OS temp dir so the project's data/ stays untouched.
// export_memory derives its exports dir from dirname(DB_PATH), so exported
// JSON also lands inside this same temp dir and is cleaned up with it.
const tmpDir = mkdtempSync(join(tmpdir(), "memory-mcp-smoke-"));
const testDb = join(tmpDir, "memory.db");
const expectedExportsDir = resolve(join(tmpDir, "exports"));
const MAX_TOOL_MS = Number(process.env.SMOKE_MAX_TOOL_MS ?? 100);
const MAX_STARTUP_MS = 2000;

let failures = 0;
let step = 0;
function report(ok, name, detail = "") {
  const tag = ok ? "PASS" : "FAIL";
  console.log(`${tag.padEnd(4)} ${(step++ + "").padStart(2)} | ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, MEMORY_DB_PATH: testDb },
});

let stderrBuf = "";
child.stderr.on("data", (d) => {
  stderrBuf += d.toString();
});
child.on("exit", (code) => {
  if (code && code !== 0 && !exiting) {
    report(false, "server exited early", `code=${code}\n${stderrBuf}`);
    printSummaryAndExit();
  }
});

const pending = new Map();
let nextId = 1;
let lineBuf = "";

function handleLine(line) {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id !== undefined && msg.id !== null && pending.has(msg.id)) {
    const { resolveP, rejectP } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) rejectP(new Error(`${msg.error.code}: ${msg.error.message}`));
    else resolveP(msg.result);
  }
}

child.stdout.on("data", (chunk) => {
  lineBuf += chunk.toString();
  let idx;
  while ((idx = lineBuf.indexOf("\n")) >= 0) {
    const line = lineBuf.slice(0, idx);
    lineBuf = lineBuf.slice(idx + 1);
    handleLine(line);
  }
});

function send(msg) {
  return new Promise((resolveP, rejectP) => {
    child.stdin.write(JSON.stringify(msg) + "\n", (e) => (e ? rejectP(e) : resolveP()));
  });
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolveP, rejectP) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      rejectP(new Error(`timeout waiting for ${method}`));
    }, 15000);
    pending.set(id, {
      resolveP: (v) => {
        clearTimeout(timer);
        resolveP(v);
      },
      rejectP: (e) => {
        clearTimeout(timer);
        rejectP(e);
      },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function textOf(result) {
  const c = result?.content ?? [];
  return c.map((x) => (x.type === "text" ? x.text : "")).join("\n");
}

async function timedCall(name, args) {
  const t0 = performance.now();
  const result = await request("tools/call", { name, arguments: args });
  const ms = performance.now() - t0;
  return { result, ms };
}

async function toolCall(name, args, label) {
  const { result, ms } = await timedCall(name, args);
  report(ms < MAX_TOOL_MS, `${label} latency`, `${ms.toFixed(1)} ms (budget ${MAX_TOOL_MS} ms)`);
  return { text: textOf(result), isError: result?.isError === true, ms };
}

function cleanupTempDir() {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
}

let summaryPrinted = false;
function printSummaryAndExit() {
  if (summaryPrinted) return;
  summaryPrinted = true;
  try {
    child.kill();
  } catch {}
  setTimeout(() => {
    // child is dead by now; DB handles released -> temp dir can be removed
    cleanupTempDir();
    console.log(failures === 0 ? "\nSMOKE TEST: ALL PASSED" : `\nSMOKE TEST: ${failures} FAILURE(S)`);
    process.exit(failures === 0 ? 0 : 1);
  }, 200);
}

const watchdog = setTimeout(() => {
  report(false, "global watchdog timeout");
  printSummaryAndExit();
}, 60000);

let exiting = false;

try {
  const t0 = performance.now();
  const initResult = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke-test", version: "0.0.0" },
  });
  const startupMs = performance.now() - t0;

  report(initResult?.serverInfo?.name === "memory-mcp", "1. initialize → serverInfo",
    `name=${initResult?.serverInfo?.name} v=${initResult?.serverInfo?.version}`);
  report(startupMs < MAX_STARTUP_MS, "startup < 2s to initialize-ready", `${startupMs.toFixed(0)} ms`);

  await send({ jsonrpc: "2.0", method: "notifications/initialized" });
  report(true, "2. notification initialized sent");

  const listResult = await request("tools/list", {});
  const toolNames = (listResult?.tools ?? []).map((t) => t.name).sort();
  const expected = [
    "export_memory",
    "forget",
    "get_profile",
    "get_recent_interactions",
    "memory_stats",
    "recall",
    "remember",
    "save_lesson",
    "search_history",
  ];
  report(
    JSON.stringify(toolNames) === JSON.stringify(expected),
    "3. tools/list has 9 tools",
    toolNames.join(", ")
  );

  const remember = await toolCall(
    "remember",
    { category: "coding_pref", key: "package_manager", value: "pnpm" },
    "4. remember package_manager=pnpm"
  );
  report(!remember.isError, "4a. remember no error", remember.text.slice(0, 80));
  const idMatch = remember.text.match(/id=(\d+)/);
  const prefId = idMatch ? Number(idMatch[1]) : NaN;
  report(Number.isFinite(prefId), "4b. remember returned id", `id=${prefId}`);

  const again = await toolCall(
    "remember",
    { category: "coding_pref", key: "package_manager", value: "pnpm" },
    "extra: remember same key again"
  );
  report(/confidence=0\.60/.test(again.text), "extra. confidence upsert +0.1", again.text.slice(0, 90));

  const profile = await toolCall("get_profile", {}, "5. get_profile");
  report(profile.text.includes("pnpm"), "5a. profile contains pnpm");
  report(profile.text.length <= 3000, "5b. get_profile <= 3000 chars", `${profile.text.length} chars`);

  const lesson = await toolCall(
    "save_lesson",
    {
      situation: "editing TypeScript source files in this repo",
      mistake: "used spaces for indentation although codebase uses tabs",
      correction: "always use tabs for indentation in this project",
    },
    "6a. save_lesson"
  );
  report(!lesson.isError, "6b. lesson saved", lesson.text.slice(0, 60));
  const lessonIdMatch = lesson.text.match(/id=(\d+)/);
  const lessonId = lessonIdMatch ? Number(lessonIdMatch[1]) : NaN;

  const recall = await toolCall("recall", { topic: "pnpm" }, "6c. recall('pnpm')");
  report(recall.text.includes("pnpm"), "6d. recall matches pnpm", recall.text.slice(0, 100));
  report(recall.text.length <= 2000, "6e. recall <= 2000 chars", `${recall.text.length} chars`);

  const history = await toolCall(
    "search_history",
    { query: "pnpm" },
    "extra: search_history('pnpm') empty is ok"
  );
  report(!history.isError, "extra. search_history no error", history.text.slice(0, 60));

  const forgot = await toolCall(
    "forget",
    { target_id: prefId, type: "preference" },
    "7a. forget(prefId, type=preference)"
  );
  report(!forgot.isError && /forgot preference/i.test(forgot.text), "7b. forget removed preference only", forgot.text.slice(0, 60));

  const profileAfter = await toolCall("get_profile", {}, "7c. get_profile after forget");
  report(
    !profileAfter.text.includes("pnpm") && !profileAfter.text.includes("package_manager"),
    "7d. profile no longer contains the forgotten preference"
  );
  report(profileAfter.text.includes("indentation"), "7e. unrelated lesson survived (no collateral delete)");

  const forgotLesson = await toolCall(
    "forget",
    { target_id: lessonId, type: "lesson" },
    "7f. forget(lessonId, type=lesson)"
  );
  report(/forgot lesson/i.test(forgotLesson.text), "7g. lesson forgotten", forgotLesson.text.slice(0, 60));

  const recallAfter = await toolCall("recall", { topic: "indentation" }, "7h. recall('indentation') after forget");
  report(recallAfter.text.startsWith("no memory found"), "7i. forgotten lesson not searchable");

  // --- Phase 4: Insight & Safety ---
  {
    const sdb = new Database(testDb);
    sdb.pragma("busy_timeout = 5000");
    const ins = sdb.prepare(
      "INSERT INTO interactions (ts, session_id, kind, content) VALUES (?, ?, ?, ?)"
    );
    const now = new Date().toISOString();
    ins.run(now, "smoke", "prompt", "phase4 prompt about pnpm workflows");
    ins.run(now, "smoke", "tool_call", 'tool=read title="read design.md"');
    ins.run(now, "smoke", "prompt", "second phase4 prompt for kind filter");
    sdb.close();
    report(true, "8a. seeded 3 interactions into test DB (2 prompt, 1 tool_call)");
  }

  const stats = await toolCall("memory_stats", {}, "8b. memory_stats");
  report(!stats.isError, "8c. memory_stats no error", stats.text.slice(0, 60));
  report(stats.text.length <= 1500, "8d. memory_stats <= 1500 chars", `${stats.text.length} chars`);
  report(
    /interactions: 3 total \(prompt=2, tool_call=1, error=0\)/.test(stats.text),
    "8e. memory_stats counts by kind",
    stats.text.split("\n")[0] ?? ""
  );

  const recent = await toolCall("get_recent_interactions", { limit: 5 }, "9a. get_recent_interactions limit=5");
  report(!recent.isError && !recent.text.startsWith("no interactions"), "9b. recent returns seeded rows", recent.text.slice(0, 80));
  report(recent.text.length <= 4000, "9c. recent <= 4000 chars", `${recent.text.length} chars`);
  report(
    /^\[\d+\] \S+ \[(?:prompt|tool_call|error)\] /m.test(recent.text),
    "9d. line format [id] ts [kind] content"
  );

  const recentPrompt = await toolCall(
    "get_recent_interactions",
    { limit: 5, kind: "prompt" },
    "9e. get_recent_interactions kind=prompt"
  );
  const promptLines = recentPrompt.text.trim().split("\n");
  report(
    !recentPrompt.isError && promptLines.length === 2 && promptLines.every((l) => l.includes("[prompt]")),
    "9f. kind=prompt filters to exactly the 2 prompt rows",
    `${promptLines.length} line(s)`
  );

  const exp = await toolCall("export_memory", {}, "10a. export_memory default");
  report(!exp.isError, "10b. export_memory no error", exp.text.slice(0, 60));
  report(/size: \d+ bytes/.test(exp.text), "10c. export reports size in bytes", (exp.text.match(/size: \d+ bytes/) ?? [""])[0]);
  const preview = exp.text.slice(exp.text.indexOf("preview:") + "preview:".length).trim();
  report(preview.length <= 500, "10d. JSON preview <= 500 chars", `${preview.length} chars`);

  const pathMatch = exp.text.match(/^exported: (.+\.json)$/m);
  report(!!pathMatch, "10e. export returns .json path", pathMatch?.[1]?.trim() ?? "(none)");
  if (pathMatch?.[1]) {
    const exportedPath = pathMatch[1].trim();
    report(existsSync(exportedPath), "10f. exported file exists on disk", exportedPath);
    try {
      const parsed = JSON.parse(readFileSync(exportedPath, "utf8"));
      const keysOk = ["exported_at", "version", "preferences", "lessons", "profile", "interactions"].every(
        (k) => k in parsed
      );
      report(
        keysOk && parsed.version === "1.1.0" && parsed.interactions.included === false,
        "10g. default export: spec keys present, interactions excluded"
      );
    } catch (e) {
      report(false, "10g. default export: spec keys present, interactions excluded", String(e));
    }
  }

  const expAll = await toolCall("export_memory", { includeInteractions: true }, "extra: export includeInteractions=true");
  const allMatch = expAll.text.match(/^exported: (.+\.json)$/m);
  if (allMatch?.[1]) {
    try {
      const parsedAll = JSON.parse(readFileSync(allMatch[1].trim(), "utf8"));
      report(
        parsedAll.interactions.included === true &&
          parsedAll.interactions.count === 3 &&
          Array.isArray(parsedAll.interactions.rows) &&
          parsedAll.interactions.rows.length === 3,
        "extra. full export embeds all 3 interaction rows"
      );
    } catch (e) {
      report(false, "extra. full export embeds all 3 interaction rows", String(e));
    }
  } else {
    report(false, "extra. full export embeds all 3 interaction rows", "no path in response");
  }

  const badExport = await toolCall("export_memory", { filename: "../evil.json" }, "extra: export unsafe filename");
  report(badExport.text.startsWith("error"), "extra. unsafe filename rejected", badExport.text.slice(0, 90));

  const customExport = await toolCall("export_memory", { filename: "smoke-custom.json" }, "extra: export custom sanitized filename");
  const customMatch = customExport.text.match(/^exported: (.+\.json)$/m);
  report(
    !!customMatch?.[1] &&
      existsSync(customMatch[1].trim()) &&
      resolve(customMatch[1].trim()).startsWith(expectedExportsDir),
    "extra. custom sanitized filename written inside exports dir",
    customMatch?.[1]?.trim() ?? "(none)"
  );

  report(true, "11. graceful shutdown");
} catch (e) {
  report(false, "unexpected failure", e instanceof Error ? e.message : String(e));
} finally {
  clearTimeout(watchdog);
  exiting = true;
  // best effort here (child may still hold the DB); printSummaryAndExit
  // retries after the child is killed, covering both pass and fail paths
  cleanupTempDir();
  printSummaryAndExit();
}
