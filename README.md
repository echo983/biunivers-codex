# Biunivers Codex

Biunivers Codex is a general conversational Workspace Application. It runs Codex inside the BWA container, presents a small browser UI, and lets the agent work only in the Workspace bound to that Instance.

## Required configuration

| Variable | Required | Sensitive | Example |
|---|---:|---:|---|
| `CODEX_MODEL_BASE_URL` | yes | no | `https://api.cloudflare.com/client/v4/accounts/<account-id>/ai/v1` |
| `CODEX_MODEL_NAME` | yes | no | `@cf/openai/gpt-oss-20b` |
| `CODEX_MODEL_API_KEY` | yes for Workers AI | yes | configure in the BWA sensitive-variable editor |

The first release targets Cloudflare Workers AI with `@cf/openai/gpt-oss-20b` or `@cf/openai/gpt-oss-120b`. The internal adapter presents the Responses API expected by Codex and translates it to Cloudflare's OpenAI-compatible Chat Completions API. It does not use ChatGPT or OpenAI login and does not use Codex `--oss`, which is intended for built-in local Ollama/LM Studio providers.

## State and boundaries

- User files live under `/workspace`. Codex's own caches, databases, downloaded skills, and temporary links live under `/tmp` and are never committed into the Workspace. The current lightweight conversation is ephemeral across container restarts.
- The entrypoint passes the model API key through a mode-`0600` one-time file in `/tmp`, clears it from PID 1's environment, and the Web backend deletes the file before starting Codex or HTTP service. Codex connects to an internal loopback adapter and does not inherit the key.
- The adapter translates text history, function declarations, calls, and results between Codex Responses and Cloudflare Chat Completions. It uses a non-streaming upstream call and converts the result to standard Responses SSE events for Codex.
- Codex runs without its nested sandbox because the outer BWA runtime already provides a non-root OCI sandbox with no capabilities or host access.
- Network access remains available under BWA v1. The agent can modify the current Workspace; the user controls commit, discard, stop, and Fork in Biunivers.

## Development

```bash
npm run check
npm test
docker build -t biunivers-codex:dev .
```

The current version is an early integration skeleton: one in-memory active conversation per running container, streamed agent text and activity events, cancellation, and a new-conversation action. Model-token streaming is currently synthesized after each Cloudflare response; tool activity still appears between model rounds. Rich approvals, historical conversation selection, attachments, multi-agent operation, web search, and unattended tasks are intentionally out of scope.
