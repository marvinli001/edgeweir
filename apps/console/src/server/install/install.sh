#!/usr/bin/env bash
# Edgeweir node installer, served by the Edgeweir console at /install.sh.
#
#   curl -fsSL https://<console>/install.sh | sudo bash -s -- \
#     --server https://<console>:8443 --token <one-time token> --ca-sha256 <fingerprint>
#
# What it does, in order:
#   1. downloads the edgeweir-node release archive, checksums.txt and its
#      cosign signature bundle (from the console mirror, or GitHub);
#   2. verifies the cosign keyless signature of checksums.txt against the
#      edgeweir-node release workflow identity, then the archive's SHA-256;
#      nothing is executed before both checks pass;
#   3. installs OpenResty from the official openresty.org repository if needed;
#   4. installs the agent, its Lua files and the systemd unit;
#   5. enrolls the node with the one-time token (the private key is generated
#      locally and never leaves this machine) and starts the service.
# It never stores SSH credentials and never phones home.
set -euo pipefail

CONSOLE_URL="__EDGEWEIR_CONSOLE_URL__"
VERSION="latest"
SERVER=""
TOKEN=""
CA_SHA256=""
MIRROR=""
ALLOW_UNSIGNED="false"
REPO="edgeweir/edgeweir-node"
CERT_IDENTITY_REGEXP="^https://github.com/${REPO}/.github/workflows/release.yml@refs/tags/v.*$"
OIDC_ISSUER="https://token.actions.githubusercontent.com"

log() { printf '\033[1;34m[edgeweir]\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m[edgeweir] error:\033[0m %s\n' "$*" >&2; exit 1; }

usage() {
  cat >&2 <<USAGE
Usage: install.sh --server URL --token TOKEN --ca-sha256 HEX [options]

  --server URL         node channel URL of the console, e.g. https://console.example.com:8443
  --token TOKEN        one-time enrollment token from the console
  --ca-sha256 HEX      SHA-256 fingerprint of the console's node CA (pinned during enrollment)
  --version VER        edgeweir-node version to install (default: latest)
  --mirror URL         base URL to download release files from (default: console mirror, then GitHub)
  --allow-unsigned     skip the cosign signature check (development only; SHA-256 is still verified)
USAGE
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="${2:-}"; shift 2 ;;
    --token) TOKEN="${2:-}"; shift 2 ;;
    --ca-sha256) CA_SHA256="${2:-}"; shift 2 ;;
    --version) VERSION="${2:-}"; shift 2 ;;
    --mirror) MIRROR="${2:-}"; shift 2 ;;
    --allow-unsigned) ALLOW_UNSIGNED="true"; shift ;;
    -h|--help) usage ;;
    *) die "unknown option: $1" ;;
  esac
done

[ -n "$SERVER" ] && [ -n "$TOKEN" ] && [ -n "$CA_SHA256" ] || usage
[[ "$CA_SHA256" =~ ^[0-9a-f]{64}$ ]] || die "--ca-sha256 must be 64 lowercase hex characters"
[ "$(id -u)" -eq 0 ] || die "run as root (e.g. via sudo)"
command -v systemctl >/dev/null || die "systemd is required"
command -v curl >/dev/null || die "curl is required"
command -v sha256sum >/dev/null || die "sha256sum is required"

case "$(uname -m)" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

if [ "$VERSION" = "latest" ]; then
  VERSION="$(curl -fsSL "${CONSOLE_URL}/downloads/edgeweir-node/latest" 2>/dev/null || true)"
  if [ -z "$VERSION" ]; then
    VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
      | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n1)"
  fi
  [ -n "$VERSION" ] || die "could not determine the latest edgeweir-node version; pass --version"
fi
VERSION="${VERSION#v}"
ARCHIVE="edgeweir-node_${VERSION}_linux_${ARCH}.tar.gz"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fetch() {
  local name="$1" base
  for base in ${MIRROR:+"$MIRROR"} "${CONSOLE_URL}/downloads/edgeweir-node/v${VERSION}" \
    "https://github.com/${REPO}/releases/download/v${VERSION}"; do
    if curl -fsSL --retry 3 -o "${WORK}/${name}" "${base}/${name}"; then
      return 0
    fi
  done
  die "failed to download ${name}"
}

log "downloading edgeweir-node ${VERSION} (${ARCH})"
fetch "$ARCHIVE"
fetch "checksums.txt"

if [ "$ALLOW_UNSIGNED" = "true" ]; then
  log "WARNING: --allow-unsigned given, skipping the cosign signature check"
else
  command -v cosign >/dev/null || die "cosign is required to verify the release signature (https://docs.sigstore.dev/cosign/system_config/installation/)"
  fetch "checksums.txt.sigstore.json"
  cosign verify-blob \
    --bundle "${WORK}/checksums.txt.sigstore.json" \
    --certificate-identity-regexp "$CERT_IDENTITY_REGEXP" \
    --certificate-oidc-issuer "$OIDC_ISSUER" \
    "${WORK}/checksums.txt" >/dev/null || die "cosign signature verification FAILED"
  log "cosign signature verified"
fi

( cd "$WORK" && grep " ${ARCHIVE}\$" checksums.txt | sha256sum -c --status - ) \
  || die "SHA-256 verification FAILED for ${ARCHIVE}"
log "SHA-256 verified"

if ! command -v openresty >/dev/null; then
  log "installing OpenResty from openresty.org"
  if command -v apt-get >/dev/null; then
    apt-get update -y && apt-get install -y --no-install-recommends wget gnupg ca-certificates lsb-release
    wget -qO - https://openresty.org/package/pubkey.gpg | gpg --dearmor -o /usr/share/keyrings/openresty.gpg
    . /etc/os-release
    echo "deb [signed-by=/usr/share/keyrings/openresty.gpg] http://openresty.org/package/${ID} ${VERSION_CODENAME} $( [ "$ID" = ubuntu ] && echo main || echo openresty )" \
      > /etc/apt/sources.list.d/openresty.list
    apt-get update -y && apt-get install -y --no-install-recommends openresty
  elif command -v dnf >/dev/null || command -v yum >/dev/null; then
    PM="$(command -v dnf || command -v yum)"
    curl -fsSL -o /etc/yum.repos.d/openresty.repo https://openresty.org/package/centos/openresty.repo
    "$PM" install -y openresty
  else
    die "unsupported package manager; install OpenResty manually and re-run"
  fi
  systemctl disable --now openresty >/dev/null 2>&1 || true
fi

log "installing edgeweir-node"
tar -xzf "${WORK}/${ARCHIVE}" -C "$WORK"
install -m 0755 "${WORK}/edgeweir-node" /usr/bin/edgeweir-node
mkdir -p /usr/share/edgeweir-node
rm -rf /usr/share/edgeweir-node/lua && cp -r "${WORK}/lua" /usr/share/edgeweir-node/lua
install -m 0644 "${WORK}/packaging/systemd/edgeweir-node.service" /etc/systemd/system/edgeweir-node.service
install -d -m 0700 /var/lib/edgeweir-node

log "enrolling with ${SERVER}"
/usr/bin/edgeweir-node enroll --server "$SERVER" --token "$TOKEN" --ca-sha256 "$CA_SHA256" \
  --state-dir /var/lib/edgeweir-node

systemctl daemon-reload
systemctl enable --now edgeweir-node
log "done: edgeweir-node is running (journalctl -u edgeweir-node -f)"
