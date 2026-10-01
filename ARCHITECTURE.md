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
| 节点 | [edgeweir-node](https://github.com/marvinli001/edgeweir-node) | Go agent 与 OpenResty 数据面；经节点通道拉取配置与任务，上报状态、主机指标、统计与日志 |
| 区域探针 | [edgeweir-node](https://github.com/marvinli001/edgeweir-node)（`probe` 模式） | 不运行 OpenResty；从所在区域探测节点的调度地址，经节点通道的 `ProbeService` 上报 |

```text
控制台（ROLE=app|worker|all）
├── :3000  HTTP ◀── 浏览器、API 调用方
├── :8443  Connect-RPC（TLS + mTLS）◀── edgeweir-node agent ── OpenResty ──▶ 源站
│                                    ◀── edgeweir-node probe（区域探针）──▶ 节点的监听端口
├── SQL、LISTEN/NOTIFY ──▶ PostgreSQL 18
├── HTTP（可选）──▶ ClickHouse
└── 子进程 stdin/stdout ──▶ edgeweir-certd ──▶ ACME CA、DNS 服务商 API
```

控制台与节点之间唯一的契约是 `proto/` 中的 `edgeweir.node.v1`（当前 tag `proto/v0.14.0`）。开源核心与商业产品的边界见 [LICENSING.md](LICENSING.md)。

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
| `packages/rule-engine` | 规则表达式的字段、阶段、函数、解析（条件、值表达式、缓存规则条件）、名单引用绑定与参考求值 |
| `packages/proto` | 由 `proto/` 生成的 TypeScript（protoc-gen-es），不手改 |
| `proto/` | buf 模块 `edgeweir/node/v1/{node,config,probe}.proto`；edgeweir-node 从 `proto/vX.Y.Z` tag 生成 Go 代码 |
| `helpers/certd` | `edgeweir-certd` 源码 |
| `helpers/http3probe` | CI 使用的 HTTP/3 探测程序 |
| `Dockerfile`、`docker/` | 镜像构建、容器健康检查脚本、端到端测试夹具 |
| `compose*.yml`、`deploy.sh` | `compose.yml`（生产）、`compose.baota.yml` 与 `compose.baota-host.yml`（宝塔 / aaPanel）、`compose.dev.yml`（开发数据库）、`compose.e2e.yml`（端到端）；`deploy.sh` 为宝塔 / aaPanel 安装与升级脚本 |
| `scripts/` | `e2e.sh`（端到端测试）、`image-version.sh`（滚动版本号）、`bench.sh`（缓存命中、持有通行凭证与挑战页的性能基线） |
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

收到 `SIGTERM` 或 `SIGINT` 时，同时停止 HTTP 与节点通道监听、结束节点的配置监视流并停止 pg-boss：进行中的请求最多再处理 3 秒，pg-boss 最多等待 5 秒完成当前任务，随后关闭数据库连接池。整个过程超过 8 秒时进程以 1 退出。

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
| 入口 | `/`（按状态跳转到 `/setup`、`/overview` 或 `/login`）、`/setup`、`/login` | 所有人 |
| 控制台 | 网站：`/overview`、`/sites`、`/certificates`、`/purge`；访问控制：`/ip-lists`、`/bans`、`/rules`；基础设施：`/clusters`、`/regions`、`/dns`；系统：`/alerts`、`/service-accounts`、`/audit`、`/system`；账户（用户菜单）：`/security`、`/settings` | 登录的运营者 |

## 认证与授权

| 入口 | 凭据 | 规则 |
| --- | --- | --- |
| `/api/auth/*` | 邮箱与密码、TOTP、备用码、passkey | 只放行 `lib/auth.ts` 中 `AUTH_HTTP_ROUTES` 列出的方法与路径（会话、登录、登出、改密码、两步验证、passkey），其余 404；请求中的 `x-api-key` 被丢弃；关闭公开注册，唯一的账号由初始化向导创建；密码至少 12 位 |
| `/rpc/*` | 会话 cookie + `x-csrf-token` | 请求中的 `x-api-key` 被丢弃 |
| `/api/v1/*` | `x-api-key`（AccessKey 或服务账号 key） | cookie 被丢弃；AccessKey 以账号本人身份执行，权限与会话相同；只读 AccessKey 只能调用 GET 过程与 `rules.validate`；服务账号只能调用 `serviceAccountProcedures` 列出且 scope 允许的过程 |
| `:8443` | 客户端证书 | 见 [节点通道](#节点通道) |

端点、OpenAPI 文档与 AccessKey 的细节见 [API 与端点](docs/reference/api.md)。控制台只有一个运营者账号，不分组织与角色：除 `system.status`、`system.setup` 外，所有过程都经 `rpc/base.ts` 的 `authed`（有效会话、启用中的 AccessKey 或服务账号 key）。

客户端 IP（审计日志、登录限速）取 TCP 对端地址；`X-Forwarded-For` 与 `X-Real-IP` 只在对端属于 `EDGEWEIR_TRUSTED_PROXIES` 时采用（`resolveClientIp`）。认证接口的限速计数存在 `rate_limit` 表，多实例共享。经 better-auth 完成的登录与账号变更由 `lib/auth-audit.ts` 的钩子写审计。

账号找回没有 HTTP 入口，只在服务器上进行：`dist/server/recover.js`（`services/recovery.ts`）读取控制台的环境变量，在一个事务中重置密码（better-auth 的 `password.hash`）、停用两步验证、删除账号的会话与进行中的两步验证登录，并写入审计 `account.recover`（[命令行](docs/reference/cli.md#找回账户)）。

## 配置发布

改变节点配置的操作在一个事务内完成：

1. 写业务表（网站、域名、源站、缓存规则、规则、IP 名单、证书、ACME HTTP-01 响应、源站允许清单、全站清除缓存的代际号）。
2. `publishRevision()` 对集群加 advisory lock，读取该集群启用的网站、全局规则、全部 IP 名单、源站允许清单、证书引用与未过期的 HTTP-01 响应，`compileNodeConfig()` 生成规范化的 NodeConfig IR。
3. 计算 `content_hash`：`revision` 与 `content_hash` 置空后二进制编码的 SHA-256。与上一版相同则不产生新 revision。
4. 新 revision 号为「库中最新 revision」与「本集群节点经验证的最高已应用 revision」中较大者加一；数据库从备份恢复后 revision 不回退。
5. 写入 `config_revision`，同一事务内 `pg_notify('edgeweir_config', …)`，再写审计。
6. 提交后，每个 `app` 实例经 LISTEN 收到通知，推给该集群节点的 `WatchConfig` 流。
7. 节点调用 `GetConfig(base_revision=已应用 revision)` 取得 diff 或快照与 revision 回执，校验哈希，落盘为 last-known-good，应用到 OpenResty，以 `ReportStatus` 回报。
8. 控制台在 `node_config_status` 记录每个节点已应用的 revision 与心跳；45 秒内有心跳即为在线。

| 约束 | 值 |
| --- | --- |
| 每个集群的启用网站 | 最多 512 个（`MAX_SITES_PER_CLUSTER`），超出返回 `CLUSTER_SITE_LIMIT` |
| 新增节点能力 | 发布需要活动节点尚不支持的能力时，服务账号与后台任务的发布返回 `NODE_CAPABILITY_REQUIRED`，运营者本人（会话或 AccessKey）可以发布；`GetConfig` 对缺少所需能力的节点返回 `FailedPrecondition` |
| revision 保留 | 每个集群保留最新 200 个，每小时清理 |
| 回滚 | 以旧 revision 的 IR 发布新 revision，源站允许清单取当前值，审计动作 `cluster.rollback` |

revision 原因是代码（`revision_reason_<code>`），定义在 `packages/contract/src/errors.ts`。规则语言见 [规则](docs/guide/rules.md)。

## 节点任务

URL、目录、Host、Cache-Tag、整站刷新与 URL、站点地图预热不产生 revision，以类型化任务下发：

1. `cacheTasks.create` 写入 `cache_task`，为每个启用节点写入 `cache_task_node`（停用节点记为跳过），`pg_notify('edgeweir_tasks', …)`。
2. `WatchConfig` 流发出 `WATCH_EVENT_TASKS`。
3. 节点以 `PullTasks` 拉取，以 `ReportTaskResult` 回报结果。
4. 交出 5 分钟后没有结果的任务再次交出；7 天未完成记为失败。节点重新连接时，控制台为其错过的清缓存按网站补发整站刷新。

Host 与 Cache-Tag 刷新需要节点能力 `purge-tag-v1`，移动端与站点地图预热需要 `prefetch-v2`；受影响集群有活动节点缺少能力时，控制台拒绝创建任务（`NODE_CAPABILITY_REQUIRED`）。节点用刷新标记的时间点与缓存对象的 `Cache-Tag` 索引计算缓存键，被刷新的对象（包括过期内容）不再被查找；站点地图由节点经本机边缘层取回。行为说明见 [源站与缓存](docs/guide/origins-and-cache.md#刷新与预热)。

节点升级同样经 `PullTasks` 下发：升级任务先在一个节点组试运行，健康观察通过后推进，其余节点每批最多四分之一，每个任务下发后 30 分钟内须完成。节点拉取任务时先不加锁检查有没有自己的升级任务，有才取集群的升级锁。行为说明见 [节点升级](docs/guide/node-upgrades.md)。

## 动态封禁

IP 封禁（`ip_ban`）不产生 revision，也不经配置金丝雀，经节点通道单独下发：

1. 每次写入（新建、再次封禁、解封、自动封禁的写入与超额移除）在同一个事务级 advisory lock 下取 `nextval('ip_ban_seq')` 作为该行的 `seq`，提交顺序与序号顺序一致；同一事务内 `pg_notify('edgeweir_bans', …)`（载荷为受影响的集群，平台封禁为全部）。手动操作写审计 `ban.create`、`ban.update`、`ban.delete`。
2. 具备 `bans-v1` 的节点在 `WatchConfig` 流建立时与每次通知后收到 `WATCH_EVENT_BANS`（`ban_sequence` 为序列当前值）。
3. 节点调用 `GetBans(after_sequence)`：从 0 或从大于序列当前值的序号（数据库恢复后）开始时返回快照（`reset`），否则返回之后变化的有效封禁与已解封的 id；到期的封禁不返回，节点按到期时间失效。读取先取同一把锁的共享模式，序列当前值不会越过未提交的写入。每页默认 2000 条、最多 5000 条；`sequence` 为本页最大序号，最后一页为序列当前值。
4. 节点以 `ReportBans` 上报自己产生的自动封禁（每次最多 1000 条），控制台按（节点、网站、地址）合并；以 `ReportStatus.bans` 上报已应用序号、容量与未生效的封禁，保存在 `node.ban_status`。

| 限制 | 值 |
| --- | --- |
| 前缀下限 | IPv4 `/16`，IPv6 `/48` |
| 有效期 | 1 分钟到 7 天；到期一小时后由 `maintenance.prune-bans` 删除 |
| 数量 | 平台手动封禁上限（系统设置，默认 10000）；每个集群最多 10000 条自动封禁 |

行为见 [封禁](docs/guide/bans.md)。

## 挑战与 CC 防护

挑战、Under Attack 与分级 CC 由节点在本地执行，控制台负责配置、密钥与事件：

1. 网站的防护（`site_protection`）、全局 Under Attack（系统设置 `protection_settings`）与 CC 模板（`cc_template`）编译进 NodeConfig。只有集群用到挑战（全局 Under Attack、网站 Under Attack、启用的 CC 策略或 `challenge` 规则）时，IR 才带 `challenge_keys`、`platform_protection` 与每个网站的 `protection`，`required_features` 加 `challenge-v1`；只开 JA4 日志的网站单独带 `protection`。规则读取 `tls.ja4`（或按它限速）、网站记录 JA4 时加 `ja4-v1`。其余集群的内容哈希不变。
2. 通行凭证的 HMAC 密钥按集群，每个集群三把（`next`、`current`、`previous`），集群第一次用到挑战时创建。IR 只含密钥 id 与角色（按 id 排序）；节点以 `GetChallengeKeys` 取得 32 字节的密钥，只能取到本集群的。密钥在第一次被取用时生成，以信封加密保存（用途 `challenge_key.secret`，绑定行 id）。
3. `maintenance.rotate-challenge-keys` 每小时检查一次，最新的密钥满一天就轮换：`previous` 删除、`current` 变 `previous`、`next` 变 `current`、新建 `next`；最新 revision 带密钥的集群发布新 revision（原因 `challenge_keys_rotated`），审计 `cluster.challenge_keys_rotate`。
4. 节点以 `ReportSecurityEvents` 上报级别变化、路径升降级与自动封禁（每次最多 500 条），控制台按（节点、事件 id）幂等写入 `security_event`；网站从正常升级时触发告警 `cc_mitigation`，同一网站 15 分钟内最多一次。心跳的 `ReportStatus.security` 保存在 `node.security_state`。`maintenance.prune-security-events` 按保留天数（默认 30 天）删除事件。

| 管理操作 | 审计 |
| --- | --- |
| 修改网站防护 | `site.protection_update`（发布该网站的集群） |
| 全局 Under Attack、事件保留天数 | `system.protection_update`（Under Attack 变化时发布全部集群） |
| CC 模板 | `system.cc_template_update`（发布有网站跟随模板的集群） |

行为见 [挑战与 CC 防护](docs/guide/challenges.md)。

## 压缩与 OWASP CRS

节点以为 Edgeweir 构建的 OpenResty（`edgeweir-openresty`，可选模块 `edgeweir-openresty-modsecurity`）执行压缩与 CRS，按实际构建上报 `brotli-v1`、`zstd-v1`、`modsecurity-v1`。控制台负责设置、能力门槛与命中统计：

1. 网站的 Brotli、Zstandard 设置与 Gzip 一起保存在 `site.tls_settings`，编译进 `TlsOptions`；只有开启的算法带级别、最小长度与类型（类型排序去重），未开启时内容哈希不变。有启用网站开启时 `required_features` 加 `brotli-v1` / `zstd-v1`。
2. 网站的 CRS 设置保存在 `site_waf`；模式不为关闭时编译为 `Site.waf`（排除的规则 id 升序去重），`required_features` 加 `modsecurity-v1`。
3. 与其他能力相同，引入集群活动节点缺少的能力时，服务账号与后台任务的发布返回 `NODE_CAPABILITY_REQUIRED`，运营者本人可以发布。`sites.features` 按网站给出三项功能能否开启（原因 `nodes`），界面据此禁用开关。回滚按保留的网站重新计算这三项能力。
4. `ReportStats` 的 `waf_rules`（规则 id → 请求数）按节点、网站、分钟最多保留 50 条，与其他分钟统计一起汇总到小时和天，并写入 ClickHouse `minute_stats` 副本；`waf.topRules` 按时间范围汇总。访问日志保存命中的规则 id（最多 16 个，升序）与 `waf_blocked`（PostgreSQL、ClickHouse、CSV）。

| 管理操作 | 审计 |
| --- | --- |
| 修改网站 HTTPS 与压缩 | `site.https_update`（发布该网站的集群） |
| 修改网站 CRS | `site.waf_update`（发布该网站的集群，原因 `site_waf_updated`） |

行为见 [HTTPS 与证书](docs/guide/https.md#压缩) 与 [OWASP CRS 托管规则](docs/guide/waf.md)。

## 规则引擎扩展

控制台是表达式语法的唯一权威：`packages/rule-engine` 解析条件与值表达式，`packages/config-compiler` 输出类型化 IR；节点逐项校验 IR 后执行，不接收表达式文本。函数、值表达式、批量重定向、源站组、缓存规则条件与新的规则动作由节点能力 `rules-v2` 标明：

1. 函数调用编码为 `RuleExpression` 的 `call`、`field`、`const` 节点。重定向目标与改写路径的值表达式写入 `RuleAction.target`；`set_query` 按名称排序，`remove_query` 排序去重；`preserve_query` 只在与动作默认值不同时写入。
2. 缓存规则以表达式保存（`cache_rule.expression`，引用的名单记在 `list_ids`）。构建器形状的表达式编译为原来的 `path_prefixes`、`paths`、`extensions`，旧节点照常执行，内容哈希不变；其他表达式编译为 `CacheRuleMatch.condition`。`browser_ttl_seconds` 写入 `CacheRule`。
3. 批量重定向编译为 `Site.bulk_redirects`（按来源排序），源站组写入 `Origin.group`。
4. 配置用到上述任何一项（含 `compression` 阶段与 `config` 动作的新字段）时 `required_features` 加 `rules-v2`；没有用到的配置与之前编码相同。与其他能力相同，服务账号与后台任务的发布引入集群活动节点缺少的 `rules-v2` 时返回 `NODE_CAPABILITY_REQUIRED`，运营者本人可以发布；`sites.features` 的 `rulesV2` 供界面锁定相关控件。

| 管理操作 | 审计 |
| --- | --- |
| 修改网站规则 | `site.rules_update`（发布该网站的集群，原因 `rules_updated`） |
| 修改全局规则 | `platform.rules_update`（发布全部集群） |
| 修改批量重定向 | `site.bulk_redirects_update`（发布该网站的集群，原因 `rules_updated`） |

行为见 [规则、IP 名单与 GeoIP](docs/guide/rules.md) 与 [源站与缓存](docs/guide/origins-and-cache.md)。

## 节点通道

Connect-RPC over HTTPS，由控制台进程自己终结 TLS。

| 项 | 值 |
| --- | --- |
| 内部 CA | ECDSA P-256，有效期 10 年，首次启动生成；私钥信封加密后存入 `pki_authority` |
| 服务端证书 | 每次启动由内部 CA 签发，有效期 90 天；进程每小时检查一次，剩余不足三分之一时重新签发，新握手使用新证书，已建立的连接不受影响；SAN 包含 `EDGEWEIR_NODE_API_URL` 的主机名（未设置时为 `EDGEWEIR_PUBLIC_URL` 的主机名）、`EDGEWEIR_NODE_API_HOSTNAMES`、`localhost`、`127.0.0.1`、`::1` 与容器主机名 |
| 节点证书 | CN 为节点 ID，仅客户端认证，有效期 30 天（服务端证书与节点证书都从签发前 1 小时起生效，容忍节点时钟偏慢）；剩余不足三分之一时 `ReportStatus` 提示调用 `RenewCertificate`。续期后旧证书（`node.previous_cert_serial`）继续有效，直到节点第一次用新证书认证；未装上新证书的节点用旧证书再次续期。已停用的节点也可以续期，其他调用仍被拒绝 |
| 探针证书 | CN 为探针 ID，`O=Edgeweir Probe`（节点证书为 `O=Edgeweir Node`），仅客户端认证，有效期 30 天；剩余不足三分之一时 `GetProbeTargets` 提示调用 `RenewProbeCertificate`，续期后旧证书的处理与节点相同。节点通道按组织区分：探针证书只能调用 `ProbeService`，`NodeService` 拒绝一切非节点证书；节点证书只在节点兼任探针时调用 `GetProbeTargets`、`ReportProbeResults`，不能注册或续期探针 |
| 心跳 | 间隔 15 秒；`WatchConfig` 每 15 秒发送 keepalive |

注册顺序：

1. 运营者生成安装命令：一次性 token（有效期 5 分钟至 7 天，默认 60 分钟，库中只存 SHA-256）与内部 CA 的 SHA-256 指纹（`--ca-sha256`）。token 经 `EDGEWEIR_TOKEN` 环境变量传递。
2. 节点核对服务端证书链中的 CA 指纹，再发送 token 与本地生成的 CSR（`Enroll`）。
3. 控制台验证 CSR 签名，签发节点证书，在同一事务内把 token 标记为已用并写审计。

安装命令与 `install.sh` 的校验见 [接入节点](docs/deploy/nodes.md)。

控制台绝不保存 SSH 凭据；节点只经控制台生成的一次性安装命令接入，由节点主动注册。

除 `Enroll`、`EnrollProbe` 外的 RPC 都要求经内部 CA 校验的客户端证书，且序列号等于库中记录的当前序列号：证书轮换后旧证书立即失效，删除节点或探针时序列号写入 `node_certificate_revocation`。停用或删除的节点每次 RPC 都被拒绝，打开的 `WatchConfig` 流随之关闭；停用的探针只能续期证书。

| RPC | 用途 |
| --- | --- |
| `Enroll` | 用一次性 token 和 CSR 换取节点证书 |
| `RenewCertificate` | 轮换节点证书 |
| `WatchConfig` | 服务端流：revision 通知、任务通知、封禁通知（`bans-v1`）、keepalive |
| `GetConfig` | 快照或相对 `base_revision` 的 diff，附 revision 回执 |
| `ReportStatus` | 心跳、应用回执、源站健康状态与错误码（被动检查与主动检查分别上报）、封禁状态、主机指标（`metrics-v1`）；响应的 `probe` 告诉节点是否兼任探针 |
| `ReportStats`、`ReportStatsV2` | 按分钟预聚合的流量统计；按批次序号去重 |
| `ReportLogs` | 采样访问日志；按批次序号去重 |
| `GetOriginCredentials` | 本集群网站引用的 S3 源站密钥 |
| `GetCertificates` | 本集群网站引用的证书链与私钥 |
| `PullTasks`、`ReportTaskResult` | 刷新预热与升级任务 |
| `GetBans`、`ReportBans` | 按序号增量拉取本集群的封禁；上报节点的自动封禁 |
| `EnrollProbe`（`ProbeService`） | 用一次性探针 token（`ewp_`）和 CSR 换取探针证书；与 `Enroll` 相同的请求大小限制，token 只在注册成功时消耗 |
| `RenewProbeCertificate` | 轮换探针证书（节点经 `RenewCertificate`） |
| `GetProbeTargets` | 探测目标（节点、地址、端口、方式、PROXY protocol）、间隔、超时与尝试次数 |
| `ReportProbeResults` | 一轮探测结果，每次至多 10000 条；之后立即对涉及的集群求值 |

revision 回执由主密钥封装（用途 `node.revision_receipt`，绑定节点 ID），内容为集群、revision 与内容哈希。节点把回执保存在本地并在 `ReportStatus` 中带回；节点报告的已应用 revision 高于控制台最新 revision 且回执无效时，请求被拒绝。

## 证书与 DNS

`edgeweir-certd` 负责 ACME 签发、续期、吊销与 DNS 记录操作。

1. pg-boss 队列 `certificates.sweep` 每分钟选出待签发与到达 `renew_at` 的证书（新申请与手动续期在前，其余按 `renew_at`，同时处理 3 张）。失败后按剩余有效期退避（十分之一，10 分钟到 12 小时；首次签发 1 小时）。已签发的证书按 CA 的 Retry-After（1 到 24 小时，默认 6 小时）查询 ARI 续期窗口，窗口早于 `renew_at` 时提前续期。
2. worker 启动 `EDGEWEIR_CERTD_BIN`（镜像内为 `/usr/local/bin/edgeweir-certd`），环境变量只保留 `PATH` 与 `EDGEWEIR_DNS_TEST_ENDPOINT`。
3. 向 stdin 写一行 JSON 请求（命令与参数，含 ACME 账户与 DNS 凭据）。certd 在 stdout 上逐行输出 JSON 事件（`account`、`http01.present`、`http01.cleanup`、`dns01.prepare`、`dns01.cleanup`），控制台处理后在 stdin 回复确认；最后一行为结果。
4. `http01.present` 一次带上订单的全部 HTTP-01 挑战：写入 `acme_challenge`，每个相关集群只发布一个 revision，等节点应用后 certd 再请 CA 验证（同时 4 个）；`http01.cleanup` 只删行，不发布（挑战到期或本次操作结束后，节点与下一个 revision 都不再带它）。挑战 revision 不计入 200 个保留数，一小时后删除。`dns01.prepare` 在 certd 写入 TXT 记录之前把清理责任登记到 `dns_challenge_lease`；完成、失败或重启后只清理本次操作写入的值。`account` 事件的 ACME 账户信封加密后写入 `acme_account`，同一目录、EAB key id 与邮箱的证书共用一个账户。
5. 结果写回 `certificate`：证书链（只存证书）、指纹、到期时间、下次续期时间与信封加密的私钥（PKCS #8）；引用该证书的集群发布新 revision。

| 限制 | 值 |
| --- | --- |
| 单次调用时长 | `dns.*` 5 分钟，其他 8 分钟，超时 `SIGKILL` |
| stdout 输出上限 | `dns.*` 命令 16 MiB，其他 2 MiB |
| stderr | 丢弃（依赖库的诊断信息可能包含凭据） |
| 命令 | `version`、`providers`、`obtain`、`renew`、`revoke`、`renewal-info`、`dns.list`、`dns.set`、`dns.present`、`dns.cleanup`、`dns.zones`、`dns.test` |
| DNS 服务商 | 服务商目录 `helpers/certd/catalog.json`，见 [服务商与凭据](docs/guide/dns-and-alerts.md#服务商与凭据) |

DNS 调度按集群绑定（`dns_binding`，模式为不管理、手动或自动）：`dns.reconcile` 每分钟按健康节点与网站域名计算每个自动模式集群的记录（每个集群一份地址记录，`all.<域名>` 按解析线路各一组，每个网站一条 CNAME；节点地址与备用节点组见[区域探针与智能调度](#区域探针与智能调度)），生成该集群的 `dns_revision`，写入绑定所选服务商账号（`platform_dns_provider`）的区域；各集群各自发布与对账，一个服务商不可用不影响其他集群；同一集群同一时间只有一个进程在写（`dns_lease`）。节点在新版本发布后 2 分钟内应用期间保留在记录中。写入外部记录之前先在 `dns_managed_name` 登记名称，部分写入可修复；新记录先于被替换的记录写入。手动模式只生成需要手动创建的记录与 zone 文件，不写 DNS。DNS 调度的服务商账号与 DNS-01 凭据使用同一份服务商目录。网站的域名保存后即参与路由，一个域名只属于一个网站。行为说明见 [HTTPS 与证书](docs/guide/https.md) 与 [DNS 调度与告警](docs/guide/dns-and-alerts.md)。

## 区域探针与智能调度

1. 探测方：区域探针（`probe`，`edgeweir-node probe` 以一次性 `probe_token` 经 `EnrollProbe` 注册），或 `node.probe_enabled` 且节点组有区域的节点（`ReportStatus` 响应 `probe=true`）。
2. `GetProbeTargets` 返回每个启用节点的调度地址（`node_ip`：有 `configured` 行时只用它们及其级别，否则 `reported` 的公网地址）× 集群最新 revision 的监听端口，附探测间隔、超时与尝试次数；集群全部活动节点具备 `probe-health-v1` 时 HTTP / HTTPS 监听以健康端点探测，否则只做 TCP。兼任探针的节点不探测自己。
3. `ReportProbeResults` 只接受当前目标，写入 `probe_result`（每个探测方、节点、地址、端口一行，最新值），1 小时未更新的行删除。
4. 每 10 秒（worker 进程内定时器，租约保证同一时间一个进程）与每次探针上报后（每集群每进程至多每 2 秒），每个集群在事务内（advisory lock）求值：先按窗口（3 个探测间隔，至少 15 秒）内的结果更新 `node_address_state`（严格多数的探测方失败持续 `ipDownSeconds` 记为不可达，持续 `ipUpSeconds` 不失败恢复），再对每条 `scheduling_rule` 与节点推进 `scheduling_state`（条件成立起点、动作起点、解除起点）。
5. 地址级别变化发布集群的 DNS revision（原因 `health`）。规则的生效与恢复各发布一个（原因 `scheduling`，`reason_params` 为规则、节点、动作与事件），以系统身份写审计 `scheduling.activate` / `scheduling.recover`，并触发或解除平台告警 `scheduling_action`。发布了 revision 的集群随即写入 DNS。
6. `compileBindingPlan` 以节点的有效级别（最低的可达级别，`backup_ip` 动作至少备 1）、规则的摘除与线路的备用节点组（健康地址少于 `minHealthyIps` 或 `backup_group` 动作）计算每条绑定线路的地址，`all.<域名>` 按解析线路写入。大面积摘除保护按名称、类型与解析线路比较，备用节点组的切换只在清空记录集时计入。

节点指标（`ReportStatusRequest.metrics`，`metrics-v1`）保存在 `node.metrics`，只有最新值；调度把 60 秒前的指标视为缺失。

| 管理操作 | 审计 |
| --- | --- |
| 探针令牌、改名与启停、删除（吊销证书） | `probe.token_create`、`probe.update`、`probe.delete` |
| 探针注册与证书续期 | `probe.enroll`、`probe.certificate_renew`（操作者为探针） |
| 探测设置 | `system.probes_update` |
| 调度地址、兼任探针 | `node.set_addresses`（发布集群 DNS，原因 `manual`）、`node.set_probe` |
| 调度规则 | `scheduling.rule_create`、`scheduling.rule_update`、`scheduling.rule_delete`（停用、删除或改变线路、条件、动作时先结束生效中的动作） |

行为见 [区域探针与智能调度](docs/guide/scheduling.md)。

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

告警（`alerts.sweep`，每分钟）检测节点离线、证书即将到期、源站不可用与 5xx 过高（CC 防护升级 `cc_mitigation` 由节点事件触发，节点不再报告升级后恢复），生成 `alert_event`，按 `alert_subscription` 生成 `alert_delivery`，经 `alert_channel`（webhook、邮件、钉钉、企业微信或 Telegram）发送；投递时重新检查渠道是否启用与订阅是否仍然有效，「接收所有告警」的渠道接收全部告警。集群告警（配置金丝雀回滚、DNS 大面积摘除被阻止、调度规则作用于节点 `scheduling_action` 等）由各自的流程触发与解除，只投递到「接收所有告警」的渠道。访问日志与 AccessKey 的使用见 [访问日志与 AccessKey](docs/guide/access-logs.md)。

## 后台任务

| 队列 | 调度 | 内容 |
| --- | --- | --- |
| `alerts.sweep` | 每分钟 | 告警检测与投递 |
| `dns.reconcile` | 每分钟 | DNS 调度发布与外部记录维护 |
| `traffic.rollup` | 每分钟 | 流量汇总与清理、访问日志分区维护、升级任务到期 |
| `certificates.sweep` | 每分钟 | 证书签发与续期 |
| `maintenance.recompile` | 启动时；`system_setting` 的 `config_recompiled` 与当前标记一致时跳过 | 升级改变了已存数据的编译结果时，为每个集群重新发布一次 revision |
| `maintenance.prune-revisions` | 每小时第 17 分 | 删除超出保留数量的 revision |
| `maintenance.expire-cache-tasks` | 每小时第 43 分 | 把超期未完成的刷新预热交付记为失败 |
| `maintenance.expire-enrollment-tokens` | 每 30 分钟 | 删除过期或使用超过 7 天的注册 token |
| `maintenance.prune-bans` | 每 10 分钟 | 删除到期超过一小时的封禁 |
| `maintenance.rotate-challenge-keys` | 每小时第 11 分 | 轮换满一天的挑战密钥 |
| `maintenance.prune-security-events` | 每小时第 37 分 | 删除超过保留天数的安全事件 |
| 调度求值（进程内定时器，不是 pg-boss 队列） | 每 10 秒；同一时间一个进程（租约），上一次未完成时跳过 | 探针判定的地址可达性与智能调度规则，见 [区域探针与智能调度](#区域探针与智能调度) |

## 数据模型

表定义在 `packages/db/src/schema`；迁移为 drizzle-kit 生成的纯 SQL，位于 `packages/db/migrations`，控制台启动时执行（见 [启动顺序](#启动顺序)）。

### 账号与身份

| 表 | 内容 |
| --- | --- |
| `user` | 唯一的运营者账号，由初始化向导创建 |
| `session` | 登录会话 |
| `account` | 登录凭据（密码哈希） |
| `verification` | better-auth 验证记录 |
| `two_factor` | TOTP 密钥与备用码 |
| `passkey` | passkey 公钥 |
| `apikey` | AccessKey：哈希、权限、启用状态 |
| `service_account` | 服务账号：名称、scope、启用状态（不能登录） |
| `service_account_key` | 服务账号 key 的 SHA-256、前缀、最后使用与吊销时间 |
| `idempotency_key` | `/api/v1` 写请求的幂等键：调用方、方法、路径、请求体哈希与最终响应，保留 24 小时 |
| `rate_limit` | 认证接口限速计数 |

### 基础设施

| 表 | 内容 |
| --- | --- |
| `region` | 区域字典 |
| `cluster` | 集群：共享一条 revision 序列的节点集合 |
| `node_group` | 节点组，可关联区域 |
| `node` | 节点：状态、能力清单、证书序列号与指纹（续期后还有被替换证书的序列号）、最近心跳、最近上报的封禁状态、各网站的 CC 级别与主机指标、是否兼任探针 |
| `node_ip` | 节点的 IP 地址：节点上报的（`reported`）与运营者配置的调度地址（`configured`，级别 0 主、1 备 1、2 备 2） |
| `node_address_state` | 调度地址的探针可达性：失败起点、不可达标记、恢复起点 |
| `probe` | 区域探针：名称、区域、启用、证书序列号与到期、最后在线、版本 |
| `probe_token` | 探针注册 token 的 SHA-256、前缀、名称、区域、到期与使用状态 |
| `probe_result` | 每个探测者（探针或兼任探针的节点）对每个节点地址与端口的最新结果：发送、丢失、延迟、错误码 |
| `enrollment_token` | 注册 token 的 SHA-256 与使用状态 |
| `node_certificate_revocation` | 删除节点时吊销的证书序列号 |
| `pki_authority` | 内部 CA，私钥信封加密 |
| `system_setting` | 平台键值设置：setup token、会话 secret 的 HMAC 校验值、源站允许清单、SMTP、节点发布源、告警策略、封禁、平台防护与 CC 模板、平台错误页、一次性迁移标记 |
| `audit_log` | 管理操作审计 |

### 网站与配置

| 表 | 内容 |
| --- | --- |
| `site` | 网站：所属集群、启用状态、缓存键、分片、Cache-Tag 转发、WebSocket、证书、TLS 设置、缓存代际号、日志采样率、错误页是否拦截源站错误与保存时间 |
| `site_domain` | 网站域名（主机名或泛域名），全局唯一 |
| `site_star` | 用户星标 |
| `origin_pool` | 源站池：超时、keepalive、失败阈值、回源 TLS 校验、主动健康检查与会话保持（关闭时保留设置） |
| `origin` | 源站与所属的源站组（空为默认组） |
| `origin_credential` | S3 源站密钥，信封加密 |
| `cache_rule` | 缓存规则：条件表达式与名单引用、状态码与大小条件、动作、边缘与浏览器 TTL |
| `edge_rule` | 网站规则或全局规则：阶段、表达式、动作、名单引用 |
| `bulk_redirect` | 网站的批量重定向：来源（路径或域名加路径，网站内唯一）、目标、状态码、是否保留查询串、顺序 |
| `cluster_port_pool` | 集群的四层端口池：协议（TCP、UDP、两者）与端口区间（1024–65535，同协议不重叠） |
| `l4_app` | 四层应用：所属集群、名称、协议、端口（集群、协议、端口唯一）、启用、PROXY protocol（接受、发往源站的版本）、被动健康检查、连接与空闲超时、放行与拦截名单引用、并发与新建速率上限 |
| `l4_origin` | 四层应用的源站：地址、端口、权重、备用、顺序 |
| `ip_list` | IP 名单（规范化 CIDR，名称唯一）；`allow` / `block` 名单对所有网站生效 |
| `ip_ban` | 动态封禁：范围（平台 / 网站）、规范化 CIDR、原因码、来源（手动 / 自动，自动带来源节点与触发条件）、到期与解封时间、序号 `seq`（序列 `ip_ban_seq`）、是否下发 |
| `site_protection` | 网站防护：Under Attack 与挑战类型、通行凭证有效期、PoW 难度、CC 策略（跟随模板或自定义）、JA4 日志；没有行即默认值 |
| `site_waf` | 网站的 OWASP CRS：模式（关闭 / 仅检测 / 拦截）、paranoia level、异常分数阈值、排除的规则 id、请求体检查上限；没有行即关闭 |
| `site_error_page` | 网站错误页：每个状态码（403、429、502、503、504）一个模板 |
| `challenge_key` | 集群的挑战密钥（`next`、`current`、`previous`），密钥信封加密 |
| `config_revision` | 每个集群的 revision：序号、内容哈希、二进制 IR、原因码 |
| `node_config_status` | 节点应用回执与心跳，含回执验证标记 |
| `cluster_rollout` | 集群的配置金丝雀：策略（开关、观察窗口、自动推进、5xx 阈值）与当前发布（稳定版本、候选版本、窗口、结果） |

### 证书、DNS 与域名

| 表 | 内容 |
| --- | --- |
| `certificate` | 证书链、指纹、到期与续期状态；私钥与申请时的 EAB 密钥信封加密 |
| `acme_account` | ACME 账户（按目录、EAB key id、邮箱共用），账户密钥信封加密 |
| `acme_challenge` | 短期公开的 HTTP-01 响应 |
| `dns_credential` | ACME DNS-01 使用的 DNS 服务商凭据与区域，信封加密 |
| `dns_challenge_lease` | DNS-01 TXT 记录的清理责任 |
| `platform_dns_provider` | DNS 调度的服务商账号与区域，凭据信封加密 |
| `dns_binding` | 集群的 DNS 绑定：模式、服务商账号、集群域名、TTL、线路（节点组、解析线路、有序备用节点组、最少健康 IP 数）、期望 / 已应用的 DNS revision |
| `dns_revision` | 集群的 DNS revision：绑定设置、记录集（含解析线路）、托管名称、状态、原因码与参数 |
| `scheduling_rule` | 集群的智能调度规则：可选线路、条件（指标、聚合、比较、阈值、持续时间、区域）、and / or、动作、保持与恢复时间 |
| `scheduling_state` | 每条规则对每个节点的状态：各条件成立起点、动作起点、解除起点 |
| `dns_managed_name` | 已登记的托管 DNS 名称及所属集群 |
| `dns_lease` | DNS 工作的租约（集群绑定、DNS-01 凭据），同一时间只有一个进程处理同一绑定或凭据 |

### 统计、日志、任务与告警

| 表 | 内容 |
| --- | --- |
| `node_minute_stats` | 按节点、网站、分钟的流量统计，含 Top URL、Top IP 与命中的 CRS 规则 |
| `node_hour_stats` | 小时汇总 |
| `node_day_stats` | 天汇总 |
| `stats_rollup_dirty` | 待重新汇总的时间桶（小时、天、用量窗口） |
| `node_stats_cursor` | 每个节点统计批次的序号高水位与统计水位（`complete_until`） |
| `l4_minute_stats` | 按节点、四层应用、分钟的统计：新建与拒绝的连接、并发峰值、入 / 出字节，保留 7 天 |
| `site_usage` | 按网站、UTC 5 分钟窗口的可复算用量（请求数、出站与入站字节，十进制精确值）、修订号与全局序号 `seq`（序列 `site_usage_seq`） |
| `access_log` | 采样访问日志（请求 id；网站开启时含 JA4；命中的 CRS 规则与是否被拦截），按 UTC 日分区 |
| `security_event` | 节点上报的 CC 防护事件：级别变化、路径升降级、自动封禁，带当时的 Top IP 与 Top 路径 |
| `node_log_cursor` | 每个节点日志批次的序号高水位 |
| `origin_health` | 节点上报的源站健康状态与错误码，被动检查与主动检查各一行 |
| `cache_task` | 刷新预热任务 |
| `cache_task_node` | 任务在每个节点上的交付与结果 |
| `node_upgrade` | 节点升级任务 |
| `node_upgrade_delivery` | 升级在每个节点上的阶段、状态、期限与健康观察 |
| `alert_channel` | 告警渠道，配置信封加密 |
| `alert_subscription` | 用户按网站与渠道的订阅 |
| `alert_state` | 告警当前状态（网站告警与平台告警） |
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
| `0026_p0_usage` | `site_usage`、序列 `site_usage_seq`、`node_stats_cursor.complete_until`；为已有分钟统计标记用量窗口 |
| `0027_p0_config_canary` | `cluster_rollout`；`alert_event.site_id`、`alert_state.site_id` 可空（平台告警） |
| `0028_g1_dynamic_bans` | `ip_ban`、序列 `ip_ban_seq`；`node.ban_status`；`organization_limit.max_bans` |
| `0029_g2_challenges` | `site_protection`、`challenge_key`、`security_event`；`node.security_state`；`access_log.ja4` |
| `0030_g3_waf` | `site_waf`；分钟、小时、天统计与视图 `traffic_hour_stats` 的 `waf_rules`；`access_log.waf_rule_ids`、`waf_blocked` |
| `0031_g4_cache_origins_error_pages` | `site_error_page`；`origin_pool.active_health_check`、`session_affinity`；`site.keep_cache_tag`、`intercept_origin_errors`、`error_pages_updated_at`；`origin_health.source`（进入主键，已有行为被动检查）；`access_log.request_id` |
| `0032_g5_rules` | `bulk_redirect`；`origin.group_name`；`cache_rule.browser_ttl_seconds`、`list_ids`；已有缓存规则的结构化条件改写为等价表达式并清空结构化列 |
| `0033_domains_without_ownership` | 删除 `domain_ownership` 与 `site_domain.verified`；重名的待验证域名只保留一条；`site_domain (name, wildcard)` 全局唯一 |
| `0034_sites_without_suspension` | 删除 `site.suspended`、`suspend_reason`、`suspend_note`、`suspended_at`；已暂停的网站改为停用；服务账号去掉 `sites:suspend` |
| `0035_without_organization_limits` | 删除 `organization_limit`；服务账号去掉 `limits:read`、`limits:write` |
| `0036_single_operator` | 只保留最早且未停用的平台管理员账号（其余账号的告警订阅合并给它）；IP 名单名称全局唯一（重名的组织名单加后缀并改写其规则），原组织名单改为 collection；删除 `organization`、`member`、`invitation`、`organization_settings` 与各表的 `organization_id`、`session.active_organization_id`、`alert_channel.available_to_tenants`；服务账号去掉组织相关 scope |
| `0037_dns_cluster_bindings` | `dns_binding`、`dns_lease`；`dns_revision.cluster_id`、`dns_managed_name.cluster_id`；DNS 调度策略转换为各集群的绑定，删除 `dns_state` |
| `0038_certificate_chains` | 证书链里混入的非证书 PEM 块（例如私钥）删除 |
| `0039_certificate_accounts` | `acme_account`；`certificate.renewal_info_at` |
| `0040_node_lifecycle` | `node.previous_cert_serial`；`node_upgrade_delivery.deadline_at`（已下发的投递沿用创建后 30 分钟的期限） |
| `0041_g6_probes_scheduling` | `probe`、`probe_token`、`probe_result`、`node_address_state`、`scheduling_rule`、`scheduling_state`；`node.metrics`、`node.probe_enabled`；`node_ip.source` 与 `level`（唯一键改为节点、来源、地址）；`dns_revision.reason_params` |
| `0042_g7_layer4` | `cluster_port_pool`、`l4_app`、`l4_origin`、`l4_minute_stats` |

## 构建产物

| 步骤 | 输出 |
| --- | --- |
| `vite build` | `apps/console/dist/web`（SPA） |
| `node scripts/build-server.mjs`（esbuild） | `apps/console/dist/server/main.js`：服务端与全部依赖打成单个 ESM 文件；`dist/server/recover.js`：找回账户命令，同样自带全部依赖，不带 source map；复制 `install/` 到 `dist/server/install`，迁移到 `dist/migrations` |
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
