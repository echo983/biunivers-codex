FROM ghcr.io/openai/codex-universal:latest

ARG VCS_REF=unknown
ARG CODEX_VERSION=0.146.0

LABEL io.biunivers.workspace-application.protocol="1" \
      org.opencontainers.image.title="Biunivers Codex" \
      org.opencontainers.image.description="General Workspace assistant powered by Codex and a user-configured Cloudflare Workers AI model" \
      org.opencontainers.image.source="https://github.com/echo983/biunivers-codex" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.revision="$VCS_REF" \
      org.opencontainers.image.licenses="MIT"

USER root
SHELL ["/bin/bash", "-c"]
RUN . "$NVM_DIR/nvm.sh" \
    && nvm use 24 \
    && npm install --global --prefix /opt/node-global "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force \
    && cp "$(command -v node)" /usr/local/bin/node \
    && ln -sf /opt/node-global/bin/codex /usr/local/bin/codex \
    && chmod -R a+rX /opt/node-global
WORKDIR /app
COPY --chown=65532:65532 package.json server.mjs ./
COPY --chown=65532:65532 src ./src
COPY --chown=65532:65532 public ./public
COPY --chown=65532:65532 preset ./preset

ENV NODE_ENV=production \
    HOME=/tmp/biunivers-home \
    BIUNIVERS_HTTP_PORT=8080 \
    BIUNIVERS_WORKSPACE=/workspace
USER 65532:65532
EXPOSE 8080
ENTRYPOINT []
CMD ["node", "server.mjs"]
