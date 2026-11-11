import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaude, ClaudeTruncatedError, ClaudeRefusalError } from '../src/index.js';

// Fake SDK client: records every request (and which endpoint took it) and answers with the given response (or throws it).
function fakeClient(respond) {
  const requests = [];
  const endpoints = [];
  const answer = (endpoint, params) => {
    requests.push(structuredClone(params));
    endpoints.push(endpoint);
    const r = typeof respond === 'function' ? respond(params, requests.length) : respond;
    if (r instanceof Error) throw r;
    return r;
  };
  const api = (prefix) => ({
    create: async (params) => answer(`${prefix}create`, params),
    stream: (params) => ({ finalMessage: async () => answer(`${prefix}stream`, params) }),
  });
  return { requests, endpoints, messages: api(''), beta: { messages: api('beta.') } };
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

test('send waits for an asynchronous recordCall before it settles, on success and on error', async () => {
  const written = [];
  const trace = {
    recordCall: async (info) => {
      await new Promise((resolve) => setImmediate(resolve));
      written.push(info.error?.name ?? 'ok');
    },
  };
  await createClaude({ client: fakeClient(response()) }).send({ model: 'claude-haiku-4-5', maxTokens: 50, prompt: 'x', trace });
  assert.deepEqual(written, ['ok']);
  await assert.rejects(createClaude({ client: fakeClient(response({ stop_reason: 'max_tokens' })) }).send({ model: 'claude-haiku-4-5', maxTokens: 5, prompt: 'x', trace }), ClaudeTruncatedError);
  assert.deepEqual(written, ['ok', 'ClaudeTruncatedError']);
});

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
  assert.deepEqual(result.usage, { input: 100, output: 20, cacheRead: 5000, cacheWrite: 0, webSearches: 0 });
  // 100*1 + 20*5 + 5000*0.1 = 700 per million
  assert.ok(Math.abs(result.costUsd - 0.0007) < 1e-12);
});

test('omits system when none is given and accepts a full messages list', async () => {
  const client = fakeClient(response());
  const messages = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }];
  await createClaude({ client }).send({ model: 'claude-haiku-4-5', maxTokens: 10, messages });
  assert.equal(client.requests[0].system, undefined);
  assert.deepEqual(client.requests[0].messages, messages);
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

test('prices a response whose model ID is a dated snapshot of the requested alias', async () => {
  const claude = createClaude({ client: fakeClient(response({ model: 'claude-haiku-4-5-20251001' })) });
  const result = await claude.send({ model: 'claude-haiku-4-5', maxTokens: 50, prompt: 'x' });
  assert.equal(result.model, 'claude-haiku-4-5-20251001');
  assert.ok(Math.abs(result.costUsd - 0.0002) < 1e-12); // 100*1 + 20*5 = 200 per million
});

test('reports null cost for a model without pricing', async () => {
  const claude = createClaude({ client: fakeClient(response({ model: 'claude-unknown-9' })) });
  const result = await claude.send({ model: 'claude-unknown-9', maxTokens: 50, prompt: 'x' });
  assert.equal(result.costUsd, null);
});

test('passes tools through, streams when asked, and uses the beta endpoint only with betas', async () => {
  const tools = [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }];
  const client = fakeClient(response());
  const claude = createClaude({ client });
  await claude.send({ model: 'claude-haiku-4-5', maxTokens: 50, prompt: 'x', tools, stream: true });
  await claude.send({ model: 'claude-haiku-4-5', maxTokens: 50, prompt: 'x', betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  await claude.send({ model: 'claude-haiku-4-5', maxTokens: 50, prompt: 'x' });
  assert.deepEqual(client.endpoints, ['stream', 'beta.create', 'create']);
  assert.deepEqual(client.requests[0].tools, tools);
  assert.deepEqual([client.requests[1].betas, client.requests[1].fallbacks], [['server-side-fallback-2026-07-01'], 'default']);
  for (const k of ['tools', 'betas', 'fallbacks']) assert.equal(client.requests[2][k], undefined, k);
});

test('resumes pause_turn with the paused content, then sums usage, searches, and cost across the responses', async () => {
  const usage = { input_tokens: 1000, output_tokens: 100, server_tool_use: { web_search_requests: 2 } };
  const paused = { ...response({ model: 'claude-sonnet-5-5', usage }), stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: {} }] };
  const done = response({ model: 'claude-sonnet-5-5', text: 'final', usage: { input_tokens: 500, output_tokens: 50, server_tool_use: { web_search_requests: 1 } } });
  const client = fakeClient((params, n) => (n === 1 ? paused : done));
  const trace = fakeTrace();
  const result = await createClaude({ client }).send({ model: 'claude-sonnet-5-5', maxTokens: 50, prompt: 'x', trace });

  assert.equal(client.requests.length, 2);
  assert.deepEqual(client.requests[1].messages, [{ role: 'user', content: 'x' }, { role: 'assistant', content: paused.content }]);
  assert.deepEqual(result.content.map((b) => b.type), ['server_tool_use', 'text']);
  assert.equal(result.text, 'final');
  assert.deepEqual(result.usage, { input: 1500, output: 150, cacheRead: 0, cacheWrite: 0, webSearches: 3 });
  // tokens: 1500*2 + 150*10 = 4500 per million; searches: 3 * $0.01
  assert.ok(Math.abs(result.costUsd - (0.0045 + 0.03)) < 1e-12);
  assert.equal(trace.calls.length, 1, 'one traced call for the whole resumed turn');
});

test('gives up after maxContinuations pauses', async () => {
  const paused = { ...response(), stop_reason: 'pause_turn', content: [] };
  const client = fakeClient(paused);
  await assert.rejects(createClaude({ client }).send({ model: 'claude-haiku-4-5', maxTokens: 50, prompt: 'x', maxContinuations: 2 }), /paused the turn more than 2 times/);
  assert.equal(client.requests.length, 3);
});
