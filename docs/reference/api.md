# API 与端点

控制台 HTTP 端点、公开 API 的认证与错误格式，以及节点通道概要。

## 端点

以下路径位于 Web 端口（`PORT`，默认 `3000`），仅 `ROLE=app`、`all` 提供。

| 路径 | 认证 | 用途 |
| --- | --- | --- |
| `/api/v1/*` | `x-api-key` | 公开 API（OpenAPI）；请求中的 Cookie 被剥离 |
| `/api/v1/openapi.json` | 无 | OpenAPI 文档 |
| `/rpc/*` | 会话 Cookie + `x-csrf-token: orpc` | Web UI 专用（oRPC）；请求中的 `x-api-key` 被剥离 |
| `/api/auth/*` | 按端点 | better-auth 白名单端点，其余返回 404 |
| `/healthz` | 无 | 健康检查 |
| `/install.sh` | 无 | 节点安装脚本 |
| `/downloads/*` | 无 | 发布文件镜像；未设置 `EDGEWEIR_DOWNLOADS_DIR` 时返回 404 |
| 其他路径 | 无 | Web UI |

`/api/*`、`/rpc/*`、`/downloads/*`、`/install.sh`、`/healthz` 下未匹配的请求返回 404 与 `{"error":"not found"}`，不回退到 Web UI。

## 公开 API

`/api/v1` 与 `/rpc` 由 `packages/contract` 中的同一份 oRPC 契约生成。OpenAPI 文档位于 `/api/v1/openapi.json`，其 `servers` 为 `<EDGEWEIR_PUBLIC_URL>/api/v1`；**后台 → 系统设置** 的「OpenAPI」链接到该文档。

```bash
curl -fsS https://cdn-admin.example.com/api/v1/openapi.json
```

### 认证

- 请求头 `x-api-key: <AccessKey>`；AccessKey 以 `ewk_` 开头。
- AccessKey 以创建者身份调用，适用创建者的角色与组织范围。平台管理员的密钥可调用后台过程。
- 所属组织要求两步验证而创建者未启用时，租户过程返回 403 `TWO_FACTOR_REQUIRED`。
- 密钥无效、已吊销或缺失：401。创建者账户被禁用后，其 AccessKey 请求被拒绝。
- 每个 AccessKey 连续最多 600 次请求：距上一次请求超过 60 秒时计数清零。超出返回 429 `API_KEY_RATE_LIMITED`，`data.retryAfterSeconds` 为需等待的秒数。持续轮询用服务账号 key，服务账号 key 不计数。
- 无需密钥的过程（OpenAPI 中 `security: []`）：`GET /system/status`、`POST /system/setup`、`GET /invitations/{id}`、`POST /invitations/{id}/accept`。

### AccessKey

在 **设置 → AccessKey** 中管理。每个用户只能查看和吊销自己的密钥。

| 操作 | 位置 | 说明 |
| --- | --- | --- |
| 创建 | 填写「名称」（最长 64 字符），选择「权限范围」，点击「创建」 | 默认「读写」。密钥只显示一次。只能在已登录的控制台会话中创建；经 `/api/v1` 创建返回 403 `ACCESS_KEY_SESSION_REQUIRED`。 |
| 查看 | 密钥列表；`GET /api/v1/access-keys` | 前缀、权限范围、状态、最后使用时间 |
| 吊销 | 「吊销密钥」；`DELETE /api/v1/access-keys/{id}` | 吊销后使用该密钥的请求返回 401；列表中保留并标记「已吊销」 |

| 权限范围 | 可调用的过程 |
| --- | --- |
| 只读 | `GET` 过程，以及 `POST /rules/validate`；其他方法返回 403 `ACCESS_KEY_READ_ONLY` |
| 读写 | 创建者有权调用的全部过程 |

未设置权限范围的旧密钥按读写处理。创建与吊销写入审计日志（`api_key.create`、`api_key.revoke`）；经 AccessKey 执行的操作在审计日志中的操作者类型为 `api_key`。

### 服务账号

服务账号是平台级的机器身份，供集成调用 `/api/v1`。它不能登录：没有密码、passkey 或会话，只有 key。在 **后台 → 服务账号** 中由平台管理员管理。

