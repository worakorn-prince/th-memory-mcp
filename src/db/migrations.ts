import type BetterSqlite3 from "better-sqlite3";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { embed, serialize } from "../lib/embed.js";
import { segmentForIndex, looseForm } from "../lib/thai-segment.js";
import { expandIndexedText } from "../lib/thai-synonyms.js";
import { SEARCH_INDEX_DDL, SEARCH_INDEX_LOOSE_DDL } from "./search-index-schema.js";

type DB = BetterSqlite3.Database;

interface Migration {
  id: string;
  up(db: DB): void;
}

const M001_schema_meta: Migration = {
  id: "001_schema_meta",
  up(db) {
    db.exec(
      `CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`
    );
    const existing = db
      .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    if (!existing) {
      db.prepare(
        "INSERT INTO schema_meta (key, value) VALUES ('schema_version', '2')"
      ).run();
    }
  },
};

const M002_memories: Migration = {
  id: "002_memories",
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      source TEXT NOT NULL DEFAULT 'explicit',
      confidence REAL NOT NULL DEFAULT 0.5,
      importance REAL NOT NULL DEFAULT 0.5,
      salience REAL NOT NULL DEFAULT 0.5,
      project_id TEXT,
      session_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_accessed_at TEXT,
      access_count INTEGER NOT NULL DEFAULT 0,
      valid_from TEXT,
      valid_until TEXT,
      supersedes_id INTEGER,
      metadata TEXT,
      FOREIGN KEY (supersedes_id) REFERENCES memories(id)
    );`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_memories_type_status ON memories(type, status);`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_memories_project_status ON memories(project_id, status);`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at);`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_memories_validity ON memories(valid_from, valid_until);`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_memories_supersedes ON memories(supersedes_id);`
    );
  },
};

const M003_entities_relations: Migration = {
  id: "003_entities_relations",
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      canonical_name TEXT NOT NULL,
      type TEXT,
      metadata TEXT
    );`);
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_canonical ON entities(canonical_name);`
    );
    db.exec(`CREATE TABLE IF NOT EXISTS relations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_entity_id INTEGER NOT NULL,
      relation TEXT NOT NULL,
      target_entity_id INTEGER NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      valid_from TEXT,
      valid_until TEXT,
      source_memory_id INTEGER,
      metadata TEXT,
      FOREIGN KEY (source_entity_id) REFERENCES entities(id),
      FOREIGN KEY (target_entity_id) REFERENCES entities(id),
      FOREIGN KEY (source_memory_id) REFERENCES memories(id)
    );`);
  },
};

