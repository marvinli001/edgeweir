# API：集群与节点

集群、配置版本与金丝雀、集群网络设置、注册 token、节点组、节点、节点日志、区域、节点升级、端口池与 L4 应用的过程。

权限级别、认证、幂等键与错误格式见 [API 概览](../api.md)。

## 集群

- 新建集群时同时创建默认节点组 `default` 并发布版本 1（原因 `cluster_created`）。
- 审计：`cluster.create`、`cluster.update`、`cluster.delete`。
- 行为见[集群与节点](../../guide/clusters.md#集群)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`clusters.list`](#clusterslist) | `GET /clusters` | 读；服务账号 `clusters:read` |
| [`clusters.get`](#clustersget) | `GET /clusters/{id}` | 读；服务账号 `clusters:read` |
| [`clusters.create`](#clusterscreate) | `POST /clusters` | 写 |
| [`clusters.update`](#clustersupdate) | `PATCH /clusters/{id}` | 写 |
| [`clusters.delete`](#clustersdelete) | `DELETE /clusters/{id}` | 写 |

### `clusters.list`

`GET /clusters` · 读 · 服务账号 `clusters:read`

无参数。

响应：[集群](#集群对象)`[]`，按创建时间升序。

### `clusters.get`

`GET /clusters/{id}` · 读 · 服务账号 `clusters:read`

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 集群 ID |

响应：[集群](#集群对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |

### `clusters.create`

`POST /clusters` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `name` | body | string | 是 | 去掉首尾空格后 1–64 字符；小写字母、数字与 `-`，首字符为小写字母或数字 | 集群名称，唯一 |
| `description` | body | string | 否 | 去掉首尾空格后最多 500 字符，默认 `""` | 描述 |

响应：[集群](#集群对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NAME_TAKEN` | 409 | 名称已被其他集群使用；`data.name` |

### `clusters.update`

`PATCH /clusters/{id}` · 写

不发布配置版本。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 集群 ID |
| `name` | body | string | 否 | 同 `clusters.create`；省略时不变 | 集群名称 |
| `description` | body | string | 否 | 去掉首尾空格后最多 500 字符；省略时不变 | 描述 |

响应：[集群](#集群对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |
| `CLUSTER_NAME_TAKEN` | 409 | 名称已被其他集群使用；`data.name` |

### `clusters.delete`

`DELETE /clusters/{id}` · 写

只能删除没有节点与网站的集群。集群的平台告警随之结束。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 集群 ID |

响应：`{ ok: true }`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |
| `CLUSTER_NOT_EMPTY` | 409 | 集群仍有节点（含已停用的）或网站；`data.nodes`、`data.sites` 为数量 |
| `DNS_BINDING_IN_USE` | 409 | 集群的 DNS 绑定为自动模式，或仍在服务商处持有记录 |

## 配置版本与金丝雀

- 版本原因代码：`rollback`（`reasonParams.revision` 为回滚目标）、`rollout_rollback`（`reasonParams.revision` 为候选版本）。
- 审计：`cluster.rollback`、`cluster.rollout_policy_update`、`cluster.rollout_promote`、`cluster.rollout_abort`。
- 行为见[配置版本](../../guide/clusters.md#配置版本)与[配置金丝雀](../../guide/clusters.md#配置金丝雀)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`clusters.revisions`](#clustersrevisions) | `GET /clusters/{id}/revisions` | 读 |
| [`clusters.rollback`](#clustersrollback) | `POST /clusters/{id}/rollback` | 写 |
| [`clusters.rollbackPreview`](#clustersrollbackpreview) | `GET /clusters/{id}/rollback-preview` | 读 |
| [`clusters.rollout`](#clustersrollout) | `GET /clusters/{id}/rollout` | 读 |
| [`clusters.setRolloutPolicy`](#clusterssetrolloutpolicy) | `PUT /clusters/{id}/rollout-policy` | 写 |
| [`clusters.promoteRollout`](#clusterspromoterollout) | `POST /clusters/{id}/rollout/promote` | 写 |
| [`clusters.abortRollout`](#clustersabortrollout) | `POST /clusters/{id}/rollout/abort` | 写 |

### `clusters.revisions`

`GET /clusters/{id}/revisions` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 集群 ID |

响应：[配置版本](#配置版本对象)`[]`，最新的在前，最多 100 个。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |

### `clusters.rollback`

`POST /clusters/{id}/rollback` · 写

把所选版本的内容发布为集群的新版本。源站地址允许清单、平台错误页、离线主机与 IP 名单取当前值，不取旧版本中的值。内容与最新版本相同时不新建版本，返回最新版本。配置金丝雀开启时，新版本直接下发给全部节点，金丝雀状态变为 `promoted`，结果为 `manual_rollback`。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 集群 ID |
| `revision` | body | integer | 是 | ≥1 | 回滚目标版本号 |

响应：[配置版本](#配置版本对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |
| `REVISION_NOT_FOUND` | 404 | 集群没有该版本（含已超出保留数量被删除的版本） |
| `ROLLBACK_RESOURCE_UNAVAILABLE` | 409 | 目标版本引用的网站、域名或 IP 名单已删除，或证书不可用、已过期 |
| `CLUSTER_SITE_LIMIT` | 409 | 发布后的网站数超出集群上限；`data.limit` |

### `clusters.rollbackPreview`

`GET /clusters/{id}/rollback-preview` · 读

按回滚的规则构建内容并与最新版本比较，不写入。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 集群 ID |
| `revision` | query | integer | 是 | ≥1 | 回滚目标版本号 |

响应：`{ revision, currentRevision, unchanged, sites: { added, changed, removed } }`。`currentRevision` 为集群最新版本号，没有版本时为 `null`；`unchanged` 为 `true` 时回滚内容与最新版本相同，回滚不发布新内容；`sites` 的三个数组为 `[{ id, name }]`，按名称比较得出的新增、修改、移除的网站。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |
| `REVISION_NOT_FOUND` | 404 | 集群没有该版本 |
| `ROLLBACK_RESOURCE_UNAVAILABLE` | 409 | 同 `clusters.rollback` |

### `clusters.rollout`

`GET /clusters/{id}/rollout` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 集群 ID |

响应：[金丝雀发布](#金丝雀发布对象)。从未保存策略时 `policy` 为默认值：`enabled: false`、`windowSeconds: 300`、`autoPromote: true`、`errorRatioMultiplier: 2`、`errorRatioFloor: 0.05`、`minRequests: 100`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |

### `clusters.setRolloutPolicy`

`PUT /clusters/{id}/rollout-policy` · 写

整体替换策略。开启时把当前最新版本定为稳定版本；发布进行中关闭时，候选版本下发给全部节点（结果 `policy_disabled`）。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 集群 ID |
| `enabled` | body | boolean | 是 | — | 开启配置金丝雀 |
| `windowSeconds` | body | integer | 是 | 60–3600 | 观察窗口（秒） |
| `autoPromote` | body | boolean | 是 | — | 窗口结束后自动推进；`false` 时等待运营者推进 |
| `errorRatioMultiplier` | body | number | 是 | 1–100 | 金丝雀 5xx 比例超过 `max(基线 × errorRatioMultiplier, errorRatioFloor)` 时回滚 |
| `errorRatioFloor` | body | number | 是 | 0.001–1 | 见上 |
| `minRequests` | body | integer | 是 | 1–1000000 | 金丝雀节点在窗口内至少服务的请求数，达到后才按比例判断 |
| `expectedUpdatedAt` | body | datetime | 否 | — | 乐观并发：上次读取的 `policyUpdatedAt`（`updatedAt` 也接受） |

响应：[金丝雀发布](#金丝雀发布对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |
| `UPDATED_AT_MISMATCH` | 409 | `expectedUpdatedAt` 既不是当前的 `policyUpdatedAt` 也不是 `updatedAt`；`data.updatedAt` |

### `clusters.promoteRollout`

`POST /clusters/{id}/rollout/promote` · 写

候选版本立即成为全部节点的稳定版本（结果 `manual_promote`）。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 集群 ID |

响应：[金丝雀发布](#金丝雀发布对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |
| `ROLLOUT_NOT_ACTIVE` | 409 | 没有进行中的金丝雀发布（策略未开启，状态不是 `canary` / `awaiting_promotion`，或没有候选版本） |

### `clusters.abortRollout`

`POST /clusters/{id}/rollout/abort` · 写

以稳定版本的内容发布新版本（原因 `rollout_rollback`），新版本成为全部节点的稳定版本；状态变为 `rolled_back`，结果 `manual_abort`，并产生平台告警 `config_rollout_failed`。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 集群 ID |

响应：[金丝雀发布](#金丝雀发布对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |
| `ROLLOUT_NOT_ACTIVE` | 409 | 同 `clusters.promoteRollout` |

## 集群网络设置（监听端口、访客 IP、未知域名、连接数限制、缓存区）

- `set*` 过程整体替换设置。设置与当前相同时不发布、不写审计；否则发布配置版本并审计。
- 版本原因代码与审计：

| 过程 | 原因代码 | 审计 |
| --- | --- | --- |
| `clusters.setListenPorts` | `listen_ports_updated` | `cluster.listen_ports_update` |
| `clusters.setClientIp` | `client_ip_updated` | `cluster.client_ip_update` |
| `clusters.setUnknownHosts` | `unknown_hosts_updated` | `cluster.unknown_hosts_update` |
| `clusters.setConnectionLimits` | `connection_limits_updated` | `cluster.connection_limits_update` |
| `clusters.setCache` | `cluster_cache_updated` | `cluster.cache_update` |

- 响应中的 `nodesWithout`（`[{ id, name }]`）为缺少相应能力的活动节点，这些节点在升级前不应用新设置，见[节点能力](../../guide/node-upgrades.md#节点能力)。
- 行为见[集群的监听端口](../../guide/https.md#集群的监听端口)、[访客 IP](../../deploy/nodes.md#访客-ip)、[未知域名与节点 IP 访问](../../guide/domains.md#未知域名与节点-ip-访问)、[连接数限制](../../guide/bans.md#连接数限制)、[缓存区](../../guide/origins-and-cache.md#缓存区)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`clusters.listenPorts`](#clusterslistenports) | `GET /clusters/{clusterId}/listen-ports` | 读 |
| [`clusters.setListenPorts`](#clusterssetlistenports) | `PUT /clusters/{clusterId}/listen-ports` | 写 |
| [`clusters.clientIp`](#clustersclientip) | `GET /clusters/{clusterId}/client-ip` | 读 |
| [`clusters.setClientIp`](#clusterssetclientip) | `PUT /clusters/{clusterId}/client-ip` | 写 |
| [`clusters.unknownHosts`](#clustersunknownhosts) | `GET /clusters/{clusterId}/unknown-hosts` | 读 |
| [`clusters.setUnknownHosts`](#clusterssetunknownhosts) | `PUT /clusters/{clusterId}/unknown-hosts` | 写 |
| [`clusters.connectionLimits`](#clustersconnectionlimits) | `GET /clusters/{clusterId}/connection-limits` | 读 |
| [`clusters.setConnectionLimits`](#clusterssetconnectionlimits) | `PUT /clusters/{clusterId}/connection-limits` | 写 |
| [`clusters.setCache`](#clusterssetcache) | `PUT /clusters/{id}/cache` | 写 |

### `clusters.listenPorts`

`GET /clusters/{clusterId}/listen-ports` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | 是 | — | 集群 ID |

响应：`{ clusterId, httpPorts, httpsPorts, nodesWithout }`。`httpPorts`、`httpsPorts` 为附加端口，升序，不含始终监听的 80 与 443；`nodesWithout` 为缺少 `edge-ports-v1` 的活动节点。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |

### `clusters.setListenPorts`

`PUT /clusters/{clusterId}/listen-ports` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | 是 | — | 集群 ID |
| `httpPorts` | body | `array<integer>` | 是 | 最多 16 个；1–65535，不能是 80 或 443；去重并升序保存 | 附加 HTTP 端口 |
| `httpsPorts` | body | `array<integer>` | 是 | 同上 | 附加 HTTPS 端口 |

响应：同 `clusters.listenPorts`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |
| `LISTEN_PORT_CONFLICT` | 400 | 同一端口同时出现在 `httpPorts` 与 `httpsPorts` 中；`data.port` |
| `LISTEN_PORT_IN_POOL` | 400 | 端口在集群的端口池内（不论协议）；`data.port`、`data.pools`（`起始-结束/协议`，逗号分隔） |
| `LISTEN_PORT_IN_USE` | 409 | 移除的端口仍被集群的网站使用；`data.port`、`data.sites`（前 5 个网站名） |

### `clusters.clientIp`

`GET /clusters/{clusterId}/client-ip` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | 是 | — | 集群 ID |

响应：`{ clusterId, settings: { mode, trustedCidrs, header, dropForwardedFor }, nodesWithout }`。从未设置时 `settings` 为 `direct`、`[]`、`""`、`false`；`nodesWithout` 为缺少 `client-ip-v1` 的活动节点。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |

### `clusters.setClientIp`

`PUT /clusters/{clusterId}/client-ip` · 写

非 `header` 模式下 `trustedCidrs`、`header` 不保存；非 `direct` 模式下 `dropForwardedFor` 不保存。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | 是 | — | 集群 ID |
| `settings` | body | object | 是 | — | 访客 IP 设置 |
| `settings.mode` | body | enum | 否 | `direct` / `proxy_protocol` / `header`，默认 `direct` | `direct`：TCP 对端；`proxy_protocol`：每个 TCP 连接开头的 PROXY protocol 报头（QUIC 仍用 UDP 对端）；`header`：可信范围内的对端发送的报头 |
| `settings.trustedCidrs` | body | `array<string>` | 否 | 最多 64 个 IP 或 CIDR，规范化（`10.1.2.3/8` 保存为 `10.0.0.0/8`）、去重并排序；不接受 IPv4 映射的 IPv6 范围；默认 `[]`；`header` 模式至少 1 个 | 可信代理范围 |
| `settings.header` | body | string | 否 | 去掉首尾空格并转小写后为 `[a-z0-9-]`，1–64 字符；不能以 `x-edgeweir-` 开头，不能是 `connection`、`keep-alive`、`proxy-connection`、`transfer-encoding`、`upgrade`、`te`、`trailer`、`host`、`content-length`、`content-type`、`cookie`、`authorization`、`cdn-loop`、`x-request-id`；默认 `""`；`header` 模式必填 | 携带访客地址的报头，如 `x-forwarded-for`、`x-real-ip`、`cf-connecting-ip`、`true-client-ip` |
| `settings.dropForwardedFor` | body | boolean | 否 | 默认 `false`；只用于 `direct` 模式 | 回源时 `X-Forwarded-For` 只发送 TCP 对端 |

响应：同 `clusters.clientIp`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |

### `clusters.unknownHosts`

`GET /clusters/{clusterId}/unknown-hosts` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | 是 | — | 集群 ID |

响应：`{ clusterId, settings, defaultSite, nodesWithout }`。`settings` 字段同 `clusters.setUnknownHosts` 的 `settings`；`defaultSite` 为 `{ id, name, enabled, certificate }`（`certificate`：网站有证书），没有默认网站时为 `null`，默认网站已停用或没有证书时节点按 `page` 处理（未知 SNI 的握手中止）；`nodesWithout` 为缺少 `unknown-host-v1` 的活动节点。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |

### `clusters.setUnknownHosts`

`PUT /clusters/{clusterId}/unknown-hosts` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | 是 | — | 集群 ID |
| `settings` | body | object | 是 | — | 未知域名设置 |
| `settings.unknownHost` | body | enum | 否 | `page` / `close` / `site`，默认 `page` | 没有网站服务的 Host：`page` 平台的未知域名页（404），`close` 不响应（444），`site` 交给默认网站 |
| `settings.ipAccess` | body | enum | 否 | 同上，默认 `page` | 以节点 IP 访问或没有 Host 的请求 |
| `settings.defaultSiteId` | body | uuid | 否 | 可为 `null`，默认 `null`；`unknownHost` 或 `ipAccess` 为 `site` 时必填，须为本集群已启用的网站；两者都不是 `site` 时不保存 | 默认网站 |
| `settings.defaultCertificate` | body | boolean | 否 | 默认 `false`；只在 `unknownHost` 为 `site` 时可为 `true` | 未知 SNI 的 TLS 握手使用默认网站的证书 |
| `settings.scan` | body | object | 否 | 默认 `{}` | 扫描防护（全平台自动封禁） |
| `settings.scan.enabled` | body | boolean | 否 | 默认 `false` | 开启扫描防护 |
| `settings.scan.threshold` | body | integer | 否 | 10–10000，默认 `100` | 60 秒内访问未知域名或节点 IP 的请求数，再多一次即封禁 |
| `settings.scan.banSeconds` | body | integer | 否 | 60–86400，默认 `3600` | 封禁时长（秒） |

响应：同 `clusters.unknownHosts`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |
| `DEFAULT_SITE_INVALID` | 400 | 默认网站不存在、不属于本集群或已停用 |
| `DEFAULT_SITE_CERTIFICATE_REQUIRED` | 409 | `defaultCertificate` 为 `true`，默认网站没有证书 |

### `clusters.connectionLimits`

`GET /clusters/{clusterId}/connection-limits` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | 是 | — | 集群 ID |

响应：`{ clusterId, settings, effectivePorts, nodes }`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `settings` | object | 字段同 `clusters.setConnectionLimits` 的 `settings`；从未设置时为 `enabled: false`、`perIp: 256`、`newPerSecond: 50`、`burst: 100`、`ports: null` |
| `effectivePorts` | `array<object>` | 节点限制的端口段 `[{ start, end }]`：`settings.ports` 合并后的段；`ports` 为 `null` 时为最新配置版本中的监听端口与 TCP L4 应用端口 |
| `nodes.total` | integer | 活动节点数 |
| `nodes.enforcing` | integer | 在内核中执行限制的节点数 |
| `nodes.unsupported` | `array<object>` | 缺少 `conn-limit-v1` 的活动节点 `[{ id, name }]` |
| `nodes.failing` | `array<object>` | 具备 `conn-limit-v1` 但没有执行限制的节点 `[{ id, name, error }]`（如没有 nftables），`error` 为节点上报的原因；限制关闭时为 `[]` |

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |

### `clusters.setConnectionLimits`

`PUT /clusters/{clusterId}/connection-limits` · 写

节点在内核（nftables）中按 IPv4 地址或 IPv6 /64 限制 TCP 连接，超出的包被丢弃；UDP 不受限制。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | 是 | — | 集群 ID |
| `settings` | body | object | 是 | — | 连接数限制 |
| `settings.enabled` | body | boolean | 是 | 开启时 `perIp` 与 `newPerSecond` 不能都为 0 | 开启限制 |
| `settings.perIp` | body | integer | 是 | 0–100000；0 为不限 | 每个客户端的并发连接数 |
| `settings.newPerSecond` | body | integer | 是 | 0–100000；0 为不限 | 每个客户端每秒新建连接数 |
| `settings.burst` | body | integer | 是 | 0–1000000；非 0 时不小于 `newPerSecond`，且 `newPerSecond` 不能为 0；0 为等于 `newPerSecond` | 超出速率可一次新建的连接数 |
| `settings.ports` | body | `array<object>` | 是 | 可为 `null`；1–64 段，段之间不重叠；保存时排序并合并相邻的段 | 限制的端口段；`null` 为集群的监听端口与 TCP L4 应用端口 |
| `settings.ports[].start` | body | integer | 是 | 1–65535 | 起始端口 |
| `settings.ports[].end` | body | integer | 是 | 1–65535，不小于 `start` | 结束端口 |

响应：同 `clusters.connectionLimits`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |

### `clusters.setCache`

`PUT /clusters/{id}/cache` · 写

集群缓存区为结构性变更：节点重写缓存区并 reload nginx。节点可用 [`nodes.setCache`](#nodessetcache) 覆盖大小。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 集群 ID |
| `maxSizeGb` | body | integer | 是 | 1–65536 | 每个节点的缓存区大小（GiB） |
| `inactiveDays` | body | integer | 是 | 1–90 | 未被请求的对象保留天数 |

响应：[集群](#集群对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |

## 注册 token

- token 一次性使用，只保存 SHA-256；`token` 只在创建时返回一次。
- 审计：`enrollment_token.create`。
- 行为见[添加节点](../../guide/clusters.md#添加节点)与[注册与身份](../../deploy/nodes.md#注册与身份)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`clusters.createEnrollmentToken`](#clusterscreateenrollmenttoken) | `POST /enrollment-tokens` | 写 |
| [`clusters.getEnrollmentToken`](#clustersgetenrollmenttoken) | `GET /enrollment-tokens/{id}` | 读 |

### `clusters.createEnrollmentToken`

`POST /enrollment-tokens` · 写 · 不接受 `Idempotency-Key`

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | body | uuid | 是 | — | 节点加入的集群 |
| `nodeGroupId` | body | uuid | 否 | 须属于 `clusterId`；默认集群的默认节点组 | 节点加入的节点组 |
| `nodeName` | body | string | 否 | 去掉首尾空格后最多 64 字符，默认 `""` | 注册后的节点名称；空字符串时为节点主机名，没有主机名时为 `node-<token ID 前 8 位>` |
| `ttlMinutes` | body | integer | 否 | 5–10080，默认 `60` | 有效期（分钟） |

响应：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `tokenId` | uuid | token ID，用于 `clusters.getEnrollmentToken` |
| `token` | string | 注册 token，`ewt_` 开头 |
| `expiresAt` | datetime | 过期时间 |
| `serverUrl` | string | 当前生效的节点通道地址 |
| `caSha256` | string | 节点通道 CA 的 SHA-256 指纹 |
| `installCommand` | string | 安装命令：`export EDGEWEIR_TOKEN=…` 与 `curl -fsSL <控制台>/install.sh \| sudo --preserve-env=EDGEWEIR_TOKEN bash -s -- --server … --ca-sha256 …` 两行 |
| `warnings` | `array<enum>` | 其他网络的节点可能访问不到的地址：`console_url_local`、`console_url_private`、`console_url_http`、`node_api_url_local`、`node_api_url_private` |

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |
| `NODE_GROUP_NOT_FOUND` | 404 | 节点组不存在 |
| `NODE_GROUP_CLUSTER_MISMATCH` | 400 | 节点组属于其他集群 |

### `clusters.getEnrollmentToken`

`GET /enrollment-tokens/{id}` · 读

不返回 token 本身。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | `tokenId` |

响应：`{ tokenId, expiresAt, usedAt, node }`。`usedAt` 为使用时间，未使用时为 `null`；`node` 为注册的[节点](#节点对象)，未使用或节点已删除时为 `null`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `ENROLLMENT_TOKEN_NOT_FOUND` | 404 | token 不存在 |

## 节点组

- 节点组名称在集群内唯一。每个集群有一个默认节点组，不能删除。
- 审计：`node_group.create`、`node_group.update`、`node_group.delete`。
- 行为见[节点组](../../guide/clusters.md#节点组)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`nodeGroups.list`](#nodegroupslist) | `GET /node-groups` | 读 |
| [`nodeGroups.create`](#nodegroupscreate) | `POST /node-groups` | 写 |
| [`nodeGroups.update`](#nodegroupsupdate) | `PATCH /node-groups/{id}` | 写 |
| [`nodeGroups.delete`](#nodegroupsdelete) | `DELETE /node-groups/{id}` | 写 |

### `nodeGroups.list`

`GET /node-groups` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | query | uuid | 否 | — | 只列出该集群的节点组；集群不存在时返回 `[]` |

响应：[节点组](#节点组对象)`[]`，默认节点组在前，其余按创建时间升序。

### `nodeGroups.create`

`POST /node-groups` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | body | uuid | 是 | — | 集群 ID |
| `name` | body | string | 是 | 去掉首尾空格后 1–64 字符 | 节点组名称 |
| `regionId` | body | uuid | 否 | 可为 `null`，默认 `null` | 区域 |
| `isCanary` | body | boolean | 否 | 默认 `false` | 金丝雀组：其节点先获得候选版本 |

响应：[节点组](#节点组对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |
| `NODE_GROUP_NAME_TAKEN` | 409 | 集群中已有同名节点组；`data.name` |
| `REGION_NOT_FOUND` | 404 | 区域不存在 |

### `nodeGroups.update`

`PATCH /node-groups/{id}` · 写

修改 `isCanary` 会改变该组节点的目标版本。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 节点组 ID |
| `name` | body | string | 否 | 去掉首尾空格后 1–64 字符；省略时不变 | 节点组名称 |
| `regionId` | body | uuid | 否 | 可为 `null`（清除区域）；省略时不变 | 区域 |
| `isCanary` | body | boolean | 否 | 省略时不变 | 金丝雀组 |

响应：[节点组](#节点组对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `NODE_GROUP_NOT_FOUND` | 404 | 节点组不存在 |
| `NODE_GROUP_NAME_TAKEN` | 409 | 集群中已有同名节点组；`data.name` |
| `REGION_NOT_FOUND` | 404 | 区域不存在 |

### `nodeGroups.delete`

`DELETE /node-groups/{id}` · 写

组内节点移到集群的默认节点组。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 节点组 ID |

响应：`{ ok: true }`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `NODE_GROUP_NOT_FOUND` | 404 | 节点组不存在 |
| `NODE_GROUP_IS_DEFAULT` | 409 | 默认节点组不能删除 |

## 节点

- 审计：`node.update`（改名，或同时改名与移组）、`node.move`（只移组）、`node.disable`、`node.enable`、`node.delete`、`node.set_probe`、`node.set_addresses`、`node.cache_update`。
- `nodes.setCache` 发布配置版本，原因代码 `node_cache_updated`（`reasonParams.node`）；`nodes.setAddresses` 发布集群的 DNS 版本（原因 `manual`）。
- 行为见[节点](../../guide/clusters.md#节点)、[调度地址与备用 IP](../../guide/scheduling.md#调度地址与备用-ip)、[节点兼任探针](../../guide/scheduling.md#节点兼任探针)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`nodes.list`](#nodeslist) | `GET /nodes` | 读 |
| [`nodes.get`](#nodesget) | `GET /nodes/{id}` | 读 |
| [`nodes.update`](#nodesupdate) | `PATCH /nodes/{id}` | 写 |
| [`nodes.disable`](#nodesdisable) | `POST /nodes/{id}/disable` | 写 |
| [`nodes.enable`](#nodesenable) | `POST /nodes/{id}/enable` | 写 |
| [`nodes.delete`](#nodesdelete) | `DELETE /nodes/{id}` | 写 |
| [`nodes.decommission`](#nodesdecommission) | `POST /nodes/{id}/decommission` | 写 |
| [`nodes.cancelDecommission`](#nodescanceldecommission) | `DELETE /nodes/{id}/decommission` | 写 |
| [`nodes.setProbe`](#nodessetprobe) | `PUT /nodes/{id}/probe` | 写 |
| [`nodes.setAddresses`](#nodessetaddresses) | `PUT /nodes/{id}/addresses` | 写 |
| [`nodes.setCache`](#nodessetcache) | `PUT /nodes/{id}/cache` | 写 |

### `nodes.list`

`GET /nodes` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | query | uuid | 否 | — | 只列出该集群的节点；集群不存在时返回 `[]` |

响应：[节点](#节点对象)`[]`，按创建时间升序。

### `nodes.get`

`GET /nodes/{id}` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 节点 ID |

响应：[节点](#节点对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `NODE_NOT_FOUND` | 404 | 节点不存在 |

### `nodes.update`

`PATCH /nodes/{id}` · 写

移入或移出金丝雀组会改变节点的目标版本。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 节点 ID |
| `name` | body | string | 否 | 去掉首尾空格后 1–64 字符；省略时不变 | 节点名称 |
| `nodeGroupId` | body | uuid | 否 | 同一集群的节点组；不接受 `null`；省略时不变 | 节点组 |

响应：[节点](#节点对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `NODE_NOT_FOUND` | 404 | 节点不存在 |
| `NODE_GROUP_NOT_FOUND` | 404 | 节点组不存在 |
| `NODE_GROUP_CLUSTER_MISMATCH` | 400 | 节点组属于其他集群 |

### `nodes.disable`

`POST /nodes/{id}/disable` · 写

停用的节点被节点通道拒绝（证书续期除外），继续使用 last-known-good 配置；其未完成的缓存任务投递标记为跳过，并退出未完成的升级任务。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 节点 ID |

响应：[节点](#节点对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `NODE_NOT_FOUND` | 404 | 节点不存在 |

### `nodes.enable`

`POST /nodes/{id}/enable` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 节点 ID |

响应：[节点](#节点对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `NODE_NOT_FOUND` | 404 | 节点不存在 |

### `nodes.delete`

`DELETE /nodes/{id}` · 写

删除节点并吊销其客户端证书（含续期替换下、仍被接受的旧证书）；之后 agent 须用新的注册 token 重新注册。节点退出未完成的升级任务，它作为探针测得的结果一并删除。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 节点 ID |

响应：`{ ok: true }`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `NODE_NOT_FOUND` | 404 | 节点不存在 |

### `nodes.decommission`

`POST /nodes/{id}/decommission` · 写

让节点停止服务并删除身份（能力 `decommission-v1`，edgeweir-node 1.7.0 起），节点报告完成后控制台吊销其证书并删除节点，见[退役节点](../../deploy/nodes.md#退役节点)。离线节点在下次连接时收到任务。服务账号不能调用。审计 `node.decommission`；节点报告失败时 `node.decommission_failed`，请求清除，`decommissionError` 为原因。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 节点 ID |

响应：[节点](#节点对象)，`decommissionRequestedAt` 非空。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `NODE_NOT_FOUND` | 404 | 节点不存在 |
| `NODE_CAPABILITY_REQUIRED` | 409 | 节点缺少 `decommission-v1` |
| `NODE_DECOMMISSION_DISABLED` | 409 | 节点已停用 |
| `NODE_DECOMMISSION_PENDING` | 409 | 已有未执行的请求 |

### `nodes.cancelDecommission`

`DELETE /nodes/{id}/decommission` · 写

撤回节点尚未执行的退役请求。审计 `node.decommission_cancel`。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 节点 ID |

响应：[节点](#节点对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `NODE_NOT_FOUND` | 404 | 节点不存在 |
| `NODE_DECOMMISSION_NOT_PENDING` | 409 | 没有未执行的请求 |

### `nodes.setProbe`

`PUT /nodes/{id}/probe` · 写

节点从其节点组的区域探测其他节点。关闭时删除该节点测得的探测结果。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 节点 ID |
| `enabled` | body | boolean | 是 | — | 兼任探针 |

响应：[节点](#节点对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `NODE_NOT_FOUND` | 404 | 节点不存在 |
| `NODE_REGION_REQUIRED` | 409 | 开启时节点的节点组没有区域 |

### `nodes.setAddresses`

`PUT /nodes/{id}/addresses` · 写

整体替换节点的配置调度地址；DNS 与探针使用它们，不再使用节点上报的地址。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 节点 ID |
| `addresses` | body | `array<object>` | 是 | 最多 8 个；非空时须有一个 `level` 为 0；`[]` 恢复为节点上报的公网地址 | 调度地址 |
| `addresses[].address` | body | string | 是 | 去掉首尾空格后 1–64 字符；单个单播 IP（可为私网地址），不是 CIDR，不重复 | 地址 |
| `addresses[].level` | body | integer | 是 | 0–2 | 0 主，1 备 1，2 备 2 |

响应：[节点](#节点对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `NODE_NOT_FOUND` | 404 | 节点不存在 |
| `NODE_ADDRESS_INVALID` | 400 | 地址不是单个单播 IP（CIDR、主机名、回环、链路本地、组播等）或重复；`data.address` |

### `nodes.setCache`

`PUT /nodes/{id}/cache` · 写

只有该节点 reload nginx。节点自己的大小在集群全部活动节点都上报 `cache-zone-v1` 后才生效。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 节点 ID |
| `maxSizeGb` | body | integer | 是 | 1–65536；可为 `null` | 节点的缓存区大小（GiB）；`null` 使用集群的大小 |

响应：[节点](#节点对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `NODE_NOT_FOUND` | 404 | 节点不存在 |

## SSH 安装

- 请求、状态、失败原因与凭据处理见 [SSH 安装](../../deploy/nodes.md#ssh-安装)。服务账号不能调用；只读 AccessKey 只能调用 `sshInstalls.get`。`start` 与 `retry` 不接受 `Idempotency-Key`。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| `sshInstalls.scanHostKeys` | `POST /ssh-installs/host-keys` | 写 |
| `sshInstalls.start` | `POST /ssh-installs` | 写 |
| `sshInstalls.get` | `GET /ssh-installs/{id}` | 读 |
| `sshInstalls.cancel` | `POST /ssh-installs/{id}/cancel` | 写 |
| `sshInstalls.retry` | `POST /ssh-installs/{id}/retry` | 写 |

## 节点日志

- 节点日志需要节点能力 `node-logs-v1`，Debug 日志需要 `debug-logs-v1`；响应的 `supported` 表示节点是否具备。
- 演示账号读取时，条目 `fields.client` 中的访客地址被缩减。
- 审计：`node.debug_logs_pull`。
- 行为见[节点日志](../../guide/node-logs.md)与 [Debug 日志](../../guide/node-logs.md#debug-日志)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`nodes.logs`](#nodeslogs) | `GET /nodes/{id}/logs` | 读 |
| [`nodes.debugLogs`](#nodesdebuglogs) | `GET /nodes/{id}/debug-logs` | 读 |
| [`nodes.debugLog`](#nodesdebuglog) | `GET /nodes/{id}/debug-logs/{pullId}` | 读 |
| [`nodes.pullDebugLogs`](#nodespulldebuglogs) | `POST /nodes/{id}/debug-logs` | 写 |

### `nodes.logs`

`GET /nodes/{id}/logs` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 节点 ID |
| `minLevel` | query | enum | 否 | `info` / `warn` / `error`；默认全部 | 该级别及以上 |
| `source` | query | enum | 否 | `agent` / `supervisor` / `nginx` / `lua` | 来源 |
| `from` | query | datetime | 否 | — | 节点上发生时间不早于此 |
| `to` | query | datetime | 否 | — | 节点上发生时间不晚于此 |
| `q` | query | string | 否 | 去掉首尾空格后最多 200 字符 | 消息包含此文本（不区分大小写） |
| `cursor` | query | string | 否 | 最多 200 字符 | 上一页的 `nextCursor`（更早的条目） |
| `limit` | query | integer | 否 | 1–200，默认 `100` | 每页条目数 |

响应：`{ entries, nextCursor, supported }`。`entries` 为[节点日志条目](#节点日志条目对象)`[]`，最新的在前；`nextCursor` 没有更早的条目时为 `null`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `NODE_NOT_FOUND` | 404 | 节点不存在 |
| `NODE_LOG_CURSOR_INVALID` | 400 | `cursor` 无法解析 |

### `nodes.debugLogs`

`GET /nodes/{id}/debug-logs` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 节点 ID |

响应：`{ pulls, supported }`。`pulls` 为 [Debug 日志拉取](#debug-日志拉取对象)`[]`（不含 `entries`），最新的在前，最多 10 个；超时未上传的拉取先标记为失败。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `NODE_NOT_FOUND` | 404 | 节点不存在 |

### `nodes.debugLog`

`GET /nodes/{id}/debug-logs/{pullId}` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 节点 ID |
| `pullId` | path | uuid | 是 | — | 拉取 ID |

响应：[Debug 日志拉取](#debug-日志拉取对象)，含 `entries`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `NODE_DEBUG_LOG_NOT_FOUND` | 404 | 该节点没有此拉取（节点不存在时也返回此错误） |

### `nodes.pullDebugLogs`

`POST /nodes/{id}/debug-logs` · 写

请节点上传内存中的 Debug 日志缓冲区；节点 120 秒内没有上传时拉取失败（`errorCode` 为 `debug_logs_timeout`）。每个节点同时只有一个未完成的拉取。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 节点 ID |
| `from` | body | datetime | 否 | 与 `to` 同时给出时早于 `to` | 起始时间 |
| `to` | body | datetime | 否 | — | 结束时间 |
| `components` | body | `array<string>` | 否 | 最多 16 个，每个为 1–64 个 `[a-z0-9_.-]`；默认 `[]`（不筛选） | 组件 |
| `sources` | body | `array<enum>` | 否 | `agent` / `supervisor` / `nginx` / `lua`，最多 4 个；默认 `[]`（不筛选） | 来源 |

响应：[Debug 日志拉取](#debug-日志拉取对象)（不含 `entries`）。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `NODE_NOT_FOUND` | 404 | 节点不存在 |
| `NODE_CAPABILITY_REQUIRED` | 409 | 节点缺少 `debug-logs-v1`；`data.features`、`data.nodes` |
| `NODE_DEBUG_LOGS_BUSY` | 409 | 节点已有未完成的拉取 |

## 区域

- 区域代码唯一。
- 审计：`region.create`、`region.update`、`region.delete`。
- 行为见[区域](../../guide/clusters.md#区域)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`regions.list`](#regionslist) | `GET /regions` | 读 |
| [`regions.create`](#regionscreate) | `POST /regions` | 写 |
| [`regions.update`](#regionsupdate) | `PATCH /regions/{id}` | 写 |
| [`regions.delete`](#regionsdelete) | `DELETE /regions/{id}` | 写 |

### `regions.list`

`GET /regions` · 读

无参数。

响应：[区域](#区域对象)`[]`，按代码升序。

### `regions.create`

`POST /regions` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `name` | body | string | 是 | 去掉首尾空格后 1–64 字符 | 区域名称 |
| `code` | body | string | 是 | 去掉首尾空格并转小写后 1–32 字符，小写字母、数字与 `-`，首字符为字母或数字 | 区域代码 |

响应：[区域](#区域对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `REGION_CODE_TAKEN` | 409 | 代码已被使用；`data.code` |

### `regions.update`

`PATCH /regions/{id}` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 区域 ID |
| `name` | body | string | 否 | 同 `regions.create`；省略时不变 | 区域名称 |
| `code` | body | string | 否 | 同 `regions.create`；省略时不变 | 区域代码 |

响应：[区域](#区域对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `REGION_NOT_FOUND` | 404 | 区域不存在 |
| `REGION_CODE_TAKEN` | 409 | 代码已被其他区域使用；`data.code` |

### `regions.delete`

`DELETE /regions/{id}` · 写

引用该区域的节点组保留，区域清空。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 区域 ID |

响应：`{ ok: true }`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `REGION_NOT_FOUND` | 404 | 区域不存在 |
| `REGION_IN_USE` | 409 | 仍有探针属于该区域；`data.probes` 为探针数 |

## 节点升级

- 升级任务覆盖集群的全部活动节点：所选节点组的节点为金丝雀（`canary`），其余节点为 `rollout`，推进后按批执行，同时升级的节点不超过 `rollout` 节点的 25%（至少 1 个）。
- 审计：`node.upgrade_create`、`node.upgrade_promote`、`node.upgrade_cancel`。
- 前提、状态与节点侧校验见[节点升级](../../guide/node-upgrades.md)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`upgrades.release`](#upgradesrelease) | `GET /node-releases/{version}` | 读 |
| [`upgrades.latestVersion`](#upgradeslatestversion) | `GET /node-upgrades/latest-version` | 读 |
| [`upgrades.list`](#upgradeslist) | `GET /node-upgrades` | 读 |
| [`upgrades.create`](#upgradescreate) | `POST /node-upgrades` | 写 |
| [`upgrades.promote`](#upgradespromote) | `POST /node-upgrades/{id}/promote` | 写 |
| [`upgrades.cancel`](#upgradescancel) | `POST /node-upgrades/{id}/cancel` | 写 |

### `upgrades.release`

`GET /node-releases/{version}` · 读

读取节点发布源中 `v<version>/checksums.txt`（最多 2 MiB，超时 15 秒）。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `version` | path | string | 是 | `主.次.修订`，可带 `-预发布` 后缀，最多 64 字符；开头的 `v` 被去掉 | 版本号 |

响应：`{ version, artifacts }`。`artifacts` 为每个支持的架构一项 `{ arch, archiveUrl, sha256, checksumsUrl, signatureUrl }`：`arch` 为 `amd64` / `arm64`；`archiveUrl` 为 `edgeweir-node_<version>_linux_<arch>.tar.gz`；`signatureUrl` 为 `checksums.txt.sigstore.json`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `UPGRADE_RELEASE_UNAVAILABLE` | 502 | 读不到清单，清单中有重复的归档，或没有支持的归档 |

### `upgrades.latestVersion`

`GET /node-upgrades/latest-version` · 读

GitHub 发布源经 releases API 查询，镜像读取 `<发布源>/latest`。每个发布源缓存 10 分钟，查询失败缓存 1 分钟。

无参数。

响应：`{ version }`，无法得知时 `version` 为 `null`。

### `upgrades.list`

`GET /node-upgrades` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | query | uuid | 否 | — | 只列出该集群的升级任务 |

响应：[升级任务](#升级任务对象)`[]`，最新的在前，最多 50 个。

### `upgrades.create`

`POST /node-upgrades` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `version` | body | string | 是 | 同 `upgrades.release` | 目标版本 |
| `nodeGroupId` | body | uuid | 是 | — | 先升级的节点组（金丝雀） |

响应：[升级任务](#升级任务对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `UPGRADE_RELEASE_UNAVAILABLE` | 502 | 同 `upgrades.release` |
| `NODE_GROUP_NOT_FOUND` | 404 | 节点组不存在 |
| `UPGRADE_TOO_MANY_NODES` | 409 | 集群的活动节点超过 `data.limit`（1000） |
| `UPGRADE_CANARY_EMPTY` | 409 | 所选节点组没有活动节点 |
| `UPGRADE_NODES_UNAVAILABLE` | 409 | 有活动节点不满足前提（Linux、发布中有其架构、具备 `self-upgrade-v1`、在线、数据面健康、已应用目标版本）；`data.nodes`（最多 10 个，其余为 `+N`） |
| `UPGRADE_BUSY` | 409 | 有节点已在未完成的升级任务中；`data.nodes` |

### `upgrades.promote`

`POST /node-upgrades/{id}/promote` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 升级任务 ID |

响应：[升级任务](#升级任务对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `UPGRADE_NOT_FOUND` | 404 | 升级任务不存在 |
| `UPGRADE_NOT_READY` | 409 | `canPromote` 为 `false` |

### `upgrades.cancel`

`POST /node-upgrades/{id}/cancel` · 写

取消 `held` 与 `pending` 的节点任务，任务状态变为 `cancelled`。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 升级任务 ID |

响应：[升级任务](#升级任务对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `UPGRADE_NOT_FOUND` | 404 | 升级任务不存在 |
| `UPGRADE_BUSY` | 409 | 有节点正在升级（`running`）；`data.nodes` |
| `UPGRADE_FINISHED` | 409 | 任务状态不是 `canary` 或 `rollout` |

## 端口池与 L4 应用

- 版本原因代码：`l4_app_created`、`l4_app_updated`、`l4_app_deleted`（`reasonParams.app` 为应用名称）。`clusters.setPortPools` 不发布配置版本。
- 审计：`cluster.port_pools_update`、`l4_app.create`、`l4_app.update`、`l4_app.enable`、`l4_app.disable`、`l4_app.delete`、`l4.cname_update`。
- 节点能力：配置中有 L4 应用时需要 `l4-v1`；端口段、`originPortMode: same` 与 TLS 卸载需要 `l4-v2`。
- 限制：每个集群最多 256 个应用（含停用的），应用端口合计最多 2048 个（端口段按全部端口计）。
- 行为见 [L4 转发](../../guide/l4.md)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`clusters.portPools`](#clustersportpools) | `GET /clusters/{clusterId}/port-pools` | 读 |
| [`clusters.setPortPools`](#clusterssetportpools) | `PUT /clusters/{clusterId}/port-pools` | 写 |
| [`l4Apps.list`](#l4appslist) | `GET /l4-apps` | 读 |
| [`l4Apps.get`](#l4appsget) | `GET /l4-apps/{id}` | 读 |
| [`l4Apps.create`](#l4appscreate) | `POST /l4-apps` | 写 |
| [`l4Apps.update`](#l4appsupdate) | `PATCH /l4-apps/{id}` | 写 |
| [`l4Apps.delete`](#l4appsdelete) | `DELETE /l4-apps/{id}` | 写 |
| [`l4Apps.setEnabled`](#l4appssetenabled) | `PUT /l4-apps/{id}/enabled` | 写 |
| [`l4Apps.setCnamePrefix`](#l4appssetcnameprefix) | `PUT /l4-apps/{id}/cname-prefix` | 写 |
| [`l4Apps.stats`](#l4appsstats) | `GET /l4-apps/{id}/stats` | 读 |

### `clusters.portPools`

`GET /clusters/{clusterId}/port-pools` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | 是 | — | 集群 ID |

响应：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `clusterId` | uuid | 集群 ID |
| `pools` | `array<object>` | 端口池 `[{ protocol, from, to }]`，按起始端口、协议排序；`protocol` 为 `tcp` / `udp` / `both` |
| `reservedPorts` | `array<integer>` | 集群 HTTP / HTTPS 监听的端口（80、443、附加端口与最新配置版本中的监听端口），不能进入端口池 |
| `nodesWithoutL4` | `array<object>` | 缺少 `l4-v1` 的活动节点 `[{ id, name }]`，升级前拒绝含 L4 应用的配置 |
| `nodesWithoutL4V2` | `array<object>` | 缺少 `l4-v2` 的活动节点 `[{ id, name }]` |

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |

### `clusters.setPortPools`

`PUT /clusters/{clusterId}/port-pools` · 写

整体替换端口池。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | 是 | — | 集群 ID |
| `pools` | body | `array<object>` | 是 | 最多 64 个 | 端口池 |
| `pools[].protocol` | body | enum | 是 | `tcp` / `udp` / `both` | `both` 同时用于 TCP 与 UDP |
| `pools[].from` | body | integer | 是 | 1024–65535 | 起始端口（含） |
| `pools[].to` | body | integer | 是 | 1024–65535，不小于 `from` | 结束端口（含） |

响应：同 `clusters.portPools`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |
| `L4_PORT_POOL_OVERLAP` | 400 | 同一协议的端口池重叠（`both` 与 `tcp`、`udp` 都算同一协议）；`data.pools`（`起始-结束/协议`，逗号分隔） |
| `L4_PORT_RESERVED` | 400 | 端口池包含集群 HTTP / HTTPS 监听的端口；`data.port` |
| `L4_PORT_IN_USE` | 409 | 新的端口池会把应用（含停用的）的端口留在池外；`data.apps`（`名称 (端口/协议)`，逗号分隔） |

### `l4Apps.list`

`GET /l4-apps` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | query | uuid | 否 | — | 只列出该集群的应用 |

响应：[L4 应用](#l4-应用对象)`[]`，按端口、协议排序。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 给出的集群不存在 |

### `l4Apps.get`

`GET /l4-apps/{id}` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 应用 ID |

响应：[L4 应用](#l4-应用对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `L4_APP_NOT_FOUND` | 404 | 应用不存在 |

### `l4Apps.create`

`POST /l4-apps` · 写 · `201`

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | body | uuid | 是 | — | 集群 ID |
| `name` | body | string | 是 | 去掉首尾空格后 1–100 字符 | 应用名称 |
| `protocol` | body | enum | 是 | `tcp` / `udp` | 协议 |
| `port` | body | integer | 是 | 1024–65535；在集群该协议的端口池内 | 监听端口（端口段的起始端口） |
| `portEnd` | body | integer | 否 | 1024–65535，可为 `null`，默认 `null`；大于 `port`，端口段最多 1000 个端口，全部在端口池内 | 端口段的结束端口；`null` 为单个端口 |
| `originPortMode` | body | enum | 否 | `fixed` / `same`，默认 `fixed` | `fixed`：使用每个源站的 `port`；`same`：使用连接到达的端口 |
| `certificateId` | body | uuid | 否 | 可为 `null`，默认 `null`；只用于 TCP；证书须已签发、未过期 | 节点用此证书终结 TLS 后以明文 TCP 转发，SNI 须为证书中的名称；`null` 为明文 TCP |
| `tlsMinimumVersion` | body | enum | 否 | `1.2` / `1.3`，默认 `1.2` | TLS 最低版本 |
| `enabled` | body | boolean | 否 | 默认 `true` | 启用 |
| `acceptProxyProtocol` | body | boolean | 否 | 默认 `false`；只用于 TCP | 监听要求 PROXY protocol 报头（v1 或 v2） |
| `proxyProtocolVersion` | body | integer | 否 | 0–2，默认 `0`；非 0 只用于 TCP | 发往源站的 PROXY protocol 版本；0 不发送 |
| `origins` | body | `array<object>` | 是 | 1–32 个，至少一个 `backup` 为 `false` | 源站 |
| `origins[].address` | body | string | 是 | 主机名或 IP，1–253 字符；源站地址策略同网站 | 源站地址 |
| `origins[].port` | body | integer | 否 | 1–65535；`originPortMode` 为 `fixed` 时必填，为 `same` 时忽略（保存为 0） | 源站端口 |
| `origins[].weight` | body | integer | 否 | 1–100，默认 `1` | 权重 |
| `origins[].backup` | body | boolean | 否 | 默认 `false` | 备用源站：其他源站全部不可用时才使用 |
| `maxFails` | body | integer | 否 | 1–100，默认 `3` | 被动健康检查：连续连接失败次数，达到后摘除源站 |
| `failTimeoutSeconds` | body | integer | 否 | 1–3600，默认 `30` | 被动健康检查：摘除后再次尝试的秒数 |
| `connectTimeoutMs` | body | integer | 否 | 100–60000，默认 `5000` | 连接源站超时（毫秒） |
| `idleTimeoutSeconds` | body | integer | 否 | 1–86400；省略时 TCP 为 `600`、UDP 为 `30` | 连接（TCP）或会话（UDP）空闲超时 |
| `allowListIds` | body | `array<uuid>` | 否 | 最多 16 个，去重；默认 `[]` | 只接受这些 IP 名单中的地址；空为全部地址 |
| `blockListIds` | body | `array<uuid>` | 否 | 最多 16 个，去重；默认 `[]` | 拒绝这些 IP 名单中的地址 |
| `maxConnections` | body | integer | 否 | 0–10000000，默认 `0` | 每个节点的并发连接或会话数；0 为不限 |
| `newConnectionsPerSecond` | body | integer | 否 | 0–1000000，默认 `0` | 每个节点每秒新建连接或会话数；0 为不限 |

响应：`{ app, revision }`：[L4 应用](#l4-应用对象)与发布的[配置版本](#配置版本对象)。新应用的 `cnamePrefix` 为随机 8 个字符。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |
| `L4_APP_LIMIT` | 409 | 集群已有 256 个应用；`data.limit` |
| `L4_PROXY_PROTOCOL_UNSUPPORTED` | 400 | UDP 应用设置了 `acceptProxyProtocol` 或非 0 的 `proxyProtocolVersion` |
| `L4_TLS_UNSUPPORTED` | 400 | UDP 应用设置了 `certificateId` |
| `L4_PORT_RANGE_INVALID` | 400 | `portEnd` 不大于 `port`，或端口段超过 `data.max`（1000）个端口 |
| `L4_PORT_RESERVED` | 400 | 端口是集群 HTTP / HTTPS 监听的端口；`data.port` |
| `L4_PORT_OUTSIDE_POOL` | 400 | 端口不在集群该协议的端口池内；`data.port` 为第一个池外端口 |
| `L4_PORT_IN_USE` | 409 | 同一集群同一协议的端口已有应用（含停用的）；`data.apps` |
| `L4_PORT_LIMIT` | 409 | 集群应用的端口合计超过 `data.limit`（2048） |
| `CERTIFICATE_NOT_FOUND` | 404 | 证书不存在 |
| `L4_CERTIFICATE_UNAVAILABLE` | 400 | 证书尚未签发或已过期 |
| `CERTIFICATE_CHAIN_EXPLICIT_CURVE` | 400 | 证书的 EC 公钥没有使用命名曲线，节点无法加载 |
| `CERTIFICATE_KEY_EXPLICIT_CURVE` | 400 | 证书的 EC 私钥没有使用命名曲线，节点无法加载 |
| `IP_LIST_NOT_FOUND` | 404 | `allowListIds` 或 `blockListIds` 中的名单不存在 |
| `ORIGIN_ADDRESS_FORBIDDEN` | 400 | 源站为特殊用途地址且不在源站地址允许清单内；`data.address`、`data.range` |
| `L4_ORIGIN_PORT_REQUIRED` | 400 | `originPortMode` 为 `fixed` 时有源站没有 `port` |

### `l4Apps.update`

`PATCH /l4-apps/{id}` · 写

只修改给出的字段，结果按 `l4Apps.create` 的规则校验。`origins` 整体替换，地址与端口不变的源站保留其 ID（节点上的被动健康状态随之保留）。修改 `protocol` 不改变 `idleTimeoutSeconds`。只修改 `originPortMode` 时按新模式重写已保存的源站端口：改为 `same` 时端口保存为 0；从 `same` 改为 `fixed` 而不给出 `origins` 时返回 `L4_ORIGIN_PORT_REQUIRED`。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 应用 ID |
| `expectedUpdatedAt` | body | datetime | 否 | — | 乐观并发：上次读取的 `updatedAt` |
| `name`、`protocol`、`port`、`portEnd`、`originPortMode`、`certificateId`、`tlsMinimumVersion`、`acceptProxyProtocol`、`proxyProtocolVersion`、`origins`、`maxFails`、`failTimeoutSeconds`、`connectTimeoutMs`、`idleTimeoutSeconds`、`allowListIds`、`blockListIds`、`maxConnections`、`newConnectionsPerSecond` | body | — | 否 | 同 `l4Apps.create`，没有默认值；省略时不变 | 同 `l4Apps.create` |

响应：`{ app, revision }`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `L4_APP_NOT_FOUND` | 404 | 应用不存在 |
| `UPDATED_AT_MISMATCH` | 409 | `expectedUpdatedAt` 不是当前值；`data.updatedAt` |
| `L4_PROXY_PROTOCOL_UNSUPPORTED` 等 | — | 同 `l4Apps.create`（`CLUSTER_NOT_FOUND`、`L4_APP_LIMIT` 除外） |

### `l4Apps.delete`

`DELETE /l4-apps/{id}` · 写

删除应用、其源站与统计。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 应用 ID |

响应：`{ revision }`：发布的[配置版本](#配置版本对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `L4_APP_NOT_FOUND` | 404 | 应用不存在 |

### `l4Apps.setEnabled`

`PUT /l4-apps/{id}/enabled` · 写

停用的应用保留端口与设置，不下发到节点，没有 DNS 记录。`enabled` 与当前状态相同时不发布、不写审计、不检查 `expectedUpdatedAt`，返回最新配置版本。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 应用 ID |
| `enabled` | body | boolean | 是 | — | 启用 |
| `expectedUpdatedAt` | body | datetime | 否 | — | 乐观并发：上次读取的 `updatedAt` |

响应：`{ app, revision }`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `L4_APP_NOT_FOUND` | 404 | 应用不存在 |
| `UPDATED_AT_MISMATCH` | 409 | `expectedUpdatedAt` 不是当前值；`data.updatedAt` |

### `l4Apps.setCnamePrefix`

`PUT /l4-apps/{id}/cname-prefix` · 写

设置应用 CNAME 目标的第一级标签；省略 `prefix` 时生成新的随机前缀。被替换的名称在集群的自动 DNS 曾发布过它时继续解析 24 小时。前缀改变时发布集群的 DNS 版本（原因 `cname`）。规则见 [CNAME 前缀](../../guide/domains.md#cname-前缀)。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 应用 ID |
| `prefix` | body | string | 否 | 去掉首尾空格并转小写后 1–30 个 `[a-z0-9-]`，不以 `-` 开头或结尾；在网站与应用间唯一（含仍在解析的旧前缀），不能是 `all`、`all-<n>` 或 DNS 绑定的记录名。UUID 只接受应用自己在 CNAME 前缀出现之前的前缀（当前前缀或 24 小时内被替换的） | 新前缀 |

响应：`{ prefix, retired }`。`retired` 为仍在解析的旧前缀 `[{ prefix, expiresAt }]`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `L4_APP_NOT_FOUND` | 404 | 应用不存在 |
| `CNAME_PREFIX_INVALID` | 400 | `prefix` 为不属于该应用的 UUID；`data.prefix` |
| `CNAME_PREFIX_CONFLICT` | 409 | 前缀已被使用或保留，或自动 DNS 的区域中该名称已有集群不管理的记录；`data.prefix` |

### `l4Apps.stats`

`GET /l4-apps/{id}/stats` · 读

范围为 `[from, to)`。每分钟计数按节点求和（每分钟的 `peakConcurrent` 为各节点峰值之和）。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 应用 ID |
| `from` | query | datetime | 是 | 早于 `to`；范围最长 7 天 | 起始时间 |
| `to` | query | datetime | 是 | — | 结束时间 |

响应：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `appId` | uuid | 应用 ID |
| `from`、`to` | datetime | 查询范围 |
| `bucketSeconds` | integer | 每个点的宽度：范围不超过 1 天为 60，不超过 5 天为 300，否则 3600 |
| `points` | `array<object>` | 从 `from` 所在的桶起每桶一项 `{ time, …计数 }`，最早在前，空桶为 0 |
| `totals` | object | 整个范围的计数 |
| `nodes` | `array<object>` | 每个上报的节点 `{ nodeId, nodeName, …计数 }`，连接数多的在前 |

计数：`connections`（接受的 TCP 连接或 UDP 会话）、`refused`（被 IP 名单或上限拒绝）、`peakConcurrent`（`points`、`totals` 中为每分钟峰值之和在桶或范围内的最大值，`nodes` 中为该节点自己的最大值）、`bytesReceived`（来自客户端的字节）、`bytesSent`（发往客户端的字节）。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `L4_APP_NOT_FOUND` | 404 | 应用不存在 |

## 对象

### 集群对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 集群 ID |
| `name` | string | 名称 |
| `description` | string | 描述 |
| `nodeCount` | integer | 节点数（含已停用的） |
| `onlineNodeCount` | integer | 在线节点数（含已停用的） |
| `liveNodeCount` | integer | 在线的活动节点数：配置当前下发的对象 |
| `appliedNodeCount` | integer | 其中运行目标版本的节点数（金丝雀进行中时目标为稳定版本或候选版本） |
| `siteCount` | integer | 网站数 |
| `latestRevision` | object | 最新的[配置版本](#配置版本对象)，或 `null` |
| `clientIpMode` | enum | 访客 IP 模式：`direct` / `proxy_protocol` / `header`，详情见 `clusters.clientIp` |
| `cache.maxSizeGb` | integer | 每个节点的缓存区大小（GiB），节点可覆盖 |
| `cache.inactiveDays` | integer | 未被请求的对象保留天数 |
| `createdAt` | datetime | 创建时间 |

### 配置版本对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `clusterId` | uuid | 集群 ID |
| `revision` | integer | 版本号 |
| `contentHash` | string | 内容哈希 |
| `siteCount` | integer | 版本中的网站数 |
| `reason` | string | 英文原因文本 |
| `reasonCode` | string | 原因代码；原因代码出现之前发布的版本为 `""` |
| `reasonParams` | object | 原因参数，值为 string 或 number |
| `createdAt` | datetime | 发布时间 |

### 金丝雀发布对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `clusterId` | uuid | 集群 ID |
| `policy` | object | 策略：`enabled`、`windowSeconds`、`autoPromote`、`errorRatioMultiplier`、`errorRatioFloor`、`minRequests`，含义见 `clusters.setRolloutPolicy` |
| `state` | enum | `idle`、`canary`、`awaiting_promotion`、`promoted`、`rolled_back`、`direct`；策略关闭时为 `idle` |
| `stableRevision` | integer | 非金丝雀节点的版本，或 `null` |
| `candidateRevision` | integer | 发布进行中金丝雀节点的版本，或 `null` |
| `lastCandidateRevision` | integer | 最近一次推进或回滚的候选版本，或 `null` |
| `windowStartedAt` | datetime | 观察窗口开始时间，或 `null` |
| `windowEndsAt` | datetime | 观察窗口结束时间，或 `null` |
| `outcome` | enum | `""`、`auto_promote`、`manual_promote`、`apply_failed`、`apply_timeout`、`unhealthy`、`error_ratio`、`manual_abort`、`no_canary`、`policy_disabled`、`manual_rollback`、`withdrawn` |
| `finishedAt` | datetime | 最近一次发布结束时间，或 `null` |
| `canaryNodes` | `array<object>` | 金丝雀组的活动节点，以及离开金丝雀组但仍在当前窗口中的节点：`{ id, name, online, appliedRevision, participating }`，`participating` 为参与当前窗口 |
| `window` | object | 当前窗口的流量 `{ canaryRequests, canary5xx, baselineRequests, baseline5xx }`，没有进行中的发布时为 `null` |
| `candidateChanges` | object | 发布进行中为 `{ sites: { added, changed, removed }, reasons }`：候选版本相对稳定版本新增、修改、移除的网站 `[{ id, name }]`，以及稳定版本之后发布的[配置版本](#配置版本对象)（原因不重复）；否则为 `null` |
| `policyUpdatedAt` | datetime | 策略最近修改时间；`clusters.setRolloutPolicy` 的 `expectedUpdatedAt` 与之比较 |
| `updatedAt` | datetime | 任何变化（含每个发布步骤）的最近时间 |

### 节点组对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 节点组 ID |
| `clusterId` | uuid | 集群 ID |
| `name` | string | 名称 |
| `isDefault` | boolean | 集群的默认节点组 |
| `isCanary` | boolean | 金丝雀组：其节点先获得候选版本 |
| `regionId` | uuid | 区域 ID，或 `null` |
| `regionName` | string | 区域名称，或 `null` |
| `regionCode` | string | 区域代码，或 `null` |
| `nodeCount` | integer | 节点数 |
| `createdAt` | datetime | 创建时间 |

### 区域对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 区域 ID |
| `name` | string | 名称 |
| `code` | string | 代码 |
| `nodeGroupCount` | integer | 使用该区域的节点组数 |
| `createdAt` | datetime | 创建时间 |

### 节点对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 节点 ID |
| `name` | string | 名称 |
| `clusterId` | uuid | 集群 ID |
| `clusterName` | string | 集群名称 |
| `nodeGroupId` | uuid | 节点组 ID，或 `null` |
| `nodeGroupName` | string | 节点组名称，或 `null` |
| `regionName` | string | 节点组的区域名称，或 `null` |
| `hostname` | string | 主机名 |
| `status` | enum | `active` / `disabled` |
| `decommissionRequestedAt` | datetime | 等待节点执行的退役请求时间，或 `null` |
| `decommissionError` | string | 上次退役失败的原因（`decommission_failed: …`），或 `null` |
| `online` | boolean | 在线 |
| `lastSeenAt` | datetime | 最近一次心跳，或 `null` |
| `enrolledAt` | datetime | 注册时间，或 `null` |
| `agentVersion` | string | agent 版本 |
| `supportedFeatures` | `array<string>` | 节点上报的能力，见下文 |
| `upgradeRequired` | boolean | 节点缺少集群最新配置要求的能力，或缺少 `stats-sequence-v1` |
| `engine` | string | 数据面引擎 |
| `engineVersion` | string | 引擎版本 |
| `os` | string | 操作系统 |
| `arch` | string | 架构 |
| `ipAddresses` | `array<string>` | 节点上报的地址，排序（配置的地址见 `schedulingAddresses`） |
| `certFingerprint` | string | 客户端证书指纹，或 `null` |
| `certNotAfter` | datetime | 客户端证书到期时间，或 `null` |
| `appliedRevision` | integer | 已应用的版本号；没有时为 0 |
| `appliedContentHash` | string | 已应用版本的内容哈希；没有时为 `""` |
| `targetRevision` | integer | 节点应运行的版本（金丝雀进行中为稳定版本或候选版本），或 `null` |
| `applyState` | enum | `applying` / `applied` / `failed`，或 `null` |
| `applyMessage` | string | 应用结果消息 |
| `dataPlaneHealthy` | boolean | 数据面健康 |
| `banStatus` | object | 动态封禁状态，来自最近一次心跳（具备 `bans-v1` 的节点），否则为 `null` |
| `banStatus.appliedSequence` | string | 数据面已应用的最高封禁序号（十进制） |
| `banStatus.entries` | integer | 封禁条目数 |
| `banStatus.capacity` | integer | 封禁容量 |
| `banStatus.unappliedIds` | `array<string>` | 节点无法保存的手动封禁 ID（最多 100 个） |
| `banStatus.unapplied` | integer | 节点无法保存的手动封禁数 |
| `banStatus.kernelEntries` | integer | nftables 保存的平台封禁数（`kernel-ban-v1`） |
| `banStatus.autoEvicted` | string | agent 启动以来为腾出空间而丢弃的自动封禁数（十进制） |
| `banStatus.reportedAt` | datetime | 上报时间 |
| `banStatus.connectionLimitsActive` | boolean | 可选；集群的连接数限制在内核中执行（`conn-limit-v1`） |
| `banStatus.connectionLimitsError` | string | 可选；未执行的原因（节点的消息） |
| `probeEnabled` | boolean | 兼任探针 |
| `metrics` | object | 最近一次心跳的主机指标（`metrics-v1`），节点上报之前为 `null` |
| `metrics.cpuPercent` | number | 整机 CPU 使用率，0–100 |
| `metrics.load1`、`metrics.load5`、`metrics.load15` | number | 负载 |
| `metrics.memoryUsedBytes`、`metrics.memoryTotalBytes` | number | 已用与总内存（字节） |
| `metrics.egressBps` | number | 非回环接口的发送速率（bit/s） |
| `metrics.activeConnections` | number | 活动连接数 |
| `metrics.reportedAt` | datetime | 上报时间 |
| `schedulingAddresses` | `array<object>` | DNS 与探针使用的地址 `{ address, level, source, reachable }`：`source` 为 `configured`（运营者配置，带级别）或 `reported`（没有配置地址时节点上报的公网地址，级别 0）；`reachable` 为 `false` 时探针判定其不可达 |
| `schedulingLevel` | integer | DNS 当前使用的地址级别（0 为主；低级别不可达时更高） |
| `remoteAddress` | string | 节点最近一次连接控制台的源地址（NAT 后的公网地址或代理的地址），连接之前为 `null` |
| `dnsIssue` | enum | `no_public_address`：节点没有上报公网地址也没有配置地址，DNS 无法应答该节点；否则为 `null` |
| `authError` | string | 自最近一次心跳以来节点通道拒绝节点自己证书的原因（OpenSSL 校验代码；`CERT_HAS_EXPIRED` 时须重新注册），否则为 `null` |
| `cache.maxSizeGb` | integer | 节点自己的缓存区大小（GiB），或 `null`（使用集群的） |
| `cache.usage` | object | 最近一次测得的缓存磁盘用量 `{ usedBytes, maxBytes, measuredAt }`，具备 `cache-zone-v1` 的节点上报之前为 `null` |
| `certificateFailures` | `array<object>` | 已应用版本中节点无法加载的证书（`certificate-isolation-v1`）：`{ certificateId, certificateName, reason, servingEarlier }`；`certificateName` 在证书已删除时为 `""`；`reason` 为 `invalid_material` / `fingerprint_mismatch` / `unavailable`；`servingEarlier` 为 `true` 时节点继续使用该证书此前的材料，否则拒绝其握手 |
| `channel` | object | 节点使用的节点通道地址，节点还没有连接过记录它的控制台时为 `null` |
| `channel.url` | string | 节点上报的地址（`channel-follow-v1`），旧版 agent 为 `null` |
| `channel.serverName` | string | 该地址校验的服务器名称 |
| `channel.fallbackUrl` | string | 最近一次切换前的地址，`url` 失败时尝试，或 `null` |
| `channel.fallbackServerName` | string | 回退地址的服务器名称 |
| `channel.onFallback` | boolean | 因 `url` 失败正在使用回退地址 |
| `channel.source` | enum | `url` 的来源：`enroll` / `console` / `command`（`edgeweir-node set-server`），或 `null` |
| `channel.switchedAt` | datetime | 切换时间，或 `null` |
| `channel.error` | object | 最近一次地址检查失败 `{ code, message, url, serverName, at }`，`code` 为 `unreachable`、`websocket_refused`、`tls_untrusted`、`rejected`、`wrong_identity`、`invalid_address`，`message` 为 agent 的消息；或 `null` |
| `channel.observedServerName` | string | 最近一次连接的 TLS 服务器名称；未发送（IP 地址）时为 `""` |
| `channel.observedWebSocket` | boolean | 最近一次连接经 WebSocket 入口 |
| `channel.observedAt` | datetime | 最近一次连接时间 |
| `clock` | object | 节点时钟相对控制台的偏差 `{ offsetMs, measuredAt, skewed }`：`offsetMs` 为正时节点超前；`skewed` 为偏差达到告警策略的 `clockSkewSeconds`；v1.5.0 之前的节点为 `null` |
| `location` | object | 节点公网地址的位置（节点 GeoIP 数据库）`{ address, country, subdivision, latitude, longitude }`：`country` 为 ISO 3166-1 alpha-2，未知时为 `""`；坐标需要 City MMDB，否则为 `null`；v1.6.2 之前的节点为 `null` |

`supportedFeatures` 中控制台识别的能力（按场景要求的全部能力见[节点能力](../../guide/node-upgrades.md#节点能力)）：

| 能力 | 含义 |
| --- | --- |
| `purge-tag-v1` | 按主机与 Cache-Tag 清缓存；集群有活动节点缺少时拒绝这类任务 |
| `prefetch-v2` | 预热设备变体与站点地图预热任务 |
| `probe-health-v1` | 边缘监听的健康端点 `/.edgeweir/health`；集群全部活动节点具备时探针以 HTTP / HTTPS 探测 |
| `metrics-v1` | 心跳中的主机指标（`metrics`） |
| `rule-log-v1` | 「记录」动作规则的每分钟匹配数 |
| `stats-dims-v1` | 统计维度 |
| `origin-stats-v1` | 每个源站的每分钟回源统计 |
| `l4-v1` | L4 应用与其统计 |
| `l4-v2` | L4 端口段、同号源站端口与 TLS 卸载 |
| `cache-zone-v1` | 节点自己的缓存区大小与心跳中的缓存用量 |
| `auth-identity-headers-v1` | 删除已停用与已删除访问鉴权规则的身份报头；从不要求 |
| `certificate-isolation-v1` | 无法加载的证书单独排除并上报（`certificateFailures`）；从不要求 |
| `encoded-path-exemptions-v1` | 网站的编码路径豁免；从不要求 |
| `channel-follow-v1` | 上报并跟随控制台给出的节点通道地址（`channel`） |
| `node-logs-v1` | 上传节点日志；从不要求 |
| `debug-logs-v1` | Debug 日志缓冲区与拉取；从不要求，缺少时 `nodes.pullDebugLogs` 被拒绝 |
| `geoip-city-v1`、`geoip-country-v1`、`geoip-subdivision-v1` | GeoIP 国家与省级数据；未上报 `geoip-country-v1` 的节点以 `geoip-city-v1` 代表省级数据 |
| `edge-ports-v1`、`client-ip-v1`、`unknown-host-v1`、`conn-limit-v1` | 集群网络设置，见[集群网络设置](#集群网络设置监听端口访客-ip未知域名连接数限制缓存区) |
| `self-upgrade-v1` | 签名升级；`upgrades.create` 要求 |
| `stats-sequence-v1` | 带序号的统计上报；缺少时 `upgradeRequired` 始终为 `true` |
| `bans-v1`、`kernel-ban-v1` | 动态封禁（`banStatus`）与 nftables 中的平台封禁 |

### 节点日志条目对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 条目 ID |
| `time` | datetime | 节点上发生的时间 |
| `receivedAt` | datetime | 控制台收到的时间 |
| `kind` | enum | `entry`：节点上传的条目；`dropped`：节点在一批之前丢弃的条数 |
| `level` | enum | `info` / `warn` / `error` |
| `source` | enum | `agent` / `supervisor` / `nginx` / `lua` |
| `component` | string | 组件 |
| `message` | string | 消息，已脱敏 |
| `fields` | object | 字段（string → string），已脱敏 |
| `repeated` | integer | 节点合并进此条的相同条目数 |
| `truncated` | boolean | 已截断 |
| `event` | string | `info` 条目的事件：`agent_started`、`config_applied`、`last_known_good`、`engine_started`、`certificate_renewed`、`channel_switched`、`upgrade_applied`、`engine_logs_unavailable`；其他条目为 `""` |
| `dropped` | object | `kind` 为 `dropped` 时为 `{ rateLimited, overflow }`（超出节点限速与缓冲区丢弃的条数），否则为 `null` |

### Debug 日志拉取对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 拉取 ID |
| `nodeId` | uuid | 节点 ID |
| `state` | enum | `pending` / `running` / `succeeded` / `failed` |
| `from`、`to` | datetime | 拉取的时间筛选，或 `null` |
| `components` | `array<string>` | 组件筛选，空为不筛选 |
| `sources` | `array<enum>` | 来源筛选，空为不筛选 |
| `createdAt` | datetime | 创建时间 |
| `deadlineAt` | datetime | 节点未上传时拉取失败的时间 |
| `finishedAt` | datetime | 结束时间，或 `null` |
| `errorCode` | string | `debug_logs_timeout`、`debug_logs_failed`（`errorParams.reason` 为 `disabled` / `upload_failed`）、`task_unsupported`，成功时为 `""` |
| `errorParams` | object | 错误参数（string → string） |
| `entryCount` | integer | 条目数 |
| `truncated` | boolean | 因上传上限（10000 条、4 MiB）略去了更早的匹配条目 |
| `bufferSince` | datetime | 节点缓冲区中最早的条目时间，更早的不可能在拉取中；或 `null` |
| `overwritten` | integer | 节点缓冲区启动以来因容量覆盖的条目数 |
| `supervisorMissing` | boolean | 无法读取监督进程（及其下 OpenResty）的条目 |
| `entries` | `array<object>` | 仅 `nodes.debugLog`：条目 `{ time, level, source, component, message, fields, truncated, event }`，最早在前；`level` 为 `debug` / `info` / `warn` / `error`；节点上传之前为 `[]` |

### 升级任务对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 升级任务 ID |
| `clusterId` | string | 集群 ID |
| `clusterName` | string | 集群名称 |
| `groupName` | string | 先升级的节点组名称 |
| `version` | string | 目标版本 |
| `state` | enum | `canary`、`rollout`、`succeeded`、`failed`、`cancelled` |
| `createdAt` | string | 创建时间（ISO 8601） |
| `canPromote` | boolean | 状态为 `canary`，有等待中的 `rollout` 节点，且金丝雀节点都已成功、运行目标版本、在线、数据面健康、已应用其目标配置并保持两个心跳周期 |
| `deliveries` | `array<object>` | 每个节点的任务，按阶段、节点名称排序 |
| `deliveries[].id` | string | 节点任务 ID |
| `deliveries[].nodeId` | string | 节点 ID |
| `deliveries[].nodeName` | string | 节点名称 |
| `deliveries[].phase` | enum | `canary` / `rollout` |
| `deliveries[].state` | enum | `held`、`pending`、`running`、`succeeded`、`failed`、`cancelled` |
| `deliveries[].message` | string | 消息 |
| `deliveries[].errorCode` | string | 错误代码，如 `upgrade_cancelled`、`upgrade_expired`、`upgrade_node_removed`（节点停用或删除），或节点上报的代码；没有时为 `""` |
| `deliveries[].deadlineAt` | string | `pending` 与 `running` 的截止时间（释放后 30 分钟），其他状态为 `null` |
| `deliveries[].finishedAt` | string | 结束时间，或 `null` |

### L4 应用对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 应用 ID |
| `clusterId` | uuid | 集群 ID |
| `clusterName` | string | 集群名称 |
| `name` | string | 名称 |
| `protocol` | enum | `tcp` / `udp` |
| `port` | integer | 监听端口（端口段的起始端口） |
| `enabled` | boolean | 启用；停用的应用不下发到节点，没有 DNS 记录 |
| `acceptProxyProtocol` | boolean | 监听要求 PROXY protocol 报头 |
| `proxyProtocolVersion` | integer | 发往源站的 PROXY protocol 版本，0 不发送 |
| `portEnd` | integer | 端口段的结束端口，单个端口时为 `null` |
| `originPortMode` | enum | `fixed` / `same` |
| `certificateId` | uuid | TLS 卸载的证书 ID，或 `null` |
| `certificateName` | string | 证书名称，没有 TLS 时为 `null` |
| `tlsMinimumVersion` | enum | `1.2` / `1.3` |
| `origins` | `array<object>` | 源站 `{ id, address, port, weight, backup }`，按保存顺序；`originPortMode` 为 `same` 时 `port` 为 0 |
| `maxFails` | integer | 被动健康检查的连续失败次数 |
| `failTimeoutSeconds` | integer | 被动健康检查的重试秒数 |
| `connectTimeoutMs` | integer | 连接源站超时（毫秒） |
| `idleTimeoutSeconds` | integer | 空闲超时（秒） |
| `allowListIds` | `array<uuid>` | 允许名单 |
| `blockListIds` | `array<uuid>` | 拒绝名单 |
| `maxConnections` | integer | 每个节点的并发上限，0 为不限 |
| `newConnectionsPerSecond` | integer | 每个节点每秒新建上限，0 为不限 |
| `cnamePrefix` | string | CNAME 目标的第一级标签（新应用为随机值，较早的应用为其 ID） |
| `dnsTarget` | string | 客户端连接的 CNAME `<cnamePrefix>.<集群 DNS 域名>`（应用启用时发布）；集群 DNS 关闭时为 `null` |
| `dnsLines` | `array<object>` | 每条 DNS 线路 `{ name, target }`：开启线路别名时 `target` 为 `<线路>.<cnamePrefix>.<域名>`，否则为 `<线路>.<域名>` |
| `dnsRetired` | `array<object>` | 被替换、在 `expiresAt` 之前仍解析的名称 `{ name, expiresAt }`（有 DNS 绑定时） |
| `createdAt` | datetime | 创建时间 |
| `updatedAt` | datetime | 修改时间 |
