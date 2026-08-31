import { recallAtK, precisionAtK } from "../lib/metrics.mjs";

export function runTemporalSuite(mods) {
  const { createMemory, getContext, updateMemoryHandler, reset } = mods;
  const cases = [];
  for (let i = 0; i < 20; i++) {
    cases.push({ i, query: `TLANG${i} language` });
  }

  let currentState = 0;
  let historicalState = 0;
  let supersession = 0;

  for (const c of cases) {
    if (reset) reset();
    const cur = createMemory({
      type: "FACT",
      content: `TLANG${c.i} project currently uses TypeScript for implementation`,
      importance: 0.9,
      confidence: 0.9,
    });
    const past = createMemory({
      type: "FACT",
      content: `TLANG${c.i} project used Python earlier`,
      validUntil: "2020-01-01T00:00:00Z",
      importance: 0.9,
      confidence: 0.9,
    });
    const res = getContext({ query: c.query, limit: 5 });
    if (res.memories.length && res.memories[0].id === cur) currentState++;
    const ctxHist = getContext({ query: c.query, includeHistory: true, limit: 20 });
    if (ctxHist.memories.some((m) => m.id === past)) historicalState++;

    updateMemoryHandler({
      id: cur,
      content: `TLANG${c.i} project migrated to Rust`,
      supersede: true,
    });
    const after = getContext({ query: c.query, limit: 5 });
    const newMatch = after.memories[0]?.content.includes("Rust");
    const noOld = !after.memories.some((m) => m.id === cur);
    if (newMatch && noOld) supersession++;
  }

  return {
    metrics: {
      currentStateAccuracy: currentState / cases.length,
      historicalStateAccuracy: historicalState / cases.length,
      supersessionAccuracy: supersession / cases.length,
    },
    notes: `20 temporal cases via get_context (current/historical/supersession) §7`,
  };
}

export function runConflictSuite(mods) {
  const { createMemory, getContext } = mods;
  let resolution = 0;
  const N = 20;
  for (let i = 0; i < N; i++) {
    createMemory({
      type: "FACT",
      content: `Project ${i} uses PostgreSQL as primary database`,
      importance: 0.5,
      confidence: 0.6,
    });
    const neu = createMemory({
      type: "FACT",
      content: `Project ${i} switched the database to SQLite`,
      importance: 0.95,
      confidence: 0.95,
    });
    const res = getContext({ query: `What database does project ${i} use?`, limit: 5 });
    if (res.memories.length && res.memories[0].content.includes("SQLite")) resolution++;
  }

  let scopeConflict = 0;
  let contamination = 0;
  const M = 20;
  for (let i = 0; i < M; i++) {
    const personal = createMemory({
      type: "FACT",
      content: `Personal project ${i} uses SQLite`,
      projectId: `personal-${i}`,
      importance: 0.8,
    });
    const prod = createMemory({
      type: "FACT",
      content: `Production project ${i} uses PostgreSQL`,
      projectId: `prod-${i}`,
      importance: 0.8,
    });
    const rPers = getContext({
      query: `What database does project ${i} use?`,
      limit: 5,
      projectId: `personal-${i}`,
    });
    const rProd = getContext({
      query: `What database does project ${i} use?`,
      limit: 5,
      projectId: `prod-${i}`,
    });
    if (rPers.memories.length && rPers.memories[0].id === personal) scopeConflict++;
    if (rProd.memories.length && rProd.memories[0].id === prod) scopeConflict++;
    if (rPers.memories.some((m) => m.id === prod)) contamination++;
    if (rProd.memories.some((m) => m.id === personal)) contamination++;
  }

  return {
    metrics: {
      conflictResolutionAccuracy: resolution / N,
      falseConflictScopeAccuracy: scopeConflict / (M * 2),
      crossScopeContaminationRate: contamination / (M * 2),
    },
    notes: `true conflict (${N}) + false conflict by scope (${M}) via get_context §8`,
  };
}

export function runScopeSuite(mods) {
  const { createMemory, getContext } = mods;
  const cases = [];
  const scopes = [
    { name: "USER", make: () => createMemory({ type: "FACT", content: "setting X = user-value", userId: "u1", importance: 0.8 }) },
    { name: "SESSION", make: () => createMemory({ type: "FACT", content: "setting X = session-value", sessionId: "s1", importance: 0.8 }) },
    { name: "PROJECT", make: () => createMemory({ type: "FACT", content: "setting X = project-value", projectId: "p1", importance: 0.8 }) },
    { name: "GLOBAL", make: () => createMemory({ type: "FACT", content: "setting X = global-value", importance: 0.8 }) },
  ];
  for (const s of scopes) cases.push({ scope: s.name, id: s.make() });

  for (let i = 0; i < 40; i++) {
    createMemory({
      type: "FACT",
      content: `unrelated filler memory number ${i} about something else`,
      importance: 0.2,
    });
  }

  let selection = 0;
  let contamination = 0;
  for (const c of cases) {
    const opt = {};
    if (c.scope === "USER") opt.userId = "u1";
    if (c.scope === "SESSION") opt.sessionId = "s1";
    if (c.scope === "PROJECT") opt.projectId = "p1";
    const res = getContext({ query: "setting X", limit: 5, ...opt });
    if (res.memories.length && res.memories[0].id === c.id) selection++;
    const other = cases.filter((x) => x.scope !== c.scope).map((x) => x.id);
    if (res.memories.some((m) => other.includes(m.id))) contamination++;
  }

  return {
    metrics: {
      scopeSelectionAccuracy: selection / cases.length,
      crossScopeContaminationRate: contamination / cases.length,
    },
    notes: `4 scopes (USER/SESSION/PROJECT/GLOBAL) + 40 distractors via get_context §9`,
  };
}
