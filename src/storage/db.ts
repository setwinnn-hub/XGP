import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  event_key     TEXT    NOT NULL UNIQUE,
  kind          TEXT    NOT NULL,
  chain         TEXT    NOT NULL,
  source        TEXT    NOT NULL,
  token_address TEXT    NOT NULL,
  token_name    TEXT,
  token_symbol  TEXT,
  tx_hash       TEXT    NOT NULL,
  details_json  TEXT    NOT NULL,
  t_chain       INTEGER,
  t_detected    INTEGER NOT NULL,
  t_processed   INTEGER,
  t_discord     INTEGER,
  delivery      TEXT,
  delivery_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_detected ON events (t_detected);
CREATE INDEX IF NOT EXISTS idx_events_token ON events (chain, token_address);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events (kind, chain, token_address);
CREATE INDEX IF NOT EXISTS idx_events_kind_time ON events (kind, t_detected);
CREATE TABLE IF NOT EXISTS wallets (
  chain    TEXT    NOT NULL,
  address  TEXT    NOT NULL,
  label    TEXT,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (chain, address)
);
`;

/** Opens (and creates if needed) the SQLite database with the current schema. ":memory:" for tests. */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}
