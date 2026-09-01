import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const PROFILE_MAP = {
  quick: { memories: 5_000, queries: 1_000 },
  normal: { memories: 20_000, queries: 5_000 },
  heavy: { memories: 100_000, queries: 10_000 },
  stress: { memories: 500_000, queries: 25_000 },
  extreme: { memories: 1_000_000, queries: 50_000 },
};

export function getProfileSpec(profile) {
  return PROFILE_MAP[profile] || PROFILE_MAP.quick;
}

export function runScalabilitySuite(mods, opts = {}) {
  const { createMemory, retrieve, getContext } = mods;
  const dbPath = mods.dbPath;
  const profile = opts.profile || null;
  let N, queries;
  if (profile && PROFILE_MAP[profile]) {
    N = PROFILE_MAP[profile].memories;
    queries = PROFILE_MAP[profile].queries;
    if (opts.scale && opts.scale < N) N = opts.scale;
    if (opts.queries) queries = opts.queries;
  } else {
    N = opts.scale || 1000;
    queries = opts.queries || 100;
  }

  const rssStart = process.memoryUsage().rss;
  const cpuStart = process.cpuUsage();
  let maxRss = rssStart;

  const tInsert0 = Date.now();
  const statePath = dbPath + ".scalability-state.json";
  let startIdx = 0;
  let resumable = false;
  try {
    if (fs.existsSync(statePath)) {
      const st = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (st.target === N && st.dbPath === dbPath && typeof st.current === "number") {
        startIdx = st.current;
        resumable = st.current > 0;
      }
    }
  } catch {}
  for (let i = startIdx; i < N; i++) {
    createMemory({
      type: "FACT",
      content: `scalability memory number ${i} about topic ${i % 50} ${"x".repeat(20)}`,
      source: "explicit",
      importance: 0.5,
    });
    if (i % 1000 === 0) {
      const r = process.memoryUsage().rss;
      if (r > maxRss) maxRss = r;
      try {
        fs.writeFileSync(statePath, JSON.stringify({ target: N, current: i + 1, dbPath, ts: new Date().toISOString() }));
      } catch {}
    }
    if (i % 200 === 0) {
      const r = process.memoryUsage().rss;
      if (r > maxRss) maxRss = r;
    }
  }
  try { fs.rmSync(statePath, { force: true }); } catch {}
  const tInsert1 = Date.now();
  const cpuAfterInsert = process.cpuUsage(cpuStart);

  let sizeBytes = 0;
  for (const s of ["", "-wal", "-shm"]) {
    try {
      sizeBytes += fs.statSync(dbPath + s).size;
    } catch {}
  }
  const sizeMB = sizeBytes / 1024 / 1024;
  const mbPer1k = sizeMB / (N / 1000);

  let retrieveLat = 0, contextLat = 0;
  let ftsLat = 0, vectorLat = 0, graphLat = 0;
  if (retrieve && getContext && N >= 1000 && queries > 0) {
    const qSamples = Math.min(queries, 100);
    const r0 = Date.now();
    for (let q = 0; q < qSamples; q++) retrieve(`scalability topic ${q % 50}`, { limit: 10 });
    retrieveLat = (Date.now() - r0) / qSamples;
    const c0 = Date.now();
    for (let q = 0; q < Math.min(qSamples, 20); q++) getContext({ query: `scalability topic ${q % 50}`, limit: 10, maxTokens: 512 });
    contextLat = (Date.now() - c0) / Math.min(qSamples, 20);
    if (mods.ftsSearch) {
      const f0 = Date.now();
      for (let q = 0; q < Math.min(qSamples, 20); q++) mods.ftsSearch(`scalability topic ${q % 50}`, { limit: 10 });
      ftsLat = (Date.now() - f0) / Math.min(qSamples, 20);
    }
    if (mods.vectorSearch) {
      const v0 = Date.now();
      for (let q = 0; q < Math.min(qSamples, 20); q++) mods.vectorSearch(`scalability topic ${q % 50}`, {});
      vectorLat = (Date.now() - v0) / Math.min(qSamples, 20);
    }
  }

  const secsInsert = (tInsert1 - tInsert0) / 1000;
  const memoriesPerSec = N / (secsInsert || 1);
  const rssEnd = process.memoryUsage().rss;
  let indexSize = 0;
  try {
    const dir = path.dirname(dbPath);
    const base = path.basename(dbPath);
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(base)) {
        try { indexSize += fs.statSync(path.join(dir, f)).size; } catch {}
      }
    }
  } catch {}

  return {
    metrics: {
      profile: profile || "custom",
      memoriesInserted: N,
      queries,
      memoriesPerSec,
      dbSizeMB: sizeMB,
      indexSizeMB: indexSize / 1024 / 1024,
      mbPer1kMemories: mbPer1k,
      peakRssMB: maxRss / 1024 / 1024,
      rssMB: rssEnd / 1024 / 1024,
      rssGrowthMB: (maxRss - rssStart) / 1024 / 1024,
      cpuUserMs: cpuAfterInsert.user / 1000,
      cpuSysMs: cpuAfterInsert.system / 1000,
      wallClockInsertMs: tInsert1 - tInsert0,
      retrieveLatencyMs: retrieveLat,
      getContextLatencyMs: contextLat,
      ftsLatencyMs: ftsLat,
      vectorLatencyMs: vectorLat,
      resumable,
    },
    notes: `scalability §24-26 v2.3: profile=${profile || "custom"} N=${N} Q=${queries} throughput+DB/index+CPU/RAM+latency, resumable via ${path.basename(statePath)}`,
  };
}
