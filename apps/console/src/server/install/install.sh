#!/usr/bin/env bash
# Edgeweir node installer, served by the Edgeweir console at /install.sh.
#
#   export EDGEWEIR_TOKEN='<one-time token>'
#   curl -fsSL https://<console>/install.sh | sudo --preserve-env=EDGEWEIR_TOKEN bash -s -- \
#     --server https://<console>:8443 --ca-sha256 <fingerprint>
#
# The token never appears on a command line (it would be visible in the
# process list): it comes from the EDGEWEIR_TOKEN environment variable or
# from --token-file PATH, and reaches `edgeweir-node enroll` the same way.
#
# What it does, in order:
#   1. downloads checksums.txt and its cosign signature bundle for the
#      edgeweir-node version (from the console mirror, then GitHub);
#   2. verifies the keyless signature of checksums.txt: the certificate must
#      be the edgeweir-node release workflow at exactly the tag being
#      installed. Without cosign on the machine, a pinned cosign release is
#      downloaded and checked against its SHA-256 first;
#   3. downloads the .deb, .rpm or tar.gz package and verifies its SHA-256
#      against the signed checksums.txt; nothing is executed before steps 2
#      and 3 pass;
#   4. installs OpenResty from the official openresty.org repository if
#      needed, then the package (deb/rpm create the `edgeweir` user and the
#      state directories; for the tar.gz this script does it);
#   5. enrolls the node with the one-time token (the private key is generated
#      locally and never leaves this machine) and starts the service.
# It never stores SSH credentials and never phones home.
#
# The whole script is a set of functions; `main` runs on the last line, so a
# download cut short executes nothing.
set -euo pipefail

constants() {
  CONSOLE_URL="__EDGEWEIR_CONSOLE_URL__"
  REPO="marvinli001/edgeweir-node"
  OIDC_ISSUER="https://token.actions.githubusercontent.com"
  STATE_DIR="/var/lib/edgeweir-node"
  CACHE_DIR="/var/cache/edgeweir-node"
  LUA_DIR="/usr/share/edgeweir-node/lua"
  # Pinned cosign for machines without one; SHA-256 values from the official
  # cosign_checksums.txt of the sigstore/cosign v3.1.3 release.
  COSIGN_VERSION="3.1.3"
  COSIGN_SHA256_AMD64="4629c757b7618056f8ddd7e2625ae9fdd94c0372a65049520bc7d9df9efc7f71"
  COSIGN_SHA256_ARM64="c5d324e091826b0d7a78eb16fef316450b4eb9aaec045611c08ba06f5e73220a"
  SEMVER_RE='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$'
}

log() { printf '\033[1;34m[edgeweir]\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[1;31m[edgeweir] error:\033[0m %s\n' "$*" >&2
  exit 1
}

usage() {
  cat >&2 <<'USAGE'
Usage:
  export EDGEWEIR_TOKEN='<one-time token>'
  install.sh --server URL --ca-sha256 HEX [options]

  --server URL         node channel URL of the console, e.g. https://console.example.com:8443
  --ca-sha256 HEX      SHA-256 fingerprint of the console's node CA (pinned during enrollment)
  --token-file PATH    read the enrollment token from PATH instead of $EDGEWEIR_TOKEN
  --version VER        edgeweir-node version to install, e.g. 0.2.0 (default: latest)
  --format FMT         package to install: auto (default), deb, rpm or tar
  --mirror URL         edgeweir-node mirror (URL/latest, URL/v<version>/<file>);
                       default: the console's /downloads/edgeweir-node
  --mirror-only        never fall back to GitHub
  --no-start           install and enroll only: do not require, enable or start systemd
  --allow-unsigned     skip the cosign signature check (development only; SHA-256 is still verified)
USAGE
  exit 2
}

