// TASK-PERF-COMPUTE equivalence gate.
//
// The compute pass (index memo in thai-segment, cached Thai key info +
// accumulator-free join in thai-synonyms, trigram build in embed) is a pure
// performance change: the FTS/LOOSE payload and the embedding vector must stay
// byte-identical. This test pins that claim against a verbatim copy of the
// pre-change implementation from commit edf13d5 (the parent of this task):
//
//   git show edf13d5:src/lib/thai-segment.ts   → legacySegment
//   git show edf13d5:src/lib/thai-synonyms.ts  → legacySynonyms
//   git show edf13d5:src/lib/embed.ts          → legacyEmbed
//
// Only TypeScript annotations and `export` keywords were removed (this file is
// ESM JavaScript); the statements, comments and control flow are unchanged.
// The copy is self-contained: every helper the four functions call is included,
// including the dictionary fallback and both injected-provider seams.
import { test, after } from "node:test";
import assert from "node:assert/strict";

const newSegmentModule = await import("../dist/lib/thai-segment.js");
const newSynonymModule = await import("../dist/lib/thai-synonyms.js");
const newEmbedModule = await import("../dist/lib/embed.js");

const { segmentForIndex, looseForm, forceSegmenter, resetSegmenter } =
  newSegmentModule;
const { expandIndexedText, THAI_SYNONYMS } = newSynonymModule;
const { embed } = newEmbedModule;

const THAI_CHAR_RE = /[\u0E00-\u0E7F]/;
const EMBED_DIM = 512;

