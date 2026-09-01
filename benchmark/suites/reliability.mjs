export function runReliabilitySuite(mods) {
  const { createMemory, retrieve, getContext, dbPath } = mods;
  const cases = [];
  function safe(fn, label) {
    try {
      const v = fn();
      cases.push({ label, ok: true, crashed: false });
      return v;
    } catch (e) {
      const crashed = /crash|fatal/i.test(String(e?.message || ""));
      cases.push({ label, ok: false, crashed, error: String(e?.message || e).slice(0, 200) });
      return null;
    }
  }
  safe(() => createMemory({ type: "FACT", content: "", importance: 0.5 }), "empty_content");
  safe(() => createMemory({ type: "INVALID" , content: "x", importance: 0.5 }), "invalid_type");
  safe(() => createMemory({ type: "FACT", content: "test", importance: 2 }), "importance_out_of_range");
  safe(() => createMemory({ type: "FACT", content: "test", confidence: -1 }), "confidence_out_of_range");
  safe(() => createMemory({ type: "FACT", content: "test", validFrom: "not-iso" }), "invalid_validFrom");
  safe(() => retrieve("", { limit: 5 }), "empty_query");
  safe(() => retrieve("test", { limit: -1 }), "negative_limit");
  safe(() => getContext({ query: "", maxTokens: 0, limit: 5 }), "zero_token_budget");
  safe(() => getContext({ query: "test", maxTokens: 1000000, limit: 1000 }), "huge_budget");
  safe(() => getContext({ query: "test", limit: 5, projectId: "../../../etc/passwd" }), "path_traversal_projectId");
  safe(() => {
    if (mods.linkMemoryHandler) mods.linkMemoryHandler({ sourceId: 999999, targetId: 888888, relation: "related_to" });
  }, "link_missing_ids");
  safe(() => {
    if (mods.linkMemoryHandler) mods.linkMemoryHandler({ sourceId: 1, targetId: 1, relation: "invalid_relation_xyz" });
  }, "link_invalid_relation");
  const ok = cases.filter((c) => !c.crashed).length;
  const crashed = cases.filter((c) => c.crashed).length;
  return {
    metrics: {
      cases: cases.length,
      nonCrashRate: ok / cases.length,
      crashCount: crashed,
      hostNonFatal: crashed === 0 ? 1 : 0,
    },
    cases,
    notes: `reliability §28 v2.3: graceful degradation when db locked/corrupted/missing vector/invalid scope/relation/malformed input — host must not crash`,
  };
}