| 操作 | 说明 |
| --- | --- |
| 新建、编辑 | 名称（最长 64 字符，唯一）、scope、启用状态。停用后该账号的全部 key 返回 401 |
| 新建 key | key 以 `ews_` 开头，只显示一次；只保存 SHA-256。列表显示前缀与最后使用时间（精度 1 分钟） |
| 吊销 key | 吊销后使用该 key 的请求返回 401 |
| 删除 | 同时删除全部 key |

以上变更写入审计日志（`service_account.create`、`service_account.update`、`service_account.delete`、`service_account.key_create`、`service_account.key_revoke`）；服务账号执行的操作在审计日志中的操作者类型为 `service_account`。服务账号 key 只在 `/api/v1` 生效。

服务账号只能调用下表列出的过程，每个过程需要对应的 scope：

| 过程 | 端点 | scope |
| --- | --- | --- |
| `system.status` | `GET /system/status` | — |
| `account.me` | `GET /me` | — |
| `settings.get` | `GET /settings` | `system:read` |
| `clusters.list`、`clusters.get` | `GET /clusters`、`GET /clusters/{id}` | `clusters:read` |
| `organizations.list` | `GET /organizations` | `organizations:read` |
| `organizations.create`、`organizations.update` | `POST /organizations`、`PATCH /organizations/{id}` | `organizations:write` |
| `organizations.members` | `GET /organizations/{id}/members` | `members:read` |
| `organizations.invite` | `POST /organizations/{organizationId}/invitations` | `invitations:write` |
| `sites.list`、`sites.get` | `GET /sites`、`GET /sites/{id}` | `sites:read` |
| `sites.setEnabled` | `PUT /sites/{id}/enabled` | `sites:write` |
| `admin.sites.suspend`、`admin.sites.resume` | `POST /admin/sites/{id}/suspend`、`POST /admin/sites/{id}/resume` | `sites:suspend` |
| `admin.organizations.getLimits` | `GET /admin/organizations/{id}/limits` | `limits:read` |
| `admin.organizations.setLimits` | `PUT /admin/organizations/{id}/limits` | `limits:write` |
| `usage.list`、`usage.changes` | `GET /usage`、`GET /usage/changes` | `usage:read` |

| 情况 | 响应 |
| --- | --- |
| 缺少 scope | 403 `SCOPE_REQUIRED`，`data.scope` 为所需的 scope |
| 过程不在上表 | 403 `SERVICE_ACCOUNT_FORBIDDEN` |
| key 无效、已吊销，或账号已停用 | 401 |

`GET /me` 对服务账号返回 `serviceAccount: { id, name, scopes }`，`user` 为服务账号的 id 与名称（`email` 为空，`isAdmin` 为 `false`），`organizations` 为空。用户的 AccessKey 仍按只读 / 读写处理。

### 幂等键

`/api/v1` 的 `POST`、`PUT`、`PATCH` 接受请求头 `Idempotency-Key`：1–255 个可打印 ASCII 字符，可写成 RFC 8941 字符串（`"key"`）或原样。

| 情况 | 响应 |
| --- | --- |
| 第一次请求 | 正常执行，保存方法、路径（含查询串）、请求体 SHA-256 与最终响应 |
| 同一调用方、同一 key、同一请求 | 返回保存的响应（状态码与响应体），带 `Idempotent-Replayed: true` |
| 同一 key、不同的方法、路径或请求体 | 422 `IDEMPOTENCY_KEY_MISMATCH` |
| 第一次请求仍在执行 | 409 `IDEMPOTENCY_IN_PROGRESS` |
| key 格式无效 | 400 `IDEMPOTENCY_KEY_INVALID` |

- key 按调用方区分：同一用户的全部 AccessKey 共用，每个服务账号单独一份。
- 保存 24 小时，每小时清理过期记录。
- 5xx 响应不保存，调用方可以用同一个 key 重试；401 与 429（未进入过程）也不保存。4xx 响应保存，重放返回同一错误。
- 执行中的记录 10 分钟后视为中断（控制台实例崩溃），下一个请求接管并重新执行。
- `GET` 与 `DELETE` 忽略该请求头。

### 乐观并发

以下写操作接受可选的 `expectedUpdatedAt`（ISO 8601，调用方读取时的 `updatedAt`）。值不一致时返回 409 `UPDATED_AT_MISMATCH`，`data.updatedAt` 为当前值。

