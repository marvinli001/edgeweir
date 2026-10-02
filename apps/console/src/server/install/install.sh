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
#   3. downloads the .deb, .rpm or tar.gz package, and the edgeweir-openresty
#      and edgeweir-openresty-modsecurity packages of the same release (unless
#      --no-modsecurity), and verifies their SHA-256 against the signed
#      checksums.txt; nothing is executed before steps 2 and 3 pass;
#   4. installs edgeweir-openresty (OpenResty built for Edgeweir, under
#      /usr/lib/edgeweir-openresty) and its ModSecurity module first, then
#      the package (deb/rpm create the `edgeweir` user and the state
#      directories; for the tar.gz this script does it);
#   5. enrolls the node with the one-time token (the private key is generated
#      locally and never leaves this machine) and starts the service. On a
#      host that is already enrolled (identity.json in the state directory)
#      no token is needed and nothing is downloaded: the service is started,
#      or restarted when it runs; with --version VER steps 1-4 install that
#      version first. With --force such a host enrolls again with a new token
#      (e.g. after its certificate expired): the packages are installed as
#      on a new host, the service is stopped, the identity replaced and the
#      service started again;
#   6. waits up to 90 seconds for `edgeweir-node healthcheck` to pass (the
#      node has applied its configuration) and exits non-zero when it does
#      not. --no-start skips the service and this check.
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
  # OpenResty built for Edgeweir, released with edgeweir-node (deb and rpm only).
  OPENRESTY_PACKAGE="edgeweir-openresty"
  MODSECURITY_PACKAGE="edgeweir-openresty-modsecurity"
  NGINX_BIN="/usr/lib/edgeweir-openresty/nginx/sbin/nginx"
  # The oldest C library the packages run on (RHEL 9, Debian 12, Ubuntu 22.04).
  GLIBC_MIN="2.34"
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
  --version VER        edgeweir-node version to install, e.g. 0.2.0 (default: latest;
                       an enrolled host keeps its installed version without it)
  --format FMT         package to install: auto (default), deb, rpm or tar
  --mirror URL         edgeweir-node mirror (URL/latest, URL/v<version>/<file>);
                       default: the console's /downloads/edgeweir-node
  --mirror-only        never fall back to GitHub
  --no-modsecurity     do not install edgeweir-openresty-modsecurity (no OWASP CRS on this node)
  --no-start           install and enroll only: do not require, enable or start systemd
                       (no health check)
  --force              enroll again on an enrolled host (needs a new token): stops
                       edgeweir-node, replaces its identity and starts it again
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
  FORCE="false"
  ALLOW_UNSIGNED="false"
  WITH_MODSECURITY="true"
  while [ $# -gt 0 ]; do
    case "$1" in
      --server) SERVER="${2:-}"; shift 2 || usage ;;
      --ca-sha256) CA_SHA256="${2:-}"; shift 2 || usage ;;
      --token-file) TOKEN_FILE="${2:-}"; shift 2 || usage ;;
      --version) VERSION="${2:-}"; shift 2 || usage ;;
      --format) FORMAT="${2:-}"; shift 2 || usage ;;
      --mirror) MIRROR="${2:-}"; shift 2 || usage ;;
      --mirror-only) MIRROR_ONLY="true"; shift ;;
      --no-modsecurity) WITH_MODSECURITY="false"; shift ;;
      --no-start) NO_START="true"; shift ;;
      --force) FORCE="true"; shift ;;
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
# child process (curl, apt, ...) inherits it. An enrolled host keeps its
# identity: rerunning the script (after a failed step, or with --version to
# install another version) needs no token, unless --force enrolls it again.
read_token() {
  TOKEN="${EDGEWEIR_TOKEN:-}"
  unset EDGEWEIR_TOKEN
  ENROLLED="false"
  if [ -f "${STATE_DIR}/identity.json" ]; then
    ENROLLED="true"
    if [ "$FORCE" != "true" ]; then
      if [ -n "$TOKEN" ] || [ -n "$TOKEN_FILE" ]; then
        log "already enrolled (${STATE_DIR}/identity.json); the token is not used (--force enrolls again)"
      fi
      TOKEN=""
      return 0
    fi
  fi
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

# server_authority: host and port of --server ("[v6]:port" for IPv6; 443 by default).
server_authority() {
  local authority="${SERVER#https://}"
  authority="${authority%%/*}"
  if [[ "$authority" =~ ^\[[0-9A-Fa-f:.]+\]$ || ! "$authority" =~ :[0-9]+$ ]]; then
    authority="${authority}:443"
  fi
  printf '%s\n' "$authority"
}

# tls_chain AUTHORITY [SERVERNAME]: the certificates the server presents, as
# openssl prints them (nothing when the handshake fails).
tls_chain() {
  local args=(s_client -connect "$1" -showcerts)
  [ -z "${2:-}" ] || args+=(-servername "$2")
  if command -v timeout >/dev/null 2>&1; then
    timeout 20 openssl "${args[@]}" </dev/null 2>/dev/null || true
  else
    openssl "${args[@]}" </dev/null 2>/dev/null || true
  fi
}

# Before anything is downloaded: the node channel must be reachable, and it
# must be the console itself, not a proxy or CDN that terminates TLS. The
# channel answers every request (404 for /), so any HTTP status means
# reachable; no token is sent. With openssl on the machine, the last
# certificate the server presents (the console sends its certificate and
# its node CA) must be the CA pinned by --ca-sha256.
check_server() {
  local status authority host presented
  authority="$(server_authority)"
  status="$(curl -sk -o /dev/null -w '%{http_code}' --connect-timeout 10 --max-time 20 "${SERVER%/}/" 2>/dev/null || true)"
  if ! [[ "$status" =~ ^[1-5][0-9][0-9]$ ]]; then
    die "cannot reach the node channel ${SERVER}: check the address and its DNS name, and that the firewall or security group lets this host reach ${authority} (the console's EDGEWEIR_NODE_API_URL)"
  fi
  if ! command -v openssl >/dev/null 2>&1; then
    log "node channel reachable (${authority}); openssl not installed, the CA is checked at enrollment"
    return 0
  fi
  host="${authority%:*}"
  host="${host#[}"
  host="${host%]}"
  # SNI carries names only.
  if [[ "$host" =~ ^[0-9.]+$ || "$host" == *:* ]]; then
    host=""
  fi
  presented="$(tls_chain "$authority" "$host" | awk '
    /-----BEGIN CERTIFICATE-----/ { cert = ""; inside = 1 }
    inside { cert = cert $0 "\n" }
    /-----END CERTIFICATE-----/ { inside = 0; last = cert }
    END { printf "%s", last }')"
  if [ -z "$presented" ]; then
    log "node channel reachable (${authority}); could not read its certificates, the CA is checked at enrollment"
    return 0
  fi
  presented="$(printf '%s' "$presented" | openssl x509 -outform DER 2>/dev/null | sha256sum | awk '{ print $1 }')"
  if [ "$presented" != "$CA_SHA256" ]; then
    die "${SERVER} does not present the console's node CA (--ca-sha256): a proxy or CDN terminates TLS in front of the node channel, or the address points at another service; nodes need a direct or layer-4 (TCP passthrough) connection to the console's port"
  fi
  log "node channel reachable and presents the pinned CA (${authority})"
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
  # Keep the verified verifier available to the unprivileged upgrade supervisor.
  if [ "$COSIGN" = "${WORK}/cosign" ]; then
    install -m 0755 "$COSIGN" /usr/local/bin/cosign
    COSIGN=/usr/local/bin/cosign
  fi
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

# verify_file NAME: $WORK/NAME matches its SHA-256 in the signed checksums.txt.
verify_file() {
  (cd "$WORK" && awk -v f="$1" '{ n = $2; sub(/^\*/, "", n) } n == f' checksums.txt \
    | sha256sum -c --status -) || die "SHA-256 verification FAILED for $1"
  log "SHA-256 verified: $1"
}

verify_checksum() {
  verify_file "$ARTIFACT"
  [ -z "$OPENRESTY_ARTIFACT" ] || verify_file "$OPENRESTY_ARTIFACT"
  [ -z "$MODSECURITY_ARTIFACT" ] || verify_file "$MODSECURITY_ARTIFACT"
}

# openresty_artifact FORMAT ARCH PACKAGE: the one release file of PACKAGE
# for FORMAT (deb or rpm) and ARCH (amd64 or arm64 for deb, x86_64 or
# aarch64 for rpm) among the file names on stdin (those of checksums.txt).
# nfpm names them PACKAGE_VERSION_ARCH.deb and PACKAGE-VERSION.ARCH.rpm; the
# version starts with a digit, so edgeweir-openresty never matches
# edgeweir-openresty-modsecurity. Fails unless exactly one file matches.
openresty_artifact() {
  local format="$1" arch="$2" package="$3" pattern matches count
  [[ "$package" =~ ^[a-z][a-z0-9-]*$ ]] || return 1
  case "$format:$arch" in
    deb:amd64 | deb:arm64) pattern="^${package}_[0-9][A-Za-z0-9.+~-]*_${arch}\.deb$" ;;
    rpm:x86_64 | rpm:aarch64) pattern="^${package}-[0-9][A-Za-z0-9.+~_-]*\.${arch}\.rpm$" ;;
    *) return 1 ;;
  esac
  matches="$(grep -E "$pattern" || true)"
  count="$(printf '%s' "$matches" | grep -c . || true)"
  [ "$count" = "1" ] || return 1
  printf '%s\n' "$matches"
}

