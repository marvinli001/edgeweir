#!/usr/bin/env bash
# Edgeweir 控制台部署脚本：宝塔面板 / aaPanel，或任何装有 Docker 与 Compose v2 的 Linux。
#
#   curl -fsSL -o deploy.sh https://raw.githubusercontent.com/marvinli001/edgeweir/master/deploy.sh
#   sudo bash deploy.sh install      # 对话式安装：选数据库方式，生成 .env，启动编排
#   ./deploy.sh update               # 备份数据库后升级到最新版本（或 update <tag>）
#   ./deploy.sh help                 # 其余命令
#
# 两种编排（docs/deploy/baota.md）：
#   host     本机或云 PostgreSQL；容器用宿主机网络，DATABASE_URL 可以直接写 127.0.0.1
#   bundled  编排内置 PostgreSQL；Docker 网桥，数据库不对外
#
# 无人值守安装：EDGEWEIR_YES=1 EDGEWEIR_DB=host|bundled EDGEWEIR_PUBLIC_URL=https://...
#   [DATABASE_URL=...] [EDGEWEIR_NODE_API_URL=...] [EDGEWEIR_DIR=...] bash deploy.sh install
set -Eeuo pipefail

readonly IMAGE=ghcr.io/marvinli001/edgeweir
readonly PG_IMAGE=postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873
readonly CONTAINER=edgeweir-console
readonly SCRIPT_URL=${EDGEWEIR_SCRIPT_URL:-https://raw.githubusercontent.com/marvinli001/edgeweir/master/deploy.sh}
readonly PG_TESTED_MAJOR=18

SELF=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")
SELF_DIR=$(dirname "$SELF")
DIR=
COMPOSE_FILE=
PROJECT=

# --- output and prompts ---------------------------------------------------------

if [[ -t 2 ]]; then
  B=$'\e[1m' G=$'\e[32m' Y=$'\e[33m' R=$'\e[31m' N=$'\e[0m'
else
  B='' G='' Y='' R='' N=''
fi
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$N" >&2; }
info() { printf '    %s\n' "$*" >&2; }
ok() { printf '%s  ✓%s %s\n' "$G" "$N" "$*" >&2; }
warn() { printf '%s  !%s %s\n' "$Y" "$N" "$*" >&2; }
die() {
  printf '%s  ✗%s %s\n' "$R" "$N" "$*" >&2
  exit 1
}

INTERACTIVE=
if [[ -z ${EDGEWEIR_YES:-} ]] && { exec 3</dev/tty; } 2>/dev/null; then INTERACTIVE=1; fi

# ask <var> <question> [default]: the answer, or the default when unattended.
ask() {
  local _var=$1 _question=$2 _default=${3-} _reply=
  if [[ -n $INTERACTIVE ]]; then
    if [[ -n $_default ]]; then
      printf '%s [%s]: ' "$_question" "$_default" >&2
    else
      printf '%s: ' "$_question" >&2
    fi
    IFS= read -r -u 3 _reply || die "输入已结束，安装取消。"
  fi
  printf -v "$_var" '%s' "${_reply:-$_default}"
}

# ask_secret <var> <question>: hidden input; empty when unattended.
ask_secret() {
  local _var=$1 _reply=
  if [[ -n $INTERACTIVE ]]; then
    printf '%s: ' "$2" >&2
    IFS= read -rs -u 3 _reply || die "输入已结束，安装取消。"
    printf '\n' >&2
  fi
  printf -v "$_var" '%s' "$_reply"
}

# confirm <question> <y|n>: yes/no, the default when unattended.
confirm() {
  local reply hint='[Y/n]'
  [[ $2 == n ]] && hint='[y/N]'
  if [[ -z $INTERACTIVE ]]; then
    [[ $2 == y ]]
    return
  fi
  while true; do
    printf '%s %s: ' "$1" "$hint" >&2
    IFS= read -r -u 3 reply || die "输入已结束，已取消。"
    case ${reply:-$2} in
      y | Y | yes) return 0 ;;
      n | N | no) return 1 ;;
    esac
  done
}

