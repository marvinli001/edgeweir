# 命令行

`deploy.sh`、节点安装脚本 `install.sh`、Docker Compose 运维命令、容器入口、找回账户与开发命令。

## deploy.sh

宝塔 / aaPanel 编排部署的安装与运维脚本。用法：`./deploy.sh <命令>`。

| 命令 | 作用 |
| --- | --- |
| `install` | 对话式安装：选择数据库方式、生成 `.env`、启动 |
| `update [tag]` | 备份后升级到最新版本或指定 tag；`--no-backup` 跳过备份。别名 `upgrade` |
| `backup` | 备份数据库、`.env`（不含主密钥）和编排文件到 `backups/`，保留最近 5 份 |
| `restore <备份>` | 先备份当前数据库，再用备份中的 `edgeweir.dump` 替换数据库；`.env` 不变，`--no-backup` 跳过备份 |
| `config` | 修改控制台地址和节点通道地址 |
| `start`、`stop` | 启动（应用 `.env` 的修改）、停止 |
| `restart` | 重建控制台容器并启动，应用 `.env` 的修改 |
| `status` | 容器状态和运行中的版本 |
| `logs [服务]` | 跟随日志，服务为 `console` 或 `postgres` |
| `setup-token` | 输出首次初始化的 setup token |
| `template <host\|bundled>` | 输出编排模板，用于在面板中手动粘贴 |
| `self-update` | 用当前镜像附带的 `deploy.sh` 更新脚本本身；镜像未附带时取 GitHub 上的版本 |
| `help` | 输出用法 |

参数、无人值守变量、写入的文件、备份结构与退出行为见 [deploy.sh 参考](../deploy/deploy-script.md)。

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
| `--server` | URL | 必需 | 节点通道 URL，须为 `https://`。 |
| `--ca-sha256` | HEX | 必需 | 控制台节点 CA 的 SHA-256 指纹，64 位小写十六进制；注册时固定。 |
| `--token-file` | PATH | 无 | 从文件读取注册 token（去除空白），优先于 `EDGEWEIR_TOKEN`。 |
| `--version` | VER | `latest` | 安装的 edgeweir-node 版本，语义化版本，可带 `v` 前缀。`latest` 依次从镜像的 `latest` 文件、GitHub 最新发布解析。 |
| `--format` | `auto`\|`deb`\|`rpm`\|`tar` | `auto` | 安装包格式。`auto`：有 `dpkg` 与 `apt-get` 时用 deb；有 `rpm` 与 `dnf` 或 `yum` 时用 rpm；否则用 tar。 |
| `--mirror` | URL | `<控制台>/downloads/edgeweir-node` | edgeweir-node 发布镜像，文件位于 `URL/latest`、`URL/v<版本>/<文件>`；cosign 取自同级的 `cosign/v<版本>/`。每个文件先从镜像下载，失败后从 GitHub 下载。 |
| `--mirror-only` | 无 | 关 | 不回退到 GitHub。 |
| `--no-modsecurity` | 无 | 关 | 不安装 `edgeweir-openresty-modsecurity`：该节点不支持 OWASP CRS。 |
| `--no-start` | 无 | 关 | 只安装和注册：不要求 systemd，不启用、不启动服务。 |
| `--force` | 无 | 关 | 已注册的主机重新注册（需要新的 token）：停止 `edgeweir-node`，替换身份后再启动。 |
| `--allow-unsigned` | 无 | 关 | 跳过 cosign 签名校验，仅限开发；仍校验 SHA-256。 |
| `-h`、`--help` | 无 | 无 | 输出用法。 |

| 环境变量 | 作用 |
| --- | --- |
| `EDGEWEIR_TOKEN` | 一次性注册 token，格式 `ewt_…`。脚本读取后从环境中移除，其他子进程不继承；经环境变量传给 `edgeweir-node enroll`。 |

`--token` 与 `--token=…` 被拒绝：命令行参数在进程列表中可见。

### 校验

