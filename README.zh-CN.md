# Edgeweir

[English](README.md) | 简体中文

Edgeweir 是开源、自托管的 CDN 控制台与边缘节点系统，统一管理节点、源站池、缓存、HTTPS 和组织权限。这个项目希望让 CDN 的信任建立在可检查的证据上：源码可读，配置变更有审计，节点回执可核对，发布物可以独立验签。

控制面绝不保存 SSH 凭据；节点身份私钥留在节点本机；证书私钥和源站密钥加密后入库。核心没有官方回连和许可证校验。这些设计针对具体风险，不代表系统不可能被攻破。

## 名字的由来

Edgeweir（读作 EDGE-weer）的名字来自「堰」（weir）。公元前 256 年前后，李冰主持修建都江堰，其中的飞沙堰位于内江的边缘：平时它让江水顺畅流向宝瓶口，灌溉成都平原；洪水来时，弯道环流把泥沙和多余的水甩过堰顶、排回外江。Edgeweir 想在网络的边缘做同样的事：放行正常流量，筛掉攻击，按需调度分流。

## 当前状态

**MVP 功能已实现并通过本地验收，仍处于预发布阶段，尚无正式二进制发布。**

| 领域 | 已提供 |
| --- | --- |
| 集群与权限 | 节点组、区域、组织、邀请、2FA / Passkey、管理审计 |
| 源站与缓存 | 源站池、回源 TLS 校验、S3 签名、WebSocket、缓存键、切片、刷新与预热 |
| 证书与协议 | 上传、ACME HTTP-01 / DNS-01、续期、HTTPS、HSTS、HTTP/2 与 HTTP/3 |
| 策略 | 组织 / 平台 IP 名单、本地 GeoIP、分阶段规则、WAF、限速、重定向、改写及头部变换 |
| DNS 与观测 | 域名归属、独立 DNS 版本、健康节点调度、统计去重与汇总、Top URL/IP、告警及订阅 |
| 运维 | 采样日志与 CSV、可选 ClickHouse、只读及可吊销 AccessKey、签名灰度升级与回滚、性能基线、备份恢复 |

