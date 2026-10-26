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

test('foreignKeys: false rebuilds a parent table without running its children\'s ON DELETE actions', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-core-'));
  const path = join(dir, 'app.db');
  const base = [
    { id: '001', up: 'CREATE TABLE parent (id INTEGER PRIMARY KEY, key TEXT UNIQUE); CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE)' },
    { id: '002', up: "INSERT INTO parent VALUES (1, 'a'), (2, 'b'); INSERT INTO child VALUES (10, 1), (11, 2)" },
  ];
  // The documented rebuild: the new table drops the UNIQUE on key and gains an owner column.
  const rebuild = `CREATE TABLE parent_new (id INTEGER PRIMARY KEY, owner INTEGER NOT NULL, key TEXT, UNIQUE (owner, key));
    INSERT INTO parent_new (id, owner, key) SELECT id, 1, key FROM parent;
    DROP TABLE parent;
    ALTER TABLE parent_new RENAME TO parent;`;
  try {
    openStore(path, { app: 'demo', migrations: base }).close();
    const store = openStore(path, { app: 'demo', migrations: [...base, { id: '003', foreignKeys: false, up: rebuild }] });
    assert.deepEqual(store.db.prepare('SELECT id FROM child ORDER BY id').pluck().all(), [10, 11], 'children survive the drop');
    assert.equal(store.db.pragma('foreign_keys', { simple: true }), 1, 'enforcement is back on');
    assert.throws(() => store.db.prepare('INSERT INTO child VALUES (12, 99)').run(), /FOREIGN KEY/);
    store.db.prepare('DELETE FROM parent WHERE id = 1').run();
    assert.deepEqual(store.db.prepare('SELECT id FROM child').pluck().all(), [11], 'the cascade still points at the rebuilt table');
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('foreignKeys: false rolls back when the migration leaves a broken reference, and turns enforcement back on', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-core-'));
  const path = join(dir, 'app.db');
  const base = [
    { id: '001', up: 'CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))' },
    { id: '002', up: 'INSERT INTO parent VALUES (1); INSERT INTO child VALUES (10, 1)' },
  ];
  try {
    openStore(path, { app: 'demo', migrations: base }).close();
    assert.throws(
      () => openStore(path, { app: 'demo', migrations: [...base, { id: '003', foreignKeys: false, up: 'DELETE FROM parent' }] }),
      /demo:003: 1 row\(s\) in child would break a foreign key; rolled back/,
    );
    const store = openStore(path, { app: 'demo', migrations: base });
    assert.deepEqual(store.db.prepare('SELECT id FROM parent').pluck().all(), [1], 'nothing changed');
    assert.equal(store.db.prepare("SELECT COUNT(*) FROM schema_migrations WHERE app = 'demo' AND id = '003'").pluck().get(), 0);
    assert.equal(store.db.pragma('foreign_keys', { simple: true }), 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('an ordinary migration keeps foreign keys on inside its transaction', () => {
  let seen = null;
  openStore(':memory:', { app: 'demo', migrations: [{ id: '001', up: (db) => { seen = db.pragma('foreign_keys', { simple: true }); } }] }).close();
  assert.equal(seen, 1);
});
