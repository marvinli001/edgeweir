# Edgeweir 架构

本文描述控制面仓库 `edgeweir` 的结构和当前（MVP M2 与 2026-09-25 收尾之后）的实现。决策的来龙去脉见 [docs/adr/](docs/adr/README.md)，节点侧细节见 `edgeweir-node` 仓库的 ARCHITECTURE.md，源站与缓存的行为说明见 [docs/guide/origins-and-cache.md](docs/guide/origins-and-cache.md)。

## 1. 全景

```
                    浏览器 / 开放 API 调用方
                              │  :3000  (可放在反向代理后面)
┌─────────────────────────────▼──────────────────────────────────────┐
│ edgeweir console（一个镜像、一个 Node.js 进程，ROLE=app|worker|all） │
│                                                                    │
│  Hono ── /            可选的公开落地页，关闭时跳到 /overview         │
│      ├── /*           React SPA（Vite 构建产物，前端路由回退）       │
│      ├── /api/auth/*  better-auth，只放行白名单里的端点              │
│      ├── /rpc/*       oRPC（UI 专用，会话 cookie + CSRF 头）          │
│      ├── /api/v1/*    同一份 oRPC 契约的 OpenAPI（只认 x-api-key）   │
│      ├── /install.sh  节点一键安装脚本                              │
│      └── /downloads/* 节点发布物镜像（EDGEWEIR_DOWNLOADS_DIR）       │
│                                                                    │
│  节点通道 :8443  Connect-RPC over HTTPS，TLS 由进程自己终结，        │
│                 注册后强制 mTLS（内部 CA 签发节点证书）              │
│  pg-boss worker  定时任务（revision 清理、注册 token 清理、          │
│                 过期的刷新预热任务）                                │
└──────────┬───────────────────────────────▲─────────────────────────┘
           │ SQL / LISTEN·NOTIFY            │ :8443 mTLS
   ┌───────▼────────┐              ┌────────┴──────────────────────┐
   │ PostgreSQL 18  │              │ edgeweir-node（Go agent）     │
   └────────────────┘              │  + OpenResty（Lua 数据面）    │
                                   └───────────────────────────────┘
```

PostgreSQL 是唯一的外部依赖。`compose.yml` 的 `analytics`（ClickHouse）和 `cache`（Valkey）profile 只启动容器，控制台目前都不使用（ClickHouse 模式见 [ADR-0009](docs/adr/0009-analytics-clickhouse-and-lite.md)，排在后续里程碑）。`edgeweir-certd` 随镜像发布，由 pg-boss 通过 stdin/stdout 调用，完成 ACME 签发、续期及 DNS 记录操作；凭据不放在进程参数中。

## 2. 仓库布局

| 路径 | 内容 |
| --- | --- |
| `apps/console/src/server` | Hono 应用（`app.ts`）、oRPC 路由实现（`rpc/`）、节点通道（`node-channel/`）、内部 CA（`pki/`）、领域服务（`services/`）、pg-boss 任务（`jobs/`）、认证与基础设施（`lib/`：better-auth 配置与审计钩子、环境变量、信封加密、客户端 IP）、安装脚本（`install/install.sh`）、发布物镜像（`downloads.ts`）；入口 `main.ts`（生产）和 `dev.ts`（开发：同一进程内嵌 Vite middleware） |
| `apps/console/src/web` | React 19 SPA：TanStack Router 文件路由（`routes/`）、TanStack Query、shadcn 组件（`components/ui`，preset `b2D0wqNxT`）、appica 封装（`components/appica/`）、统计面板（`components/analytics/`）、落地页模板（`components/landing/`）；Paraglide 消息在 `apps/console/messages/{zh-CN,en}.json`，编译到 `src/web/paraglide` |
| `apps/console/test` | Vitest：`server/`（过程、权限、审计、节点通道，数据库用 PGlite）与 `web/`（i18n、界面规则、preset） |
| `apps/console/e2e` | Playwright：`setup`、`smoke`、`m1`、`m2`、`analytics`、`landing` |
| `packages/contract` | oRPC 契约 + zod schema、错误码（`errors.ts`）、节点错误码（`node-errors.ts`）、源站地址规则（`addresses.ts`），UI、服务端和 OpenAPI 共用 |
| `packages/db` | Drizzle schema（`src/schema/auth.ts` 为 better-auth 表，`core.ts` 为业务表）和纯 SQL 迁移（`migrations/`，启动时自动执行） |
| `packages/config-compiler` | 把站点、源站、缓存规则和平台的源站允许清单编译成 NodeConfig IR；规范排序、内容哈希、diff；跨语言哈希向量在 `test/fixtures/` |
| `packages/proto` | 由 `proto/` 生成的 TypeScript 代码（protoc-gen-es），不手改 |
| `proto/` | buf 模块：`edgeweir/node/v1/{node,config}.proto`，两个仓库唯一的契约来源（当前 tag `proto/v0.3.0`） |
| `helpers/certd` | Go 编写的 `edgeweir-certd`（ACME 与 DNS helper），多阶段构建进同一镜像 |
| `compose*.yml`、`Dockerfile`、`docker/` | 部署；`compose.dev.yml` 是本地开发数据库，`compose.e2e.yml` 用于端到端测试 |
| `scripts/e2e.sh` | 端到端测试脚本：注册、配置下发、缓存、刷新预热、源站、S3、故障切换，认证路由白名单、源站地址策略与 CDN-Loop、HTTPS 源站名称校验、分片 Range，`install.sh` 在干净容器里安装 goreleaser snapshot 包；中间穿插 Playwright |
| `docs/` | `adr/`（架构决策，edgeweir-node 的 `docs/adr` 由该仓库的 `scripts/sync-adr.sh` 镜像）、`specs/mvp.md`、`guide/`、`deploy/`、`audits/`、`research/` |

