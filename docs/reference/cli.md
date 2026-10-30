# 命令行

`deploy.sh`、节点安装脚本 `install.sh`、Docker Compose 运维命令、容器入口、找回账户与开发命令的参数、环境变量与退出码。

## deploy.sh

宝塔 / aaPanel 及任意装有 Docker 与 Compose v2 的 Linux 上的安装与运维脚本。用法：`./deploy.sh <命令> [参数]`。行为、写入的文件与备份结构见 [deploy.sh 参考](../deploy/deploy-script.md)。

### 命令

| 命令 | 参数 | 作用 |
| --- | --- | --- |
| `install` | — | 对话式安装：选择数据库方式（`host` 或 `bundled`）、生成 `.env` 与编排文件、启动。脚本须先下载到本地文件（`curl … \| bash` 不可用） |
| `update` | `[tag]`、`--no-backup` | 备份后升级到 `tag`（默认 `stable`；`latest` 跟随 master 构建，或日期 tag）。渠道解析为日期 tag 写入 `.env` 的 `EDGEWEIR_VERSION`。`--no-backup` 跳过备份。别名 `upgrade` |
| `backup` | — | 备份数据库、`.env`（不含主密钥）和编排文件到 `backups/`，保留份数见 `EDGEWEIR_BACKUP_KEEP` |
| `restore` | `<备份>`、`--no-backup` | 先备份当前数据库，再用备份目录中的 `edgeweir.dump` 替换数据库；`.env` 不变。非交互运行时需要 `EDGEWEIR_YES=1` |
| `config` | — | 修改控制台地址和节点通道地址 |
| `start` | — | 启动，应用 `.env` 的修改 |
| `stop` | — | 停止 |
| `restart` | — | 重建控制台容器并启动，应用 `.env` 的修改 |
| `status` | — | 容器状态、部署目录、编排方式与运行中的版本 |
| `logs` | `[服务]` | 跟随最近 200 行起的日志；服务为 `console` 或 `postgres` |
| `setup-token` | — | 输出首次初始化令牌；已完成初始化或容器未启动时报错 |
| `template` | `host` \| `bundled` | 输出编排模板，用于在面板中手动粘贴 |
| `self-update` | — | 用当前镜像附带的 `/app/deploy.sh` 更新脚本本身；镜像未附带时从 `EDGEWEIR_SCRIPT_URL` 下载 |
| `help`、`-h`、`--help` | — | 输出用法 |

### 环境变量

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `EDGEWEIR_YES` | 未设置 | 非空：不打开 `/dev/tty` 提问，使用默认值或下列变量（无人值守）；`restore` 不再要求确认 |
| `EDGEWEIR_DB` | 交互：询问；无人值守：`bundled` | `install` 的数据库方式：`host`（本机或云 PostgreSQL，宿主机网络）或 `bundled`（编排内置 PostgreSQL）；其他值报错 |
| `DATABASE_URL` | 无 | `install` 的 `host` 方式的连接串；无人值守时必需。不得含空白、引号、`$` 或 `#` |
| `EDGEWEIR_PUBLIC_URL` | 无 | `install` 的控制台地址；无人值守时必需 |
| `EDGEWEIR_NODE_API_URL` | `https://<控制台主机>:<EDGEWEIR_NODE_API_PORT>` | `install` 的节点通道地址，须为 `https://`；其端口即节点通道端口。`host` 方式下端口不小于 1024 |
| `EDGEWEIR_NODE_API_PORT` | `8443` | `install` 的默认节点通道地址中的端口 |
| `EDGEWEIR_HTTP_PORT` | `3000` | `install` 的 Web 端口（只取最后一个 `:` 之后的数字）；被占用时交互运行询问新端口，无人值守报错 |
| `EDGEWEIR_VERSION` | `stable` | `install` 的镜像 tag；渠道解析为日期 tag |
| `EDGEWEIR_DIR` | `/opt/edgeweir`；有 `/www/server/panel` 时 `/www/dk_project/edgeweir` | `install` 的安装目录（绝对路径，须为空目录）。其他命令按顺序查找部署：`EDGEWEIR_DIR`、脚本所在目录、当前目录、`/www/dk_project/edgeweir`、`/opt/edgeweir` |
| `EDGEWEIR_NO_PULL` | 未设置 | 非空：不拉取镜像，只用本机已有镜像（`docker load` 导入） |
| `EDGEWEIR_POSTGRES_IMAGE` | `postgres:18.6-alpine`（按 digest 固定） | `bundled` 方式的 PostgreSQL 镜像，以及 `host` 方式检查与备份所用的镜像 |
| `EDGEWEIR_BACKUP_KEEP` | `5` | 保留的备份份数；`0` 为全部保留；非数字报错 |
| `EDGEWEIR_SCRIPT_URL` | `https://raw.githubusercontent.com/marvinli001/edgeweir/master/deploy.sh` | `self-update` 的后备下载地址 |

