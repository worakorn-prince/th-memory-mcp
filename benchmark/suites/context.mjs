import { tokenEstimate, mean } from "../lib/metrics.mjs";

const est = (s) => Math.ceil((s?.length ?? 0) / 4) + 8;

export function runContextSuite(mods) {
  const { createMemory, getContext } = mods;
  const critical = [];
  for (let i = 0; i < 12; i++) {
    critical.push(
      createMemory({
        type: "FACT",
        content: `deployment config critical rule ${i}: set timeout to ${i + 1}00s and retry ${i + 1} times`,
        importance: 0.95,
        confidence: 0.95,
      })
    );
  }
  for (let i = 0; i < 60; i++) {
    createMemory({
      type: "FACT",
      content: `unrelated trivia item number ${i} about a different subject area`,
      importance: 0.2,
      confidence: 0.3,
    });
  }
  const criticalSet = new Set(critical);

  const budgets = [128, 256, 512, 1024, 2048, 4096, 8192];
  const metrics = {};
  for (const b of budgets) {
    const res = getContext({
      query: "deployment config critical rules",
      maxTokens: b,
      limit: 50,
    });
    const ids = res.memories.map((m) => m.id);
    const relevant = ids.filter((id) => criticalSet.has(id));
    const critTokens = relevant.reduce((a, id) => {
      const m = res.memories.find((x) => x.id === id);
      return a + est(m.content);
    }, 0);
    const coverage = relevant.length / criticalSet.size;
    const relevantRatio = res.tokenEstimate ? critTokens / res.tokenEstimate : 0;
    const noise = 1 - relevantRatio;
    const ctxRelevance = res.memories.length
      ? relevant.length / res.memories.length
      : 0;
    metrics[`budget_${b}`] = {
      criticalCoverage: coverage,
      relevantTokenRatio: relevantRatio,
      noiseRatio: noise,
      contextRelevance: ctxRelevance,
      infoDensity: res.tokenEstimate
        ? relevant.length / (res.tokenEstimate / 1000)
        : 0,
      tokensUsed: res.tokenEstimate,
      truncated: res.truncated,
      accuracyPerToken: res.tokenEstimate ? coverage / res.tokenEstimate : 0,
    };
  }

  return {
    metrics,
    notes: `token-budget sweep (§11,§16,§17,§18-20 v2.3): 12 critical + 60 irrelevant memories, budgets 128→8192, reports criticalCoverage/relevantTokenRatio/noiseRatio/contextRelevance/infoDensity/tokensUsed/truncated/accuracyPerToken`,
  };
}
