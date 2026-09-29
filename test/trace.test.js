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

test('totals calls, tokens, cost and errors in memory', () => {
  const logger = quietLogger();
  const run = createTracer({ logger }).startRun('discovery');
  assert.equal(run.id, null);
  run.recordCall(call());
  run.recordCall(call({ costUsd: null, error: { name: 'RateLimitError', message: 'x' } }));
  const totals = run.finish('ok');

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

test('finish is idempotent and a failed status logs as a warning', () => {
  const logger = quietLogger();
  const run = createTracer({ logger }).startRun('hunt');
  const first = run.finish('failed');
  const second = run.finish('ok');
  assert.equal(second, first);
  assert.equal(second.status, 'failed');
  assert.equal(logger.lines.filter(([level]) => level === 'warn').length, 1);
});

test('log prefixes the run name and passes fields through', () => {
  const logger = quietLogger();
  createTracer({ logger }).startRun('hunt').log('warn', 'fetch failed', { status: 403 });
  assert.deepEqual(logger.lines[0], ['warn', '[hunt] fetch failed', { status: 403 }]);
});

test('requires a run name', () => {
  assert.throws(() => createTracer({ logger: quietLogger() }).startRun(''), /name is required/);
});

test('persists runs and calls to the store', () => {
  const store = openStore(':memory:');
  const run = createTracer({ store, logger: quietLogger() }).startRun('discovery', { trigger: 'manual' });
  run.recordCall(call());
  run.recordCall(call({ error: { name: 'ClaudeTruncatedError', message: 'cut' }, stopReason: 'max_tokens' }));
  run.finish('ok', { postings: 3 });

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
  const run = createTracer({ store, logger: quietLogger() }).startRun('smoke');
  await createClaude({ client }).send({ model: 'claude-haiku-4-5', maxTokens: 20, prompt: 'SECRET-PROMPT', trace: run, label: 'ping' });
  run.finish();

  const dump = JSON.stringify([
    store.db.prepare('SELECT * FROM runs').all(),
    store.db.prepare('SELECT * FROM run_calls').all(),
  ]);
  assert.ok(!dump.includes('SECRET'), dump);
  assert.equal(store.db.prepare('SELECT label FROM run_calls').pluck().get(), 'ping');
  store.close();
});
