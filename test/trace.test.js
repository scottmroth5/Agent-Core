import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTracer, createClaude, openStore } from '../src/index.js';

function quietLogger() {
  const lines = [];
  const push = (level) => (...args) => lines.push([level, ...args]);
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}

const call = (overrides = {}) => ({
  label: 'score',
  model: 'claude-haiku-4-5',
  stopReason: 'end_turn',
  inputTokens: 100,
  outputTokens: 10,
  cacheReadTokens: 50,
  cacheWriteTokens: 5,
  costUsd: 0.001,
  durationMs: 12,
  error: null,
  ...overrides,
});

test('totals calls, tokens, cost and errors in memory', async () => {
  const logger = quietLogger();
  const run = await createTracer({ logger }).startRun('discovery');
  assert.equal(run.id, null);
  await run.recordCall(call());
  await run.recordCall(call({ costUsd: null, error: { name: 'RateLimitError', message: 'x' } }));
  const totals = await run.finish('ok');

  assert.equal(totals.status, 'ok');
  assert.equal(totals.calls, 2);
  assert.equal(totals.errors, 1);
  assert.equal(totals.inputTokens, 200);
  assert.equal(totals.outputTokens, 20);
  assert.equal(totals.cacheReadTokens, 100);
  assert.equal(totals.cacheWriteTokens, 10);
  assert.equal(totals.costUsd, 0.001);
  assert.equal(totals.unpricedCalls, 1);
  assert.ok(logger.lines.some(([level, msg]) => level === 'info' && msg.startsWith('[discovery] ok: 2 calls')));
});

test('finish is idempotent and a failed status logs as a warning', async () => {
  const logger = quietLogger();
  const run = await createTracer({ logger }).startRun('hunt');
  const first = await run.finish('failed');
  const second = await run.finish('ok');
  assert.equal(second, first);
  assert.equal(second.status, 'failed');
  assert.equal(logger.lines.filter(([level]) => level === 'warn').length, 1);
});

test('two finish calls made before either settles return the same totals and write once', async () => {
  const store = openStore(':memory:');
  const run = await createTracer({ store, logger: quietLogger() }).startRun('hunt');
  const [first, second] = await Promise.all([run.finish('failed'), run.finish('ok')]);
  assert.equal(second, first);
  assert.equal(store.db.prepare('SELECT status FROM runs WHERE id = ?').pluck().get(run.id), 'failed');
  store.close();
});

test('log prefixes the run name and passes fields through', async () => {
  const logger = quietLogger();
  (await createTracer({ logger }).startRun('hunt')).log('warn', 'fetch failed', { status: 403 });
  assert.deepEqual(logger.lines[0], ['warn', '[hunt] fetch failed', { status: 403 }]);
});

test('requires a run name', async () => {
  await assert.rejects(createTracer({ logger: quietLogger() }).startRun(''), /name is required/);
});

test('persists runs and calls to the store', async () => {
  const store = openStore(':memory:');
  const run = await createTracer({ store, logger: quietLogger() }).startRun('discovery', { trigger: 'manual' });
  await run.recordCall(call());
  await run.recordCall(call({ error: { name: 'ClaudeTruncatedError', message: 'cut' }, stopReason: 'max_tokens' }));
  await run.finish('ok', { postings: 3 });

  const row = store.db.prepare('SELECT * FROM runs WHERE id = ?').get(run.id);
  assert.equal(row.name, 'discovery');
  assert.equal(row.status, 'ok');
  assert.equal(row.calls, 2);
  assert.equal(row.errors, 1);
  assert.equal(row.input_tokens, 200);
  assert.deepEqual(JSON.parse(row.meta), { trigger: 'manual' });
  assert.deepEqual(JSON.parse(row.summary), { postings: 3 });
  assert.ok(row.finished_at);

  const calls = store.db.prepare('SELECT * FROM run_calls WHERE run_id = ? ORDER BY id').all(run.id);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].error_name, 'ClaudeTruncatedError');
  assert.equal(calls[1].stop_reason, 'max_tokens');
  store.close();
});

test('an asynchronous store works the same: each write is awaited, and the run id can come back as id', async () => {
  const store = openStore(':memory:');
  // Answers like an async data layer: run() resolves later, with { changes, id } instead of lastInsertRowid.
  const asyncDb = {
    prepare: (sql) => {
      const stmt = store.db.prepare(sql);
      return {
        run: async (...params) => {
          await new Promise((resolve) => setImmediate(resolve));
          const r = stmt.run(...params);
          return { changes: r.changes, id: Number(r.lastInsertRowid) };
        },
      };
    },
  };
  const run = await createTracer({ store: { db: asyncDb }, logger: quietLogger() }).startRun('score');
  assert.equal(typeof run.id, 'number');
  await run.recordCall(call());
  const totals = await run.finish('ok');
  assert.equal(totals.calls, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) FROM run_calls WHERE run_id = ?').pluck().get(run.id), 1);
  assert.equal(store.db.prepare('SELECT status FROM runs WHERE id = ?').pluck().get(run.id), 'ok');
  store.close();
});