## 3. 数据模型

表定义以 `packages/db/src/schema` 为准。

- **DNS 挑战恢复**：`dns_challenge_lease` 由 `0008_m3_dns_cleanup` 创建。在发送 DNS 写请求之前保存 TXT 清理责任，超时、失败与重启后只清理本次操作的记录值。

- **证书与 DNS 凭据（M3 集成中）**：`certificate` 存证书链、指纹、到期与续期状态，私钥和 ACME 账户分别信封加密；`dns_credential` 存组织级 DNS 服务商凭据的信封；`acme_challenge` 存短期公开的 HTTP-01 响应。迁移 `0006_m3_certificates` 同时增加节点能力清单与网站 TLS 策略；`0007_m3_challenge_attempts` 为 `acme_challenge` 增加必填的操作开始时间 `operation_started_at`。

- **身份与租户**（better-auth 生成）：`user`、`session`、`account`、`verification`、`organization`、`member`、`invitation`、`two_factor`、`passkey`、`apikey`、`rate_limit`（认证接口的限速计数）。平台管理员 = `user.role` 含 `admin`；租户 = organization；成员角色在 `member.role`。组织的默认集群和"要求两步验证"在自有表 `organization_settings`。
- **基础设施**（平台管理员）：`region`（区域字典）；`cluster` → `node_group`（可引用区域）→ `node`（`node_ip`）；`enrollment_token`（只存 SHA-256）；`node_certificate_revocation`（删除节点时吊销的证书序列号）。
- **站点**（租户）：`site` → `site_domain`、`origin_pool` → `origin`、`origin_credential`（S3 源站密钥，信封加密）、`cache_rule`；`site_star`（按用户的星标）。
- **配置发布**：`config_revision`（每个集群单调递增的 revision、内容哈希、二进制 IR、原因码），`node_config_status`（节点回执 + 心跳）。
- **节点上报与任务**：`node_minute_stats`（按节点、网站、分钟的 lite 统计），`origin_health`（节点上报的被动健康状态与错误码），`cache_task` → `cache_task_node`（刷新预热任务及其在每个节点上的交付和结果，含跳过与补发）。
- **其他**：`pki_authority`（内部 CA，私钥信封加密），`system_setting`（setup token、落地页设置、源站允许清单），`audit_log`（所有管理操作）。

迁移：`0000_init`、`0001_m1`、`0002_site_star`、`0003_m2`、`0004_wrapup_auth`（`rate_limit`）、`0005_wrapup_console`（`cache_authorized`、任务来源与节点错误码）。控制台启动时在一个专用连接上持 advisory lock 执行迁移，多实例同时启动也安全。

`0009_m4_rules` 增加 `edge_rule`（有阶段、表达式、动作与名单引用的站点/平台规则）和 `ip_list`（组织或平台作用域的规范化 CIDR 名单）。发布时解析为结构化 AST，列表名绑定到受权限检查的 ID。

