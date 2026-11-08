#!/usr/bin/env bash
# Run on InstaBox with flock /data/locks/heavy.lock bash scripts/ssh-test/verify.sh.
set -Eeuo pipefail
export COMPOSE_PROJECT_NAME=edgeweir-ssh-1108
export SSH_TEST_TAG=ssh-1108
dc() { docker compose -f scripts/ssh-test/compose.yml "$@"; }
cleanup() {
  result=$?
  trap - EXIT
  dc down -v --remove-orphans || true
  docker rmi "edgeweir-ssh-test:$SSH_TEST_TAG" || true
  docker builder prune -f
  exit "$result"
}
trap cleanup EXIT
docker ps
test -z "$(docker ps -q)"
dc build jump
dc up -d
export EDGEWEIR_SSH_REAL=1
export SSH_TEST_JUMP_CONTAINER=$(dc ps -q jump)
export SSH_TEST_TARGET_CONTAINER=$(dc ps -q target)
flock /data/locks/check.lock pnpm --filter @edgeweir/console exec vitest run test/server/ssh-real.test.ts --maxWorkers=1
