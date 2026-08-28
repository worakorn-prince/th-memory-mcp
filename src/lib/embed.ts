// embed: lightweight, 100% local vector embeddings (no model download, no API).
//
// Uses a deterministic hashing trick over word tokens + character n-grams
// (n=3) so it captures sub-word/Thai similarity without a heavy ML model.
// This gives a "lexical-semantic" vector that blends with FTS5 keyword search
// in recall(). It is intentionally dependency-free to keep th-memory-mcp
// lightweight and offline — swap `embed()` for a real local model (e.g.
// transformers.js) if you need transformer-grade semantics.
import { createHash } from "node:crypto";

export const EMBED_DIM = 512;

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function hashToken(token: string): number {
  return fnv1a(token) % EMBED_DIM;
}

function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  const matches = lower.match(/[a-z0-9ก-์]+/gi);
  if (matches) {
    for (const m of matches) tokens.push(m);
  }
  const chars = Array.from(lower.replace(/\s+/g, ""));
  if (chars.length >= 3) {
    for (let i = 0; i < chars.length - 2; i++) {
      tokens.push("g:" + chars.slice(i, i + 3).join(""));
    }
  } else if (chars.length > 0) {
    tokens.push("g:" + chars.join(""));
  }
  return tokens;
}

export function embed(text: string): Float32Array {
  const vec = new Float32Array(EMBED_DIM);
  const tokens = tokenize(text || "");
  if (tokens.length === 0) return vec;
  for (const t of tokens) {
    const idx = hashToken(t);
    vec[idx] = (vec[idx] ?? 0) + 1;
  }
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += (vec[i] ?? 0) * (vec[i] ?? 0);
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBED_DIM; i++) vec[i] = (vec[i] ?? 0) / norm;
  return vec;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < EMBED_DIM; i++) dot += (a[i] ?? 0) * (b[i] ?? 0);
  return dot;
}

export function serialize(vec: Float32Array): Buffer {
  const copy = new Float32Array(EMBED_DIM);
  copy.set(vec);
  return Buffer.from(copy.buffer);
}

export function deserialize(buf: Buffer): Float32Array {
  const out = new Float32Array(EMBED_DIM);
  const ab = Buffer.from(buf).buffer.slice(0, EMBED_DIM * 4);
  out.set(new Float32Array(ab));
  return out;
}
