import type { ImportCounts } from "./types.js";

export function validateAux(
  exportPrefs: unknown,
  exportLessons: unknown,
  exportProfile: unknown,
  hasAux: boolean,
  state: ImportCounts
): {
  validPrefs: Array<Record<string, unknown>>;
  validLessons: Array<Record<string, unknown>>;
  validProfiles: Array<Record<string, unknown>>;
} {
  // Phase-1 validation for prefs/lessons/profile (no writes yet).
  const prefArr = Array.isArray(exportPrefs) ? (exportPrefs as Array<Record<string, unknown>>) : [];
  const lessonArr = Array.isArray(exportLessons) ? (exportLessons as Array<Record<string, unknown>>) : [];
  const profileArr = Array.isArray(exportProfile) ? (exportProfile as Array<Record<string, unknown>>) : [];
  const validCat = new Set(["work_style", "coding_pref", "language", "domain", "other"]);
  const validPrefs: Array<Record<string, unknown>> = [];
  const validLessons: Array<Record<string, unknown>> = [];
  const validProfiles: Array<Record<string, unknown>> = [];
  if (hasAux) {
    for (const p of prefArr) {
      if (
        !p ||
        typeof p.category !== "string" ||
        !validCat.has(p.category) ||
        typeof p.key !== "string" ||
        (p.key as string).length === 0 ||
        (p.key as string).length > 200 ||
        typeof p.value !== "string" ||
        (p.value as string).length === 0 ||
        (p.value as string).length > 2000 ||
        (p.confidence != null && (typeof p.confidence !== "number" || (p.confidence as number) < 0 || (p.confidence as number) > 1))
      ) {
        state.prefInvalid++;
        continue;
      }
      state.prefOk++;
      validPrefs.push(p);
    }
    for (const l of lessonArr) {
      if (
        !l ||
        typeof l.situation !== "string" ||
        (l.situation as string).length === 0 ||
        (l.situation as string).length > 1000 ||
        typeof l.mistake !== "string" ||
        (l.mistake as string).length === 0 ||
        (l.mistake as string).length > 1000 ||
        typeof l.correction !== "string" ||
        (l.correction as string).length === 0 ||
        (l.correction as string).length > 1000
      ) {
        state.lessonInvalid++;
        continue;
      }
      state.lessonOk++;
      validLessons.push(l);
    }
    for (const pr of profileArr) {
      if (!pr || typeof pr.section !== "string" || (pr.section as string).length === 0 || typeof pr.content !== "string" || (pr.content as string).length === 0) continue;
      state.profileOk++;
      validProfiles.push(pr);
    }
  }
  return { validPrefs, validLessons, validProfiles };
}
