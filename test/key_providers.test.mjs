// Ph-6 C2 — encryption key providers (dependency-free).
//
//   MEMORY_ENCRYPTION_KEY       inline base64          (highest priority)
//   MEMORY_ENCRYPTION_KEY_FILE  file holding base64
//   MEMORY_ENCRYPTION_KEY_CMD   command line printing base64 (no shell)
//
// The unit half drives dist/lib/config.js resolveEncryptionKey() with explicit
// env objects; the call-site half spawns dist/db/index.js to prove what the
// server actually does (plaintext open in legacy mode, exit 2 on a bad key).
// No test may ever see key material in output — that is asserted both per case
// and once over every captured stderr line.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test, after } from "node:test";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const appUrl = new URL("../dist/db/index.js", import.meta.url).href;

const { resolveEncryptionKey, getEncryptionKey, splitCommandLine } = await import(
  "../dist/lib/config.js"
);

const workDir = mkdtempSync(join(tmpdir(), "th-p6-keyprov-"));
after(() => rmSync(workDir, { recursive: true, force: true }));

const NODE = process.execPath;
const keyA = new Uint8Array(32).fill(0x11);
const keyB = new Uint8Array(32).fill(0x22);
const keyC = new Uint8Array(32).fill(0x33);
const b64A = Buffer.from(keyA).toString("base64");
const b64B = Buffer.from(keyB).toString("base64");
const b64C = Buffer.from(keyC).toString("base64");

const stderrSeen = [];

async function captureStderr(fn) {
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const value = await fn();
    return { value, stderr: chunks.join("") };
  } finally {
    process.stderr.write = original;
    stderrSeen.push(chunks.join(""));
  }
}

/**
 * Env for a resolution: a clean base (no inherited MEMORY_* settings, so the
 * suite behaves the same when the whole run is launched with
 * MEMORY_ENCRYPTION=on + a key) plus exactly what the case sets.
 */
function env(extra) {
  const base = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("MEMORY_")) base[name] = value;
  }
  return { ...base, ...extra };
}

function writeKeyFile(name, contents) {
  const path = join(workDir, name);
  writeFileSync(path, contents, "utf8");
  return path;
}

/** A command line that runs node -e <code> without a shell (no quotes in code). */
function nodeCommand(code) {
  return `"${NODE}" -e "${code}"`;
}

const sameKey = (actual, expected) => {
  assert.ok(actual instanceof Uint8Array, "expected a Uint8Array key");
  assert.deepEqual([...actual], [...expected]);
};

const boundedLines = (text) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

// ------------------------------------------------------------------ env ---

test("env provider: inline base64 resolves, source env, silent", async () => {
  const { value, stderr } = await captureStderr(() =>
    resolveEncryptionKey(env({ MEMORY_ENCRYPTION: "on", MEMORY_ENCRYPTION_KEY: b64A }))
  );
  assert.equal(value.source, "env");
  sameKey(value.key, keyA);
  assert.equal(value.error, undefined);
  assert.equal(stderr, "");
});

test("env provider: invalid base64 fails fast without echoing the value", async () => {
  const bad = "this-is-not-32-bytes-of-base64";
  const { value, stderr } = await captureStderr(() =>
    resolveEncryptionKey(env({ MEMORY_ENCRYPTION: "on", MEMORY_ENCRYPTION_KEY: bad }))
  );
  assert.equal(value.key, undefined);
  assert.match(value.error, /^MEMORY_ENCRYPTION_KEY is not a valid base64-encoded 32-byte key$/);
  assert.equal(`${stderr}${value.error}`.includes(bad), false);
  assert.equal(stderr, "");
});

// ----------------------------------------------------------- precedence ---

test("precedence: env wins over file and cmd, one bounded warning, cmd not run", async () => {
  const marker = join(workDir, "precedence-cmd-marker");
  const filePath = writeKeyFile("precedence.key", `${b64B}\n`);
  process.env.KEYPROBE_MARKER = marker;
  try {
    const { value, stderr } = await captureStderr(() =>
      resolveEncryptionKey(
        env({
          MEMORY_ENCRYPTION: "on",
          MEMORY_ENCRYPTION_KEY: b64A,
          MEMORY_ENCRYPTION_KEY_FILE: filePath,
          MEMORY_ENCRYPTION_KEY_CMD: nodeCommand(
            "require('node:fs').writeFileSync(process.env.KEYPROBE_MARKER,'ran');process.stdout.write(process.env.KEYPROBE_KEY)"
          ),
        })
      )
    );
    assert.equal(value.source, "env");
    sameKey(value.key, keyA);
    assert.equal(existsSync(marker), false, "the ignored key command must not be executed");

    const lines = boundedLines(stderr);
    assert.equal(lines.length, 1, `expected exactly one warning, got:\n${stderr}`);
    assert.match(lines[0], /MEMORY_ENCRYPTION_KEY takes precedence/);
    assert.match(lines[0], /MEMORY_ENCRYPTION_KEY_FILE and MEMORY_ENCRYPTION_KEY_CMD/);
    assert.ok(lines[0].length <= 240, `warning is not bounded: ${lines[0].length} chars`);
  } finally {
    delete process.env.KEYPROBE_MARKER;
  }
});