parse_args() {
  VERSION="latest"
  SERVER=""
  CA_SHA256=""
  TOKEN_FILE=""
  FORMAT="auto"
  MIRROR=""
  MIRROR_ONLY="false"
  NO_START="false"
  ALLOW_UNSIGNED="false"
  while [ $# -gt 0 ]; do
    case "$1" in
      --server) SERVER="${2:-}"; shift 2 || usage ;;
      --ca-sha256) CA_SHA256="${2:-}"; shift 2 || usage ;;
      --token-file) TOKEN_FILE="${2:-}"; shift 2 || usage ;;
      --version) VERSION="${2:-}"; shift 2 || usage ;;
      --format) FORMAT="${2:-}"; shift 2 || usage ;;
      --mirror) MIRROR="${2:-}"; shift 2 || usage ;;
      --mirror-only) MIRROR_ONLY="true"; shift ;;
      --no-start) NO_START="true"; shift ;;
      --allow-unsigned) ALLOW_UNSIGNED="true"; shift ;;
      --token | --token=*)
        die "--token is not accepted (the process list would show it): export EDGEWEIR_TOKEN or use --token-file" ;;
      -h | --help) usage ;;
      *) die "unknown option: $1" ;;
    esac
  done
  if [ -z "$SERVER" ] || [ -z "$CA_SHA256" ]; then
    usage
  fi
  [[ "$SERVER" =~ ^https://[^[:space:]/]+(/[^[:space:]]*)?$ ]] || die "--server must be an https:// URL"
  [[ "$CA_SHA256" =~ ^[0-9a-f]{64}$ ]] || die "--ca-sha256 must be 64 lowercase hex characters"
  case "$FORMAT" in auto | deb | rpm | tar) ;; *) die "--format must be auto, deb, rpm or tar" ;; esac
  if [ "$VERSION" != "latest" ]; then
    VERSION="${VERSION#v}"
    [[ "$VERSION" =~ $SEMVER_RE ]] || die "--version must be a semantic version, e.g. 0.2.0"
  fi
  MIRROR="${MIRROR:-${CONSOLE_URL%/}/downloads/edgeweir-node}"
  MIRROR="${MIRROR%/}"
  [[ "$MIRROR" =~ ^https?://[^[:space:]]+$ ]] || die "--mirror must be an http(s) URL"
}

# The token is read once and removed from the environment, so no other
# child process (curl, apt, ...) inherits it.
read_token() {
  TOKEN="${EDGEWEIR_TOKEN:-}"
  unset EDGEWEIR_TOKEN
  if [ -n "$TOKEN_FILE" ]; then
    [ -r "$TOKEN_FILE" ] || die "cannot read --token-file $TOKEN_FILE"
    TOKEN="$(tr -d '[:space:]' <"$TOKEN_FILE")"
  fi
  [ -n "$TOKEN" ] || die "no enrollment token: export EDGEWEIR_TOKEN='<token>' and run with sudo --preserve-env=EDGEWEIR_TOKEN, or pass --token-file PATH"
  [[ "$TOKEN" =~ ^ewt_[A-Za-z0-9_-]+$ ]] || die "the enrollment token is malformed (expected ewt_...)"
}

check_system() {
  [ "$(uname -s)" = "Linux" ] || die "edgeweir-node runs on Linux only"
  [ "$(id -u)" -eq 0 ] || die "run as root (e.g. via sudo)"
  command -v curl >/dev/null 2>&1 || die "curl is required"
  command -v sha256sum >/dev/null 2>&1 || die "sha256sum is required"
  command -v tar >/dev/null 2>&1 || die "tar is required"
  if [ "$NO_START" != "true" ]; then
    if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then
      die "systemd is required (use --no-start to only install and enroll)"
    fi
  fi
  case "$(uname -m)" in
    x86_64 | amd64) ARCH="amd64"; RPM_ARCH="x86_64"; COSIGN_SHA256="$COSIGN_SHA256_AMD64" ;;
    aarch64 | arm64) ARCH="arm64"; RPM_ARCH="aarch64"; COSIGN_SHA256="$COSIGN_SHA256_ARM64" ;;
    *) die "unsupported architecture: $(uname -m)" ;;
  esac
  if [ "$FORMAT" = "auto" ]; then
    if command -v dpkg >/dev/null 2>&1 && command -v apt-get >/dev/null 2>&1; then
      FORMAT="deb"
    elif command -v rpm >/dev/null 2>&1 && { command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; }; then
      FORMAT="rpm"
    else
      FORMAT="tar"
    fi
  fi
}

# download URL DEST: fails (non-zero) on HTTP errors, never writes an error page.
download() {
  curl -fsSL --retry 3 --connect-timeout 15 -o "$2" "$1"
}

