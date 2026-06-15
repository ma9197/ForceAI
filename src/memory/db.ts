import Database from 'better-sqlite3';
import fs from 'node:fs';
import { DATA_DIR, DB_PATH, STICKER_DIR, AUTH_DIR, IMAGE_DIR } from '../config.js';

export function openDb(): Database.Database {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(STICKER_DIR, { recursive: true });
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.mkdirSync(IMAGE_DIR, { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS members (
      jid               TEXT PRIMARY KEY,
      pn_jid            TEXT,
      display_name      TEXT,
      personality_notes TEXT,
      first_seen        INTEGER,
      last_seen         INTEGER,
      message_count     INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS facts (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid           TEXT,
      member_jid         TEXT REFERENCES members(jid),
      fact               TEXT NOT NULL,
      category           TEXT,
      confidence         REAL,
      source_message_id  TEXT,
      created_at         INTEGER,
      superseded_by      INTEGER,
      UNIQUE(chat_jid, member_jid, fact)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      short_id    TEXT,
      chat_jid    TEXT,
      sender_jid  TEXT,
      sender_name TEXT,
      from_me     INTEGER DEFAULT 0,
      is_bot      INTEGER DEFAULT 0,
      is_owner    INTEGER DEFAULT 0,
      text        TEXT,
      type        TEXT,
      quoted_id   TEXT,
      ts          INTEGER,
      raw         TEXT,
      media_path  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_msg_chat_ts ON messages(chat_jid, ts);

    CREATE TABLE IF NOT EXISTS bot_messages (
      message_id TEXT PRIMARY KEY,
      ts         INTEGER
    );

    CREATE TABLE IF NOT EXISTS stickers (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path   TEXT NOT NULL,
      sha256      TEXT UNIQUE,
      description TEXT,
      usage_hint  TEXT,
      added_at    INTEGER,
      times_used  INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS group_summary (
      chat_jid        TEXT PRIMARY KEY,
      summary         TEXT,
      last_message_ts INTEGER,
      updated_at      INTEGER
    );

    CREATE TABLE IF NOT EXISTS stats (
      key   TEXT PRIMARY KEY,
      value INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ts         INTEGER,
      tier       TEXT,
      decision   TEXT,
      reason     TEXT,
      tokens_in  INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS lid_pn_map (
      lid TEXT PRIMARY KEY,
      pn  TEXT UNIQUE
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS poll_votes (
      poll_id    TEXT,
      voter_jid  TEXT,
      voter_name TEXT,
      options    TEXT,
      ts         INTEGER,
      PRIMARY KEY (poll_id, voter_jid)
    );

    -- voice profiler: per-group learned texting style (phrases, slang, jokes, patterns, per-member style)
    CREATE TABLE IF NOT EXISTS voice_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_jid      TEXT,
      category      TEXT,
      content       TEXT NOT NULL,
      example       TEXT,
      member_jid    TEXT,
      created_at    INTEGER,
      superseded_by INTEGER,
      checked       INTEGER NOT NULL DEFAULT 0, -- 0 = new/unreviewed (shown highlighted), 1 = reviewed by owner
      UNIQUE(chat_jid, category, content)
    );
    CREATE INDEX IF NOT EXISTS idx_voice_chat ON voice_items(chat_jid, superseded_by);
  `);

  // migrations for DBs created before multi-group support
  try { db.exec('ALTER TABLE decisions ADD COLUMN chat_jid TEXT'); } catch { /* column exists */ }
  // local path to a downloaded inbound image (for Claude vision)
  try { db.exec('ALTER TABLE messages ADD COLUMN media_path TEXT'); } catch { /* column exists */ }
  // voice items: owner review flag. Items that predate this column were already in use, so mark
  // them reviewed (only the ALTER's first run executes the UPDATE; later boots throw + skip).
  try {
    db.exec('ALTER TABLE voice_items ADD COLUMN checked INTEGER NOT NULL DEFAULT 0');
    db.exec('UPDATE voice_items SET checked = 1');
  } catch { /* column exists */ }

  // facts: scope per group (chat_jid) with per-group uniqueness — requires a table rebuild
  const factCols = db.prepare("PRAGMA table_info(facts)").all() as { name: string }[];
  if (!factCols.some(c => c.name === 'chat_jid')) {
    db.exec(`
      CREATE TABLE facts_new (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_jid           TEXT,
        member_jid         TEXT REFERENCES members(jid),
        fact               TEXT NOT NULL,
        category           TEXT,
        confidence         REAL,
        source_message_id  TEXT,
        created_at         INTEGER,
        superseded_by      INTEGER,
        UNIQUE(chat_jid, member_jid, fact)
      );
      INSERT INTO facts_new (id, chat_jid, member_jid, fact, category, confidence, source_message_id, created_at, superseded_by)
        SELECT id, (SELECT value FROM config WHERE key = 'active_group_jid'), member_jid, fact, category, confidence, source_message_id, created_at, superseded_by FROM facts;
      DROP TABLE facts;
      ALTER TABLE facts_new RENAME TO facts;
    `);
  }

  return db;
}