test('createClaude and a stored run work together without storing text', async () => {
  const store = openStore(':memory:');
  const client = {
    messages: {
      create: async () => ({
        id: 'msg_1',
        model: 'claude-haiku-4-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'SECRET-RESPONSE' }],
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    },
  };
  const run = await createTracer({ store, logger: quietLogger() }).startRun('smoke');
  await createClaude({ client }).send({ model: 'claude-haiku-4-5', maxTokens: 20, prompt: 'SECRET-PROMPT', trace: run, label: 'ping' });
  await run.finish();

  const dump = JSON.stringify([
    store.db.prepare('SELECT * FROM runs').all(),
    store.db.prepare('SELECT * FROM run_calls').all(),
  ]);
  assert.ok(!dump.includes('SECRET'), dump);
  assert.equal(store.db.prepare('SELECT label FROM run_calls').pluck().get(), 'ping');
  store.close();
});

// A sink that records what the tracer hands it, optionally answering a tick later like an async data layer.
function recordingSink({ id = 7, async = false } = {}) {
  const events = [];
  const later = (value) => (async ? new Promise((resolve) => setImmediate(() => resolve(value))) : value);
  return {
    events,
    startRun: (run) => { events.push(['startRun', run]); return later(id); },
    recordCall: (runId, c) => { events.push(['recordCall', runId, c]); return later(undefined); },
    finishRun: (runId, f) => { events.push(['finishRun', runId, f]); return later(undefined); },
  };
}

test('a sink receives the run, each call, and one finish as plain objects', async () => {
  const sink = recordingSink();
  const run = await createTracer({ sink, logger: quietLogger() }).startRun('discovery', { trigger: 'manual' });
  assert.equal(run.id, 7);
  await run.recordCall(call());
  await run.recordCall(call({ costUsd: null, error: { name: 'RateLimitError', message: 'x' }, label: undefined }));
  const totals = await run.finish('ok', { postings: 3 });

  assert.deepEqual(sink.events.map(([kind]) => kind), ['startRun', 'recordCall', 'recordCall', 'finishRun']);
  const [, started] = sink.events[0];
  assert.equal(started.name, 'discovery');
  assert.deepEqual(started.meta, { trigger: 'manual' });
  assert.ok(!Number.isNaN(Date.parse(started.startedAt)));

  const [, firstId, first] = sink.events[1];
  assert.equal(firstId, 7);
  assert.deepEqual({ ...first, createdAt: 'x' }, { ...call(), createdAt: 'x' });
  const [, , second] = sink.events[2];
  assert.equal(second.label, null);
  assert.equal(second.costUsd, null);
  assert.deepEqual(second.error, { name: 'RateLimitError', message: 'x' });

  const [, finishId, finished] = sink.events[3];
  assert.equal(finishId, 7);
  assert.deepEqual(finished.summary, { postings: 3 });
  assert.ok(!Number.isNaN(Date.parse(finished.finishedAt)));
  assert.equal(finished.calls, 2);
  assert.equal(finished.errors, 1);
  assert.equal(finished.unpricedCalls, 1);
  assert.deepEqual({ ...finished, finishedAt: undefined, summary: undefined }, { ...totals, finishedAt: undefined, summary: undefined });
});

test('an asynchronous sink is awaited at each step', async () => {
  const sink = recordingSink({ id: 'run-1', async: true });
  const run = await createTracer({ sink, logger: quietLogger() }).startRun('score');
  assert.equal(run.id, 'run-1');
  await run.recordCall(call());
  assert.equal(sink.events.length, 2);
  await run.finish();
  assert.equal(sink.events.length, 3);
  assert.equal(sink.events[2][2].summary, undefined);
});

test('a sink that keeps no id gives a null run id', async () => {
  const run = await createTracer({ sink: recordingSink({ id: null }), logger: quietLogger() }).startRun('hunt');
  assert.equal(run.id, null);
});

test('two finish calls made before either settles reach the sink once', async () => {
  const sink = recordingSink({ async: true });
  const run = await createTracer({ sink, logger: quietLogger() }).startRun('hunt');
  const [first, second] = await Promise.all([run.finish('failed'), run.finish('ok')]);
  assert.equal(second, first);
  const finishes = sink.events.filter(([kind]) => kind === 'finishRun');
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0][2].status, 'failed');
});

test('a sink error rejects the step that hit it', async () => {
  const sink = { ...recordingSink(), recordCall: () => Promise.reject(new Error('disk full')) };
  const run = await createTracer({ sink, logger: quietLogger() }).startRun('hunt');
  await assert.rejects(run.recordCall(call()), /disk full/);
});

test('a sink and a store together, or an incomplete sink, are refused', () => {
  const store = openStore(':memory:');
  assert.throws(() => createTracer({ sink: recordingSink(), store }), /sink or a store, not both/);
  assert.throws(() => createTracer({ sink: { startRun() {}, recordCall() {} } }), /startRun, recordCall, and finishRun/);
  store.close();
});

test('createClaude through a sink hands over no prompt or response text', async () => {
  const sink = recordingSink();
  const client = {
    messages: {
      create: async () => ({
        id: 'msg_1',
        model: 'claude-haiku-4-5',
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'SECRET-RESPONSE' }],
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
    },
  };
  const run = await createTracer({ sink, logger: quietLogger() }).startRun('smoke');
  await createClaude({ client }).send({ model: 'claude-haiku-4-5', maxTokens: 20, prompt: 'SECRET-PROMPT', trace: run, label: 'ping' });
  await run.finish();
  const dump = JSON.stringify(sink.events);
  assert.ok(!dump.includes('SECRET'), dump);
  assert.equal(sink.events[1][2].label, 'ping');
});
