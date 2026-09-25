# Edgeweir 架构

本文描述控制面仓库 `edgeweir` 的结构和 Phase 0 的端到端闭环。决策的来龙去脉见 [docs/adr/](docs/adr/README.md)，节点侧细节见 `edgeweir-node` 仓库的 ARCHITECTURE.md。

## 1. 全景

```
                    浏览器 / 开放 API 调用方
                              │  :3000  (可放在反向代理后面)
┌─────────────────────────────▼──────────────────────────────────────┐
│ edgeweir console（一个镜像、一个 Node.js 进程，ROLE=app|worker|all） │
│                                                                    │
│  Hono ── /            React SPA（Vite 构建产物）                    │
│      ├── /api/auth/*  better-auth（会话、2FA、passkey、AccessKey）   │
│      ├── /rpc/*       oRPC（UI 专用，会话 cookie + CSRF 头）          │
│      ├── /api/v1/*    同一份 oRPC 契约的 OpenAPI（只认 x-api-key）   │
│      └── /install.sh  节点一键安装脚本                              │
│                                                                    │
│  节点通道 :8443  Connect-RPC over HTTPS，TLS 由进程自己终结，        │
│                 注册后强制 mTLS（内部 CA 签发节点证书）              │
│  pg-boss worker  定时任务（revision 清理、过期 token 清理、certd）   │
└──────────┬───────────────────────────────▲─────────────────────────┘
           │ SQL / LISTEN·NOTIFY            │ :8443 mTLS
   ┌───────▼────────┐              ┌────────┴──────────────────────┐
   │ PostgreSQL 18  │              │ edgeweir-node（Go agent）     │
   └────────────────┘              │  + OpenResty（Lua 数据面）    │
                                   └───────────────────────────────┘
```

## 2. 仓库布局

| 路径 | 内容 |
| --- | --- |
| `apps/console/src/server` | Hono 应用（`app.ts`）、oRPC 路由实现（`rpc/`）、节点通道（`node-channel/`）、内部 CA（`pki/`）、领域服务（`services/`）、pg-boss 任务（`jobs/`）、入口 `main.ts`（生产）和 `dev.ts`（开发：同一进程内嵌 Vite middleware） |
| `apps/console/src/web` | React 19 SPA：TanStack Router 文件路由（`routes/`）、TanStack Query、shadcn 组件（`components/ui`，preset `b2D0wqNxT`）、Paraglide 消息（`messages/*.json` 编译到 `src/web/paraglide`） |
| `packages/contract` | oRPC 契约 + zod schema，UI、服务端和 OpenAPI 共用 |
| `packages/db` | Drizzle schema（better-auth 表 + 业务表）和纯 SQL 迁移（`migrations/`，容器启动时自动执行） |
| `packages/config-compiler` | 把站点、源站、缓存规则编译成 NodeConfig IR；规范排序、内容哈希、diff |
| `packages/proto` | 由 `proto/` 生成的 TypeScript 代码（protoc-gen-es），不手改 |
| `proto/` | buf 模块：`edgeweir/node/v1/{node,config}.proto`，两个仓库唯一的契约来源 |
| `helpers/certd` | Go 编写的 `edgeweir-certd`（lego + libdns），多阶段构建进同一镜像 |
| `compose*.yml`、`Dockerfile`、`docker/` | 部署；`compose.e2e.yml` 用于端到端测试 |
| `scripts/e2e.sh`、`apps/console/e2e/` | 端到端脚本和 Playwright 冒烟测试 |

## 3. 数据模型 v0

- 身份与租户（better-auth 生成）：`user`、`session`、`account`、`verification`、`organization`、`member`、`invitation`、`two_factor`、`passkey`、`apikey`。平台管理员 = `user.role` 含 `admin`；租户 = organization；成员角色在 `member.role`。
- 基础设施（平台管理员）：`cluster` → `node_group` → `node`（`node_ip`），`enrollment_token`（只存 SHA-256）。
- 站点（租户）：`site` → `site_domain`、`origin_pool` → `origin`、`cache_rule`。
- 配置发布：`config_revision`（每个集群单调递增的 revision、内容哈希、二进制 IR），`node_config_status`（节点回执 + 心跳）。
- 其他：`node_minute_stats`（lite 统计）、`pki_authority`（内部 CA，私钥信封加密）、`audit_log`（所有管理操作）。