const M004_memory_links: Migration = {
  id: "004_memory_links",
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS memory_links (
      source_memory_id INTEGER NOT NULL,
      relation TEXT NOT NULL,
      target_memory_id INTEGER NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL,
      PRIMARY KEY (source_memory_id, relation, target_memory_id),
      FOREIGN KEY (source_memory_id) REFERENCES memories(id),
      FOREIGN KEY (target_memory_id) REFERENCES memories(id)
    );`);
  },
};

const M005_backfill_v1: Migration = {
  id: "005_backfill_v1",
  up(db) {
    const done = db
      .prepare("SELECT value FROM schema_meta WHERE key = 'v1_backfilled'")
      .get() as { value: string } | undefined;
    if (done) return;
    const memCount = (
      db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number }
    ).c;
    if (memCount > 0) {
      db.prepare(
        "INSERT INTO schema_meta (key, value) VALUES ('v1_backfilled', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
      ).run();
      return;
    }
    const now = new Date().toISOString();
    const insertSearch = db.prepare(
      "INSERT INTO search_index (ref_table, ref_id, title, body) VALUES ('memories', ?, ?, ?)"
    );
    const insertEmbed = db.prepare(
      "INSERT INTO embeddings (ref_table, ref_id, vec) VALUES ('memories', ?, ?) ON CONFLICT(ref_table, ref_id) DO UPDATE SET vec = excluded.vec"
    );
    const insPref = db.prepare(
      `INSERT INTO memories (type, content, status, source, confidence, project_id, created_at, updated_at, metadata)
       VALUES ('PREFERENCE', @content, 'active', @source, @confidence, NULL, @ts, @ts, NULL)`
    );
    const insLes = db.prepare(
      `INSERT INTO memories (type, content, status, source, confidence, project_id, created_at, updated_at, metadata)
       VALUES ('LESSON', @content, 'active', 'corrected', 0.95, NULL, @ts, @ts, NULL)`
    );
    const tx = db.transaction(() => {
      const prefs = db
        .prepare(
          "SELECT category, key, value, source, confidence, updated_at FROM preferences"
        )
        .all() as Array<{
        category: string;
        key: string;
        value: string;
        source: string | null;
        confidence: number | null;
        updated_at: string | null;
      }>;
      for (const p of prefs) {
        const content = `[${p.category}] ${p.key} = ${p.value}`;
        const info = insPref.run({
          content,
          source: p.source ?? "explicit",
          confidence: p.confidence ?? 0.5,
          ts: p.updated_at ?? now,
        });
        const id = Number(info.lastInsertRowid);
        insertSearch.run(id, p.category, content);
        insertEmbed.run(id, serialize(embed(content)));
      }
      const lessons = db
        .prepare("SELECT situation, mistake, correction, created_at FROM lessons")
        .all() as Array<{
        situation: string;
        mistake: string;
        correction: string;
        created_at: string | null;
      }>;
      for (const l of lessons) {
        const content = `Situation: ${l.situation} | Mistake: ${l.mistake} | Correction: ${l.correction}`;
        const info = insLes.run({ content, ts: l.created_at ?? now });
        const id = Number(info.lastInsertRowid);
        insertSearch.run(id, "LESSON", content);
        insertEmbed.run(id, serialize(embed(content)));
      }
    });
    tx();
    db.prepare(
      "INSERT INTO schema_meta (key, value) VALUES ('v1_backfilled', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
    ).run();
  },
};

const M006_scope: Migration = {
  id: "006_scope",
  up(db) {
    db.exec(`ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'GLOBAL';`);
    db.exec(`UPDATE memories SET scope = 'SESSION' WHERE session_id IS NOT NULL;`);
    db.exec(
      `UPDATE memories SET scope = 'PROJECT' WHERE session_id IS NULL AND project_id IS NOT NULL;`
    );
    db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope);`);
  },
};

const M007_user: Migration = {
  id: "007_user",
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT NOT NULL UNIQUE,
      name TEXT,
      created_at TEXT NOT NULL
    );`);
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_users_external ON users(external_id);`
    );
    db.exec(`ALTER TABLE memories ADD COLUMN user_id INTEGER REFERENCES users(id);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);`);
  },
};

const M008_perf_indexes: Migration = {
  id: "008_perf_indexes",
  up(db) {
    // Idempotent: IF NOT EXISTS only, never touches old migrations.
    // Covers consolidation/dedup filters: memories(status,scope,project_id)
    // and memory_links(source,target) lookups (forward + reverse).
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_memories_status_scope_project ON memories(status, scope, project_id);`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_memory_links_source_target ON memory_links(source_memory_id, target_memory_id);`
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_memory_links_target ON memory_links(target_memory_id);`
    );
  },
};

// Batch A-3: unique guard for relations (M003 declared FKs but no uniqueness,
// so re-imports / repeated extraction could accumulate identical rows).
// Idempotent: dedupes legacy duplicates first (keep MIN(id) per group), then
// creates the index with IF NOT EXISTS. Old migrations are NOT edited.
const M009_relations_unique: Migration = {
  id: "009_relations_unique",
  up(db) {
    db.exec(`
      DELETE FROM relations WHERE id NOT IN (
        SELECT MIN(id) FROM relations
        GROUP BY source_entity_id, relation, target_entity_id, COALESCE(source_memory_id, -1)
      );`);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_relations_unique
      ON relations(source_entity_id, relation, target_entity_id, COALESCE(source_memory_id, -1));`);
  },
};

