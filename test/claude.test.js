import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaude, ClaudeTruncatedError, ClaudeRefusalError } from '../src/index.js';

// Fake SDK client: records every request and answers with the given response (or throws it).
function fakeClient(respond) {
  const requests = [];
  return {
    requests,
    messages: {
      create: async (params) => {
        requests.push(params);
        const r = typeof respond === 'function' ? respond(params) : respond;
        if (r instanceof Error) throw r;
        return r;
      },
    },
  };
}

function response({ text = 'hello', stop_reason = 'end_turn', model = 'claude-haiku-4-5', usage, stop_details } = {}) {
  return {
    id: 'msg_test',
    model,
    stop_reason,
    stop_details: stop_details ?? null,
    content: [{ type: 'text', text }],
    usage: usage ?? { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };
}

function fakeTrace() {
  const calls = [];
  return { calls, recordCall: (info) => calls.push(info) };
}

test('sends the system prompt as one cached block and returns text, usage and cost', async () => {
  const client = fakeClient(response({ usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 } }));
  const claude = createClaude({ client });
  const result = await claude.send({ model: 'claude-haiku-4-5', maxTokens: 256, system: 'SYSTEM', prompt: 'PROMPT' });

  const req = client.requests[0];
  assert.deepEqual(req.system, [{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(req.messages, [{ role: 'user', content: 'PROMPT' }]);
  assert.equal(req.max_tokens, 256);
  assert.equal(req.output_config, undefined);
  assert.equal(req.thinking, undefined);

  assert.equal(result.text, 'hello');
  assert.equal(result.data, null);
  assert.equal(result.stopReason, 'end_turn');
  assert.deepEqual(result.usage, { input: 100, output: 20, cacheRead: 5000, cacheWrite: 0 });
  // 100*1 + 20*5 + 5000*0.1 = 700 per million
  assert.ok(Math.abs(result.costUsd - 0.0007) < 1e-12);
});

test('omits system when none is given and accepts a full messages list', async () => {
  const client = fakeClient(response());
  const messages = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }];
  await createClaude({ client }).send({ model: 'claude-haiku-4-5', maxTokens: 10, messages });
  assert.equal(client.requests[0].system, undefined);
  assert.equal(client.requests[0].messages, messages);
});

test('schema sets output_config.format and parses the JSON response', async () => {
  const schema = { type: 'object', properties: { score: { type: 'integer' } }, required: ['score'], additionalProperties: false };
  const client = fakeClient(response({ text: '{"score": 7}' }));
  const result = await createClaude({ client }).send({ model: 'claude-haiku-4-5', maxTokens: 50, prompt: 'x', schema });
  assert.deepEqual(client.requests[0].output_config, { format: { type: 'json_schema', schema } });
  assert.deepEqual(result.data, { score: 7 });
});

test('passes thinking and effort through unchanged', async () => {
  const client = fakeClient(response({ model: 'claude-opus-5-5' }));
  await createClaude({ client }).send({
    model: 'claude-opus-5-5',
    maxTokens: 50,
    prompt: 'x',
    thinking: { type: 'adaptive' },
    effort: 'low',
  });
  assert.deepEqual(client.requests[0].thinking, { type: 'adaptive' });
  assert.deepEqual(client.requests[0].output_config, { effort: 'low' });
});

test('rejects missing model, missing maxTokens, and prompt plus messages together', async () => {
  const claude = createClaude({ client: fakeClient(response()) });
  await assert.rejects(claude.send({ maxTokens: 10, prompt: 'x' }), /model is required/);
  await assert.rejects(claude.send({ model: 'm', prompt: 'x' }), /maxTokens is required/);
  await assert.rejects(claude.send({ model: 'm', maxTokens: 10 }), /exactly one of prompt or messages/);
  await assert.rejects(
    claude.send({ model: 'm', maxTokens: 10, prompt: 'x', messages: [] }),
    /exactly one of prompt or messages/,
  );
});

test('throws ClaudeTruncatedError at max_tokens and still traces the call', async () => {
  const trace = fakeTrace();
  const claude = createClaude({ client: fakeClient(response({ text: 'cut of', stop_reason: 'max_tokens' })) });
  await assert.rejects(
    claude.send({ model: 'claude-haiku-4-5', maxTokens: 5, prompt: 'x', trace, label: 'score' }),
    (err) => err instanceof ClaudeTruncatedError && err.result.text === 'cut of',
  );
  assert.equal(trace.calls.length, 1);
  assert.equal(trace.calls[0].stopReason, 'max_tokens');
  assert.equal(trace.calls[0].error.name, 'ClaudeTruncatedError');
});

test('throws ClaudeRefusalError with stop details', async () => {
  const stop_details = { type: 'refusal', category: 'cyber', explanation: 'declined' };
  const claude = createClaude({ client: fakeClient(response({ text: '', stop_reason: 'refusal', stop_details })) });
  await assert.rejects(
    claude.send({ model: 'claude-haiku-4-5', maxTokens: 50, prompt: 'x' }),
    (err) => err instanceof ClaudeRefusalError && err.stopDetails.category === 'cyber',
  );
});

test('propagates SDK errors and records their class name', async () => {
  class RateLimitError extends Error {}
  const trace = fakeTrace();
  const claude = createClaude({ client: fakeClient(new RateLimitError('rate limited')) });
  await assert.rejects(claude.send({ model: 'claude-haiku-4-5', maxTokens: 50, prompt: 'x', trace }), RateLimitError);
  assert.deepEqual(trace.calls[0].error, { name: 'RateLimitError', message: 'rate limited' });
  assert.equal(trace.calls[0].inputTokens, 0);
});

test('traces metadata only, never prompt or response text', async () => {
  const trace = fakeTrace();
  const claude = createClaude({ client: fakeClient(response({ text: 'SECRET-RESPONSE' })) });
  await claude.send({ model: 'claude-haiku-4-5', maxTokens: 50, system: 'SECRET-SYSTEM', prompt: 'SECRET-PROMPT', trace, label: 'score' });
  const recorded = JSON.stringify(trace.calls);
  assert.ok(!recorded.includes('SECRET'), recorded);
  assert.equal(trace.calls[0].label, 'score');
  assert.equal(trace.calls[0].model, 'claude-haiku-4-5');
  assert.equal(trace.calls[0].error, null);
});

test('reports null cost for a model without pricing', async () => {
  const claude = createClaude({ client: fakeClient(response({ model: 'claude-unknown-9' })) });
  const result = await claude.send({ model: 'claude-unknown-9', maxTokens: 50, prompt: 'x' });
  assert.equal(result.costUsd, null);
});