| 过程 | 资源的 `updatedAt` |
| --- | --- |
| `sites.setEnabled`、`admin.sites.suspend`、`admin.sites.resume` | 网站 |
| `organizations.update` | 组织 |
| `admin.organizations.setLimits` | 组织限额（未保存过时为 `null`，此时传入任何值都不一致） |
| `clusters.setRolloutPolicy` | 集群的金丝雀策略 |

状态已经是请求的目标值时，站点启停与暂停直接返回当前状态，不比较 `expectedUpdatedAt`。

### 站点启停与暂停

| 状态 | 修改者 | 端点 |
| --- | --- | --- |
| `enabled` | 组织 owner / admin、平台管理员、`sites:write` 服务账号 | `PUT /sites/{id}/enabled`，`{"enabled":false}` |
| `suspended` | 平台管理员、`sites:suspend` 服务账号 | `POST /admin/sites/{id}/suspend`，`{"reason":"billing","note":"…"}`；`POST /admin/sites/{id}/resume` |

- `reason`：`billing`、`abuse`、`security`、`other`；`note` 最长 256 字符，只有平台管理员与服务账号能读到。
- 两个状态都允许时网站才下发到节点。停用或暂停的网站不下发，节点对其域名返回 404；DNS 记录保留；证书续期继续，HTTP-01 挑战照常应答。
- 状态有变化时生成新的配置版本（原因码 `site_enabled`、`site_disabled`、`site_suspended`、`site_resumed`）并写审计（`site.enable`、`site.disable`、`site.suspend`、`site.resume`）；没有变化时返回当前状态，不生成版本、不写审计。
- 对停用或暂停的网站清缓存或预热：409 `SITE_DISABLED` / `SITE_SUSPENDED`。
- 响应为 `{ site, revision }`；`site` 带 `enabled`、`suspended`、`suspendReason`、`suspendNote`、`suspendedAt`。

### 组织限额

| 过程 | 端点 | 调用方 |
| --- | --- | --- |
| `admin.organizations.getLimits` | `GET /admin/organizations/{id}/limits` | 平台管理员、`limits:read` 服务账号 |
| `admin.organizations.setLimits` | `PUT /admin/organizations/{id}/limits` | 平台管理员、`limits:write` 服务账号 |
| `organization.limits` | `GET /organization/limits` | 当前组织的成员 |

