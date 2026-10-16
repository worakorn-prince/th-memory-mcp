import { runCaptureSyncChecks } from "../scripts/check-capture-sync.mjs";

let failures = 0;
let step = 0;
function report(ok, name, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} ${(step++ + "").padStart(2)} | ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const { checks } = runCaptureSyncChecks();
for (const c of checks) {
  report(c.ok, `capture-sync: ${c.name}`, c.detail);
}
if (checks.length !== 5) {
  report(false, "capture-sync: all checks executed", `ran ${checks.length}/5`);
}

console.log(
  failures === 0 ? "\nCAPTURE-SYNC TEST: ALL PASSED" : `\nCAPTURE-SYNC TEST: ${failures} FAILURE(S)`
);
process.exit(failures === 0 ? 0 : 1);