# fetch NAME: the release file NAME of $VERSION into $WORK, mirror first.
fetch() {
  local name="$1" url
  for url in "${MIRROR}/v${VERSION}/${name}" \
    "https://github.com/${REPO}/releases/download/v${VERSION}/${name}"; do
    if [ "$MIRROR_ONLY" = "true" ] && [[ "$url" == https://github.com/* ]]; then
      continue
    fi
    if download "$url" "${WORK}/${name}"; then
      return 0
    fi
    log "not available from ${url%/*}"
  done
  die "failed to download ${name}"
}

resolve_version() {
  [ "$VERSION" = "latest" ] || return 0
  local latest=""
  latest="$(curl -fsSL --retry 3 --connect-timeout 15 "${MIRROR}/latest" 2>/dev/null || true)"
  latest="$(printf '%s' "$latest" | tr -d '[:space:]')"
  latest="${latest#v}"
  if ! [[ "$latest" =~ $SEMVER_RE ]] && [ "$MIRROR_ONLY" != "true" ]; then
    local release=""
    release="$(curl -fsSL --retry 3 --connect-timeout 15 \
      "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null || true)"
    latest="$(printf '%s\n' "$release" | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n1)"
  fi
  [[ "$latest" =~ $SEMVER_RE ]] || die "could not determine the latest edgeweir-node version; pass --version"
  VERSION="$latest"
}

# Uses the machine's cosign, or downloads the pinned release and checks its SHA-256.
ensure_cosign() {
  if command -v cosign >/dev/null 2>&1; then
    COSIGN="$(command -v cosign)"
    return 0
  fi
  local name="cosign-linux-${ARCH}" url ok="false"
  local mirror_base="${MIRROR%/edgeweir-node}"
  for url in "${mirror_base}/cosign/v${COSIGN_VERSION}/${name}" \
    "https://github.com/sigstore/cosign/releases/download/v${COSIGN_VERSION}/${name}"; do
    if [ "$MIRROR_ONLY" = "true" ] && [[ "$url" == https://github.com/* ]]; then
      continue
    fi
    if download "$url" "${WORK}/cosign"; then
      ok="true"
      break
    fi
  done
  [ "$ok" = "true" ] || die "cosign is not installed and cosign v${COSIGN_VERSION} could not be downloaded"
  printf '%s  %s\n' "$COSIGN_SHA256" "${WORK}/cosign" | sha256sum -c --status - \
    || die "SHA-256 verification FAILED for the downloaded cosign v${COSIGN_VERSION}"
  chmod 0755 "${WORK}/cosign"
  COSIGN="${WORK}/cosign"
  log "using cosign v${COSIGN_VERSION} (SHA-256 verified)"
}

verify_signature() {
  if [ "$ALLOW_UNSIGNED" = "true" ]; then
    log "WARNING: --allow-unsigned given, skipping the cosign signature check"
    return 0
  fi
  fetch "checksums.txt.sigstore.json"
  ensure_cosign
  # Exactly the release workflow of this repository at the tag being installed.
  "$COSIGN" verify-blob \
    --bundle "${WORK}/checksums.txt.sigstore.json" \
    --certificate-identity "https://github.com/${REPO}/.github/workflows/release.yml@refs/tags/v${VERSION}" \
    --certificate-oidc-issuer "$OIDC_ISSUER" \
    "${WORK}/checksums.txt" >/dev/null || die "cosign signature verification FAILED"
  log "cosign signature verified (release workflow, tag v${VERSION})"
}

# The package file for this machine, as listed in the signed checksums.txt.
pick_artifact() {
  local names count
  names="$(awk '{ sub(/^\*/, "", $2); print $2 }' "${WORK}/checksums.txt")"
  case "$FORMAT" in
    deb) ARTIFACT="$(printf '%s\n' "$names" | grep -E "^edgeweir-node_.*_${ARCH}\.deb$" || true)" ;;
    rpm) ARTIFACT="$(printf '%s\n' "$names" | grep -E "^edgeweir-node-.*\.${RPM_ARCH}\.rpm$" || true)" ;;
    tar)
      ARTIFACT="$(printf '%s\n' "$names" \
        | grep -Fx "edgeweir-node_${VERSION}_linux_${ARCH}.tar.gz" || true)"
      ;;
  esac
  count="$(printf '%s' "$ARTIFACT" | grep -c . || true)"
  [ "$count" = "1" ] || die "checksums.txt lists ${count:-0} ${FORMAT} packages for ${ARCH}"
  [[ "$ARTIFACT" =~ ^[A-Za-z0-9._+~-]+$ ]] || die "unexpected package name: ${ARTIFACT}"
}

verify_checksum() {
  (cd "$WORK" && awk -v f="$ARTIFACT" '{ n = $2; sub(/^\*/, "", n) } n == f' checksums.txt \
    | sha256sum -c --status -) || die "SHA-256 verification FAILED for ${ARTIFACT}"
  log "SHA-256 verified: ${ARTIFACT}"
}

