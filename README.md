# Biunivers Codex

Biunivers Codex is a general conversational Workspace Application. It runs Codex inside the BWA container, presents a small browser UI, and lets the agent work only in the Workspace bound to that Instance.

## Required configuration

| Variable | Required | Sensitive | Example |
|---|---:|---:|---|
| `BIUNIVERS_MODEL_BASE_URL` | yes | no | `https://api.cloudflare.com/client/v4/accounts/<account-id>/ai/v1` |
| `BIUNIVERS_MODEL_NAME` | yes | no | `@cf/openai/gpt-oss-20b` |
| `BIUNIVERS_MODEL_API_KEY` | yes for Workers AI | yes | configure in the BWA sensitive-variable editor |

The endpoint must implement the OpenAI Responses API. The first release targets Cloudflare Workers AI with `@cf/openai/gpt-oss-20b` or `@cf/openai/gpt-oss-120b`. It does not use ChatGPT or OpenAI login and does not use Codex `--oss`, which is intended for built-in local Ollama/LM Studio providers.

## State and boundaries

- User files and Codex conversation state live under `/workspace`.
- The generated Codex configuration contains only the API-key environment-variable name, never its value.
- The API key is filtered out of shell commands launched by Codex.
- Codex runs without its nested sandbox because the outer BWA runtime already provides a non-root OCI sandbox with no capabilities or host access.
- Network access remains available under BWA v1. The agent can modify the current Workspace; the user controls commit, discard, stop, and Fork in Biunivers.

## Development

```bash
npm run check
npm test
docker build -t biunivers-codex:dev .
```

The current version is an early integration skeleton: one in-memory active conversation per running container, streamed agent text and activity events, cancellation, and a new-conversation action. Rich approvals, historical conversation selection, attachments, multi-agent operation, and unattended tasks are intentionally out of scope.
