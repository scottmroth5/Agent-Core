import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../src/index.js';

const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").pluck().all();

test('creates the core tables and migration log', () => {
  const store = openStore(':memory:');
  assert.deepEqual(tables(store.db), ['run_calls', 'runs', 'schema_migrations']);
  assert.equal(store.db.pragma('foreign_keys', { simple: true }), 1);
  store.close();
});

test('applies app migrations in order, including function migrations', () => {
  const store = openStore(':memory:', {
    app: 'demo',
    migrations: [
      { id: '001-items', up: 'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT)' },
      { id: '002-seed', up: (db) => db.prepare('INSERT INTO items (name) VALUES (?)').run('first') },
      { id: '003-column', up: 'ALTER TABLE items ADD COLUMN note TEXT' },
    ],
  });
  assert.equal(store.db.prepare('SELECT name FROM items').pluck().get(), 'first');
  const ids = store.db.prepare("SELECT id FROM schema_migrations WHERE app = 'demo' ORDER BY rowid").pluck().all();
  assert.deepEqual(ids, ['001-items', '002-seed', '003-column']);
  store.close();
});

test('re-opening a file applies only new migrations and creates parent folders', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-core-'));
  const path = join(dir, 'nested', 'app.db');
  const v1 = [{ id: '001', up: 'CREATE TABLE t (x INTEGER)' }];
  try {
    openStore(path, { app: 'demo', migrations: v1 }).close();
    const store = openStore(path, { app: 'demo', migrations: [...v1, { id: '002', up: 'INSERT INTO t VALUES (1)' }] });
    assert.equal(store.db.prepare('SELECT COUNT(*) FROM t').pluck().get(), 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) FROM schema_migrations WHERE app = 'demo'").pluck().get(), 2);
    assert.equal(store.db.prepare("SELECT COUNT(*) FROM schema_migrations WHERE app = 'agent-core'").pluck().get(), 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('keeps each app namespace separate from agent-core and each other', () => {
  const store = openStore(':memory:', { app: 'one', migrations: [{ id: '001-runs', up: 'CREATE TABLE one_t (x)' }] });
  const rows = store.db.prepare('SELECT app, id FROM schema_migrations ORDER BY app').all();
  assert.deepEqual(rows.map((r) => `${r.app}:${r.id}`), ['agent-core:001-runs', 'one:001-runs']);
  store.close();
});

test('rolls back a failing migration and leaves it unrecorded', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-core-'));
  const path = join(dir, 'app.db');
  try {
    assert.throws(() =>
      openStore(path, {
        app: 'demo',
        migrations: [
          { id: '001', up: 'CREATE TABLE ok_t (x)' },
          { id: '002', up: 'CREATE TABLE half_t (x); SELECT * FROM missing_table' },
        ],
      }),
    );
    const store = openStore(path);
    assert.ok(tables(store.db).includes('ok_t'));
    assert.ok(!tables(store.db).includes('half_t'));
    assert.deepEqual(store.db.prepare("SELECT id FROM schema_migrations WHERE app = 'demo'").pluck().all(), ['001']);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('validates migration options', () => {
  assert.throws(() => openStore(':memory:', { migrations: [{ id: '1', up: 'SELECT 1' }] }), /app is required/);
  assert.throws(() => openStore(':memory:', { app: 'agent-core', migrations: [] }), /reserved/);
  assert.throws(
    () => openStore(':memory:', { app: 'demo', migrations: [{ id: '1', up: 'SELECT 1' }, { id: '1', up: 'SELECT 1' }] }),
    /duplicate/,
  );
  assert.throws(() => openStore(':memory:', { app: 'demo', migrations: [{ id: '1' }] }), /needs an id and an up/);
});

test('tx commits on success and rolls back on a throw', () => {
  const store = openStore(':memory:', { app: 'demo', migrations: [{ id: '001', up: 'CREATE TABLE t (x INTEGER)' }] });
  const insert = store.db.prepare('INSERT INTO t VALUES (?)');
  assert.equal(store.tx(() => { insert.run(1); return 'done'; }), 'done');
  assert.throws(() => store.tx(() => { insert.run(2); throw new Error('boom'); }), /boom/);
  assert.deepEqual(store.db.prepare('SELECT x FROM t').pluck().all(), [1]);
  store.close();
});