# version_at_least VERSION MIN: VERSION (e.g. 2.36) is MIN (e.g. 2.34) or later.
version_at_least() {
  local have="$1" want="$2"
  [[ "$have" =~ ^[0-9]+\.[0-9]+$ ]] && [[ "$want" =~ ^[0-9]+\.[0-9]+$ ]] || return 1
  [ "${have%%.*}" -gt "${want%%.*}" ] \
    || { [ "${have%%.*}" -eq "${want%%.*}" ] && [ "${have#*.}" -ge "${want#*.}" ]; }
}

# The edgeweir-openresty packages of this release, as listed in the signed
# checksums.txt. deb and rpm installs use their own format; the tar.gz uses
# the machine's package manager, or an edgeweir-openresty already installed.
pick_openresty() {
  local names arch glibc=""
  OPENRESTY_ARTIFACT=""
  MODSECURITY_ARTIFACT=""
  OPENRESTY_FORMAT="$FORMAT"
  if [ "$FORMAT" = "tar" ]; then
    if command -v dpkg >/dev/null 2>&1; then
      OPENRESTY_FORMAT="deb"
    elif command -v rpm >/dev/null 2>&1; then
      OPENRESTY_FORMAT="rpm"
    elif [ -x "$NGINX_BIN" ]; then
      log "using the installed ${OPENRESTY_PACKAGE} (${NGINX_BIN})"
      return 0
    else
      die "${OPENRESTY_PACKAGE} comes as .deb and .rpm only: install it first (${NGINX_BIN}), then re-run"
    fi
  fi
  if command -v getconf >/dev/null 2>&1; then
    glibc="$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{ print $2 }' || true)"
  fi
  if [[ "$glibc" =~ ^[0-9]+\.[0-9]+$ ]] && ! version_at_least "$glibc" "$GLIBC_MIN"; then
    die "${OPENRESTY_PACKAGE} needs glibc ${GLIBC_MIN} or later (this machine has ${glibc}): RHEL, Rocky or AlmaLinux 9, Debian 12, Ubuntu 22.04 or later"
  fi
  if [ "$OPENRESTY_FORMAT" = "deb" ]; then arch="$ARCH"; else arch="$RPM_ARCH"; fi
  names="$(awk '{ sub(/^\*/, "", $2); print $2 }' "${WORK}/checksums.txt")"
  OPENRESTY_ARTIFACT="$(printf '%s\n' "$names" | openresty_artifact "$OPENRESTY_FORMAT" "$arch" "$OPENRESTY_PACKAGE")" \
    || die "checksums.txt does not list exactly one ${OPENRESTY_FORMAT} package of ${OPENRESTY_PACKAGE} for ${arch}"
  if [ "$WITH_MODSECURITY" = "true" ]; then
    MODSECURITY_ARTIFACT="$(printf '%s\n' "$names" | openresty_artifact "$OPENRESTY_FORMAT" "$arch" "$MODSECURITY_PACKAGE")" \
      || die "checksums.txt does not list exactly one ${OPENRESTY_FORMAT} package of ${MODSECURITY_PACKAGE} for ${arch} (--no-modsecurity skips it)"
  fi
}

