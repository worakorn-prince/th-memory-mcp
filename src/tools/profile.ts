import {
  db,
  truncate,
  ok,
  err,
  type ToolResult,
} from "../db/index.js";

export const PROFILE_BUDGET = 3000;
const PROFILE_SECTION_MAX = 400;
const PREF_CATEGORY_MAX = 30;
const PREF_VALUE_MAX = 120;
const LESSON_SITUATION_MAX = 100;
const LESSON_MISTAKE_MAX = 120;
const LESSON_CORRECTION_MAX = 150;

const profileRows = db.prepare("SELECT section, content FROM profile");
const topPrefs = db.prepare(
  "SELECT category, key, value, confidence FROM preferences ORDER BY confidence DESC, updated_at DESC LIMIT 15"
);
const recentLessons = db.prepare(
  "SELECT situation, mistake, correction FROM lessons ORDER BY created_at DESC, id DESC LIMIT 5"
);

export function buildProfileText(): string {
  const parts: string[] = [];

  const prof = profileRows.all() as { section: string; content: string }[];
  for (const p of prof) {
    parts.push(`[${p.section}]\n${truncate(p.content, PROFILE_SECTION_MAX)}`);
  }

  const prefs = topPrefs.all() as {
    category: string;
    key: string;
    value: string;
    confidence: number;
  }[];
  if (prefs.length > 0) {
    let block = "[preferences]";
    for (const p of prefs) {
      block += `\n- (${p.confidence.toFixed(2)}) ${truncate(p.category, PREF_CATEGORY_MAX)}/${p.key}: ${truncate(p.value, PREF_VALUE_MAX)}`;
    }
    parts.push(block);
  } else {
    parts.push("[preferences]\n(none yet)");
  }

  const lessons = recentLessons.all() as {
    situation: string;
    mistake: string;
    correction: string;
  }[];
  if (lessons.length > 0) {
    let block = "[lessons]";
    for (const l of lessons) {
      block += `\n- ${truncate(l.situation, LESSON_SITUATION_MAX)} | mistake: ${truncate(l.mistake, LESSON_MISTAKE_MAX)} -> ${truncate(l.correction, LESSON_CORRECTION_MAX)}`;
    }
    parts.push(block);
  }

  return truncate(parts.join("\n\n"), PROFILE_BUDGET);
}

export async function getProfileHandler(): Promise<ToolResult> {
  try {
    return ok(buildProfileText());
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
