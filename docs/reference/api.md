# API 概览

控制台 HTTP 端点、公开 API 的认证、权限、请求格式、幂等键、并发控制与分页，以及节点通道概要。

## 端点

以下路径位于 Web 端口（`PORT`，默认 `3000`），仅 `ROLE=app`、`all` 提供。

| 路径 | 认证 | 用途 |
| --- | --- | --- |
| `/api/v1/*` | `x-api-key` | 公开 API（OpenAPI）；请求中的 Cookie 被剥离 |
| `/api/v1/openapi.json` | 无 | OpenAPI 文档 |
| `/rpc/*` | 会话 Cookie + `x-csrf-token: orpc` | Web UI 专用（oRPC RPC 协议）；请求中的 `x-api-key` 被剥离 |
| `/api/auth/*` | 按端点 | better-auth 允许列表中的端点，见[认证端点](#认证端点) |
| `/healthz` | 无 | 健康检查 |
| `/install.sh` | 无 | 节点安装脚本 |
| `/downloads/*` | 无 | 发布文件镜像；未设置 `EDGEWEIR_DOWNLOADS_DIR` 时返回 404 |
| `/node-channel` | 节点通道 mTLS | 节点通道的 WebSocket 入口；入口开放时普通请求返回 426，关闭时 404 |
| 其他路径 | 无 | Web UI |

`/api/*`、`/rpc/*`、`/downloads/*`、`/install.sh`、`/healthz`、`/node-channel` 下未匹配的请求返回 404 与 `{"error":"not found"}`，不回退到 Web UI。全部响应在未设置 `cache-control` 时带 `cache-control: no-store`。

## 资源

`/api/v1` 与 `/rpc` 由 `packages/contract` 中的同一份 oRPC 契约生成，共 275 个过程。

| 页面 | 资源 | 过程数 |
| --- | --- | --- |
| [网站](api/sites.md) | 网站、网站启停、标签与批量操作、复制与克隆、缓存任务、错误页与维护模式、访问鉴权、访问控制、图片格式转换、用量保护、自动缓解 | 51 |
| [访问控制](api/security.md) | 网站规则、全局规则、批量重定向、IP 名单、IP 检查、封禁、灰名单、挑战与 CC 防护、OWASP CRS | 32 |
| [证书](api/certificates.md) | 证书、ACME 账户、DNS 凭据、回源客户端 CA、Origin CA、源站证书 | 28 |
| [集群与节点](api/clusters.md) | 集群、配置版本与金丝雀、集群网络设置、注册 token、节点组、节点、节点日志、区域、节点升级、端口池与 L4 应用 | 60 |
| [DNS 与调度](api/dns.md) | DNS 服务商、DNS 绑定与记录、DNS 版本与对账、区域探针、智能调度规则 | 28 |
| [概览、统计与告警](api/monitoring.md) | 概览、统计、访问日志、用量、审计日志、告警 | 29 |
| [系统与账户](api/system.md) | 初始化与状态、账户、AccessKey、服务账号、系统设置 | 47 |

## OpenAPI 文档

`GET /api/v1/openapi.json` 返回 OpenAPI 文档：`info.version` 为控制台版本，`servers` 为 `<EDGEWEIR_PUBLIC_URL>/api/v1`，安全方案 `apiKey`（请求头 `x-api-key`）。**系统设置** 的「OpenAPI」链接到该文档。

```bash
curl -fsS https://cdn-admin.example.com/api/v1/openapi.json
```

## 认证

| 凭据 | 前缀 | 使用位置 | 身份 |
| --- | --- | --- | --- |
| AccessKey | `ewk_` | `/api/v1`，请求头 `x-api-key` | 运营者（初始化向导创建的唯一账户）；审计操作者类型 `api_key` |
| 服务账号 key | `ews_` | `/api/v1`，请求头 `x-api-key` | 服务账号；审计操作者类型 `service_account` |
| 会话 Cookie | — | `/rpc`，另需请求头 `x-csrf-token: orpc` | 登录的账户；审计操作者类型 `user` |

- 缺少凭据，或密钥无效、已吊销、已过期，或服务账号已停用：401 `UNAUTHORIZED`。
- 无需凭据的过程（OpenAPI 中 `security: []`）：`system.status`（`GET /system/status`）、`system.setup`（`POST /system/setup`）。
- `GET /me`（`account.me`）返回调用方，见[系统与账户](api/system.md#accountme)。
- AccessKey 只能在已登录的会话中创建与修改（`accessKeys.create`、`accessKeys.update`）；经 `/api/v1` 调用返回 403 `ACCESS_KEY_SESSION_REQUIRED`。
- 登录 IP 白名单只限制会话（`/rpc`、`/api/auth`），不限制 `/api/v1` 的密钥。

### AccessKey

AccessKey 在 **个人设置**（用户菜单）的「AccessKey」卡片中管理，或在已登录的会话中经 `/rpc` 调用 `accessKeys.*`。

| 属性 | 值 |
| --- | --- |
| 权限范围 | 「只读」或「读写」（默认读写），见[权限](#权限) |
| 每分钟请求数 | 默认 600，1–100000，或不限，见[速率限制](#速率限制) |
| 密钥 | `ewk_` 开头，只在创建时显示一次 |
| 吊销 | 吊销后使用该密钥的请求返回 401；列表中保留 |
| 审计 | `api_key.create`、`api_key.update`、`api_key.revoke` |

过程与字段见[系统与账户](api/system.md#accesskey)。better-auth 的 `/api/auth/api-key/*` 端点不开放，返回 404。

## 权限

| 级别 | 过程 | 可调用的调用方 |
| --- | --- | --- |
| 读 | 全部 `GET` 过程与 `rules.validate` | 会话、全部 AccessKey、演示账号 |
| 写 | 其余过程 | 会话、「读写」AccessKey；「只读」AccessKey 返回 403 `ACCESS_KEY_READ_ONLY`，演示账号返回 403 `DEMO_READ_ONLY` |

AccessKey 的权限范围为「只读」或「读写」（未设置的密钥按读写处理）。资源页中每个过程标注 **读** 或 **写**。

### 服务账号

服务账号只能调用下表中的过程，每个过程需要对应的 scope；其他过程返回 403 `SERVICE_ACCOUNT_FORBIDDEN`，缺少 scope 返回 403 `SCOPE_REQUIRED`（`data.scope` 为所需的 scope）。scope 只用于服务账号。

| 过程 | 端点 | scope |
| --- | --- | --- |
| `system.status` | `GET /system/status` | — |
| `account.me` | `GET /me` | — |
| `dns.catalog` | `GET /dns/catalog` | — |
| `settings.get` | `GET /settings` | `system:read` |
| `clusters.list`、`clusters.get` | `GET /clusters`、`GET /clusters/{id}` | `clusters:read` |
| `sites.list`、`sites.get`、`sites.launch` | `GET /sites`、`GET /sites/{id}`、`GET /sites/{id}/launch` | `sites:read` |
| `dns.siteTarget` | `GET /sites/{siteId}/cname` | `sites:read` |
| `sites.setEnabled` | `PUT /sites/{id}/enabled` | `sites:write` |
| `usage.list`、`usage.changes` | `GET /usage`、`GET /usage/changes` | `usage:read` |

服务账号与 key 的管理过程见[系统与账户](api/system.md#服务账号)。

### 节点能力

修改后的配置需要集群中某个活动节点缺少的能力（节点在 `supportedFeatures` 中上报，如 `challenge-v1`、`modsecurity-v1`）时：

| 调用方 | 结果 |
| --- | --- |
| 运营者（会话或 AccessKey） | 保存并发布；缺少能力的节点保留原配置，在 **集群与节点** 中显示「需要升级」 |
| 服务账号、控制台的自动任务 | 409 `NODE_CAPABILITY_REQUIRED`，`data.features` 为缺少的能力（逗号分隔），`data.nodes` 为缺少能力的节点（前 5 个，更多时以 `+N` 结尾）；修改不保存 |

升级节点见[节点升级](../guide/node-upgrades.md)。

## 请求格式

| 项 | 规则 |
| --- | --- |
| 基址 | `<EDGEWEIR_PUBLIC_URL>/api/v1` |
| 路径参数 | 路径中的 `{name}` |
| 其他输入 | `GET`：查询参数；`POST`、`PUT`、`PATCH`、`DELETE`：JSON 请求体（`content-type: application/json`） |
| 查询参数中的数组 | `name[]=a&name[]=b` |
| 请求体上限 | 无有效凭据 1 MiB，有有效凭据 16 MiB；超出返回 413 `PAYLOAD_TOO_LARGE`，在执行过程前判断 |
| 时间 | ISO 8601 字符串，带时区偏移（如 `2026-10-30T08:00:00Z`） |
| ID | UUID |
| 响应 | 过程输出的 JSON；状态 200，创建类过程按资源页标注返回 201 |
| 输入校验失败 | 400 `BAD_REQUEST`，`data.issues` 为校验问题 |

错误响应格式与全部错误码见[错误码](errors.md)。

```bash
curl -fsS -H "x-api-key: $EDGEWEIR_API_KEY" \
  "https://cdn-admin.example.com/api/v1/sites?page=1&pageSize=20"
```

```bash
curl -fsS -X PUT -H "x-api-key: $EDGEWEIR_API_KEY" -H 'content-type: application/json' \
  -d '{"enabled":false}' \
  https://cdn-admin.example.com/api/v1/sites/<网站 ID>/enabled
```

## 速率限制

每个 AccessKey 有自己的「每分钟请求数」：默认 600，1–100000，或不限（`requestsPerMinute: null`）。

| 规则 | 说明 |
| --- | --- |
| 窗口 | 固定 60 秒窗口，从上一个窗口结束后该密钥的第一个请求开始；窗口内最多「每分钟请求数」个请求 |
| 超出 | 429 `API_KEY_RATE_LIMITED`，`data.retryAfterSeconds` 为距窗口结束的秒数（至少 1） |
| 计数 | 保存在控制台进程内：每个实例分别计数，重启后清零；修改上限后重新计数 |
| 不计数 | 不限的 AccessKey、服务账号 key |

`/api/auth` 的登录类端点另有 better-auth 的限速（`NODE_ENV=production`，计数存于 PostgreSQL）。

## 幂等键

`/api/v1` 的 `POST`、`PUT`、`PATCH` 接受请求头 `Idempotency-Key`：1–255 个可打印 ASCII 字符，可写成 RFC 8941 字符串（`"key"`）或原样。`GET` 与 `DELETE` 忽略该请求头。

| 情况 | 响应 |
| --- | --- |
| 第一次请求 | 正常执行，保存方法、路径（含查询串）、请求体 SHA-256 与最终响应 |
| 同一调用方、同一 key、同一请求 | 返回保存的响应（状态码与响应体），带 `Idempotent-Replayed: true` |
| 同一 key、不同的方法、路径或请求体 | 422 `IDEMPOTENCY_KEY_MISMATCH` |
| 第一次请求仍在执行 | 409 `IDEMPOTENCY_IN_PROGRESS` |
| key 格式无效 | 400 `IDEMPOTENCY_KEY_INVALID` |
| 请求体带 SSH 凭据：`sshInstalls.start`、`sshInstalls.retry` | 400 `IDEMPOTENCY_KEY_UNSUPPORTED`，不执行，也不留下请求体的哈希；不带该请求头重新发送 |
| 响应里有只显示一次的凭据：`accessKeys.create`、`serviceAccounts.createKey`、`clusters.createEnrollmentToken`、`probes.createToken`、`authRules.signUrl` | 400 `IDEMPOTENCY_KEY_UNSUPPORTED`，不执行；不带该请求头重新发送 |

- key 按调用方区分：全部 AccessKey 共用一份（同一账户），每个服务账号单独一份。
- 保存 24 小时，每小时清理过期记录。
- 5xx 响应不保存，可用同一个 key 重试；401 与 429（未进入过程）也不保存。4xx 响应保存，重放返回同一错误。
- 执行中的记录 10 分钟后视为中断，下一个请求接管并重新执行。

## 乐观并发

以下写操作接受可选的 `expectedUpdatedAt`（ISO 8601，调用方读取时的 `updatedAt`）。与资源当前的值不一致时返回 409 `UPDATED_AT_MISMATCH`，`data.updatedAt` 为当前值（尚无值时为空字符串）。省略时不比较。

| 过程 | 比较的 `updatedAt` |
| --- | --- |
| `sites.setEnabled` | 网站；已经是请求的状态时直接返回，不比较 |
| `accessControl.update` | 网站的访问控制 |
| `authRules.update`、`authRules.forgetIdentityHeaders` | 网站的访问鉴权 |
| `errorPages.update` | 网站的错误页 |
| `maintenance.update` | 网站的维护模式 |
| `usageGuard.update` | 网站的用量保护 |
| `autoMitigation.update` | 网站的自动缓解 |
| `clusters.setRolloutPolicy` | 集群金丝雀策略的 `policyUpdatedAt`（发布与金丝雀进度不改变它；传入当时读取的 `updatedAt` 也可） |
| `l4Apps.update`、`l4Apps.setEnabled` | L4 应用；`setEnabled` 已经是请求的状态时直接返回，不比较 |

## 分页

| 方式 | 请求 | 响应 | 过程 |
| --- | --- | --- | --- |
| 页码 | `page`（≥1，默认 1）、`pageSize` | `{ items, total }` | `sites.list`、`cacheTasks.list`（`pageSize` 1–100，默认 20）；`bans.list`、`greylist.list`、`security.events`（1–100，默认 50） |
| 偏移 | `offset`（≥0，默认 0）、`limit`（1–200，默认 50） | `{ items, total }` | `auditLogs.list` |
| 游标 | `cursor`（上一页的 `nextCursor`）、`limit` | `nextCursor`；`null` 为最后一页 | `usage.list`、`nodes.logs` |
| 序号 | `afterSeq`（上次收到的最大 `seq`，默认 `"0"`）、`limit` | 按 `seq` 排序的记录 | `usage.changes`（增量同步） |
| 条数 | `limit` | 列表 | 统计与访问日志查询，上限见各过程 |

无效游标返回 400（`USAGE_CURSOR_INVALID`、`NODE_LOG_CURSOR_INVALID`）。各过程的参数范围见资源页。

## Web UI 接口

`/rpc/*` 使用 oRPC RPC 协议，供 Web UI 调用，路径为过程路径，例如 `POST /rpc/sites/list`。

| 要求 | 说明 |
| --- | --- |
| 会话 Cookie | 由 `/api/auth` 的登录端点签发 |
| `x-csrf-token: orpc` | 缺少时返回 403 `CSRF_TOKEN_MISMATCH` |
| `x-api-key` | 被剥离，不能代替会话 Cookie |
| 登录 IP 白名单 | 客户端 IP 不在白名单内时返回 403 `LOGIN_IP_NOT_ALLOWED`（演示账号除外） |

第三方集成使用 `/api/v1`。

## 认证端点

`/api/auth/*` 由 better-auth 处理，只放行下表中的路径与方法（`AUTH_HTTP_ROUTES`）。匹配为精确匹配（不接受前缀、编码变体或结尾斜杠），其余请求返回 404。请求中的 `x-api-key` 被剥离；客户端 IP 按 `EDGEWEIR_TRUSTED_PROXIES` 解析后传入。请求体上限 64 KiB。控制台不开放注册，唯一的账户由初始化向导创建。

| 路径 | 方法 | 登录 IP 白名单 | 演示账号 |
| --- | --- | --- | --- |
| `/api/auth/get-session` | `GET` | 限制 | 允许 |
| `/api/auth/sign-in/email` | `POST` | 限制 | 允许 |
| `/api/auth/sign-out` | `POST` | 不限制 | 允许 |
| `/api/auth/change-password` | `POST` | 限制 | 403 `DEMO_READ_ONLY` |
| `/api/auth/two-factor/enable` | `POST` | 限制 | 403 `DEMO_READ_ONLY` |
| `/api/auth/two-factor/disable` | `POST` | 限制 | 403 `DEMO_READ_ONLY` |
| `/api/auth/two-factor/verify-totp` | `POST` | 限制 | 允许 |
| `/api/auth/two-factor/verify-backup-code` | `POST` | 限制 | 允许 |
| `/api/auth/passkey/generate-register-options` | `GET` | 限制 | 403 `DEMO_READ_ONLY` |
| `/api/auth/passkey/verify-registration` | `POST` | 限制 | 403 `DEMO_READ_ONLY` |
| `/api/auth/passkey/generate-authenticate-options` | `GET` | 限制 | 允许 |
| `/api/auth/passkey/verify-authentication` | `POST` | 限制 | 允许 |
| `/api/auth/passkey/list-user-passkeys` | `GET` | 限制 | 允许 |
| `/api/auth/passkey/delete-passkey` | `POST` | 限制 | 403 `DEMO_READ_ONLY` |

客户端 IP 不在登录 IP 白名单内时，受限制的端点在 better-auth 处理前返回 403 `LOGIN_IP_NOT_ALLOWED`（演示账号的登录与会话除外）。`NODE_ENV=production` 时启用 better-auth 的限速，计数存于 PostgreSQL。

## 健康检查

`GET /healthz` 返回 200：

```json
{ "status": "ok", "version": "20261029-0c26898" }
```

| 字段 | 说明 |
| --- | --- |
| `status` | 固定为 `ok` |
| `version` | 运行版本（`EDGEWEIR_VERSION`）；源码运行为 `dev` |

HTTP 服务监听即返回，不检查数据库。容器健康检查见[命令行](cli.md#容器)。

## 安装脚本与发布镜像

`GET /install.sh` 返回节点安装脚本（`text/x-shellscript; charset=utf-8`，`cache-control: no-store`），脚本中的控制台地址替换为 `EDGEWEIR_PUBLIC_URL`。选项见[命令行](cli.md#节点安装脚本)。

`GET`、`HEAD` `/downloads/*` 从 `EDGEWEIR_DOWNLOADS_DIR` 提供文件，URL 路径与目录中的相对路径相同：

| 路径 | 内容 | `cache-control` |
| --- | --- | --- |
| `/downloads/<项目>/latest` | 最新版本号，文本 | `no-cache` |
| `/downloads/<项目>/v<语义化版本>/<文件>` | 发布文件 | `public, max-age=86400, immutable` |

`<项目>` 为 `edgeweir-node` 或 `cosign`；`edgeweir-openresty`、`edgeweir-openresty-modsecurity` 软件包放在 `edgeweir-node` 的同一版本目录。其他路径、不存在的文件、指向目录外的符号链接返回 404。目录准备见[接入节点](../deploy/nodes.md)。

## 节点通道

| 项 | 值 |
| --- | --- |
| 协议 | Connect-RPC，HTTPS（HTTP/2，兼容 HTTP/1.1），TLS 1.2 及以上 |
| 监听 | `NODE_API_HOST:NODE_API_PORT`，默认 `8443` |
| WebSocket 入口 | Web 端口上的 `/node-channel`：节点通道的 TLS 在 WebSocket 内由控制台终结。节点通道地址为 `wss://`、`ws://` 或设置了 `EDGEWEIR_NODE_API_WEBSOCKET` 时开放 |
| 服务 | `edgeweir.node.v1.NodeService`（节点）与 `edgeweir.node.v1.ProbeService`（区域探针与兼任探针的节点），定义见 [`proto/edgeweir/node/v1/node.proto`](../../proto/edgeweir/node/v1/node.proto) 与 [`probe.proto`](../../proto/edgeweir/node/v1/probe.proto) |
| 服务器证书 | 控制台内部 CA 签发，名称见[环境变量](environment.md#访问地址与网络) |
| 认证 | `Enroll`、`EnrollProbe`：一次性注册 token（节点 `ewt_`、探针 `ewp_`），节点或探针预先固定内部 CA 的 SHA-256 指纹。其他 RPC：内部 CA 签发的客户端证书（mTLS），CN 为节点 ID（`O=Edgeweir Node`）或探针 ID（`O=Edgeweir Probe`）；探针证书只能调用 `ProbeService`，节点证书只在节点兼任探针时调用 `GetProbeTargets`、`ReportProbeResults` |
| 其他路径 | 404 |

> [!WARNING]
> 节点通道必须直连或四层透传；终结 TLS 的代理会使节点 mTLS 失败。见[端口、反向代理与可信代理](../deploy/networking.md)。