# choose <var> <default number> <option>...: sets var to the chosen number.
choose() {
  local _var=$1 _default=$2 _reply i
  shift 2
  if [[ -z $INTERACTIVE ]]; then
    printf -v "$_var" '%s' "$_default"
    return
  fi
  for ((i = 1; i <= $#; i++)); do printf '    %d) %s\n' "$i" "${!i}" >&2; done
  while true; do
    printf '请选择 [%s]: ' "$_default" >&2
    IFS= read -r -u 3 _reply || die "输入已结束，已取消。"
    _reply=${_reply:-$_default}
    if [[ $_reply =~ ^[0-9]+$ ]] && ((_reply >= 1 && _reply <= $#)); then
      printf -v "$_var" '%s' "$_reply"
      return
    fi
  done
}

# --- small helpers --------------------------------------------------------------

rand_base64() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -base64 "$1"; else head -c "$1" /dev/urandom | base64 | tr -d '\n'; fi
}
rand_hex() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"; else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi
}

urlencode() {
  local LC_ALL=C s=$1 out='' c n i
  for ((i = 0; i < ${#s}; i++)); do
    c=${s:i:1}
    case $c in
      [A-Za-z0-9._~-]) out+=$c ;;
      *)
        printf -v n '%d' "'$c"
        ((n < 0)) && n=$((n + 256))
        printf -v c '%%%02X' "$n"
        out+=$c
        ;;
    esac
  done
  printf '%s' "$out"
}
urldecode() { printf '%b' "${1//%/\\x}"; }

# env_get <key>: value of KEY in .env (last one wins, surrounding quotes removed).
env_get() {
  local line value=''
  [[ -f $DIR/.env ]] || return 0
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    [[ $line == "$1="* ]] && value=${line#*=}
  done <"$DIR/.env"
  value=${value#[\"\']}
  value=${value%[\"\']}
  printf '%s' "$value"
}

# env_set <key> <value>: replaces or appends KEY=value in .env, keeping mode 600.
env_set() {
  local tmp
  tmp=$(mktemp "$DIR/.env.XXXXXX")
  KEY=$1 VALUE=$2 awk '
    BEGIN { key = ENVIRON["KEY"]; line = key "=" ENVIRON["VALUE"] }
    index($0, key "=") == 1 { if (!done) print line; done = 1; next }
    { print }
    END { if (!done) print line }
  ' "$DIR/.env" >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$DIR/.env"
}

# Values go into .env unquoted; Compose would expand "$" and cut at " #".
env_safe() { [[ $1 != *[[:space:]\"\'\`\\\$#]* ]]; }

port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    ss -Hltn "( sport = :$1 )" 2>/dev/null | grep -q .
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$1\$"
  else
    return 1
  fi
}

# Addresses the host listens on for a TCP port (host network check).
listen_addresses() {
  if command -v ss >/dev/null 2>&1; then ss -Hltn "( sport = :$1 )" 2>/dev/null | awk '{print $4}'; fi
}

valid_url() { [[ $1 =~ ^https?://([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:[0-9]{1,5})?$ ]]; }
url_host() {
  local rest=${1#*://}
  rest=${rest%%/*}
  if [[ $rest == \[* ]]; then printf '%s' "${rest%%]*}]"; else printf '%s' "${rest%%:*}"; fi
}
url_port() {
  local rest=${1#*://}
  rest=${rest%%/*}
  rest=${rest##*]}
  if [[ $rest == *:* ]]; then printf '%s' "${rest##*:}"; elif [[ $1 == https://* ]]; then printf 443; else printf 80; fi
}

# --- PostgreSQL connection ------------------------------------------------------

DB_USER='' DB_PASS='' DB_HOST='' DB_PORT='' DB_NAME='' DB_SSLMODE=''

# db_parse <url>: splits a postgres:// URL into DB_* (single host only).
db_parse() {
  local re='^postgres(ql)?://([^:@/?#]+)(:([^@/?#]*))?@([^/?#]+)/([^?#]+)(\?([^#]*))?$' hostport query
  [[ $1 =~ $re ]] || return 1
  DB_USER=$(urldecode "${BASH_REMATCH[2]}")
  DB_PASS=$(urldecode "${BASH_REMATCH[4]}")
  hostport=${BASH_REMATCH[5]}
  DB_NAME=$(urldecode "${BASH_REMATCH[6]}")
  query="&${BASH_REMATCH[8]}&"
  if [[ $hostport =~ ^\[([0-9A-Fa-f:.]+)\](:([0-9]+))?$ ]]; then
    DB_HOST=${BASH_REMATCH[1]}
    DB_PORT=${BASH_REMATCH[3]:-5432}
  elif [[ $hostport =~ ^([^:,]+)(:([0-9]+))?$ ]]; then
    DB_HOST=${BASH_REMATCH[1]}
    DB_PORT=${BASH_REMATCH[3]:-5432}
  else
    return 1
  fi
  DB_SSLMODE=''
  if [[ $query =~ \&sslmode=([^\&]*)\& ]]; then DB_SSLMODE=${BASH_REMATCH[1]}; fi
}

db_url() {
  local host=$DB_HOST url
  [[ $host == *:* ]] && host="[$host]"
  url="postgres://$(urlencode "$DB_USER"):$(urlencode "$DB_PASS")@$host:$DB_PORT/$(urlencode "$DB_NAME")"
  [[ -n $DB_SSLMODE ]] && url+="?sslmode=$DB_SSLMODE"
  printf '%s' "$url"
}

is_loopback() { [[ $1 == 127.* || $1 == localhost || $1 == ::1 ]]; }

# pg_client <command>...: runs a PostgreSQL client on the host network with the
# DB_* connection. The password travels in the environment, never in argv.
pg_client() {
  local args=(--rm --network host -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -e PGSSLMODE -e PGCONNECT_TIMEOUT=8)
  local sslmode ca=''
  # The console uses node-postgres: no sslmode means no TLS, no-verify encrypts
  # without checking, and every other mode verifies the certificate and name.
  case $DB_SSLMODE in
    '' | disable | allow) sslmode=disable ;;
    no-verify) sslmode=require ;;
    *) sslmode=verify-full ;;
  esac
  if [[ $sslmode == verify-full ]]; then
    for ca in /etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/cert.pem; do
      [[ -f $ca ]] && break
      ca=''
    done
    if [[ -n $ca ]]; then
      args+=(-v "$ca:/etc/edgeweir-ca.pem:ro" -e PGSSLROOTCERT=/etc/edgeweir-ca.pem)
    else
      args+=(-e PGSSLROOTCERT=system)
    fi
  fi
  PGHOST=$DB_HOST PGPORT=$DB_PORT PGUSER=$DB_USER PGPASSWORD=$DB_PASS PGDATABASE=$DB_NAME PGSSLMODE=$sslmode \
    docker run "${args[@]}" "$PG_IMAGE" "$@"
}

# db_check: connects with DB_*, reports the version and whether this user can
# create tables (migrations) and schemas (the job queue).
db_check() {
  local out major create_db create_public
  info "正在连接 ${DB_HOST}:${DB_PORT}/${DB_NAME}（用户 ${DB_USER}）…"
  if ! out=$(pg_client psql -XAtq -F ' ' -c "select current_setting('server_version_num')::int / 10000, has_database_privilege(current_database(), 'CREATE'), has_schema_privilege('public', 'CREATE')" 2>&1); then
    warn "连接失败："
    printf '      %s\n' "$out" >&2
    case $out in
      *refused*) info "PostgreSQL 没有在这个地址和端口监听，检查地址、端口和数据库是否已启动。" ;;
      *password*) info "用户名或密码不对。宝塔「数据库 → PgSQL」可以重置该用户的密码。" ;;
      *pg_hba*) info "pg_hba.conf 没有放行这台服务器；本机数据库放行 127.0.0.1，云数据库在白名单里加入本机 IP。" ;;
      *does\ not\ exist*) info "数据库或用户不存在，先在宝塔「数据库 → PgSQL」或云控制台创建。" ;;
      *timeout* | *timed\ out*) info "连接超时：检查防火墙、安全组或云数据库的白名单。" ;;
      *certificate* | *SSL*) info "TLS 校验失败：云数据库的证书需由公共 CA 签发且与主机名一致。" ;;
    esac
    return 1
  fi
  read -r major create_db create_public <<<"$out"
  ok "已连接，PostgreSQL ${major}"
  if [[ $create_db != t || $create_public != t ]]; then
    warn "用户 ${DB_USER} 不能在 ${DB_NAME} 里建表或建 schema（迁移和后台任务需要）。"
    info "让该用户成为数据库所有者：宝塔新建数据库时选择这个用户，或执行"
    info "ALTER DATABASE ${DB_NAME} OWNER TO ${DB_USER}; 以及 ALTER SCHEMA public OWNER TO ${DB_USER};"
    return 1
  fi
  if ((major < PG_TESTED_MAJOR)); then
    warn "控制台在 PostgreSQL ${PG_TESTED_MAJOR} 上测试；当前 ${major} 未经验证。"
    confirm "仍然使用这个数据库？" n || return 1
  fi
}

# --- deployment directory and compose -------------------------------------------

compose_file_in() {
  local f
  for f in compose.yml compose.yaml docker-compose.yml docker-compose.yaml; do
    if [[ -f $1/$f ]] && grep -q "container_name: $CONTAINER" "$1/$f"; then
      printf '%s' "$f"
      return 0
    fi
  done
  return 1
}
is_deploy_dir() { [[ -f $1/.env ]] && compose_file_in "$1" >/dev/null; }

# Locates an existing deployment: EDGEWEIR_DIR, the script's directory, the
# working directory, then the default locations.
find_dir() {
  local d
  for d in "${EDGEWEIR_DIR:-}" "$SELF_DIR" "$PWD" /www/dk_project/edgeweir /opt/edgeweir; do
    if [[ -n $d ]] && is_deploy_dir "$d"; then
      DIR=$(cd "$d" && pwd)
      COMPOSE_FILE=$(compose_file_in "$DIR")
      # A panel may have created the project under another name; follow the container.
      PROJECT=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$CONTAINER" 2>/dev/null || true)
      return 0
    fi
  done
  [[ -n ${EDGEWEIR_DIR:-} ]] && die "${EDGEWEIR_DIR} 里没有 Edgeweir 部署（需要 .env 和含 ${CONTAINER} 的编排文件）。"
  die "找不到 Edgeweir 部署。在部署目录里运行本脚本，或设置 EDGEWEIR_DIR=部署目录；新装请运行 install。"
}

# Compose prefers variables from the calling shell over .env; drop every
# variable .env or the compose file names, so .env decides.
compose() {
  local unset=() name
  while IFS= read -r name; do unset+=(-u "$name"); done < <(
    {
      sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$DIR/.env"
      # shellcheck disable=SC2016 # a literal "${" in the compose file
      grep -o '\${[A-Za-z_][A-Za-z0-9_]*' "$DIR/$COMPOSE_FILE" | cut -c3-
    } | sort -u
  )
  env ${unset[@]+"${unset[@]}"} docker compose --project-directory "$DIR" -f "$DIR/$COMPOSE_FILE" --env-file "$DIR/.env" \
    ${PROJECT:+-p "$PROJECT"} "$@"
}

deploy_mode() {
  if grep -qE '^[[:space:]]*network_mode:[[:space:]]*"?host"?[[:space:]]*$' "$DIR/$COMPOSE_FILE"; then echo host; else echo bundled; fi
}

preflight() {
  command -v docker >/dev/null 2>&1 || die "没有找到 docker。宝塔用户在「Docker」页面安装，其他系统见 https://docs.docker.com/engine/install/"
  docker info >/dev/null 2>&1 || die "无法访问 Docker：请用 root（sudo）运行，或确认 Docker 服务已启动。"
  docker compose version >/dev/null 2>&1 || die "需要 Docker Compose v2（docker compose）。宝塔用户在「Docker」页面更新 Docker。"
}

# image_version <ref>: the rolling version baked into the image.
image_version() { docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$1" 2>/dev/null || true; }

# EDGEWEIR_NO_PULL=1: use images already loaded on this host (docker load), never pull.
pull() { [[ -n ${EDGEWEIR_NO_PULL:-} ]] || compose pull -q; }

# resolve_version <tag|latest>: pulls the image and prints the dated tag to pin.
resolve_version() {
  local want=$1 version
  if [[ -n ${EDGEWEIR_NO_PULL:-} ]]; then
    docker image inspect "$IMAGE:$want" >/dev/null 2>&1 || die "本机没有 ${IMAGE}:${want}（EDGEWEIR_NO_PULL 不会拉取）。"
  else
    info "拉取 ${IMAGE}:${want} …"
    docker pull -q "$IMAGE:$want" >/dev/null || die "拉取 ${IMAGE}:${want} 失败，检查网络或 tag 是否存在。"
  fi
  version=$(image_version "$IMAGE:$want")
  if [[ $want != latest ]]; then
    printf '%s' "$want"
  elif [[ -n $version && $version != dev ]]; then
    # Compose runs the dated tag: have it locally before anything restarts.
    if [[ -n ${EDGEWEIR_NO_PULL:-} ]]; then
      docker image inspect "$IMAGE:$version" >/dev/null 2>&1 || docker tag "$IMAGE:latest" "$IMAGE:$version"
    else
      docker pull -q "$IMAGE:$version" >/dev/null || die "拉取 ${IMAGE}:${version} 失败。"
    fi
    printf '%s' "$version"
  else
    warn "latest 镜像没有版本标签，只能跟随 latest。"
    printf latest
  fi
}

running_version() {
  docker exec "$CONTAINER" sh -c 'wget -qO- "http://127.0.0.1:${PORT:-3000}/healthz"' 2>/dev/null |
    sed -n 's/.*"version":"\([^"]*\)".*/\1/p'
}

setup_token() {
  compose logs --no-color --no-log-prefix console 2>/dev/null | sed -n 's/.*"setupToken":"\([^"]*\)".*/\1/p' | tail -n 1
}

# Bundled mode: the console sees the panel nginx as the Docker network gateway.
# Keep EDGEWEIR_TRUSTED_PROXIES on it when it is a single address (as written by
# install), since the network (and its gateway) is recreated after a `down`.
sync_trusted_proxy() {
  [[ $(deploy_mode) == bundled ]] || return 0
  local postgres network gateway current
  postgres=$(compose ps -q postgres 2>/dev/null | head -n 1)
  [[ -n $postgres ]] || return 0
  network=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$postgres" 2>/dev/null | awk '{print $1}')
  [[ -n $network ]] || return 0
  gateway=$(docker network inspect -f '{{range .IPAM.Config}}{{if .Gateway}}{{.Gateway}} {{end}}{{end}}' "$network" 2>/dev/null |
    tr ' ' '\n' | grep -E '^[0-9]+(\.[0-9]+){3}$' | head -n 1 || true)
  [[ -n $gateway ]] || return 0
  current=$(env_get EDGEWEIR_TRUSTED_PROXIES)
  if [[ -z $current || ($current =~ ^[0-9]+(\.[0-9]+){3}$ && $current != "$gateway") ]]; then
    env_set EDGEWEIR_TRUSTED_PROXIES "$gateway"
    ok "EDGEWEIR_TRUSTED_PROXIES=${gateway}（宝塔 nginx 经 Docker 网关转发）"
    return 10
  fi
}

# up_and_wait: starts the project and waits for the health checks.
up_and_wait() {
  local rc=0
  if [[ $(deploy_mode) == bundled ]]; then
    compose up -d postgres
    sync_trusted_proxy || rc=$?
    ((rc == 0 || rc == 10)) || return "$rc"
  fi
  if ! compose up -d --wait --remove-orphans; then
    warn "服务没有进入健康状态，最近的日志："
    compose logs --no-color --tail=40 console >&2 || true
    die "启动失败。修正 .env 后运行 ./deploy.sh start 重试。"
  fi
  if [[ $(deploy_mode) == host ]]; then
    local port addrs
    port=$(env_get EDGEWEIR_NODE_API_PORT)
    addrs=$(listen_addresses "${port:-8443}")
    if [[ -n $addrs ]] && ! grep -qvE '^(127\.|\[::1\]|::1)' <<<"$addrs"; then
      warn "节点通道只监听在本机回环地址（${addrs//$'\n'/ }）：镜像版本不支持 NODE_API_HOST，节点无法连接。"
      info "运行 ./deploy.sh update 升级到最新版本。"
    fi
  fi
}

# --- compose templates ----------------------------------------------------------
# 与仓库中的 compose.baota-host.yml / compose.baota.yml 逐字一致（测试会检查）。

template_host() {
  cat <<'EDGEWEIR_COMPOSE'
# Edgeweir 控制台 · 宝塔面板（BT Panel）/ aaPanel · 本机或云 PostgreSQL（host 网络）
#
# 推荐用 deploy.sh 安装和升级（docs/deploy/baota.md），它会对话式生成 .env 并启动本编排。
# 与 compose.baota.yml（编排内置 PostgreSQL，Docker 网桥）的区别：
#   - 容器使用宿主机网络（network_mode: host），DATABASE_URL 可以直接写 127.0.0.1，
#     宝塔「数据库 → PgSQL」装在本机、只监听回环地址的 PostgreSQL 无需改 listen_addresses
#     和 pg_hba；云数据库照常填它的地址（sslmode=verify-full）。
#   - host 网络下没有端口映射：Web 控制台自己只监听 127.0.0.1:EDGEWEIR_HTTP_PORT（交给
#     宝塔站点反向代理），节点通道监听 0.0.0.0:EDGEWEIR_NODE_API_PORT（直接对外，TLS 由
#     控制台自己终结，不能交给宝塔 nginx）。这里的两个端口只能是数字。
#   - 宝塔 nginx 从 127.0.0.1 转发，EDGEWEIR_TRUSTED_PROXIES 默认只信任本机回环地址。
# .env 至少需要 DATABASE_URL、EDGEWEIR_MASTER_KEY、EDGEWEIR_PUBLIC_URL；镜像 tag 用
# EDGEWEIR_VERSION 固定（滚动发布的「日期-提交」，例如 20260929-a1b2c3d）。
name: edgeweir

services:
  console:
    image: ghcr.io/marvinli001/edgeweir:${EDGEWEIR_VERSION:-latest}
    container_name: edgeweir-console
    restart: unless-stopped
    network_mode: host
    environment:
      ROLE: all
      DATABASE_URL: ${DATABASE_URL:?DATABASE_URL is required}
      EDGEWEIR_MASTER_KEY: ${EDGEWEIR_MASTER_KEY:-}
      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:-}
      # 浏览器访问控制台的地址，即宝塔站点的域名，例如 https://cdn-admin.example.com
      EDGEWEIR_PUBLIC_URL: ${EDGEWEIR_PUBLIC_URL:-http://localhost:3000}
      # 节点连接控制台的地址，例如 https://cdn-admin.example.com:8443
      EDGEWEIR_NODE_API_URL: ${EDGEWEIR_NODE_API_URL:-}
      EDGEWEIR_NODE_API_HOSTNAMES: ${EDGEWEIR_NODE_API_HOSTNAMES:-}
      # Web 控制台只在本机回环地址监听；节点通道对外
      HOST: 127.0.0.1
      PORT: ${EDGEWEIR_HTTP_PORT:-3000}
      NODE_API_HOST: 0.0.0.0
      NODE_API_PORT: ${EDGEWEIR_NODE_API_PORT:-8443}
      EDGEWEIR_ANALYTICS: ${EDGEWEIR_ANALYTICS:-lite}
      # 可选外部 ClickHouse；此模板不额外创建分析服务。
      EDGEWEIR_CLICKHOUSE_URL: ${EDGEWEIR_CLICKHOUSE_URL:-http://localhost:8123}
      EDGEWEIR_CLICKHOUSE_DATABASE: ${EDGEWEIR_CLICKHOUSE_DATABASE:-edgeweir}
      EDGEWEIR_CLICKHOUSE_USER: ${EDGEWEIR_CLICKHOUSE_USER:-edgeweir}
      EDGEWEIR_CLICKHOUSE_PASSWORD: ${EDGEWEIR_CLICKHOUSE_PASSWORD:-${CLICKHOUSE_PASSWORD:-edgeweir}}
      EDGEWEIR_OUTBOUND_ALLOW_CIDRS: ${EDGEWEIR_OUTBOUND_ALLOW_CIDRS:-}
      EDGEWEIR_ACME_DIRECTORY: ${EDGEWEIR_ACME_DIRECTORY:-}
      EDGEWEIR_ACME_CA_FILE: ${EDGEWEIR_ACME_CA_FILE:-}
      # 旧部署的后备值：「后台 → 系统设置」里保存的值优先
      EDGEWEIR_NODE_RELEASE_BASE_URL: ${EDGEWEIR_NODE_RELEASE_BASE_URL:-}
      EDGEWEIR_SMTP_CA_FILE: ${EDGEWEIR_SMTP_CA_FILE:-}
      EDGEWEIR_DNS_RESOLVERS: ${EDGEWEIR_DNS_RESOLVERS:-}
      # 宝塔 nginx 从本机回环地址转发，只信任它的 X-Forwarded-For
      EDGEWEIR_TRUSTED_PROXIES: ${EDGEWEIR_TRUSTED_PROXIES:-127.0.0.1,::1}
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true
EDGEWEIR_COMPOSE
}

template_bundled() {
  cat <<'EDGEWEIR_COMPOSE'
# Edgeweir 控制台 · 宝塔面板（BT Panel）/ aaPanel · 编排内置 PostgreSQL（Docker 网桥）
#
# 推荐用 deploy.sh 安装和升级（docs/deploy/baota.md），它会对话式生成 .env 并启动本编排；
# PostgreSQL 装在本机（宝塔「数据库 → PgSQL」）或云上时用 compose.baota-host.yml。
# 手动使用的要点：
#   1. 宝塔「Docker → 容器编排 → 添加编排」（aaPanel「Docker → Compose → Add」），粘贴本文件，
#      并在编排的 .env 里填写 EDGEWEIR_MASTER_KEY、POSTGRES_PASSWORD、EDGEWEIR_PUBLIC_URL
#      （主密钥用 openssl rand -base64 32 生成并原样使用，POSTGRES_PASSWORD 会拼进
#      DATABASE_URL，用 openssl rand -hex 24 生成）。会话密钥由主密钥派生；已经设置过
#      BETTER_AUTH_SECRET 的部署继续保留它。其余配置在控制台「后台 → 系统设置」填写。
#      镜像是公开的 ghcr.io/marvinli001/edgeweir，滚动发布，tag 为「日期-提交」（例如
#      20260929-a1b2c3d）；生产在 .env 里用 EDGEWEIR_VERSION 固定一个 tag，升级时改 tag 后
#      「更新镜像」。
#   2. Web 控制台只监听 127.0.0.1:3000，由宝塔站点「反向代理」到 http://127.0.0.1:3000，
#      HTTPS 证书在宝塔上配置即可。
#   3. 节点通道 8443 端口必须直接暴露（或用 nginx stream 四层透传），
#      TLS 由控制台自己终结（节点证书双向认证），不能交给宝塔 nginx 终结。
#      记得在宝塔「安全」和云厂商安全组里放行 8443/TCP。
name: edgeweir

services:
  console:
    image: ghcr.io/marvinli001/edgeweir:${EDGEWEIR_VERSION:-latest}
    container_name: edgeweir-console
    restart: unless-stopped
    environment:
      ROLE: all
      DATABASE_URL: postgres://edgeweir:${POSTGRES_PASSWORD:-edgeweir}@postgres:5432/edgeweir
      EDGEWEIR_MASTER_KEY: ${EDGEWEIR_MASTER_KEY:-}
      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:-}
      # 浏览器访问控制台的地址，即宝塔站点的域名，例如 https://cdn-admin.example.com
      EDGEWEIR_PUBLIC_URL: ${EDGEWEIR_PUBLIC_URL:-http://localhost:3000}
      # 节点连接控制台的地址，例如 https://cdn-admin.example.com:8443
      EDGEWEIR_NODE_API_URL: ${EDGEWEIR_NODE_API_URL:-}
      EDGEWEIR_NODE_API_HOSTNAMES: ${EDGEWEIR_NODE_API_HOSTNAMES:-}
      EDGEWEIR_ANALYTICS: ${EDGEWEIR_ANALYTICS:-lite}
      # 可选外部 ClickHouse；此模板不额外创建分析服务。
      EDGEWEIR_CLICKHOUSE_URL: ${EDGEWEIR_CLICKHOUSE_URL:-http://localhost:8123}
      EDGEWEIR_CLICKHOUSE_DATABASE: ${EDGEWEIR_CLICKHOUSE_DATABASE:-edgeweir}
      EDGEWEIR_CLICKHOUSE_USER: ${EDGEWEIR_CLICKHOUSE_USER:-edgeweir}
      EDGEWEIR_CLICKHOUSE_PASSWORD: ${EDGEWEIR_CLICKHOUSE_PASSWORD:-${CLICKHOUSE_PASSWORD:-edgeweir}}
      EDGEWEIR_OUTBOUND_ALLOW_CIDRS: ${EDGEWEIR_OUTBOUND_ALLOW_CIDRS:-}
      EDGEWEIR_ACME_DIRECTORY: ${EDGEWEIR_ACME_DIRECTORY:-}
      EDGEWEIR_ACME_CA_FILE: ${EDGEWEIR_ACME_CA_FILE:-}
      # 旧部署的后备值：「后台 → 系统设置」里保存的值优先
      EDGEWEIR_NODE_RELEASE_BASE_URL: ${EDGEWEIR_NODE_RELEASE_BASE_URL:-}
      EDGEWEIR_SMTP_CA_FILE: ${EDGEWEIR_SMTP_CA_FILE:-}
      EDGEWEIR_DNS_RESOLVERS: ${EDGEWEIR_DNS_RESOLVERS:-}
      # 宝塔 nginx 的来源地址（Docker 网桥网关），只信任它转发的 X-Forwarded-For
      EDGEWEIR_TRUSTED_PROXIES: ${EDGEWEIR_TRUSTED_PROXIES:-}
    ports:
      # 仅本机可访问，交给宝塔 nginx 反向代理
      - "127.0.0.1:${EDGEWEIR_HTTP_PORT:-3000}:3000"
      # 节点通道：直接对外（或由 stream 透传），不要用宝塔反代
      - "${EDGEWEIR_NODE_API_PORT:-8443}:8443"
    depends_on:
      postgres:
        condition: service_healthy
    read_only: true
    tmpfs:
      - /tmp
    security_opt:
      - no-new-privileges:true

  postgres:
    image: postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873
    container_name: edgeweir-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: edgeweir
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:-edgeweir}
      POSTGRES_DB: edgeweir
    volumes:
      - postgres-data:/var/lib/postgresql
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U edgeweir -d edgeweir"]
      interval: 5s
      timeout: 3s
      retries: 20

volumes:
  postgres-data:
EDGEWEIR_COMPOSE
}

template() {
  case $1 in
    host) template_host ;;
    bundled) template_bundled ;;
    *) die "模板只有 host 和 bundled。" ;;
  esac
}

# --- commands -------------------------------------------------------------------

cmd_install() {
  preflight
  local default_dir=/opt/edgeweir mode_choice='' mode public_url='' node_url='' http_port node_port version
  local master_key pg_password db_choice='' db_ssl url=''

  [[ -f $SELF ]] || die "请先下载脚本再运行：curl -fsSL -o deploy.sh ${SCRIPT_URL} && sudo bash deploy.sh install"

  [[ -d /www/server/panel ]] && default_dir=/www/dk_project/edgeweir
  step "安装 Edgeweir 控制台"
  if [[ -d /www/server/panel ]]; then
    info "检测到宝塔面板 / aaPanel。安装后容器会出现在面板「Docker → 容器」列表里。"
  fi
  ask DIR "安装目录" "${EDGEWEIR_DIR:-$default_dir}"
  [[ $DIR == /* ]] || die "安装目录要用绝对路径。"
  if is_deploy_dir "$DIR"; then
    die "${DIR} 已经有 Edgeweir 部署。升级请运行 ${DIR}/deploy.sh update。"
  fi
  if [[ -e $DIR/.env ]]; then die "${DIR}/.env 已存在，请换一个目录或先移走它。"; fi
  if docker inspect "$CONTAINER" >/dev/null 2>&1; then
    die "已经有名为 ${CONTAINER} 的容器（可能是面板里创建的编排）。在它的目录里用 deploy.sh 管理，或先删除它。"
  fi

  step "数据库"
  case ${EDGEWEIR_DB:-} in
    host) mode_choice=1 ;;
    bundled) mode_choice=2 ;;
    '') if [[ -n $INTERACTIVE ]]; then mode_choice=''; else mode_choice=2; fi ;;
    *) die "EDGEWEIR_DB 只能是 host 或 bundled。" ;;
  esac
  if [[ -z $mode_choice ]]; then
    choose mode_choice 1 \
      "本机或云 PostgreSQL（宝塔「数据库 → PgSQL」或云数据库；容器使用 host 网络）" \
      "编排内置 PostgreSQL（数据库跟控制台一起在 Docker 里运行，数据存在 Docker 卷）"
  fi
  if [[ $mode_choice == 1 ]]; then mode=host; else mode=bundled; fi

  if [[ $mode == host ]]; then
    info "先准备好一个空数据库和它的所有者用户，例如宝塔「数据库 → PgSQL → 添加数据库」。"
    info "控制台在 PostgreSQL ${PG_TESTED_MAJOR} 上测试。"
    while true; do
      if [[ -n ${DATABASE_URL:-} ]]; then
        db_choice=2
      elif [[ -z $INTERACTIVE ]]; then
        die "无人值守安装 host 模式需要 DATABASE_URL。"
      else
        choose db_choice 1 "逐项填写（地址、端口、库名、用户、密码）" "粘贴连接串 postgres://…"
      fi
      if [[ $db_choice == 2 ]]; then
        url=${DATABASE_URL:-}
        [[ -n $url ]] || ask url "DATABASE_URL"
        if ! db_parse "$url"; then
          [[ -n $INTERACTIVE ]] || die "DATABASE_URL 格式不对：postgres://用户:密码@主机:端口/库名[?sslmode=verify-full]"
          warn "格式不对：postgres://用户:密码@主机:端口/库名[?sslmode=verify-full]"
          DATABASE_URL=''
          continue
        fi
        env_safe "$url" || die "连接串里有空白、引号、\$ 或 #，请把密码里的特殊字符做 URL 编码（例如 \$ 写成 %24）。"
      else
        ask DB_HOST "数据库地址" "${DB_HOST:-127.0.0.1}"
        ask DB_PORT "端口" "${DB_PORT:-5432}"
        ask DB_NAME "数据库名" "${DB_NAME:-edgeweir}"
        ask DB_USER "用户名" "${DB_USER:-$DB_NAME}"
        ask_secret DB_PASS "密码（输入时不显示）"
        [[ -n $DB_PASS ]] || { warn "密码不能为空。"; continue; }
        DB_SSLMODE=''
        if ! is_loopback "$DB_HOST"; then
          db_ssl=''
          confirm "使用 TLS 连接并校验证书（云数据库推荐）？" y && db_ssl=verify-full
          DB_SSLMODE=$db_ssl
        fi
      fi
      if db_check; then break; fi
      [[ -n $INTERACTIVE ]] || die "数据库检查没有通过。"
      DATABASE_URL=''
      confirm "重新填写数据库信息？" y || die "已取消。"
    done
  else
    info "数据库密码自动生成；数据保存在 Docker 卷 edgeweir_postgres-data。"
  fi

  step "访问地址"
  info "控制台地址是浏览器打开的地址，通常是宝塔站点的域名（配好 SSL 后用 https://）。"
  while true; do
    ask public_url "控制台地址" "${EDGEWEIR_PUBLIC_URL:-}"
    public_url=${public_url%/}
    valid_url "$public_url" && break
    [[ -n $INTERACTIVE ]] || die "EDGEWEIR_PUBLIC_URL 需要形如 https://cdn-admin.example.com"
    warn "需要形如 https://cdn-admin.example.com（不带路径）。"
  done
  [[ $public_url == https://* ]] || warn "不是 https：登录会话只应在 HTTPS 下使用，配好证书后记得改成 https:// 并重启。"
  info "节点通道是节点连接控制台的地址，TLS 由控制台自己终结，不能经过宝塔反代或 CDN。"
  while true; do
    ask node_url "节点通道地址" "${EDGEWEIR_NODE_API_URL:-https://$(url_host "$public_url"):${EDGEWEIR_NODE_API_PORT:-8443}}"
    node_url=${node_url%/}
    [[ $node_url == https://* ]] && valid_url "$node_url" && break
    [[ -n $INTERACTIVE ]] || die "EDGEWEIR_NODE_API_URL 需要形如 https://cdn-admin.example.com:8443"
    warn "需要形如 https://cdn-admin.example.com:8443"
  done
  node_port=$(url_port "$node_url")
  http_port=${EDGEWEIR_HTTP_PORT:-3000}
  http_port=${http_port##*:}
  while port_in_use "$http_port"; do
    warn "本机端口 ${http_port} 已被占用。"
    [[ -n $INTERACTIVE ]] || die "设置 EDGEWEIR_HTTP_PORT 为空闲端口。"
    ask http_port "Web 控制台端口（只监听 127.0.0.1，给宝塔反代）" "$((http_port + 1))"
  done
  if port_in_use "$node_port"; then
    die "节点通道端口 ${node_port} 已被占用，换一个端口写进节点通道地址（例如 :9443）。"
  fi
  [[ $http_port =~ ^[0-9]+$ && $node_port =~ ^[0-9]+$ && $http_port != "$node_port" ]] ||
    die "端口无效：Web ${http_port}，节点通道 ${node_port}。"

  step "镜像版本"
  version=$(resolve_version "${EDGEWEIR_VERSION:-latest}")
  ok "固定为 ${version}"

  step "确认"
  info "目录          ${DIR}"
  info "数据库        $([[ $mode == host ]] && printf '%s' "${DB_HOST}:${DB_PORT}/${DB_NAME}（host 网络）" || printf '编排内置 PostgreSQL')"
  info "控制台地址    ${public_url}  →  宝塔反代到 http://127.0.0.1:${http_port}"
  info "节点通道      ${node_url}  （放行 ${node_port}/TCP）"
  info "版本          ${version}"
  confirm "开始安装？" y || die "已取消。"

  step "生成配置"
  mkdir -p "$DIR"
  chmod 700 "$DIR"
  master_key=$(rand_base64 32)
  (
    umask 077
    {
      printf '# Edgeweir 控制台 · deploy.sh 生成于 %s（%s）\n' "$(date '+%Y-%m-%d %H:%M')" "$mode"
      printf '# 主密钥加密入库的私钥和 DNS 密钥，并派生会话 secret。请离线备份，丢失后无法恢复。\n'
      printf 'EDGEWEIR_MASTER_KEY=%s\n' "$master_key"
      if [[ $mode == host ]]; then
        printf 'DATABASE_URL=%s\n' "$(if [[ $db_choice == 2 ]]; then printf '%s' "$url"; else db_url; fi)"
        printf 'EDGEWEIR_HTTP_PORT=%s\n' "$http_port"
      else
        pg_password=$(rand_hex 24)
        printf '# 内置 PostgreSQL 的密码（只在编排网络内可达）\n'
        printf 'POSTGRES_PASSWORD=%s\n' "$pg_password"
        printf 'EDGEWEIR_HTTP_PORT=%s\n' "$http_port"
      fi
      printf 'EDGEWEIR_NODE_API_PORT=%s\n' "$node_port"
      printf 'EDGEWEIR_PUBLIC_URL=%s\n' "$public_url"
      printf 'EDGEWEIR_NODE_API_URL=%s\n' "$node_url"
      printf '# 镜像 tag（滚动发布的「日期-提交」）；./deploy.sh update 会更新它\n'
      printf 'EDGEWEIR_VERSION=%s\n' "$version"
      printf '# 其余配置在控制台「后台 → 系统设置」填写；可选变量见 .env.example\n'
    } >"$DIR/.env"
  )
  COMPOSE_FILE=compose.yml
  template "$mode" >"$DIR/$COMPOSE_FILE"
  if [[ $SELF != "$DIR/deploy.sh" ]]; then install -m 700 "$SELF" "$DIR/deploy.sh"; fi
  ok "已写入 ${DIR}/.env（600）、${DIR}/${COMPOSE_FILE} 和 ${DIR}/deploy.sh"

  step "启动"
  pull
  up_and_wait
  ok "控制台已启动，版本 $(running_version)"
  print_next_steps "$public_url" "$http_port" "$node_port"
}

print_next_steps() {
  local public_url=$1 http_port=$2 node_port=$3 token
  token=$(setup_token)
  step "接下来"
  info "1. 放行节点通道端口 ${node_port}/TCP：宝塔「安全」和云厂商安全组。Web 端口 ${http_port} 不要对外放行。"
  info "2. 宝塔「网站 → 添加站点」，域名填 $(url_host "$public_url")，PHP 选「纯静态」；"
  info "   站点设置「反向代理」目标 URL 填 http://127.0.0.1:${http_port}；「SSL」申请证书并开启强制 HTTPS。"
  if [[ -n $token ]]; then
    info "3. 打开 ${public_url}/setup，填入一次性初始化令牌并创建管理员："
    printf '\n        %s%s%s\n\n' "$B" "$token" "$N" >&2
    info "   令牌也可以随时用 ./deploy.sh setup-token 查看。"
  else
    info "3. 打开 ${public_url} 登录。"
  fi
  info "4. 离线备份 ${DIR}/.env（含主密钥）。以后在 ${DIR} 里运行 ./deploy.sh update 升级。"
}

# backup [label]: database dump plus .env and compose file, into backups/<time>.
cmd_backup() {
  local dest
  dest=$DIR/backups/$(date +%Y%m%d-%H%M%S)${1:+-$1}
  mkdir -p "$DIR/backups"
  chmod 700 "$DIR/backups"
  mkdir -m 700 "$dest"
  step "备份到 ${dest}"
  if [[ $(deploy_mode) == host ]]; then
    db_parse "$(env_get DATABASE_URL)" || die ".env 里的 DATABASE_URL 无法解析，不能备份。"
    pg_client pg_dump --format=custom >"$dest/edgeweir.dump" || die "pg_dump 失败，已中止。"
  else
    compose exec -T postgres pg_dump -U edgeweir -d edgeweir --format=custom >"$dest/edgeweir.dump" ||
      die "pg_dump 失败（数据库容器在运行吗？），已中止。"
  fi
  install -m 600 "$DIR/.env" "$dest/env"
  install -m 600 "$DIR/$COMPOSE_FILE" "$dest/$COMPOSE_FILE"
  chmod 600 "$dest/edgeweir.dump"
  ok "edgeweir.dump（$(du -h "$dest/edgeweir.dump" | awk '{print $1}')）、env、${COMPOSE_FILE}"
  info "备份含主密钥和全部数据，请复制到别的机器并妥善保管；恢复步骤见 docs/deploy/backup.md。"
}

cmd_update() {
  local target=latest skip_backup='' arg current version tmp
  for arg in "$@"; do
    case $arg in
      --no-backup) skip_backup=1 ;;
      -*) die "未知参数：${arg}" ;;
      *) target=$arg ;;
    esac
  done
  preflight
  find_dir
  current=$(env_get EDGEWEIR_VERSION)
  step "检查版本（当前 ${current:-latest}）"
  version=$(resolve_version "$target")
  if [[ $version == "$current" && $version != latest ]] && [[ $(running_version) == "$version" ]]; then
    ok "已经是 ${version}。"
    return 0
  fi
  info "${current:-latest} → ${version}"
  if [[ -n $current && $current > $version && $target != latest ]]; then
    warn "这是回退：数据库迁移只向前执行，只有两个版本之间没有新增迁移时才能直接换回旧镜像。"
    confirm "继续？" n || die "已取消。"
  fi
  if [[ -z $skip_backup ]]; then
    cmd_backup "before-$version"
  else
    warn "跳过备份。"
  fi

  tmp=$(mktemp)
  template "$(deploy_mode)" >"$tmp"
  if ! cmp -s "$tmp" "$DIR/$COMPOSE_FILE"; then
    info "编排文件与脚本自带的模板不同（模板更新过，或你改过它）。"
    if confirm "替换为脚本自带的模板？（旧文件已在备份里）" "$([[ -n $INTERACTIVE ]] && echo y || echo n)"; then
      install -m 600 "$tmp" "$DIR/$COMPOSE_FILE"
      ok "编排文件已更新"
    else
      info "保留现有编排文件；需要时用 ./deploy.sh template $(deploy_mode) 查看模板。"
    fi
  fi
  rm -f "$tmp"

  env_set EDGEWEIR_VERSION "$version"
  step "升级"
  up_and_wait
  ok "当前版本 $(running_version)"
  [[ -n $current ]] && info "回退：./deploy.sh update ${current}（仅当两个版本之间没有新增数据库迁移）"
  offer_script_update "$IMAGE:$version"
}

# script_from_image <ref> <dest>: the deploy.sh shipped in that image.
script_from_image() {
  docker run --rm --entrypoint cat "$1" /app/deploy.sh >"$2" 2>/dev/null && [[ -s $2 ]] && bash -n "$2"
}

# replace_self <file>: renames over this script (a new inode: the running
# bash keeps reading the old one).
replace_self() {
  local tmp
  tmp=$(mktemp "$SELF_DIR/.deploy.sh.XXXXXX")
  cat "$1" >"$tmp"
  chmod 700 "$tmp"
  mv "$tmp" "$SELF"
}

# offer_script_update <image>: replaces this script with the one in the image.
offer_script_update() {
  local tmp
  tmp=$(mktemp)
  if script_from_image "$1" "$tmp" && ! cmp -s "$tmp" "$SELF"; then
    if confirm "镜像里带有新版 deploy.sh，更新脚本？" y; then
      replace_self "$tmp"
      ok "deploy.sh 已更新"
    fi
  fi
  rm -f "$tmp"
}

# config: changes the public and node channel addresses, then recreates the console.
cmd_config() {
  local public_url node_url node_port
  preflight
  find_dir
  [[ -n $INTERACTIVE ]] || die "config 需要在终端里交互运行；也可以直接编辑 ${DIR}/.env 后运行 ./deploy.sh start。"
  step "修改访问地址（回车保留当前值）"
  while true; do
    ask public_url "控制台地址" "$(env_get EDGEWEIR_PUBLIC_URL)"
    public_url=${public_url%/}
    valid_url "$public_url" && break
    warn "需要形如 https://cdn-admin.example.com（不带路径）。"
  done
  while true; do
    ask node_url "节点通道地址" "$(env_get EDGEWEIR_NODE_API_URL)"
    node_url=${node_url%/}
    [[ $node_url == https://* ]] && valid_url "$node_url" && break
    warn "需要形如 https://cdn-admin.example.com:8443"
  done
  node_port=$(url_port "$node_url")
  if [[ $node_port != "$(env_get EDGEWEIR_NODE_API_PORT)" ]]; then
    warn "节点通道端口改为 ${node_port}：记得放行新端口；已注册节点要按新地址重新注册。"
  fi
  if [[ $(url_host "$node_url") != $(url_host "$(env_get EDGEWEIR_NODE_API_URL)") ]]; then
    warn "节点通道主机名改变后，已注册的节点需要重新注册（或把旧名字加进 EDGEWEIR_NODE_API_HOSTNAMES）。"
  fi
  confirm "保存并重启控制台？" y || die "已取消。"
  env_set EDGEWEIR_PUBLIC_URL "$public_url"
  env_set EDGEWEIR_NODE_API_URL "$node_url"
  env_set EDGEWEIR_NODE_API_PORT "$node_port"
  up_and_wait
  ok "已生效"
}

# self-update: the deploy.sh shipped in the running version's image; without
# one (older images), the copy on GitHub.
cmd_self_update() {
  local tmp ref source
  preflight
  find_dir
  ref=$IMAGE:$(env_get EDGEWEIR_VERSION)
  tmp=$(mktemp)
  if script_from_image "$ref" "$tmp"; then
    source=$ref
  else
    step "从 ${SCRIPT_URL} 下载 deploy.sh"
    curl -fsSL "$SCRIPT_URL" -o "$tmp" || die "下载失败。"
    bash -n "$tmp" || die "下载的脚本有语法错误，未替换。"
    source=$SCRIPT_URL
  fi
  if cmp -s "$tmp" "$SELF"; then
    ok "已经是 ${source} 的版本。"
  else
    replace_self "$tmp"
    ok "已从 ${source} 更新 ${SELF}"
  fi
  rm -f "$tmp"
}

usage() {
  cat >&2 <<EOF
用法：./deploy.sh <命令>

  install            对话式安装（选择数据库方式、生成 .env、启动）
  update [tag]       备份后升级到最新版本或指定 tag（--no-backup 跳过备份）
  backup             备份数据库、.env 和编排文件到 backups/
  config             修改控制台地址和节点通道地址
  start | stop | restart
  status             容器状态和运行中的版本
  logs [服务]        跟随日志（console / postgres）
  setup-token        显示首次初始化令牌
  template <host|bundled>  输出编排模板（手动在面板里粘贴时用）
  self-update        用当前版本镜像附带的 deploy.sh（旧镜像没有时用 GitHub 上的）更新本脚本

无人值守安装：EDGEWEIR_YES=1 EDGEWEIR_DB=host|bundled EDGEWEIR_PUBLIC_URL=https://…
  [DATABASE_URL=…] [EDGEWEIR_NODE_API_URL=…] [EDGEWEIR_VERSION=…] [EDGEWEIR_DIR=…]
只用本机已有镜像（docker load 导入）：EDGEWEIR_NO_PULL=1
EOF
}

main() {
  local command=${1:-help}
  [[ $# -gt 0 ]] && shift
  case $command in
    install) cmd_install ;;
    update | upgrade) cmd_update "$@" ;;
    backup)
      preflight
      find_dir
      cmd_backup
      ;;
    start)
      preflight
      find_dir
      up_and_wait
      ok "已启动，版本 $(running_version)"
      ;;
    stop)
      preflight
      find_dir
      compose stop
      ;;
    restart)
      preflight
      find_dir
      local rc=0
      sync_trusted_proxy || rc=$?
      if ((rc == 10)); then up_and_wait; else compose restart; fi
      ;;
    status)
      preflight
      find_dir
      compose ps
      info "目录 ${DIR}（$(deploy_mode)），版本 $(running_version)"
      ;;
    logs)
      preflight
      find_dir
      compose logs -f --tail=200 "$@"
      ;;
    setup-token)
      preflight
      find_dir
      local token
      token=$(setup_token)
      [[ -n $token ]] || die "日志里没有初始化令牌：已经完成初始化，或容器还没启动。"
      printf '%s\n' "$token"
      ;;
    config) cmd_config ;;
    template) template "${1:-}" ;;
    self-update) cmd_self_update ;;
    help | -h | --help) usage ;;
    *)
      usage
      exit 1
      ;;
  esac
}

# Sourcing the script (tests) only defines the functions.
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