// ===========================================================================
// LEGACY REFERENCE IMPLEMENTATION — src/lib/thai-segment.ts @ edf13d5
// ===========================================================================
const legacySegment = (() => {
  const THAI_RE = /[\u0E00-\u0E7F]/;
  const THAI_RUN_RE = /[\u0E00-\u0E7F]+/g;
  const THAI_TONE_MARK_RE = /[\u0E48\u0E49\u0E4A\u0E4B\u0E4C\u0E4D]/g;

  let cached;

  let forced;

  function getSegmenter() {
    if (forced !== undefined) return forced;
    if (cached !== undefined) return cached;
    try {
      const Ctor = Intl.Segmenter;
      cached =
        typeof Ctor === "function"
          ? new Ctor("th", { granularity: "word" })
          : null;
    } catch {
      cached = null;
    }
    return cached;
  }

  function forceSegmenter(seg) {
    forced = seg;
    cached = undefined;
  }

  function resetSegmenter() {
    forced = undefined;
    cached = undefined;
  }

  const DICT_WORDS = [
    // dev / tech / infrastructure
    "ระบบ", "เซิร์ฟเวอร์", "ฐานข้อมูล", "ข้อมูล", "ความจำ", "หน่วยความจำ",
    "โปรแกรม", "แอปพลิเคชัน", "แอป", "ไฟล์", "โฟลเดอร์", "โค้ด",
    "ฟังก์ชัน", "คลาส", "เมธอด", "ตัวแปร", "โมดูล", "มอดูล",
    "สตริง", "อาร์เรย์", "แพ็กเกจ", "แพ็กเก็ต", "ไลบรารี", "รันไทม์",
    "เวอร์ชัน", "สคริปต์", "เอพีไอ", "เอ็นจิน", "คีย์", "ค่า",
    "โทเคน", "ตาราง", "คอลัมน์", "แถว", "ดัชนี", "สคีมา",
    "เคียวรี", "ควิวรี", "ทรานแซกชัน", "เครือข่าย", "อินเทอร์เน็ต", "เบราว์เซอร์",
    "เว็บไซต์", "รหัสผ่าน", "ผู้ใช้", "บัญชี", "อีเมล", "ล็อก",
    "ล็อกอิน", "ดีบั๊ก", "บั๊ก", "บัค", "โอเพนซอร์ส", "เดสก์ท็อป",
    "โมบาย", "คลาวด์", "โปรเซส", "เธรด", "พาร์เซอร์", "คอมไพเลอร์",
    "ลิงก์", "แมป", "เครื่องมือ", "ภาษา", "พร้อม", "รองรับ",
    // commands / actions
    "ติดตั้ง", "ถอนการติดตั้ง", "ติดตัง", "เปิดใช้งาน", "ปิดใช้งาน",
    "อัปเดต", "อัปเกรด", "ดาวน์เกรด", "ดาวน์โหลด", "อัปโหลด",
    "กู้คืน", "สำรอง", "บันทึก", "ลบ", "แก้ไข", "สร้าง",
    "เขียน", "อ่าน", "ค้นหา", "กรอง", "เรียง", "จัดเรียง",
    "เชื่อมต่อ", "แยก", "รวม", "เพิ่ม", "ลด", "คูณ",
    "หาร", "บวก", "ส่ง", "รับ", "เปิด", "ปิด",
    "หยุด", "พัก", "ต่อ", "ข้าม", "ยกเลิก", "กด",
    "คลิก", "พิมพ์", "ใส่", "แทรก", "คัดลอก", "วาง",
    "ย้าย", "เปลี่ยน", "แปลง", "แปล", "รัน", "เทสต์",
    "ทดสอบ", "เรียก", "เรียกใช้", "แสดง", "ซ่อน", "ตรวจ",
    "ตรวจสอบ", "ตั้งค่า", "กำหนด", "อนุญาต", "ปฏิเสธ", "เริ่ม",
    "เริ่มต้น", "คืนค่า", "รีเซ็ต", "เรียนรู้", "จำ", "ทำงาน",
    "พยายาม", "ลอง", "ต้องการ", "อยากได้", "เข้าใจ", "ตอบ",
    "ถาม", "ช่วย", "ดีพลอย",
    // generic common words
    "เวลา", "งาน", "คน", "วัน", "ศุกร์", "บ่าย",
    "โมง", "สาม", "หลัง", "ใหม่", "เก่า", "เร็ว",
    "ช้า", "ดี", "ง่าย", "ยาก", "ใหญ่", "เล็ก",
    "มาก", "น้อย", "ทุก", "บาง", "เสร็จ", "การ",
    "ของ", "และ", "หรือ", "ที่", "ให้", "ไม่",
    "ใน", "มี", "คือ", "ไป", "มา", "ด้วย",
    "อะไร", "ทำ", "เป็น", "อยู่", "จาก", "กับ",
    "ว่า", "นี้", "นั้น", "โดย", "ครับ", "ค่ะ",
    "ต้อง", "ยัง", "เพื่อ", "แบบ", "นะ", "เลย",
    "ก็", "แต่", "ถ้า", "ผม", "ฉัน", "คุณ",
    "เรา", "เขา", "มัน", "ใช้", "ข้าว", "ผัด",
    "อร่อย", "แมว", "กิน", "ปลา", "น้ำ", "บ้าน",
    "เมือง", "เพื่อน", "ร้าน", "เงิน", "บริการ", "รายเดือน",
    "อาหาร", "ทะเล", "นั่ง", "กลางวัน", "ดื้อ", "ยอม",
    "ฟัง", "ใคร", "แพ้", "เผ็ด",
  ];

  const DICT = new Set(DICT_WORDS);
  let DICT_MAX = 0;
  for (const w of DICT_WORDS) {
    if (w.length > DICT_MAX) DICT_MAX = w.length;
  }

  function isThaiConsonant(ch) {
    const c = ch.codePointAt(0) ?? 0;
    return c >= 0x0e01 && c <= 0x0e2e;
  }

  function heuristicWord(run, start) {
    let i = start + 1;
    let word = run[start] ?? "";
    while (i < run.length) {
      const ch = run[i] ?? "";
      if (isThaiConsonant(ch)) break;
      word += ch;
      i++;
    }
    return { word, next: i };
  }

  function dictSegment(run) {
    const out = [];
    let i = 0;
    while (i < run.length) {
      const max = Math.min(DICT_MAX, run.length - i);
      let matched = "";
      for (let len = max; len >= 1; len--) {
        const cand = run.slice(i, i + len);
        if (DICT.has(cand)) {
          matched = cand;
          break;
        }
      }
      if (matched) {
        out.push(matched);
        i += matched.length;
        continue;
      }
      const cluster = heuristicWord(run, i);
      out.push(cluster.word);
      i = cluster.next;
    }
    return out;
  }

  function thaiTokens(run, seg) {
    const out = [];
    if (seg) {
      for (const s of seg.segment(run)) {
        const w = s.segment.trim();
        if (w) out.push(w);
      }
    } else {
      out.push(...dictSegment(run));
    }
    return applyOverrideMerges(run, out);
  }

  let overrideProvider = null;
  let overrideProviderCached;
  let overrideTermMap = null;

  function setSegmentOverrideProvider(fn) {
    overrideProvider = fn ?? null;
    overrideProviderCached = undefined;
    overrideTermMap = null;
  }

  function getOverrideTermMap() {
    const provider = overrideProvider;
    if (!provider) return null;
    if (overrideProviderCached !== provider) {
      let list = null;
      try {
        list = provider() ?? null;
      } catch {
        list = null;
      }
      const map = new Map();
      if (list) {
        for (const o of list) {
          const t = String(o?.term ?? "").trim();
          const f = String(o?.fixed ?? "").trim();
          if (t && f) map.set(t, f);
        }
      }
      overrideTermMap = map;
      overrideProviderCached = provider;
    }
    return overrideTermMap;
  }

  function mergeForcedTokens(tokens, term, fixed) {
    const out = [];
    let changed = false;
    let i = 0;
    while (i < tokens.length) {
      const head = tokens[i] ?? "";
      if (head === term) {
        out.push(fixed);
        changed = true;
        i += 1;
        continue;
      }
      if (head.length < term.length) {
        let acc = head;
        let j = i + 1;
        while (j < tokens.length && acc.length < term.length) {
          acc += tokens[j] ?? "";
          j += 1;
        }
        if (acc === term) {
          out.push(fixed);
          changed = true;
          i = j;
          continue;
        }
      }
      out.push(head);
      i += 1;
    }
    return changed ? out : null;
  }

  function applyOverrideMerges(run, tokens) {
    const map = getOverrideTermMap();
    if (map === null || map.size === 0) return [...tokens];
    const terms = [...map.keys()]
      .filter((t) => run.includes(t))
      .sort((a, b) => b.length - a.length);
    if (terms.length === 0) return [...tokens];
    let out = tokens;
    for (const term of terms) {
      const merged = mergeForcedTokens(out, term, map.get(term) ?? term);
      if (merged) out = merged;
    }
    return [...out];
  }

  function hasThai(text) {
    return THAI_RE.test(text);
  }

  function looseForm(text) {
    return String(text ?? "").toLowerCase().replace(THAI_TONE_MARK_RE, "");
  }

  function wordTokens(text) {
    const input = String(text ?? "");
    const seg = getSegmenter();
    const out = [];
    let last = 0;
    for (const m of input.matchAll(THAI_RUN_RE)) {
      const run = m[0] ?? "";
      const idx = m.index;
      pushLatinTokens(input.slice(last, idx), out);
      for (const w of thaiTokens(run, seg)) {
        if (w) out.push(w.toLowerCase());
      }
      last = idx + run.length;
    }
    pushLatinTokens(input.slice(last), out);
    return out;
  }

  function pushLatinTokens(segment, out) {
    if (!segment) return;
    for (const tok of segment.toLowerCase().split(/[^a-z0-9]+/)) {
      if (tok) out.push(tok);
    }
  }

  // Pre-change form: no memo, same transform.
  function segmentForIndex(text) {
    const input = String(text ?? "");
    if (!hasThai(input)) return input;
    const seg = getSegmenter();
    const out = input.replace(
      THAI_RUN_RE,
      (run) => ` ${thaiTokens(run, seg).join(" ")} `
    );
    return out.replace(/ {2,}/g, " ");
  }

  return {
    segmentForIndex,
    looseForm,
    wordTokens,
    forceSegmenter,
    resetSegmenter,
    setSegmentOverrideProvider,
    hasThai,
  };
})();

