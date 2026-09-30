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
 * @param {object} [options.client]      pre-built client exposing messages.create (used by tests)
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
 * @property {object} [trace]            a run from createTracer().startRun()
 * @property {string} [label]            short call name recorded in the trace
 *
 * @typedef {object} SendResult
 * @property {string} text
 * @property {any}    data               parsed JSON when schema was given, else null
 * @property {string} stopReason
 * @property {{input:number, output:number, cacheRead:number, cacheWrite:number}} usage
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
    const { model, maxTokens, system, prompt, messages, schema, thinking, effort, trace, label } = opts ?? {};
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

    const started = Date.now();
    let result = null;
    try {
      const response = await getApi().messages.create(params);
      const usage = response.usage ?? {};
      result = {
        text: (response.content ?? [])
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim(),
        data: null,
        stopReason: response.stop_reason,
        usage: {
          input: usage.input_tokens ?? 0,
          output: usage.output_tokens ?? 0,
          cacheRead: usage.cache_read_input_tokens ?? 0,
          cacheWrite: usage.cache_creation_input_tokens ?? 0,
        },
        costUsd: costFromUsage(response.model ?? model, usage) ?? costFromUsage(model, usage),
        model: response.model ?? model,
        id: response.id,
      };
      if (response.stop_reason === 'max_tokens') throw new ClaudeTruncatedError(result);
      if (response.stop_reason === 'refusal') throw new ClaudeRefusalError(result, response.stop_details);
      if (schema) result.data = JSON.parse(result.text);
      record(trace, label, model, started, result, null);
      return result;
    } catch (err) {
      record(trace, label, model, started, result, err);
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

// Metadata only: never prompt or response text.
function record(trace, label, model, started, result, err) {
  if (!trace) return;
  trace.recordCall({
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
