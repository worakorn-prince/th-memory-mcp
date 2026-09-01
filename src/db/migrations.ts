import type BetterSqlite3 from "better-sqlite3";
import { copyFileSync, readdirSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { embed, serialize } from "../lib/embed.js";

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

export const MIGRATIONS: Migration[] = [
  M001_schema_meta,
  M002_memories,
  M003_entities_relations,
  M004_memory_links,
  M005_backfill_v1,
  M006_scope,
  M007_user,
];

const KEEP_BACKUPS = 5;

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
    try {
      const dbPath = (db as unknown as { name: string }).name;
      if (dbPath && dbPath !== ":memory:") {
        const backupPath = `${dbPath}.backup-${Date.now()}`;
        try {
          copyFileSync(dbPath, backupPath);
        } catch {
          console.error("[migrations] failed to create backup, aborting");
          return;
        }
        pruneOldBackups(dbPath);
      }
    } catch {}
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