### 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 完成，或 `help` |
| `1` | 任一检查或步骤失败（stderr 输出 `✗` 与原因），或未知命令（同时输出用法） |

## 节点安装脚本

`install.sh` 由控制台在 `/install.sh` 提供，在节点上安装并注册 `edgeweir-node`。控制台生成的安装命令已填入 `--server` 与 `--ca-sha256`，见[接入节点](../deploy/nodes.md)。

```bash title="节点"
export EDGEWEIR_TOKEN='<一次性 token>'
curl -fsSL https://<控制台>/install.sh | sudo --preserve-env=EDGEWEIR_TOKEN bash -s -- \
  --server https://<控制台>:8443 --ca-sha256 <CA 指纹>
```

### 选项

`<控制台>` 为 `EDGEWEIR_PUBLIC_URL`，控制台提供脚本时写入。

| 选项 | 参数 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `--server` | URL | 必需 | 节点通道 URL：`https://主机[:端口]`（节点通道端口，默认 443），或 `wss://`、`ws://主机[:端口]`（Web 端口上的 WebSocket 入口，需要 edgeweir-node 0.2.0 及以上） |
| `--ca-sha256` | HEX | 必需 | 控制台节点 CA 的 SHA-256 指纹，64 位小写十六进制；注册时固定 |
| `--token-file` | PATH | 无 | 从文件读取注册 token（去除全部空白），优先于 `EDGEWEIR_TOKEN` |
| `--version` | VER | `latest` | 安装的 edgeweir-node 版本，语义化版本，可带 `v` 前缀。`latest` 依次从镜像的 `latest` 文件、GitHub 最新发布解析。已注册的主机不给此选项（也不给 `--force`）时不下载、不安装，只启动或重启服务并检查 |
| `--format` | `auto` \| `deb` \| `rpm` \| `tar` | `auto` | 安装包格式。`auto`：有 `dpkg` 与 `apt-get` 时 deb；有 `rpm` 与 `dnf` 或 `yum` 时 rpm；否则 tar |
| `--mirror` | URL | `<控制台>/downloads/edgeweir-node` | edgeweir-node 发布镜像（`http`、`https`），文件位于 `URL/latest`、`URL/v<版本>/<文件>`；cosign 取自同级的 `cosign/v<版本>/`。每个文件先从镜像下载，失败后从 GitHub 下载 |
| `--mirror-only` | — | 关 | 不回退到 GitHub |
| `--no-modsecurity` | — | 关 | 不安装 `edgeweir-openresty-modsecurity`：该节点不支持 OWASP CRS |
| `--no-start` | — | 关 | 只安装和注册：不要求 systemd，不启用、不启动服务，不做健康检查 |
| `--force` | — | 关 | 已注册的主机重新注册（需要新的 token）：照新主机安装软件包，停止 `edgeweir-node`，替换身份后再启动 |
| `--allow-unsigned` | — | 关 | 跳过 cosign 签名校验，仅限开发；仍校验 SHA-256 |
| `-h`、`--help` | — | — | 输出用法 |

