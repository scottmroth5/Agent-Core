import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costFromUsage } from '../src/pricing.js';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} != ${expected}`);

test('prices input, output, cache reads and 5-minute writes', () => {
  const usage = { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 2000, cache_creation_input_tokens: 4000 };
  // Haiku 4.5: 1000*1 + 500*5 + 2000*0.1 + 4000*1.25 = 8700 per million
  near(costFromUsage('claude-haiku-4-5', usage), 0.0087);
});

test('uses the TTL breakdown when present', () => {
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 4000,
    cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 3000 },
  };
  // Sonnet 5.5: 1000*2.5 + 3000*4 = 14500 per million
  near(costFromUsage('claude-sonnet-5-5', usage), 0.0145);
});

test('uses per-model cache read rates', () => {
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1_000_000 };
  near(costFromUsage('claude-opus-5-5', usage), 0.2);
  near(costFromUsage('claude-fable-5-1', usage), 0.25);
});

test('prices dated snapshot IDs like their alias', () => {
  const usage = { input_tokens: 1_000_000, output_tokens: 0 };
  near(costFromUsage('claude-haiku-4-5-20251001', usage), 1);
});

test('returns null for an unknown model or missing usage', () => {
  assert.equal(costFromUsage('claude-unknown-9', { input_tokens: 10 }), null);
  assert.equal(costFromUsage('claude-haiku-4-5', undefined), null);
});
