// distill-core: pure rule-based summarization helpers for the Learning Loop.
// NO DB imports — must compile with the main tsc config and stay testable.

// --- stopwords (basic EN + TH) ---
export const STOPWORDS: ReadonlySet<string> = new Set([
  // english
  "the", "a", "an", "is", "are", "to", "of", "and", "or", "in", "on", "for",
  "with", "this", "that", "it", "i", "you", "me", "my", "we", "be", "was",
  "were", "been", "am", "do", "does", "did", "have", "has", "had", "not",
  "no", "but", "so", "if", "then", "than", "as", "at", "by", "from", "into",
  "about", "can", "could", "will", "would", "should", "shall", "may",
  "might", "must", "just", "very", "there", "here", "what", "when", "where",
  "which", "who", "how", "why", "all", "any", "some", "such", "own", "same",
  "too", "its", "our", "your", "they", "them", "their", "he", "she", "his",
  "her", "him", "us", "s", "t",
  // thai
  "และ", "หรือ", "ที่", "ให้", "ของ", "การ", "ไม่", "ใน", "มี", "ผม", "ฉัน",
  "คือ", "ไป", "มา", "แล้ว", "ด้วย", "อะไร", "ทำ", "ใส่", "เป็น", "อยู่",
  "จาก", "กับ", "ว่า", "นี้", "นั้น", "โดย", "ครับ", "ค่ะ", "ต้อง", "ยัง",
  "เพื่อ", "แบบ", "หน่อย", "นะ", "ล่ะ", "เลย", "ก็", "แต่", "ถ้า", "ช่วย",
]);

interface SegmentLike {
  segment?: unknown;
}

type SegmentFn = (text: string) => string[];

let cachedSegmenter: SegmentFn | null | undefined;

function getSegmenter(): SegmentFn | null {
  if (cachedSegmenter !== undefined) return cachedSegmenter;
  try {
    const intl = Intl as unknown as {
      Segmenter?: new (
        locale: string,
        opts: { granularity: "word" }
      ) => { segment(text: string): Iterable<SegmentLike> };
    };
    if (typeof intl.Segmenter === "function") {
      const segmenter = new intl.Segmenter("th", { granularity: "word" });
      cachedSegmenter = (text: string): string[] => {
        const out: string[] = [];
        for (const s of segmenter.segment(text)) {
          if (typeof s.segment === "string") out.push(s.segment);
        }
        return out;
      };
    } else {
      cachedSegmenter = null;
    }
  } catch {
    cachedSegmenter = null;
  }
  return cachedSegmenter;
}

const PURE_DIGITS = /^\d+$/;

export function tokenize(text: string): string[] {
  const input = String(text ?? "");
  const seg = getSegmenter();
  const raw = seg ? seg(input) : input.split(/\s+/);
  const out: string[] = [];
  for (const r of raw) {
    const tok = r.toLowerCase().trim();
    if (tok.length < 2) continue;
    if (PURE_DIGITS.test(tok)) continue;
    if (STOPWORDS.has(tok)) continue;
    out.push(tok);
  }
  return out;
}

// --- stats ---

export interface DistillRow {
  kind: string;
  content: string;
  meta: string | null;
  ts: string;
}

export type CountPair = [string, number];

export interface DistillStats {
  totalPrompts: number;
  promptDays: number;
  topTools: CountPair[];
  topKeywords: CountPair[];
  topDirs: CountPair[];
}

function topN(map: Map<string, number>, n: number): CountPair[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n);
}

function parseMetaObject(meta: unknown): Record<string, unknown> | null {
  if (typeof meta !== "string" || !meta.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(meta);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  return null;
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export function computeStats(rows: DistillRow[]): DistillStats {
  let totalPrompts = 0;
  const days = new Set<string>();
  const toolCounts = new Map<string, number>();
  const keywordCounts = new Map<string, number>();
  const dirCounts = new Map<string, number>();

  for (const row of rows ?? []) {
    if (!row || typeof row !== "object") continue;
    if (row.kind === "prompt") {
      totalPrompts += 1;
      days.add(String(row.ts ?? "").slice(0, 10));
      for (const tok of tokenize(String(row.content ?? ""))) {
        bump(keywordCounts, tok);
      }
    }
    const metaObj = parseMetaObject(row.meta);
    if (metaObj) {
      const tool = metaObj.tool;
      if (typeof tool === "string" && tool.trim()) {
        bump(toolCounts, tool.trim());
      }
      const directory = metaObj.directory;
      if (typeof directory === "string" && directory.trim()) {
        bump(dirCounts, directory.trim());
      }
    }
  }

  return {
    totalPrompts,
    promptDays: days.size,
    topTools: topN(toolCounts, 10),
    topKeywords: topN(keywordCounts, 15),
    topDirs: topN(dirCounts, 5),
  };
}

// --- formatting ---

export interface ProfileSections {
  usage_stats: string;
  topics: string;
}

function pairList(pairs: CountPair[]): string {
  return pairs.map(([name, count]) => `${name}(${count})`).join(", ");
}

export function formatProfileSections(stats: DistillStats): ProfileSections {
  const lines: string[] = [];
  lines.push(
    `prompts: ${stats.totalPrompts} across ${stats.promptDays} ${
      stats.promptDays === 1 ? "day" : "days"
    }`
  );
  if (stats.topTools.length > 0) {
    lines.push(`top tools: ${pairList(stats.topTools)}`);
  }
  if (stats.topDirs.length > 0) {
    lines.push(`top dirs: ${pairList(stats.topDirs)}`);
  }

  const topics =
    stats.topKeywords.length > 0
      ? `frequent topics: ${stats.topKeywords.map(([w]) => w).join(", ")}`
      : "frequent topics: (none)";

  return { usage_stats: lines.join("\n"), topics };
}