# openresty_apt_source ID CODENAME ARCH: the openresty.org APT source line
# (https://openresty.org/en/linux-packages.html). arm64 packages live under
# /package/arm64/; the component is "openresty" on Debian and "main" on
# Ubuntu. Fails for anything openresty.org does not package.
openresty_apt_source() {
  local id="$1" codename="$2" arch="$3" path component
  case "$id" in
    debian) component="openresty" ;;
    ubuntu) component="main" ;;
    *) return 1 ;;
  esac
  [[ "$codename" =~ ^[a-z]+$ ]] || return 1
  case "$arch" in
    amd64) path="$id" ;;
    arm64) path="arm64/$id" ;;
    *) return 1 ;;
  esac
  printf 'deb [arch=%s signed-by=/usr/share/keyrings/openresty.gpg] https://openresty.org/package/%s %s %s\n' \
    "$arch" "$path" "$codename" "$component"
}

# openresty_rpm_repo ID ID_LIKE VERSION_ID ARCH: the URL of the openresty.org
# yum/dnf .repo file (https://openresty.org/en/linux-packages.html). One file
# serves x86_64 and aarch64 (its baseurl ends in $releasever/$basearch).
# CentOS, RHEL and Rocky 9 or later use openresty2.repo (packages signed with
# the newer key); RHEL rebuilds without a repository of their own (AlmaLinux,
# ...) use RHEL's, found through ID_LIKE. Fails for anything openresty.org
# does not package.
openresty_rpm_repo() {
  local id="$1" like="$2" version="$3" arch="$4" major dir min max=999999 file="openresty.repo"
  case "$arch" in amd64 | arm64) ;; *) return 1 ;; esac
  [[ "$version" =~ ^[0-9]{1,6}(\.[0-9]+)*$ ]] || return 1
  major="${version%%.*}"
  case "$id" in
    centos | rhel | rocky | ol | fedora | amzn | alinux | tencentos | mariner) ;;
    *)
      [[ " $like " == *" rhel "* ]] || return 1
      id="rhel"
      ;;
  esac
  case "$id" in
    centos | rhel) dir="$id" min=7 ;;
    rocky) dir="rocky" min=8 ;;
    ol) dir="oracle" min=7 max=8 ;;
    fedora) dir="fedora" min=32 ;;
    amzn)
      # Amazon Linux 2 and 2023; Amazon Linux 1 (2018.03) on x86_64 only.
      dir="amazon" min=0
      case "$version" in 2 | 2023) ;; 2018.03) [ "$arch" = amd64 ] || return 1 ;; *) return 1 ;; esac
      ;;
    alinux) dir="alinux" min=2 max=3 ;;
    tencentos) dir="tlinux" min=2 max=3 ;;
    mariner) dir="mariner" min=2 max=2 ;;
  esac
  [ "$major" -ge "$min" ] && [ "$major" -le "$max" ] || return 1
  case "$id" in centos | rhel | rocky) [ "$major" -lt 9 ] || file="openresty2.repo" ;; esac
  printf 'https://openresty.org/package/%s/%s\n' "$dir" "$file"
}

install_openresty() {
  if command -v openresty >/dev/null 2>&1; then
    return 0
  fi
  log "installing OpenResty from openresty.org"
  if command -v apt-get >/dev/null 2>&1; then
    local id codename apt_source
    # shellcheck source=/dev/null
    id="$(. /etc/os-release && printf '%s' "${ID:-}")"
    # shellcheck source=/dev/null
    codename="$(. /etc/os-release && printf '%s' "${VERSION_CODENAME:-}")"
    apt_source="$(openresty_apt_source "$id" "$codename" "$ARCH")" \
      || die "openresty.org has no packages for ${id:-this distribution} ${codename} (${ARCH}); install OpenResty manually and re-run"
    apt-get update -y
    apt-get install -y --no-install-recommends wget gnupg ca-certificates
    wget -qO - https://openresty.org/package/pubkey.gpg | gpg --dearmor --yes -o /usr/share/keyrings/openresty.gpg
    printf '%s\n' "$apt_source" >/etc/apt/sources.list.d/openresty.list
    apt-get update -y
    apt-get install -y --no-install-recommends openresty
  elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    local pm id like version repo
    pm="$(command -v dnf || command -v yum)"
    # shellcheck source=/dev/null
    id="$(. /etc/os-release && printf '%s' "${ID:-}")"
    # shellcheck source=/dev/null
    like="$(. /etc/os-release && printf '%s' "${ID_LIKE:-}")"
    # shellcheck source=/dev/null
    version="$(. /etc/os-release && printf '%s' "${VERSION_ID:-}")"
    repo="$(openresty_rpm_repo "$id" "$like" "$version" "$ARCH")" \
      || die "openresty.org has no packages for ${id:-this distribution} ${version} (${RPM_ARCH}); install OpenResty manually and re-run"
    log "adding ${repo}"
    download "$repo" /etc/yum.repos.d/openresty.repo || die "could not download ${repo}"
    if ! "$pm" install -y openresty; then
      # A repository without metadata for this release would break every later dnf/yum run.
      rm -f /etc/yum.repos.d/openresty.repo
      die "could not install OpenResty from ${repo}; install OpenResty manually and re-run"
    fi
  else
    die "unsupported package manager; install OpenResty manually and re-run"
  fi
}

