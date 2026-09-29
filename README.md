# Edgeweir

简体中文 | [English](README.en.md)

[![CI](https://github.com/marvinli001/edgeweir/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/marvinli001/edgeweir/actions/workflows/ci.yml)
[![Docs](https://github.com/marvinli001/edgeweir/actions/workflows/docs.yml/badge.svg?branch=master)](https://marvinli001.github.io/edgeweir/zh/)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](LICENSE)

自托管的 CDN / WAF / 边缘调度控制平面。统一管理边缘节点、源站池、缓存、HTTPS、访问策略、DNS 调度与组织权限。边缘节点见 [edgeweir-node](https://github.com/marvinli001/edgeweir-node)。

文档：<https://marvinli001.github.io/edgeweir/zh/>

## 功能

| 领域 | 能力 |
| --- | --- |
| 集群与权限 | 节点组、区域、组织、成员邀请、2FA / Passkey、管理审计 |
| 源站与缓存 | 源站池、回源 TLS 校验、S3 签名回源、WebSocket、缓存键、切片、刷新与预热 |
| 证书与协议 | 证书上传、ACME HTTP-01 / DNS-01 签发与续期、HTTPS、HSTS、HTTP/2、HTTP/3 |
| 访问策略 | 组织 / 平台 IP 名单、本地 GeoIP、分阶段规则、WAF、限速、重定向、改写、请求头与响应头变换 |
| DNS 与观测 | 域名归属验证、独立 DNS 版本、健康节点调度、流量统计去重与汇总、Top URL / IP、告警与订阅 |
| 运维 | 采样访问日志与 CSV 导出、可选 ClickHouse、只读及可吊销 AccessKey、签名灰度升级与回滚、性能基线、备份恢复 |

## 架构

| 仓库 | 组成 |
| --- | --- |
| [edgeweir](https://github.com/marvinli001/edgeweir)（本仓库） | 控制台：Web UI、管理 API（含 OpenAPI `/api/v1`）、节点通道、pg-boss worker，单进程、单镜像。镜像内含 `edgeweir-certd`（Go），负责 ACME 证书签发与 DNS 记录管理，由 pg-boss 经有界 stdin/stdout 协议调用，凭据不经进程参数传递。 |
| [edgeweir-node](https://github.com/marvinli001/edgeweir-node) | 边缘节点：`edgeweir-node` Go agent 与 OpenResty 数据面。 |

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

控制台与节点之间的唯一契约为 `proto/` 中的 protobuf（buf 管理）。设计细节见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 安全基线

- 控制台不保存 SSH 凭据。
- 节点私钥在节点本机生成与保存，不离开节点。
- 内部 CA 私钥、证书私钥、S3 源站密钥、DNS API 凭据经 `EDGEWEIR_MASTER_KEY` 信封加密后入库，密文与所属记录绑定。
- 节点注册 token 单次有效，仅存储 SHA-256；注册完成后节点 RPC 一律使用 mTLS。
- `/api/v1` 仅接受 `x-api-key`；`/rpc` 仅接受会话 Cookie 与 CSRF 请求头。
- 无厂商回连，无许可证校验；遥测默认关闭，第三方依赖的遥测强制关闭。

信任基线、漏洞报告与发布物校验见 [SECURITY.md](SECURITY.md)。

## 发布

| 制品 | 地址 | 版本规则 |
| --- | --- | --- |
| 控制台镜像 | `ghcr.io/marvinli001/edgeweir`（amd64 / arm64） | 滚动发布：`master` 上通过 CI 的提交发布为 `<YYYYMMDD>-<commit>`（如 `20260929-a1b2c3d`），`latest` 指向最新提交；不使用语义化版本号。镜像经 cosign keyless 签名。 |
| 边缘节点 | [edgeweir-node Releases](https://github.com/marvinli001/edgeweir-node/releases) | 签名 Release，版本号 `vX.Y.Z`。 |

生产环境通过 `EDGEWEIR_VERSION` 固定日期 tag。

## 快速开始

环境要求：Docker、Compose v2。

```sh
git clone https://github.com/marvinli001/edgeweir.git
cd edgeweir

umask 077
cat > .env <<EOF
EDGEWEIR_MASTER_KEY=$(openssl rand -base64 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
EOF

docker compose pull        # 从源码构建：docker compose up -d --build
docker compose up -d
docker compose logs console | grep setupToken
```

访问 <http://localhost:3000>，使用日志中的一次性 setup token 完成初始化向导，创建平台管理员与默认组织。setup token 在首次初始化成功后失效；无 token 的初始化请求一律拒绝。

### 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `EDGEWEIR_MASTER_KEY` | 是 | 主密钥，用于信封加密入库的敏感数据（内部 CA 私钥、证书私钥、S3 源站密钥、DNS API 凭据、setup token）并派生会话密钥。**须与数据库备份分开保存，丢失后上述数据不可恢复。** |
| `POSTGRES_PASSWORD` | 是 | 内置 PostgreSQL 密码。 |
| `BETTER_AUTH_SECRET` | 否 | 未设置时由主密钥派生。已设置的部署不得移除，否则控制台拒绝启动。 |

其余变量均有默认值，完整列表见 [.env.example](.env.example)。SMTP、节点发布源、域名归属校验 DNS、源站地址允许清单与 GeoIP 在初始化后于 **后台 → 系统设置** 配置。

### 可选组件

| Compose profile | 组件 | 说明 |
| --- | --- | --- |
| `analytics` | ClickHouse | 配合 `EDGEWEIR_ANALYTICS=clickhouse` 启用原始访问日志与分钟级统计。访问日志采样默认关闭，保留 7 天。控制台图表与告警使用 PostgreSQL 汇总数据。 |
| `cache` | Valkey | 控制台目前未使用。 |

详见 [访问日志与 AccessKey](docs/guide/access-logs.md)、[备份与恢复](docs/deploy/backup.md)。

### 端口

| 端口 | 用途 | 反向代理 |
| --- | --- | --- |
| 3000 | Web 控制台与 API | 支持在前端终结 TLS（如宝塔 nginx）。须将代理地址写入 `EDGEWEIR_TRUSTED_PROXIES`，否则审计日志与登录限速取不到真实客户端 IP；其他来源的转发头一律忽略。 |
| 8443 | 节点通道 | 直接暴露，或经 nginx `stream` 四层透传。**禁止由代理终结 TLS**：控制台自行终结 TLS 并强制 mTLS。 |

### 部署方式

| 平台 | 文档 |
| --- | --- |
| Docker Compose / `docker run` | [Docker Compose 部署](docs/deploy/docker.md) |
| 宝塔面板 / aaPanel | [宝塔面板 / aaPanel](docs/deploy/baota.md)、[deploy.sh 参考](docs/deploy/deploy-script.md) |
| Railway | [Railway](docs/deploy/railway.md) |
| Fly.io | [Fly.io](docs/deploy/fly.md) |

交互式安装与升级脚本 `deploy.sh` 适用于任何装有 Docker 与 Compose v2 的 Linux，支持本机、云端或内置 PostgreSQL：

```sh
curl -fsSL -o deploy.sh https://raw.githubusercontent.com/marvinli001/edgeweir/master/deploy.sh
sudo bash deploy.sh install
```

## 接入节点

节点要求：Linux（systemd），amd64 / arm64，可访问控制台 8443 端口。

1. 以平台管理员登录，切换至 **后台 → 集群与节点**，选择集群并生成安装命令。命令包含单次有效 token 与控制台内部 CA 的 SHA-256 指纹。
2. 在节点上以具备 sudo 权限的账户执行：

   ```sh
   export EDGEWEIR_TOKEN='<一次性 token>'
   curl -fsSL https://<控制台>/install.sh | sudo --preserve-env=EDGEWEIR_TOKEN bash -s -- \
     --server https://<控制台>:8443 --ca-sha256 <CA 指纹>
   ```

3. 节点上线后，控制台显示其在线状态与已应用的配置 revision。

安装脚本行为：

- token 仅经 `EDGEWEIR_TOKEN` 环境变量或 `--token-file` 传递，不出现在进程参数中。
- 安装前校验 checksums 的 cosign 签名（签发身份须为 edgeweir-node release 工作流及待安装的 tag）与每个包的 SHA-256。
- 优先安装 .deb / .rpm，否则使用 tar.gz；配置了控制台 `/downloads` 镜像时从镜像下载，否则从 GitHub Releases 下载。
- agent 先核对 CA 指纹再提交 token，本地生成私钥，此后仅经 mTLS 与控制台通信。

安装参数与发布物镜像见[接入节点](docs/deploy/nodes.md)。

## API

| 入口 | 认证 | 用途 |
| --- | --- | --- |
| `/api/v1` | AccessKey（`x-api-key` 请求头） | 对外 OpenAPI，规范文档位于 `/api/v1/openapi.json` |
| `/rpc` | 会话 Cookie + CSRF 请求头 | Web UI 专用 |

两个入口由 `packages/contract` 中的同一份 oRPC 契约提供。

## 开发

环境要求：Node.js 24+、pnpm 12、Docker。`helpers/certd` 与 `pnpm e2e` 另需 Go 1.27.1。buf 随开发依赖安装。

```sh
pnpm install
docker compose -f compose.dev.yml up -d   # 本地 PostgreSQL
cp .env.example .env                      # 填写 EDGEWEIR_MASTER_KEY
pnpm dev                                  # UI 与 API :3000，节点通道 :8443
```

| 命令 | 作用 |
| --- | --- |
| `pnpm lint` | Biome 检查与格式校验、`buf lint` |
| `pnpm typecheck` | 全 workspace TypeScript 类型检查 |
| `pnpm test` | 单元与集成测试（Vitest，PostgreSQL 由进程内 PGlite 提供，无需 Docker） |
| `pnpm build` | 生产构建 |
| `pnpm proto:lint` | 检查 `proto/` |
| `pnpm proto:gen` | 由 `proto/` 生成 TypeScript 至 `packages/proto` |
| `pnpm db:generate` | 由 `packages/db/src/schema` 的变更生成 SQL 迁移 |
| `pnpm e2e` | 端到端测试，见[端到端测试](#端到端测试) |

提交规范、proto 变更流程与国际化规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。

### 端到端测试

```sh
docker compose -f compose.e2e.yml up -d --build
pnpm e2e     # --up 启动环境；--down 结束后删除环境与卷；--skip-ui 跳过 Playwright
```

依赖：

- curl、jq、Docker、Node.js
- 与本仓库同级的 edgeweir-node 检出（或 `EDGEWEIR_NODE_CONTEXT`）
- 安装步骤：goreleaser v2、syft、cosign、Go 1.27.1，以及对 deb.debian.org、openresty.org 的网络访问

覆盖范围：节点注册、配置下发、缓存、刷新与预热、源站与 S3、故障切换、认证路由白名单（better-auth 组织与管理端点关闭，API Key 不转换为会话）、源站地址策略与 CDN-Loop、HTTPS 源站名称校验、1 MiB 切片 Range 请求、`install.sh` 在干净容器中从控制台镜像安装、Playwright 页面流程。

以下变量由 `compose.e2e.yml` 与 `scripts/e2e.sh` 共同读取，两侧取值须一致。更换项目名、端口、tag 与子网即可并行运行第二套环境。

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `COMPOSE_PROJECT_NAME` | `edgeweir-e2e` | Compose 项目名，同时用于命名安装容器 |
| `E2E_CONSOLE_PORT` | `13000` | 控制台宿主机端口 |
| `E2E_NODE_PORT` | `18080` | 节点 HTTP 宿主机端口 |
| `E2E_TAG` | `e2e` | 控制台与节点镜像 tag |
| `E2E_SUBNET` | `172.28.213.0/24` | 默认网络，加入源站地址允许清单 |
| `E2E_ISOLATED_SUBNET` | `172.28.214.0/24` | 允许清单之外的网络，其中的源站须被拒绝 |
| `E2E_INSTALL_IMAGE` | `debian:bookworm-slim`（`scripts/e2e.sh` 中按 digest 固定） | 运行 `install.sh` 的干净环境 |
| `EDGEWEIR_NODE_CONTEXT` | `../edgeweir-node` | edgeweir-node 检出目录 |

## 已知限制

- 节点所用 OpenResty 原版引擎不含 Brotli / Zstd。

## 目录结构

```
apps/console/              控制台：单一应用包、单一进程
  src/server/              Hono 服务端：API、认证、节点通道、worker
  src/web/                 React SPA
packages/db/               Drizzle schema 与 SQL 迁移
packages/contract/         oRPC 契约与 zod schema
packages/config-compiler/  数据库模型 → NodeConfig IR
packages/proto/            由 proto/ 生成的 TypeScript
proto/                     protobuf（buf 管理），与 edgeweir-node 共享的唯一契约
helpers/certd/             edgeweir-certd（Go）：lego 负责 ACME，libdns 负责 DNS 记录
scripts/e2e.sh             端到端测试脚本
docs/deploy/               部署文档
docs/guide/                使用指南
docs/reference/            参考：环境变量、命令行、API
doc/                       文档站（Fumadocs），发布至 GitHub Pages
```

## 文档

文档站 <https://marvinli001.github.io/edgeweir/zh/> 由以下 Markdown 生成。每篇文档另有英文版 `*.en.md`。

| 分类 | 文档 |
| --- | --- |
| 部署 | [部署概览](docs/deploy/README.md) · [Docker Compose](docs/deploy/docker.md) · [宝塔 / aaPanel](docs/deploy/baota.md) · [deploy.sh](docs/deploy/deploy-script.md) · [Railway](docs/deploy/railway.md) · [Fly.io](docs/deploy/fly.md) · [端口与反向代理](docs/deploy/networking.md) · [接入节点](docs/deploy/nodes.md) · [版本与升级](docs/deploy/upgrade.md) · [备份与恢复](docs/deploy/backup.md) |
| 使用 | [快速上手](docs/guide/first-site.md) · [组织与成员](docs/guide/organizations.md) · [平台管理](docs/guide/admin.md) · [源站与缓存](docs/guide/origins-and-cache.md) · [HTTPS 与证书](docs/guide/https.md) · [规则](docs/guide/rules.md) · [DNS 与告警](docs/guide/dns-and-alerts.md) · [访问日志与 AccessKey](docs/guide/access-logs.md) · [节点升级](docs/guide/node-upgrades.md) |
| 参考 | [环境变量](docs/reference/environment.md) · [命令行](docs/reference/cli.md) · [API 与端点](docs/reference/api.md) |
| 项目 | [架构](ARCHITECTURE.md) · [安全](SECURITY.md) · [贡献指南](CONTRIBUTING.md) · [许可证](LICENSING.md) |

## 许可证

[AGPL-3.0-only](LICENSE)，[edgeweir-node](https://github.com/marvinli001/edgeweir-node) 相同。允许在遵守许可证的前提下商用。

组织、成员、权限、组织隔离及控制台与后台属于开源核心；客户门户、套餐计费、财务与分销由独立商业产品提供，不对开源核心附加使用限制。详见 [LICENSING.md](LICENSING.md)。