| 环境变量 | 作用 |
| --- | --- |
| `EDGEWEIR_TOKEN` | 一次性注册 token，格式 `ewt_` 加 `[A-Za-z0-9_-]`。脚本读取后从环境中移除，其他子进程不继承；经环境变量传给 `edgeweir-node enroll`。已注册且未给 `--force` 时不使用 |

`--token` 与 `--token=…` 被拒绝：命令行参数在进程列表中可见。

### 系统要求与检查

| 检查 | 失败条件 |
| --- | --- |
| 系统 | 不是 Linux；不是 root；缺少 `curl`、`sha256sum` 或 `tar`；未给 `--no-start` 且没有 systemd |
| 架构 | 不是 `x86_64`（`amd64`）或 `aarch64`（`arm64`） |
| glibc | 低于 2.34（RHEL / Rocky / AlmaLinux 9、Debian 12、Ubuntu 22.04 及以上） |
| 节点通道（`https://`） | 不可达；装有 `openssl` 时，服务器出示的最后一张证书的 SHA-256 不是 `--ca-sha256`（TLS 被代理或 CDN 终结） |
| 节点通道（`wss://`、`ws://`） | `<Web 地址>/node-channel` 返回 404（WebSocket 入口关闭）或 426 以外的状态 |

| 对象 | 校验 |
| --- | --- |
| `checksums.txt` | cosign 无密钥签名（`checksums.txt.sigstore.json`）。证书身份：`https://github.com/marvinli001/edgeweir-node/.github/workflows/release.yml@refs/tags/v<版本>`；OIDC 签发者：`https://token.actions.githubusercontent.com` |
| 安装包 | SHA-256，与已签名的 `checksums.txt` 比对 |
| cosign | 机器上没有 cosign 时下载 v3.1.3，按脚本内置的 SHA-256 核对 |

