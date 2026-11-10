#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export E2E_TAG="${E2E_TAG:-${COMPOSE_PROJECT_NAME:-e2e}}"
export CI_LOCAL_IMAGE="edgeweir:$E2E_TAG"
candidate="${CI_ACCEPTANCE_DIR:-.local/acceptance}/candidate"
case "${1:-}" in
  checks)
    pnpm install --frozen-lockfile
    pnpm lint
    pnpm proto:gen
    git diff --exit-code -- packages/proto
    PROTO_REMOTE=https://github.com/marvinli001/edgeweir.git pnpm proto:breaking
    pnpm typecheck
    pnpm build
    ;;
  tests)
    postgres="${COMPOSE_PROJECT_NAME:?Set an isolated project}-unit-postgres"
    docker run --rm -d --name "$postgres" -p 127.0.0.1::5432 -e POSTGRES_PASSWORD=ci-test-only postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873
    for attempt in $(seq 1 60); do
      if docker exec "$postgres" pg_isready -U postgres; then break; fi
      sleep 1
    done
    port=$(docker port "$postgres" 5432/tcp | awk -F: '{print $NF}')
    export TEST_DATABASE_URL="postgres://postgres:ci-test-only@127.0.0.1:$port/postgres"
    export EDGEWEIR_TEST_POSTGRES_URL="$TEST_DATABASE_URL"
    pnpm exec turbo run test --force
    ;;
  certd)
    cd helpers/certd
    go vet ./...
    go test -race ./...
    ;;
  containers)
    python3 scripts/ci-image.py build --directory "$candidate"
    python3 scripts/ci-image.py load --directory "$candidate"
    node_context="$(realpath "${EDGEWEIR_NODE_CONTEXT:-../edgeweir-node}")"
    docker buildx bake --allow="fs.read=$node_context" -f compose.e2e.yml --set node.args.OPENRESTY_JOBS=4 --load node geoip-fixture
    pnpm --filter @edgeweir/console exec playwright install --with-deps chromium
    ;&
  e2e)
    docker compose -f compose.e2e.yml up -d --no-build
    args=()
    if [ -n "${CI_E2E_SECTIONS:-}" ]; then args+=(--only "$CI_E2E_SECTIONS"); fi
    # CI's e2e matrix: shard N of scripts/e2e.sh --shards (0 or unset: every section).
    if [ "${CI_E2E_SHARD:-0}" != 0 ]; then args+=(--shard "$CI_E2E_SHARD"); fi
    bash scripts/e2e.sh ${args[@]+"${args[@]}"}
    ;;
  cleanup)
    docker compose -f compose.e2e.yml --profile '*' down -v --remove-orphans
    if docker container inspect "${COMPOSE_PROJECT_NAME}-unit-postgres" >/dev/null 2>&1; then docker rm -f "${COMPOSE_PROJECT_NAME}-unit-postgres"; fi
    for image in "edgeweir:$E2E_TAG" "edgeweir-node:$E2E_TAG" "edgeweir-geoip-fixture:$E2E_TAG"; do
      if docker image inspect "$image" >/dev/null 2>&1; then docker image rm "$image"; fi
    done
    docker builder prune -f
    ;;
  *) echo 'Expected checks, tests, certd, containers or cleanup' >&2; exit 2 ;;
esac
