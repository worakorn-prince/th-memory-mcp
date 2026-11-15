import { z } from "zod";
import {
  db,
  truncate,
  ok,
  err,
  type ToolResult,
} from "../db/index.js";
import { buildScopeClause } from "../lib/scope.js";
import { resolveUserId } from "../db/repositories/users.js";
import { getEffectiveScope } from "../auth/scope-resolver.js";
import {
  MEMORY_REF_CLOSE,
  MEMORY_REF_GUIDANCE,
  MEMORY_REF_OPEN,
  UNTRUSTED_NOTE,
  UNTRUSTED_TAG,
  isUntrustedMetadata,
  sanitizeMemoryText,
} from "../lib/memory-format.js";

export const profileInput = {
  userId: z
    .string()
    .nullable()
    .optional()
    .describe("Include GLOBAL plus this user's USER-scoped memories"),
  sessionId: z
    .string()
    .nullable()
    .optional()
    .describe("Include GLOBAL plus this session's SESSION-scoped memories"),
  projectId: z
    .string()
    .nullable()
    .optional()
    .describe("Include GLOBAL plus this project's PROJECT-scoped memories"),
};

export interface ProfileScope {
  userId?: string | null;
  sessionId?: string | null;
  projectId?: string | null;
}

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
// Ph-3 enforced variants: preferences/lessons are personal tables, never
// grant-scoped, so a row is visible when it is shared (user_id IS NULL) or owned
// by the bound identity. The legacy statements above stay untouched.
const topPrefsScoped = db.prepare(
  "SELECT category, key, value, confidence FROM preferences WHERE (user_id IS NULL OR user_id = ?) ORDER BY confidence DESC, updated_at DESC LIMIT 15"
);
const recentLessonsScoped = db.prepare(
  "SELECT situation, mistake, correction FROM lessons WHERE (user_id IS NULL OR user_id = ?) ORDER BY created_at DESC, id DESC LIMIT 5"
);
// profile/preferences/lessons tables are global by design. Only the
// auto-projected memories query is scope-filtered (SEC-01); with no scope
// args the clause binds nulls and matches GLOBAL rows only (fail-closed).
const topMemories = db.prepare(
  `SELECT type, content, importance, confidence, metadata
   FROM memories m
   WHERE m.status = 'active'
     AND ${buildScopeClause("m").sql}
   ORDER BY importance * confidence DESC, updated_at DESC LIMIT 15`
);

export function buildProfileText(
  scope: ProfileScope = {},
  personalUid: number | null = null
): string {
  const parts: string[] = [];

  const prof = profileRows.all() as { section: string; content: string }[];
  for (const p of prof) {
    parts.push(`[${p.section}]\n${truncate(p.content, PROFILE_SECTION_MAX)}`);
  }

  const prefs = (
    personalUid === null
      ? topPrefs.all()
      : topPrefsScoped.all(personalUid)
  ) as {
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

  const lessons = (
    personalUid === null
      ? recentLessons.all()
      : recentLessonsScoped.all(personalUid)
  ) as {
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

  // Auto-projection: surface top memories from the unified store (spec §7 / item 7).
  const resolvedUid = scope.userId ? resolveUserId(scope.userId) : null;
  const scopeFilter = buildScopeClause("m", {
    resolvedUid,
    sessionId: scope.sessionId ?? null,
    projectId: scope.projectId ?? null,
  });
  const mems = topMemories.all(scopeFilter.params) as {
    type: string;
    content: string;
    importance: number;
    confidence: number;
    metadata: string | null;
  }[];
  if (mems.length > 0) {
    let block = "[memories]";
    for (const m of mems) {
      // Batch B-2: label untrusted imports (metadata.trusted=false) inline.
      const tag = isUntrustedMetadata(m.metadata)
        ? ` ${UNTRUSTED_TAG} (${UNTRUSTED_NOTE})`
        : "";
      block += `\n- (${m.type} c${m.confidence.toFixed(2)})${tag} ${truncate(m.content, 200)}`;
    }
    parts.push(block);
  }

  // Batch B-2: profile/memory text is reference data, not instructions —
  // wrap with delimiters. Reserve wrapper overhead inside PROFILE_BUDGET so
  // the wrapped output still fits the 3000-char contract.
  const overhead =
    MEMORY_REF_GUIDANCE.length +
    MEMORY_REF_OPEN.length +
    MEMORY_REF_CLOSE.length +
    8;
  const inner = truncate(
    sanitizeMemoryText(parts.join("\n\n")),
    Math.max(0, PROFILE_BUDGET - overhead)
  );
  return `${MEMORY_REF_GUIDANCE}\n${MEMORY_REF_OPEN}\n${inner}\n${MEMORY_REF_CLOSE}`;
}

export async function getProfileHandler(
  args: ProfileScope = {}
): Promise<ToolResult> {
  try {
    const scope = getEffectiveScope();
    // Ph-3: in enforced mode the bound scope replaces the raw args, and ONLY
    // the dimensions the caller actually requested are projected. With no scope
    // args the memory clause binds nulls, keeping the documented GLOBAL-only
    // default (plan §9.2).
    const effective: ProfileScope =
      scope !== null
        ? {
            userId: scope.requested.userId ? scope.userId : undefined,
            sessionId: scope.requested.sessionId ? scope.sessionId : undefined,
            projectId: scope.requested.projectId ? scope.projectId : undefined,
          }
        : args;
    return ok(
      buildProfileText(effective, scope !== null ? (scope.uid ?? null) : null)
    );
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
