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

`/api/v1` 与 `/rpc` 由 `packages/contract` 中的同一份 oRPC 契约生成。OpenAPI 文档位于 `/api/v1/openapi.json`，其 `servers` 为 `<EDGEWEIR_PUBLIC_URL>/api/v1`；**系统设置** 的「OpenAPI」链接到该文档。

```bash
curl -fsS https://cdn-admin.example.com/api/v1/openapi.json
```

### 认证

- 请求头 `x-api-key: <key>`：AccessKey（`ewk_` 开头）或服务账号 key（`ews_` 开头）。
- AccessKey 以运营者（初始化向导创建的唯一账户）身份调用，可调用的过程由其权限范围决定，见 [AccessKey](#accesskey)。服务账号 key 只能调用[服务账号](#服务账号)中列出的过程。
- 密钥无效、已吊销或缺失：401。
- 每个 AccessKey 连续最多 600 次请求：距上一次请求超过 60 秒时计数清零。超出返回 429 `API_KEY_RATE_LIMITED`，`data.retryAfterSeconds` 为需等待的秒数。持续轮询用服务账号 key，服务账号 key 不计数。
- 无需密钥的过程（OpenAPI 中 `security: []`）：`GET /system/status`、`POST /system/setup`。
- `GET /me` 返回调用方：`{ user: { id, name, email, twoFactorEnabled }, serviceAccount }`；使用 AccessKey 时 `serviceAccount` 为 `null`。

### AccessKey

在 **设置 → AccessKey**（用户菜单）中管理；也可在已登录的会话中经 `/rpc` 调用 `accessKeys.*`。

| 操作 | 位置 | 说明 |
| --- | --- | --- |
| 创建 | 填写「名称」（最长 64 字符），选择「权限范围」，点击「创建」 | 默认「读写」。密钥只显示一次。只能在已登录的控制台会话中创建；经 `/api/v1` 用密钥调用 `POST /access-keys` 返回 403 `ACCESS_KEY_SESSION_REQUIRED`。 |
| 查看 | 密钥列表；`GET /api/v1/access-keys` | 前缀、权限范围、状态、最后使用时间 |
| 吊销 | 「吊销密钥」；`DELETE /api/v1/access-keys/{id}` | 吊销后使用该密钥的请求返回 401；列表中保留并标记「已吊销」 |

| 权限范围 | 可调用的过程 |
| --- | --- |
| 只读 | `GET` 过程，以及 `POST /rules/validate`；其他方法返回 403 `ACCESS_KEY_READ_ONLY` |
| 读写 | 全部过程，创建 AccessKey 除外 |

未设置权限范围的密钥按读写处理。创建与吊销写入审计日志（`api_key.create`、`api_key.revoke`）；经 AccessKey 执行的操作在审计日志中的操作者类型为 `api_key`。better-auth 的 `/api/auth/api-key/*` 端点不开放，返回 404。

### 服务账号

服务账号是供集成调用 `/api/v1` 的机器身份。它不能登录：没有密码、passkey 或会话，只有 key。在 **服务账号** 页面管理。

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
| `dns.catalog` | `GET /dns/catalog` | — |
| `settings.get` | `GET /settings` | `system:read` |
| `clusters.list`、`clusters.get` | `GET /clusters`、`GET /clusters/{id}` | `clusters:read` |
| `sites.list`、`sites.get` | `GET /sites`、`GET /sites/{id}` | `sites:read` |
| `sites.setEnabled` | `PUT /sites/{id}/enabled` | `sites:write` |
| `dns.siteTarget` | `GET /sites/{siteId}/cname` | `sites:read` |
| `usage.list`、`usage.changes` | `GET /usage`、`GET /usage/changes` | `usage:read` |

| 情况 | 响应 |
| --- | --- |
| 缺少 scope | 403 `SCOPE_REQUIRED`，`data.scope` 为所需的 scope |
| 过程不在上表 | 403 `SERVICE_ACCOUNT_FORBIDDEN` |
| key 无效、已吊销，或账号已停用 | 401 |
| 修改需要集群活动节点缺少的能力 | 409 `NODE_CAPABILITY_REQUIRED`，见[节点能力](#节点能力) |

`GET /me` 对服务账号返回 `serviceAccount: { id, name, scopes }`，`user` 为服务账号的 id 与名称（`email` 为空，`twoFactorEnabled` 为 `false`）。scope 只用于服务账号；AccessKey 使用只读 / 读写权限范围。

### 幂等键

`/api/v1` 的 `POST`、`PUT`、`PATCH` 接受请求头 `Idempotency-Key`：1–255 个可打印 ASCII 字符，可写成 RFC 8941 字符串（`"key"`）或原样。

| 情况 | 响应 |
| --- | --- |
| 第一次请求 | 正常执行，保存方法、路径（含查询串）、请求体 SHA-256 与最终响应 |
| 同一调用方、同一 key、同一请求 | 返回保存的响应（状态码与响应体），带 `Idempotent-Replayed: true` |
| 同一 key、不同的方法、路径或请求体 | 422 `IDEMPOTENCY_KEY_MISMATCH` |
| 第一次请求仍在执行 | 409 `IDEMPOTENCY_IN_PROGRESS` |
| key 格式无效 | 400 `IDEMPOTENCY_KEY_INVALID` |
| 响应里有只显示一次的凭据：`POST /access-keys`、`POST /service-accounts/{id}/keys`、`POST /enrollment-tokens`、`POST /probe-tokens` | 400 `IDEMPOTENCY_KEY_UNSUPPORTED`，不执行；不带该请求头重新发送 |

- key 按调用方区分：全部 AccessKey 共用一份，每个服务账号单独一份。
- 保存 24 小时，每小时清理过期记录。
- 5xx 响应不保存，调用方可以用同一个 key 重试；401 与 429（未进入过程）也不保存。4xx 响应保存，重放返回同一错误。
- 执行中的记录 10 分钟后视为中断（控制台实例崩溃），下一个请求接管并重新执行。
- `GET` 与 `DELETE` 忽略该请求头。

### 乐观并发

以下写操作接受可选的 `expectedUpdatedAt`（ISO 8601，调用方读取时的 `updatedAt`）。值不一致时返回 409 `UPDATED_AT_MISMATCH`，`data.updatedAt` 为当前值。

| 过程 | 资源的 `updatedAt` |
| --- | --- |
| `sites.setEnabled` | 网站 |
| `clusters.setRolloutPolicy` | 集群的金丝雀策略 |
| `l4Apps.update`、`l4Apps.setEnabled` | L4 应用 |

网站或 L4 应用已经是请求的启停状态时，`sites.setEnabled`、`l4Apps.setEnabled` 直接返回当前状态，不比较 `expectedUpdatedAt`。

### 站点启停

`PUT /sites/{id}/enabled`（过程 `sites.setEnabled`），请求体 `{"enabled":false}`。运营者（会话或读写 AccessKey）与 `sites:write` 服务账号可以调用。

- 停用的网站不下发到节点，节点对其域名返回 404；DNS 记录保留；证书续期继续，HTTP-01 挑战照常应答。
- 状态有变化时生成新的配置版本（原因码 `site_enabled`、`site_disabled`）并写审计（`site.enable`、`site.disable`）；没有变化时返回当前状态，不生成版本、不写审计。
- 对停用的网站清缓存或预热：409 `SITE_DISABLED`。
- 响应为 `{ site, revision }`；`site.enabled` 为当前状态。

### 节点能力

修改后的配置需要集群中某个活动节点缺少的能力（节点在 `supportedFeatures` 中上报，如 `challenge-v1`、`modsecurity-v1`）时：

| 调用方 | 结果 |
| --- | --- |
| 运营者（会话或 AccessKey） | 保存并发布；缺少能力的节点保留原配置，在 **集群与节点** 中显示「需要升级」 |
| 服务账号 | 409 `NODE_CAPABILITY_REQUIRED`，`data.features` 为缺少的能力（逗号分隔）；修改不保存 |

控制台的自动任务发布配置时与服务账号受同样的限制。升级节点见[节点升级](../guide/node-upgrades.md)。

### 封禁

| 过程 | 端点 |
| --- | --- |
| `bans.list` | `GET /bans` |
| `bans.create` | `POST /bans` |
| `bans.delete` | `DELETE /bans/{id}` |
| `settings.bans`、`settings.setBans` | `GET`、`PUT /settings/bans` |

服务账号不能调用这些过程（403 `SERVICE_ACCOUNT_FORBIDDEN`）；只读 AccessKey 只能调用 `GET`。范围 `scope`：`site` 针对一个网站，`platform` 针对全部网站（界面显示为「全局」）。

| 请求 | 字段 |
| --- | --- |
| `POST /bans` | `scope`（`site` / `platform`）、`siteId`（`site` 必须带，`platform` 不能带）、`cidr`（IP 地址或 CIDR）、`reason`（`abuse`、`attack`、`scanner`、`spam`、`other`）、`durationSeconds`（60–604800） |
| `GET /bans` | 查询参数 `scope`、`siteId`、`source`（`manual` / `auto`）、`page`、`pageSize`（1–100，默认 50） |
| `PUT /settings/bans` | `maxTotal`（100–100000，默认 10000）、`shareAutoBans`（默认 `true`） |

列表响应 `{ items, total }`，只含有效的封禁（未到期、未解封），按创建时间倒序。封禁字段：

| 字段 | 说明 |
| --- | --- |
| `id`、`scope`、`cidr` | `cidr` 为规范化的 CIDR，如 `203.0.113.7/32` |
| `reason`、`source` | `source` 为 `manual` 或 `auto`；自动封禁的 `reason` 为 `cc_ip_rate` |
| `siteId`、`siteName` | `platform` 封禁为 `null` |
| `node`、`trigger` | 自动封禁的来源节点 `{ id, name }` 与触发条件 `{ metric, observed, threshold, windowSeconds }`；手动封禁为 `null` |
| `createdBy` | 手动封禁的操作者 `{ type, id, name }` |
| `createdAt`、`expiresAt` | ISO 8601 |
| `seq` | 封禁变化序号（十进制字符串） |
| `distributed` | 是否下发到节点；未共享的自动封禁为 `false` |
| `unappliedNodes` | 上报未能保存该封禁的在线节点数 |

- 同一范围、网站与地址已有有效的手动封禁时，`create` 更新 `reason` 与到期时间并返回同一 `id`，审计 `ban.update`；否则审计 `ban.create`。`delete` 解除任一有效封禁（手动或自动），审计 `ban.delete`。
- `maxTotal` 是有效手动封禁的上限，网站与全局封禁合计；续期不计入新增。`shareAutoBans` 决定自动封禁是否下发到同一集群的其他节点。`setBans` 审计 `system.bans_update`。
- 节点的封禁状态：`GET /nodes/{id}` 的 `banStatus`（`appliedSequence`、`entries`、`capacity`、`unappliedIds`、`unapplied`、`kernelEntries`、`autoEvicted`、`reportedAt`），节点未上报时为 `null`；节点能力见 `supportedFeatures`（`bans-v1`、`kernel-ban-v1`）。

| 错误代码 | 状态 | 场景 |
| --- | --- | --- |
| `BAN_INVALID_CIDR` | 400 | 不是 IP 地址或 CIDR |
| `BAN_PREFIX_TOO_SHORT` | 400 | 前缀短于 `/16`（IPv4）或 `/48`（IPv6）；`data.min` 为下限 |
| `BAN_EXPIRY_OUT_OF_RANGE` | 400 | `durationSeconds` 不在 60–604800 |
| `BAN_PROTECTED_ADDRESS` | 400 | 包含节点地址、回环或未指定地址，或与「放行」类 IP 名单重叠；`data.address` 为冲突的地址 |
| `BAN_PLATFORM_LIMIT` | 409 | 有效的手动封禁达到 `maxTotal`；`data.limit` |
| `BAN_NOT_FOUND` | 404 | 封禁不存在、已到期或已解封 |
| `SITE_NOT_FOUND` | 404 | `siteId` 对应的网站不存在 |

```bash
curl -fsS -X POST -H "x-api-key: $EDGEWEIR_API_KEY" -H 'content-type: application/json' \
  -d '{"scope":"platform","cidr":"203.0.113.0/24","reason":"attack","durationSeconds":86400}' \
  https://cdn-admin.example.com/api/v1/bans
```

行为见 [封禁](../guide/bans.md)。

### 挑战与 CC 防护

| 过程 | 端点 |
| --- | --- |
| `protection.get` | `GET /sites/{id}/protection` |
| `protection.update` | `PATCH /sites/{id}/protection` |
| `security.state` | `GET /sites/{id}/security` |
| `security.events` | `GET /sites/{id}/security/events` |
| `settings.protection`、`settings.setProtection` | `GET`、`PUT /settings/protection` |
| `settings.ccTemplate`、`settings.setCcTemplate` | `GET`、`PUT /settings/cc-template` |

服务账号不能调用这些过程（403 `SERVICE_ACCOUNT_FORBIDDEN`）；只读 AccessKey 只能调用 `GET`。挑战类型与 CC 级别取值：`cookie302`、`js`、`pow`、`captcha`（级别另有 `normal`）。

| 请求 | 字段 |
| --- | --- |
| `PATCH /sites/{id}/protection` | 只修改给出的字段：`underAttack`、`underAttackChallenge`、`passTtlSeconds`（300–86400）、`powDifficulty`（8–24）、`powHighDifficulty`（8–26，不低于 `powDifficulty`）、`logJa4`、`cc`（部分字段，合并到已保存的策略） |
| `cc` | `enabled`、`followTemplate`、`maxLevel`、`highPowInsteadOfCaptcha`、`windowSeconds`（5–60）、`siteQps`、`urlQps`、`ipQps`（0–1000000，0 关闭该条件）、`ipBanSeconds`（60–86400）、`originErrorPercent`（0–100）、`originErrorMinRequests`、`escalateAfterSeconds`（1–3600）、`cooldownSeconds`（1–86400） |
| `GET /sites/{id}/security` | 查询参数 `hours`（1–168，默认 24） |
| `GET /sites/{id}/security/events` | 查询参数 `kind`（`site_level` / `path_level` / `ip_banned`）、`page`、`pageSize`（1–100，默认 50） |
| `PUT /settings/protection` | `underAttack`（全局 Under Attack）、`underAttackChallenge`、`eventRetentionDays`（7–365，默认 30） |
| `PUT /settings/cc-template` | `cc` 中除 `enabled`、`followTemplate` 外的全部字段 |

响应：

| 过程 | 内容 |
| --- | --- |
| `protection.get`、`protection.update` | 上述字段，另有 `siteId`、`cc`（跟随模板时阈值为模板值）、`ccTemplate`（当前 CC 模板）、`effectiveCc`（节点使用的阈值，策略关闭时为 `null`）、`platformUnderAttack`（全局 Under Attack 是否开启）、`updatedAt` |
| `security.state` | `nodes`：集群中每个活动节点的 `{ id, name, online, level, escalatedPaths, reportedAt }`；`topIps`、`topPaths`：近 `hours` 小时事件中的 `{ value, count }`（各最多 10 个，近似值）；`hours` |
| `security.events` | `{ items, total }`，按发生时间倒序；事件字段 `id`、`node`（`{ id, name }`，节点删除后为 `null`）、`occurredAt`、`kind`、`level`、`previousLevel`、`path`、`address`、`metric`、`observed`、`threshold`、`topIps`、`topPaths` |

- 修改发布网站所在集群的配置版本（原因 `site_protection_updated`），审计 `site.protection_update`；全局 Under Attack 变化时发布所有集群（`platform_protection_updated`），审计 `system.protection_update`；修改 CC 模板发布有网站跟随模板的集群（`cc_template_updated`），审计 `system.cc_template_update`。挑战密钥每日轮换发布 `challenge_keys_rotated`。
- 挑战、Under Attack 与 CC 需要节点能力 `challenge-v1`，`logJa4` 另需 `ja4-v1`；集群有活动节点缺少时见[节点能力](#节点能力)。

| 错误代码 | 状态 | 场景 |
| --- | --- | --- |
| `PROTECTION_POW_DIFFICULTY` | 400 | `powHighDifficulty` 低于 `powDifficulty`；`data.min` 为最小允许值 |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

```bash
curl -fsS -X PATCH -H "x-api-key: $EDGEWEIR_API_KEY" -H 'content-type: application/json' \
  -d '{"underAttack":true,"underAttackChallenge":"pow","cc":{"enabled":true,"followTemplate":true}}' \
  https://cdn-admin.example.com/api/v1/sites/<网站 ID>/protection
```

行为见 [挑战与 CC 防护](../guide/challenges.md)。

### 压缩与 OWASP CRS

| 过程 | 端点 |
| --- | --- |
| `https.get`、`https.update` | `GET`、`PUT /sites/{id}/https` |
| `sites.features` | `GET /sites/{id}/features` |
| `waf.get` | `GET /sites/{id}/waf` |
| `waf.update` | `PATCH /sites/{id}/waf` |
| `waf.topRules` | `GET /sites/{id}/waf/rules` |

服务账号不能调用这些过程（403 `SERVICE_ACCOUNT_FORBIDDEN`）；只读 AccessKey 只能调用 `GET`。

| 请求 | 字段 |
| --- | --- |
| `PUT /sites/{id}/https` | `settings` 替换网站的全部 HTTPS 设置，缺省字段取默认值；先 `GET` 再修改。压缩字段：`brotli`、`brotliLevel`（1–11，默认 6）、`brotliMinLength`、`brotliTypes`，`zstd`、`zstdLevel`（1–19，默认 3）、`zstdMinLength`、`zstdTypes`，`gzip`、`gzipMinLength`、`gzipTypes`；最小长度 1–1048576（默认 256），类型为 MIME 类型数组（最多 32 个） |
| `PATCH /sites/{id}/waf` | 只修改给出的字段：`mode`（`off` / `detect` / `block`）、`paranoiaLevel`（1–4）、`anomalyThreshold`（1–1000）、`excludedRuleIds`（900000–999999，不重复，最多 200 个）、`requestBodyLimit`（0–134217728 字节） |
| `GET /sites/{id}/waf/rules` | 查询参数 `range`（`1h` / `6h` / `24h` / `7d` / `30d`，默认 `24h`）、`limit`（1–50，默认 10） |

响应：

| 过程 | 内容 |
| --- | --- |
| `sites.features` | `brotli`、`zstd`、`crs`，各为 `{ available, reason }`；集群有活动节点缺少 `brotli-v1` / `zstd-v1` / `modsecurity-v1` 时 `available` 为 `false`、`reason` 为 `nodes`，否则 `reason` 为 `null` |
| `waf.get`、`waf.update` | `siteId`、上述字段（`excludedRuleIds` 升序）、`updatedAt`（从未保存时为 `null`，此时为默认值：`off`、1、5、`[]`、131072） |
| `waf.topRules` | `{ approximate: true, items: [{ ruleId, requests }] }`，按命中次数倒序 |

- `https.update` 发布网站所在集群（原因 `certificate_updated`），审计 `site.https_update`；`waf.update` 发布（`site_waf_updated`），审计 `site.waf_update`。
- `available` 为 `false` 时仍可经 API 开启，见[节点能力](#节点能力)。
- 网站不存在：404 `SITE_NOT_FOUND`。

```bash
curl -fsS -X PATCH -H "x-api-key: $EDGEWEIR_API_KEY" -H 'content-type: application/json' \
  -d '{"mode":"block","paranoiaLevel":1,"excludedRuleIds":[920350]}' \
  https://cdn-admin.example.com/api/v1/sites/<网站 ID>/waf
curl -fsS -H "x-api-key: $EDGEWEIR_API_KEY" \
  'https://cdn-admin.example.com/api/v1/sites/<网站 ID>/waf/rules?range=1h'
```

行为见 [HTTPS 与证书](../guide/https.md#压缩) 与 [OWASP CRS 托管规则](../guide/waf.md)。

### 清缓存、预热、源站与错误页

| 过程 | 端点 |
| --- | --- |
| `cacheTasks.create`、`cacheTasks.get`、`cacheTasks.list` | `POST /cache-tasks`、`GET /cache-tasks/{id}`、`GET /cache-tasks` |
| `sites.update` | `PATCH /sites/{id}`（`originSettings`、`cacheSettings`） |
| `sites.originHealth` | `GET /sites/{id}/origin-health` |
| `errorPages.get` | `GET /sites/{id}/error-pages` |
| `errorPages.update` | `PUT /sites/{id}/error-pages` |
| `settings.errorPages`、`settings.setErrorPages` | `GET`、`PUT /settings/error-pages` |

服务账号不能调用这些过程（403 `SERVICE_ACCOUNT_FORBIDDEN`）；只读 AccessKey 只能调用 `GET`。

| 请求 | 字段 |
| --- | --- |
| `POST /cache-tasks` | `type`：`url`、`prefix`、`site`、`prefetch`、`host`、`tag`、`sitemap`。`host`：`hosts`（最多 500 个主机名，不带端口或通配符）；`tag`：`siteIds`（1–100）与 `tags`（1–500，去首尾空格后按小写保存，每个 1–128 字节可打印 ASCII，不含逗号）；`sitemap`：`urls` 恰好一个站点地图 URL、`maxUrls`（1–10000，默认 1000）；`prefetch` 与 `sitemap`：`variants`（`desktop` / `mobile`，默认 `["desktop"]`） |
| `PATCH /sites/{id}` | `originSettings.activeHealthCheck`：`enabled`、`path`、`method`（`GET` / `HEAD`）、`expectedStatusMin`、`expectedStatusMax`、`host`、`intervalSeconds`（5–300）、`timeoutSeconds`（1–60，不超过间隔）、`healthyThreshold`、`unhealthyThreshold`（1–10）；`originSettings.sessionAffinity`：`enabled`、`ttlSeconds`（60–604800）；`cacheSettings.keepCacheTag`。省略这三项时保持原值；`originSettings`、`cacheSettings` 的其他字段仍整体替换，先 `GET` 再修改 |
| `PUT /sites/{id}/error-pages` | `pages`：`[{ status, template }]`，`status` 为 403、429、502、503、504，各至多一个，`template` 1–65536 字节（UTF-8）；`interceptOriginErrors`；可选 `expectedUpdatedAt`。整体替换 |
| `PUT /settings/error-pages` | `unknownHost`、`siteDisabled`：模板，空字符串表示内置页面，每个最多 65536 字节 |

响应：

| 过程 | 内容 |
| --- | --- |
| `cacheTasks.*` | 任务对象增加 `variants`（清缓存任务为 `[]`）与 `maxUrls`（站点地图任务以外为 `null`）；`targets` 为 Host、规范化后的标签或站点地图 URL；节点结果的错误码增加 `sitemap_failed`、`sitemap_empty` |
| `sites.originHealth` | 每个源站的 `nodes` 按节点和来源各一项，增加 `source`（`passive` / `active`）；`downNodes` 统计有任一来源不健康的在线节点，每个节点计一次 |
| `sites.features` | 增加 `activeHealthCheck`、`sessionAffinity`、`errorPages`、`purgeByTag`、`prefetchVariants` |
| `errorPages.get`、`errorPages.update` | `siteId`、`pages`（按状态码排序）、`interceptOriginErrors`、`updatedAt`（从未保存时为 `null`） |
| `logs.query`、`logs.export` | 查询参数 `requestId`（精确匹配，最长 128）；日志条目增加 `requestId`，CSV 增加 `requestId` 列 |

- `errorPages.update` 发布网站所在集群（原因 `site_error_pages_updated`），审计 `site.error_pages_update`；`settings.setErrorPages` 发布所有集群（`error_pages_updated`），审计 `system.error_pages_update`。

| 错误代码 | 状态 | 场景 |
| --- | --- | --- |
| `CACHE_TASK_HOST_INVALID` | 400 | Host 带端口、通配符或不是合法主机名；`data.hosts` |
| `CACHE_TASK_TAG_INVALID` | 400 | 标签不符合规则；`data.tags` |
| `CACHE_TASK_HOST_UNKNOWN` | 400 | Host 或站点地图的 Host 不属于任何网站；`data.hosts` |
| `NODE_CAPABILITY_REQUIRED` | 409 | 任务：集群内有活动节点缺少 `purge-tag-v1`（Host、标签）或 `prefetch-v2`（移动端、站点地图）；`data.features` |
| `ERROR_PAGE_TOO_LARGE` | 400 | 模板超过 65536 字节；`data.status`、`data.limit`（平台模板的 `status` 为 404 或 503） |

```bash
curl -fsS -X POST -H "x-api-key: $EDGEWEIR_API_KEY" -H 'content-type: application/json' \
  -d '{"type":"tag","siteIds":["<网站 ID>"],"tags":["product-42"]}' \
  https://cdn-admin.example.com/api/v1/cache-tasks
curl -fsS -X POST -H "x-api-key: $EDGEWEIR_API_KEY" -H 'content-type: application/json' \
  -d '{"type":"sitemap","urls":["https://www.example.com/sitemap.xml"],"maxUrls":2000,"variants":["desktop","mobile"]}' \
  https://cdn-admin.example.com/api/v1/cache-tasks
```

行为见 [源站与缓存](../guide/origins-and-cache.md) 与 [错误页](../guide/error-pages.md)。

### 规则与批量重定向

| 过程 | 端点 |
| --- | --- |
| `rules.get`、`rules.save` | `GET`、`PUT /sites/{id}/rules` |
| `platformRules.get`、`platformRules.save`（全局规则） | `GET`、`PUT /platform-rules` |
| `rules.validate` | `POST /rules/validate` |
| `bulkRedirects.get` | `GET /sites/{id}/bulk-redirects` |
| `bulkRedirects.save` | `PUT /sites/{id}/bulk-redirects` |

服务账号不能调用这些过程（403 `SERVICE_ACCOUNT_FORBIDDEN`）；只读 AccessKey 只能调用 `GET` 与 `POST /rules/validate`。

| 请求 | 字段 |
| --- | --- |
| `PUT /sites/{id}/rules`、`PUT /platform-rules` | `rules`：整体替换，网站最多 64 条、平台最多 32 条；每条 `id`（可选；不是该网站或平台已有规则的 `id` 时重新生成，可直接保存从别处读取的规则）、`name`（1–100 字符）、`phase`、`expression`（最长 4096 字符）、`enabled`、`action`。`phase`：`request-transform`、`redirect`、`config`、`waf-custom`、`ratelimit`、`cache`、`origin`、`response-transform`、`compression` |
| `action`（`kind: "redirect"`） | `value`（静态目标）与 `target`（值表达式）恰好填一个；`statusCode`（301、302、307、308，默认 301）；`preserveQuery`（默认 `false`）；`setQuery`（`[{ name, value }]`，最多 16 个，名称不重复）；`removeQuery`（参数名，最多 16 个，不能与 `setQuery` 重名）。参数名 `[A-Za-z0-9._~-]{1,64}`，值为可打印 ASCII，最长 256 字符 |
| `action`（`kind: "rewrite"`） | 同 `redirect`，没有 `statusCode`；`preserveQuery` 默认 `true` |
| `action`（`kind: "config"`） | 至少一项。`cacheBypass`、`forceHttps`、`gzip`（布尔）；只在 `config` 阶段：`brotli`、`zstd`、`websocket`、`underAttack`、`ccEnabled`（布尔），`ccMaxLevel`（`cookie302`、`js`、`pow`、`captcha`），`originConnectTimeoutMs`（100–120000），`originSendTimeoutMs`、`originReadTimeoutMs`（100–3600000），`logSampleRate`（0–10000，万分比）。省略的字段不覆盖 |
| `action`（`kind: "origin"`） | `origin` 阶段。`originGroup`（网站的源站组，空为默认组；全局规则只能为空）、`hostHeader`、`sni`（主机名，空不覆盖）、`port`（0–65535，0 不覆盖），至少修改一项 |
| `action`（`kind: "compression"`） | `compression` 阶段。`algorithms`：`zstd`、`br`、`gzip` 中不重复的若干个，按优先顺序；`[]` 不压缩 |
| `POST /sites`、`PATCH /sites/{id}` | `cacheRules[]` 增加 `expression`（`cache` 阶段的条件，最长 16384 字符；为空时由 `pathPrefixes`、`paths`、`extensions` 生成；不为空时这三项为空或等于它的构建器形式）与 `browserTtlSeconds`（0–31536000，0 保留源站的 `Cache-Control`）；`origins[]` 增加 `group`（`[a-z0-9_-]{0,32}`，空为默认组，至少一个源站在默认组） |
| `PUT /sites/{id}/bulk-redirects` | `redirects`：整体替换，最多 5000 条，`source` 不重复；每条 `source`（`/路径` 或 `域名/路径`，2–512 字节，不含空白、`?` 与控制字符，域名小写）、`target`（静态重定向目标，最长 1024 字节）、`statusCode`（默认 301）、`preserveQuery`（默认 `false`） |
| `POST /rules/validate` | `expression`（最长 16384 字符）、`phase`、`kind`：`condition`（默认，规则条件）、`value`（`phase` 阶段的重定向目标或改写路径）、`cacheRule`（缓存规则条件，忽略 `phase`） |

响应：

| 过程 | 内容 |
| --- | --- |
| `rules.*`、`platformRules.*` | 规则数组，按保存顺序，带 `id` |
| `bulkRedirects.*` | `[{ source, target, statusCode, preserveQuery }]`，按保存顺序 |
| `sites.get`；`sites.create`、`sites.update` 的 `site` | `cacheRules[]` 总带 `expression`（`"true"` 匹配所有请求）；条件是构建器形状时 `pathPrefixes`、`paths`、`extensions` 为其结构化形式，否则为空；另有 `browserTtlSeconds`。`origins[]` 带 `group` |
| `rules.validate` | `{ valid, position, message }`；无效时 `position` 为出错的字符位置，`message` 为 `invalid_expression` |
| `sites.features` | 增加 `rulesV2`；`reason` 为 `nodes` 时集群有活动节点缺少 `rules-v2` |

- `rules.save` 发布网站所在集群（原因 `rules_updated`），审计 `site.rules_update`；`platformRules.save` 发布所有集群，审计 `platform.rules_update`；`bulkRedirects.save` 发布网站所在集群（`rules_updated`），审计 `site.bulk_redirects_update`（条目数）。
- 用到函数、新字段、值表达式、查询参数编辑、`origin` 或 `compression` 动作、`config` 阶段的新字段、`gzip: true`、非构建器形状的缓存规则条件、`browserTtlSeconds`、批量重定向或非默认源站组的配置要求节点能力 `rules-v2`。

| 错误代码 | 状态 | 场景 |
| --- | --- | --- |
| `RULE_INVALID` | 400 | `origin` 动作选择了网站没有的源站组，或全局规则选择源站组；`sites.update` 移除仍被规则选择的源站组；已保存的规则或缓存规则条件无法编译 |
| `BULK_REDIRECT_HOST_UNKNOWN` | 400 | `域名/路径` 来源的域名不是网站的域名（网站泛域名下一级的子域名可以）；`data.hosts`（逗号分隔，最多 5 个） |
| `IP_LIST_NOT_FOUND` | 404 | 规则或缓存规则条件引用的 IP 名单不存在或不可见 |
| `NODE_CAPABILITY_REQUIRED` | 409 | 集群内有活动节点缺少 `rules-v2`（服务账号与后台任务发布时）；`data.features` |
| `SITE_NOT_FOUND` | 404 | 网站不存在或不在调用方范围内 |

```bash
curl -fsS -X PUT -H "x-api-key: $EDGEWEIR_API_KEY" -H 'content-type: application/json' \
  -d '{"redirects":[{"source":"/old","target":"/new","statusCode":301,"preserveQuery":true}]}' \
  https://cdn-admin.example.com/api/v1/sites/<网站 ID>/bulk-redirects
curl -fsS -X POST -H "x-api-key: $EDGEWEIR_API_KEY" -H 'content-type: application/json' \
  -d '{"expression":"regex_replace(http.request.uri.path, \"^/old/\", \"/new/\")","phase":"redirect","kind":"value"}' \
  https://cdn-admin.example.com/api/v1/rules/validate
```

行为见 [规则、IP 名单与 GeoIP](../guide/rules.md) 与 [源站与缓存](../guide/origins-and-cache.md#源站组)。

### 用量

每个网站、每个 UTC 5 分钟窗口 `[windowStart, windowEnd)` 一条记录，数值为该窗口内全部节点上报的分钟统计之和。

| 过程 | 端点 | 查询参数 |
| --- | --- | --- |
| `usage.list` | `GET /usage` | `from`、`to`（按 5 分钟对齐，UTC，半开区间）、`siteId`、`cursor`、`limit`（1–5000，默认 1000） |
| `usage.changes` | `GET /usage/changes` | `afterSeq`（默认 `"0"`）、`limit`（1–5000，默认 1000） |

记录字段：

| 字段 | 说明 |
| --- | --- |
| `id` | `<siteId>.<windowStart 的 Unix 秒>`，同一网站同一窗口永远相同 |
| `siteId` | 网站删除后记录仍保留 |
| `windowStart`、`windowEnd` | ISO 8601 |
| `requests`、`bytesSent`、`bytesReceived` | 十进制整数字符串（出站、入站字节），超过 2^53 时仍精确 |
| `revision` | 从 1 开始；重算后数值变化时加 1 |
| `seq` | 全局单调递增（十进制字符串，可有间隔）；创建或修订时分配 |
| `updatedAt` | 最近一次写入时间 |

- `usage.list` 按（窗口，网站）排序，响应 `{ items, nextCursor, completeUntil }`；`nextCursor` 为 `null` 时没有下一页。`from`、`to` 未对齐或 `to` 不晚于 `from`：400 `USAGE_RANGE_INVALID`；游标无效：400 `USAGE_CURSOR_INVALID`。
- `usage.changes` 按 `seq` 返回 `afterSeq` 之后创建或修订的记录，响应 `{ items, lastSeq, completeUntil }`；下次以 `lastSeq` 作为 `afterSeq`。被修订的记录会再次出现。
- 没有流量的窗口没有记录。
- 窗口结束后每分钟重算一次；迟到数据改变数值时 `revision` 加 1 并分配新的 `seq`，数值不变时两者都不变。同一统计批次重复上报不改变结果。
- 保留期默认 100 天，**系统设置 → 用量** 可调（35–400 天）。

`completeUntil`（ISO 8601 或 `null`）：结束时间不晚于它的窗口，已包含当时所有活动节点的数据。

| 规则 | 说明 |
| --- | --- |
| 节点水位 | 节点在全部统计批次确认后上报 `complete_until`：最近一次成功取出统计时所在分钟的开始，之前的分钟都已上报。控制台不可达时节点照常把统计存入本地缓冲，节点退出前先存下包括当前分钟在内的统计；缓冲超出上限丢弃过统计时，水位停在丢弃的最早一分钟，24 小时后恢复 |
| 参与的节点 | 状态为启用、且在离线阈值内上报过心跳的节点。阈值默认 60 分钟，**系统设置 → 用量** 可调（5–1440 分钟） |
| 计算 | 参与节点水位的最小值；从未上报水位的节点（旧版本节点）按注册时间计；落后超过离线阈值的节点按「当前时间减阈值」计（与离线节点一样，它之后补报的数据按修订处理）；尚未重算的窗口不计入；向下取整到 5 分钟 |
| 单调 | 只前移不后退。离线超过阈值的节点恢复后，它补报的更早窗口的数据按修订处理（`revision` 加 1） |
| 停用或删除的节点 | 不参与 |

### 节点升级

| 过程 | 端点 | 说明 |
| --- | --- | --- |
| `upgrades.release` | `GET /node-releases/{version}` | 发布源中该版本各架构的发布物 |
| `upgrades.list` | `GET /node-upgrades` | 升级任务；查询参数 `clusterId` |
| `upgrades.create` | `POST /node-upgrades` | `{ version, nodeGroupId }`：`version` 不带 `v` 前缀，`nodeGroupId` 为先升级的节点组 |
| `upgrades.promote` | `POST /node-upgrades/{id}/promote` | 推进剩余节点 |
| `upgrades.cancel` | `POST /node-upgrades/{id}/cancel` | 取消「等待试运行组」与「待执行」的节点任务 |

服务账号不能调用这些过程（403 `SERVICE_ACCOUNT_FORBIDDEN`）；只读 AccessKey 只能调用 `GET`。

| 错误代码 | 状态 | 场景 |
| --- | --- | --- |
| `UPGRADE_RELEASE_UNAVAILABLE` | 502 | 发布源中读不到该版本的清单，或清单中没有支持的归档 |
| `UPGRADE_NODES_UNAVAILABLE` | 409 | 所选节点组没有已启用节点，或集群中有已启用节点不满足升级前提 |
| `UPGRADE_BUSY` | 409 | 节点已有进行中的升级；取消时有节点正在升级，或任务已结束 |
| `UPGRADE_NOT_READY` | 409 | 试运行组尚未满足推进条件 |
| `UPGRADE_NOT_FOUND` | 404 | 升级任务不存在 |

前提、状态与节点侧校验见[节点升级](../guide/node-upgrades.md)。

### 区域探针、调度地址与智能调度

| 过程 | 端点 | 说明 |
| --- | --- | --- |
| `probes.list` | `GET /probes` | 全部探针 |
| `probes.createToken` | `POST /probe-tokens` | 一次性探针注册令牌 |
| `probes.update` | `PATCH /probes/{id}` | 改名、停用或启用 |
| `probes.delete` | `DELETE /probes/{id}` | 删除探针并吊销其证书 |
| `probes.results` | `GET /probe-results` | 最新探测结果 |
| `settings.probes`、`settings.setProbes` | `GET`、`PUT /settings/probes` | 探测设置 |
| `nodes.setAddresses` | `PUT /nodes/{id}/addresses` | 节点的调度地址与级别 |
| `nodes.setProbe` | `PUT /nodes/{id}/probe` | 节点兼任探针 |
| `scheduling.list` | `GET /scheduling/rules` | 调度规则；查询参数 `clusterId`（可选） |
| `scheduling.create` | `POST /scheduling/rules` | 新建规则，返回 201 |
| `scheduling.update` | `PATCH /scheduling/rules/{id}` | 只修改给出的字段 |
| `scheduling.delete` | `DELETE /scheduling/rules/{id}` | 删除规则；生效中的动作恢复 |
| `scheduling.preview` | `GET /clusters/{clusterId}/scheduling/preview` | 按当前指标预览全部规则，不写入 |

服务账号不能调用这些过程（403 `SERVICE_ACCOUNT_FORBIDDEN`）；只读 AccessKey 只能调用 `GET`。`POST /probe-tokens` 不接受 `Idempotency-Key`（见[幂等键](#幂等键)）。

| 请求 | 字段 |
| --- | --- |
| `POST /probe-tokens` | `name`（1–64 字符）、`regionId`、`ttlMinutes`（5–10080，默认 60） |
| `PATCH /probes/{id}` | `name`（1–64 字符）、`enabled`，均可选。停用时删除该探针的结果 |
| `GET /probe-results` | 查询参数 `probeId`（探针 ID，或兼任探针的节点 ID）、`nodeId`（被探测的节点），均可选 |
| `PUT /settings/probes` | 整体替换：`intervalSeconds`（5–60）、`timeoutMs`（500–10000，不超过 `intervalSeconds × 1000`）、`attempts`（1–10）、`lossPercent`（1–100）、`ipDownSeconds`、`ipUpSeconds`（5–3600） |
| `PUT /nodes/{id}/addresses` | `addresses`：整体替换，至多 8 个 `{ address, level }`；`address` 为单个单播 IP（可为私网地址），不重复；`level` 为 0（主）、1（备 1）、2（备 2），非空时须有 `level` 0；`[]` 恢复为上报地址。发布集群的 DNS 版本（原因 `manual`） |
| `PUT /nodes/{id}/probe` | `enabled`；关闭时删除该节点的探测结果 |
| `POST /scheduling/rules` | `clusterId`、`lineName`（集群 DNS 绑定中的线路名称，`null` 为全部线路，默认 `null`；`backup_group` 必须有）、`name`（1–100 字符）、`enabled`（默认 `true`）、`match`（`all` 默认 / `any`）、`conditions`、`action`（`remove_node`、`backup_group`、`backup_ip`）、`holdSeconds`、`recoverSeconds`（0–86400，默认 300） |
| `conditions[]` | 1–8 个：`metric`（`cpu_percent`、`load1`、`memory_percent`、`egress_mbps`、`connections`、`probe_loss_percent`、`probe_latency_ms`）、`aggregate`（`avg` 默认 / `max` / `min`）、`comparator`（`gt`、`ge`、`lt`、`le`）、`threshold`（0–10¹²）、`durationSeconds`（0–3600，默认 0）、`regionId`（只用于 `probe_loss_percent`、`probe_latency_ms`，默认 `null`） |
| `PATCH /scheduling/rules/{id}` | `POST` 中除 `clusterId` 外的字段，均可选。`enabled: false`，或 `lineName`、`match`、`action`、`conditions` 与当前不同时，生效中的动作先恢复，状态重新开始；只修改 `name`、`holdSeconds`、`recoverSeconds` 时不影响。`lineName` 只在修改 `lineName` 或 `action` 时检查 |

| 过程 | 响应 |
| --- | --- |
| `probes.list`、`probes.update` | 探针：`id`、`name`、`regionId`、`regionName`、`regionCode`、`enabled`、`online`、`lastSeenAt`、`enrolledAt`、`hostname`、`agentVersion`、`os`、`arch`、`certNotAfter`、`targets`、`lastRound`（`{ checkedAt, results, failed, lossPercent, avgRttMs }`，没有结果时为 `null`）、`createdAt` |
| `probes.createToken` | `tokenId`、`token`（`ewp_…`，只返回一次）、`expiresAt`、`serverUrl`（节点通道）、`caSha256`、`command`（`docker run` 启动命令） |
| `probes.delete`、`scheduling.delete` | `{ ok: true }` |
| `probes.results` | 按节点、地址、端口、探测方排序，至多 5000 条：`proberKind`（`probe` / `node`）、`proberId`、`proberName`、`regionId`、`regionName`、`nodeId`、`nodeName`、`address`、`port`、`method`（`tcp` / `http` / `https`）、`sent`、`lost`、`lossPercent`、`rttMs`（成功尝试的中位数，全部丢失时为 0）、`error`（`timeout`、`refused`、`reset`、`tls`、`status`、`unreachable`）、`checkedAt` |
| `settings.probes`、`settings.setProbes` | 探测设置；从未保存时为默认值 10、3000、3、50、30、60 |
| `nodes.*` 返回的节点 | 增加 `probeEnabled`；`metrics`（`{ cpuPercent, load1, load5, load15, memoryUsedBytes, memoryTotalBytes, egressBps, activeConnections, reportedAt }`，最近一次心跳没有指标（节点缺少 `metrics-v1`）时为 `null`）；`schedulingAddresses`（`[{ address, level, source, reachable }]`，`source` 为 `reported` 或 `configured`）；`schedulingLevel`（DNS 当前使用的级别） |
| `scheduling.list`、`scheduling.create`、`scheduling.update` | 规则：`id`、`clusterId`、请求中的字段（条件补齐默认值）、`activeNodes`（`[{ nodeId, nodeName, since }]`，生效中与恢复中的节点）、`createdAt`、`updatedAt` |
| `scheduling.preview` | `{ clusterId, evaluatedAt, rules }`。每条规则：`ruleId`、`ruleName`、`enabled`、`lineName`、`match`、`action`、`nodes`。每个节点：`nodeId`、`nodeName`、`state`（`idle`、`pending`、`active`、`recovering`）、`conditions`（条件字段与 `value`（没有数据为 `null`）、`holds`、`heldSeconds`、`satisfied`）、`matches`、`inEffect`、`wouldActivate`、`wouldRecover`、`activeSince`、`recoveringSince`、`recoversAt` |

DNS 绑定与记录的新增字段：

| 请求或响应 | 字段 |
| --- | --- |
| `PUT /clusters/{clusterId}/dns` 的 `binding.lines[]` | 增加 `resolutionLine`（`default` 默认、`telecom`、`unicom`、`mobile`、`edu`、`overseas`）、`backupNodeGroupIds`（本集群的节点组，至多 4 个，不重复，不含本线路的节点组，默认 `[]`）、`minHealthyIps`（1–64，默认 1）。`GET` 对此前保存的线路返回默认值 |
| `GET /clusters/{clusterId}/dns` 与 `GET /clusters/{clusterId}/dns/export` 的 `records[]` | 增加 `line`：记录的解析线路；默认线路的记录没有此字段 |
| DNS 版本（`revision`、`blocked`、`GET /clusters/{clusterId}/dns/revisions` 等） | `reason` 为 `manual`、`health`、`rollback`、`force` 或 `scheduling`；增加 `reasonParams`：`scheduling` 为 `ruleId`、`rule`、`nodeId`、`node`、`action`、`event`（`activated` / `recovered`），其他原因为 `{}` |
| `GET /dns/catalog` | `capabilities.lines` 由布尔值改为服务商支持的解析线路数组 |

| 错误代码 | 状态 | 场景 |
| --- | --- | --- |
| `DNS_LINE_UNSUPPORTED` | 400 | 绑定线路的 `resolutionLine` 不在服务商账号支持的线路中；`data.line` |
| `REGION_IN_USE` | 409 | 删除仍有探针的区域（`regions.delete`）；`data.probes` 为探针数 |
| `PROBE_NOT_FOUND` | 404 | 探针不存在；`probes.results` 的 `probeId` 既不是探针也不是节点 |
| `NODE_REGION_REQUIRED` | 409 | `nodes.setProbe` 开启时，节点的节点组没有区域 |
| `NODE_ADDRESS_INVALID` | 400 | 调度地址不是单个单播 IP（CIDR、主机名、回环、链路本地、组播等）或重复；`data.address` |
| `SCHEDULING_RULE_NOT_FOUND` | 404 | 规则不存在 |
| `SCHEDULING_RULE_INVALID` | 400 | `backup_group` 没有 `lineName`，或 `lineName` 不在集群的 DNS 绑定中 |
| `REGION_NOT_FOUND` | 404 | `probes.createToken` 的 `regionId` 或条件的 `regionId` 不存在 |
| `NODE_NOT_FOUND` | 404 | 节点不存在，含 `probes.results` 的 `nodeId` |
| `CLUSTER_NOT_FOUND` | 404 | 规则或预览的集群不存在 |
| `BAD_REQUEST` | 400 | 输入校验失败，例如 `timeoutMs` 超过探测间隔、调度地址没有 `level` 0、非探测指标带 `regionId` |

行为见[区域探针与智能调度](../guide/scheduling.md)与[DNS 调度与告警](../guide/dns-and-alerts.md#按解析线路写入)。

### 端口池与 L4 应用

| 过程 | 端点 | 说明 |
| --- | --- | --- |
| `clusters.portPools` | `GET /clusters/{clusterId}/port-pools` | 集群的端口池、保留端口与缺少 `l4-v1` 的节点 |
| `clusters.setPortPools` | `PUT /clusters/{clusterId}/port-pools` | 整体替换端口池；不发布配置版本 |
| `l4Apps.list` | `GET /l4-apps` | L4 应用，按端口、协议排序；查询参数 `clusterId`（可选） |
| `l4Apps.get` | `GET /l4-apps/{id}` | 一个应用 |
| `l4Apps.create` | `POST /l4-apps` | 新建应用，返回 201 |
| `l4Apps.update` | `PATCH /l4-apps/{id}` | 只修改给出的字段 |
| `l4Apps.setEnabled` | `PUT /l4-apps/{id}/enabled` | 停用或启用 |
| `l4Apps.delete` | `DELETE /l4-apps/{id}` | 删除应用、源站与统计 |
| `l4Apps.stats` | `GET /l4-apps/{id}/stats` | 按分钟的统计 |

服务账号不能调用这些过程（403 `SERVICE_ACCOUNT_FORBIDDEN`）；只读 AccessKey 只能调用 `GET`。

| 请求 | 字段 |
| --- | --- |
| `PUT /clusters/{clusterId}/port-pools` | `pools`：整体替换，最多 64 个 `{ protocol, from, to }`；`protocol` 为 `tcp`、`udp` 或 `both`，`from`、`to` 为 1024–65535，`from` 不大于 `to` |
| `POST /l4-apps` | `clusterId`、`name`（1–100 字符，去掉首尾空格）、`protocol`（`tcp` / `udp`）、`port`（1024–65535）、`origins`；可选：`enabled`（默认 `true`）、`acceptProxyProtocol`（默认 `false`）、`proxyProtocolVersion`（0–2，0 不发送，默认 0）、`maxFails`（1–100，默认 3）、`failTimeoutSeconds`（1–3600，默认 30）、`connectTimeoutMs`（100–60000，默认 5000）、`idleTimeoutSeconds`（1–86400，省略时 TCP 为 600、UDP 为 30）、`allowListIds`、`blockListIds`（IP 名单 ID，各最多 16 个，去重，默认 `[]`）、`maxConnections`（0–10000000）、`newConnectionsPerSecond`（0–1000000），后两项 0 表示不限，默认 0 |
| `origins[]` | 1–32 个 `{ address, port, weight, backup }`：`address` 为主机名或 IP，规则同网站源站；`port` 1–65535；`weight` 1–100，默认 1；`backup` 默认 `false`。至少一个源站的 `backup` 为 `false` |
| `PATCH /l4-apps/{id}` | `POST` 中除 `clusterId`、`enabled` 外的字段，均可选；`origins` 整体替换，地址与端口不变的源站保留 ID（节点上的被动健康状态随之保留）；修改 `protocol` 不改变 `idleTimeoutSeconds`；可选 `expectedUpdatedAt` |
| `PUT /l4-apps/{id}/enabled` | `enabled`；可选 `expectedUpdatedAt` |
| `GET /l4-apps/{id}/stats` | 查询参数 `from`、`to`（ISO 8601），`from` 早于 `to`，范围最长 7 天 |

| 过程 | 响应 |
| --- | --- |
| `clusters.portPools`、`clusters.setPortPools` | `clusterId`；`pools`（按起始端口、协议排序）；`reservedPorts`（集群 HTTP / HTTPS 监听的端口，不能进入端口池）；`nodesWithoutL4`（`[{ id, name }]`，集群中不上报 `l4-v1` 的活动节点） |
| `l4Apps.list`、`l4Apps.get` 与其他过程返回的应用 | `id`、`clusterId`、`clusterName`、`name`、`protocol`、`port`、`enabled`、`acceptProxyProtocol`、`proxyProtocolVersion`、`origins`（`[{ id, address, port, weight, backup }]`，按保存顺序）、`maxFails`、`failTimeoutSeconds`、`connectTimeoutMs`、`idleTimeoutSeconds`、`allowListIds`、`blockListIds`、`maxConnections`、`newConnectionsPerSecond`、`dnsTarget`、`dnsLines`、`createdAt`、`updatedAt` |
| `dnsTarget` | 客户端连接的 CNAME `<应用 ID>.<集群域名>`，只在应用启用时发布；集群 DNS 为「不管理」时为 `null` |
| `dnsLines` | 每条绑定线路 `{ name, target }`：开启线路别名时 `target` 为 `<线路>.<应用 ID>.<集群域名>`，否则为 `<线路>.<集群域名>` |
| `l4Apps.create`、`l4Apps.update`、`l4Apps.setEnabled` | `{ app, revision }` |
| `l4Apps.delete` | `{ revision }` |
| `l4Apps.stats` | `appId`、`from`、`to`；`bucketSeconds`：范围不超过 1 天为 60，不超过 5 天为 300，否则 3600；`points`：从 `from` 所在的桶起每桶一项，最早在前，空桶为 0；`totals`；`nodes`：每个上报节点 `{ nodeId, nodeName, … }`，连接数多的在前 |
| 统计计数 | `connections`（接受的连接或 UDP 会话）、`refused`（被 IP 名单或上限拒绝）、`peakConcurrent`、`bytesReceived`（来自客户端）、`bytesSent`（发往客户端）。`peakConcurrent` 在 `points`、`totals` 中为每分钟各节点峰值之和在桶或范围内的最大值，在 `nodes` 中为该节点自己的最大值 |

- `create`、`update` 发布集群的配置版本（原因 `l4_app_created`、`l4_app_updated`），审计 `l4_app.create`、`l4_app.update`；`setEnabled` 状态变化时发布（`l4_app_updated`），审计 `l4_app.enable`、`l4_app.disable`，状态不变时返回最新版本，不发布、不写审计；`delete` 发布（`l4_app_deleted`），审计 `l4_app.delete`。`setPortPools` 审计 `cluster.port_pools_update`。
- 配置中有启用的应用时要求节点能力 `l4-v1`，见[节点能力](#节点能力)。

| 错误代码 | 状态 | 场景 |
| --- | --- | --- |
| `L4_APP_NOT_FOUND` | 404 | 应用不存在 |
| `L4_APP_LIMIT` | 409 | 集群已有 256 个应用（含停用的）；`data.limit` |
| `L4_PORT_OUTSIDE_POOL` | 400 | 端口不在集群该协议的端口池内；`data.port` |
| `L4_PORT_IN_USE` | 409 | 同一集群同一协议的端口已有应用（含停用的），或新的端口池会把应用的端口留在池外；`data.apps`（`名称 (端口/协议)`，逗号分隔） |
| `L4_PORT_RESERVED` | 400 | 端口池或应用端口是集群 HTTP / HTTPS 监听的端口；`data.port` |
| `L4_PORT_POOL_OVERLAP` | 400 | 同一协议的端口池重叠，`both` 与 `tcp`、`udp` 都重叠；`data.pools`（`起始-结束/协议`，逗号分隔） |
| `L4_PROXY_PROTOCOL_UNSUPPORTED` | 400 | UDP 应用设置了 `acceptProxyProtocol` 或非 0 的 `proxyProtocolVersion` |
| `IP_LIST_NOT_FOUND` | 404 | `allowListIds` 或 `blockListIds` 中的名单不存在 |
| `IP_LIST_IN_USE` | 409 | `DELETE /ip-lists/{id}` 删除仍被规则、缓存规则条件或 L4 应用引用的名单 |
| `ORIGIN_ADDRESS_FORBIDDEN` | 400 | 源站为特殊用途地址且不在源站地址允许清单内；`data.address`、`data.range` |
| `UPDATED_AT_MISMATCH` | 409 | `expectedUpdatedAt` 不是当前值 |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |
| `BAD_REQUEST` | 400 | 输入校验失败，例如端口低于 1024、`from` 大于 `to`、源站全为备用、统计范围超过 7 天 |

```bash
curl -fsS -X PUT -H "x-api-key: $EDGEWEIR_API_KEY" -H 'content-type: application/json' \
  -d '{"pools":[{"protocol":"both","from":20000,"to":20100}]}' \
  https://cdn-admin.example.com/api/v1/clusters/<集群 ID>/port-pools
curl -fsS -X POST -H "x-api-key: $EDGEWEIR_API_KEY" -H 'content-type: application/json' \
  -d '{"clusterId":"<集群 ID>","name":"game","protocol":"tcp","port":20000,"origins":[{"address":"game-origin.example.com","port":7000}],"proxyProtocolVersion":2}' \
  https://cdn-admin.example.com/api/v1/l4-apps
```

行为见[四层转发](../guide/l4.md)。

### 示例

列出网站（过程 `sites.list`，`GET /api/v1/sites`）：

```bash
curl -fsS -H "x-api-key: $EDGEWEIR_API_KEY" \
  "https://cdn-admin.example.com/api/v1/sites?page=1&pageSize=20"
```

| 查询参数 | 说明 |
| --- | --- |
| `search` | 匹配网站名称或任一域名，最长 100 字符 |
| `clusterId` | 集群 UUID |
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

认证与输入校验失败使用 oRPC 通用代码：`UNAUTHORIZED`（401）、`BAD_REQUEST`（400）。

## Web UI 接口

`/rpc/*` 使用 oRPC RPC 协议，供 Web UI 调用，路径为过程路径，例如 `POST /rpc/sites/list`。

| 要求 | 说明 |
| --- | --- |
| 会话 Cookie | 由 `/api/auth` 的登录端点签发 |
| `x-csrf-token: orpc` | 缺少时返回 403 |
| `x-api-key` | 被剥离，不能代替会话 Cookie |

第三方集成使用 `/api/v1`。

## 认证端点

`/api/auth/*` 由 better-auth 处理，只放行下表中的路径与方法。匹配为精确匹配（不接受前缀、编码变体或结尾斜杠），其余请求返回 404。请求中的 `x-api-key` 被剥离；客户端 IP 按 `EDGEWEIR_TRUSTED_PROXIES` 解析后传入。控制台不开放注册，唯一的账户由初始化向导创建；AccessKey 经 `accessKeys.*` 管理。`NODE_ENV=production` 时启用限速，计数存于 PostgreSQL。

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

`<项目>` 为 `edgeweir-node` 或 `cosign`；`edgeweir-openresty`、`edgeweir-openresty-modsecurity` 软件包放在 `edgeweir-node` 的同一版本目录。其他路径、不存在的文件、指向目录外的符号链接返回 404。目录准备见[接入节点](../deploy/nodes.md)。

## 节点通道

| 项 | 值 |
| --- | --- |
| 协议 | Connect-RPC，HTTPS（HTTP/2，兼容 HTTP/1.1），TLS 1.2 及以上 |
| 监听 | `NODE_API_HOST:NODE_API_PORT`，默认 `8443` |
| 服务 | `edgeweir.node.v1.NodeService`（节点）与 `edgeweir.node.v1.ProbeService`（区域探针与兼任探针的节点），定义见 [`proto/edgeweir/node/v1/node.proto`](https://github.com/marvinli001/edgeweir/blob/master/proto/edgeweir/node/v1/node.proto) 与 [`probe.proto`](https://github.com/marvinli001/edgeweir/blob/master/proto/edgeweir/node/v1/probe.proto) |
| 服务器证书 | 控制台内部 CA 在每次启动时签发，名称见[环境变量](environment.md#访问地址与网络) |
| 认证 | `Enroll`、`EnrollProbe`：一次性注册 token（`ewt_`、`ewp_`），节点或探针预先固定内部 CA 的 SHA-256 指纹。其他 RPC：内部 CA 签发的客户端证书（mTLS），CN 为节点 ID（`O=Edgeweir Node`）或探针 ID（`O=Edgeweir Probe`）；探针证书只能调用 `ProbeService`，节点证书只在节点兼任探针时调用 `GetProbeTargets`、`ReportProbeResults` |
| 其他路径 | 404 |

> [!WARNING]
> 节点通道必须直连或四层透传；终结 TLS 的代理会使节点 mTLS 失败。见[端口、反向代理与可信代理](../deploy/networking.md)。
