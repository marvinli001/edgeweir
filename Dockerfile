# syntax=docker/dockerfile:1.26.0@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# Edgeweir console: one image, one Node.js process serving the web UI, the
# API and the node channel. ROLE=app|worker|all selects what runs (default all).
#
# VERSION is the rolling version <YYYYMMDD>-<commit> (scripts/image-version.sh);
# the release workflow passes it with REVISION, the full commit id.
#
# Every base image is pinned by tag and multi-arch index digest; the digest is
# what gets pulled (ADR-0017). Refresh tag and digest together (CONTRIBUTING.md).

ARG NODE_IMAGE=node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
ARG GO_IMAGE=golang:1.27.2-alpine@sha256:f92b6ef800e499660581efdabdf25d9d817a9d124eaf900924f0504e7e27e12d

# The certd and build stages run on the build machine's own platform for
# every target: certd is cross-compiled, and the web + server build is
# JavaScript and static assets (an arm64 vite build emulated by QEMU crashed
# with SIGILL).

# --- edgeweir-certd (Go helper) ------------------------------------------------
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS certd
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY helpers/certd/ ./
ARG VERSION=dev
RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -buildvcs=false \
      -ldflags "-s -w -X main.Version=${VERSION}" -o /out/edgeweir-certd .

# --- web + server build ---------------------------------------------------------
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
RUN npm install -g pnpm@12.6.0 && pnpm --version
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY apps/console/package.json apps/console/
COPY packages/proto/package.json packages/proto/
COPY packages/contract/package.json packages/contract/
COPY packages/db/package.json packages/db/
COPY packages/config-compiler/package.json packages/config-compiler/
COPY packages/rule-engine/package.json packages/rule-engine/
RUN pnpm install --frozen-lockfile
COPY apps/console apps/console
COPY packages packages
ARG VERSION=dev
ENV EDGEWEIR_VERSION=${VERSION}
RUN pnpm --filter @edgeweir/console run build

# --- runtime --------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="edgeweir" \
      org.opencontainers.image.description="Edgeweir console: self-hosted CDN / WAF / edge scheduling control plane" \
      org.opencontainers.image.source="https://github.com/marvinli001/edgeweir" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
RUN apk add --no-cache tini
WORKDIR /app
# The server is bundled into a single file: no node_modules at runtime.
COPY --from=build --chown=root:root /repo/apps/console/dist ./dist
COPY --from=certd --chown=root:root /out/edgeweir-certd /usr/local/bin/edgeweir-certd
COPY --chmod=0755 docker/healthcheck.sh /usr/local/bin/edgeweir-healthcheck
# Installer and upgrade script for the 宝塔 / aaPanel compose deployments, so a
# server can refresh it from the image it runs (docs/deploy/baota.md).
COPY --chmod=0755 deploy.sh ./deploy.sh
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
