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
