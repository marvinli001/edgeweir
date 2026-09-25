# Edgeweir

[English](README.md) | 简体中文

Edgeweir 是一个开源、自托管的 CDN / WAF / 边缘调度平台。功能范围对标 GoEdge 和 FlexCDN（自建边缘节点、缓存、WAF、DNS 调度、多租户分销），站点优化能力对标 Cloudflare。它的第一卖点是"可验证的信任"：GoEdge 发布过与公开源码不一致的官方二进制，之后又被发现遭到投毒；2025 年的 RingH23 攻击则利用其控制面保存的节点 SSH root 凭据，横向投毒边缘节点。Edgeweir 从设计上杜绝这两类问题：控制面不保存节点 SSH 凭据，节点私钥从不离开节点，每个发布物都用 Sigstore 签名并附 SBOM 和 SLSA provenance，代码中没有任何 phone-home 或授权校验。

## 名字的由来

Edgeweir（读作 EDGE-weer）的名字来自「堰」（weir）。公元前 256 年前后，李冰主持修建都江堰，其中的飞沙堰位于内江的边缘：平时它让江水顺畅流向宝瓶口，灌溉成都平原；洪水来时，弯道环流把泥沙和多余的水甩过堰顶、排回外江。Edgeweir 想在网络的边缘做同样的事：放行正常流量，筛掉攻击，按需调度分流。

## 当前状态

**MVP 进行中（6 个里程碑完成 1 个）。** Phase 0 打通了端到端闭环：节点经 mTLS 注册、拉取配置，通过 OpenResty 代理并缓存站点。MVP M1 增加了集群、节点组和区域，组织、成员、邀请与两步验证 / passkey，网站编辑（每次保存生成配置版本），可筛选的审计日志，以及一次性 setup token。目前还不能用于生产。后续计划见 [docs/specs/mvp.md](docs/specs/mvp.md) 和 [ROADMAP.md](ROADMAP.md)。

## 组成

