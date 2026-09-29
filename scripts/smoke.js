// Manual check against the real API: one small Haiku call with a schema.
// Costs a fraction of a cent. Not part of npm test, so CI never needs a key.
//
//   node --env-file=<path to a .env with ANTHROPIC_API_KEY> scripts/smoke.js
import { createClaude, createTracer } from '../src/index.js';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Run with --env-file=<path to .env>.');
  process.exit(1);
}

const run = createTracer().startRun('smoke');
const claude = createClaude();
try {
  const result = await claude.send({
    model: 'claude-haiku-4-5',
    maxTokens: 100,
    system: 'You answer arithmetic questions.',
    prompt: 'What is 17 + 25? Give the answer and one short word describing it.',
    schema: {
      type: 'object',
      properties: { answer: { type: 'integer' }, word: { type: 'string' } },
      required: ['answer', 'word'],
      additionalProperties: false,
    },
    trace: run,
    label: 'arithmetic',
  });
  console.log('data:', result.data);
  console.log('usage:', result.usage, 'cost USD:', result.costUsd);
  run.finish(result.data?.answer === 42 ? 'ok' : 'unexpected-answer');
} catch (err) {
  run.finish('failed');
  console.error(err);
  process.exitCode = 1;
}