fetch_openresty() {
  [ -z "$OPENRESTY_ARTIFACT" ] || fetch "$OPENRESTY_ARTIFACT"
  [ -z "$MODSECURITY_ARTIFACT" ] || fetch "$MODSECURITY_ARTIFACT"
}

# Installs the verified edgeweir-openresty packages before edgeweir-node,
# which depends on edgeweir-openresty and recommends the ModSecurity module.
install_openresty() {
  if [ -n "$OPENRESTY_ARTIFACT" ]; then
    local main="${WORK}/${OPENRESTY_ARTIFACT}" module=""
    [ -z "$MODSECURITY_ARTIFACT" ] || module="${WORK}/${MODSECURITY_ARTIFACT}"
    log "installing ${OPENRESTY_ARTIFACT}${MODSECURITY_ARTIFACT:+ and ${MODSECURITY_ARTIFACT}}"
    case "$OPENRESTY_FORMAT" in
      deb)
        if command -v apt-get >/dev/null 2>&1; then
          apt-get install -y --no-install-recommends "$main" ${module:+"$module"}
        else
          dpkg -i "$main" ${module:+"$module"}
        fi
        ;;
      rpm)
        if command -v dnf >/dev/null 2>&1; then
          dnf install -y "$main" ${module:+"$module"}
        elif command -v yum >/dev/null 2>&1; then
          yum install -y "$main" ${module:+"$module"}
        else
          rpm -Uvh --replacepkgs "$main" ${module:+"$module"}
        fi
        ;;
    esac
  fi
  [ -x "$NGINX_BIN" ] || die "${OPENRESTY_PACKAGE} did not install ${NGINX_BIN}"
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