| 仓库 | 内容 |
| --- | --- |
| [edgeweir/edgeweir](https://github.com/edgeweir/edgeweir)（本仓库） | 控制台：Web UI、管理 API（含对外的 OpenAPI `/api/v1`）和节点通道，一个 Node.js 进程、一个镜像。另含 `edgeweir-certd`，一个负责 ACME 证书和 DNS 记录的 Go helper，打包在同一个镜像里。 |
| [edgeweir/edgeweir-node](https://github.com/edgeweir/edgeweir-node) | 边缘节点：`edgeweir-node` Go agent 加 OpenResty。 |

```
浏览器、API 调用方 ─:3000──▶ ┌───────────────────────────────────┐
                             │ 控制台（一个 Node.js 进程）       │── PostgreSQL 18（必需）
                             │   UI · /rpc · /api/v1             │── ClickHouse（可选）
                             │   节点通道 :8443（mTLS）          │── Valkey（可选）
                             │   pg-boss worker · certd          │
                             └────────────────▲──────────────────┘
                                              │ Connect-RPC over mTLS
                             ┌────────────────┴──────────────────┐
             终端用户 ─────▶ │ 边缘节点：edgeweir-node agent     │──▶ 源站
                             │           + OpenResty             │
                             └───────────────────────────────────┘
```

镜像：`ghcr.io/edgeweir/edgeweir`、`ghcr.io/edgeweir/edgeweir-node`（Docker Hub 同名 `edgeweir/edgeweir`、`edgeweir/edgeweir-node`）。

## 快速开始（Docker）

需要 Docker 和 Compose v2。

```sh
git clone https://github.com/edgeweir/edgeweir.git
cd edgeweir

# 两个必填密钥，Compose 从 .env 读取
cat > .env <<EOF
EDGEWEIR_MASTER_KEY=$(openssl rand -base64 32)
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
EOF

docker compose up -d
```

打开 <http://localhost:3000>，首次初始化向导会创建平台管理员和默认组织。向导需要控制台打印在日志里的一次性 setup token（`docker compose logs console | grep setupToken`）。

- `EDGEWEIR_MASTER_KEY` 用于加密入库的敏感数据（内部 CA 私钥、证书私钥、DNS API 凭据）。**请把它与数据库备份分开保存。** 丢失后这些数据无法恢复。
- `BETTER_AUTH_SECRET` 用于签名登录会话。
- 没有 setup token 的初始化请求会被拒绝，所以在你完成向导之前，别人无法抢先创建管理员。token 在第一次初始化成功后作废。

可选组件：

```sh
docker compose --profile analytics up -d   # 加入 ClickHouse（原始日志与分析）
docker compose --profile cache up -d       # 加入 Valkey（可选缓存）
```

端口：

| 端口 | 用途 | 能否放在反向代理后面 |
| --- | --- | --- |
| 3000 | Web 控制台与 API | 可以。宝塔 nginx 等代理可以在前面终结 TLS。 |
| 8443 | 节点通道 | 直接暴露，或用 nginx `stream` 做四层透传。**不能由代理终结 TLS**：控制台自己终结 TLS 并强制 mTLS。 |

部署文档：[docs/deploy/docker.md](docs/deploy/docker.md)、[docs/deploy/baota.md](docs/deploy/baota.md)（宝塔面板）。

## 添加节点

1. 以平台管理员登录，在顶栏切换到**后台**，打开**集群与节点**，选择集群，生成一次性安装命令。命令中包含一次性 token 和控制台内部 CA 的 SHA-256 指纹。
2. 在节点上以 root 执行该命令（使用 systemd 的 Linux，amd64 或 arm64）。节点需要能访问控制台的 8443 端口。

   ```sh
   curl -fsSL https://<控制台>/install.sh | sudo bash -s -- --token <一次性token> --ca-sha256 <CA指纹> ...
   ```

3. 安装脚本在执行任何下载的程序之前，先校验它的 cosign 签名和 sha256。agent 先核对 CA 指纹再发送 token，在本地生成私钥，此后只通过 mTLS 与控制台通信。
4. 控制台中显示节点在线，以及它已应用的配置 revision。

详见 [ADR-0008](docs/adr/0008-node-channel-connect-rpc-mtls.md) 和 [ADR-0016](docs/adr/0016-one-line-install.md)。

## 开发

需要 Node.js 24+、pnpm 12、Docker。修改 `helpers/certd` 需要 Go 1.27，修改 `proto/` 需要 buf。

```sh
pnpm install
docker compose -f compose.dev.yml up -d
cp .env.example .env
pnpm dev
```

`pnpm dev` 启动单个进程：在 <http://localhost:3000> 提供 UI 和 API，在 `:8443` 提供节点通道。

| 命令 | 作用 |
| --- | --- |
| `pnpm lint` | Biome lint 与格式检查 |
| `pnpm typecheck` | 全 workspace 的 TypeScript 类型检查 |
| `pnpm test` | 单元与集成测试（Vitest） |
| `pnpm build` | 生产构建 |
| `pnpm proto:lint` | 用 buf 检查 `proto/` |
| `pnpm proto:gen` | 从 `proto/` 重新生成 TypeScript 到 `packages/proto` |
| `pnpm e2e` | 端到端测试（需要 Docker） |

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
helpers/certd/             edgeweir-certd（Go）：lego 负责 ACME，libdns 负责 DNS 记录
docs/adr/                  架构决策记录
docs/deploy/               部署文档
```

## 文档

- [ARCHITECTURE.md](ARCHITECTURE.md)：整体架构
- [docs/adr/](docs/adr/README.md)：架构决策记录
- [ROADMAP.md](ROADMAP.md)：MVP、v1、v2 功能规划
- [SECURITY.md](SECURITY.md)：信任基线、漏洞报告、发布物校验
- [CONTRIBUTING.md](CONTRIBUTING.md)：贡献指南
- 文档站：<https://edgeweir.dev> · 官网：<https://edgeweir.com>

## 许可证

[AGPL-3.0-only](LICENSE)。[edgeweir-node](https://github.com/edgeweir/edgeweir-node) 使用相同的许可证。
