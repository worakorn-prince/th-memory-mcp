import { buildStorageDataset } from "../datasets/smoke.mjs";

function prefId(r) {
  const m = /preference id=(\d+)/.exec((r?.content?.[0]?.text) || "");
  return m ? Number(m[1]) : null;
}
function lessonId(r) {
  const m = /lesson id=(\d+)/.exec((r?.content?.[0]?.text) || "");
  return m ? Number(m[1]) : null;
}

export async function runStorageSuite(mods) {
  const { rememberHandler, recallHandler, saveLessonHandler, forgetHandler } = mods;
  const ds = buildStorageDataset();

  let inserted = 0;
  let okInsert = 0;
  let roundtrip = 0;
  const storedPrefIds = [];

  for (const p of ds.prefs) {
    inserted++;
    const r = await rememberHandler({
      category: p.category,
      key: p.key,
      value: p.value,
    });
    if (!r.isError) okInsert++;
    const id = prefId(r);
    if (id != null) storedPrefIds.push(id);
    const rec = await recallHandler({ topic: p.key, limit: 5 });
    const text = rec?.content?.[0]?.text || "";
    if (text.includes(p.value)) roundtrip++;
  }

  let okLesson = 0;
  let lessonRoundtrip = 0;
  const storedLessonIds = [];
  for (const l of ds.lessons) {
    const r = await saveLessonHandler({
      situation: l.situation,
      mistake: l.mistake,
      correction: l.correction,
    });
    if (!r.isError) okLesson++;
    const id = lessonId(r);
    if (id != null) storedLessonIds.push(id);
    const rec = await recallHandler({ topic: l.situation, limit: 5 });
    const text = rec?.content?.[0]?.text || "";
    if (text.includes(l.correction)) lessonRoundtrip++;
  }

  const forgetTargets = storedPrefIds.slice(0, 5);
  let forgetOk = 0;
  for (const id of forgetTargets) {
    const before = await recallHandler({
      topic: ds.prefs[storedPrefIds.indexOf(id)].key,
      limit: 5,
    });
    const fr = await forgetHandler({ target_id: id, type: "preference" });
    const after = await recallHandler({
      topic: ds.prefs[storedPrefIds.indexOf(id)].key,
      limit: 5,
    });
    if (!fr.isError && before?.content?.[0]?.text?.includes(ds.prefs[storedPrefIds.indexOf(id)].value) && !(after?.content?.[0]?.text || "").includes(ds.prefs[storedPrefIds.indexOf(id)].value)) {
      forgetOk++;
    }
  }

  const metrics = {
    preferenceInsertSuccess: okInsert / ds.prefs.length,
    preferenceRoundTrip: roundtrip / ds.prefs.length,
    lessonInsertSuccess: okLesson / ds.lessons.length,
    lessonRoundTrip: lessonRoundtrip / ds.lessons.length,
    forgetCorrectness: forgetTargets.length ? forgetOk / forgetTargets.length : 1,
    storageCorrectness: (okInsert + okLesson) / (ds.prefs.length + ds.lessons.length),
  };

  return {
    metrics,
    notes: `inserted ${inserted} prefs + ${ds.lessons.length} lessons into a fresh temp DB`,
  };
}
