import Database from 'better-sqlite3';
import { resolve } from 'node:path';

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(resolve(process.cwd(), 'ccweb.db'));
    db.pragma('journal_mode = WAL');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_path TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'idle',
      started_at TEXT NOT NULL,
      last_activity_at TEXT NOT NULL,
      ended_at TEXT,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      sdk_session_id TEXT,
      result_text TEXT,
      error_text TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES sessions(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      metadata TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
  `);

  // Add columns introduced after initial schema. SQLite lacks IF NOT EXISTS for
  // ADD COLUMN, so swallow "duplicate column" errors.
  for (const stmt of [
    `ALTER TABLE sessions ADD COLUMN chat_number INTEGER`,
    `ALTER TABLE sessions ADD COLUMN label TEXT`,
    `ALTER TABLE sessions ADD COLUMN auto_label INTEGER NOT NULL DEFAULT 1`,
  ]) {
    try { db.exec(stmt); } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '';
      if (!/duplicate column/i.test(msg)) console.error('[db] migration failed:', msg);
    }
  }
}

export function closeDb() {
  if (db) db.close();
}
