# Agent Core

## Purpose
Generic agent infrastructure shared by Job-Agent and Health-Review.
Consumed as a local npm dependency (npm install ../Agent-Core).

## Structure
/src/claude.js       API client, retries, model tiering, prompt caching
/src/agentLoop.js    tool use loop with step limits and tracing
/src/tools.js        tool registry: JSON schema plus handler pattern
/src/store.js        SQLite access layer
/src/validators.js   generic validation utilities
/src/trace.js        run logging and token cost tracking
/src/index.js        public exports

## Commands
npm test            run unit tests

## Hard rules
No domain logic. Nothing about jobs, resumes, health, or any specific agent.
No personal data, fixtures from real data, or API keys, ever.
Every public export is documented and covered by a unit test.
Breaking changes to exports must be updated in both Job-Agent and Health-Review.

## Conventions
Keep the public API small; add exports only when a second consumer needs them.
Use plan mode for any change touching more than one file.