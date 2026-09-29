/**
 * Creates a run tracer. A run collects per-call metadata (tokens, cost, timing,
 * errors) and totals it on finish. Traces never hold prompt or response text.
 *
 * With a store from openStore(), runs go into the runs table and calls into
 * run_calls. Without one, the run is kept in memory and summarized to the logger.
 *
 * @param {object} [options]
 * @param {{ db: import('better-sqlite3').Database }} [options.store]
 * @param {{ info: Function, warn: Function, error: Function }} [options.logger]  defaults to console
 * @returns {{ startRun: (name: string, meta?: object) => Run }}
 *
 * @typedef {object} Run
 * @property {number|null} id                              runs.id when persisted
 * @property {(info: CallInfo) => void} recordCall         called by createClaude().send when given as trace
 * @property {(level: 'info'|'warn'|'error', msg: string, fields?: object) => void} log
 * @property {(status?: string, summary?: object) => Totals} finish   idempotent; later calls return the first totals
 *
 * @typedef {object} CallInfo
 * @property {string|null} label
 * @property {string} model
 * @property {string|null} stopReason
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheWriteTokens
 * @property {number|null} costUsd
 * @property {number} durationMs
 * @property {{name: string, message: string}|null} error
 *
 * @typedef {object} Totals
 * @property {string} status
 * @property {number} calls
 * @property {number} errors
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheWriteTokens
 * @property {number} costUsd          sum over calls with a known price
 * @property {number} unpricedCalls    calls whose model had no pricing entry
 * @property {number} durationMs
 */
export function createTracer({ store, logger = console } = {}) {
  const db = store?.db ?? null;

  function startRun(name, meta = {}) {
    if (!name) throw new TypeError('startRun: name is required');
    const started = Date.now();
    const totals = {
      status: 'running',
      calls: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      unpricedCalls: 0,
      durationMs: 0,
    };
    let finished = null;

    const id = db
      ? Number(
          db
            .prepare('INSERT INTO runs (name, meta, started_at) VALUES (?, ?, ?)')
            .run(name, JSON.stringify(meta), new Date(started).toISOString()).lastInsertRowid,
        )
      : null;

    const insertCall = db?.prepare(`INSERT INTO run_calls
      (run_id, label, model, stop_reason, input_tokens, output_tokens, cache_read_tokens,
       cache_write_tokens, cost_usd, duration_ms, error_name, error_message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    function recordCall(info) {
      totals.calls += 1;
      if (info.error) totals.errors += 1;
      totals.inputTokens += info.inputTokens ?? 0;
      totals.outputTokens += info.outputTokens ?? 0;
      totals.cacheReadTokens += info.cacheReadTokens ?? 0;
      totals.cacheWriteTokens += info.cacheWriteTokens ?? 0;
      if (info.costUsd == null) totals.unpricedCalls += 1;
      else totals.costUsd += info.costUsd;
      insertCall?.run(
        id,
        info.label ?? null,
        info.model ?? null,
        info.stopReason ?? null,
        info.inputTokens ?? 0,
        info.outputTokens ?? 0,
        info.cacheReadTokens ?? 0,
        info.cacheWriteTokens ?? 0,
        info.costUsd ?? null,
        info.durationMs ?? null,
        info.error?.name ?? null,
        info.error?.message ?? null,
        new Date().toISOString(),
      );
    }

    function log(level, msg, fields) {
      const write = logger[level] ?? logger.info ?? logger.log;
      write.call(logger, `[${name}] ${msg}`, ...(fields ? [fields] : []));
    }

    function finish(status = 'ok', summary) {
      if (finished) return finished;
      totals.status = status;
      totals.durationMs = Date.now() - started;
      finished = { ...totals };
      db?.prepare(`UPDATE runs SET status = ?, finished_at = ?, duration_ms = ?, calls = ?, errors = ?,
          input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, cost_usd = ?, summary = ?
        WHERE id = ?`).run(
        status,
        new Date().toISOString(),
        totals.durationMs,
        totals.calls,
        totals.errors,
        totals.inputTokens,
        totals.outputTokens,
        totals.cacheReadTokens,
        totals.cacheWriteTokens,
        totals.costUsd,
        summary === undefined ? null : JSON.stringify(summary),
        id,
      );
      log(
        status === 'ok' ? 'info' : 'warn',
        `${status}: ${totals.calls} calls, ${totals.errors} errors, ` +
          `${totals.inputTokens} in / ${totals.outputTokens} out, ` +
          `${totals.cacheReadTokens} cache read / ${totals.cacheWriteTokens} cache write, ` +
          `$${totals.costUsd.toFixed(4)}${totals.unpricedCalls ? ` (+${totals.unpricedCalls} unpriced)` : ''}, ` +
          `${totals.durationMs} ms`,
      );
      return finished;
    }

    return { id, recordCall, log, finish };
  }

  return { startRun };
}
