import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3-multiple-ciphers";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const hookPath = join(root, "scripts", "claude-capture.mjs");
const { openEncryptedDB } = await import("../dist/db/encryption.js");

const INTERACTIONS_DDL = `
CREATE TABLE IF NOT EXISTS interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  session_id TEXT,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  meta TEXT
);`;

function cleanEnv(extra = {}) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("MEMORY_")) env[name] = value;
  }
  return { ...env, ...extra };
}

function runHook(dbPath, extraEnv = {}, scriptPath = hookPath) {
  const payload = {
    hook_event_name: "UserPromptSubmit",
    session_id: "claude-hook-session",
    prompt: "Remember that I prefer pnpm",
  };
  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: root,
    env: cleanEnv({ MEMORY_DB_PATH: dbPath, ...extraEnv }),
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 30000,
  });

  assert.equal(result.error, undefined, `hook process error: ${result.error?.message}`);
  assert.equal(
    result.status,
    0,
    `hook must exit 0; status=${result.status}; stderr=${result.stderr}`
  );
  assert.ok(
    result.stderr.length < 4096,
    `hook stderr must stay short; received ${result.stderr.length} characters`
  );

  let output;
  assert.doesNotThrow(() => {
    output = JSON.parse(result.stdout);
  }, `hook stdout must be valid JSON: ${result.stdout}`);
  assert.equal(typeof output, "object");
  assert.notEqual(output, null);
  assert.equal(Array.isArray(output), false);
  return { ...result, output };
}

async function withTempDir(run) {
  const tempDir = mkdtempSync(join(tmpdir(), "th-hook-driver-"));
  try {
    return await run(tempDir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function createEncryptedDb(dbPath, key, kdfIter = 256000) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = openEncryptedDB(dbPath, key, kdfIter);
  db.exec(INTERACTIONS_DDL);
  db.close();
}

function installDriverForTempHook(tempDir) {
  const packageName = "better-sqlite3-multiple-ciphers";
  const source = join(root, "node_modules", packageName);
  const target = join(tempDir, "node_modules", packageName);
  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true });
}