// FTS5 cannot change the tokenizer of an existing table, so this migration
// rebuilds search_index with the mark-aware tokenizer from
// search-index-schema.ts and re-segments every Thai row on the way through.
// Rows are copied into a TEMP table and read back in bounded batches, so a
// large index is never loaded into JS memory. (better-sqlite3 refuses to run
// an INSERT while an iterate() cursor is open on the same connection, hence
// rowid paging instead of a single iterator.) Idempotent: segmentForIndex is
// byte-idempotent and the table is always rebuilt from its own contents.
// Old migrations are NOT edited (see M009) — this rebuild covers M005 rows.
const M010_search_index_thai: Migration = {
  id: "010_search_index_thai",
  up(db) {
    // IF NOT EXISTS: a fresh or partially-migrated DB may lack the source.
    db.exec(SEARCH_INDEX_DDL);
    db.exec("DROP TABLE IF EXISTS temp._fts_rebuild;");
    db.exec(
      "CREATE TEMP TABLE _fts_rebuild AS SELECT ref_table, ref_id, title, body FROM search_index;"
    );
    db.exec("DROP TABLE IF EXISTS search_index;");
    db.exec(SEARCH_INDEX_DDL);
    const insert = db.prepare(
      "INSERT INTO search_index (ref_table, ref_id, title, body) VALUES (?, ?, ?, ?)"
    );
    const batch = db.prepare(
      `SELECT rowid AS rid, ref_table, ref_id, title, body
       FROM temp._fts_rebuild WHERE rowid > ? ORDER BY rowid LIMIT 200`
    );
    let lastRowid = 0;
    for (;;) {
      const rows = batch.all(lastRowid) as Array<{
        rid: number;
        ref_table: string;
        ref_id: number;
        title: string | null;
        body: string | null;
      }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        insert.run(
          row.ref_table,
          row.ref_id,
          segmentForIndex(row.title ?? ""),
          segmentForIndex(row.body ?? "")
        );
        lastRowid = row.rid;
      }
    }
    db.exec("DROP TABLE IF EXISTS temp._fts_rebuild;");
  },
};

// EMBED's tokenizer changed to segment Thai runs into word tokens
// (TASK-THAI-EMBED), so every stored vector is stale the moment this ships.
// Recompute each embedding row from its source row (memories.content,
// preferences.category/key/value, lessons.situation/mistake/correction) with
// the new embed(). Mirrors M010's batched, idempotent, row-count-preserving
// style: page over embeddings by rowid in bounded batches and recompute in
// place via UPSERT on the PK (ref_table, ref_id), so no row is dropped or
// duplicated and the count is preserved. embed() is deterministic, so a
// re-run yields byte-identical vectors. A row whose source is missing is left
// untouched (it cannot be recomputed) — which also preserves the count.
// Old migrations are NOT edited.
const M011_embeddings_segmenter: Migration = {
  id: "011_embeddings_segmenter",
  up(db) {
    const memSource = db.prepare("SELECT content FROM memories WHERE id = ?");
    const prefSource = db.prepare(
      "SELECT category, key, value FROM preferences WHERE id = ?"
    );
    const lessonSource = db.prepare(
      "SELECT situation, mistake, correction FROM lessons WHERE id = ?"
    );
    const batch = db.prepare(
      `SELECT rowid AS rid, ref_table, ref_id
       FROM embeddings WHERE rowid > ? ORDER BY rowid LIMIT 200`
    );
    const upsert = db.prepare(
      `INSERT INTO embeddings (ref_table, ref_id, vec) VALUES (?, ?, ?)
       ON CONFLICT(ref_table, ref_id) DO UPDATE SET vec = excluded.vec`
    );
    let lastRowid = 0;
    for (;;) {
      const rows = batch.all(lastRowid) as Array<{
        rid: number;
        ref_table: string;
        ref_id: number;
      }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        lastRowid = row.rid;
        let source: string | null = null;
        if (row.ref_table === "memories") {
          const r = memSource.get(row.ref_id) as
            | { content: string }
            | undefined;
          source = r ? r.content : null;
        } else if (row.ref_table === "preferences") {
          const r = prefSource.get(row.ref_id) as
            | { category: string; key: string; value: string }
            | undefined;
          // Mirrors remember.ts / import apply: `${category} ${key} ${value}`.
          source = r ? `${r.category} ${r.key} ${r.value}` : null;
        } else if (row.ref_table === "lessons") {
          const r = lessonSource.get(row.ref_id) as
            | { situation: string; mistake: string; correction: string }
            | undefined;
          // Mirrors lesson.ts: `${situation} ${mistake} ${correction}`.
          source = r ? `${r.situation} ${r.mistake} ${r.correction}` : null;
        }
        if (source == null) continue;
        upsert.run(row.ref_table, row.ref_id, serialize(embed(source)));
      }
    }
  },
};

