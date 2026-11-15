import { statSync } from "node:fs";
import {
  db,
  DB_PATH,
  truncate,
  ok,
  err,
  type ToolResult,
} from "../db/index.js";
import { CAPTURE_KINDS } from "../lib/capture-core.js";
import { getIdentity } from "../auth/identity.js";
import { hasRole } from "../auth/policy.js";
import { getEffectiveScope } from "../auth/scope-resolver.js";

export const STATS_BUDGET = 1500;

const kindCounts = db.prepare(
  "SELECT kind, COUNT(*) AS n FROM interactions GROUP BY kind"
);
const prefCount = db.prepare("SELECT COUNT(*) AS n FROM preferences");
const lessonCount = db.prepare("SELECT COUNT(*) AS n FROM lessons");
const interactionRange = db.prepare(
  "SELECT MIN(ts) AS oldest, MAX(ts) AS newest FROM interactions"
);
// Ph-3 enforced variants: count only rows the identity may read. Interactions
// are bounded by user_id (NULL rows owner/admin only); preferences/lessons are
// shared (NULL) or own. profile sections stay shared (design §5 / Q2). The
// legacy statements above are untouched, so the output format never changes.
const kindCountsScoped = db.prepare(
  "SELECT kind, COUNT(*) AS n FROM interactions WHERE (user_id = ? OR (? = 1 AND user_id IS NULL)) GROUP BY kind"
);
const prefCountScoped = db.prepare(
  "SELECT COUNT(*) AS n FROM preferences WHERE (user_id IS NULL OR user_id = ?)"
);
const lessonCountScoped = db.prepare(
  "SELECT COUNT(*) AS n FROM lessons WHERE (user_id IS NULL OR user_id = ?)"
);
const interactionRangeScoped = db.prepare(
  "SELECT MIN(ts) AS oldest, MAX(ts) AS newest FROM interactions WHERE (user_id = ? OR (? = 1 AND user_id IS NULL))"
);
const profileSections = db.prepare(
  "SELECT section, updated_at FROM profile ORDER BY section"
);

export async function memoryStatsHandler(): Promise<ToolResult> {
  try {
    const lines: string[] = [];
    const scope = getEffectiveScope();
    const uid = scope !== null ? (scope.uid ?? -1) : -1;
    const ownerFlag =
      scope !== null ? (hasRole(getIdentity(), "owner") ? 1 : 0) : 0;

    const kinds = (
      scope === null
        ? kindCounts.all()
        : kindCountsScoped.all(uid, ownerFlag)
    ) as { kind: string; n: number }[];
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

    const range = (
      scope === null
        ? interactionRange.get()
        : interactionRangeScoped.get(uid, ownerFlag)
    ) as {
      oldest: string | null;
      newest: string | null;
    };
    if (range.oldest && range.newest) {
      lines.push(`oldest interaction: ${range.oldest}`);
      lines.push(`newest interaction: ${range.newest}`);
    }

    lines.push(
      `preferences: ${((scope === null ? prefCount.get() : prefCountScoped.get(uid)) as { n: number }).n}`
    );
    lines.push(
      `lessons: ${((scope === null ? lessonCount.get() : lessonCountScoped.get(uid)) as { n: number }).n}`
    );

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