响应为 `{ organizationId, limits, usage, updatedAt }`。`limits` 与 `usage` 的字段：`sites`、`domains`、`certificates`、`ipListEntries`、`purgeTasksPerMinute`、`purgeUrlsPerHour`、`members`、`bans`（有效的手动网站封禁）；`limits` 中 `null` 表示不限。`setLimits` 替换全部限额，省略的字段为 `null`，写审计 `organization.limits_update`（修改前后的值）。超限返回 409 `ORG_LIMIT_EXCEEDED`，`data` 为 `{ resource, limit, current }`。行为见 [组织与成员](../guide/organizations.md#技术限额)。

### 封禁

| 过程 | 端点 | 调用方 |
| --- | --- | --- |
| `bans.list` | `GET /bans` | 组织成员（本组织的网站封禁）；平台管理员（全部网站封禁） |
| `bans.create` | `POST /bans` | 组织 owner / admin、平台管理员 |
| `bans.delete` | `DELETE /bans/{id}` | 组织 owner / admin、平台管理员；只针对网站封禁，含自动封禁 |
| `admin.bans.list` | `GET /admin/bans` | 平台管理员 |
| `admin.bans.create` | `POST /admin/bans` | 平台管理员 |
| `admin.bans.delete` | `DELETE /admin/bans/{id}` | 平台管理员 |
| `settings.bans`、`settings.setBans` | `GET`、`PUT /settings/bans` | 平台管理员 |

服务账号不能调用这些过程（403 `SERVICE_ACCOUNT_FORBIDDEN`）；只读 AccessKey 只能调用 `GET`。

| 请求 | 字段 |
| --- | --- |
| `POST /bans` | `siteId`、`cidr`（IP 地址或 CIDR）、`reason`（`abuse`、`attack`、`scanner`、`spam`、`other`）、`durationSeconds`（60–604800） |
| `POST /admin/bans` | 另加 `scope`（`platform` / `site`）：`site` 必须带 `siteId`，`platform` 不能带 |
| `GET /bans` | 查询参数 `siteId`、`source`（`manual` / `auto`）、`page`、`pageSize`（1–100，默认 50） |
| `GET /admin/bans` | 另加 `scope`、`organizationId` |
| `PUT /settings/bans` | `maxTotal`（100–100000，默认 10000）、`shareAutoBans`（默认 `true`） |

列表响应 `{ items, total }`，只含有效的封禁（未到期、未解封），按创建时间倒序。封禁字段：

| 字段 | 说明 |
| --- | --- |
| `id`、`scope`、`cidr` | `cidr` 为规范化的 CIDR，如 `203.0.113.7/32` |
| `reason`、`source` | `source` 为 `manual` 或 `auto`；自动封禁的 `reason` 为 `cc_ip_rate` |
| `siteId`、`siteName`、`organizationId`、`organizationName` | 平台封禁为 `null` |
| `node`、`trigger` | 自动封禁的来源节点 `{ id, name }` 与触发条件 `{ metric, observed, threshold, windowSeconds }`；手动封禁为 `null` |
| `createdBy` | 手动封禁的操作者 `{ type, id, name }` |
| `createdAt`、`expiresAt` | ISO 8601 |
| `seq` | 封禁变化序号（十进制字符串） |
| `distributed` | 是否下发到节点；未共享的自动封禁为 `false` |
| `unappliedNodes` | 上报未能保存该封禁的在线节点数 |

- 同一范围、网站与地址已有有效的手动封禁时，`create` 更新 `reason` 与到期时间并返回同一 `id`，审计 `ban.update`；否则审计 `ban.create`。`delete` 审计 `ban.delete`。
- 节点的封禁状态：`GET /nodes/{id}` 的 `banStatus`（`appliedSequence`、`entries`、`capacity`、`unappliedIds`、`unapplied`、`kernelEntries`、`autoEvicted`、`reportedAt`），节点未上报时为 `null`；节点能力见 `supportedFeatures`（`bans-v1`、`kernel-ban-v1`）。

| 错误代码 | 状态 | 场景 |
| --- | --- | --- |
| `BAN_INVALID_CIDR` | 400 | 不是 IP 地址或 CIDR |
| `BAN_PREFIX_TOO_SHORT` | 400 | 前缀短于 `/16`（IPv4）或 `/48`（IPv6）；`data.min` 为下限 |
| `BAN_EXPIRY_OUT_OF_RANGE` | 400 | `durationSeconds` 不在 60–604800 |
| `BAN_PROTECTED_ADDRESS` | 400 | 包含节点地址、回环或未指定地址，或与平台放行名单重叠；`data.address` 为冲突的地址 |
| `BAN_PLATFORM_LIMIT` | 409 | 达到平台手动封禁上限；`data.limit` |
| `BAN_NOT_FOUND` | 404 | 封禁不存在、已到期或已解封，或不在调用方范围内 |
| `ORG_LIMIT_EXCEEDED` | 409 | 达到组织限额，`data.resource` 为 `bans` |
| `ORG_ADMIN_REQUIRED` | 403 | 组织成员调用 `create` 或 `delete` |

```bash
curl -fsS -X POST -H "x-api-key: $EDGEWEIR_API_KEY" -H 'content-type: application/json' \
  -d '{"scope":"platform","cidr":"203.0.113.0/24","reason":"attack","durationSeconds":86400}' \
  https://cdn-admin.example.com/api/v1/admin/bans
```

行为见 [封禁](../guide/bans.md)。

### 用量

每个网站、每个 UTC 5 分钟窗口 `[windowStart, windowEnd)` 一条记录，数值为该窗口内全部节点上报的分钟统计之和。

| 过程 | 端点 | 查询参数 |
| --- | --- | --- |
| `usage.list` | `GET /usage` | `from`、`to`（按 5 分钟对齐，UTC，半开区间）、`siteId`、`organizationId`、`cursor`、`limit`（1–5000，默认 1000） |
| `usage.changes` | `GET /usage/changes` | `afterSeq`（默认 `"0"`）、`limit`（1–5000，默认 1000）、`organizationId` |

记录字段：

| 字段 | 说明 |
| --- | --- |
| `id` | `<siteId>.<windowStart 的 Unix 秒>`，同一网站同一窗口永远相同 |
| `siteId`、`organizationId` | 网站删除后记录仍保留 |
| `windowStart`、`windowEnd` | ISO 8601 |
| `requests`、`bytesSent`、`bytesReceived` | 十进制整数字符串（出站、入站字节），超过 2^53 时仍精确 |
| `revision` | 从 1 开始；重算后数值变化时加 1 |
| `seq` | 全局单调递增（十进制字符串，可有间隔）；创建或修订时分配 |
| `updatedAt` | 最近一次写入时间 |

- `usage.list` 按（窗口，网站）排序，响应 `{ items, nextCursor, completeUntil }`；`nextCursor` 为 `null` 时没有下一页。`from`、`to` 未对齐或 `to` 不晚于 `from`：400 `USAGE_RANGE_INVALID`；游标无效：400 `USAGE_CURSOR_INVALID`。
- `usage.changes` 按 `seq` 返回 `afterSeq` 之后创建或修订的记录，响应 `{ items, lastSeq, completeUntil }`；下次以 `lastSeq` 作为 `afterSeq`。被修订的记录会再次出现。
- 没有流量的窗口没有记录。
- 窗口结束后每分钟重算一次；迟到数据改变数值时 `revision` 加 1 并分配新的 `seq`，数值不变时两者都不变。同一统计批次重复上报不改变结果。
- 成员只能读取本组织的记录，`organizationId` 被忽略；平台管理员与 `usage:read` 服务账号可以按组织过滤。
- 保留期默认 100 天，**后台 → 系统设置 → 用量** 可调（35–400 天）。

`completeUntil`（ISO 8601 或 `null`）：结束时间不晚于它的窗口，已包含当时所有活动节点的数据。

| 规则 | 说明 |
| --- | --- |
| 节点水位 | 节点在全部统计批次确认后上报 `complete_until`：最近一次成功取出统计时所在分钟的开始，之前的分钟都已上报 |
| 参与的节点 | 状态为启用、且在离线阈值内上报过心跳的节点。阈值默认 60 分钟，**后台 → 系统设置 → 用量** 可调（5–1440 分钟） |
| 计算 | 参与节点水位的最小值；从未上报水位的节点（旧版本节点）按注册时间计；尚未重算的窗口不计入；向下取整到 5 分钟 |
| 单调 | 只前移不后退。离线超过阈值的节点恢复后，它补报的更早窗口的数据按修订处理（`revision` 加 1） |
| 停用或删除的节点 | 不参与 |

### 示例

列出网站（过程 `sites.list`，`GET /api/v1/sites`）：

```bash
curl -fsS -H "x-api-key: $EDGEWEIR_API_KEY" \
  "https://cdn-admin.example.com/api/v1/sites?page=1&pageSize=20"
```

| 查询参数 | 说明 |
| --- | --- |
| `search` | 匹配网站名称或任一域名，最长 100 字符 |
| `clusterId` | 集群 UUID；仅平台管理员 |
| `page` | 页码，默认 `1` |
| `pageSize` | 每页条数，1–100，默认 `20` |

响应：`{"items":[…],"total":<总数>}`。

### 错误格式

```json
{
  "defined": false,
  "code": "ACCESS_KEY_READ_ONLY",
  "status": 403,
  "message": "access key is read only",
  "data": {}
}
```

| 字段 | 说明 |
| --- | --- |
| `code` | 稳定错误代码。代码与 HTTP 状态的完整列表：[`packages/contract/src/errors.ts`](https://github.com/marvinli001/edgeweir/blob/master/packages/contract/src/errors.ts) |
| `status` | HTTP 状态码 |
| `message` | 英文说明，供不识别代码的客户端使用 |
| `data` | 消息参数 |

认证与输入校验失败使用 oRPC 通用代码：`UNAUTHORIZED`（401）、`FORBIDDEN`（403）、`BAD_REQUEST`（400）。

## Web UI 接口

`/rpc/*` 使用 oRPC RPC 协议，供 Web UI 调用，路径为过程路径，例如 `POST /rpc/sites/list`。

| 要求 | 说明 |
| --- | --- |
| 会话 Cookie | 由 `/api/auth` 的登录端点签发 |
| `x-csrf-token: orpc` | 缺少时返回 403 |
| `x-api-key` | 被剥离，不能代替会话 Cookie |

第三方集成使用 `/api/v1`。

## 认证端点

`/api/auth/*` 由 better-auth 处理，只放行下表中的路径与方法。匹配为精确匹配（不接受前缀、编码变体或结尾斜杠），其余请求返回 404。请求中的 `x-api-key` 被剥离；客户端 IP 按 `EDGEWEIR_TRUSTED_PROXIES` 解析后传入。控制台不开放注册；账户在初始化向导、平台管理员创建用户或接受邀请时创建。`NODE_ENV=production` 时启用限速，计数存于 PostgreSQL。

| 路径 | 方法 |
| --- | --- |
| `/api/auth/get-session` | `GET` |
| `/api/auth/sign-in/email` | `POST` |
| `/api/auth/sign-out` | `POST` |
| `/api/auth/change-password` | `POST` |
| `/api/auth/two-factor/enable` | `POST` |
| `/api/auth/two-factor/disable` | `POST` |
| `/api/auth/two-factor/verify-totp` | `POST` |
| `/api/auth/two-factor/verify-backup-code` | `POST` |
| `/api/auth/passkey/generate-register-options` | `GET` |
| `/api/auth/passkey/verify-registration` | `POST` |
| `/api/auth/passkey/generate-authenticate-options` | `GET` |
| `/api/auth/passkey/verify-authentication` | `POST` |
| `/api/auth/passkey/list-user-passkeys` | `GET` |
| `/api/auth/passkey/delete-passkey` | `POST` |
| `/api/auth/api-key/create` | `POST` |
| `/api/auth/api-key/list` | `GET` |
| `/api/auth/api-key/delete` | `POST` |

## 健康检查

`GET /healthz` 返回 200：

```json
{ "status": "ok", "version": "20260929-a1b2c3d" }
```

| 字段 | 说明 |
| --- | --- |
| `status` | 固定为 `ok` |
| `version` | 运行版本（`EDGEWEIR_VERSION`）；源码运行为 `dev` |

HTTP 服务监听即返回，不检查数据库。容器健康检查见[命令行](cli.md#容器)。

## 安装脚本与发布镜像

`GET /install.sh` 返回节点安装脚本（`text/x-shellscript`，`cache-control: no-store`），脚本中的控制台地址替换为 `EDGEWEIR_PUBLIC_URL`。选项见[命令行](cli.md#节点安装脚本)。

`GET`、`HEAD` `/downloads/*` 从 `EDGEWEIR_DOWNLOADS_DIR` 提供文件，URL 路径与目录中的相对路径相同：

| 路径 | 内容 | `cache-control` |
| --- | --- | --- |
| `/downloads/<项目>/latest` | 最新版本号，文本 | `no-cache` |
| `/downloads/<项目>/v<语义化版本>/<文件>` | 发布文件 | `public, max-age=86400, immutable` |

`<项目>` 为 `edgeweir-node` 或 `cosign`。其他路径、不存在的文件、指向目录外的符号链接返回 404。目录准备见[接入节点](../deploy/nodes.md)。

## 节点通道

| 项 | 值 |
| --- | --- |
| 协议 | Connect-RPC，HTTPS（HTTP/2，兼容 HTTP/1.1），TLS 1.2 及以上 |
| 监听 | `NODE_API_HOST:NODE_API_PORT`，默认 `8443` |
| 服务 | `edgeweir.node.v1.NodeService`，定义见 [`proto/edgeweir/node/v1/node.proto`](https://github.com/marvinli001/edgeweir/blob/master/proto/edgeweir/node/v1/node.proto) |
| 服务器证书 | 控制台内部 CA 在每次启动时签发，名称见[环境变量](environment.md#访问地址与网络) |
| 认证 | `Enroll`：一次性注册 token，节点预先固定内部 CA 的 SHA-256 指纹。其他 RPC：内部 CA 签发的客户端证书（mTLS），证书 CN 为节点 ID |
| 其他路径 | 404 |

> [!WARNING]
> 节点通道必须直连或四层透传；终结 TLS 的代理会使节点 mTLS 失败。见[端口、反向代理与可信代理](../deploy/networking.md)。