test("precedence: file wins over cmd (cmd not executed)", async () => {
  const marker = join(workDir, "file-over-cmd-marker");
  const filePath = writeKeyFile("file-over-cmd.key", b64B);
  process.env.KEYPROBE_MARKER = marker;
  try {
    const { value, stderr } = await captureStderr(() =>
      resolveEncryptionKey(
        env({
          MEMORY_ENCRYPTION: "on",
          MEMORY_ENCRYPTION_KEY_FILE: filePath,
          MEMORY_ENCRYPTION_KEY_CMD: nodeCommand(
            "require('node:fs').writeFileSync(process.env.KEYPROBE_MARKER,'ran')"
          ),
        })
      )
    );
    assert.equal(value.source, "file");
    sameKey(value.key, keyB);
    assert.equal(existsSync(marker), false);
    const lines = boundedLines(stderr);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /MEMORY_ENCRYPTION_KEY_FILE takes precedence; ignoring MEMORY_ENCRYPTION_KEY_CMD/);
  } finally {
    delete process.env.KEYPROBE_MARKER;
  }
});

// ----------------------------------------------------------------- file ---

test("file provider: trimmed contents resolve the key", async () => {
  const filePath = writeKeyFile("plain.key", `\n  ${b64B}  \r\n`);
  const { value, stderr } = await captureStderr(() =>
    resolveEncryptionKey(env({ MEMORY_ENCRYPTION: "on", MEMORY_ENCRYPTION_KEY_FILE: filePath }))
  );
  assert.equal(value.source, "file");
  sameKey(value.key, keyB);
  // A 0600 temp file yields no permission warning on POSIX; Windows has no modes.
  if (process.platform !== "win32") assert.equal(stderr, "");
});

test("file provider: group/world-readable file warns once (POSIX only)", async () => {
  const filePath = writeKeyFile("loose.key", b64C);
  if (process.platform !== "win32") chmodSync(filePath, 0o644);
  const first = await captureStderr(() =>
    resolveEncryptionKey(env({ MEMORY_ENCRYPTION: "on", MEMORY_ENCRYPTION_KEY_FILE: filePath }))
  );
  sameKey(first.value.key, keyC);
  if (process.platform === "win32") {
    assert.equal(first.stderr, "");
  } else {
    const lines = boundedLines(first.stderr);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /MEMORY_ENCRYPTION_KEY_FILE is group\/world readable \(chmod 600 recommended\)/);
    assert.equal(first.stderr.includes(b64C), false);

    const second = await captureStderr(() =>
      resolveEncryptionKey(env({ MEMORY_ENCRYPTION: "on", MEMORY_ENCRYPTION_KEY_FILE: filePath }))
    );
    assert.equal(second.stderr, "", "the permission warning must be emitted once");
  }
});

test("file provider: unreadable path fails fast without echoing the path", async () => {
  const missing = join(workDir, "no-such-key-file");
  const { value } = await captureStderr(() =>
    resolveEncryptionKey(env({ MEMORY_ENCRYPTION: "on", MEMORY_ENCRYPTION_KEY_FILE: missing }))
  );
  assert.equal(value.key, undefined);
  assert.equal(value.error, "MEMORY_ENCRYPTION_KEY_FILE is unreadable");
  assert.equal(value.error.includes(missing), false);
});

test("file provider: a non-key file fails fast", async () => {
  const filePath = writeKeyFile("garbage.key", "definitely not a key");
  const { value } = await captureStderr(() =>
    resolveEncryptionKey(env({ MEMORY_ENCRYPTION: "on", MEMORY_ENCRYPTION_KEY_FILE: filePath }))
  );
  assert.equal(value.key, undefined);
  assert.equal(value.error, "MEMORY_ENCRYPTION_KEY_FILE did not produce a valid 32-byte key");
});

// ------------------------------------------------------------------ cmd ---

