function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DATASET_VERSION = "smoke-1.0";

export function buildRetrievalDataset({ topics = 120, distractors = 100 } = {}) {
  const cases = [];
  for (let i = 0; i < topics; i++) {
    const token = `TK${i}`;
    cases.push({
      id: `retrieval-${String(i).padStart(4, "0")}`,
      category: "retrieval",
      difficulty: "medium",
      token,
      query: `${token} approach`,
      relevantKinds: ["canonical", "duplicate", "contradiction", "expired", "related"],
    });
  }
  return {
    datasetVersion: DATASET_VERSION,
    topics: cases,
    distractors,
  };
}

export function buildStorageDataset() {
  const prefs = [];
  for (let i = 0; i < 60; i++) {
    prefs.push({
      id: `store-pref-${i}`,
      category: "other",
      key: `store_key_${i}`,
      value: `stored value number ${i} for project config`,
    });
  }
  const lessons = [];
  for (let i = 0; i < 40; i++) {
    lessons.push({
      id: `store-lesson-${i}`,
      situation: `situation context number ${i}`,
      mistake: `mistake number ${i}`,
      correction: `correction number ${i}`,
    });
  }
  return { datasetVersion: DATASET_VERSION, prefs, lessons };
}
