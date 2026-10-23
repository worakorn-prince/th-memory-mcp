import { scrubHistoricalSecrets } from "./tools/scrub.js";

const apply = process.argv.includes("--apply");
const report = scrubHistoricalSecrets(apply);

const summary = Object.entries(report.changed)
  .map(([table, count]) => `  - ${table}: ${count}`)
  .join("\n");

console.log(
  `scrub-secrets (${apply ? "APPLY" : "DRY-RUN"}):${
    summary.length > 0 ? `\n${summary}` : " no rows need redaction"
  }`
);
if (!apply && summary.length > 0) {
  console.log("re-run with --apply to rewrite these rows");
}
