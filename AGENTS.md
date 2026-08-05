# AGENTS.md — Biunivers Codex

This repository delivers one Biunivers Workspace Application OCI image.

- Read the BWA protocol and README before changing runtime behavior.
- Keep UI on `0.0.0.0:8080`, `/health` side-effect free, primary state under `/workspace`, and temporary data under `/tmp`.
- Preserve non-root operation, read-only container root compatibility, protocol/OCI labels, and clean SIGTERM handling.
- Never commit or print model credentials. Codex child commands must not inherit model API secrets.
- The outer BWA container is the security boundary; do not request Docker socket, host mounts, capabilities, privileged mode, or host networking.
- Keep the preset agent instructions separate from project-owned `/workspace/AGENTS.md`.
- Pin the Codex version. Treat App Server schemas and event names as version-specific.
- Before publishing, run syntax checks, unit tests, the container verification script, and inspect image labels and logs for secrets.
