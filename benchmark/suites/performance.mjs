import { measure } from "../lib/harness.mjs";
import { summarizeLatencies } from "../lib/metrics.mjs";

function prefId(r) {
  const m = /preference id=(\d+)/.exec((r?.content?.[0]?.text) || "");
  return m ? Number(m[1]) : null;
}

export async function runPerformanceSuite(mods, opts = {}) {
  const {
    rememberHandler,
    recallHandler,
    contextHandler,
    createMemory,
    retrieve,
    updateMemoryHandler,
    mergeMemoryHandler,
    linkMemoryHandler,
    forgetHandler,
  } = mods;

  const warmup = opts.warmup ?? 20;
  const iterations = opts.iterations ?? 100;
  const out = {};

  {
    let k = 0;
    const lat = await measure(
      () => rememberHandler({ category: "other", key: `perf_${k++}`, value: "x" }),
      { warmup, iterations }
    );
    out.remember = summarizeLatencies(lat);
  }

  {
    const lat = await measure(
      () => recallHandler({ topic: "perf", limit: 5 }),
      { warmup, iterations }
    );
    out.recall = summarizeLatencies(lat);
  }

  {
    const lat = await measure(
      () => contextHandler({ query: "perf", maxTokens: 500 }),
      { warmup, iterations }
    );
    out.getContext = summarizeLatencies(lat);
  }

  {
    const lat = await measure(
      () => retrieve("benchmark memory topic", { limit: 10 }),
      { warmup, iterations }
    );
    out.retrieve = summarizeLatencies(lat);
  }

  {
    const lat = await measure(
      () => createMemory({ type: "FACT", content: `perf ${Math.random()}`, source: "explicit" }),
      { warmup, iterations }
    );
    out.createMemory = summarizeLatencies(lat);
  }

  {
    const lat = await measure(() => {
      const id = createMemory({ type: "FACT", content: `perf ${Math.random()}`, source: "explicit" });
      updateMemoryHandler({ id, content: `updated ${Math.random()}` });
    }, { warmup, iterations });
    out.updateMemory = summarizeLatencies(lat);
  }

  {
    const lat = await measure(() => {
      const a = createMemory({ type: "FACT", content: `a ${Math.random()}`, source: "explicit" });
      const b = createMemory({ type: "FACT", content: `b ${Math.random()}`, source: "explicit" });
      mergeMemoryHandler({ sourceId: a, targetId: b });
    }, { warmup, iterations });
    out.mergeMemory = summarizeLatencies(lat);
  }

  {
    const lat = await measure(() => {
      const a = createMemory({ type: "FACT", content: `a ${Math.random()}`, source: "explicit" });
      const b = createMemory({ type: "FACT", content: `b ${Math.random()}`, source: "explicit" });
      linkMemoryHandler({ sourceId: a, targetId: b, relation: "related_to" });
    }, { warmup, iterations });
    out.linkMemory = summarizeLatencies(lat);
  }

  {
    let k = 0;
    const lat = await measure(async () => {
      const r = await rememberHandler({ category: "other", key: `f_${k++}`, value: "x" });
      const id = prefId(r);
      if (id != null) await forgetHandler({ target_id: id, type: "preference" });
    }, { warmup, iterations });
    out.forget = summarizeLatencies(lat);
  }

  return {
    metrics: { operations: Object.keys(out).length },
    latency: out,
    notes: `warmup=${warmup} iterations=${iterations} (warm only; cold not yet implemented)`,
  };
}
