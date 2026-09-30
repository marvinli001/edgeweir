# 架构

控制台仓库的组件、进程、端口、数据流、数据模型与信任边界。

## 组件

| 组件 | 位置 | 职责 |
| --- | --- | --- |
| 控制台 | `apps/console` | Web UI、UI 接口 `/rpc`、开放 API `/api/v1`、节点通道、pg-boss worker；一个镜像、一个 Node.js 进程 |
| `edgeweir-certd` | `helpers/certd` | Go 编写的 ACME 与 DNS helper，随控制台镜像发布；worker 以子进程调用，经 stdin/stdout 交换 JSON，凭据不进入进程参数 |
| PostgreSQL 18 | 外部服务 | 唯一必需的依赖：业务数据、迁移记录（schema `drizzle`）、pg-boss 队列（schema `pgboss`）、LISTEN/NOTIFY |
| ClickHouse | Compose profile `analytics` | 可选；`EDGEWEIR_ANALYTICS=clickhouse` 时保存访问日志与分钟统计副本 |
| Valkey | Compose profile `cache` | 控制台目前未使用 |
| 节点 | [edgeweir-node](https://github.com/marvinli001/edgeweir-node) | Go agent 与 OpenResty 数据面；经节点通道拉取配置与任务，上报状态、统计与日志 |

```text
控制台（ROLE=app|worker|all）
├── :3000  HTTP ◀── 浏览器、API 调用方
├── :8443  Connect-RPC（TLS + mTLS）◀── edgeweir-node agent ── OpenResty ──▶ 源站
├── SQL、LISTEN/NOTIFY ──▶ PostgreSQL 18
├── HTTP（可选）──▶ ClickHouse
└── 子进程 stdin/stdout ──▶ edgeweir-certd ──▶ ACME CA、DNS 服务商 API
```

控制台与节点之间唯一的契约是 `proto/` 中的 `edgeweir.node.v1`（当前 tag `proto/v0.7.0`）。开源核心与商业产品的边界见 [LICENSING.md](LICENSING.md)。

## 仓库布局

| 路径 | 内容 |
| --- | --- |
| `apps/console/src/server` | 服务端：`app.ts`（HTTP 路由）、`bootstrap.ts`（启动顺序）、`main.ts`（生产入口）、`dev.ts`（开发入口，同一进程内嵌 Vite 中间件）、`rpc/`（oRPC 路由与守卫）、`node-channel/`（节点通道）、`pki/`（内部 CA）、`services/`（领域服务）、`jobs/worker.ts`（pg-boss 队列）、`lib/`（环境变量、认证、信封加密、客户端 IP、日志）、`install/install.sh`（节点安装脚本）、`downloads.ts`（发布物镜像） |
| `apps/console/src/web` | React 19 SPA：TanStack Router 文件路由（`routes/`）、TanStack Query、shadcn 组件（`components/ui`）、appica 封装（`components/appica/`）；Paraglide 消息在 `apps/console/messages/{zh-CN,en}.json`，编译到 `src/web/paraglide` |
| `apps/console/test` | Vitest：`server/`（数据库为进程内 PGlite）、`web/`（i18n、界面规则、preset、主题） |
| `apps/console/e2e` | Playwright 用例，由 `scripts/e2e.sh` 调用 |
| `packages/contract` | oRPC 契约与 zod schema、错误码（`errors.ts`）、节点错误码（`node-errors.ts`）、源站地址规则（`addresses.ts`）；UI、服务端与 OpenAPI 共用 |
| `packages/db` | Drizzle schema（`src/schema/`）与纯 SQL 迁移（`migrations/`） |
| `packages/config-compiler` | 把网站、规则、IP 名单、证书引用与平台策略编译为 NodeConfig IR；规范排序、内容哈希、diff |
| `packages/rule-engine` | 规则表达式的字段、阶段、解析与名单引用绑定 |
| `packages/proto` | 由 `proto/` 生成的 TypeScript（protoc-gen-es），不手改 |
| `proto/` | buf 模块 `edgeweir/node/v1/{node,config}.proto`；edgeweir-node 从 `proto/vX.Y.Z` tag 生成 Go 代码 |
| `helpers/certd` | `edgeweir-certd` 源码 |
| `helpers/http3probe` | CI 使用的 HTTP/3 探测程序 |
| `Dockerfile`、`docker/` | 镜像构建、容器健康检查脚本、端到端测试夹具 |
| `compose*.yml`、`deploy.sh` | `compose.yml`（生产）、`compose.baota.yml` 与 `compose.baota-host.yml`（宝塔 / aaPanel）、`compose.dev.yml`（开发数据库）、`compose.e2e.yml`（端到端）；`deploy.sh` 为宝塔 / aaPanel 安装与升级脚本 |
| `scripts/` | `e2e.sh`（端到端测试）、`image-version.sh`（滚动版本号）、`bench.sh`（缓存命中性能基线） |
| `docs/` | `deploy/`（部署）、`guide/`（功能说明）、`reference/`（参考） |

## 进程与角色

`ROLE` 决定一个进程运行的部分。所有角色使用同一镜像与同一数据库；部署形态与扩展见 [部署概览](docs/deploy/README.md)，全部变量见 [环境变量](docs/reference/environment.md)。

| `ROLE` | 运行内容 |
| --- | --- |
| `app` | HTTP 服务、节点通道、setup token、LISTEN/NOTIFY 订阅 |
| `worker` | pg-boss 队列与定时任务 |
| `all`（默认） | `app` 与 `worker` 的全部内容 |

### 启动顺序

1. 解析并校验环境变量（`lib/env.ts`）；无效时列出变量名并退出。
2. 等待 PostgreSQL 可连接，最长 60 秒。
3. 在专用连接上持 advisory lock 执行未应用的迁移；多个实例同时启动时串行执行。
4. 确定会话 secret（`BETTER_AUTH_SECRET`，或由主密钥派生），与数据库中的 HMAC 校验值比对：派生值与数据库此前使用的 secret 不一致时拒绝启动；显式设置的新值被接受并记录警告（[SECURITY.md](SECURITY.md#会话-secret)）。
5. 把旧版本写入的 v1 信封重新加密为 v2。
6. 加载内部 CA；数据库中没有时生成。
7. `app`、`all`：未初始化时生成或读取 setup token 并写入日志；开始 LISTEN；由内部 CA 签发节点通道服务端证书并开始监听。
8. `worker`、`all`：启动 pg-boss，创建队列，注册定时任务。
9. `app`、`all`：HTTP 服务开始监听。

收到 `SIGTERM` 或 `SIGINT` 时，关闭 HTTP 连接与节点通道，pg-boss 最多等待 5 秒完成当前任务，随后关闭数据库连接池。

## 端口与路由

| 端口 | 变量 | 协议 | 约束 |
| --- | --- | --- | --- |
| 3000 | `HOST`、`PORT` | HTTP | 可置于反向代理后；代理地址写入 `EDGEWEIR_TRUSTED_PROXIES` |
| 8443 | `NODE_API_HOST`（默认同 `HOST`）、`NODE_API_PORT` | HTTPS，TLS 1.2 及以上，HTTP/2 与 HTTP/1.1 | 直接暴露或四层透传；代理终结 TLS 会使节点 mTLS 失败 |

反向代理与四层透传配置见 [端口、反向代理与可信代理](docs/deploy/networking.md)。

### HTTP 路由

| 路径 | 处理 | 凭据 |
| --- | --- | --- |
| `/healthz` | 返回 `{"status":"ok","version":…}` | 无 |
| `/api/auth/*` | better-auth，只放行白名单端点 | 见 [认证与授权](#认证与授权) |
| `/rpc/*` | oRPC，UI 专用 | 会话 cookie + `x-csrf-token` |
| `/api/v1/openapi.json` | OpenAPI 文档 | 无 |
| `/api/v1/*` | 与 `/rpc` 同一份路由的 OpenAPI 处理器 | `x-api-key` |
| `/install.sh` | 节点安装脚本，其中的控制台地址替换为 `EDGEWEIR_PUBLIC_URL`；`cache-control: no-store` | 无 |
| `/downloads/*` | 节点发布物镜像（`EDGEWEIR_DOWNLOADS_DIR`），GET 与 HEAD | 无 |
| `/assets/*` | SPA 静态资源，`max-age=31536000, immutable` | 无 |
| 其他路径 | SPA 静态文件；未命中时返回 `index.html` | 无 |

`/api`、`/rpc`、`/downloads` 下没有匹配的请求，以及 `/install.sh`、`/healthz` 的其他方法，返回 404 JSON，不回退到 SPA。所有响应带安全头，CSP 为 `default-src 'self'`、`frame-ancestors 'none'`。

### 界面区域

| 区域 | 路径 | 访问者 |
| --- | --- | --- |
| 入口 | `/`（按状态跳转到 `/setup`、`/overview` 或 `/login`）、`/setup`、`/login`、`/invite/$id` | 所有人 |
| 控制台 | `/overview`、`/sites`、`/certificates`、`/alerts`、`/ip-lists`、`/purge`、`/members`、`/security`、`/settings` | 登录用户；`/members` 仅组织所有者、管理员与平台管理员 |
| 后台 | `/admin`、`/admin/clusters`、`/admin/alerts`、`/admin/dns`、`/admin/rules`、`/admin/ip-lists`、`/admin/regions`、`/admin/organizations`、`/admin/audit`、`/admin/settings` | 平台管理员，经页头的 **控制台** / **后台** 切换进入 |

## 认证与授权

| 入口 | 凭据 | 规则 |
| --- | --- | --- |
| `/api/auth/*` | 邮箱与密码、TOTP、备用码、passkey | 只放行 `lib/auth.ts` 中 `AUTH_HTTP_ROUTES` 列出的方法与路径（会话、登录、登出、改密码、两步验证、passkey、API key 创建 / 列表 / 删除），其余 404；请求中的 `x-api-key` 被丢弃；关闭公开注册，账号由初始化向导与管理员创建；密码至少 12 位 |
| `/rpc/*` | 会话 cookie + `x-csrf-token` | 请求中的 `x-api-key` 被丢弃 |
| `/api/v1/*` | `x-api-key`（AccessKey） | cookie 被丢弃；AccessKey 以所有者身份执行，权限与会话相同；只读 AccessKey 只能调用 GET 过程与 `rules.validate` |
| `:8443` | 客户端证书 | 见 [节点通道](#节点通道) |

端点、OpenAPI 文档与 AccessKey 的细节见 [API 与端点](docs/reference/api.md)。oRPC 过程按守卫分级（`rpc/base.ts`）：

| 守卫 | 允许的调用者 |
| --- | --- |
| `authed` | 有效会话或启用中的 AccessKey |
| `tenant` | `authed`，且组织要求两步验证时本人已启用 |
| `orgManager` | `tenant`，且为组织所有者、管理员或平台管理员 |
| `admin` | 平台管理员（`user.role` 含 `admin`） |
| `maybeAuthed` | 任何人；登录时返回结果不同（邀请） |

客户端 IP（审计日志、登录限速）取 TCP 对端地址；`X-Forwarded-For` 与 `X-Real-IP` 只在对端属于 `EDGEWEIR_TRUSTED_PROXIES` 时采用（`resolveClientIp`）。认证接口的限速计数存在 `rate_limit` 表，多实例共享。经 better-auth 完成的登录与账号变更由 `lib/auth-audit.ts` 的钩子写审计。

## 配置发布

改变节点配置的操作在一个事务内完成：

1. 写业务表（网站、域名、源站、缓存规则、规则、IP 名单、证书、ACME HTTP-01 响应、源站允许清单、全站清除缓存的代际号）。
2. `publishRevision()` 对集群加 advisory lock，读取该集群启用的网站、平台规则、相关 IP 名单、源站允许清单、证书引用与未过期的 HTTP-01 响应，`compileNodeConfig()` 生成规范化的 NodeConfig IR。
3. 计算 `content_hash`：`revision` 与 `content_hash` 置空后二进制编码的 SHA-256。与上一版相同则不产生新 revision。
4. 新 revision 号为「库中最新 revision」与「本集群节点经验证的最高已应用 revision」中较大者加一；数据库从备份恢复后 revision 不回退。
5. 写入 `config_revision`，同一事务内 `pg_notify('edgeweir_config', …)`，再写审计。
6. 提交后，每个 `app` 实例经 LISTEN 收到通知，推给该集群节点的 `WatchConfig` 流。
7. 节点调用 `GetConfig(base_revision=已应用 revision)` 取得 diff 或快照与 revision 回执，校验哈希，落盘为 last-known-good，应用到 OpenResty，以 `ReportStatus` 回报。
8. 控制台在 `node_config_status` 记录每个节点已应用的 revision 与心跳；45 秒内有心跳即为在线。

| 约束 | 值 |
| --- | --- |
| 每个集群的启用网站 | 最多 512 个（`MAX_SITES_PER_CLUSTER`），超出返回 `CLUSTER_SITE_LIMIT` |
| 新增节点能力 | 发布需要活动节点尚不支持的能力时，平台管理员以外的操作返回 `NODE_CAPABILITY_REQUIRED`；`GetConfig` 对缺少所需能力的节点返回 `FailedPrecondition` |
| revision 保留 | 每个集群保留最新 200 个，每小时清理 |
| 回滚 | 以旧 revision 的 IR 发布新 revision，源站允许清单取当前值，审计动作 `cluster.rollback` |

revision 原因是代码（`revision_reason_<code>`），定义在 `packages/contract/src/errors.ts`。规则语言见 [规则](docs/guide/rules.md)。

## 节点任务

URL、目录、整站刷新与 URL 预热不产生 revision，以类型化任务下发：

1. `cacheTasks.create` 写入 `cache_task`，为每个启用节点写入 `cache_task_node`（停用节点记为跳过），`pg_notify('edgeweir_tasks', …)`。
2. `WatchConfig` 流发出 `WATCH_EVENT_TASKS`。
3. 节点以 `PullTasks` 拉取，以 `ReportTaskResult` 回报结果。
4. 交出 5 分钟后没有结果的任务再次交出；7 天未完成记为失败。节点重新连接时，控制台为其错过的清缓存按网站补发整站刷新。

| 限制 | 值 |
| --- | --- |
| 每个组织每分钟任务数 | 10（平台管理员不受限） |
| 每个组织每小时目标数 | 2000（平台管理员不受限） |

节点升级同样经 `PullTasks` 下发：升级任务先在一个节点组试运行，健康观察通过后由平台管理员推进到其余节点。行为说明见 [节点升级](docs/guide/node-upgrades.md)。

## 节点通道

Connect-RPC over HTTPS，由控制台进程自己终结 TLS。

| 项 | 值 |
| --- | --- |
| 内部 CA | ECDSA P-256，有效期 10 年，首次启动生成；私钥信封加密后存入 `pki_authority` |
| 服务端证书 | 每次启动由内部 CA 签发，有效期 90 天；进程每小时检查一次，剩余不足三分之一时重新签发，新握手使用新证书，已建立的连接不受影响；SAN 包含 `EDGEWEIR_NODE_API_URL` 的主机名（未设置时为 `EDGEWEIR_PUBLIC_URL` 的主机名）、`EDGEWEIR_NODE_API_HOSTNAMES`、`localhost`、`127.0.0.1`、`::1` 与容器主机名 |
| 节点证书 | CN 为节点 ID，仅客户端认证，有效期 30 天；剩余不足三分之一时 `ReportStatus` 提示调用 `RenewCertificate` |
| 心跳 | 间隔 15 秒；`WatchConfig` 每 15 秒发送 keepalive |

注册顺序：

1. 平台管理员生成安装命令：一次性 token（有效期 5 分钟至 7 天，默认 60 分钟，库中只存 SHA-256）与内部 CA 的 SHA-256 指纹（`--ca-sha256`）。token 经 `EDGEWEIR_TOKEN` 环境变量传递。
2. 节点核对服务端证书链中的 CA 指纹，再发送 token 与本地生成的 CSR（`Enroll`）。
3. 控制台验证 CSR 签名，签发节点证书，在同一事务内把 token 标记为已用并写审计。

安装命令与 `install.sh` 的校验见 [接入节点](docs/deploy/nodes.md)。

控制台绝不保存 SSH 凭据；节点只经控制台生成的一次性安装命令接入，由节点主动注册。

除 `Enroll` 外的 RPC 都要求经内部 CA 校验的客户端证书，且序列号等于库中记录的当前序列号：证书轮换后旧证书立即失效，删除节点时序列号写入 `node_certificate_revocation`。停用或删除的节点每次 RPC 都被拒绝，打开的 `WatchConfig` 流随之关闭。

| RPC | 用途 |
| --- | --- |
| `Enroll` | 用一次性 token 和 CSR 换取节点证书 |
| `RenewCertificate` | 轮换节点证书 |
| `WatchConfig` | 服务端流：revision 通知、任务通知、keepalive |
| `GetConfig` | 快照或相对 `base_revision` 的 diff，附 revision 回执 |
| `ReportStatus` | 心跳、应用回执、源站被动健康状态与错误码 |
| `ReportStats`、`ReportStatsV2` | 按分钟预聚合的流量统计；按批次序号去重 |
| `ReportLogs` | 采样访问日志；按批次序号去重 |
| `GetOriginCredentials` | 本集群网站引用的 S3 源站密钥 |
| `GetCertificates` | 本集群网站引用的证书链与私钥 |
| `PullTasks`、`ReportTaskResult` | 刷新预热与升级任务 |

revision 回执由主密钥封装（用途 `node.revision_receipt`，绑定节点 ID），内容为集群、revision 与内容哈希。节点把回执保存在本地并在 `ReportStatus` 中带回；节点报告的已应用 revision 高于控制台最新 revision 且回执无效时，请求被拒绝。

## 证书与 DNS

`edgeweir-certd` 负责 ACME 签发、续期、吊销与 DNS 记录操作。

1. pg-boss 队列 `certificates.sweep` 每分钟选出待签发与到达 `renew_at` 的证书。
2. worker 启动 `EDGEWEIR_CERTD_BIN`（镜像内为 `/usr/local/bin/edgeweir-certd`），环境变量只保留 `PATH` 与 `EDGEWEIR_DNS_TEST_ENDPOINT`。
3. 向 stdin 写一行 JSON 请求（命令与参数，含 ACME 账户与 DNS 凭据）。certd 在 stdout 上逐行输出 JSON 事件（`account`、`http01.present`、`http01.cleanup`、`dns01.prepare`、`dns01.cleanup`），控制台处理后在 stdin 回复确认；最后一行为结果。
4. `http01.present` 的响应写入 `acme_challenge` 并发布新 revision，由节点应答。`dns01.prepare` 在 certd 写入 TXT 记录之前把清理责任登记到 `dns_challenge_lease`；完成、失败或重启后只清理本次操作写入的值。`account` 事件的 ACME 账户信封加密后写入 `certificate`。
5. 结果写回 `certificate`：证书链、指纹、到期时间、下次续期时间与信封加密的私钥；引用该证书的集群发布新 revision。

| 限制 | 值 |
| --- | --- |
| 单次调用时长 | 5 分钟，超时 `SIGKILL` |
| stdout 输出上限 | `dns.*` 命令 16 MiB，其他 2 MiB |
| stderr | 丢弃（依赖库的诊断信息可能包含凭据） |
| 命令 | `version`、`providers`、`obtain`、`renew`、`revoke`、`dns.list`、`dns.set`、`dns.present`、`dns.cleanup` |
| DNS 服务商 | `cloudflare`、`alidns`、`huaweicloud`、`dnspod` |

平台 DNS（`dns.reconcile`，每分钟）按健康节点与域名路由权计算记录，生成 `dns_revision`，写入 `platform_dns_provider` 指定的区域；写入外部记录之前先在 `dns_managed_name` 登记名称，部分写入可修复。域名路由权需要 TXT 校验（`_edgeweir-verification.<域名>`），状态存在 `domain_ownership`。行为说明见 [HTTPS 与证书](docs/guide/https.md) 与 [DNS 与告警](docs/guide/dns-and-alerts.md)。

## 统计、日志与告警

| 模式 | `EDGEWEIR_ANALYTICS` | 访问日志 | 分钟统计 | 图表与告警 |
| --- | --- | --- | --- | --- |
| lite（默认） | `lite` | PostgreSQL `access_log`，按 UTC 日分区 | PostgreSQL | PostgreSQL |
| ClickHouse | `clickhouse` | ClickHouse `access_log` | PostgreSQL，另写副本到 ClickHouse `minute_stats` | PostgreSQL |

访问日志按网站采样，采样率默认 0（关闭）。节点预聚合的分钟统计写入 `node_minute_stats`；worker 汇总到 `node_hour_stats` 与 `node_day_stats`，视图 `traffic_hour_stats` 合并已汇总与待汇总的数据。概览、网站统计与平台概览按 1 小时、6 小时、24 小时、7 天、30 天分桶查询（`date_bin`）；7 天与 30 天读取小时数据。

| 数据 | 保留 |
| --- | --- |
| 访问日志（PostgreSQL 与 ClickHouse） | 7 天 |
| 分钟统计（PostgreSQL 与 ClickHouse） | 7 天 |
| 小时统计 | 90 天 |
| 天统计 | 365 天 |

Compose profile `cache` 启动 Valkey；控制台目前未使用 Valkey。

告警（`alerts.sweep`，每分钟）检测节点离线、证书即将到期、源站不可用与 5xx 过高，生成 `alert_event`，按 `alert_subscription` 生成 `alert_delivery`，经 `alert_channel`（webhook 或邮件）发送；投递时重新检查成员资格、封禁状态、两步验证与渠道可见性。访问日志与 AccessKey 的使用见 [访问日志与 AccessKey](docs/guide/access-logs.md)。

## 后台任务

| 队列 | 调度 | 内容 |
| --- | --- | --- |
| `alerts.sweep` | 每分钟 | 告警检测与投递 |
| `dns.reconcile` | 每分钟 | 平台 DNS 发布与外部记录维护 |
| `traffic.rollup` | 每分钟 | 流量汇总与清理、访问日志分区维护、升级任务到期 |
| `certificates.sweep` | 每分钟 | 证书签发与续期 |
| `domains.enforce-ownership` | 启动时；完成后在 `system_setting` 记录 `domain_ownership_v1`，不再执行 | 为每个集群重新发布 revision，未校验的域名不再路由 |
| `maintenance.prune-revisions` | 每小时第 17 分 | 删除超出保留数量的 revision |
| `maintenance.expire-cache-tasks` | 每小时第 43 分 | 把超期未完成的刷新预热交付记为失败 |
| `maintenance.expire-enrollment-tokens` | 每 30 分钟 | 删除过期或使用超过 7 天的注册 token |

## 数据模型

表定义在 `packages/db/src/schema`；迁移为 drizzle-kit 生成的纯 SQL，位于 `packages/db/migrations`，控制台启动时执行（见 [启动顺序](#启动顺序)）。

### 身份与组织

| 表 | 内容 |
| --- | --- |
| `user` | 用户；`role` 含 `admin` 即平台管理员 |
| `session` | 登录会话 |
| `account` | 登录凭据（密码哈希） |
| `verification` | better-auth 验证记录 |
| `organization` | 组织，资源与权限边界 |
| `member` | 组织成员与角色 |
| `invitation` | 成员邀请（邀请人为用户或服务账号） |
| `two_factor` | TOTP 密钥与备用码 |
| `passkey` | passkey 公钥 |
| `apikey` | AccessKey：哈希、权限、启用状态 |
| `service_account` | 服务账号：名称、scope、启用状态（不能登录） |
| `service_account_key` | 服务账号 key 的 SHA-256、前缀、最后使用与吊销时间 |
| `idempotency_key` | `/api/v1` 写请求的幂等键：调用方、方法、路径、请求体哈希与最终响应，保留 24 小时 |
| `rate_limit` | 认证接口限速计数 |
| `organization_settings` | 组织默认集群、要求两步验证 |
| `organization_limit` | 组织技术限额（站点、域名、证书、IP 名单条目、清缓存频率、成员），空值为不限 |

### 基础设施

| 表 | 内容 |
| --- | --- |
| `region` | 区域字典 |
| `cluster` | 集群：共享一条 revision 序列的节点集合 |
| `node_group` | 节点组，可关联区域 |
| `node` | 节点：状态、能力清单、证书序列号与指纹、最近心跳 |
| `node_ip` | 节点上报的 IP 地址 |
| `enrollment_token` | 注册 token 的 SHA-256 与使用状态 |
| `node_certificate_revocation` | 删除节点时吊销的证书序列号 |
| `pki_authority` | 内部 CA，私钥信封加密 |
| `system_setting` | 平台键值设置：setup token、会话 secret 的 HMAC 校验值、源站允许清单、SMTP、节点发布源、DNS 解析器、告警策略、一次性迁移标记 |
| `audit_log` | 管理操作审计 |

### 网站与配置

| 表 | 内容 |
| --- | --- |
| `site` | 网站：所属组织与集群、启用状态、平台暂停（原因、备注）、缓存键、分片、WebSocket、证书、TLS 设置、缓存代际号、日志采样率 |
| `site_domain` | 网站域名与路由校验状态 |
| `site_star` | 用户星标 |
| `origin_pool` | 源站池：超时、keepalive、失败阈值、回源 TLS 校验 |
| `origin` | 源站 |
| `origin_credential` | S3 源站密钥，信封加密 |
| `cache_rule` | 缓存规则 |
| `edge_rule` | 网站或平台规则：阶段、表达式、动作、名单引用 |
| `ip_list` | 组织或平台 IP 名单（规范化 CIDR） |
| `config_revision` | 每个集群的 revision：序号、内容哈希、二进制 IR、原因码 |
| `node_config_status` | 节点应用回执与心跳，含回执验证标记 |

### 证书、DNS 与域名

| 表 | 内容 |
| --- | --- |
| `certificate` | 证书链、指纹、到期与续期状态；私钥与 ACME 账户信封加密 |
| `acme_challenge` | 短期公开的 HTTP-01 响应 |
| `dns_credential` | 组织的 DNS 服务商凭据，信封加密 |
| `dns_challenge_lease` | DNS-01 TXT 记录的清理责任 |
| `domain_ownership` | 域名归属校验 |
| `platform_dns_provider` | 平台 DNS 服务商与区域，凭据信封加密 |
| `dns_state` | 平台 DNS 策略与期望 / 已应用的 DNS revision |
| `dns_revision` | DNS revision：记录集、托管名称、状态 |
| `dns_managed_name` | 已登记的托管 DNS 名称 |

### 统计、日志、任务与告警

| 表 | 内容 |
| --- | --- |
| `node_minute_stats` | 按节点、网站、分钟的流量统计 |
| `node_hour_stats` | 小时汇总 |
| `node_day_stats` | 天汇总 |
| `stats_rollup_dirty` | 待重新汇总的时间桶 |
| `node_stats_cursor` | 每个节点统计批次的序号高水位 |
| `access_log` | 采样访问日志，按 UTC 日分区 |
| `node_log_cursor` | 每个节点日志批次的序号高水位 |
| `origin_health` | 节点上报的源站被动健康状态与错误码 |
| `cache_task` | 刷新预热任务 |
| `cache_task_node` | 任务在每个节点上的交付与结果 |
| `node_upgrade` | 节点升级任务 |
| `node_upgrade_delivery` | 升级在每个节点上的阶段、状态与健康观察 |
| `alert_channel` | 告警渠道，配置信封加密 |
| `alert_subscription` | 用户按网站与渠道的订阅 |
| `alert_state` | 告警当前状态 |
| `alert_event` | 告警事件，带顺序号 |
| `alert_delivery` | 事件在渠道上的投递与重试 |

视图 `traffic_hour_stats` 合并小时汇总与尚未汇总的分钟数据，不重复计数。

### 迁移

| 迁移 | 变更 |
| --- | --- |
| `0000_init` | 初始 schema：better-auth 表、集群、节点组、节点、注册 token、网站、域名、源站池、源站、缓存规则、revision、节点状态、分钟统计、内部 CA、审计日志 |
| `0001_m1` | `region`、`organization_settings`、`system_setting`、`node_certificate_revocation`；revision 原因码；审计的操作者与目标名称；节点组关联区域 |
| `0002_site_star` | `site_star` |
| `0003_m2` | `origin_credential`、`origin_health`、`cache_task`、`cache_task_node`；源站池超时、keepalive 与 TLS 校验；缓存规则扩展；网站缓存键、分片与 WebSocket |
| `0004_wrapup_auth` | `rate_limit` |
| `0005_wrapup_console` | 缓存规则 `cache_authorized`；任务来源；任务与源站健康的错误码 |
| `0006_m3_certificates` | `certificate`、`dns_credential`、`acme_challenge`；节点能力清单；网站证书与 TLS 设置 |
| `0007_m3_challenge_attempts` | `acme_challenge.operation_started_at` |
| `0008_m3_dns_cleanup` | `dns_challenge_lease` |
| `0009_m4_rules` | `edge_rule`、`ip_list` |
| `0010_m5_stats` | `node_stats_cursor`、`node_hour_stats`、`node_day_stats`、`stats_rollup_dirty`、视图 `traffic_hour_stats`；分钟统计的 Top URL 与 Top IP |
| `0011_m5_domain_ownership` | `domain_ownership`；`site_domain.verified` |
| `0012_m5_dns` | `platform_dns_provider`、`dns_state`、`dns_revision`、`dns_managed_name` |
| `0013_m5_dns_managed_names` | `dns_revision.managed_names` |
| `0014_m5_alerts` | `alert_channel`、`alert_subscription`、`alert_state`、`alert_event`、`alert_delivery` |
| `0015_m5_alert_order` | `alert_event.ordinal` |
| `0016_m5_alert_privacy_default` | `alert_channel.platform` 默认为 `false`（平台全量通知默认关闭） |
| `0017_m6_logs` | `access_log`、`node_log_cursor`；`site.log_sample_rate` |
| `0018_retain_node_traffic` | 流量统计表去掉对 `node` 的外键；删除节点保留网站统计 |
| `0019_m6_upgrades` | `node_upgrade`、`node_upgrade_delivery` |
| `0020_m6_upgrade_health` | `node_upgrade_delivery.healthy_since` |
| `0021_authenticated_revision_floor` | `node_config_status.revision_receipt_verified` |
| `0022_bound_traffic_counters` | 既有流量计数截断到 0 至 2^53−1 |
| `0023_p0_site_state` | `site.suspended`、`suspend_reason`、`suspend_note`、`suspended_at`（平台暂停） |
| `0024_p0_organization_limits` | `organization_limit` |
| `0025_p0_service_accounts` | `service_account`、`service_account_key`、`idempotency_key`；`invitation.inviter_id` 可空，新增 `inviter_service_account_id` |

## 构建产物

| 步骤 | 输出 |
| --- | --- |
| `vite build` | `apps/console/dist/web`（SPA） |
| `node scripts/build-server.mjs`（esbuild） | `apps/console/dist/server/main.js`：服务端与全部依赖打成单个 ESM 文件；复制 `install/` 到 `dist/server/install`，迁移到 `dist/migrations` |
| Dockerfile 阶段 `certd` | `golang:1.27.1-alpine` 构建 `edgeweir-certd` |
| Dockerfile 阶段 `build` | `node:24.21.0-alpine`、pnpm 12.6.0 构建控制台 |
| Dockerfile 阶段 `runtime` | `node:24.21.0-alpine` + tini；无 `node_modules`；以 `node` 用户运行；`EXPOSE 3000 8443`；健康检查 `edgeweir-healthcheck` |

基础镜像按 tag 与多架构 index digest 固定。镜像版本号为 `<YYYYMMDD>-<commit>`（`scripts/image-version.sh`），写入 `EDGEWEIR_VERSION` 与镜像标签 `org.opencontainers.image.version`；完整提交 ID 写入 `org.opencontainers.image.revision`。开发命令与测试见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 可观测性

| 项 | 行为 |
| --- | --- |
| 日志 | 每个事件一行 JSON；`warn`、`error` 写 stderr，其余写 stdout；级别由 `LOG_LEVEL` 控制 |
| `/healthz` | 返回状态与版本号 |
| 容器健康检查 | `ROLE=worker` 只检查进程存活；其他角色请求 `http://127.0.0.1:${PORT}/healthz` |
| 节点状态 | 在线状态、已应用 revision、数据面健康、源站健康来自 `node_config_status` 与 `origin_health` |
