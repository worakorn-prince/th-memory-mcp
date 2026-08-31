import { mkdirSync, writeFileSync, statSync, statfsSync } from "node:fs";
import { join, dirname } from "node:path";
import { z } from "zod";
import {
  db,
  DB_PATH,
  nowISO,
  truncate,
  ok,
  err,
  type ToolResult,
} from "../db/index.js";
import { VERSION, EXPORTS_DIRNAME } from "../lib/config.js";
import type { InteractionRow } from "../lib/capture-core.js";

export const exportMemoryInput = {
  includeInteractions: z
    .boolean()
    .default(false)
    .describe("Include raw interaction rows in the export (file gets bigger)"),
  filename: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Output file name inside data/exports/ (only A-Z a-z 0-9 . _ - allowed, must end with .json). Defaults to memory-export-YYYYMMDD-HHmmss.json"
    ),
};

const PREVIEW_BUDGET = 500;
const EXPORT_DIR = join(dirname(DB_PATH), EXPORTS_DIRNAME);

interface PreferenceRow {
  id: number;
  category: string;
  key: string;
  value: string;
  confidence: number;
  source: string;
  updated_at: string;
}

interface LessonRow {
  id: number;
  situation: string;
  mistake: string;
  correction: string;
  created_at: string;
}

interface ProfileRow {
  section: string;
  content: string;
  updated_at: string;
}

const selectPrefs = db.prepare(
  "SELECT id, category, key, value, confidence, source, updated_at FROM preferences ORDER BY id"
);
const selectLessons = db.prepare(
  "SELECT id, situation, mistake, correction, created_at FROM lessons ORDER BY id"
);
const selectProfile = db.prepare(
  "SELECT section, content, updated_at FROM profile ORDER BY section"
);
const selectInteractions = db.prepare(
  "SELECT id, ts, session_id, kind, content, meta FROM interactions ORDER BY id"
);

function timestamp(d = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

const WINDOWS_RESERVED = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

function sanitizeFilename(name: string): string | null {
  if (name.includes("..")) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return null;
  if (!name.endsWith(".json")) return null;
  const stem = name.slice(0, -".json".length);
  if (stem.length === 0) return null;
  if (WINDOWS_RESERVED.has(stem.toUpperCase())) return null;
  return name;
}

export async function exportMemoryHandler(args: {
  includeInteractions?: boolean;
  filename?: string;
}): Promise<ToolResult> {
  try {
    const includeInteractions = args.includeInteractions ?? false;

    let filename: string;
    if (args.filename !== undefined) {
      const clean = sanitizeFilename(args.filename);
      if (!clean) {
        return err(
          `invalid filename "${truncate(args.filename, 100)}": only [A-Za-z0-9._-] allowed, no "..", must end with .json`
        );
      }
      filename = clean;
    } else {
      filename = `memory-export-${timestamp()}.json`;
    }

    const interactionsIncluded = includeInteractions
      ? (selectInteractions.all() as InteractionRow[])
      : undefined;

    const payload = {
      exported_at: nowISO(),
      version: VERSION,
      preferences: selectPrefs.all() as PreferenceRow[],
      lessons: selectLessons.all() as LessonRow[],
      profile: selectProfile.all() as ProfileRow[],
      interactions: {
        included: includeInteractions,
        count: interactionsIncluded ? interactionsIncluded.length : 0,
        ...(interactionsIncluded ? { rows: interactionsIncluded } : {}),
      },
    };

    const json = JSON.stringify(payload, null, 2);

    mkdirSync(EXPORT_DIR, { recursive: true });
    try {
      const stats = statfsSync(EXPORT_DIR);
      if (json.length > stats.bavail * stats.bsize * 0.9)
        return err("insufficient disk space for export");
    } catch {}
    const filePath = join(EXPORT_DIR, filename);
    writeFileSync(filePath, json, "utf8");
    const size = statSync(filePath).size;

    return ok(
      `exported: ${filePath}\nsize: ${size} bytes\npreview: ${truncate(json, PREVIEW_BUDGET)}`
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
