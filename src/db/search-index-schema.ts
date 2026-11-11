// Single source of truth for the search_index DDL. Imported by both
// db/index.ts (fresh databases) and db/migrations.ts (rebuild), because
// db/index.ts imports migrations.ts and the DDL cannot live there without a
// circular import.
//
// Tokenizer choice: the default unicode61 tokenizer treats Unicode category M
// (Thai combining marks — vowels/tone marks U+0E31..U+0E4E) as separators, so
// a Thai word such as "ติดตั้ง" was split into consonant fragments. Adding
// `M*` keeps marks inside tokens, so a whole segmented Thai word becomes one
// token and tone marks stay significant ("ติดตัง" does not match "ติดตั้ง").
//
// The `categories` directive REPLACES the default category list, so `L* N* Co`
// must stay in the directive (letters, numbers, private use). FTS5 cannot
// change a tokenizer in place; migrations rebuild the table instead.
export const SEARCH_INDEX_DDL = `CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  ref_table, ref_id, title, body,
  tokenize = "unicode61 categories 'L* N* Co M*'"
);`;

// LOOSE fallback channel (TASK-THAI-LOOSE): same columns, same mark-aware
// tokenizer, but rows store the de-accented looseForm() of the segmented text,
// so a tone-mark typo (ติดตัง) can still match a correctly-marked document
// (ติดตั้ง) — always ranked BELOW the strict channel. Derived from
// SEARCH_INDEX_DDL by renaming only the table, so the tokenizer stays in
// lockstep with the strict index forever.
export const SEARCH_INDEX_LOOSE_DDL = SEARCH_INDEX_DDL.replace(
  "CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(",
  "CREATE VIRTUAL TABLE IF NOT EXISTS search_index_loose USING fts5("
);

// TASK-PERF-WRITE: FTS5 virtual tables have no secondary index, so
// `DELETE FROM search_index WHERE ref_table = ? AND ref_id = ?` is a full
// table scan (10.6 ms at 20k rows) and made every write O(n). This side table
// maps (ref_table, ref_id) -> the FTS rowids, so writes become
// `UPDATE/DELETE ... WHERE rowid = ?` (a point lookup). The PRIMARY KEY is a
// plain B-tree unique index, which is what gives the O(log n) ref lookup.
// Deliberately NOT WITHOUT ROWID: the table is tiny and the rowid is free.
//
// NOTE for future migrations: any migration that rebuilds `search_index` or
// `search_index_loose` (DROP/recreate, e.g. the M010/M012/M013 pattern) MUST
// also rebuild `search_index_keys`, because the FTS rowids it stores become
// stale the moment the virtual tables are recreated.
export const SEARCH_INDEX_KEYS_DDL = `CREATE TABLE IF NOT EXISTS search_index_keys (
  ref_table TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  strict_rowid INTEGER NOT NULL,
  loose_rowid INTEGER NOT NULL,
  PRIMARY KEY (ref_table, ref_id)
);`;
