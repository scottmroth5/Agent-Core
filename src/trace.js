/**
 * Creates a run tracer. A run collects per-call metadata (tokens, cost, timing,
 * errors) and totals it on finish. Traces never hold prompt or response text.
 *
 * Where runs are kept is up to the caller:
 * - options.sink (0.5.0): the app writes them itself. The tracer hands over each run, call, and finish as plain
 *   objects (meta and summary as given, times as ISO strings) and writes no SQL, so the app chooses the database.
 * - options.store: the built-in SQLite writer for the runs and run_calls tables that openStore() creates. The store's
 *   db only needs prepare(sql).run(...params), synchronous (better-sqlite3) or asynchronous (a promise), returning the
 *   inserted row's id as lastInsertRowid or id.
 * - neither: the run is kept in memory and summarized to the logger.
 * startRun, recordCall, and finish return promises either way (0.4.0).
 *
 * @param {object} [options]
 * @param {TraceSink} [options.sink]
 * @param {{ db: TraceDb }} [options.store]   not together with sink
 * @param {{ info: Function, warn: Function, error: Function }} [options.logger]  defaults to console
 * @returns {{ startRun: (name: string, meta?: object) => Promise<Run> }}
 *
 * @typedef {object} TraceSink
 * @property {(run: { name: string, meta: object, startedAt: string }) => RunId | Promise<RunId>} startRun
 *   returns the stored run's id, or null when it keeps none
 * @property {(runId: RunId, call: StoredCall) => unknown} recordCall   may return a promise
 * @property {(runId: RunId, finish: Totals & { finishedAt: string, summary: unknown }) => unknown} finishRun
 *   may return a promise; summary is undefined when finish() was given none. Called once per run.
 * @typedef {number | string | null} RunId
 * @typedef {CallInfo & { createdAt: string }} StoredCall   CallInfo with missing counts as 0 and the rest as null
 *
 * @typedef {{ prepare: (sql: string) => { run: (...params: unknown[]) => RunResult | Promise<RunResult> } }} TraceDb
 * @typedef {{ lastInsertRowid?: number | bigint, id?: number | string | bigint }} RunResult
 *
 * @typedef {object} Run
 * @property {RunId} id                                      the sink's run id (runs.id with a store), else null
 * @property {(info: CallInfo) => Promise<void>} recordCall   awaited by createClaude().send when given as trace
 * @property {(level: 'info'|'warn'|'error', msg: string, fields?: object) => void} log
 * @property {(status?: string, summary?: object) => Promise<Totals>} finish   idempotent; later calls return the first totals
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
export function createTracer({ sink, store, logger = console } = {}) {
  if (sink && store) throw new TypeError('createTracer: pass a sink or a store, not both');
  if (sink && !['startRun', 'recordCall', 'finishRun'].every((k) => typeof sink[k] === 'function')) {
    throw new TypeError('createTracer: a sink needs startRun, recordCall, and finishRun functions');
  }
  const out = sink ?? (store?.db ? storeSink(store.db) : null);

  async function startRun(name, meta = {}) {
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
    let finishing = null;

    const id = out ? ((await out.startRun({ name, meta, startedAt: new Date(started).toISOString() })) ?? null) : null;

    async function recordCall(info) {
      totals.calls += 1;
      if (info.error) totals.errors += 1;
      totals.inputTokens += info.inputTokens ?? 0;
      totals.outputTokens += info.outputTokens ?? 0;
      totals.cacheReadTokens += info.cacheReadTokens ?? 0;
      totals.cacheWriteTokens += info.cacheWriteTokens ?? 0;
      if (info.costUsd == null) totals.unpricedCalls += 1;
      else totals.costUsd += info.costUsd;
      await out?.recordCall(id, {
        label: info.label ?? null,
        model: info.model ?? null,
        stopReason: info.stopReason ?? null,
        inputTokens: info.inputTokens ?? 0,
        outputTokens: info.outputTokens ?? 0,
        cacheReadTokens: info.cacheReadTokens ?? 0,
        cacheWriteTokens: info.cacheWriteTokens ?? 0,
        costUsd: info.costUsd ?? null,
        durationMs: info.durationMs ?? null,
        error: info.error ? { name: info.error.name ?? null, message: info.error.message ?? null } : null,
        createdAt: new Date().toISOString(),
      });
    }

    function log(level, msg, fields) {
      const write = logger[level] ?? logger.info ?? logger.log;
      write.call(logger, `[${name}] ${msg}`, ...(fields ? [fields] : []));
    }

    // The first call's totals are fixed before anything is awaited, so a second call (even one made before the
    // first has settled) returns the same totals.
    function finish(status = 'ok', summary) {
      finishing ??= writeFinish(status, summary);
      return finishing;
    }

    async function writeFinish(status, summary) {
      totals.status = status;
      totals.durationMs = Date.now() - started;
      const finished = { ...totals };
      await out?.finishRun(id, { ...finished, finishedAt: new Date().toISOString(), summary });
      log(
        status === 'ok' ? 'info' : 'warn',
        `${status}: ${finished.calls} calls, ${finished.errors} errors, ` +
          `${finished.inputTokens} in / ${finished.outputTokens} out, ` +
          `${finished.cacheReadTokens} cache read / ${finished.cacheWriteTokens} cache write, ` +
          `$${finished.costUsd.toFixed(4)}${finished.unpricedCalls ? ` (+${finished.unpricedCalls} unpriced)` : ''}, ` +
          `${finished.durationMs} ms`,
      );
      return finished;
    }

    return { id, recordCall, log, finish };
  }

  return { startRun };
}

/**
 * The built-in sink behind options.store: the runs and run_calls tables from openStore(), with the run id from
 * SQLite's lastInsertRowid (or an async db's id). The statements are the ones the tracer ran before 0.5.0.
 * @param {TraceDb} db
 * @returns {TraceSink}
 */
function storeSink(db) {
  let insertCall = null;
  return {
    async startRun({ name, meta, startedAt }) {
      const inserted = await db
        .prepare('INSERT INTO runs (name, meta, started_at) VALUES (?, ?, ?)')
        .run(name, JSON.stringify(meta), startedAt);
      return Number(inserted.lastInsertRowid ?? inserted.id);
    },
    async recordCall(runId, c) {
      insertCall ??= db.prepare(`INSERT INTO run_calls
        (run_id, label, model, stop_reason, input_tokens, output_tokens, cache_read_tokens,
         cache_write_tokens, cost_usd, duration_ms, error_name, error_message, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      await insertCall.run(
        runId,
        c.label,
        c.model,
        c.stopReason,
        c.inputTokens,
        c.outputTokens,
        c.cacheReadTokens,
        c.cacheWriteTokens,
        c.costUsd,
        c.durationMs,
        c.error?.name ?? null,
        c.error?.message ?? null,
        c.createdAt,
      );
    },
    async finishRun(runId, f) {
      await db.prepare(`UPDATE runs SET status = ?, finished_at = ?, duration_ms = ?, calls = ?, errors = ?,
          input_tokens = ?, output_tokens = ?, cache_read_tokens = ?, cache_write_tokens = ?, cost_usd = ?, summary = ?
        WHERE id = ?`).run(
        f.status,
        f.finishedAt,
        f.durationMs,
        f.calls,
        f.errors,
        f.inputTokens,
        f.outputTokens,
        f.cacheReadTokens,
        f.cacheWriteTokens,
        f.costUsd,
        f.summary === undefined ? null : JSON.stringify(f.summary),
        runId,
      );
    },
  };
}