`0010_m5_stats` 增加 `node_stats_cursor` 的永久批次高水位，以及 `node_hour_stats`、`node_day_stats`、`stats_rollup_dirty`。`traffic_hour_stats` 视图在已完成汇总与待汇总分钟数据之间避免重复。`0011_m5_domain_ownership` 增加 `domain_ownership` 和域名的 verified 路由标记；待校验记录不保留全局主机名使用权。

`0012_m5_dns` 与 `0013_m5_dns_managed_names` 增加 `platform_dns_provider`、`dns_state`、`dns_revision`、`dns_managed_name`，用于独立 DNS 发布与可重试的外部记录维护。`0014_m5_alerts`、`0015_m5_alert_order`、`0016_m5_alert_privacy_default` 增加 `alert_channel`、`alert_subscription`、`alert_state`、`alert_event`、`alert_delivery`：通知凭据加密，事件带顺序，发送时重新检查订阅权限，平台全量通知默认关闭。

## 4. 配置发布流水线

1. 改变节点配置的操作（网站新增、编辑、删除，全站清除缓存代际号加一，源站允许清单变更，回滚）在同一个事务里：写业务表 → `publishRevision()` → 写审计。
2. `publishRevision()` 对集群加 advisory lock，读取集群全部站点和平台的源站允许清单，`compileNodeConfig()` 生成规范化的 IR，计算 `content_hash`（清空 `revision`/`content_hash` 后的确定性编码的 SHA-256），与上一版哈希相同则不产生新 revision。
3. 写 `config_revision` 并在同一事务里 `pg_notify('edgeweir_config', …)`；提交后所有控制台实例收到通知。
4. 节点通道把通知推给该集群节点的 `WatchConfig` 流；节点调用 `GetConfig(base_revision=已应用)` 拿 diff（或快照），校验哈希，落盘为 last-known-good，应用到 OpenResty，再 `ReportStatus` 回执。
5. 控制台用 `node_config_status` 展示每个节点已应用的 revision；心跳 45 秒内算在线。
6. 回滚 = 以旧 revision 的 IR 发布一个新 revision（源站允许清单取当前值），写 `cluster.rollback` 审计。

URL、目录、全站刷新和 URL 预热不走 revision，而是类型化的节点任务：`cacheTasks.create` 写 `cache_task` 和每个启用节点的 `cache_task_node`（停用的节点记为跳过），`pg_notify('edgeweir_tasks', …)` 让 `WatchConfig` 流发出 `WATCH_EVENT_TASKS`；节点用 `PullTasks` 拉取、`ReportTaskResult` 回报。任务交出后 5 分钟没有结果会再交出一次，7 天未执行记为失败；节点重新连接时，它错过的清缓存按网站补发整站刷新。每个组织每分钟最多 10 个任务、每小时最多 2000 个目标（平台管理员不受限）。

## 5. 节点通道与信任

- 内部 CA（ECDSA P-256，10 年）首次启动生成，私钥用 `EDGEWEIR_MASTER_KEY` 派生的密钥做 AES-256-GCM 信封加密后入库。信封的附加认证数据绑定表、字段和记录 id（v2），旧版本写入的 v1 密文在启动时自动升级。
- 服务端证书每次启动由内部 CA 签发，SAN 包含 `EDGEWEIR_NODE_API_URL` 的主机名和 `EDGEWEIR_NODE_API_HOSTNAMES`。
- 注册：安装命令带一次性 token（经 `EDGEWEIR_TOKEN` 环境变量传递）和 CA 证书指纹（`--ca-sha256`）。节点先校验服务端证书链里的 CA 指纹，再发送 token 和本地生成的 CSR；控制台验证 CSR 签名，签发 30 天、CN=节点 ID、仅限客户端认证的证书；token 原子地标记为已用。
- 控制面绝不保存节点 SSH 凭据，也没有保存的选项；节点只通过控制台生成的一次性安装命令接入，由节点主动注册（[ADR-0016](docs/adr/0016-one-line-install.md)、[ADR-0018](docs/adr/0018-trust-and-security-baseline.md) 的收尾更新记录）。
- 除 `Enroll` 外的 RPC 都要求经 CA 校验的客户端证书，且证书序列号必须等于库里记录的当前序列号（轮换后旧证书立即失效；删除节点时序列号写入吊销表）。停用的节点每次 RPC 都被拒绝。剩余有效期不足三分之一时，`ReportStatus` 提示节点调用 `RenewCertificate`。
- RPC：`Enroll`、`RenewCertificate`、`WatchConfig`、`GetConfig`、`ReportStatus`（含源站健康与错误码）、`ReportStats`（每次一条 upsert 语句）、`GetOriginCredentials`（只返回本集群站点引用的 S3 密钥）、`PullTasks`、`ReportTaskResult`。proto 当前为 `v0.2.2`（[ADR-0008](docs/adr/0008-node-channel-connect-rpc-mtls.md) 更新记录）。