验收使用真实 OpenResty 节点、PostgreSQL、Pebble、ClickHouse、本地 DNS 和通知模拟服务，并覆盖浏览器流程。升级测试用本地临时密钥签署真实 Linux 归档，验证错误密钥签名拒绝，以及已签名坏程序启动失败后的回滚。恢复测试执行真实 pg_dump / pg_restore，并证明恢复后仍可向已应用更高 revision 的节点发布配置。见[实现证据](docs/implementation/mvp-completion.md)、[MVP 规格](docs/specs/mvp.md)及[控制面 CI](https://github.com/marvinli001/edgeweir/actions/workflows/ci.yml) / [节点 CI](https://github.com/marvinli001/edgeweir-node/actions/workflows/ci.yml)。

真实 DNS 服务商、ZeroSSL EAB 和外部通知账户仍需按运维方自己的凭据验收。所选原版引擎不含 Brotli / Zstd；正式 GitHub OIDC 签名二进制尚未发布和验收，当前请从源码构建评估。这里提供可复现的证据，不作线上可靠性或绝对安全保证。

指南：[HTTPS](docs/guide/https.md) · [规则](docs/guide/rules.md) · [DNS 与告警](docs/guide/dns-and-alerts.md) · [日志与 AccessKey](docs/guide/access-logs.md) · [节点升级](docs/guide/node-upgrades.md) · [备份恢复](docs/deploy/backup.md)。

## 组成

| 仓库 | 内容 |
| --- | --- |
| [edgeweir](https://github.com/marvinli001/edgeweir)（本仓库） | 控制台：Web UI、管理 API（含对外的 OpenAPI `/api/v1`）和节点通道，一个 Node.js 进程、一个镜像。镜像里另有 `edgeweir-certd`，处理 ACME 证书和 DNS 记录的 Go helper；由 pg-boss 通过有界 stdin/stdout 协议调用，凭据不出现在进程参数中。 |
| [edgeweir-node](https://github.com/marvinli001/edgeweir-node) | 边缘节点：`edgeweir-node` Go agent 加 OpenResty。 |

```
浏览器、API 调用方 ─:3000──▶ ┌───────────────────────────────────┐
                             │ 控制台（一个 Node.js 进程）       │── PostgreSQL 18（唯一依赖）
                             │   UI · /rpc · /api/v1             │
                             │   节点通道 :8443（mTLS）          │
                             │   pg-boss worker                  │
                             └────────────────▲──────────────────┘
                                              │ Connect-RPC over mTLS
                             ┌────────────────┴──────────────────┐
             终端用户 ─────▶ │ 边缘节点：edgeweir-node agent     │──▶ 源站
                             │           + OpenResty             │
                             └───────────────────────────────────┘
```

发布镜像命名空间为 `ghcr.io/marvinli001/edgeweir` 和 `ghcr.io/marvinli001/edgeweir-node`。当前工作流没有发布 Docker Hub 镜像副本。

## 快速开始（Docker）

需要 Docker 和 Compose v2。

```sh
git clone https://github.com/marvinli001/edgeweir.git
cd edgeweir

# 必填密钥，Compose 从 .env 读取；openssl 的输出原样使用
umask 077
cat > .env <<EOF
EDGEWEIR_MASTER_KEY=$(openssl rand -base64 32)
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
EOF

docker compose up -d --build
```

打开 <http://localhost:3000>（所有变量的说明见 [.env.example](.env.example)），首次初始化向导会创建平台管理员和默认组织。向导需要控制台打印在日志里的一次性 setup token（`docker compose logs console | grep setupToken`）。

- `EDGEWEIR_MASTER_KEY` 用于加密入库的敏感数据（内部 CA 私钥、S3 源站密钥、setup token、证书私钥和 DNS API 凭据）。**请把它与数据库备份分开保存。** 丢失后这些数据无法恢复。
- `BETTER_AUTH_SECRET` 用于签名登录会话。
- 没有 setup token 的初始化请求会被拒绝，所以在你完成向导之前，别人无法抢先创建管理员。token 在第一次初始化成功后作废。

`EDGEWEIR_ANALYTICS=clickhouse` 配合 `analytics` Compose profile 启用可选 ClickHouse 原始日志与分钟统计。访问日志采样默认关闭，保留 7 天；控制台图表和告警共用 PostgreSQL 汇总。`cache` profile 启动 Valkey，控制台目前尚未使用。见[日志与 AccessKey](docs/guide/access-logs.md)及[备份恢复](docs/deploy/backup.md)。

端口：

| 端口 | 用途 | 能否放在反向代理后面 |
| --- | --- | --- |
| 3000 | Web 控制台与 API | 可以。宝塔 nginx 等代理可以在前面终结 TLS。把代理的地址写进 `EDGEWEIR_TRUSTED_PROXIES`，审计日志和登录限速才能拿到访客 IP；其他来源的转发头一律忽略。 |
| 8443 | 节点通道 | 直接暴露，或用 nginx `stream` 做四层透传。**不能由代理终结 TLS**：控制台自己终结 TLS 并强制 mTLS。 |

部署文档：[docs/deploy/docker.md](docs/deploy/docker.md)、[docs/deploy/baota.md](docs/deploy/baota.md)（宝塔面板）。

## 添加节点

以下签名安装流程在正式发布后适用。当前预发布阶段请先[从源码构建节点](https://github.com/marvinli001/edgeweir-node#build-and-test)评估。

1. 以平台管理员登录，在顶栏切换到**后台**，打开**集群与节点**，选择集群，生成一次性安装命令。命令中包含一次性 token 和控制台内部 CA 的 SHA-256 指纹。
2. 在节点上用有 sudo 权限的账号执行该命令（使用 systemd 的 Linux，amd64 或 arm64）。节点需要能访问控制台的 8443 端口。

   ```sh
   export EDGEWEIR_TOKEN='<一次性token>'
   curl -fsSL https://<控制台>/install.sh | sudo --preserve-env=EDGEWEIR_TOKEN bash -s -- \
     --server https://<控制台>:8443 --ca-sha256 <CA指纹>
   ```

   token 只经 `EDGEWEIR_TOKEN` 环境变量（或 `--token-file` 指定的文件）传递，不作为命令行参数出现，`ps` 看不到。
3. 安装脚本在安装或执行任何东西之前，先校验发布物 checksums 的 cosign 签名（证书必须是 edgeweir-node 的 release 工作流、且正是要安装的版本 tag），再校验每个包的 SHA-256。能用 .deb 或 .rpm 时装包，否则用 tar.gz。配置了控制台的 `/downloads` 镜像时从镜像下载，否则从 GitHub Releases 下载。agent 先核对 CA 指纹再发送 token，在本地生成私钥，此后只通过 mTLS 与控制台通信。
4. 控制台中显示节点在线，以及它已应用的配置 revision。

详见 [ADR-0008](docs/adr/0008-node-channel-connect-rpc-mtls.md) 和 [ADR-0016](docs/adr/0016-one-line-install.md)。

## 开发

需要 Node.js 24+、pnpm 12、Docker。修改 `helpers/certd` 和运行 `pnpm e2e` 需要 Go 1.27.1。buf 随开发依赖安装（`pnpm lint` 会运行它）。

```sh
pnpm install
docker compose -f compose.dev.yml up -d   # 本地 PostgreSQL
cp .env.example .env                      # 填写 EDGEWEIR_MASTER_KEY 和 BETTER_AUTH_SECRET
pnpm dev
```

`pnpm dev` 启动单个进程：在 <http://localhost:3000> 提供 UI 和 API，在 `:8443` 提供节点通道。

| 命令 | 作用 |
| --- | --- |
| `pnpm lint` | Biome lint 与格式检查，另跑 `buf lint` |
| `pnpm typecheck` | 全 workspace 的 TypeScript 类型检查 |
| `pnpm test` | 单元与集成测试（Vitest；PostgreSQL 用进程内的 PGlite，不需要 Docker） |
| `pnpm build` | 生产构建 |
| `pnpm proto:lint` | 用 buf 检查 `proto/` |
| `pnpm proto:gen` | 从 `proto/` 重新生成 TypeScript 到 `packages/proto` |
| `pnpm db:generate` | 根据 `packages/db/src/schema` 的改动生成 SQL 迁移 |
| `pnpm e2e` | 针对 `compose.e2e.yml` 的端到端测试（见[端到端测试](#端到端测试)） |

### 端到端测试

`pnpm e2e` 运行 `scripts/e2e.sh`，对象是一套全新的 `compose.e2e.yml` 环境（PostgreSQL、控制台、由 edgeweir-node 构建的一个边缘节点、测试源站）：

```sh
docker compose -f compose.e2e.yml up -d --build
pnpm e2e     # --up 先启动环境，--down 结束后删除环境及其卷，--skip-ui 跳过 Playwright
```

除 curl、jq、Docker 和 Node.js 外，需要本仓库旁边的 edgeweir-node 检出（或用 `EDGEWEIR_NODE_CONTEXT` 指定）；安装步骤还需要宿主机上的 goreleaser v2、syft、cosign 和 Go 1.27.1，并能访问 deb.debian.org 和 openresty.org。除注册、配置下发、缓存、刷新预热、源站、S3、故障切换和 Playwright 用例外，它还检查认证路由白名单（better-auth 的组织与管理端点关闭，API Key 不会变成会话）、源站地址策略与 CDN-Loop、HTTPS 源站的名称校验、1 MiB 分片的 Range 请求，以及 `install.sh` 在干净容器里从控制台镜像安装 goreleaser snapshot 包。

`compose.e2e.yml` 和 `scripts/e2e.sh` 读取下列变量，两边要给相同的值。换一组项目名、端口、tag 和子网，就能在旁边再跑一套环境。

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `COMPOSE_PROJECT_NAME` | `edgeweir-e2e` | Compose 项目名，也用于命名安装容器 |
| `E2E_CONSOLE_PORT` | `13000` | 控制台的宿主机端口 |
| `E2E_NODE_PORT` | `18080` | 节点 HTTP 的宿主机端口 |
| `E2E_TAG` | `e2e` | 控制台和节点镜像的 tag |
| `E2E_SUBNET` | `172.28.213.0/24` | 默认网络，加入源站允许清单 |
| `E2E_ISOLATED_SUBNET` | `172.28.214.0/24` | 允许清单之外的网络（其中的源站必须被拒绝） |
| `E2E_INSTALL_IMAGE` | `debian:bookworm-slim` | 运行 `install.sh` 的干净机器 |
| `EDGEWEIR_NODE_CONTEXT` | `../edgeweir-node` | edgeweir-node 检出目录 |

提交规范、proto 变更流程和 i18n 规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 目录结构

```
apps/console/              控制台：一个应用包、一个进程
  src/server/              Hono 服务端：API、认证、节点通道、worker
  src/web/                 React SPA
packages/db/               Drizzle schema 与 SQL 迁移
packages/contract/         oRPC 契约与 zod schema
packages/config-compiler/  数据库模型 → NodeConfig IR
packages/proto/            由 proto/ 生成的 TypeScript
proto/                     buf 管理的 protobuf，与 edgeweir-node 共享的唯一契约来源
helpers/certd/             edgeweir-certd（Go）：lego 负责 ACME，libdns 及适配器负责 DNS 记录
scripts/e2e.sh             端到端测试脚本
docs/adr/                  架构决策记录
docs/specs/                MVP 规格
docs/guide/                行为说明（源站与缓存）
docs/deploy/               部署文档
```

## 文档

- [ARCHITECTURE.md](ARCHITECTURE.md)：整体架构
- [docs/adr/](docs/adr/README.md)：架构决策记录
- [ROADMAP.md](ROADMAP.md)：MVP、v1、v2 功能规划；[docs/specs/mvp.md](docs/specs/mvp.md)：MVP 各里程碑
- [docs/guide/origins-and-cache.md](docs/guide/origins-and-cache.md)：源站池、缓存规则、刷新与预热
- [SECURITY.md](SECURITY.md)：信任基线、漏洞报告、发布物校验
- [CONTRIBUTING.md](CONTRIBUTING.md)：贡献指南
- [云端开发](docs/development/cloud.md)：Claude 云端检出的准备与验证边界
- [HTTPS 与证书](docs/guide/https.md)：签发、续期与协议限制

## 许可证

[AGPL-3.0-only](LICENSE)。[edgeweir-node](https://github.com/marvinli001/edgeweir-node) 使用相同的许可证。
