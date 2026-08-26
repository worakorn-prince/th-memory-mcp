import { statSync } from "node:fs";
import {
  db,
  DB_PATH,
  truncate,
  ok,
  err,
  type ToolResult,
} from "../db.js";
import { CAPTURE_KINDS } from "../lib/capture-core.js";

export const STATS_BUDGET = 1500;

const kindCounts = db.prepare(
  "SELECT kind, COUNT(*) AS n FROM interactions GROUP BY kind"
);
const prefCount = db.prepare("SELECT COUNT(*) AS n FROM preferences");
const lessonCount = db.prepare("SELECT COUNT(*) AS n FROM lessons");
const interactionRange = db.prepare(
  "SELECT MIN(ts) AS oldest, MAX(ts) AS newest FROM interactions"
);
const profileSections = db.prepare(
  "SELECT section, updated_at FROM profile ORDER BY section"
);

export async function memoryStatsHandler(): Promise<ToolResult> {
  try {
    const lines: string[] = [];

    const kinds = kindCounts.all() as { kind: string; n: number }[];
    const byKind = new Map(kinds.map((k) => [k.kind, k.n]));
    const total = kinds.reduce((s, k) => s + k.n, 0);
    const known: string[] = [...CAPTURE_KINDS];
    const kindText =
      known.map((k) => `${k}=${byKind.get(k) ?? 0}`).join(", ") +
      kinds
        .filter((k) => !known.includes(k.kind))
        .map((k) => `, ${k.kind}=${k.n}`)
        .join("");
    lines.push(`interactions: ${total} total (${kindText})`);

    let dbSize = -1;
    try {
      dbSize = statSync(DB_PATH).size;
    } catch {}
    lines.push(
      `db file: ${DB_PATH}${dbSize >= 0 ? ` (${dbSize} bytes)` : " (not found)"}`
    );

    const range = interactionRange.get() as {
      oldest: string | null;
      newest: string | null;
    };
    if (range.oldest && range.newest) {
      lines.push(`oldest interaction: ${range.oldest}`);
      lines.push(`newest interaction: ${range.newest}`);
    }

    lines.push(`preferences: ${(prefCount.get() as { n: number }).n}`);
    lines.push(`lessons: ${(lessonCount.get() as { n: number }).n}`);

    const prof = profileSections.all() as {
      section: string;
      updated_at: string;
    }[];
    if (prof.length > 0) {
      const latest = prof.reduce((a, b) =>
        a.updated_at > b.updated_at ? a : b
      );
      lines.push(
        `profile sections: ${prof.map((p) => p.section).join(", ")}`
      );
      lines.push(`profile latest update: ${latest.updated_at}`);
    } else {
      lines.push("profile sections: (none)");
    }

    return ok(truncate(lines.join("\n"), STATS_BUDGET));
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
