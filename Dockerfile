# syntax=docker/dockerfile:1
# Edgeweir console: one image, one Node.js process serving the web UI, the
# API and the node channel. ROLE=app|worker|all selects what runs (default all).

ARG NODE_IMAGE=node:24.21.0-alpine
ARG GO_IMAGE=golang:1.27.1-alpine

# --- edgeweir-certd (Go helper) ------------------------------------------------
FROM ${GO_IMAGE} AS certd
WORKDIR /src
COPY helpers/certd/ ./
ARG VERSION=0.1.0-dev
RUN CGO_ENABLED=0 go build -trimpath -buildvcs=false \
      -ldflags "-s -w -X main.Version=${VERSION}" -o /out/edgeweir-certd .

# --- web + server build ---------------------------------------------------------
FROM ${NODE_IMAGE} AS build
RUN npm install -g pnpm@12.6.0 && pnpm --version
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/console/package.json apps/console/
COPY packages/proto/package.json packages/proto/
COPY packages/contract/package.json packages/contract/
COPY packages/db/package.json packages/db/
COPY packages/config-compiler/package.json packages/config-compiler/
RUN pnpm install --frozen-lockfile
COPY apps/console apps/console
COPY packages packages
ARG VERSION=0.1.0-dev
ENV EDGEWEIR_VERSION=${VERSION}
RUN pnpm --filter @edgeweir/console run build

# --- runtime --------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG VERSION=0.1.0-dev
LABEL org.opencontainers.image.title="edgeweir" \
      org.opencontainers.image.description="Edgeweir console: self-hosted CDN / WAF / edge scheduling control plane" \
      org.opencontainers.image.source="https://github.com/edgeweir/edgeweir" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${VERSION}"
RUN apk add --no-cache tini
WORKDIR /app
# The server is bundled into a single file: no node_modules at runtime.
COPY --from=build --chown=root:root /repo/apps/console/dist ./dist
COPY --from=certd --chown=root:root /out/edgeweir-certd /usr/local/bin/edgeweir-certd
COPY --chmod=0755 docker/healthcheck.sh /usr/local/bin/edgeweir-healthcheck
ENV NODE_ENV=production \
    ROLE=all \
    HOST=0.0.0.0 \
    PORT=3000 \
    NODE_API_PORT=8443 \
    EDGEWEIR_VERSION=${VERSION} \
    EDGEWEIR_CERTD_BIN=/usr/local/bin/edgeweir-certd
USER node
EXPOSE 3000 8443
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 CMD ["edgeweir-healthcheck"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "--enable-source-maps", "dist/server/main.js"]
