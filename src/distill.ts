// distill CLI: summarize interactions -> profile sections + prune old rows.
// CLI script (NOT a stdio server) — console output is allowed here.
import { pathToFileURL } from "node:url";
import DatabaseCtor from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { DEFAULT_DB_PATH } from "./lib/config.js";
import {
  computeStats,
  formatProfileSections,
  type DistillRow,
  type DistillStats,
} from "./lib/distill-core.js";

type DbInstance = BetterSqlite3.Database;

const DEFAULT_RETENTION_DAYS = 30;
const MS_PER_DAY = 86_400_000;

const UPSERT_PROFILE_SQL = `
INSERT INTO profile (section, content, updated_at) VALUES (?, ?, ?)
ON CONFLICT(section) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at`;

export interface DistillSummary {
  stats: DistillStats;
  updatedSections: string[];
  pruned: number;
  cutoff: string;
}

export function retentionCutoff(now: Date = new Date()): string {
  const daysRaw = process.env.RETENTION_DAYS;
  const parsed = Number(daysRaw);
  const days =
    Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETENTION_DAYS;
  return new Date(now.getTime() - days * MS_PER_DAY).toISOString();
}

export function runDistill(db: DbInstance): DistillSummary {
  const rows = db
    .prepare("SELECT kind, content, meta, ts FROM interactions")
    .all() as unknown as DistillRow[];

  const stats = computeStats(rows);
  const sections = formatProfileSections(stats);
  const updated_at = new Date().toISOString();

  const upsert = db.prepare(UPSERT_PROFILE_SQL);
  const updatedSections: string[] = [];
  for (const [section, content] of Object.entries(sections)) {
    upsert.run(section, content, updated_at);
    updatedSections.push(section);
  }

  const cutoff = retentionCutoff();
  const pruned = db.prepare("DELETE FROM interactions WHERE ts < ?").run(cutoff)
    .changes;

  return { stats, updatedSections, pruned, cutoff };
}

function main(): number {
  let db: DbInstance | null = null;
  try {
    db = new DatabaseCtor(DEFAULT_DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    const summary = runDistill(db);
    console.error(
      `[distill] prompts=${summary.stats.totalPrompts} days=${summary.stats.promptDays} ` +
        `tools=${summary.stats.topTools.length} dirs=${summary.stats.topDirs.length} ` +
        `keywords=${summary.stats.topKeywords.length}`
    );
    console.error(
      `[distill] profile sections updated: ${summary.updatedSections.join(", ")}`
    );
    console.error(
      `[distill] pruned ${summary.pruned} interaction(s) older than ${summary.cutoff}`
    );
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    try {
      console.error(`[distill] failed: ${msg}`);
    } catch {}
    return 1;
  } finally {
    try {
      if (db) db.close();
    } catch {}
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
