import Anthropic from '@anthropic-ai/sdk';
import { costFromUsage } from './pricing.js';

/**
 * Thrown when a response stops at max_tokens, so a cut-off answer is never
 * treated as complete. Carries the partial text and usage for diagnosis.
 */
export class ClaudeTruncatedError extends Error {
  constructor(result) {
    super(`Claude response truncated at max_tokens (${result.usage.output} output tokens, model ${result.model})`);
    this.name = 'ClaudeTruncatedError';
    this.result = result;
  }
}

/**
 * Thrown when the model declines the request (stop_reason "refusal").
 * stopDetails holds the API's category and explanation, when provided.
 */
export class ClaudeRefusalError extends Error {
  constructor(result, stopDetails) {
    super(`Claude declined the request (${stopDetails?.category ?? 'no category'}, model ${result.model})`);
    this.name = 'ClaudeRefusalError';
    this.result = result;
    this.stopDetails = stopDetails ?? null;
  }
}

/**
 * Creates a thin Claude client. Retries (429, 5xx, connection errors) and
 * timeouts are handled by the Anthropic SDK; this layer adds system prompt
 * caching, structured output, stop_reason checks, cost, and tracing.
 *
 * @param {object} [options]
 * @param {string} [options.apiKey]      defaults to ANTHROPIC_API_KEY via the SDK
 * @param {object} [options.client]      pre-built client exposing messages.create/stream and beta.messages (used by tests)
 * @param {number} [options.maxRetries]  SDK retry count, default 3
 * @param {number} [options.timeoutMs]   per-request timeout in milliseconds, SDK default when omitted
 * @returns {{ send: (opts: SendOptions) => Promise<SendResult> }}
 *
 * @typedef {object} SendOptions
 * @property {string} model              exact model ID; agent-core never picks one
 * @property {number} maxTokens
 * @property {string} [system]           sent as one cached text block
 * @property {string} [prompt]           single user message; use this or messages
 * @property {Array}  [messages]         full Messages API message list
 * @property {object} [schema]           JSON Schema; the response is constrained to it and parsed into data
 * @property {object} [thinking]         passed through unchanged (rules differ per model)
 * @property {string} [effort]           output_config.effort, passed through unchanged
 * @property {Array}  [tools]            tool definitions, passed through (e.g. server tools such as web search)
 * @property {boolean} [stream]          stream the response and wait for the final message (long outputs)
 * @property {string[]} [betas]          beta flags; when given, the beta Messages endpoint is used
 * @property {any}    [fallbacks]        server-side refusal fallbacks, passed through (needs its beta flag)
 * @property {number} [maxContinuations] how many times to resume a pause_turn response, default 5
 * @property {object} [trace]            a run from createTracer().startRun()
 * @property {string} [label]            short call name recorded in the trace
 *
 * @typedef {object} SendResult
 * @property {string} text               every text block, joined with newlines
 * @property {Array}  content            every content block, across resumed pause_turn responses
 * @property {any}    data               parsed JSON when schema was given, else null
 * @property {string} stopReason
 * @property {{input:number, output:number, cacheRead:number, cacheWrite:number, webSearches:number}} usage
 * @property {number|null} costUsd      null when the model has no pricing entry
 * @property {string} model
 * @property {string} id
 */
export function createClaude({ apiKey, client, maxRetries = 3, timeoutMs } = {}) {
  let api = client;
  const getApi = () => {
    api ??= new Anthropic({ apiKey, maxRetries, ...(timeoutMs ? { timeout: timeoutMs } : {}) });
    return api;
  };

  async function send(opts) {
    const { model, maxTokens, system, prompt, messages, schema, thinking, effort, tools, stream, betas, fallbacks, maxContinuations = 5, trace, label } = opts ?? {};
    if (!model) throw new TypeError('send: model is required');
    if (!maxTokens) throw new TypeError('send: maxTokens is required');
    if (!prompt === !messages) throw new TypeError('send: pass exactly one of prompt or messages');

    const params = {
      model,
      max_tokens: maxTokens,
      messages: messages ?? [{ role: 'user', content: prompt }],
    };
    if (system) params.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    if (thinking) params.thinking = thinking;
    if (effort || schema) {
      params.output_config = {};
      if (effort) params.output_config.effort = effort;
      if (schema) params.output_config.format = { type: 'json_schema', schema };
    }
    if (tools?.length) params.tools = tools;
    if (fallbacks) params.fallbacks = fallbacks;
    if (betas?.length) params.betas = betas;

    const request = (p) => {
      const api = betas?.length ? getApi().beta.messages : getApi().messages;
      return stream ? api.stream(p).finalMessage() : api.create(p);
    };

    const started = Date.now();
    let result = null;
    try {
      // Server tools (web search) can pause a long turn; resend it with the paused content and the API resumes.
      const responses = [await request(params)];
      while (responses.at(-1).stop_reason === 'pause_turn' && responses.length <= maxContinuations) {
        params.messages = [...params.messages, { role: 'assistant', content: responses.at(-1).content }];
        responses.push(await request(params));
      }
      const last = responses.at(-1);
      const content = responses.flatMap((r) => r.content ?? []);
      const sum = (pick) => responses.reduce((n, r) => n + (pick(r.usage ?? {}) || 0), 0);
      const costs = responses.map((r) => costFromUsage(r.model ?? model, r.usage) ?? costFromUsage(model, r.usage));
      result = {
        text: content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim(),
        content,
        data: null,
        stopReason: last.stop_reason,
        usage: {
          input: sum((u) => u.input_tokens),
          output: sum((u) => u.output_tokens),
          cacheRead: sum((u) => u.cache_read_input_tokens),
          cacheWrite: sum((u) => u.cache_creation_input_tokens),
          webSearches: sum((u) => u.server_tool_use?.web_search_requests),
        },
        costUsd: costs.some((c) => c === null) ? null : costs.reduce((a, b) => a + b, 0),
        model: last.model ?? model,
        id: last.id,
      };
      if (last.stop_reason === 'max_tokens') throw new ClaudeTruncatedError(result);
      if (last.stop_reason === 'refusal') throw new ClaudeRefusalError(result, last.stop_details);
      if (last.stop_reason === 'pause_turn') throw new Error(`Claude paused the turn more than ${maxContinuations} times (model ${result.model})`);
      if (schema) result.data = JSON.parse(result.text);
      await record(trace, label, model, started, result, null);
      return result;
    } catch (err) {
      await record(trace, label, model, started, result, err);
      throw err;
    }
  }

  return { send };
}

// SDK error subclasses (RateLimitError, ...) may leave name as "Error"; the class name is more useful.
function errorName(err) {
  if (err.name && err.name !== 'Error') return err.name;
  return err.constructor?.name || 'Error';
}

// Metadata only: never prompt or response text. recordCall may return a promise (a stored run); it is awaited so the
// call's row is written before send settles.
async function record(trace, label, model, started, result, err) {
  if (!trace) return;
  await trace.recordCall({
    label: label ?? null,
    model: result?.model ?? model,
    stopReason: result?.stopReason ?? null,
    inputTokens: result?.usage.input ?? 0,
    outputTokens: result?.usage.output ?? 0,
    cacheReadTokens: result?.usage.cacheRead ?? 0,
    cacheWriteTokens: result?.usage.cacheWrite ?? 0,
    costUsd: result?.costUsd ?? null,
    durationMs: Date.now() - started,
    error: err ? { name: errorName(err), message: String(err.message ?? err) } : null,
  });
}
