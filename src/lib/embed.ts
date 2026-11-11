// embed: lightweight, 100% local vector embeddings (no model download, no API).
//
// Uses a deterministic hashing trick over word tokens + character n-grams
// (n=3) so it captures sub-word/Thai similarity without a heavy ML model.
// This gives a "lexical-semantic" vector that blends with FTS5 keyword search
// in recall(). It is intentionally dependency-free to keep th-memory-mcp
// lightweight and offline — swap `embed()` for a real local model (e.g.
// transformers.js) if you need transformer-grade semantics.
//
// Thai is word-aware: every Thai run is fed through the shared segmenter
// (`wordTokens` from ./thai-segment.js, the same single source of truth the
// FTS indexer uses), so "ติดตั้งโปรแกรม" contributes the word tokens
// ["ติดตั้ง", "โปรแกรม"] instead of a single opaque run. English stays a
// plain lowercase alpha-numeric split, and the character n-gram channel
// (g:...) remains as a secondary spelling-tolerance signal.
import { createHash } from "node:crypto";
import { wordTokens } from "./thai-segment.js";

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
  const input = text || "";
  const lower = input.toLowerCase();
  const tokens: string[] = [];
  // Word-level channel: English keeps its current lowercase alpha-numeric
  // tokens; each Thai run is segmented into word tokens via the shared
  // thai-segment core (e.g. ติดตั้งโปรแกรม -> [ติดตั้ง, โปรแกรม]).
  tokens.push(...wordTokens(input));
  // Character n-gram channel (secondary, spelling tolerance).
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
  for (let i = 0; i < EMBED_DIM; i++) dot += a[i]! * b[i]!;
  return dot;
}

export function serialize(vec: Float32Array): Buffer {
  const buf = Buffer.alloc(EMBED_DIM * 4);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < EMBED_DIM; i++) dv.setFloat32(i * 4, vec[i] ?? 0, true);
  return buf;
}

// Float32Array views follow platform endianness; the stored blobs are always
// little-endian (serialize writes with DataView, explicit LE), so the zero-copy
// path is only valid on a little-endian runtime. Probe with an integer: the low
// byte of a LE uint32 1 is 1 (a float32 1.0 starts with 0x00).
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

export function deserialize(buf: Buffer): Float32Array {
  // Fast path: a 4-byte-aligned little-endian blob can be viewed in place, no
  // per-element DataView hop. The view keeps the buffer alive, so callers that
  // outlive the read (the decoded-vector cache) are still safe.
  if (
    LITTLE_ENDIAN &&
    buf.byteOffset % 4 === 0 &&
    buf.byteLength >= EMBED_DIM * 4
  ) {
    return new Float32Array(buf.buffer, buf.byteOffset, EMBED_DIM);
  }
  const out = new Float32Array(EMBED_DIM);
  const view = new DataView(
    buf.buffer,
    buf.byteOffset,
    Math.min(EMBED_DIM * 4, buf.byteLength)
  );
  for (let i = 0; i < EMBED_DIM; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}