## 6. 认证面

| 入口 | 凭据 | 说明 |
| --- | --- | --- |
| `/api/auth/*` | 邮箱+密码、2FA、passkey | better-auth；只放行前端用到的端点（登录、登出、会话、改密码、两步验证、passkey、API key 的创建/列表/删除），其余 404；请求里的 `x-api-key` 被丢弃；无公开注册，账号由初始化向导和管理员创建 |
| `/rpc/*` | 会话 cookie + `x-csrf-token` | UI 专用；请求里的 `x-api-key` 会被丢弃 |
| `/api/v1/*` | `x-api-key` | 开放 API（OpenAPI 文档 `/api/v1/openapi.json`，公开过程声明 `security: []`）；cookie 会被丢弃 |
| `/install.sh`、`/downloads/*`、`/healthz` | 无 | 安装脚本、发布物镜像（未镜像的文件 404）、健康检查；这些路径和 `/api`、`/rpc` 下没有匹配的请求一律 404，不回退到 SPA |
| `:8443` | mTLS | 节点通道 |

客户端 IP（审计日志、登录限速）取 TCP 对端地址；`X-Forwarded-For` / `X-Real-IP` 只在对端属于 `EDGEWEIR_TRUSTED_PROXIES` 时采用。认证接口的限速计数存在 `rate_limit` 表。经 better-auth 完成的登录与账号变更由钩子写审计（[ADR-0007](docs/adr/0007-auth-better-auth-multitenancy.md) 更新记录）。

## 7. 开发与构建

- `pnpm dev`：一个进程同时跑 API、节点通道和 Vite（HMR），需要本地 PostgreSQL（`docker compose -f compose.dev.yml up -d`）和从 `.env.example` 复制并填好密钥的 `.env`。
- `pnpm test`：Vitest，服务端测试用 PGlite 在进程内跑 PostgreSQL，不需要 Docker。
- `pnpm build`：Vite 构建 SPA 到 `apps/console/dist/web`，esbuild 把服务端和所有依赖打成单个 `dist/server/main.js`（`install/` 一并复制），迁移复制到 `dist/migrations`。生产镜像不需要 `node_modules`。
- `pnpm db:generate`：drizzle-kit 根据 schema 的改动生成 SQL 迁移，SQL 与快照一起提交。
- `pnpm proto:gen`：从 `proto/` 生成 TS；`edgeweir-node` 从本仓库的 git tag（`proto/vX.Y.Z`）生成 Go。
- 端到端：`docker compose -f compose.e2e.yml up -d --build` 后 `pnpm e2e`（`scripts/e2e.sh`），需要同级目录的 edgeweir-node（`EDGEWEIR_NODE_CONTEXT`），安装步骤还需要宿主机上的 goreleaser v2、syft、Go 1.27.1，以及对 deb.debian.org 和 openresty.org 的网络访问。`COMPOSE_PROJECT_NAME`、`E2E_CONSOLE_PORT`、`E2E_NODE_PORT`、`E2E_TAG`、`E2E_SUBNET`、`E2E_ISOLATED_SUBNET` 让第二套环境并行运行，`E2E_INSTALL_IMAGE` 换安装用的镜像（默认值见 README 的端到端测试一节）。

## 8. 可观测性

- 结构化 JSON 日志（stdout/stderr），级别由 `LOG_LEVEL` 控制。
- `/healthz` 供容器健康检查；worker 角色只检查进程存活。
- 节点预聚合的分钟级统计写入 `node_minute_stats`。控制台首页、网站统计 Tab 和平台概览按时间范围（1 小时到 30 天）用 `date_bin` 直接从分钟明细分桶，显示请求数、流量、带宽峰值、命中率和状态码分布，并与上一等长时段比较。小时 / 天汇总与明细清理、Top URL / IP 在 M5；ClickHouse 模式属于后续版本（[ADR-0009](docs/adr/0009-analytics-clickhouse-and-lite.md)）。