// SYN adds transliteration synonyms (TASK-THAI-SYN) on BOTH index and query
// sides. Existing search_index rows were written by the pre-synonym writer, so
// they must be rebuilt with the new index-writing logic to carry the appended
// transliteration tokens. Mirrors M010's batched, temp-table, rowid-paging,
// row-count-preserving style: the rebuild re-reads the CURRENT indexed text
// (already segmented by M010) through segmentForIndex (a byte-idempotent no-op
// here) and expandIndexedText (idempotent fixed point), so re-running the
// migration yields byte-identical rows and the same row count. The mark-aware
// tokenizer DDL from search-index-schema.ts is preserved (SEARCH_INDEX_DDL).
// Old migrations are NOT edited.
const M012_search_index_synonyms: Migration = {
  id: "012_search_index_synonyms",
  up(db) {
    db.exec(SEARCH_INDEX_DDL);
    db.exec("DROP TABLE IF EXISTS temp._fts_syn_rebuild;");
    db.exec(
      "CREATE TEMP TABLE _fts_syn_rebuild AS SELECT ref_table, ref_id, title, body FROM search_index;"
    );
    db.exec("DROP TABLE IF EXISTS search_index;");
    db.exec(SEARCH_INDEX_DDL);
    const insert = db.prepare(
      "INSERT INTO search_index (ref_table, ref_id, title, body) VALUES (?, ?, ?, ?)"
    );
    const batch = db.prepare(
      `SELECT rowid AS rid, ref_table, ref_id, title, body
       FROM temp._fts_syn_rebuild WHERE rowid > ? ORDER BY rowid LIMIT 200`
    );
    let lastRowid = 0;
    for (;;) {
      const rows = batch.all(lastRowid) as Array<{
        rid: number;
        ref_table: string;
        ref_id: number;
        title: string | null;
        body: string | null;
      }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        lastRowid = row.rid;
        insert.run(
          row.ref_table,
          row.ref_id,
          expandIndexedText(segmentForIndex(row.title ?? "")),
          expandIndexedText(segmentForIndex(row.body ?? ""))
        );
      }
    }
    db.exec("DROP TABLE IF EXISTS temp._fts_syn_rebuild;");
  },
};