# Whether this run enrolls: a new host, or an enrolled one with --force.
enrolling() {
  [ "$ENROLLED" != "true" ] || [ "$FORCE" = "true" ]
}

# Whether this run downloads and installs packages: on a new host, with
# --force, with --version, or when edgeweir-node is missing. Otherwise an
# enrolled host keeps what is installed and the service is (re)started.
installing() {
  enrolling || [ "$VERSION" != "latest" ] || [ ! -x /usr/bin/edgeweir-node ]
}

enroll() {
  if ! enrolling; then
    log "already enrolled; to enroll again with a new token, run this command with --force"
    return 0
  fi
  log "enrolling with ${SERVER}"
  # The token goes through the environment only (edgeweir-node reads EDGEWEIR_TOKEN).
  if [ "$ENROLLED" = "true" ]; then
    # A running node keeps its identity: stop it first; start_service starts it again.
    log "enrolling again (--force): stopping edgeweir-node"
    systemctl stop edgeweir-node.service >/dev/null 2>&1 || true
    EDGEWEIR_TOKEN="$TOKEN" /usr/bin/edgeweir-node enroll --force --server "$SERVER" \
      --ca-sha256 "$CA_SHA256" --state-dir "$STATE_DIR" || die "enrollment failed"
  else
    EDGEWEIR_TOKEN="$TOKEN" /usr/bin/edgeweir-node enroll --server "$SERVER" --ca-sha256 "$CA_SHA256" \
      --state-dir "$STATE_DIR" || die "enrollment failed"
  fi
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
  # The deb and rpm packages restart a running service themselves; nothing
  # does after a tar.gz install, or when this run installed nothing.
  if [ "$FORMAT" = "tar" ] || [ "${RESTART:-false}" = "true" ]; then
    systemctl try-restart edgeweir-node.service
  fi
  systemctl enable --now edgeweir-node.service
  log "edgeweir-node.service started"
}

# Waits for the started node: `edgeweir-node healthcheck` passes once the
# data plane runs with a configuration from the console (or the last one
# kept in the state directory). EDGEWEIR_HEALTHCHECK_TIMEOUT (seconds,
# default 90) exists for tests.
check_health() {
  [ "$NO_START" != "true" ] || return 0
  local timeout="${EDGEWEIR_HEALTHCHECK_TIMEOUT:-90}" interval=3 attempt=1 attempts output=""
  [[ "$timeout" =~ ^[0-9]{1,4}$ ]] || timeout=90
  attempts=$(((timeout + interval - 1) / interval))
  [ "$attempts" -ge 1 ] || attempts=1
  log "waiting up to ${timeout}s for edgeweir-node to apply its configuration"
  while true; do
    if output="$(/usr/bin/edgeweir-node healthcheck 2>&1)"; then
      output="${output##*$'\n'}"
      log "done: edgeweir-node is healthy (${output#healthy: }); logs: journalctl -u edgeweir-node -f"
      return 0
    fi
    output="${output##*$'\n'}"
    [ "$attempt" -lt "$attempts" ] || break
    attempt=$((attempt + 1))
    sleep "$interval"
  done
  die "edgeweir-node is installed but not healthy after ${timeout}s (${output:-no output}); see journalctl -u edgeweir-node -n 50"
}

main() {
  constants
  parse_args "$@"
  read_token
  check_system
  umask 022
  WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT
  if enrolling; then
    check_server
  fi
  if ! installing; then
    log "already enrolled: nothing is downloaded or reinstalled (--version VER installs that version)"
    RESTART="true"
    start_service
    check_health
    return 0
  fi
  resolve_version
  log "installing edgeweir-node ${VERSION} (${FORMAT}, ${ARCH})"
  fetch "checksums.txt"
  verify_signature
  pick_artifact
  pick_openresty
  fetch "$ARTIFACT"
  fetch_openresty
  verify_checksum
  install_openresty
  install_package
  enroll
  start_service
  check_health
}

main "$@"
