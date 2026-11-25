import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
  id                TEXT PRIMARY KEY,
  topic             TEXT NOT NULL,
  ground_rules      TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL,           -- waiting | active | ended | locked
  join_code_hash    TEXT NOT NULL,
  failed_joins      INTEGER NOT NULL DEFAULT 0,
  max_messages      INTEGER NOT NULL,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  ended_at          INTEGER,
  ended_by          TEXT,
  end_summary       TEXT
);

CREATE TABLE IF NOT EXISTS participants (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id       TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role          TEXT NOT NULL,               -- host | guest
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  joined_at     INTEGER NOT NULL,
  UNIQUE (chat_id, role)
);

CREATE TABLE IF NOT EXISTS messages (
  chat_id     TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  sender      TEXT NOT NULL,                 -- host | guest | system
  sender_name TEXT NOT NULL,
  kind        TEXT NOT NULL,                 -- text | system | end
  body        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (chat_id, seq)
);

CREATE TABLE IF NOT EXISTS viewers (
  chat_id   TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  label     TEXT NOT NULL,                   -- host | guest
  key_hash  TEXT NOT NULL UNIQUE,
  PRIMARY KEY (chat_id, label)
);

CREATE INDEX IF NOT EXISTS chats_expires ON chats(expires_at);

-- OAuth for the owner connector (claude.ai can't send a custom Authorization header).
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,
  client_name   TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,               -- JSON array
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash     TEXT PRIMARY KEY,
  client_id     TEXT NOT NULL,
  redirect_uri  TEXT NOT NULL,
  challenge     TEXT NOT NULL,               -- PKCE S256
  expires_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash    TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,               -- access | refresh
  client_id     TEXT NOT NULL,
  expires_at    INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);
`;

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** Additive migrations for databases created by older versions. */
function migrate(db: DatabaseSync) {
  const cols = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
  // Space-separated framing flags the server detected on a message (forged tags, turn markers...).
  if (!cols('messages').has('flags')) db.exec(`ALTER TABLE messages ADD COLUMN flags TEXT NOT NULL DEFAULT ''`);
  // How many of a participant's messages were flagged; the first one triggers a visible system note.
  // Self chats: between the owner's own agents; any owner-authenticated agent may take the second seat without a code.
  if (!cols('chats').has('self_chat')) db.exec(`ALTER TABLE chats ADD COLUMN self_chat INTEGER NOT NULL DEFAULT 0`);
  if (!cols('participants').has('flag_count')) db.exec(`ALTER TABLE participants ADD COLUMN flag_count INTEGER NOT NULL DEFAULT 0`);
}
