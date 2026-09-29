import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// agent-core's own tables, applied before any app migrations under the "agent-core" namespace.
const CORE_MIGRATIONS = [
  {
    id: '001-runs',
    up: `
      CREATE TABLE runs (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        meta TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER,
        calls INTEGER NOT NULL DEFAULT 0,
        errors INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        summary TEXT
      );
      CREATE TABLE run_calls (
        id INTEGER PRIMARY KEY,
        run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        label TEXT,
        model TEXT,
        stop_reason TEXT,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL,
        duration_ms INTEGER,
        error_name TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX run_calls_run_id ON run_calls(run_id);
    `,
  },
];

/**
 * Opens (or creates) a SQLite database and applies migrations.
 * agent-core's tables are migrated first under the "agent-core" namespace, then the
 * app's migrations under options.app. Each migration runs once, in array order,
 * inside its own transaction; applied IDs are recorded in schema_migrations.
 *
 * @param {string} path  file path, or ':memory:' for tests; parent folders are created
 * @param {object} [options]
 * @param {string} [options.app]  namespace for the app's migrations (required when migrations are given)
 * @param {Array<{id: string, up: string | ((db: import('better-sqlite3').Database) => void)}>} [options.migrations]
 * @returns {{ db: import('better-sqlite3').Database, tx: <T>(fn: () => T) => T, close: () => void }}
 */
export function openStore(path, { app, migrations = [] } = {}) {
  if (migrations.length && !app) throw new TypeError('openStore: app is required when migrations are given');
  if (app === 'agent-core') throw new TypeError('openStore: "agent-core" is a reserved migration namespace');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    app TEXT NOT NULL,
    id TEXT NOT NULL,
    applied_at TEXT NOT NULL,
    PRIMARY KEY (app, id)
  )`);

  try {
    migrate(db, 'agent-core', CORE_MIGRATIONS);
    if (migrations.length) migrate(db, app, migrations);
  } catch (err) {
    db.close();
    throw err;
  }

  return {
    db,
    tx: (fn) => db.transaction(fn)(),
    close: () => db.close(),
  };
}

function migrate(db, app, migrations) {
  const seen = new Set();
  for (const m of migrations) {
    if (!m?.id || !m.up) throw new TypeError(`openStore: every ${app} migration needs an id and an up`);
    if (seen.has(m.id)) throw new TypeError(`openStore: duplicate ${app} migration id "${m.id}"`);
    seen.add(m.id);
  }
  const applied = new Set(db.prepare('SELECT id FROM schema_migrations WHERE app = ?').pluck().all(app));
  const mark = db.prepare('INSERT INTO schema_migrations (app, id, applied_at) VALUES (?, ?, ?)');
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    db.transaction(() => {
      if (typeof m.up === 'function') m.up(db);
      else db.exec(m.up);
      mark.run(app, m.id, new Date().toISOString());
    })();
  }
}