// ===========================================================================
// LEGACY REFERENCE IMPLEMENTATION — src/lib/thai-synonyms.ts @ edf13d5
// ===========================================================================
const legacySynonyms = (({ segmentForIndex }) => {
  const THAI_SYNONYMS = [
    ["deploy", "ดีพลอย"], // dev loanword; already a segmenter-dictionary word.
    ["server", "เซิร์ฟเวอร์"], // standard TH transliteration for "server".
    ["database", "ฐานข้อมูล"], // semantic TH term for "database".
    ["repository", "รีโพสิทอรี"], // TH loanword for repository.
    ["repository", "รีโพ"], // dev slang "repo", unambiguous in chat/code.
    ["install", "ติดตั้ง"], // TH verb (strict tone-marked form).
    ["package", "แพ็กเกจ"], // TH loanword (packaging context).
    ["project", "โปรเจกต์"], // TH loanword.
    ["version", "เวอร์ชัน"], // TH loanword.
    ["test", "เทสต์"], // TH loanword verb/noun.
    ["node", "โหนด"], // graph / Node.js node, TH loanword.
    ["backup", "สำรอง"], // TH verb.
    ["error", "ข้อผิดพลาด"], // semantic TH term.
    ["search", "ค้นหา"], // TH verb.
    ["save", "บันทึก"], // TH verb.
    ["delete", "ลบ"], // TH verb.
    ["memory", "ความจำ"], // memory (faculty sense) — core domain.
    ["memory", "หน่วยความจำ"], // memory (hardware sense).
    ["config", "คอนฟิก"], // TH loanword for config.
    ["debug", "ดีบั๊ก"], // TH loanword; dictionary word.
  ];

  const THAI_RE = /[\u0E00-\u0E7F]/;

  function buildLookup(pairs) {
    const m = new Map();
    const put = (k, v) => {
      if (!k || !v || k === v) return;
      const cur = m.get(k);
      if (cur) {
        if (!cur.includes(v)) cur.push(v);
      } else {
        m.set(k, [v]);
      }
    };
    for (const [a, b] of pairs) {
      put(a.toLowerCase(), b.toLowerCase());
      put(b.toLowerCase(), a.toLowerCase());
    }
    return m;
  }

  const STATIC_LOOKUP = buildLookup(THAI_SYNONYMS);

  let synonymProvider = null;
  let synonymProviderCached;
  let synonymDynamicBase = null;

  function setSynonymProvider(fn) {
    synonymProvider = fn ?? null;
    synonymProviderCached = undefined;
    synonymDynamicBase = null;
  }

  function getDynamicBase() {
    if (!synonymProvider) return null;
    if (synonymProviderCached !== synonymProvider) {
      const pairs = synonymProvider() ?? [];
      const merged = new Map(STATIC_LOOKUP);
      mergeLookup(merged, buildLookup(pairs));
      synonymDynamicBase = merged;
      synonymProviderCached = synonymProvider;
    }
    return synonymDynamicBase;
  }

  function mergeLookup(target, source) {
    for (const [k, v] of source) {
      const cur = target.get(k);
      const arr = cur ? [...cur] : [];
      for (const x of v) if (!arr.includes(x)) arr.push(x);
      target.set(k, arr);
    }
  }

  function lookupFor(extra) {
    const dyn = getDynamicBase();
    if (dyn === null) {
      if (!extra) return STATIC_LOOKUP;
      const merged = new Map(STATIC_LOOKUP);
      mergeLookup(merged, buildLookup(extra));
      return merged;
    }
    if (!extra) return dyn;
    const merged = new Map(dyn);
    mergeLookup(merged, buildLookup(extra));
    return merged;
  }

  function expandSynonyms(term, extra) {
    const input = String(term ?? "");
    const lc = input.toLowerCase();
    if (!lc) return [lc];
    const exts = lookupFor(extra).get(lc);
    return exts ? [lc, ...exts] : [lc];
  }

  function expandChunkSynonyms(chunk, extra) {
    const input = String(chunk ?? "");
    if (!input) return [input];
    const syns = expandSynonyms(input, extra);
    return syns.length === 1 ? [input] : [input, ...syns.slice(1)];
  }

  const THAI_SUBSEQ_CAP = 40;

  function expandIndexedText(segmented, extra) {
    const text = String(segmented ?? "");
    if (!text.trim()) return text;
    const lookup = lookupFor(extra);
    const tokens = text.split(/\s+/).filter(Boolean);
    const lower = text.toLowerCase();
    const toAppend = [];
    const appended = new Set();

    const present = (c) => {
      const cs = segmentForIndex(String(c)).toLowerCase().trim();
      return cs.length === 0 || lower.includes(cs);
    };
    const push = (c) => {
      const cs = segmentForIndex(String(c)).toLowerCase().trim();
      if (!cs || present(c)) return;
      if (!appended.has(cs)) {
        appended.add(cs);
        toAppend.push(cs);
      }
    };

    for (const tok of tokens) {
      const syns = expandSynonyms(tok, extra);
      for (let i = 1; i < syns.length; i++) {
        const c = syns[i];
        if (c) push(c);
      }
    }

    const thaiKeys = new Set();
    for (const k of lookup.keys()) {
      if (THAI_RE.test(k)) thaiKeys.add(k);
    }
    let run = null;
    const flush = () => {
      if (run && run.length > 0 && run.length <= THAI_SUBSEQ_CAP) {
        for (let s = 0; s < run.length; s++) {
          let join = "";
          for (let e = s; e < run.length; e++) {
            join += run[e] ?? "";
            if (thaiKeys.has(join)) {
              const syns = expandSynonyms(join, extra);
              for (let i = 1; i < syns.length; i++) {
                const c = syns[i];
                if (c) push(c);
              }
            }
          }
        }
      }
      run = null;
    };
    for (const tok of tokens) {
      if (THAI_RE.test(tok)) {
        run = run ?? [];
        run.push(tok.toLowerCase());
      } else {
        flush();
      }
    }
    flush();

    if (toAppend.length === 0) return text.trimEnd();
    return `${text} ${toAppend.join(" ")}`.replace(/ {2,}/g, " ").trimEnd();
  }

  return {
    expandIndexedText,
    expandSynonyms,
    expandChunkSynonyms,
    setSynonymProvider,
    STATIC_LOOKUP,
  };
})(legacySegment);