| 对象 | 校验 |
| --- | --- |
| `checksums.txt` | cosign 无密钥签名（`checksums.txt.sigstore.json`）。证书身份：`https://github.com/marvinli001/edgeweir-node/.github/workflows/release.yml@refs/tags/v<版本>`；OIDC 签发者：`https://token.actions.githubusercontent.com` |
| 安装包 | SHA-256，与已签名的 `checksums.txt` 比对 |
| cosign | 机器上没有 cosign 时下载 v3.1.3，按脚本内置的 SHA-256 核对 |

校验通过前不执行任何下载内容。系统要求、执行流程与安装结果见[接入节点](../deploy/nodes.md#installsh-流程)。

### 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 安装与注册完成 |
| `1` | 任一检查或步骤失败；stderr 输出 `[edgeweir] error:` 与原因 |
| `2` | 缺少 `--server` 或 `--ca-sha256`，或指定了 `-h`、`--help` |

脚本不提供升级与卸载。节点升级见[节点升级](../guide/node-upgrades.md)。

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
| 找回账户（重置密码、停用两步验证） | `docker compose exec console node dist/server/recover.js --reset-password --disable-two-factor`，见 [找回账户](#找回账户) |
| 拉取 `EDGEWEIR_VERSION` 指定的镜像并重建 | `docker compose pull && docker compose up -d` |
| 启动 ClickHouse | `docker compose --profile analytics up -d` |

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
| 健康检查 | `edgeweir-healthcheck`；间隔 10 秒，超时 3 秒，启动期 30 秒，重试 5 次 |
| 附带文件 | `/usr/local/bin/edgeweir-certd`、`/usr/local/bin/edgeweir-healthcheck`、`/app/deploy.sh` |
| 停止信号 | `SIGTERM`、`SIGINT`：关闭 HTTP 与节点通道监听并结束节点的监视流，进行中的请求最多 3 秒，同时等待 pg-boss 最多 5 秒，进程以 0 退出；超过 8 秒以 1 退出 |

`edgeweir-healthcheck`：`ROLE=worker` 时直接返回 0；其他角色请求 `http://127.0.0.1:${PORT}/healthz`，超时 2 秒，失败返回非 0。

镜像的环境变量默认值见[环境变量](environment.md#运行时)。

### ROLE

取值 `all`（默认）、`app`、`worker`。各角色运行的组件、监听端口与扩展方式见[部署概览](../deploy/README.md#进程角色)。

## 找回账户

`dist/server/recover.js` 为控制台唯一的账户重置密码、停用两步验证，用于无法登录时。它读取与控制台相同的环境变量（`DATABASE_URL`、`EDGEWEIR_MASTER_KEY` 等），直接修改数据库，不经过 Web 界面与 HTTP。步骤见 [找回账户](../guide/account.md#找回账户)。

```bash
docker compose exec console node dist/server/recover.js --reset-password --disable-two-factor
```

| 部署 | 命令 |
| --- | --- |
| Docker Compose | `docker compose exec console node dist/server/recover.js <选项>` |
| Docker Compose，控制台容器未运行 | `docker compose run --rm console node dist/server/recover.js <选项>` |
| 宝塔 / aaPanel（`deploy.sh`） | `docker exec -it edgeweir-console node dist/server/recover.js <选项>` |
| 源码（`pnpm dev`） | `pnpm --filter @edgeweir/console recover <选项>`，见 [命令](#命令) |

### 选项

| 选项 | 作用 |
| --- | --- |
| `--reset-password` | 设置新密码，12–128 字符 |
| `--disable-two-factor` | 停用两步验证，删除 TOTP 密钥与备用码 |
| `-h`、`--help` | 输出用法 |

至少指定 `--reset-password`、`--disable-two-factor` 之一。

### 新密码

| 标准输入 | 读取方式 |
| --- | --- |
| 终端（`docker compose exec` 与 `docker exec -it` 默认分配） | 提示 `New password:` 与 `Repeat new password:`，输入不回显；两次不一致时不做修改。Ctrl-C 取消 |
| 管道或文件 | 第一行，去掉行尾的 `\n` 或 `\r\n` |

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
| 会话 | 删除该账户的全部会话，以及尚未完成两步验证的登录与受信任设备记录 |
| 审计日志 | `account.recover`，操作者为系统（名称 `recover`）；元数据 `passwordReset`、`twoFactorDisabled`、`sessionsRevoked` |

姓名、邮箱、通行密钥与 AccessKey 不变。标准输出为账户的姓名与邮箱和完成的操作，不含密码、密码哈希或会话 token：

```text
Account: Ops <admin@example.com>
Password reset.
Two-factor authentication turned off.
Signed out 2 sessions.
```

### 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 完成，或指定了 `-h`、`--help` |
| `1` | 未做修改：没有账户（尚未初始化）、密码长度不符、两次输入不一致、已取消、配置无效、数据库连接或写入失败；stderr 输出 `error:` 与原因 |
| `2` | 未知选项、多余参数或未指定操作；stderr 输出用法 |

## 开发

要求：Node.js 24.11.0 及以上、pnpm 12.6.0、Docker；`helpers/certd` 与 `pnpm e2e` 另需 Go 1.27.1。buf 随开发依赖安装。

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
| `pnpm lint` | `biome check .` 与 `buf lint proto` |
| `pnpm format` | `biome check --write .` |
| `pnpm proto:lint` | `buf lint proto` |
| `pnpm proto:gen` | 由 `proto/` 生成 `packages/proto/src/gen` |
| `pnpm db:generate` | 由 `packages/db/src/schema` 生成 SQL 迁移到 `packages/db/migrations`（drizzle-kit） |
| `pnpm e2e` | 运行 `scripts/e2e.sh` |
| `pnpm --filter @edgeweir/console start` | 运行已构建的 `dist/server/main.js` |
| `pnpm --filter @edgeweir/console recover <选项>` | 从源码运行 [找回账户](#找回账户) 命令；读取仓库根目录的 `.env`（存在时）。选项前不加 `--` |
| `pnpm --filter @edgeweir/console test:e2e` | Playwright 测试 |

### 端到端测试

`scripts/e2e.sh` 针对 `compose.e2e.yml` 运行。需要 `curl`、`jq`、`docker`、`node`；安装脚本步骤另需 goreleaser v2、syft、Go 1.27.1 与同级的 `edgeweir-node` 源码，签名升级步骤需要 cosign v3.1.3；运行时需要访问 deb.debian.org 与 openresty.org。

```bash
docker compose -f compose.e2e.yml up -d --build
pnpm e2e
```

| 参数 | 作用 |
| --- | --- |
| `--up` | 先执行 `docker compose -f compose.e2e.yml up -d --build` |
| `--down` | 结束时执行 `docker compose -f compose.e2e.yml --profile '*' down -v`，连同 profile 服务（ClickHouse、升级测试节点、区域探针）及其卷一起删除 |
| `--skip-ui` | 跳过 Playwright 浏览器测试 |

参数写在脚本后：`bash scripts/e2e.sh --up --down`。

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
| `E2E_CLICKHOUSE_PORT` | `19123` | ClickHouse HTTP 端口，绑定 `127.0.0.1` |
| `E2E_ACME_PORT` | `14000` | Pebble ACME 端口，绑定 `127.0.0.1` |
| `E2E_ACME_MGMT_PORT` | `15000` | Pebble 管理端口，绑定 `127.0.0.1` |
| `E2E_MOCK_PORT` | `19090` | 模拟服务端口 |
| `EDGEWEIR_NODE_CONTEXT` | `../edgeweir-node` | edgeweir-node 源码目录 |

同一台机器运行第二套环境时，更改 `COMPOSE_PROJECT_NAME`、各端口、`E2E_TAG`、`E2E_SUBNET` 与 `E2E_ISOLATED_SUBNET`。