## 4. 配置发布流水线

1. 任何站点变更（新增、删除、清缓存）在同一个事务里：写业务表 → `publishRevision()`。
2. `publishRevision()` 对集群加 advisory lock，读取集群全部站点，`compileNodeConfig()` 生成规范化的 IR，计算 `content_hash`（清空 `revision`/`content_hash` 后的确定性编码的 SHA-256），与上一版哈希相同则不产生新 revision。
3. 写 `config_revision` 并在同一事务里 `pg_notify('edgeweir_config', …)`；提交后所有控制台实例收到通知。
4. 节点通道把通知推给该集群节点的 `WatchConfig` 流；节点调用 `GetConfig(base_revision=已应用)` 拿 diff（或快照），校验哈希，落盘为 last-known-good，应用到 OpenResty，再 `ReportStatus` 回执。
5. 控制台用 `node_config_status` 展示每个节点已应用的 revision；心跳 45 秒内算在线。
6. 回滚 = 以旧 revision 的 IR 发布一个新 revision。

## 5. 节点通道与信任

- 内部 CA（ECDSA P-256，10 年）首次启动生成，私钥用 `EDGEWEIR_MASTER_KEY` 派生的密钥做 AES-256-GCM 信封加密后入库。
- 服务端证书每次启动由内部 CA 签发，SAN 包含 `EDGEWEIR_NODE_API_URL` 的主机名和 `EDGEWEIR_NODE_API_HOSTNAMES`。
- 注册：安装命令带一次性 token 和 CA 证书指纹（`--ca-sha256`）。节点先校验服务端证书链里的 CA 指纹，再发送 token 和本地生成的 CSR；控制台验证 CSR 签名，签发 30 天、CN=节点 ID、仅限客户端认证的证书；token 原子地标记为已用。
- 除 `Enroll` 外的 RPC 都要求经 CA 校验的客户端证书，且证书序列号必须等于库里记录的当前序列号（轮换后旧证书立即失效）。剩余有效期不足三分之一时，`ReportStatus` 提示节点调用 `RenewCertificate`。

## 6. 认证面

| 入口 | 凭据 | 说明 |
| --- | --- | --- |
| `/api/auth/*` | 邮箱+密码、2FA、passkey | better-auth；无公开注册，账号由初始化向导和管理员创建 |
| `/rpc/*` | 会话 cookie + `x-csrf-token` | UI 专用；请求里的 `x-api-key` 会被丢弃 |
| `/api/v1/*` | `x-api-key` | 开放 API（OpenAPI 文档 `/api/v1/openapi.json`）；cookie 会被丢弃 |
| `:8443` | mTLS | 节点通道 |

## 7. 开发与构建

- `pnpm dev`：一个进程同时跑 API、节点通道和 Vite（HMR），需要本地 PostgreSQL（`docker compose up -d postgres`）和 `.env`。
- `pnpm build`：Vite 构建 SPA 到 `apps/console/dist/web`，esbuild 把服务端和所有依赖打成单个 `dist/server/main.js`，迁移复制到 `dist/migrations`。生产镜像不需要 `node_modules`。
- `pnpm proto:gen`：从 `proto/` 生成 TS；`edgeweir-node` 从本仓库的 git tag（`proto/vX.Y.Z`）生成 Go。

## 8. 可观测性

- 结构化 JSON 日志（stdout/stderr）。
- `/healthz` 供容器健康检查；worker 角色只检查进程存活。
- 节点预聚合的分钟级统计写入 `node_minute_stats`，概览页展示最近 60 分钟请求数和缓存命中。ClickHouse 模式属于后续版本（ADR-0009）。
