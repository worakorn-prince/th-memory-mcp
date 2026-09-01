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
export const SEMANTIC_DATASET_VERSION = "semantic-hard-1.0";
export const GRAPH_DATASET_VERSION = "graph-1.0";
export const SCOPE_DATASET_VERSION = "scope-1.0";

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

const SEMANTIC_CATEGORIES = [
  "exact",
  "variation",
  "typo",
  "thai_paraphrase",
  "synonym",
  "thai_english",
  "indirect",
  "conceptual",
];

const SEMANTIC_TEMPLATES = {
  exact: { mem: (tk) => `ผู้ใช้ชอบกาแฟดำ ${tk}`, qry: (tk) => `กาแฟดำ ${tk}` },
  variation: { mem: (tk) => `ผู้ใช้ชอบกาแฟดำ ${tk}`, qry: (tk) => `ผู้ใช้ชอบดื่มกาแฟดำ ${tk}` },
  typo: { mem: (tk) => `ผู้ใช้ใช้ OpenCode ${tk}`, qry: (tk) => `ผู้ใช้ไช้ OpenCode ${tk}` },
  thai_paraphrase: { mem: (tk) => `ผู้ใช้ไม่ต้องการระบบที่ต้องพึ่ง cloud ${tk}`, qry: (tk) => `ระบบควรทำงานโดยไม่ต้องส่งข้อมูลขึ้นออนไลน์ ${tk}` },
  synonym: { mem: (tk) => `ผู้ใช้ไม่กินอาหารเผ็ด ${tk}`, qry: (tk) => `ผู้ใช้ทานรสจัดไม่ได้ ${tk}` },
  thai_english: { mem: (tk) => `โปรเจกต์นี้ต้องทำงานแบบ offline ${tk}`, qry: (tk) => `ระบบนี้ต้องใช้ internet หรือไม่ ${tk}` },
  indirect: { mem: (tk) => `ผู้ใช้เลือก SQLite เพราะต้องการ database ที่ local ${tk}`, qry: (tk) => `ทำไมถึงเลือก database ตัวนี้ ${tk}` },
  conceptual: { mem: (tk) => `โปรเจกต์ต้องไม่ส่งข้อมูลผู้ใช้ไปยัง third-party service ${tk}`, qry: (tk) => `เราสามารถใช้ external API ได้หรือไม่ ${tk}` },
};

export function buildSemanticHardDataset({ topics = 100, distractors = 100, seed = 42 } = {}) {
  const rand = mulberry32(seed);
  const cases = [];
  for (let i = 0; i < topics; i++) {
    const category = SEMANTIC_CATEGORIES[i % SEMANTIC_CATEGORIES.length];
    const tpl = SEMANTIC_TEMPLATES[category];
    const tk = `TK${String(i).padStart(4, "0")}`;
    cases.push({
      id: `semantic-${String(i).padStart(4, "0")}`,
      category,
      difficulty: category === "exact" || category === "variation" ? "easy" : category === "typo" ? "medium" : "hard",
      token: tk,
      query: tpl.qry(tk),
      memoryTemplate: tpl.mem(tk),
      relevantKinds: ["canonical"],
    });
  }
  for (let i = cases.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [cases[i], cases[j]] = [cases[j], cases[i]];
  }
  return {
    datasetVersion: SEMANTIC_DATASET_VERSION,
    topics: cases,
    distractors,
    seed,
    categories: [...SEMANTIC_CATEGORIES],
  };
}

export function buildGraphDataset({ scenarios = 100, seed = 42 } = {}) {
  const rand = mulberry32(seed);
  const relations = ["supports", "contradicts", "supersedes", "derived_from", "related_to", "caused_by", "depends_on"];
  const cases = [];
  for (let i = 0; i < scenarios; i++) {
    const nodes = 5 + Math.floor(rand() * 16);
    const hops = 1 + Math.floor(rand() * 3);
    const chain = [];
    for (let h = 0; h <= hops; h++) {
      chain.push(`G${i}_N${h}`);
    }
    cases.push({
      id: `graph-${String(i).padStart(4, "0")}`,
      nodes,
      hops,
      chain,
      relations: chain.slice(1).map((_, idx) => relations[(i + idx) % relations.length]),
      query: `Why was decision G${i}_N0 made?`,
    });
  }
  return { datasetVersion: GRAPH_DATASET_VERSION, scenarios: cases, seed };
}

export function buildScopeDataset({ seed = 42 } = {}) {
  return { datasetVersion: SCOPE_DATASET_VERSION, seed, scopes: ["USER", "SESSION", "PROJECT", "GLOBAL"] };
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
