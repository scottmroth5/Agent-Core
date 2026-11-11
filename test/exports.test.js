// The package's entry points: "." (everything), "./claude" (createClaude and its errors, without the SQLite store) and
// "./pricing" (costFromUsage). Imported by the package's own name, as consumers do (Node resolves a package's self-reference
// through its exports map).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

test('each entry point resolves and exports what it documents', async () => {
  const all = await import('@scottmroth5/agent-core');
  const claude = await import('@scottmroth5/agent-core/claude');
  const pricing = await import('@scottmroth5/agent-core/pricing');
  assert.equal(claude.createClaude, all.createClaude);
  assert.equal(claude.ClaudeTruncatedError, all.ClaudeTruncatedError);
  assert.equal(claude.ClaudeRefusalError, all.ClaudeRefusalError);
  assert.equal(typeof pricing.costFromUsage, 'function');
  assert.equal(pricing.costFromUsage('no-such-model', { input_tokens: 1 }), null);
  assert.deepEqual(Object.keys(all).sort(), ['ClaudeRefusalError', 'ClaudeTruncatedError', 'createClaude', 'createTracer', 'openStore']);
});

test('./claude and ./pricing never load better-sqlite3', () => {
  for (const entry of ['@scottmroth5/agent-core/claude', '@scottmroth5/agent-core/pricing']) {
    // A fresh process, so nothing loaded by other tests counts. better-sqlite3 is CommonJS, so loading it fills
    // require.cache even when it is imported from ESM.
    const loaded = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { createRequire } from 'node:module';
      await import('${entry}');
      const cache = createRequire(import.meta.url).cache;
      console.log(Object.keys(cache).some((k) => k.includes('better-sqlite3')));
    `], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }).trim();
    assert.equal(loaded, 'false', `${entry} loaded better-sqlite3`);
  }
  // The control: the main entry does load it (openStore), so the check above can see it.
  const main = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { createRequire } from 'node:module';
    await import('@scottmroth5/agent-core');
    console.log(Object.keys(createRequire(import.meta.url).cache).some((k) => k.includes('better-sqlite3')));
  `], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }).trim();
  assert.equal(main, 'true');
});
