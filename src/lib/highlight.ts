import type { ToolResult } from "../db/index.js";

export interface MemorySpan {
  start: number;
  end: number;
  source: string;
}

export function findMemorySpans(
  text: string,
  candidates: string[]
): MemorySpan[] {
  if (!text || candidates.length === 0) return [];
  const lowered = text.toLowerCase();
  const raw: MemorySpan[] = [];
  for (const c of candidates) {
    if (!c) continue;
    const needle = c.toLowerCase();
    if (!needle) continue;
    let from = 0;
    while (true) {
      const idx = lowered.indexOf(needle, from);
      if (idx === -1) break;
      raw.push({ start: idx, end: idx + c.length, source: c });
      from = idx + 1;
    }
  }
  if (raw.length === 0) return [];
  raw.sort(
    (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start)
  );
  const merged: MemorySpan[] = [];
  for (const s of raw) {
    const last = merged[merged.length - 1];
    if (!last) {
      merged.push({ start: s.start, end: s.end, source: s.source });
      continue;
    }
    if (s.start >= last.end) {
      merged.push({ start: s.start, end: s.end, source: s.source });
      continue;
    }
    const lastLen = last.end - last.start;
    const curLen = s.end - s.start;
    if (curLen > lastLen) last.source = s.source;
    if (s.end > last.end) last.end = s.end;
  }
  return merged;
}

export function renderHighlighted(
  text: string,
  spans: MemorySpan[],
  opts?: { color?: boolean }
): string {
  if (!spans || spans.length === 0) return text;
  const color = opts?.color ?? false;
  const open = color ? "\x1b[4m" : "[mem]";
  const close = color ? "\x1b[24m" : "[/mem]";
  const sorted = spans
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end))
    .map((s) => ({
      start: Math.max(0, Math.min(text.length, Math.floor(s.start))),
      end: Math.max(0, Math.min(text.length, Math.floor(s.end))),
      source: s.source,
    }))
    .filter((s) => s.end > s.start)
    .sort(
      (a, b) => a.start - b.start || b.end - b.start - (a.end - a.start)
    );
  const merged: MemorySpan[] = [];
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (!last || s.start >= last.end) {
      merged.push({ start: s.start, end: s.end, source: s.source });
    } else if (s.end > last.end) {
      last.end = s.end;
    }
  }
  if (merged.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (const s of merged) {
    out += text.slice(cursor, s.start) + open + text.slice(s.start, s.end) + close;
    cursor = s.end;
  }
  out += text.slice(cursor);
  return out;
}

function extractCandidates(recallText: string): string[] {
  if (!recallText) return [];
  if (/no memory found for/i.test(recallText)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (s: string): void => {
    const t = s.trim();
    if (t.length < 2 || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  for (const line of recallText.split(/\r?\n/)) {
    const t = line.trim().replace(/^[-*\u2022]\s+/, "");
    if (!t) continue;
    if (t.startsWith("<") && t.endsWith(">")) continue;
    if (/^the content inside/i.test(t)) continue;
    if (/^\[.+\]$/.test(t)) continue;
    const interaction = t.match(/^\[.*?\] \([a-z_]+\)\s*(.+)$/);
    if (interaction) {
      push(interaction[1] ?? "");
      continue;
    }
    if (t.startsWith("[")) continue;
    push(t);
    for (const seg of t.split("|")) {
      push(seg);
      const ci = seg.lastIndexOf(":");
      if (ci !== -1) push(seg.slice(ci + 1));
    }
  }
  return out;
}

export async function highlightTextWithMemory(
  text: string,
  topic: string,
  opts?: { limit?: number; color?: boolean }
): Promise<string> {
  const color = opts?.color ?? false;
  const limit = opts?.limit ?? 8;
  try {
    const { recallHandler } = await import("../tools/recall.js");
    const result: ToolResult = await recallHandler({ topic, limit });
    const raw = result.content.map((c) => c.text).join("\n");
    const candidates = extractCandidates(raw);
    if (candidates.length === 0) return text;
    const spans = findMemorySpans(text, candidates);
    if (spans.length === 0) return text;
    return renderHighlighted(text, spans, { color });
  } catch {
    return text;
  }
}
