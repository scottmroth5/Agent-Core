// Claude API list prices in USD per million tokens (first-party API, global routing).
// Source: https://platform.claude.com/docs/en/about-claude/pricing, checked 2026-09-28.
// Cache reads are listed per model because the multiplier is not uniform
// (0.1x on most models, 0.05x on Opus 5.5, 0.025x on Fable 5.1).
const RATES = {
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite5m: 2.5, cacheWrite1h: 4, cacheRead: 0.2 },
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite5m: 5, cacheWrite1h: 8, cacheRead: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50, cacheWrite5m: 12.5, cacheWrite1h: 20, cacheRead: 0.25 },
};

/**
 * Estimates the USD cost of one Messages API response from its usage block.
 * Returns null for a model with no rates, rather than guessing.
 * @param {string} model
 * @param {object} usage  raw API usage (input_tokens, output_tokens, cache_* fields)
 * @returns {number|null}
 */
export function costFromUsage(model, usage) {
  // Responses can report a dated snapshot ID (e.g. claude-haiku-4-5-20251001) for an alias.
  const r = RATES[model] ?? RATES[String(model ?? '').replace(/-\d{8}$/, '')];
  if (!r || !usage) return null;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  // The breakdown by TTL is present on current API versions; without it, treat writes as 5-minute.
  const write1h = usage.cache_creation?.ephemeral_1h_input_tokens || 0;
  const write5m = usage.cache_creation ? usage.cache_creation.ephemeral_5m_input_tokens || 0 : cacheWrite;
  const dollars =
    (usage.input_tokens || 0) * r.input +
    (usage.output_tokens || 0) * r.output +
    (usage.cache_read_input_tokens || 0) * r.cacheRead +
    write5m * r.cacheWrite5m +
    write1h * r.cacheWrite1h;
  return dollars / 1_000_000;
}
