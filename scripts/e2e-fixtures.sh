#!/usr/bin/env bash
# Build products of the edgeweir-node checkout the e2e run needs, taken from
# the cache of scripts/e2e-cache.mjs ($E2E_CACHE_DIR, ~/.cache/edgeweir-e2e)
# or built and cached:
#   bash scripts/e2e-fixtures.sh openresty NODE_CONTEXT LOG_DIR
#     the edgeweir-openresty packages of `make openresty-packages` in
#     NODE_CONTEXT/out/openresty, for the Docker architecture
#   bash scripts/e2e-fixtures.sh dist NODE_CONTEXT LOG_DIR
#     the goreleaser snapshot in NODE_CONTEXT/dist (needs the packages)
#   bash scripts/e2e-fixtures.sh all NODE_CONTEXT LOG_DIR
#     both, the old node images of e2e-g3/e2e-g8, then drops every other
#     cached build (the CI fixtures job, which keeps the cache between runs)
# scripts/e2e.sh sources this file for openresty_vars and runs the first two
# in its install section. Needs docker, node, git, and to build: make, syft,
# goreleaser and Go.
set -euo pipefail

# openresty_vars NODE_CONTEXT ARCH: the edgeweir-openresty version and file names.
openresty_vars() {
  OPENRESTY_VERSION="$(awk '$1 == "openresty" { print $2 }' "$1/packaging/openresty/sources.lock")"
  OPENRESTY_RELEASE="$(awk '$1 == "release:" { print $2 }' "$1/packaging/openresty/nfpm/edgeweir-openresty.yaml")"
  OPENRESTY_PKG="$OPENRESTY_VERSION-$OPENRESTY_RELEASE"
  OPENRESTY_FILES=("edgeweir-openresty_${OPENRESTY_PKG}_$2.deb" "edgeweir-openresty-modsecurity_${OPENRESTY_PKG}_$2.deb"
    "edgeweir-openresty_${OPENRESTY_PKG}_$2.sbom.json")
  RPM_ARCH="$([[ "$2" == arm64 ]] && echo aarch64 || echo x86_64)"
  OPENRESTY_CACHED=("${OPENRESTY_FILES[@]}" "edgeweir-openresty-$OPENRESTY_PKG.$RPM_ARCH.rpm"
    "edgeweir-openresty-modsecurity-$OPENRESTY_PKG.$RPM_ARCH.rpm")
}

fixtures_die() { echo "$*" >&2; exit 1; }
# same_files DIR_A DIR_B FILE...: every FILE exists in DIR_A and is identical in DIR_B.
same_files() {
  local a="$1" b="$2" f
  shift 2
  for f in "$@"; do [[ -f "$a/$f" ]] && cmp -s "$a/$f" "$b/$f" || return 1; done
}

# ensure_openresty NODE_CONTEXT ARCH LOG_DIR
ensure_openresty() {
  local context="$1" arch="$2" log="$3/openresty-packages.log" f
  openresty_vars "$context" "$arch"
  if same_files "$context/out/openresty" "$context/out/openresty" "${OPENRESTY_FILES[@]}"; then
    echo "edgeweir-openresty $OPENRESTY_PKG packages already in $context/out/openresty"
    return
  fi
  node scripts/e2e-cache.mjs openresty restore "$context" "$arch" "${OPENRESTY_CACHED[@]}" && return
  echo "make openresty-packages ARCH=$arch (in $context, log in $log)"
  make -C "$context" openresty-packages ARCH="$arch" >"$log" 2>&1 ||
    { tail -n 40 "$log" >&2; fixtures_die "building the edgeweir-openresty packages failed"; }
  for f in "${OPENRESTY_FILES[@]}"; do
    [[ -f "$context/out/openresty/$f" ]] || fixtures_die "make openresty-packages did not produce $f"
  done
  node scripts/e2e-cache.mjs openresty save "$context" "$arch" "${OPENRESTY_CACHED[@]}" ||
    echo "not cached: packaging/openresty has uncommitted changes in $context"
}

goreleaser_version() { goreleaser --version 2>/dev/null | awk '$1 == "GitVersion:" { print $2 }'; }

# ensure_dist NODE_CONTEXT ARCH LOG_DIR: a cached snapshot is used only when it
# carries the very packages in out/openresty (they are copied into dist/).
ensure_dist() {
  local context="$1" arch="$2" log="$3/goreleaser.log" version
  command -v goreleaser >/dev/null || fixtures_die "missing required tool: goreleaser"
  version="$(goreleaser_version)"
  [[ -n "$version" ]] || fixtures_die "cannot read the goreleaser version"
  openresty_vars "$context" "$arch"
  if node scripts/e2e-cache.mjs dist restore "$context" "$arch" "$version"; then
    same_files "$context/dist" "$context/out/openresty" "${OPENRESTY_FILES[@]}" && return
    echo "the cached snapshot carries other edgeweir-openresty packages than out/openresty; building again"
  fi
  echo "goreleaser release --snapshot --clean (in $context, log in $log)"
  (cd "$context" && goreleaser release --snapshot --clean) >"$log" 2>&1 ||
    { tail -n 40 "$log" >&2; fixtures_die "goreleaser snapshot build failed"; }
  node scripts/e2e-cache.mjs dist save "$context" "$arch" "$version" ||
    echo "not cached: $context has uncommitted changes"
}

fixtures_main() {
  local command="${1:-}" context="${2:-}" logs="${3:-}" arch pid status=0
  [[ -n "$context" && -n "$logs" ]] || fixtures_die "usage: e2e-fixtures.sh openresty|dist|all NODE_CONTEXT LOG_DIR"
  mkdir -p "$logs"
  context="$(cd "$context" && pwd)" logs="$(cd "$logs" && pwd)"
  cd "$(dirname "${BASH_SOURCE[0]}")/.."
  arch="$(docker version --format '{{.Server.Arch}}')"
  case "$command" in
    openresty) ensure_openresty "$context" "$arch" "$logs" ;;
    dist) ensure_dist "$context" "$arch" "$logs" ;;
    all)
      # The old node images build beside the packages (each its own Docker build).
      node scripts/e2e-cache.mjs images "$context" >"$logs/old-node-images.log" 2>&1 &
      pid=$!
      (ensure_openresty "$context" "$arch" "$logs" && ensure_dist "$context" "$arch" "$logs") || status=$?
      wait "$pid" || { tail -n 40 "$logs/old-node-images.log" >&2; status=1; }
      cat "$logs/old-node-images.log"
      ((status == 0)) || fixtures_die "e2e fixtures failed"
      node scripts/e2e-cache.mjs prune "$context" "$arch" "$(goreleaser_version)"
      ;;
    *) fixtures_die "usage: e2e-fixtures.sh openresty|dist|all NODE_CONTEXT LOG_DIR" ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then fixtures_main "$@"; fi