// ===========================================================================
// LEGACY REFERENCE IMPLEMENTATION — src/lib/embed.ts @ edf13d5
// ===========================================================================
const legacyEmbed = (({ wordTokens }) => {
  const EMBED_DIM = 512;

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function hashToken(token) {
    return fnv1a(token) % EMBED_DIM;
  }

  function tokenize(text) {
    const input = text || "";
    const lower = input.toLowerCase();
    const tokens = [];
    tokens.push(...wordTokens(input));
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

  function embed(text) {
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

  return { embed };
})(legacySegment);

// ===========================================================================
// Corpus
// ===========================================================================
const LONG_THAI_PROSE = [
  "ระบบบันทึกความจำของโปรเจกต์นี้ทำงานบนเซิร์ฟเวอร์ลินุกซ์",
  "โดยใช้ฐานข้อมูล SQLite และไลบรารี better-sqlite3",
  "ทุกครั้งที่มีการติดตั้งหรืออัปเดตเวอร์ชันใหม่",
  "ต้องสำรองฐานข้อมูลก่อนดีพลอยขึ้นโปรดักชันเสมอ",
  "จากนั้นรันเทสต์ทั้งหมดเพื่อตรวจสอบข้อผิดพลาด",
  "ถ้าพบข้อผิดพลาดให้บันทึกไว้ในหน่วยความจำของโปรเจกต์",
].join(" ");

// One unspaced Thai run that segments into far more than 10 tokens: this is the
// case that exercises the `join.length > maxThaiKeyLen` break in the new
// expandIndexedText (the old implementation kept extending every join).
const LONG_THAI_RUN =
  "ระบบฐานข้อมูลความจำหน่วยความจำโปรแกรมไฟล์โฟลเดอร์โค้ดฟังก์ชันคลาสเมธอดตัวแปรโมดูลสตริงอาร์เรย์แพ็กเกจไลบรารีเวอร์ชันสคริปต์เอ็นจินคีย์ตารางคอลัมน์ดัชนี";

const CORPUS = [
  // --- Thai only, with tone marks ----------------------------------------
  "ติดตั้งโปรแกรมใหม่บนเซิร์ฟเวอร์",
  "ฐานข้อมูลสำรองข้อมูลทุกวันศุกร์บ่ายโมง",
  "บันทึกความจำของโปรเจกต์ไว้ในหน่วยความจำ",
  "ตรวจสอบข้อผิดพลาดก่อนดีพลอยขึ้นโปรดักชัน",
  "เวอร์ชันใหม่ของไลบรารีทำงานได้เร็วขึ้น",
  "เทสต์ทั้งหมดผ่านแล้วแต่ยังต้องตรวจสอบอีกครั้ง",
  "ค้นหาข้อมูลในฐานข้อมูลด้วยเคียวรีเดียว",
  "ตั้งค่าคอนฟิกของเซิร์ฟเวอร์ให้พร้อมใช้งาน",
  "ลบไฟล์เก่าออกแล้วสร้างโฟลเดอร์ใหม่",
  "อ่านโค้ดของฟังก์ชันนี้แล้วแก้ไขบั๊กที่พบ",
  "ผมต้องการให้คุณช่วยตรวจสอบความถูกต้อง",
  "ข้าวผัดทะเลอร่อยมากที่ร้านใกล้บ้าน",
  "นั่งทำงานทั้งวันจนเสร็จแล้วพักผ่อนบ้าง",
  "ระบบนี้รองรับผู้ใช้หลายคนพร้อมกัน",
  "กดปุ่มเปิดใช้งานแล้วรอสักครู่",
  "ติดตังโปรแกรมผิดพลาดเพราะวรรณยุกต์ไม่ตรง",
  "เริ่มต้นระบบใหม่หลังกู้คืนจากสำรอง",
  "แปลงข้อมูลแล้วย้ายไปยังตารางใหม่",
  "เรียกใช้ฟังก์ชันตรวจสอบก่อนเขียนลงฐานข้อมูล",
  "อนุญาตให้ผู้ใช้แก้ไขข้อมูลของตัวเองเท่านั้น",

  // --- Thai + English mixed ----------------------------------------------
  "deploy ขึ้นเซิร์ฟเวอร์ใหม่",
  "install แพ็กเกจนี้ด้วย pnpm",
  "backup ฐานข้อมูลก่อน upgrade",
  "server ล่มต้อง restart ด่วน",
  "test เคสนี้ด้วย node --test",
  "memory leak เกิดจาก cache ไม่ถูก clear",
  "config ไฟล์อยู่ที่ /etc/app/config.json",
  "debug ด้วยการเพิ่ม log ในฟังก์ชัน",
  "ติดตั้ง dependency แล้วรัน build",
  "อัปเดต version ใน package.json",
  "search หา error ใน database log",
  "save ข้อมูลลงไฟล์ backup ทุกชั่วโมง",
  "delete แถวที่ซ้ำในตาราง users",
  "project นี้ใช้ TypeScript กับ Node 22",
  "repository อยู่บน GitHub ชื่อ th-memory-mcp",
  "ติดตั้ง plugin แล้วเปิดใช้งานใน opencode",
  "query นี้ช้าเพราะไม่มี index ในฐานข้อมูล",

  // --- English only ------------------------------------------------------
  "deploy the server to production",
  "install package and run tests",
  "backup database before migration",
  "hello world",
  "The quick brown fox jumps over the lazy dog",
  "node --version && npm --version",
  "SELECT * FROM memories WHERE id = 42;",
  "error: ENOENT no such file or directory",
  "config version 2.5.1 test save search",
  "memory repository server database",
  "DEPLOY AND INSTALL THE PACKAGE",
  "  leading and trailing spaces  ",
  "double  spaces   here",

  // --- digits / punctuation / symbols ------------------------------------
  "123 456 789",
  "3.14159 / 2 = 1.5708",
  "!@#$%^&*()_+-=[]{}|;':\",./<>?",
  "50% off — ราคา 199 บาท",
  "v2.5.1-beta.3+build.2026",
  "a1b2c3d4e5f6",
  "2026-11-12T00:00:00Z",

  // --- curated synonyms, TH side (each is split by the segmenter, so the
  //     Thai-run join channel is what fires) ------------------------------
  "ติดตั้ง",
  "ดีพลอย",
  "เซิร์ฟเวอร์",
  "ฐานข้อมูล",
  "สำรอง",
  "บันทึก",
  "โปรเจกต์",
  "เวอร์ชัน",
  "เทสต์",
  "ความจำ",
  "หน่วยความจำ",
  "ข้อผิดพลาด",
  "รีโพสิทอรี",
  "แพ็กเกจ",
  "คอนฟิก",
  "ดีบั๊ก",
  "ค้นหา",
  "ลบ",
  "โหนด",
  "รีโพ",

  // --- curated synonyms, EN side (strict single-token channel) -----------
  "deploy",
  "install",
  "server",
  "database",
  "backup",
  "save",
  "project",
  "version",
  "test",
  "memory",
  "repository",
  "package",
  "debug",
  "config",
  "error",
  "search",
  "delete",
  "node",

  // --- repeats and whitespace shapes -------------------------------------
  "ติดตั้ง ติดตั้ง ติดตั้ง",
  "deploy deploy deploy ดีพลอย ดีพลอย",
  "ติดตั้ง    โปรแกรม",
  "\tติดตั้ง\nโปรแกรม\t",
  "  ดีพลอย  ",
  "   ",
  "",
  "ดีพลอยติดตั้งดีพลอยติดตั้ง",

  // --- emoji / astral ----------------------------------------------------
  "👨‍👩‍👧‍👦 deploy 🚀",
  "🚀 ติดตั้ง 🎉 ดีพลอย 🔥",
  "👩‍💻 ฐานข้อมูล 🧠 ความจำ",
  "𝕳𝖊𝖑𝖑𝖔 🅳🅴🅿🅻🅾🆈",
  "🇹🇭 ประเทศไทย",

  // --- single characters -------------------------------------------------
  "ก",
  "a",
  "1",
  "่",
  "🚀",

  // --- long inputs -------------------------------------------------------
  LONG_THAI_PROSE,
  `${LONG_THAI_PROSE} ${LONG_THAI_PROSE}`,
  LONG_THAI_RUN,
  `${LONG_THAI_RUN} deploy ${LONG_THAI_RUN}`,
  "deploy ".repeat(40).trim(),
  "ติดตั้ง ".repeat(40).trim(),
];

// ===========================================================================
// Helpers
// ===========================================================================
function splitThaiRuns(payload) {
  const tokens = payload.split(/\s+/).filter(Boolean);
  const runs = [];
  let run = null;
  for (const tok of tokens) {
    if (THAI_CHAR_RE.test(tok)) {
      run = run ?? [];
      run.push(tok);
    } else if (run) {
      runs.push(run);
      run = null;
    }
  }
  if (run) runs.push(run);
  return runs;
}

function maxThaiKeyLen() {
  let max = 0;
  for (const [, th] of THAI_SYNONYMS) {
    if (th.length > max) max = th.length;
  }
  return max;
}

function vectorBytes(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

after(() => {
  // Leave the module-level segmenter state exactly as found.
  resetSegmenter();
  legacySegment.resetSegmenter();
});

// ===========================================================================
// Tests
// ===========================================================================

test("corpus covers the required shapes (>= 60 entries)", () => {
  assert.ok(
    CORPUS.length >= 60,
    `corpus must hold at least 60 strings, got ${CORPUS.length}`
  );
  const has = (re) => CORPUS.some((s) => re.test(s));
  assert.ok(has(/[\u0E48-\u0E4D]/), "tone marks");
  assert.ok(has(/[A-Za-z]/) && has(/[\u0E00-\u0E7F]/), "TH+EN mixed");
  assert.ok(CORPUS.some((s) => /^[A-Za-z0-9 .:/=&;'"%+-]+$/.test(s)), "English only");
  assert.ok(has(/[0-9]/) && has(/[!@#$%^&*()[\]{}]/), "digits/punctuation");
  assert.ok(CORPUS.includes(""), "empty string");
  assert.ok(CORPUS.includes("ก"), "single character");
  assert.ok(has(/[\u{1F300}-\u{1FAFF}]/u), "emoji");
  assert.ok(has(/[\u{1D500}-\u{1D5FF}]/u), "astral (non-emoji) code points");
  assert.ok(CORPUS.some((s) => s.length > 300), "long input");
  assert.ok(has(/ {2,}/), "double spaces");
  assert.ok(has(/^ | $/), "leading/trailing spaces");
});

test("segmentForIndex is byte-identical to the pre-change implementation", () => {
  for (let i = 0; i < CORPUS.length; i++) {
    const input = CORPUS[i];
    const actual = segmentForIndex(input);
    const expected = legacySegment.segmentForIndex(input);
    assert.equal(
      actual,
      expected,
      `segmentForIndex mismatch at corpus[${i}] ${JSON.stringify(input)}`
    );
  }
});

test("looseForm is byte-identical to the pre-change implementation", () => {
  for (let i = 0; i < CORPUS.length; i++) {
    const input = CORPUS[i];
    const actual = looseForm(input);
    const expected = legacySegment.looseForm(input);
    assert.equal(
      actual,
      expected,
      `looseForm mismatch at corpus[${i}] ${JSON.stringify(input)}`
    );
  }
});

test("expandIndexedText is byte-identical for raw and segmented input", () => {
  for (let i = 0; i < CORPUS.length; i++) {
    const input = CORPUS[i];
    const segmented = segmentForIndex(input);
    // Raw input: both implementations re-segment their own candidates.
    assert.equal(
      expandIndexedText(input),
      legacySynonyms.expandIndexedText(input),
      `expandIndexedText(raw) mismatch at corpus[${i}] ${JSON.stringify(input)}`
    );
    // The real index path: the segmentForIndex payload feeds expandIndexedText.
    const actual = expandIndexedText(segmented);
    const expected = legacySynonyms.expandIndexedText(
      legacySegment.segmentForIndex(input)
    );
    assert.equal(
      actual,
      expected,
      `expandIndexedText(segmented) mismatch at corpus[${i}] ${JSON.stringify(
        input
      )}`
    );
  }
});

test("embed is element-for-element and byte-for-byte identical (512 dims)", () => {
  for (let i = 0; i < CORPUS.length; i++) {
    const input = CORPUS[i];
    const actual = embed(input);
    const expected = legacyEmbed.embed(input);
    assert.equal(actual.length, EMBED_DIM);
    assert.equal(expected.length, EMBED_DIM);
    for (let d = 0; d < EMBED_DIM; d++) {
      assert.ok(
        Object.is(actual[d], expected[d]),
        `embed dim ${d} mismatch at corpus[${i}] ${JSON.stringify(
          input
        )}: ${actual[d]} !== ${expected[d]}`
      );
    }
    assert.ok(
      vectorBytes(actual).equals(vectorBytes(expected)),
      `embed bytes mismatch at corpus[${i}] ${JSON.stringify(input)}`
    );
  }
});

test("expandIndexedText and looseForm are idempotent on every entry", () => {
  const nonIdempotent = [];
  for (let i = 0; i < CORPUS.length; i++) {
    const input = CORPUS[i];
    const segmented = segmentForIndex(input);
    const once = expandIndexedText(segmented);
    const twice = expandIndexedText(once);
    if (twice !== once) {
      // Known pre-existing exception (see the dedicated test below): a
      // one-to-many curated pair can append a second counterpart on the second
      // pass. Tolerate it only when the pre-change implementation does exactly
      // the same and the payload is stable from the second pass on.
      const legacyOnce = legacySynonyms.expandIndexedText(
        legacySegment.segmentForIndex(input)
      );
      const legacyTwice = legacySynonyms.expandIndexedText(legacyOnce);
      assert.equal(
        twice,
        legacyTwice,
        `non-idempotency differs from the pre-change implementation at corpus[${i}] ${JSON.stringify(
          input
        )}`
      );
      assert.equal(
        expandIndexedText(twice),
        twice,
        `second pass is not a fixed point at corpus[${i}] ${JSON.stringify(
          input
        )}`
      );
      nonIdempotent.push(input);
    }
    // Raw (unsegmented) input is not this function's contract — the indexer
    // always passes a segmentForIndex payload — and it is not a fixed point in
    // the pre-change implementation either, so only equivalence is asserted
    // there (see the byte-identity test above).
    const loose = looseForm(input);
    assert.equal(
      looseForm(loose),
      loose,
      `looseForm not idempotent at corpus[${i}] ${JSON.stringify(input)}`
    );
  }
  assert.ok(
    nonIdempotent.length <= 6,
    `expected only the known one-to-many corpus entries to be non-idempotent, got ${JSON.stringify(
      nonIdempotent
    )}`
  );
});

test("known pre-existing non-idempotency of one-to-many pairs is unchanged", () => {
  // FINDING (pre-existing, identical before and after TASK-PERF-COMPUTE): the
  // curated layer is one-to-many on the EN side — memory → [ความจำ,
  // หน่วยความจำ] and repository → [รีโพสิทอรี, รีโพ] — while each TH side maps
  // back only to the EN term. A payload holding one TH variant therefore
  // appends the EN term on pass 1, and the now-present EN *token* makes pass 2
  // append the missing sibling. The doc comment in thai-synonyms.ts claims a
  // single pass is a fixed point; for these pairs pass 2 is. Both the pre-change
  // and the current implementation agree on every pass, so this task changes
  // nothing here.
  const cases = [
    ["ความจำ", " ความ จำ ", " ความ จำ memory", " ความ จำ memory หน่วย ความ จำ"],
    [
      "รีโพสิทอรี",
      " รี โพ สิ ทอ รี ",
      " รี โพ สิ ทอ รี repository",
      " รี โพ สิ ทอ รี repository รีโพ",
    ],
    ["รีโพ", " รีโพ ", " รีโพ repository", " รีโพ repository รี โพ สิ ทอ รี"],
  ];
  for (const [input, segmented, onceExpected, twiceExpected] of cases) {
    assert.equal(segmentForIndex(input), segmented);
    const once = expandIndexedText(segmented);
    assert.equal(once, onceExpected, `first pass differs for ${input}`);
    const twice = expandIndexedText(once);
    assert.equal(twice, twiceExpected, `second pass differs for ${input}`);
    assert.equal(expandIndexedText(twice), twice, `no fixed point for ${input}`);

    const legacyOnce = legacySynonyms.expandIndexedText(
      legacySegment.segmentForIndex(input)
    );
    assert.equal(legacyOnce, once, `pre-change first pass differs for ${input}`);
    assert.equal(
      legacySynonyms.expandIndexedText(legacyOnce),
      twice,
      `pre-change second pass differs for ${input}`
    );
  }
});

test("segmentForIndex is idempotent (memo warm and cold agree)", () => {
  for (let i = 0; i < CORPUS.length; i++) {
    const input = CORPUS[i];
    const once = segmentForIndex(input);
    // Cold call already happened above; this hits the memo for short inputs.
    const twice = segmentForIndex(input);
    assert.equal(twice, once, `memo mismatch at corpus[${i}]`);
    assert.equal(
      segmentForIndex(once),
      once,
      `segmentForIndex not idempotent at corpus[${i}] ${JSON.stringify(input)}`
    );
    assert.equal(
      legacySegment.segmentForIndex(once),
      once,
      `legacy segmentForIndex not idempotent at corpus[${i}]`
    );
  }
});

test("corpus actually exercises synonym appends (strict + Thai-run join)", () => {
  const appended = CORPUS.filter(
    (s) => expandIndexedText(segmentForIndex(s)).length > segmentForIndex(s).length
  );
  assert.ok(
    appended.length >= 30,
    `expected >= 30 corpus entries to append a synonym, got ${appended.length}`
  );

  // Strict single-token channel (English key → Thai counterpart), appended in
  // its segmented form so it stays one-token-per-word.
  assert.equal(
    expandIndexedText(segmentForIndex("deploy")),
    "deploy ดี พลอย"
  );
  // Thai-run join channel: "ติดตั้ง" is split into ติด + ตั้ง, so no single
  // token matches a key — only the re-joined run does.
  const segmented = segmentForIndex("ติดตั้ง");
  assert.equal(segmented, " ติด ตั้ง ");
  assert.equal(expandIndexedText(segmented), " ติด ตั้ง install");
  assert.equal(
    expandIndexedText(segmentForIndex("ดีพลอย")),
    " ดี พลอย deploy"
  );
  // The same call in the old implementation agrees on both channels.
  for (const s of ["deploy", "ติดตั้ง", "ดีพลอย", "ฐานข้อมูล", "memory"]) {
    assert.equal(
      expandIndexedText(segmentForIndex(s)),
      legacySynonyms.expandIndexedText(legacySegment.segmentForIndex(s)),
      `append channel mismatch for ${JSON.stringify(s)}`
    );
  }
});

test("long Thai run exercises the join.length > maxThaiKeyLen break", () => {
  const keyMax = maxThaiKeyLen();
  assert.ok(keyMax > 0, "expected at least one Thai synonym key");

  // Longest contiguous Thai token run over the segmented payloads.
  let maxRun = 0;
  let longest = "";
  for (const s of CORPUS) {
    for (const run of splitThaiRuns(segmentForIndex(s))) {
      if (run.length > maxRun) {
        maxRun = run.length;
        longest = run.join(" ");
      }
    }
  }
  assert.ok(
    maxRun > 10,
    `expected a Thai run longer than 10 tokens, longest was ${maxRun}: ${longest}`
  );

  // Count joins the new implementation skipped because the accumulator passed
  // the longest Thai key. > 0 proves the break branch runs on this corpus.
  let skipped = 0;
  for (const s of CORPUS) {
    for (const run of splitThaiRuns(segmentForIndex(s))) {
      if (run.length > 40) continue; // THAI_SUBSEQ_CAP guard, same in both
      for (let start = 0; start < run.length; start++) {
        let join = "";
        for (let end = start; end < run.length; end++) {
          join += run[end];
          if (join.length > keyMax) {
            skipped += 1;
            break;
          }
        }
      }
    }
  }
  assert.ok(skipped > 0, "corpus never trips the maxThaiKeyLen break");

  // ...and the long-run payload still matches the old implementation exactly,
  // including every append the old loop made before extending past the bound.
  for (const s of [LONG_THAI_RUN, `${LONG_THAI_RUN} deploy ${LONG_THAI_RUN}`]) {
    const seeded = segmentForIndex(s);
    assert.equal(
      expandIndexedText(seeded),
      legacySynonyms.expandIndexedText(seeded)
    );
  }
});

test("dictionary fallback path (no Intl.Segmenter) stays equivalent", () => {
  forceSegmenter(null);
  legacySegment.forceSegmenter(null);
  try {
    for (let i = 0; i < CORPUS.length; i++) {
      const input = CORPUS[i];
      const segmented = segmentForIndex(input);
      assert.equal(
        segmented,
        legacySegment.segmentForIndex(input),
        `fallback segmentForIndex mismatch at corpus[${i}] ${JSON.stringify(
          input
        )}`
      );
      assert.equal(
        looseForm(input),
        legacySegment.looseForm(input),
        `fallback looseForm mismatch at corpus[${i}]`
      );
      assert.equal(
        expandIndexedText(segmented),
        legacySynonyms.expandIndexedText(
          legacySegment.segmentForIndex(input)
        ),
        `fallback expandIndexedText mismatch at corpus[${i}] ${JSON.stringify(
          input
        )}`
      );
      assert.ok(
        vectorBytes(embed(input)).equals(vectorBytes(legacyEmbed.embed(input))),
        `fallback embed mismatch at corpus[${i}] ${JSON.stringify(input)}`
      );
    }
  } finally {
    resetSegmenter();
    legacySegment.resetSegmenter();
  }
});
