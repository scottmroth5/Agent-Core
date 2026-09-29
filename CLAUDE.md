# Agent Core

## Purpose
Generic agent infrastructure shared by Job-Agent and Health-Review.
Consumed by Job-Agent and Health-Review as a git dependency pinned to version tags:
"@scottmroth5/agent-core": "github:scottmroth5/Agent-Core#semver:^<version>". This repo is public.

## Releasing
Always release with npm version, never by editing "version" by hand, so the tag and package.json always match:
npm version <x.y.z> -m "Release %s"   then   git push origin main --follow-tags
Consumers pick it up with npm install "github:scottmroth5/Agent-Core#semver:^<x.y.z>" (a caret on 0.x never crosses a minor version on its own).
To test an unreleased change, run npm link ../Agent-Core in the consumer.

## Structure
/src/claude.js       createClaude: SDK client wrapper; cached system prompt, JSON schema output, stop_reason checks, cost
/src/pricing.js      per-model USD rates and costFromUsage (internal); update when models or prices change
/src/trace.js        createTracer: per-run call metadata, token and cost totals, persisted to the store when given
/src/store.js        openStore: better-sqlite3, WAL, namespaced migrations (agent-core owns runs and run_calls)
/src/index.js        public exports
/test                node:test suites, synthetic data only
/scripts/smoke.js    manual real-API check; needs ANTHROPIC_API_KEY
Planned for 0.3.0: /src/agentLoop.js (tool use loop with step limits), /src/tools.js (tool registry), /src/validators.js.

## Commands
npm test                                        run unit tests (no network, no API key)
node --test test/store.test.js                  run one suite
node --env-file=<.env> scripts/smoke.js         one real Haiku call (costs a fraction of a cent)

## Hard rules
No domain logic. Nothing about jobs, resumes, health, or any specific agent.
No personal data, fixtures from real data, or API keys, ever.
Every public export is documented and covered by a unit test.
Breaking changes to exports must be updated in both Job-Agent and Health-Review.
Traces and logs hold metadata only (model, tokens, cost, timing, errors); never prompt or response text.
agent-core never chooses a model; callers pass exact model IDs.

## Conventions
Keep the public API small; add exports only when a second consumer needs them.
Use plan mode for any change touching more than one file.
Leave retries and timeouts to the Anthropic SDK; do not wrap them in a second retry loop.
