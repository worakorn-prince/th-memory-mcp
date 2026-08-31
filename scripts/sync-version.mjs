import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = join(repoRoot, "package.json");
const readmePath = join(repoRoot, "README.md");

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

function getReadmeStatusVersion(readme) {
  const m = readme.match(/\*\*Status:\*\*\s*v(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

const pkgVersion = getPackageVersion();
let readme;
try {
  readme = readFileSync(readmePath, "utf8");
} catch (e) {
  console.error(`[sync-version] cannot read README.md: ${e.message}`);
  process.exit(1);
}

const readmeVersion = getReadmeStatusVersion(readme);

if (!readmeVersion) {
  console.error("[sync-version] cannot find Status line with version in README.md (expected **Status:** vX.Y.Z)");
  process.exit(1);
}

if (readmeVersion === pkgVersion) {
  console.log(`[sync-version] ok: package.json (${pkgVersion}) matches README.md Status v${readmeVersion}`);
  process.exit(0);
}

if (isCheck) {
  console.error(`[sync-version] version mismatch: package.json=${pkgVersion} README Status=v${readmeVersion}`);
  console.error("[sync-version] run `node scripts/sync-version.mjs` to sync");
  process.exit(1);
}

const next = readme.replace(
  /(\*\*Status:\*\*\s*v)\d+\.\d+\.\d+/,
  `$1${pkgVersion}`
);

if (next === readme) {
  console.error("[sync-version] failed to replace Status version in README.md");
  process.exit(1);
}

writeFileSync(readmePath, next, "utf8");
console.log(`[sync-version] synced README.md Status: v${readmeVersion} -> v${pkgVersion}`);