校验通过前不执行任何下载内容。执行流程与安装结果见[接入节点](../deploy/nodes.md#installsh-流程)。

### 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 安装与注册完成，`edgeweir-node healthcheck` 已通过（`--no-start` 时不检查） |
| `1` | 任一检查或步骤失败，包括未知选项、90 秒内健康检查未通过；stderr 输出 `[edgeweir] error:` 与原因 |
| `2` | 缺少 `--server` 或 `--ca-sha256`，选项缺少参数，或指定了 `-h`、`--help`；stderr 输出用法 |

脚本不提供卸载。节点升级见[节点升级](../guide/node-upgrades.md)。

## Docker Compose

在 `compose.yml` 所在目录执行；其他编排文件加 `-f <文件>`。

| 操作 | 命令 |
| --- | --- |
| 启动，或应用 `.env` 修改 | `docker compose up -d` |
| 从源码构建并启动 | `docker compose up -d --build` |
| 停止 | `docker compose stop` |
| 删除容器与网络，保留数据卷 | `docker compose down` |
| 重启（不应用 `.env` 修改） | `docker compose restart console` |
| 状态 | `docker compose ps` |
| 跟随日志 | `docker compose logs -f console` |
| 查看 setup token 日志行 | `docker compose logs console \| grep setupToken` |
| 健康检查（宿主机） | `curl -s http://127.0.0.1:3000/healthz` |
| 健康检查（容器内） | `docker compose exec console edgeweir-healthcheck` |
| 找回账户 | `docker compose exec console node dist/server/recover.js <选项>`，见[找回账户](#找回账户) |
| 拉取 `EDGEWEIR_VERSION` 指定的镜像并重建 | `docker compose pull && docker compose up -d` |
| 启动 ClickHouse | `.env` 中设置 `COMPOSE_PROFILES=analytics` 后 `docker compose up -d` |

> [!WARNING]
> `docker compose down -v` 删除 `postgres-data` 等命名卷，即全部数据。

只输出 setup token：

```bash
docker compose logs --no-color --no-log-prefix console \
  | sed -n 's/.*"setupToken":"\([^"]*\)".*/\1/p' | tail -n 1
```

`/healthz` 返回 `{"status":"ok","version":"<版本>"}`。`EDGEWEIR_HTTP_PORT` 不是 `3000` 时改用该端口。升级与回滚步骤见[版本、升级与回滚](../deploy/upgrade.md)。

## 容器

| 项 | 值 |
| --- | --- |
| 镜像 | `ghcr.io/marvinli001/edgeweir:<tag>`，linux/amd64、linux/arm64 |
| 入口 | `/sbin/tini --` |
| 命令 | `node --enable-source-maps dist/server/main.js`，工作目录 `/app` |
| 用户 | `node` |
| 端口 | `3000`（Web、API）、`8443`（节点通道） |
| 环境变量默认值 | `NODE_ENV=production`、`ROLE=all`、`HOST=0.0.0.0`、`PORT=3000`、`NODE_API_PORT=8443`、`EDGEWEIR_VERSION=<构建版本>`、`EDGEWEIR_CERTD_BIN=/usr/local/bin/edgeweir-certd` |
| 健康检查 | `edgeweir-healthcheck`；间隔 10 秒，超时 3 秒，启动期 30 秒，重试 5 次 |
| 附带文件 | `/usr/local/bin/edgeweir-certd`、`/usr/local/bin/edgeweir-healthcheck`、`/app/deploy.sh`、`/app/dist/server/recover.js` |
| 停止信号 | `SIGTERM`、`SIGINT`：关闭 HTTP 与节点通道监听并结束节点的监视流，进行中的请求最多 3 秒，同时等待 pg-boss 最多 5 秒，进程以 0 退出；8 秒内未完成以 1 退出 |

`edgeweir-healthcheck`：`ROLE=worker` 时直接返回 0；其他角色请求 `http://127.0.0.1:${PORT}/healthz`（`PORT` 默认 3000），超时 2 秒，失败返回非 0。

### ROLE

| 值 | 组件 |
| --- | --- |
| `all`（默认） | Web 与 API、节点通道、pg-boss worker |
| `app` | Web 与 API、节点通道 |
| `worker` | pg-boss worker；不监听端口 |

扩展方式见[部署概览](../deploy/README.md#进程角色)。

## 找回账户

`dist/server/recover.js` 为控制台唯一的账户重置密码、停用两步验证或清空登录 IP 白名单，用于无法登录时。它读取与控制台相同的环境变量（`DATABASE_URL`、`EDGEWEIR_MASTER_KEY` 等），直接修改数据库，不经过 Web 界面与 HTTP。步骤见[找回账户](../guide/account.md#找回账户)。

```bash
docker compose exec console node dist/server/recover.js --reset-password --disable-two-factor
```

| 部署 | 命令 |
| --- | --- |
| Docker Compose | `docker compose exec console node dist/server/recover.js <选项>` |
| Docker Compose，控制台容器未运行 | `docker compose run --rm console node dist/server/recover.js <选项>` |
| 宝塔 / aaPanel（`deploy.sh`） | `docker exec -it edgeweir-console node dist/server/recover.js <选项>` |
| 源码 | `pnpm --filter @edgeweir/console recover <选项>`，见[命令](#命令-1) |

### 选项

| 选项 | 作用 |
| --- | --- |
| `--reset-password` | 设置新密码，12–128 字符 |
| `--disable-two-factor` | 停用两步验证，删除 TOTP 密钥与备用码 |
| `--clear-login-allowlist` | 清空[登录 IP 白名单](../guide/system.md#登录-ip-白名单)，任何地址都能再次登录 |
| `-h`、`--help` | 输出用法到标准输出 |

至少指定 `--reset-password`、`--disable-two-factor`、`--clear-login-allowlist` 之一。

### 新密码

| 标准输入 | 读取方式 |
| --- | --- |
| 终端（`docker compose exec` 与 `docker exec -it` 默认分配） | 提示 `New password:` 与 `Repeat new password:`，输入不回显；两次不一致时不做修改。Ctrl-C 取消 |
| 管道或文件 | 第一行，去掉行尾的 `\n` 或 `\r\n`；为空时报错 |

```bash
docker compose exec -T console node dist/server/recover.js --reset-password < new-password.txt
```

`-T` 不分配终端，只在从管道或文件输入时使用：在终端里直接输入时密码会显示在屏幕上。密码不接受命令行参数或环境变量：命令行参数在进程列表与 shell 历史中可见。

### 执行结果

以下变更与审计条目在同一事务中提交，任一步失败时全部回滚：

| 变更 | 说明 |
| --- | --- |
| 密码 | 由 better-auth 哈希（scrypt）后写入账户的密码凭据 |
| 两步验证 | 关闭；删除 TOTP 密钥与备用码 |
| 登录 IP 白名单 | 删除 |
| 会话 | 删除该账户的全部会话，以及尚未完成两步验证的登录与受信任设备记录 |
| 审计日志 | `account.recover`，操作者为系统（名称 `recover`）；元数据 `passwordReset`、`twoFactorDisabled`、`sessionsRevoked`，清空白名单时还有 `loginAllowListCleared`（清空前的地址段） |

姓名、邮箱、通行密钥与 AccessKey 不变。标准输出为账户的姓名与邮箱和完成的操作，不含密码、密码哈希或会话 token：

```text
Account: Ops <admin@example.com>
Password reset.
Two-factor authentication turned off.
Signed out 2 sessions.
```

| 操作 | 输出 |
| --- | --- |
| `--disable-two-factor` | `Two-factor authentication turned off.`；本来未启用时 `Two-factor authentication was already off.` |
| `--clear-login-allowlist` | `Login allow list cleared (N ranges).`；本来为空时 `The login allow list was already off.` |
| 会话 | `Signed out N sessions.`（每次都输出） |

### 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 完成，或指定了 `-h`、`--help` |
| `1` | 未做修改：没有账户（尚未初始化）、密码长度不符、两次输入不一致、标准输入没有密码、已取消、配置无效、数据库连接或写入失败；stderr 输出 `error:` 与原因 |
| `2` | 未知选项、多余参数或未指定操作；stderr 输出用法 |

## 开发

要求：Node.js 24.11.0 及以上、pnpm 12.6.0、Docker；`helpers/certd` 与 `pnpm e2e` 另需 Go 1.27.2。buf 随开发依赖安装。

### 本地运行

1. 安装依赖。

   ```bash
   pnpm install
   ```

2. 启动开发数据库（`compose.dev.yml`，端口见 [`DEV_POSTGRES_PORT`](environment.md#compose-宿主机变量)）。

   ```bash
   docker compose -f compose.dev.yml up -d
   ```

3. 创建 `.env`，填写 `EDGEWEIR_MASTER_KEY`（`openssl rand -base64 32`）。`DATABASE_URL` 的模板值与开发数据库一致。

   ```bash
   cp .env.example .env
   ```

4. 启动控制台。

   ```bash
   pnpm dev
   ```

5. 验证。

   ```bash
   curl -s http://localhost:3000/healthz
   ```

   预期输出：`{"status":"ok","version":"dev"}`。

签发证书需要证书助手：`cd helpers/certd && go build -o bin/edgeweir-certd .`，再把绝对路径写入 `EDGEWEIR_CERTD_BIN`。

### 命令

在仓库根目录执行。

| 命令 | 作用 |
| --- | --- |
| `pnpm dev` | 单进程运行 API、节点通道与 Vite HMR；读取仓库根目录的 `.env`（存在时）；Web 监听 `PORT` |
| `pnpm build` | Turborepo 构建全部包；控制台输出到 `apps/console/dist` |
| `pnpm typecheck` | 类型检查 |
| `pnpm test` | Vitest；数据库使用 PGlite，不需要 Docker |
| `pnpm lint` | `biome check .`、`buf lint proto` 与 `knip` |
| `pnpm format` | `biome check --write .` |
| `pnpm proto:lint` | `buf lint proto` |
| `pnpm proto:breaking` | 检查 `proto/` 的不兼容变更（`scripts/proto-breaking.sh`） |
| `pnpm proto:gen` | 由 `proto/` 生成 `packages/proto/src/gen` |
| `pnpm db:generate` | 由 `packages/db/src/schema` 生成 SQL 迁移到 `packages/db/migrations`（drizzle-kit） |
| `pnpm e2e` | 运行 `scripts/e2e.sh` |
| `pnpm --filter @edgeweir/console start` | 运行已构建的 `dist/server/main.js` |
| `pnpm --filter @edgeweir/console recover <选项>` | 从源码运行[找回账户](#找回账户)命令；读取仓库根目录的 `.env`（存在时）。选项前不加 `--` |
| `pnpm --filter @edgeweir/console test:e2e` | Playwright 测试 |

### 端到端测试

`scripts/e2e.sh` 针对 `compose.e2e.yml` 运行。需要 `curl`、`jq`、`docker`、`node`；安装脚本步骤另需 goreleaser v2、syft、Go 1.27.2 与同级的 `edgeweir-node` 源码，签名升级步骤需要 cosign v3.1.3；运行时需要访问 deb.debian.org 与 openresty.org。

```bash
docker compose -f compose.e2e.yml up -d --build
pnpm e2e
```

| 参数 | 作用 |
| --- | --- |
| `--up` | 先执行 `docker compose -f compose.e2e.yml up -d --build` |
| `--down` | 结束时执行 `docker compose -f compose.e2e.yml --profile '*' down -v`，连同 profile 服务及其卷一起删除 |
| `--skip-ui` | 跳过 Playwright 浏览器测试 |
| `--only <分段,…>` | 只运行列出的分段，以及新环境上它们依赖的分段 |
| `--from <分段>` | 从该分段运行到最后 |
| `--list` | 列出分段及各自依赖的分段 |
| `--plan` | 输出本次将运行的分段后退出 |
| `--serial` | 不使用并行通道，全部分段依次运行 |

参数写在脚本后：`bash scripts/e2e.sh --up --down`；未知参数以 2 退出。新环境先运行 `core` 分段；已通过 `core` 的环境上，运行从中断处继续（`.e2e/run.env`、`.e2e/run.done`）。每个分段的耗时在结束时输出，并写入 `.e2e/timings.tsv`。

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `COMPOSE_PROJECT_NAME` | `edgeweir-e2e` | Compose 项目名 |
| `E2E_CONSOLE_PORT` | `13000` | 控制台宿主机端口 |
| `E2E_NODE_PORT` | `18080` | 节点 HTTP 宿主机端口 |
| `E2E_NODE_TLS_PORT` | `18443` | 节点 HTTPS 宿主机端口（TCP、UDP） |
| `E2E_TAG` | `e2e` | 构建镜像的 tag |
| `E2E_SUBNET` | `172.28.213.0/24` | 默认网络子网；脚本将其加入源站地址允许清单 |
| `E2E_ISOLATED_SUBNET` | `172.28.214.0/24` | 隔离网络子网；保持在允许清单之外 |
| `E2E_INSTALL_IMAGE` | `debian:bookworm-slim@sha256:…` | 测试 `install.sh` 的干净系统镜像 |
| `E2E_ANALYTICS` | `lite` | 控制台的 `EDGEWEIR_ANALYTICS` |
| `E2E_STATS_INTERVAL` | `5s` | 测试节点的统计上报间隔 |
| `E2E_CLICKHOUSE_PORT` | `19123` | ClickHouse HTTP 端口，绑定 `127.0.0.1` |
| `E2E_ACME_PORT` | `14000` | Pebble ACME 端口，绑定 `127.0.0.1` |
| `E2E_ACME_MGMT_PORT` | `15000` | Pebble 管理端口，绑定 `127.0.0.1` |
| `E2E_MOCK_PORT` | `19090` | 模拟服务端口 |
| `EDGEWEIR_NODE_CONTEXT` | `../edgeweir-node` | edgeweir-node 源码目录 |

同一台机器运行第二套环境时，更改 `COMPOSE_PROJECT_NAME`、各端口、`E2E_TAG`、`E2E_SUBNET` 与 `E2E_ISOLATED_SUBNET`。
