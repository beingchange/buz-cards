// SQLite storage (node:sqlite, built into Node.js — no native add-on to compile).
// The database file and card images live in the data directory on the computer running the server.
// It is the single authoritative store: phone and computer browsers both read and write it through the API.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const SCHEMA_VERSION = 1;

export function dataDir(): string {
  return path.resolve(process.env.BUZ_DATA_DIR ?? path.join(import.meta.dirname, '..', 'data'));
}

let db: DatabaseSync | null = null;

export function openDb(file = path.join(dataDir(), 'buz-cards.sqlite')): DatabaseSync {
  if (db) return db;
  mkdirSync(path.dirname(file), { recursive: true });
  const d = new DatabaseSync(file);
  d.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(d);
  db = d;
  return d;
}

export function closeDb() {
  db?.close();
  db = null;
}

function migrate(d: DatabaseSync) {
  const v = (d.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (v > SCHEMA_VERSION) throw new Error(`This database was created by a newer Buz Cards (schema ${v}). Update the app; your data has not been changed.`);
  if (v < 1) {
    d.exec(`
      BEGIN;
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('draft','saved','skipped')),
        data TEXT NOT NULL,
        search TEXT NOT NULL DEFAULT '',
        batch_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        saved_at TEXT,
        revision INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS contacts_state ON contacts(state, created_at);
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY,
        contact_id TEXT,
        side TEXT NOT NULL DEFAULT 'front',
        original_name TEXT NOT NULL DEFAULT '',
        original_mime TEXT NOT NULL DEFAULT '',
        original_bytes INTEGER NOT NULL DEFAULT 0,
        sha256 TEXT NOT NULL DEFAULT '',
        width INTEGER NOT NULL DEFAULT 0,
        height INTEGER NOT NULL DEFAULT 0,
        processed_width INTEGER NOT NULL DEFAULT 0,
        processed_height INTEGER NOT NULL DEFAULT 0,
        engine_version TEXT NOT NULL DEFAULT '',
        ocr TEXT,
        processed_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS cards_contact ON cards(contact_id);
      CREATE TABLE IF NOT EXISTS batches (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL DEFAULT 'batch',
        label TEXT NOT NULL DEFAULT '',
        event TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]',
        paused INTEGER NOT NULL DEFAULT 0,
        discarded_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS batch_items (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
        client_key TEXT NOT NULL,
        position INTEGER NOT NULL,
        card_id TEXT NOT NULL,
        contact_id TEXT,
        file_name TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        error TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER,
        updated_at TEXT NOT NULL,
        UNIQUE(batch_id, client_key)
      );
      CREATE INDEX IF NOT EXISTS batch_items_status ON batch_items(status);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version = 1;
      COMMIT;
    `);
  }
  // Future migrations: if (v < 2) { ... PRAGMA user_version = 2 } — always additive; never drop user data.
}

let txDepth = 0;

/** Run fn in a transaction. Nested calls join the outer transaction (savepoints keep inner failures contained). */
export function tx<T>(fn: () => T): T {
  const d = openDb();
  const sp = `sp${txDepth}`;
  d.exec(txDepth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
  txDepth++;
  try {
    const r = fn();
    txDepth--;
    d.exec(txDepth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return r;
  } catch (e) {
    txDepth--;
    d.exec(txDepth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw e;
  }
}

export function getSetting(key: string): string | null {
  const r = openDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return r?.value ?? null;
}

export function setSetting(key: string, value: string) {
  openDb().prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
