# thai-fts — Thai tokenize, made copy-able

A small **zero-dependency** surface for dealing with Thai text: word
segmentation, tone-tolerant matching, synonyms, and a standalone CLI. It powers
th-memory-mcp's Thai search, but every bit of it below can be lifted into **any**
Node project without installing anything.

- Problem → [unspaced Thai + combining marks](#the-problem-unspaced-thai--combining-marks)
- Fix → [mark-aware tokenizer + segmentation](#the-two-sided-fix-mark-aware-tokenizer--segmentation)
- [The loose / tone-tolerant channel](#the-loose--tone-tolerant-channel)
- [Synonyms](#synonyms)
- [Personal dictionary](#personal-dictionary-thai_dictthai-dict)
- [Copy the module into your own project](#copy-the-zero-dep-module-into-your-own-project)
- [CLI usage](#cli-usage)

---

## The problem: unspaced Thai + combining marks

English puts spaces between words, so a default text tokenizer can split on
whitespace. Thai does **not**:

> ผมต้องติดตั้งโปรแกรมบนเซิร์ฟเวอร์ใหม่

is many words ("ผม ต้อง ติดตั้ง โปรแกรม บน เซิร์ฟเวอร์ ใหม่") written without
spaces. A naive tokenizer treats the whole clause as one blob — unusable for
search.

On top of that, Thai combines vowels and tone marks onto the consonant glyphs:

> ติดตั้ง  vs  ติดตัง

These differ **only** by tone marks (ระหว่าง ั + ้ in the first, ั in the second),
yet mean very different things ("install" vs "install [a service fee]" in this
pair). A tokenizer that drops combining marks (the default `unicode61` FTS5
configuration treats Unicode category M — vowels/tone marks U+0E31..U+0E4E — as
*separators*) would fragment ติดตั้ง into consonant shards and make these two
spellings collide.

## The two-sided fix: mark-aware tokenizer + segmentation

th-memory-mcp fixes this on both sides of the search path:

1. **Index time — segmentation.** `segmentForIndex()` inserts spaces between
   Thai words, so each word becomes one clean token:
   `ผมต้องติดตั้งโปรแกรม` → `ผม ต้อง ติด ตั้ง โปรแกรม` (exact split depends on
   the runtime's ICU dictionary; the built-in fallback covers the dev/tech
   domain). The added spaces live only in the search index — display always
   reads the source rows, so users never see them.
2. **Query time — phrase.** `buildFtsMatch()` turns each Thai query chunk into
   an FTS5 phrase of its words (`"ติด ตั้ง"`), so the words must appear
   consecutively — the same precision a single English word has.
3. **Storage — mark-aware tokenizer.** The `search_index` FTS5 table uses a
   custom tokenizer with `M*` in the category list, so a segmented Thai word is
   stored **whole** and its tone marks stay significant: `ติดตั้ง` and `ติดตัง`
   are different tokens, and a misspelled query can't surface the correctly
   spelled document.

`wordTokens()` is the single core tokenizer: pure-English text is a plain
whitespace/alpha split, Thai runs go through the segmenter (or the fallback
dictionary), deterministically, never dropping characters.

## The loose / tone-tolerant channel

Sometimes you *want* tone marks ignored — a relaxed, forgive-the-typo fallback.
`looseForm()` strips only tone-level marks (่ ้ ๊ ๋ ์ ํ) and lowercases, keeping
all vowels:

```text
looseForm("ติดตั้ง")  →  "ติดตัง"
looseForm("ติดตั้ง") === looseForm("ติดตัง")  // true
```

That equivalence is used strictly as a **fallback matcher** (never for FTS index
content), so precision search stays tone-exact while relaxed lookup still finds
"good enough" matches.

## Synonyms

`THAI_SYNONYMS` is a curated TH↔EN transliteration/semantic table for the
dev/tech domain (`deploy`↔`ดีพลอย`, `install`↔`ติดตั้ง`, `debug`↔`ดีบั๊ก`, …).
The lookup is **bidirectional** and fires only on whole terms:

```text
expandSynonyms("deploy")   →  ["deploy", "ดีพลอย"]
expandSynonyms("ติดตั้ง")   →  ["ติดตั้ง", "install"]
expandSynonyms("nope")     →  ["nope"]
```

## Personal dictionary: `thai_dict`/thai-dict

Beyond the static tables, users can extend both channels at runtime:

- `kind='synonym'` — an extra TH↔EN transliteration merged into the synonym
  lookup.
- `kind='segment'` — a forced compound the segmenter must keep as **one** token.

Rows live in the SQLite `thai_dict` table (`src/db/thai-dict.ts`), configured
through the server CLI: `th-memory thai-dict list|add --kind <synonym|segment>|rm`.
The pure modules stay DB-free — they expose *provider seams* that the DB layer
wires in — so the copy-able surface described here does not need the database at
all.

## Copy the zero-dep module into your own project

Copy these two files (they import nothing else):

```
src/lib/thai-segment.ts   → your project/src/lib/thai-segment.ts
src/lib/thai-synonyms.ts  → your project/src/lib/thai-synonyms.ts
```

That's it — no `package.json` entry, no npm install, no `node:` imports. A
10-line getting-started snippet:

```ts
import { wordTokens, segmentForIndex, looseForm } from "./lib/thai-segment.js";
import { expandSynonyms } from "./lib/thai-synonyms.js";

const clause = "ผมต้องติดตั้งโปรแกรม";
wordTokens(clause);                      // ["ผม","ต้อง","ติด","ตั้ง","โปรแกรม"] (ICU-dependent)
segmentForIndex(clause);                 // " ผม ต้อง ติด ตั้ง โปรแกรม " (space-delimited)
looseForm("ติดตั้ง");                     // "ติดตัง" — tone-tolerant form
expandSynonyms("deploy");                // ["deploy", "ดีพลอย"]
```

> Tone marks stay significant by default (`looseForm` is opt-in); the exact
> token split of `wordTokens`/`segmentForIndex` depends on whether the runtime
> has a full-ICU `Intl.Segmenter` or falls back to the built-in dictionary —
> but tokens never drop characters, so re-joining them always reproduces the
> input.

## CLI usage

The repo ships a small zero-dependency CLI, `thai-fts`, compiled to
`dist/thai-cli.js` (registered in `package.json` `bin`). Output is line-delimited
and pipe-friendly (no ANSI color).

```
Usage:
  thai-fts segment "<text>"      word tokens (line-delimited)
  thai-fts loose "<text>"        tone-tolerant (de-accented) form
  thai-fts synonyms "<term>"     counterpart matches from THAI_SYNONYMS
  thai-fts check "<text>"        1 if Thai is present, else 0
  thai-fts --json <cmd> "<text>" wrap the output as { ok, data }
  thai-fts --help                show this help
```

Real samples (`npm run build`, then `node dist/thai-cli.js ...`):

```console
$ node dist/thai-cli.js segment "ติดตั้งโปรแกรม"
ติด
ตั้ง
โปรแกรม

$ node dist/thai-cli.js loose "ติดตั้ง"
ติดตัง

$ node dist/thai-cli.js synonyms deploy
ดีพลอย

$ node dist/thai-cli.js check "foo"
0

$ node dist/thai-cli.js check "ติดตั้ง"
1

$ node dist/thai-cli.js --json segment "ติดตั้ง"
{"ok":true,"data":"ติด\nตั้ง"}
```

Installed globally (`npm i -g th-memory-mcp`), `thai-fts` is available on PATH;
from the repo, call `node dist/thai-cli.js` directly. There is no dict/DB
command here on purpose — this CLI stays purely standalone, so shell scripts can
call `thai-fts check "$line"` to gate Thai-only text.
