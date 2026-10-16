import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(repoRoot, "package.json");

const args = process.argv.slice(2);
const isCheck = args.includes("--check");

function getPackageVersion() {
  const raw = readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw);
  if (!pkg.version) {
    console.error(`[sync-version] package.json missing version field`);
    process.exit(1);
  }
  return String(pkg.version).trim();
}

const targets = [
  {
    file: "README.md",
    label: "Status",
    pattern: /(\*\*Status:\*\*\s*v)\d+\.\d+\.\d+/g,
  },
  {
    file: "README.th.md",
    label: "สถานะ",
    pattern: /(\*\*สถานะ:\*\*\s*v)\d+\.\d+\.\d+/g,
  },
  {
    file: "ARCHITECTURE_v2.md",
    label: "Current",
    pattern: /(\*\*Current:\*\*\s*v)\d+\.\d+\.\d+/g,
    optional: true, // local-only doc, may be absent in CI checkout
  },
  {
    file: "design.md",
    label: "Version",
    pattern: /(\*\*Version:\*\*\s*`package\.json`\s*=\s*`)\d+\.\d+\.\d+/g,
    optional: true, // local-only doc, may be absent in CI checkout
  },
  {
    file: "server.json",
    label: "version",
    pattern: /("version":\s*")\d+\.\d+\.\d+/g,
  },
  {
    file: "src/lib/config.ts",
    label: "VERSION",
    pattern: /(export const VERSION = ")\d+\.\d+\.\d+/g,
  },
];

function readTarget(target) {
  const path = join(repoRoot, target.file);
  let content;
  try {
    content = readFileSync(path, "utf8");
  } catch (e) {
    if (target.optional && e.code === "ENOENT") {
      return null;
    }
    console.error(`[sync-version] cannot read ${target.file}: ${e.message}`);
    process.exit(1);
  }
  const found = [...content.matchAll(target.pattern)].map((m) => m[0].slice(m[1].length));
  if (found.length === 0) {
    console.error(`[sync-version] cannot find ${target.label} version in ${target.file}`);
    process.exit(1);
  }
  return { content, found, path };
}

function formatFound(found) {
  return [...new Set(found)].map((v) => `v${v}`).join(" + ");
}

const pkgVersion = getPackageVersion();
const mismatches = [];
const checked = [];

for (const target of targets) {
  const result = readTarget(target);
  if (!result) continue; // optional target absent (e.g., CI checkout without local-only docs)
  checked.push(target);
  const { content, found, path } = result;
  if (found.some((v) => v !== pkgVersion)) {
    mismatches.push({ target, content, found, path });
  }
}

if (mismatches.length === 0) {
  console.log(
    `[sync-version] ok: package.json (${pkgVersion}) matches ` +
      checked.map((t) => `${t.file} ${t.label} v${pkgVersion}`).join(", ")
  );
  process.exit(0);
}

if (isCheck) {
  for (const { target, found } of mismatches) {
    console.error(
      `[sync-version] version mismatch: ${target.file} ${target.label} = ${formatFound(found)} != package.json ${pkgVersion}`
    );
  }
  console.error("[sync-version] run `node scripts/sync-version.mjs` to sync");
  process.exit(1);
}

for (const { target, content, found, path } of mismatches) {
  const next = content.replace(target.pattern, (_full, prefix) => prefix + pkgVersion);
  if (next === content) {
    console.error(`[sync-version] failed to replace ${target.label} version in ${target.file}`);
    process.exit(1);
  }
  writeFileSync(path, next, "utf8");
  console.log(
    `[sync-version] synced ${target.file} ${target.label}: ${formatFound(found)} -> v${pkgVersion}`
  );
}
