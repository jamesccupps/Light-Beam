'use strict';
// Beam Family's database: one SQLite file (node:sqlite, Node 22.13+) in write-ahead mode. Everything the family
// writes is kept for good, so it lives here rather than in JSON files: messages page by id, unread counts and search
// (FTS5) are queries, and each change is one transaction.

// node:sqlite still says it's experimental: that warning, and only that one, is left out of the logs.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  if (/SQLite/i.test(String(warning?.message ?? warning))) return;
  return emitWarning.call(process, warning, ...rest);
};
const { DatabaseSync } = require('node:sqlite');

// Each entry moves the schema one version on (PRAGMA user_version). Never edit one that has shipped: add another.
const MIGRATIONS = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    login TEXT UNIQUE,
    pass_hash TEXT,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    color INTEGER NOT NULL DEFAULT 0,
    avatar TEXT,
    created_at INTEGER NOT NULL,
    disabled_at INTEGER
  );
  CREATE UNIQUE INDEX users_name ON users (name COLLATE NOCASE);

  CREATE TABLE sessions (
    hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    agent TEXT,
    ip TEXT
  );
  CREATE INDEX sessions_user ON sessions (user_id);

  CREATE TABLE invites (
    id TEXT PRIMARY KEY,
    hash TEXT NOT NULL UNIQUE,
    created_by TEXT REFERENCES users (id) ON DELETE SET NULL,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    space_id TEXT,
    uses INTEGER NOT NULL DEFAULT 0,
    max_uses INTEGER NOT NULL DEFAULT 1,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    note TEXT
  );

  CREATE TABLE spaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    created_by TEXT
  );
  CREATE TABLE space_members (
    space_id TEXT NOT NULL REFERENCES spaces (id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (space_id, user_id)
  );

  CREATE TABLE channels (
    id TEXT PRIMARY KEY,
    space_id TEXT REFERENCES spaces (id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('text', 'dm', 'group')),
    name TEXT,
    topic TEXT,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    created_by TEXT,
    archived_at INTEGER,
    last_id TEXT,
    dm_key TEXT UNIQUE
  );
  CREATE INDEX channels_space ON channels (space_id);
  CREATE TABLE channel_members (
    channel_id TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    added_at INTEGER NOT NULL,
    PRIMARY KEY (channel_id, user_id)
  );
  CREATE INDEX channel_members_user ON channel_members (user_id);

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    author_id TEXT REFERENCES users (id) ON DELETE SET NULL,
    body TEXT NOT NULL DEFAULT '',
    reply_to TEXT,
    created_at INTEGER NOT NULL,
    edited_at INTEGER,
    deleted_at INTEGER,
    pinned_at INTEGER,
    pinned_by TEXT,
    mentions_all INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL DEFAULT 'user'
  );
  CREATE INDEX messages_channel ON messages (channel_id, id);
  CREATE TABLE mentions (
    message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    PRIMARY KEY (message_id, user_id)
  );
  CREATE INDEX mentions_user ON mentions (user_id, message_id);

  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT REFERENCES messages (id) ON DELETE SET NULL,
    uploader_id TEXT REFERENCES users (id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    received INTEGER NOT NULL DEFAULT 0,
    width INTEGER,
    height INTEGER,
    thumb TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX attachments_message ON attachments (message_id);

  CREATE TABLE reactions (
    message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    emoji TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (message_id, user_id, emoji)
  );

  CREATE TABLE reads (
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    last_id TEXT NOT NULL,
    PRIMARY KEY (user_id, channel_id)
  );

  CREATE TABLE notify (
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels (id) ON DELETE CASCADE,
    level TEXT NOT NULL CHECK (level IN ('all', 'mentions', 'none')),
    PRIMARY KEY (user_id, channel_id)
  );

  CREATE TABLE push_subs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    ok_at INTEGER,
    failures INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE audit (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    user_id TEXT,
    action TEXT NOT NULL,
    detail TEXT
  );

  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  -- Search: message text, kept in step by triggers (a deleted message's text is emptied, so it drops out).
  CREATE VIRTUAL TABLE messages_fts USING fts5 (body, content = 'messages', content_rowid = 'rowid', tokenize = 'unicode61 remove_diacritics 2');
  CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts (rowid, body) VALUES (new.rowid, new.body);
  END;
  CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  END;
  CREATE TRIGGER messages_fts_update AFTER UPDATE OF body ON messages BEGIN
    INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
    INSERT INTO messages_fts (rowid, body) VALUES (new.rowid, new.body);
  END;
  `,
  // v2: a link can also reset one person's password (invites.user_id: whose).
  `
  ALTER TABLE invites ADD COLUMN user_id TEXT REFERENCES users (id) ON DELETE CASCADE;
  `,
];

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL'); // with WAL: a power cut loses at most the last moment, never the file
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  const version = db.prepare('PRAGMA user_version').get().user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  const statements = new Map();
  const prepare = sql => {
    let s = statements.get(sql);
    if (!s) statements.set(sql, (s = db.prepare(sql)));
    return s;
  };
  let depth = 0;

  return {
    raw: db,
    get: (sql, ...params) => prepare(sql).get(...params),
    all: (sql, ...params) => prepare(sql).all(...params),
    run: (sql, ...params) => prepare(sql).run(...params),
    // fn runs in one transaction (nested calls join the outer one); a throw rolls everything back.
    tx(fn) {
      if (depth > 0) return fn();
      db.exec('BEGIN IMMEDIATE');
      depth++;
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch {}
        throw err;
      } finally {
        depth--;
      }
    },
    meta(key, value) {
      if (value === undefined) return prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
      prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value').run(key, String(value));
    },
    close: () => db.close(),
    version: () => db.prepare('PRAGMA user_version').get().user_version,
  };
}

module.exports = { openDb };
