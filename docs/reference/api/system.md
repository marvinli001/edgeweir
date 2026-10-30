# API：系统与账户

初始化、调用方账户、AccessKey、服务账号与系统设置的过程，共 47 个。

权限级别、认证、幂等键与错误格式见 [API 概览](../api.md)。

## 初始化与状态

- 两个过程都无需密钥。初始化向导见 [账户](../../guide/account.md#账户)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`system.status`](#systemstatus) | `GET /system/status` | 公开；服务账号（无需 scope） |
| [`system.setup`](#systemsetup) | `POST /system/setup` | 公开 |

### `system.status`

`GET /system/status` · 公开 · 服务账号（无需 scope）

无参数。

响应：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `initialized` | boolean | 已有管理账户（演示账号不计） |
| `version` | string | 控制台版本 |
| `demo` | boolean | 演示账号已打开，登录页提供演示账号登录 |

### `system.setup`

`POST /system/setup` · 公开

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `setupToken` | body | string | 是 | 去掉首尾空格后 1–200 字符 | 控制台启动时写入日志的一次性初始化令牌 |
| `name` | body | string | 是 | 去掉首尾空格后 1–100 字符 | 姓名 |
| `email` | body | string | 是 | 电子邮件地址；转为小写 | 登录邮箱 |
| `password` | body | string | 是 | 12–128 字符 | 密码 |

只在没有管理账户时可用。创建唯一的管理账户；没有集群时创建集群 `default`；令牌随即作废。不建立会话。审计 `system.setup`；令牌不符时审计 `system.setup_rejected`（元数据 `email`）。任一步骤失败时删除已创建的账户，令牌保持可用。

响应：`{ userId }`：新账户的 ID（string）。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SETUP_IN_PROGRESS` | 409 | 另一个初始化请求正在进行 |
| `SETUP_DONE` | 403 | 已有管理账户 |
| `SETUP_TOKEN_INVALID` | 403 | 令牌不符或已使用 |

## 账户

- `hiddenCards.*` 读写调用方账户的个人偏好，不写审计；用 AccessKey 调用时为管理账户的偏好。行为见 [自定义卡片](../../guide/overview.md#自定义卡片)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`account.me`](#accountme) | `GET /me` | 读；服务账号（无需 scope） |
| [`hiddenCards.get`](#hiddencardsget) | `GET /hidden-cards` | 读 |
| [`hiddenCards.update`](#hiddencardsupdate) | `PATCH /hidden-cards` | 写 |

### `account.me`

`GET /me` · 读 · 服务账号（无需 scope）

无参数。

响应：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `user.id` | string | 账户 ID；服务账号为服务账号 ID |
| `user.name` | string | 姓名；服务账号为服务账号名称 |
| `user.email` | string | 登录邮箱；服务账号为空字符串 |
| `user.twoFactorEnabled` | boolean | 已开启两步验证；服务账号为 `false` |
| `serviceAccount` | object | 调用方为服务账号时为 `{ id, name, scopes }`，否则为 `null` |
| `demo` | boolean | 调用方为演示账号 |

### `hiddenCards.get`

`GET /hidden-cards` · 读

无参数。

响应：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `overview` | `array<enum>` | 概览中隐藏的卡片 ID，按页面上的顺序 |
| `site` | `array<enum>` | 网站「统计」页签中隐藏的卡片 ID（所有网站共用），按页面上的顺序 |

未列出的卡片都显示。从未保存时两项都为 `[]`。当前版本不认识的已保存 ID 不返回。

### `hiddenCards.update`

`PATCH /hidden-cards` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `overview` | body | `array<enum>` | 否 | 至多 21 个，取值见下表；去重；省略时不变 | 替换概览的隐藏卡片 |
| `site` | body | `array<enum>` | 否 | 至多 14 个，取值见下表；去重；省略时不变 | 替换网站统计的隐藏卡片 |

两项都省略时返回 400 `BAD_REQUEST`。空数组显示该页面的全部卡片。

| 页面 | 卡片 ID |
| --- | --- |
| `overview` | `live-requests`、`live-egress`、`live-hit-ratio`、`live-nodes`、`requests`、`data-transfer`、`edge-network`、`hit-ratio`、`peak-bandwidth`、`4xx-rate`、`5xx-rate`、`status-codes`、`top-sites`、`top-nodes`、`top-countries`、`top-urls`、`top-ips`、`revisions`、`recents`、`sites`、`nodes` |
| `site` | `requests`、`data-transfer`、`hit-ratio`、`peak-bandwidth`、`4xx-rate`、`5xx-rate`、`status-codes`、`top-urls`、`top-ips`、`countries`、`asns`、`referers`、`clients`、`protocols` |

响应：同 [`hiddenCards.get`](#hiddencardsget)。

## AccessKey

- 管理调用方账户的 AccessKey；用 AccessKey 调用时为管理账户的密钥。用法见 [AccessKey](../../guide/access-logs.md#accesskey)。
- 密钥为 `ewk_` 加 64 个字母，只在 `accessKeys.create` 的响应中返回一次；`prefix` 为其前 6 个字符。`scope` 为 `read`（读级别的过程）或 `write`（全部过程）；没有记录权限的旧密钥按 `write`。
- `requestsPerMinute`：1–100000，或 `null`（不限）。每个密钥按 60 秒的窗口计数，窗口从上一个窗口结束后的第一个请求开始；窗口内超出上限返回 429 `API_KEY_RATE_LIMITED`，`data.retryAfterSeconds` 为到窗口结束的秒数。计数保存在控制台进程内，重启后清零；修改上限后重新计数。
- 审计 `api_key.create`、`api_key.update`（元数据为前后的 `name` 与 `requestsPerMinute`）、`api_key.revoke`；元数据不含密钥。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`accessKeys.list`](#accesskeyslist) | `GET /access-keys` | 读 |
| [`accessKeys.create`](#accesskeyscreate) | `POST /access-keys` | 写；仅会话 |
| [`accessKeys.update`](#accesskeysupdate) | `PATCH /access-keys/{id}` | 写；仅会话 |
| [`accessKeys.revoke`](#accesskeysrevoke) | `DELETE /access-keys/{id}` | 写 |

### `accessKeys.list`

`GET /access-keys` · 读

无参数。

响应：[AccessKey](#accesskey-对象)`[]`，按创建时间升序，含已吊销的密钥（`enabled` 为 `false`）。

### `accessKeys.create`

`POST /access-keys` · 写 · 仅会话 · 不接受 `Idempotency-Key`

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `name` | body | string | 是 | 去掉首尾空格后 1–64 字符 | 名称 |
| `scope` | body | enum | 否 | `read` / `write`，默认 `write` | 权限范围 |
| `requestsPerMinute` | body | integer | 否 | 1–100000 或 `null`，默认 `600` | 每分钟请求数上限，`null` 为不限 |

只能以控制台登录会话调用。

响应：[AccessKey](#accesskey-对象)，另加 `key`（string）：完整密钥，只返回这一次。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `ACCESS_KEY_SESSION_REQUIRED` | 403 | 用 AccessKey 调用 |

### `accessKeys.update`

`PATCH /access-keys/{id}` · 写 · 仅会话

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | string | 是 | 1–128 字符 | 密钥 ID |
| `name` | body | string | 否 | 去掉首尾空格后 1–64 字符；省略时不变 | 名称 |
| `requestsPerMinute` | body | integer | 否 | 1–100000 或 `null`；省略时不变 | 每分钟请求数上限，`null` 为不限 |

只能以控制台登录会话调用。上限改变时该密钥重新计数。

响应：[AccessKey](#accesskey-对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `ACCESS_KEY_SESSION_REQUIRED` | 403 | 用 AccessKey 调用 |
| `ACCESS_KEY_NOT_FOUND` | 404 | 调用方账户没有该密钥 |
| `ACCESS_KEY_REVOKED` | 409 | 密钥已吊销 |

### `accessKeys.revoke`

`DELETE /access-keys/{id}` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | string | 是 | 1–128 字符 | 密钥 ID |

`enabled` 置为 `false`，密钥保留在列表中；之后使用它的请求返回 401。再次吊销已吊销的密钥同样返回成功，并再写一条审计。

响应：`{ ok: true }`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `ACCESS_KEY_NOT_FOUND` | 404 | 调用方账户没有该密钥 |

## 服务账号

- 行为见 [服务账号](../../guide/system.md#服务账号)。服务账号不能调用本节的过程。
- key 为 `ews_` 加 43 个 base64url 字符，只在 `serviceAccounts.createKey` 的响应中返回一次，控制台只保存其 SHA-256；`prefix` 为其前 12 个字符。停用账号的 key 与已吊销的 key 返回 401。服务账号 key 没有请求数上限。
- 审计 `service_account.create`、`service_account.update`、`service_account.delete`、`service_account.key_create`、`service_account.key_revoke`。
- 无需 scope 的过程：`system.status`、`account.me`、`dns.catalog`。各 scope 可调用的过程：

| scope | 过程 |
| --- | --- |
| `system:read` | `settings.get` |
| `clusters:read` | `clusters.list`、`clusters.get` |
| `sites:read` | `sites.list`、`sites.get`、`sites.launch`、`dns.siteTarget` |
| `sites:write` | `sites.setEnabled` |
| `usage:read` | `usage.list`、`usage.changes` |

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`serviceAccounts.list`](#serviceaccountslist) | `GET /service-accounts` | 读 |
| [`serviceAccounts.create`](#serviceaccountscreate) | `POST /service-accounts` | 写 |
| [`serviceAccounts.update`](#serviceaccountsupdate) | `PATCH /service-accounts/{id}` | 写 |
| [`serviceAccounts.delete`](#serviceaccountsdelete) | `DELETE /service-accounts/{id}` | 写 |
| [`serviceAccounts.createKey`](#serviceaccountscreatekey) | `POST /service-accounts/{id}/keys` | 写 |
| [`serviceAccounts.revokeKey`](#serviceaccountsrevokekey) | `POST /service-accounts/{id}/keys/{keyId}/revoke` | 写 |

### `serviceAccounts.list`

`GET /service-accounts` · 读

无参数。

响应：[服务账号](#服务账号对象)`[]`，按名称升序。

### `serviceAccounts.create`

`POST /service-accounts` · 写 · `201`

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `name` | body | string | 是 | 去掉首尾空格后 1–64 字符；唯一（区分大小写） | 名称 |
| `scopes` | body | `array<enum>` | 是 | 0–5 个：`clusters:read` / `system:read` / `sites:read` / `sites:write` / `usage:read`；去重并排序 | scope |
| `enabled` | body | boolean | 否 | 默认 `true` | 启用 |

响应：[服务账号](#服务账号对象)，`keys` 为 `[]`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SERVICE_ACCOUNT_NAME_TAKEN` | 409 | 名称已被使用；`data.name` |

### `serviceAccounts.update`

`PATCH /service-accounts/{id}` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 服务账号 ID |
| `name` | body | string | 否 | 同 `create`；省略时不变 | 名称 |
| `scopes` | body | `array<enum>` | 否 | 同 `create`；整体替换；省略时不变 | scope |
| `enabled` | body | boolean | 否 | 省略时不变 | 启用 |

响应：[服务账号](#服务账号对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SERVICE_ACCOUNT_NOT_FOUND` | 404 | 服务账号不存在 |
| `SERVICE_ACCOUNT_NAME_TAKEN` | 409 | 名称已被其他服务账号使用；`data.name` |

### `serviceAccounts.delete`

`DELETE /service-accounts/{id}` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 服务账号 ID |

同时删除它的全部 key。

响应：`{ ok: true }`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SERVICE_ACCOUNT_NOT_FOUND` | 404 | 服务账号不存在 |

### `serviceAccounts.createKey`

`POST /service-accounts/{id}/keys` · 写 · `201` · 不接受 `Idempotency-Key`

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 服务账号 ID |
| `name` | body | string | 否 | 去掉首尾空格后至多 64 字符，默认 `""` | key 名称 |

停用的服务账号也可创建 key。

响应：`{ key, secret }`：`key` 为[服务账号 key](#服务账号-key-对象)，`secret`（string）为完整 key，只返回这一次。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SERVICE_ACCOUNT_NOT_FOUND` | 404 | 服务账号不存在 |

### `serviceAccounts.revokeKey`

`POST /service-accounts/{id}/keys/{keyId}/revoke` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 服务账号 ID |
| `keyId` | path | uuid | 是 | — | key ID |

已吊销的 key 原样返回，不再写审计。

响应：[服务账号 key](#服务账号-key-对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SERVICE_ACCOUNT_NOT_FOUND` | 404 | 服务账号不存在 |
| `SERVICE_ACCOUNT_KEY_NOT_FOUND` | 404 | key 不存在或不属于该服务账号 |

## 系统信息

- 页面见 [系统信息](../../guide/system.md#系统信息)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`settings.get`](#settingsget) | `GET /settings` | 读；服务账号 `system:read` |

### `settings.get`

`GET /settings` · 读 · 服务账号 `system:read`

无参数。

响应：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `version` | string | 控制台版本 |
| `consoleUrl` | string | `EDGEWEIR_PUBLIC_URL` |
| `nodeApiUrl` | string | 生效的节点通道地址，同 [`settings.nodeChannel`](#settingsnodechannel) 的 `effectiveUrl` |
| `nodeCaSha256` | string | 节点通道 CA 证书（DER）的 SHA-256，小写十六进制 |
| `analyticsMode` | enum | `lite` / `clickhouse`：`EDGEWEIR_ANALYTICS` |
| `setupCompletedAt` | datetime | 初始化令牌的使用时间，或 `null` |

## 节点通道

- 行为见 [节点通道](../../guide/system.md#节点通道) 与 [更换节点通道地址](../../deploy/networking.md#更换节点通道地址)。
- 三个修改类过程写审计 `system.node_channel_update`（`removeNodeChannelName` 的元数据含 `removedName`，`closeNodeChannelWebSocket` 的含 `webSocket: closed`），并通知所有控制台实例更新节点通道证书与 WebSocket 入口。
- 节点与探针的计数只含证书仍有效的。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`settings.nodeChannelCheck`](#settingsnodechannelcheck) | `GET /settings/node-channel-check` | 读 |
| [`settings.nodeChannel`](#settingsnodechannel) | `GET /settings/node-channel` | 读 |
| [`settings.setNodeChannel`](#settingssetnodechannel) | `PUT /settings/node-channel` | 写 |
| [`settings.removeNodeChannelName`](#settingsremovenodechannelname) | `DELETE /settings/node-channel/names/{name}` | 写 |
| [`settings.closeNodeChannelWebSocket`](#settingsclosenodechannelwebsocket) | `DELETE /settings/node-channel/websocket` | 写 |

### `settings.nodeChannelCheck`

`GET /settings/node-channel-check` · 读

无参数。

像节点一样连接生效的节点通道地址：TLS 握手，不带客户端证书，不发请求，3 秒超时。`wss://`、`ws://` 地址先在 `/node-channel` 完成 WebSocket 握手，再在其中做 TLS 握手。系统设置中保存的地址先按出站策略解析（`EDGEWEIR_OUTBOUND_ALLOW_CIDRS`），环境变量与默认地址直接连接。每个控制台进程缓存结果 30 秒，地址或其来源变化时重新检查。结果只作提示。见 [节点通道连接检查](../../deploy/nodes.md#节点通道连接检查)。

响应：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `url` | string | 检查的地址 |
| `result` | enum | `ok`：出示的证书链含节点通道 CA；`unreachable`：超时内没有完成握手；`mismatch`：出示了其他证书链，或 WebSocket 地址没有完成升级；`refused`：保存的地址解析到出站策略不允许的特殊用途地址，未连接 |
| `candidate` | object | `result` 为 `unreachable`、`mismatch` 时为 WebSocket 入口候选 `{ url, result }`（入口关闭时也检查；`result` 为 `ok` 时把 `url` 保存为节点通道地址即可改用），否则为 `null` |
| `checkedAt` | datetime | 检查时间 |

### `settings.nodeChannel`

`GET /settings/node-channel` · 读

无参数。

响应：[节点通道](#节点通道对象)。

### `settings.setNodeChannel`

`PUT /settings/node-channel` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `url` | body | string | 是 | 空字符串，或 `https://`、`wss://`、`ws://` 加主机与可选端口；不含账号、路径、查询参数与片段；至多 2048 字符 | 节点通道地址 |

保存为 origin 形式（主机名小写，去掉末尾 `/` 与默认端口）。空字符串清除保存的地址，`EDGEWEIR_NODE_API_URL` 或默认地址生效。此前生效的地址的名称留在证书中（至多 32 个）；此前或现在为 `wss://`、`ws://` 地址时，WebSocket 入口保持开放。

响应：[节点通道](#节点通道对象)。

### `settings.removeNodeChannelName`

`DELETE /settings/node-channel/names/{name}` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `name` | path | string | 是 | 1–253 字符；不区分大小写 | `previousNames` 中的名称 |

从节点通道证书中去掉该名称。

响应：[节点通道](#节点通道对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `NODE_CHANNEL_NAME_NOT_FOUND` | 404 | 名称不是此前的地址留下的：不在 `previousNames` 中，是当前地址的名称，或来自环境变量与默认值 |
| `NODE_CHANNEL_NAME_IN_USE` | 409 | 仍有节点或探针用该名称连接；`data.nodes`、`data.probes` |

### `settings.closeNodeChannelWebSocket`

`DELETE /settings/node-channel/websocket` · 写

无参数。

关闭此前的 `wss://`、`ws://` 地址打开的 WebSocket 入口。

响应：[节点通道](#节点通道对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `NODE_CHANNEL_WEBSOCKET_REQUIRED` | 409 | `webSocket.closable` 为 `false`：`EDGEWEIR_NODE_API_WEBSOCKET=true`，生效地址为 `wss://` 或 `ws://`，或此前没有这类地址打开入口 |
| `NODE_CHANNEL_WEBSOCKET_IN_USE` | 409 | 仍有节点或探针可能经入口连接；`data.nodes`、`data.probes` |

## 源站地址允许清单

- 行为见 [源站地址允许清单](../../guide/system.md#源站地址允许清单) 与 [源站地址限制](../../guide/origins-and-cache.md#源站地址限制)。
- `settings.setOriginAllowList` 为每个集群发布一个配置版本（原因 `origin_allow_list_updated`），审计 `system.origin_allow_list_update`（元数据 `cidrs`、`added`、`removed`、各集群的新版本号 `revisions`）。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`settings.originAllowList`](#settingsoriginallowlist) | `GET /settings/origin-allow-list` | 读 |
| [`settings.setOriginAllowList`](#settingssetoriginallowlist) | `PUT /settings/origin-allow-list` | 写 |

### `settings.originAllowList`

`GET /settings/origin-allow-list` · 读

无参数。

响应：`{ cidrs }`：允许作为源站的特殊用途地址段（string[]），规范化、排序、去重；从未保存时为 `[]`。

### `settings.setOriginAllowList`

`PUT /settings/origin-allow-list` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `cidrs` | body | `array<string>` | 是 | 至多 256 个；每个为 IPv4 或 IPv6 CIDR，至多 64 字符，单个地址按单主机处理；规范化（`10.1.2.3/8` → `10.0.0.0/8`） | 整个清单 |

整体替换；空数组清空清单。

响应：同 [`settings.originAllowList`](#settingsoriginallowlist)。

## ACME 目录

- 行为见 [证书颁发机构](../../guide/system.md#证书颁发机构)。证书申请中的 `ca` `custom` 使用这里的目录。
- 每个值依次取系统设置中保存的、环境变量的（`EDGEWEIR_ACME_DIRECTORY`、`EDGEWEIR_ACME_CA_FILE`），否则为无。EAB HMAC 密钥用主密钥加密保存，不返回。
- 审计 `system.acme_directory_update`（元数据为前后的 `url`、`eabKid`、`caCertificates`，不含密钥）。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`settings.acmeDirectory`](#settingsacmedirectory) | `GET /settings/acme-directory` | 读 |
| [`settings.setAcmeDirectory`](#settingssetacmedirectory) | `PUT /settings/acme-directory` | 写 |

### `settings.acmeDirectory`

`GET /settings/acme-directory` · 读

无参数。

响应：[ACME 目录设置](#acme-目录设置对象)。

### `settings.setAcmeDirectory`

`PUT /settings/acme-directory` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `url` | body | string | 是 | 空字符串，或 `https://` URL，不含账号与片段，至多 2048 字符 | ACME 目录 URL |
| `eabKid` | body | string | 否 | 去掉首尾空格后至多 256 字符，默认 `""` | EAB 密钥 ID；空字符串表示不用 EAB |
| `eabHmacKey` | body | string | 否 | 去掉首尾空格后至多 1024 字符，默认 `""` | EAB HMAC 密钥；空字符串时保留已保存的同一 `eabKid` 的密钥 |
| `caPem` | body | string | 否 | 至多 65536 字符，默认 `""` | 信任的 CA 证书：1–10 张 PEM 证书，不含其他 PEM 块；只含空白时为无 |

- `url` 为空字符串时清除整个设置，其他字段不起作用。
- `eabKid` 为空时不保存 EAB，`eabHmacKey` 被忽略。
- 保存前用系统信任库加 `caPem`（为空时加 `EDGEWEIR_ACME_CA_FILE` 的证书）读取目录：10 秒，至多 1 MiB，不跟随重定向，须返回 200 和含 `newNonce`、`newAccount`、`newOrder` 的 JSON。目录可以在内网。`meta.caaIdentities` 中至多 10 个名称保存为 `caaIdentities`。

响应：[ACME 目录设置](#acme-目录设置对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `ACME_DIRECTORY_CA_INVALID` | 400 | `caPem` 不是 1–10 张可读的 PEM 证书，含其他 PEM 块，或超过 65536 字节 |
| `ACME_DIRECTORY_EAB_INCOMPLETE` | 400 | 给出 `eabKid` 而 `eabHmacKey` 为空，且没有保存同一 `eabKid` 的密钥 |
| `ACME_DIRECTORY_INVALID` | 400 | 读取失败或返回的不是 ACME 目录 |

## 节点发布源

- 行为见 [节点发布源](../../guide/system.md#节点发布源)。镜像布局为 `<地址>/v<版本>/checksums.txt`。
- 审计 `system.release_source_update`（元数据 `before`、`after`）。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`settings.releaseSource`](#settingsreleasesource) | `GET /settings/release-source` | 读 |
| [`settings.setReleaseSource`](#settingssetreleasesource) | `PUT /settings/release-source` | 写 |

### `settings.releaseSource`

`GET /settings/release-source` · 读

无参数。

响应：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `url` | string | 系统设置中保存的地址；未保存时为空字符串 |
| `effectiveUrl` | string | 节点升级使用的地址：保存的地址，否则 `EDGEWEIR_NODE_RELEASE_BASE_URL`，否则 `https://github.com/marvinli001/edgeweir-node/releases/download` |
| `source` | enum | `setting` / `environment` / `default`：`effectiveUrl` 的来源 |

### `settings.setReleaseSource`

`PUT /settings/release-source` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `url` | body | string | 是 | 空字符串，或 `https://`、`http://` URL，不含账号、查询参数与片段，至多 2048 字符 | 镜像地址 |

保存前解析主机名（10 秒）：每个解析结果须为公网地址或 `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` 放行的地址；`http://` 只允许用于非公网地址。不读取镜像内容。空字符串清除保存的地址。

响应：同 [`settings.releaseSource`](#settingsreleasesource)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `RELEASE_SOURCE_REFUSED` | 400 | 主机名无法解析，解析到不允许的地址，或公网地址使用 `http://` |

## 用量与日志保留期

- 行为见 [用量](../../guide/system.md#用量)、[访问日志保留期](../../guide/access-logs.md#保留期) 与 [节点日志保留期](../../guide/system.md#节点日志保留期)。
- 三个 `PUT` 都整体替换；审计 `system.usage_update`、`system.log_retention_update`、`system.node_log_retention_update`（元数据为前后的值）。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`settings.usage`](#settingsusage) | `GET /settings/usage` | 读 |
| [`settings.setUsage`](#settingssetusage) | `PUT /settings/usage` | 写 |
| [`settings.logRetention`](#settingslogretention) | `GET /settings/log-retention` | 读 |
| [`settings.setLogRetention`](#settingssetlogretention) | `PUT /settings/log-retention` | 写 |
| [`settings.nodeLogRetention`](#settingsnodelogretention) | `GET /settings/node-log-retention` | 读 |
| [`settings.setNodeLogRetention`](#settingssetnodelogretention) | `PUT /settings/node-log-retention` | 写 |

### `settings.usage`

`GET /settings/usage` · 读

无参数。

响应：`{ retentionDays, offlineThresholdMinutes }`，字段见 [`settings.setUsage`](#settingssetusage)；从未保存时为 `100`、`60`。

### `settings.setUsage`

`PUT /settings/usage` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `retentionDays` | body | integer | 是 | 35–400 | 用量记录保留天数 |
| `offlineThresholdMinutes` | body | integer | 是 | 5–1440 | 超过这么久没有心跳的节点不再拖住 `completeUntil` |

响应：同 [`settings.usage`](#settingsusage)。

### `settings.logRetention`

`GET /settings/log-retention` · 读

无参数。

响应：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `postgresDays` | integer | PostgreSQL 存储的访问日志保留天数；从未保存时为 `7` |
| `clickhouseDays` | integer | ClickHouse 存储的访问日志保留天数；从未保存时为 `7` |
| `storage` | enum | `lite` / `clickhouse`：在用的存储（`EDGEWEIR_ANALYTICS`），决定哪一项生效 |

### `settings.setLogRetention`

`PUT /settings/log-retention` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `postgresDays` | body | integer | 是 | 1–30 | PostgreSQL 存储的保留天数 |
| `clickhouseDays` | body | integer | 是 | 1–90 | ClickHouse 存储的保留天数 |

在用的存储为 `clickhouse` 时，保存后立即修改 ClickHouse `access_log` 表的 TTL。

响应：同 [`settings.logRetention`](#settingslogretention)。

### `settings.nodeLogRetention`

`GET /settings/node-log-retention` · 读

无参数。

响应：`{ days, perNode }`，字段见 [`settings.setNodeLogRetention`](#settingssetnodelogretention)；从未保存时为 `7`、`10000`。

### `settings.setNodeLogRetention`

`PUT /settings/node-log-retention` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `days` | body | integer | 是 | 1–30 | 节点日志保留天数 |
| `perNode` | body | integer | 是 | 1000–100000 | 每个节点至多保留的条数 |

响应：同 [`settings.nodeLogRetention`](#settingsnodelogretention)。

## 封禁与防护设置

- 行为见 [防护](../../guide/system.md#防护)、[封禁](../../guide/system.md#封禁)、[CC 模板](../../guide/system.md#cc-模板)、[封禁](../../guide/bans.md) 与 [挑战与 CC 防护](../../guide/challenges.md)。
- 三个 `PUT` 都整体替换；审计 `system.bans_update`、`system.protection_update`、`system.cc_template_update`（元数据为前后的值）。
- 配置版本原因：`platform_protection_updated`（`settings.setProtection`）、`cc_template_updated`（`settings.setCcTemplate`）。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`settings.bans`](#settingsbans) | `GET /settings/bans` | 读 |
| [`settings.setBans`](#settingssetbans) | `PUT /settings/bans` | 写 |
| [`settings.protection`](#settingsprotection) | `GET /settings/protection` | 读 |
| [`settings.setProtection`](#settingssetprotection) | `PUT /settings/protection` | 写 |
| [`settings.ccTemplate`](#settingscctemplate) | `GET /settings/cc-template` | 读 |
| [`settings.setCcTemplate`](#settingssetcctemplate) | `PUT /settings/cc-template` | 写 |

### `settings.bans`

`GET /settings/bans` · 读

无参数。

响应：`{ maxTotal, shareAutoBans }`，字段见 [`settings.setBans`](#settingssetbans)；从未保存时为 `10000`、`true`。

### `settings.setBans`

`PUT /settings/bans` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `maxTotal` | body | integer | 是 | 100–100000 | 全平台有效手动封禁的上限，网站封禁与全局封禁合计 |
| `shareAutoBans` | body | boolean | 是 | — | 自动封禁下发到同一集群的其他节点 |

响应：同 [`settings.bans`](#settingsbans)。

### `settings.protection`

`GET /settings/protection` · 读

无参数。

响应：`{ underAttack, underAttackChallenge, eventRetentionDays }`，字段见 [`settings.setProtection`](#settingssetprotection)；从未保存时为 `false`、`js`、`30`。

### `settings.setProtection`

`PUT /settings/protection` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `underAttack` | body | boolean | 是 | — | 所有集群的所有网站开启 Under Attack |
| `underAttackChallenge` | body | enum | 是 | `cookie302` / `js` / `pow` / `captcha` | 全局 Under Attack 的挑战类型 |
| `eventRetentionDays` | body | integer | 是 | 7–365 | 安全事件保留天数 |

`underAttack` 改变，或 `underAttack` 为 `true` 时 `underAttackChallenge` 改变，为所有集群发布配置版本。

响应：同 [`settings.protection`](#settingsprotection)。

### `settings.ccTemplate`

`GET /settings/cc-template` · 读

无参数。

响应：CC 模板，字段见 [`settings.setCcTemplate`](#settingssetcctemplate)。

### `settings.setCcTemplate`

`PUT /settings/cc-template` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `maxLevel` | body | enum | 是 | `cookie302` / `js` / `pow` / `captcha`；未保存时 `captcha` | 可升到的最高级别 |
| `highPowInsteadOfCaptcha` | body | boolean | 是 | 未保存时 `false` | 到 `captcha` 级别时改用高难度工作量证明 |
| `windowSeconds` | body | integer | 是 | 5–60；未保存时 `10` | 滑动窗口秒数 |
| `siteQps` | body | integer | 是 | 0–1000000；未保存时 `1000` | 网站每秒请求数阈值 |
| `urlQps` | body | integer | 是 | 0–1000000；未保存时 `200` | 单个路径的每秒请求数阈值；只升级被攻击的路径 |
| `ipQps` | body | integer | 是 | 0–1000000；未保存时 `50` | 单个地址的每秒请求数阈值；超出的地址自动封禁 `ipBanSeconds` 秒 |
| `ipBanSeconds` | body | integer | 是 | 60–86400；未保存时 `600` | 自动封禁时长 |
| `originErrorPercent` | body | integer | 是 | 0–100；未保存时 `50` | 回源错误（5xx 与失败的尝试）占回源请求的百分比阈值 |
| `originErrorMinRequests` | body | integer | 是 | 0–1000000；未保存时 `100` | 窗口内回源请求达到这么多后才计算错误率 |
| `escalateAfterSeconds` | body | integer | 是 | 1–3600；未保存时 `10` | 触发持续这么久升一级 |
| `cooldownSeconds` | body | integer | 是 | 1–86400；未保存时 `60` | 这么久没有触发降一级 |

阈值为 `0` 时关闭该触发条件。判断在每个节点本地进行，阈值按节点计。保存后为有网站开启 CC 防护且跟随模板的集群发布配置版本。

响应：同 [`settings.ccTemplate`](#settingscctemplate)。

## 探测设置

- 行为见 [探测设置](../../guide/scheduling.md#探测设置)。
- 审计 `system.probes_update`（元数据为前后的值）。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`settings.probes`](#settingsprobes) | `GET /settings/probes` | 读 |
| [`settings.setProbes`](#settingssetprobes) | `PUT /settings/probes` | 写 |

### `settings.probes`

`GET /settings/probes` · 读

无参数。

响应：探测设置，字段见 [`settings.setProbes`](#settingssetprobes)。

### `settings.setProbes`

`PUT /settings/probes` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `intervalSeconds` | body | integer | 是 | 5–60；未保存时 `10` | 两轮探测的间隔秒数 |
| `timeoutMs` | body | integer | 是 | 500–10000，不大于 `intervalSeconds × 1000`；未保存时 `3000` | 单次尝试的超时毫秒数 |
| `attempts` | body | integer | 是 | 1–10；未保存时 `3` | 每轮对每个目标的尝试次数 |
| `lossPercent` | body | integer | 是 | 1–100；未保存时 `50` | 丢失尝试的百分比达到它时地址算失败 |
| `ipDownSeconds` | body | integer | 是 | 5–3600；未保存时 `30` | 地址失败这么久后节点切到下一级地址 |
| `ipUpSeconds` | body | integer | 是 | 5–3600；未保存时 `60` | 失败的地址恢复这么久后节点切回 |

整体替换。`timeoutMs` 大于 `intervalSeconds × 1000` 时返回 400 `BAD_REQUEST`。

响应：同 [`settings.probes`](#settingsprobes)。

## 平台错误页

- 行为与占位符见 [平台错误页](../../guide/error-pages.md#平台错误页) 与 [模板](../../guide/error-pages.md#模板)。
- `settings.setErrorPages` 为每个集群发布配置版本（原因 `error_pages_updated`），审计 `system.error_pages_update`（元数据 `changed`、`bytes`、各集群的新版本号 `revisions`）。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`settings.errorPages`](#settingserrorpages) | `GET /settings/error-pages` | 读 |
| [`settings.setErrorPages`](#settingsseterrorpages) | `PUT /settings/error-pages` | 写 |

### `settings.errorPages`

`GET /settings/error-pages` · 读

无参数。

响应：`{ unknownHost, siteDisabled }`，字段见 [`settings.setErrorPages`](#settingsseterrorpages)；从未保存时都为空字符串。

### `settings.setErrorPages`

`PUT /settings/error-pages` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `unknownHost` | body | string | 否 | UTF-8 至多 65536 字节，默认 `""` | 没有网站使用的域名的页面（404） |
| `siteDisabled` | body | string | 否 | UTF-8 至多 65536 字节，默认 `""` | 已停用网站的页面（503） |

整体替换：省略的字段按空字符串保存。空字符串使用节点的内置页面。模板含 `{{time}}` 或 `{{path}}` 时，集群的配置要求节点能力 `rules-v3`。

响应：同 [`settings.errorPages`](#settingserrorpages)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `ERROR_PAGE_TOO_LARGE` | 400 | 模板超过 65536 字节；`data.status` 为 `404` 或 `503`，`data.limit` 为 `65536` |

## 演示账号

- 行为见 [演示账号](../../guide/system.md#演示账号)。
- 状态改变时审计 `system.demo_update`（元数据 `from`、`to`）；状态不变时不写。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`settings.demo`](#settingsdemo) | `GET /settings/demo` | 读 |
| [`settings.setDemo`](#settingssetdemo) | `PUT /settings/demo` | 写 |

### `settings.demo`

`GET /settings/demo` · 读

无参数。

响应：`{ enabled }`：演示账号已打开（boolean）。

### `settings.setDemo`

`PUT /settings/demo` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `enabled` | body | boolean | 是 | — | 打开或关闭演示账号 |

打开时创建账号 `demo@edgeweir.com`（密码 `demo`）；关闭时删除该账号及其全部会话。管理账户不受影响。

响应：同 [`settings.demo`](#settingsdemo)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `DEMO_EMAIL_TAKEN` | 409 | 打开时管理账户的邮箱为 `demo@edgeweir.com` |

## 登录 IP 白名单

- 行为与受限范围见 [登录 IP 白名单](../../guide/system.md#登录-ip-白名单)。
- 审计 `system.login_allow_list_update`（元数据 `cidrs`、`added`、`removed`）。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`settings.loginAllowList`](#settingsloginallowlist) | `GET /settings/login-allow-list` | 读 |
| [`settings.setLoginAllowList`](#settingssetloginallowlist) | `PUT /settings/login-allow-list` | 写 |

### `settings.loginAllowList`

`GET /settings/login-allow-list` · 读

无参数。

响应：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `cidrs` | `array<string>` | 允许登录的地址段，规范化、排序、去重；名单关闭时为 `[]`。演示账号看到的每一段至多到 IPv4 /24、IPv6 /48 |
| `currentIp` | string | 控制台为这次请求解析出的客户端地址 |
| `proxyHint` | boolean | `currentIp` 可能是代理的地址：它是特殊用途地址，或请求带有来自 `EDGEWEIR_TRUSTED_PROXIES` 之外的对端的转发头 |

### `settings.setLoginAllowList`

`PUT /settings/login-allow-list` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `cidrs` | body | `array<string>` | 是 | 至多 64 个；每个为 IPv4 或 IPv6 CIDR，至多 64 字符，单个地址按单主机处理；规范化 | 整个名单 |

整体替换；空数组关闭名单。IPv4 映射的 IPv6 地址与地址段按对应的 IPv4 比较。

响应：同 [`settings.loginAllowList`](#settingsloginallowlist)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `LOGIN_ALLOW_LIST_EXCLUDES_CURRENT_IP` | 400 | 名单不为空且不含这次请求的客户端地址（用 AccessKey 调用时同样检查）；`data.ip` |

## 对象

### AccessKey 对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 密钥 ID |
| `name` | string | 名称 |
| `prefix` | string | 密钥的前 6 个字符 |
| `scope` | enum | `read` / `write` |
| `enabled` | boolean | `false`：已吊销 |
| `requestsPerMinute` | integer | 每分钟请求数上限，或 `null`（不限） |
| `createdAt` | datetime | 创建时间 |
| `lastUsedAt` | datetime | 最后使用时间（至多每分钟更新一次），或 `null` |

### 服务账号对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 服务账号 ID |
| `name` | string | 名称 |
| `scopes` | `array<enum>` | scope，排序 |
| `enabled` | boolean | 启用 |
| `keys` | array<[服务账号 key](#服务账号-key-对象)> | 全部 key，含已吊销的，按创建时间升序 |
| `createdAt` | datetime | 创建时间 |
| `updatedAt` | datetime | 最后修改时间 |

### 服务账号 key 对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | key ID |
| `name` | string | key 名称，可为空字符串 |
| `prefix` | string | key 的前 12 个字符 |
| `createdAt` | datetime | 创建时间 |
| `lastUsedAt` | datetime | 最后使用时间（至多每分钟更新一次），或 `null` |
| `revokedAt` | datetime | 吊销时间，或 `null` |

### 节点通道对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `url` | string | 系统设置中保存的地址；未保存时为空字符串 |
| `effectiveUrl` | string | 生效的地址：保存的地址，否则 `EDGEWEIR_NODE_API_URL`，否则默认地址。新的安装命令使用它，已注册的节点与探针切换到它 |
| `source` | enum | `setting` / `environment` / `default`：`effectiveUrl` 的来源 |
| `serverName` | string | 节点在 `effectiveUrl` 校验的证书名称（主机名或 IP） |
| `previousNames` | `array<object>` | 此前生效的地址留在证书中的名称，不含当前名称与环境变量、默认值产生的名称 |
| `previousNames[].name` | string | 名称 |
| `previousNames[].nodes` | integer | 仍用该名称连接的节点数：最近一次连接校验了它，或报告它为在用地址；节点保留的备用地址不计入 |
| `previousNames[].probes` | integer | 同上，探针数。`nodes` 与 `probes` 都为 `0` 时可移除 |
| `webSocket.open` | boolean | WebSocket 入口开放：`EDGEWEIR_NODE_API_WEBSOCKET=true`，生效地址为 `wss://` 或 `ws://`，或此前用过这类地址 |
| `webSocket.closable` | boolean | 入口只因此前的地址而开放，可用 [`settings.closeNodeChannelWebSocket`](#settingsclosenodechannelwebsocket) 关闭 |
| `webSocket.nodes` | integer | 可能仍经入口连接的节点数 |
| `webSocket.probes` | integer | 可能仍经入口连接的探针数 |
| `adoption.nodes` | integer | 证书仍有效的节点数 |
| `adoption.nodesCurrent` | integer | 其中已使用 `effectiveUrl` 的节点数 |
| `adoption.probes` | integer | 证书仍有效的探针数 |
| `adoption.probesCurrent` | integer | 其中已使用 `effectiveUrl` 的探针数 |

默认地址为 `https://<EDGEWEIR_PUBLIC_URL 的主机名>:<NODE_API_PORT>`；`EDGEWEIR_NODE_API_WEBSOCKET=true` 时为 `wss://<EDGEWEIR_PUBLIC_URL 的主机与端口>`（控制台地址为 `http://` 时为 `ws://`）。

### ACME 目录设置对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `url` | string | 保存的目录 URL；未保存时为空字符串 |
| `effectiveUrl` | string | 生效的目录 URL：保存的，否则 `EDGEWEIR_ACME_DIRECTORY`；都没有时为空字符串 |
| `source` | enum | `setting` / `environment` / `default`：`effectiveUrl` 的来源；`default` 表示没有自定义目录 |
| `eabKid` | string | 保存的 EAB 密钥 ID；没有 EAB 或未保存目录时为空字符串 |
| `eabHmacKeySet` | boolean | 已保存 EAB HMAC 密钥 |
| `caPem` | string | 保存的 CA 证书（PEM）；未保存时为空字符串 |
| `caSource` | enum | `setting` / `environment` / `default`：生效的 CA 证书的来源；`default` 为系统信任库 |
| `caaIdentities` | `array<string>` | 保存的目录 `meta.caaIdentities` 中的 CAA 签发者域名（小写，至多 10 个）；为空时不检查 CAA。目录来自环境变量时为 `[]` |
