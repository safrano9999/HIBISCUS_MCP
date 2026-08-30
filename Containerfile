# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=docker.io/library/node:24.18.1-alpine@sha256:f70403e87646dc51b45295f4b8b70cdad0b63d2297c4c9899119b03f7af7a6b3

FROM ${NODE_IMAGE} AS builder
ARG SUPERGATEWAY_REVISION=973c4595250dcd59da83c12c4f11ff653b6cd4f0
RUN apk add --no-cache git
WORKDIR /src/supergateway
RUN git init \
    && git remote add origin https://github.com/supercorp-ai/supergateway.git \
    && git fetch --depth=1 origin "${SUPERGATEWAY_REVISION}" \
    && git checkout --detach FETCH_HEAD \
    && test "$(git rev-parse HEAD)" = "${SUPERGATEWAY_REVISION}"
COPY patches/supergateway-bearer.patch /tmp/supergateway-bearer.patch
COPY patches/supergateway-bind-host.patch /tmp/supergateway-bind-host.patch
RUN git apply --unidiff-zero --check /tmp/supergateway-bearer.patch \
    && git apply --unidiff-zero /tmp/supergateway-bearer.patch \
    && git apply --check /tmp/supergateway-bind-host.patch \
    && git apply /tmp/supergateway-bind-host.patch \
    && npm ci \
    && npm run build \
    && npm prune --omit=dev
WORKDIR /src/hibiscus-mcp
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs ./
RUN npm test

FROM ${NODE_IMAGE}
RUN apk add --no-cache ca-certificates tini \
    && mkdir -p /opt/hibiscus-mcp /opt/supergateway \
    && chown -R node:node /opt/hibiscus-mcp /opt/supergateway
COPY --from=builder --chown=node:node /src/hibiscus-mcp /opt/hibiscus-mcp
COPY --from=builder --chown=node:node /src/supergateway/dist /opt/supergateway/dist
COPY --from=builder --chown=node:node /src/supergateway/node_modules /opt/supergateway/node_modules
COPY --chown=node:node --chmod=0755 entrypoint.sh /usr/local/bin/hibiscus-mcp-entrypoint

LABEL org.opencontainers.image.title="Hibiscus MCP" \
      org.opencontainers.image.description="Minimal bearer-aware Streamable HTTP MCP bridge for Hibiscus XML-RPC" \
      org.opencontainers.image.source="https://github.com/safrano9999/HIBISCUS_MCP" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production HIBISCUS_MCP_PORT=8000 HIBISCUS_MCP_UPSTREAM_URL=https://hibiscus:8080
USER node
EXPOSE 8000
ENTRYPOINT ["/sbin/tini", "-g", "--", "/usr/local/bin/hibiscus-mcp-entrypoint"]