test("cmd provider: stdout resolves the key (no shell involved)", async () => {
  const { value, stderr } = await captureStderr(() =>
    resolveEncryptionKey(
      env({
        MEMORY_ENCRYPTION: "on",
        MEMORY_ENCRYPTION_KEY_CMD: nodeCommand(`process.stdout.write('${b64C}')`),
      })
    )
  );
  assert.equal(value.source, "cmd");
  sameKey(value.key, keyC);
  assert.equal(value.error, undefined);
  assert.equal(stderr, "");
});

test("cmd provider: quoted arguments survive the split", () => {
  assert.deepEqual(splitCommandLine(`"${NODE}" -e "console.log('a b')"`), [
    NODE,
    "-e",
    "console.log('a b')",
  ]);
  assert.deepEqual(splitCommandLine(`  powershell  -NoProfile -Command "(Get-Content 'C:\\k')" `), [
    "powershell",
    "-NoProfile",
    "-Command",
    "(Get-Content 'C:\\k')",
  ]);
  assert.deepEqual(splitCommandLine("   "), []);
});

test("cmd provider: non-zero exit fails fast with status only", async () => {
  const { value, stderr } = await captureStderr(() =>
    resolveEncryptionKey(
      env({
        MEMORY_ENCRYPTION: "on",
        MEMORY_ENCRYPTION_KEY_CMD: nodeCommand("process.stdout.write('secret-key-text');process.exit(7)"),
      })
    )
  );
  assert.equal(value.key, undefined);
  assert.equal(value.error, "MEMORY_ENCRYPTION_KEY_CMD exited with status 7");
  assert.equal(`${stderr}${value.error}`.includes("secret-key-text"), false);
});

test("cmd provider: garbage output fails fast without echoing it", async () => {
  const { value, stderr } = await captureStderr(() =>
    resolveEncryptionKey(
      env({
        MEMORY_ENCRYPTION: "on",
        MEMORY_ENCRYPTION_KEY_CMD: nodeCommand("process.stdout.write('not-a-valid-key')"),
      })
    )
  );
  assert.equal(value.key, undefined);
  assert.equal(value.error, "MEMORY_ENCRYPTION_KEY_CMD did not produce a valid 32-byte key");
  assert.equal(`${stderr}${value.error}`.includes("not-a-valid-key"), false);
});

test("cmd provider: empty output fails fast", async () => {
  const { value } = await captureStderr(() =>
    resolveEncryptionKey(
      env({
        MEMORY_ENCRYPTION: "on",
        MEMORY_ENCRYPTION_KEY_CMD: nodeCommand("process.stdout.write('   ')"),
      })
    )
  );
  assert.equal(value.key, undefined);
  assert.equal(value.error, "MEMORY_ENCRYPTION_KEY_CMD produced no output");
});

test(
  "cmd provider: a hanging command is killed after 5 s",
  { timeout: 40000 },
  async () => {
    const started = Date.now();
    const { value } = await captureStderr(() =>
      resolveEncryptionKey(
        env({
          MEMORY_ENCRYPTION: "on",
          MEMORY_ENCRYPTION_KEY_CMD: nodeCommand("setTimeout(()=>{},60000)"),
        })
      )
    );
    const elapsed = Date.now() - started;
    assert.equal(value.key, undefined);
    assert.equal(value.error, "MEMORY_ENCRYPTION_KEY_CMD timed out after 5000 ms");
    assert.ok(elapsed >= 4500, `returned too early for a timeout: ${elapsed} ms`);
    assert.ok(elapsed < 30000, `timeout was not enforced: ${elapsed} ms`);
  }
);

// --------------------------------------------------------------- legacy ---

test("legacy: MEMORY_ENCRYPTION off ignores all three providers and runs nothing", async () => {
  const marker = join(workDir, "legacy-cmd-marker");
  const filePath = writeKeyFile("legacy.key", b64B);
  process.env.KEYPROBE_MARKER = marker;
  try {
    const { value, stderr } = await captureStderr(() =>
      resolveEncryptionKey(
        env({
          MEMORY_ENCRYPTION_KEY: b64A,
          MEMORY_ENCRYPTION_KEY_FILE: filePath,
          MEMORY_ENCRYPTION_KEY_CMD: nodeCommand(
            "require('node:fs').writeFileSync(process.env.KEYPROBE_MARKER,'ran')"
          ),
        })
      )
    );
    assert.equal(value.key, undefined);
    assert.equal(value.source, undefined);
    assert.equal(value.error, undefined);
    assert.equal(stderr, "", "legacy mode must not warn about ignored providers");
    assert.equal(existsSync(marker), false, "legacy mode must not execute the key command");
  } finally {
    delete process.env.KEYPROBE_MARKER;
  }
});