// LOOSE channel (TASK-THAI-LOOSE): build the de-accented search_index_loose
// table from the current search_index rows. Each search_index row already
// carries the canonical strict payload (expandIndexedText(segmentForIndex(...))),
// so the loose row is looseForm() of it — exactly what the dual-write write
// path (syncSearchIndex) produces, keeping the index and query sides in
// lockstep. Mirrors M010/M012's batched, temp-table, rowid-paging,
// row-count-preserving style. Idempotent: looseForm is idempotent and
// search_index is unchanged by this migration, so a re-run yields byte-
// identical loose rows and the same row count. The mark-aware tokenizer DDL
// is preserved (SEARCH_INDEX_LOOSE_DDL). Old migrations are NOT edited.
const M013_search_index_loose: Migration = {
  id: "013_search_index_loose",
  up(db) {
    db.exec(SEARCH_INDEX_LOOSE_DDL);
    db.exec("DROP TABLE IF EXISTS temp._fts_loose_rebuild;");
    db.exec(
      "CREATE TEMP TABLE _fts_loose_rebuild AS SELECT ref_table, ref_id, title, body FROM search_index;"
    );
    db.exec("DROP TABLE IF EXISTS search_index_loose;");
    db.exec(SEARCH_INDEX_LOOSE_DDL);
    const insert = db.prepare(
      "INSERT INTO search_index_loose (ref_table, ref_id, title, body) VALUES (?, ?, ?, ?)"
    );
    const batch = db.prepare(
      `SELECT rowid AS rid, ref_table, ref_id, title, body
       FROM temp._fts_loose_rebuild WHERE rowid > ? ORDER BY rowid LIMIT 200`
    );
    let lastRowid = 0;
    for (;;) {
      const rows = batch.all(lastRowid) as Array<{
        rid: number;
        ref_table: string;
        ref_id: number;
        title: string | null;
        body: string | null;
      }>;
      if (rows.length === 0) break;
      for (const row of rows) {
        lastRowid = row.rid;
        insert.run(
          row.ref_table,
          row.ref_id,
          looseForm(row.title ?? ""),
          looseForm(row.body ?? "")
        );
      }
    }
    db.exec("DROP TABLE IF EXISTS temp._fts_loose_rebuild;");
  },
};

export const MIGRATIONS: Migration[] = [
  M001_schema_meta,
  M002_memories,
  M003_entities_relations,
  M004_memory_links,
  M005_backfill_v1,
  M006_scope,
  M007_user,
  M008_perf_indexes,
  M009_relations_unique,
  M010_search_index_thai,
  M011_embeddings_segmenter,
  M012_search_index_synonyms,
  M013_search_index_loose,
];

const KEEP_BACKUPS = 5;

function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export function backupDatabase(db: DB, dbPath: string): string {
  const stem = `${dbPath}.backup-${Date.now()}`;
  let target = stem;
  let counter = 1;
  while (existsSync(target)) {
    target = `${stem}-${counter}`;
    counter += 1;
  }
  try {
    db.exec(`VACUUM INTO '${escapeSqlLiteral(target)}'`);
    return target;
  } catch (e) {
    try {
      if (existsSync(target)) unlinkSync(target);
    } catch {}
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(`migration backup failed for ${dbPath}: ${reason}`);
  }
}

function pruneOldBackups(dbPath: string): void {
  try {
    const dir = dirname(dbPath);
    const base = basename(dbPath);
    const prefix = `${base}.backup-`;
    const entries = readdirSync(dir);
    const backups = entries.filter((n) => n.startsWith(prefix)).sort();
    if (backups.length > KEEP_BACKUPS) {
      for (const name of backups.slice(0, backups.length - KEEP_BACKUPS)) {
        try {
          unlinkSync(join(dir, name));
        } catch {}
      }
    }
  } catch {}
}

export function runMigrations(db: DB): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`
  );
  const pending = MIGRATIONS.filter((m) => {
    const applied = db
      .prepare("SELECT value FROM schema_meta WHERE key = ?")
      .get(m.id) as { value: string } | undefined;
    return !applied;
  });
  if (pending.length === 0) {
    try {
      const dbPath = (db as unknown as { name: string }).name;
      if (dbPath && dbPath !== ":memory:") pruneOldBackups(dbPath);
    } catch {}
    return;
  }
  const shouldBackup =
    process.env.MEMORY_BACKUP_ON_MIGRATE !== "0" &&
    process.env.MEMORY_BACKUP_ON_MIGRATE !== "false";
  if (shouldBackup) {
    const dbPath = (db as unknown as { name: string }).name;
    if (dbPath && dbPath !== ":memory:") {
      // VACUUM INTO produces a consistent snapshot even with pending WAL
      // frames; the helper owns the error message and partial cleanup.
      backupDatabase(db, dbPath);
      pruneOldBackups(dbPath);
    }
  }
  for (const m of pending) {
    const tx = db.transaction(() => {
      m.up(db);
      db.prepare(
        "INSERT INTO schema_meta (key, value) VALUES (?, '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
      ).run(m.id);
    });
    tx();
  }
}