test("static guard: hook uses the declared multiple-ciphers driver", () => {
  const source = readFileSync(hookPath, "utf8");
  const bareImports = [...source.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/g)].map(
    (match) => match[1]
  );
  assert.equal(
    bareImports.includes("better-sqlite3"),
    false,
    "scripts/claude-capture.mjs must not import the undeclared better-sqlite3 package"
  );
  assert.equal(
    bareImports.includes("better-sqlite3-multiple-ciphers"),
    true,
    "scripts/claude-capture.mjs must import better-sqlite3-multiple-ciphers"
  );
  assert.equal(
    /require\(\s*["']better-sqlite3["']\s*\)/.test(source),
    false,
    "scripts/claude-capture.mjs must not require the undeclared better-sqlite3 package"
  );

  const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(
    Object.hasOwn(packageJson.dependencies ?? {}, "better-sqlite3"),
    false,
    "package.json dependencies must not contain better-sqlite3"
  );
  assert.equal(
    typeof packageJson.dependencies?.["better-sqlite3-multiple-ciphers"],
    "string"
  );
});

test("plaintext mode captures into the configured database without behavior changes", async () => {
  await withTempDir(async (tempDir) => {
    const dbPath = join(tempDir, "data", "memory.db");
    const { output, stderr } = runHook(dbPath);

    assert.deepEqual(output, {});
    assert.equal(stderr, "");
    assert.equal(existsSync(dbPath), true);

    const db = new Database(dbPath);
    try {
      assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
      assert.equal(db.pragma("busy_timeout", { simple: true }), 5000);
      assert.deepEqual(
        db.prepare("PRAGMA table_info(interactions)").all().map((row) => row.name),
        ["id", "ts", "session_id", "kind", "content", "meta"]
      );
      const row = db
        .prepare(
          "SELECT session_id, kind, content, meta FROM interactions ORDER BY id DESC LIMIT 1"
        )
        .get();
      assert.equal(row.session_id, "claude-hook-session");
      assert.equal(row.kind, "prompt");
      assert.equal(row.content, "Remember that I prefer pnpm");
      assert.equal(row.meta, "null");
    } finally {
      db.close();
    }
  });
});

test("plaintext mode captures without a dist build", async () => {
  await withTempDir(async (tempDir) => {
    const hooksDir = join(tempDir, "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const copiedHook = join(hooksDir, "claude-capture.mjs");
    copyFileSync(hookPath, copiedHook);
    installDriverForTempHook(tempDir);

    assert.equal(existsSync(join(tempDir, "dist")), false);
    assert.equal(existsSync(join(hooksDir, "dist")), false);

    const dbPath = join(tempDir, "data", "memory.db");
    const { output, stderr } = runHook(dbPath, {}, copiedHook);

    assert.deepEqual(output, {});
    assert.equal(stderr, "");
    assert.equal(existsSync(dbPath), true);

    const db = new Database(dbPath);
    try {
      const row = db
        .prepare(
          "SELECT session_id, kind, content FROM interactions ORDER BY id DESC LIMIT 1"
        )
        .get();
      assert.equal(row.session_id, "claude-hook-session");
      assert.equal(row.kind, "prompt");
      assert.equal(row.content, "Remember that I prefer pnpm");
    } finally {
      db.close();
    }
  });
});

test("encrypted mode without a dist build fails closed without creating a database", async () => {
  await withTempDir(async (tempDir) => {
    const hooksDir = join(tempDir, "hooks");
    mkdirSync(hooksDir, { recursive: true });
    const copiedHook = join(hooksDir, "claude-capture.mjs");
    copyFileSync(hookPath, copiedHook);
    installDriverForTempHook(tempDir);

    assert.equal(existsSync(join(tempDir, "dist")), false);
    assert.equal(existsSync(join(hooksDir, "dist")), false);

    const dbPath = join(tempDir, "data", "memory.db");
    const logPath = join(tempDir, "data", "hook-errors.log");
    const key = new Uint8Array(randomBytes(32));
    const { output } = runHook(
      dbPath,
      {
        MEMORY_ENCRYPTION: "on",
        MEMORY_ENCRYPTION_KEY: Buffer.from(key).toString("base64"),
      },
      copiedHook
    );

    assert.deepEqual(output, {});
    assert.equal(existsSync(dbPath), false, "missing dist must not create a plaintext DB");
    assert.equal(existsSync(logPath), true);
  });
});

test("encryption mode switch fails closed and preserves off-list plaintext semantics", async () => {
  await withTempDir(async (tempDir) => {
    for (const [index, value] of ["yes", "1"].entries()) {
      const caseDir = join(tempDir, `on-${index}`);
      const dbPath = join(caseDir, "memory.db");
      const logPath = join(caseDir, "hook-errors.log");

      const { output } = runHook(dbPath, { MEMORY_ENCRYPTION: value });

      assert.deepEqual(output, {});
      assert.equal(
        existsSync(dbPath),
        false,
        `MEMORY_ENCRYPTION=${value} must not create a plaintext DB`
      );
      assert.equal(existsSync(logPath), true);
      assert.match(readFileSync(logPath, "utf8"), /MEMORY_ENCRYPTION=on/);
    }

    const offValues = [undefined, "", "off", "0", "false", "no", "n", "OFF", " false "];
    for (const [index, value] of offValues.entries()) {
      const caseDir = join(tempDir, `off-${index}`);
      const dbPath = join(caseDir, "memory.db");
      const env = value === undefined ? {} : { MEMORY_ENCRYPTION: value };

      const { output } = runHook(dbPath, env);

      assert.deepEqual(output, {});
      assert.equal(existsSync(dbPath), true);
      const db = new Database(dbPath);
      try {
        assert.equal(
          db.prepare("SELECT count(*) AS count FROM interactions").get().count,
          1
        );
      } finally {
        db.close();
      }
    }
  });
});

test("encrypted mode captures into the encrypted database with the correct key", async () => {
  await withTempDir(async (tempDir) => {
    const dbPath = join(tempDir, "data", "memory.db");
    const key = new Uint8Array(randomBytes(32));
    const keyBase64 = Buffer.from(key).toString("base64");
    createEncryptedDb(dbPath, key);

    const { output } = runHook(dbPath, {
      MEMORY_ENCRYPTION: "on",
      MEMORY_ENCRYPTION_KEY: keyBase64,
    });

    assert.deepEqual(output, {});
    const db = openEncryptedDB(dbPath, key, 256000);
    try {
      const row = db
        .prepare(
          "SELECT session_id, kind, content FROM interactions ORDER BY id DESC LIMIT 1"
        )
        .get();
      assert.equal(row.session_id, "claude-hook-session");
      assert.equal(row.kind, "prompt");
      assert.equal(row.content, "Remember that I prefer pnpm");
    } finally {
      db.close();
    }
  });
});

test("MEMORY_ENCRYPTION_KEY_FILE captures into the encrypted database", async () => {
  await withTempDir(async (tempDir) => {
    const dbPath = join(tempDir, "data", "memory.db");
    const keyFile = join(tempDir, "encryption.key");
    const key = new Uint8Array(randomBytes(32));
    const keyBase64 = Buffer.from(key).toString("base64");
    writeFileSync(keyFile, `${keyBase64}\n`, { encoding: "utf8", mode: 0o600 });
    createEncryptedDb(dbPath, key);

    const { output } = runHook(dbPath, {
      MEMORY_ENCRYPTION: "on",
      MEMORY_ENCRYPTION_KEY_FILE: keyFile,
    });

    assert.deepEqual(output, {});
    const db = openEncryptedDB(dbPath, key, 256000);
    try {
      const row = db
        .prepare(
          "SELECT session_id, kind, content FROM interactions ORDER BY id DESC LIMIT 1"
        )
        .get();
      assert.equal(row.session_id, "claude-hook-session");
      assert.equal(row.kind, "prompt");
      assert.equal(row.content, "Remember that I prefer pnpm");
    } finally {
      db.close();
    }
  });
});

test("MEMORY_ENCRYPTION_KEY_CMD captures into the encrypted database", async () => {
  await withTempDir(async (tempDir) => {
    const dbPath = join(tempDir, "data", "memory.db");
    const key = new Uint8Array(randomBytes(32));
    const keyBase64 = Buffer.from(key).toString("base64");
    const keyCommand = `"${process.execPath}" -e "process.stdout.write(process.argv[1])" ${keyBase64}`;
    createEncryptedDb(dbPath, key);

    const { output } = runHook(dbPath, {
      MEMORY_ENCRYPTION: "on",
      MEMORY_ENCRYPTION_KEY_CMD: keyCommand,
    });

    assert.deepEqual(output, {});
    const db = openEncryptedDB(dbPath, key, 256000);
    try {
      const row = db
        .prepare(
          "SELECT session_id, kind, content FROM interactions ORDER BY id DESC LIMIT 1"
        )
        .get();
      assert.equal(row.session_id, "claude-hook-session");
      assert.equal(row.kind, "prompt");
      assert.equal(row.content, "Remember that I prefer pnpm");
    } finally {
      db.close();
    }
  });
});

test("custom MEMORY_ENCRYPTION_KDF_ITER opens the matching encrypted database", async () => {
  await withTempDir(async (tempDir) => {
    const dbPath = join(tempDir, "data", "memory.db");
    const key = new Uint8Array(randomBytes(32));
    const keyBase64 = Buffer.from(key).toString("base64");
    const kdfIter = 12345;
    createEncryptedDb(dbPath, key, kdfIter);

    const { output } = runHook(dbPath, {
      MEMORY_ENCRYPTION: "on",
      MEMORY_ENCRYPTION_KEY: keyBase64,
      MEMORY_ENCRYPTION_KDF_ITER: String(kdfIter),
    });

    assert.deepEqual(output, {});
    const db = openEncryptedDB(dbPath, key, kdfIter);
    try {
      const row = db
        .prepare(
          "SELECT session_id, kind, content FROM interactions ORDER BY id DESC LIMIT 1"
        )
        .get();
      assert.equal(row.session_id, "claude-hook-session");
      assert.equal(row.kind, "prompt");
      assert.equal(row.content, "Remember that I prefer pnpm");
    } finally {
      db.close();
    }
  });
});

test("encrypted mode without a key exits cleanly and logs without plaintext fallback", async () => {
  await withTempDir(async (tempDir) => {
    const dbPath = join(tempDir, "data", "memory.db");
    const logPath = join(tempDir, "data", "hook-errors.log");

    const { output } = runHook(dbPath, { MEMORY_ENCRYPTION: "on" });

    assert.deepEqual(output, {});
    assert.equal(existsSync(dbPath), false, "missing-key mode must not create a plaintext DB");
    assert.equal(existsSync(logPath), true);
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /MEMORY_ENCRYPTION=on/);
    assert.match(log, /MEMORY_ENCRYPTION_KEY_FILE/);
    assert.match(log, /MEMORY_ENCRYPTION_KEY_CMD/);
  });
});

test("encrypted mode with the wrong key logs without leaking key representations", async () => {
  await withTempDir(async (tempDir) => {
    const dbPath = join(tempDir, "data", "memory.db");
    const logPath = join(tempDir, "data", "hook-errors.log");
    const key = new Uint8Array(randomBytes(32));
    const wrongKey = new Uint8Array(randomBytes(32));
    const rawKeyValue = Buffer.from(wrongKey).toString("base64");
    const base64Key = Buffer.from(wrongKey).toString("base64");
    const hexKey = Buffer.from(wrongKey).toString("hex");
    createEncryptedDb(dbPath, key);

    const { output } = runHook(dbPath, {
      MEMORY_ENCRYPTION: "on",
      MEMORY_ENCRYPTION_KEY: rawKeyValue,
    });

    assert.deepEqual(output, {});
    assert.equal(existsSync(logPath), true);
    const log = readFileSync(logPath, "utf8");
    assert.match(log, /wrong key or corrupted file/i);
    assert.equal(log.includes(rawKeyValue), false);
    assert.equal(log.includes(base64Key), false);
    assert.equal(log.includes(hexKey), false);

    const db = openEncryptedDB(dbPath, key, 256000);
    try {
      assert.equal(
        db.prepare("SELECT count(*) AS count FROM interactions").get().count,
        0
      );
    } finally {
      db.close();
    }
  });
});

test("encrypted mode refuses a plaintext database without triggering migration", async () => {
  await withTempDir(async (tempDir) => {
    const dbPath = join(tempDir, "data", "memory.db");
    const logPath = join(tempDir, "data", "hook-errors.log");
    const key = new Uint8Array(randomBytes(32));
    mkdirSync(dirname(dbPath), { recursive: true });
    const plaintext = new Database(dbPath);
    plaintext.exec(INTERACTIONS_DDL);
    plaintext.close();

    const { output } = runHook(dbPath, {
      MEMORY_ENCRYPTION: "on",
      MEMORY_ENCRYPTION_KEY: Buffer.from(key).toString("base64"),
    });

    assert.deepEqual(output, {});
    assert.equal(existsSync(logPath), true);
    assert.match(readFileSync(logPath, "utf8"), /plaintext database/i);

    const db = new Database(dbPath);
    try {
      assert.equal(
        db.prepare("SELECT count(*) AS count FROM interactions").get().count,
        0
      );
    } finally {
      db.close();
    }
  });
});