# The tar.gz has no install scripts: user, directories and unit are set up here,
# the same way the .deb/.rpm scripts do it.
install_tarball() {
  local top="edgeweir-node_${VERSION}_linux_${ARCH}" dir
  mkdir -p "${WORK}/extract"
  tar -xzf "${WORK}/${ARTIFACT}" -C "${WORK}/extract"
  dir="${WORK}/extract/${top}"
  if [ ! -f "${dir}/edgeweir-node" ] || [ ! -f "${dir}/systemd/edgeweir-node.service" ] \
    || [ ! -d "${dir}/lua/edgeweir" ]; then
    die "unexpected archive layout in ${ARTIFACT}"
  fi
  if ! getent group edgeweir >/dev/null 2>&1; then
    groupadd --system edgeweir
  fi
  if ! getent passwd edgeweir >/dev/null 2>&1; then
    local nologin
    nologin="$(command -v nologin 2>/dev/null || echo /bin/false)"
    useradd --system --gid edgeweir --home-dir "$STATE_DIR" --no-create-home \
      --shell "$nologin" --comment "Edgeweir edge node" edgeweir
  fi
  install -m 0755 "${dir}/edgeweir-node" /usr/bin/edgeweir-node
  rm -rf "${LUA_DIR}/edgeweir"
  install -d -m 0755 "${LUA_DIR}/edgeweir"
  install -m 0644 "${dir}"/lua/edgeweir/*.lua "${LUA_DIR}/edgeweir/"
  install -D -m 0644 "${dir}/systemd/edgeweir-node.service" /etc/systemd/system/edgeweir-node.service
  install -d -o edgeweir -g edgeweir -m 0700 "$STATE_DIR"
  install -d -o edgeweir -g edgeweir -m 0750 "$CACHE_DIR"
}

install_package() {
  install_openresty
  log "installing ${ARTIFACT}"
  case "$FORMAT" in
    deb)
      if command -v apt-get >/dev/null 2>&1; then
        apt-get install -y --no-install-recommends "${WORK}/${ARTIFACT}"
      else
        dpkg -i "${WORK}/${ARTIFACT}"
      fi
      ;;
    rpm)
      if command -v dnf >/dev/null 2>&1; then
        dnf install -y "${WORK}/${ARTIFACT}"
      elif command -v yum >/dev/null 2>&1; then
        yum install -y "${WORK}/${ARTIFACT}"
      else
        rpm -Uvh --replacepkgs "${WORK}/${ARTIFACT}"
      fi
      ;;
    tar) install_tarball ;;
  esac
  getent passwd edgeweir >/dev/null 2>&1 || die "the package did not create the edgeweir user"
  [ -d "$STATE_DIR" ] || die "the package did not create ${STATE_DIR}"
}

enroll() {
  log "enrolling with ${SERVER}"
  # The token goes through the environment only (edgeweir-node reads EDGEWEIR_TOKEN).
  EDGEWEIR_TOKEN="$TOKEN" /usr/bin/edgeweir-node enroll --server "$SERVER" --ca-sha256 "$CA_SHA256" \
    --state-dir "$STATE_DIR" || die "enrollment failed"
}

start_service() {
  if [ "$NO_START" = "true" ]; then
    log "done: installed and enrolled; --no-start given, the service was not started"
    log "start it with: systemctl enable --now edgeweir-node.service"
    return 0
  fi
  systemctl daemon-reload
  # The agent runs OpenResty itself; the distribution unit would bind the same ports.
  systemctl disable --now openresty.service >/dev/null 2>&1 || true
  systemctl enable --now edgeweir-node.service
  log "done: edgeweir-node is running (journalctl -u edgeweir-node -f)"
}

main() {
  constants
  parse_args "$@"
  read_token
  check_system
  umask 022
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  resolve_version
  log "installing edgeweir-node ${VERSION} (${FORMAT}, ${ARCH})"
  fetch "checksums.txt"
  verify_signature
  pick_artifact
  fetch "$ARTIFACT"
  verify_checksum
  install_package
  enroll
  start_service
}

main "$@"
