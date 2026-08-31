import fs from "node:fs";
import os from "node:os";

export function runScalabilitySuite(mods, opts = {}) {
  const { createMemory } = mods;
  const dbPath = mods.dbPath;
  const N = opts.scale || 1000;

  const rssStart = process.memoryUsage().rss;
  const cpuStart = process.cpuUsage();
  let maxRss = rssStart;

  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    createMemory({
      type: "FACT",
      content: `scalability memory number ${i} about topic ${i % 50}`,
      source: "explicit",
      importance: 0.5,
    });
    if (i % 200 === 0) {
      const r = process.memoryUsage().rss;
      if (r > maxRss) maxRss = r;
    }
  }
  const t1 = Date.now();
  const cpuEnd = process.cpuUsage(cpuStart);

  const secs = (t1 - t0) / 1000;
  const memoriesPerSec = N / secs;
  let sizeBytes = 0;
  for (const s of ["", "-wal", "-shm"]) {
    try {
      sizeBytes += fs.statSync(dbPath + s).size;
    } catch {}
  }
  const sizeMB = sizeBytes / 1024 / 1024;
  const mbPer1k = sizeMB / (N / 1000);

  return {
    metrics: {
      memoriesInserted: N,
      memoriesPerSec: memoriesPerSec,
      dbSizeMB: sizeMB,
      mbPer1kMemories: mbPer1k,
      peakRssMB: maxRss / 1024 / 1024,
      rssGrowthMB: (maxRss - rssStart) / 1024 / 1024,
      cpuUserMs: cpuEnd.user / 1000,
      cpuSysMs: cpuEnd.system / 1000,
    },
    notes: `throughput + DB size + CPU/RAM (§13,§14,§15). cold-state not yet implemented (needs subprocess).`,
  };
}