test("legacy: the server opens a plaintext DB while all three providers are set", () => {
  const dbPath = join(workDir, "legacy-open.db");
  const marker = join(workDir, "legacy-open-marker");
  const filePath = writeKeyFile("legacy-open.key", b64B);
  const childEnv = cleanEnv();
  process.env.KEYPROBE_MARKER = marker;
  try {
    const result = spawnSync(
      NODE,
      [
        "--input-type=module",
        "-e",
        `const app = await import(${JSON.stringify(appUrl)}); app.getDb(); console.log("OPENED"); app.getDb().close();`,
      ],
      {
        cwd: root,
        env: {
          ...childEnv,
          MEMORY_DB_PATH: dbPath,
          MEMORY_ENCRYPTION_KEY: b64A,
          MEMORY_ENCRYPTION_KEY_FILE: filePath,
          MEMORY_ENCRYPTION_KEY_CMD: nodeCommand(
            "require('node:fs').writeFileSync(process.env.KEYPROBE_MARKER,'ran')"
          ),
        },
        encoding: "utf8",
        timeout: 120000,
      }
    );
    assert.equal(result.status, 0, `legacy open failed: ${result.stderr}${result.stdout}`);
    assert.match(result.stdout, /OPENED/);
    assert.equal(
      /\[th-memory-mcp\] encryption:/.test(result.stderr),
      false,
      `legacy open emitted an encryption warning: ${result.stderr}`
    );
    assert.equal(result.stderr.includes(b64A), false, "legacy open leaked a key");
    assert.equal(existsSync(marker), false, "legacy open must not execute the key command");
    const header = readFileSync(dbPath).subarray(0, 16).toString("utf8");
    assert.equal(header, "SQLite format 3\0", "legacy DB must stay plaintext");
  } finally {
    delete process.env.KEYPROBE_MARKER;
  }
});

// ------------------------------------------------------------ call site ---

test("call site: a bad key command fails the server with one line and exit 2", () => {
  const dbPath = join(workDir, "bad-cmd.db");
  const childEnv = cleanEnv();
  {
    const result = spawnSync(
      NODE,
      ["--input-type=module", "-e", `const app = await import(${JSON.stringify(appUrl)}); app.getDb();`],
      {
        cwd: root,
        env: {
          ...childEnv,
          MEMORY_DB_PATH: dbPath,
          MEMORY_ENCRYPTION: "on",
          MEMORY_ENCRYPTION_KEY_CMD: nodeCommand("process.stdout.write('leak-me-not')"),
        },
        encoding: "utf8",
        timeout: 120000,
      }
    );
    assert.equal(result.status, 2, `expected exit 2, got ${result.status}: ${result.stderr}`);
    const lines = boundedLines(result.stderr);
    assert.equal(lines.length, 1, `expected exactly one stderr line, got:\n${result.stderr}`);
    assert.match(
      lines[0],
      /\[th-memory-mcp\] MEMORY_ENCRYPTION=on but MEMORY_ENCRYPTION_KEY_CMD did not produce a valid 32-byte key$/
    );
    assert.equal(result.stderr.includes("leak-me-not"), false);
    assert.ok(lines[0].length <= 200, `fail-fast line is not bounded: ${lines[0].length} chars`);
  }
});

// ------------------------------------------------ no key material, ever ---

test("no key material appears in any warning or error produced above", () => {
  assert.ok(stderrSeen.length > 0, "the stderr capture did not run");
  for (const text of stderrSeen) {
    for (const key of [b64A, b64B, b64C]) {
      assert.equal(text.includes(key), false, `a key leaked into output: ${text}`);
    }
    for (const line of boundedLines(text)) {
      assert.ok(line.length <= 240, `unbounded stderr line (${line.length} chars): ${line}`);
    }
  }
  // The accessor the rest of the app uses agrees with the resolution.
  assert.deepEqual([...getEncryptionKey(env({ MEMORY_ENCRYPTION: "on", MEMORY_ENCRYPTION_KEY: b64A }))], [
    ...keyA,
  ]);
  assert.equal(getEncryptionKey(env({ MEMORY_ENCRYPTION_KEY: b64A })), undefined);
});

// --------------------------------------------------------------- helpers ---

/** process.env with every MEMORY_* variable removed. */
function cleanEnv() {
  const base = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("MEMORY_")) base[name] = value;
  }
  return base;
}
