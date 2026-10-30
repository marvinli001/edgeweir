# API：概览、统计与告警

概览、流量统计、访问日志、用量记录、审计日志与告警（渠道、规则、订阅、事件）的过程、参数、响应与错误。

权限级别、认证、幂等键与错误格式见 [API 概览](../api.md)。

## 概览

行为见 [概览](../../guide/overview.md)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`overview.get`](#overviewget) | `GET /overview` | 读 |

### `overview.get`

`GET /overview` · 读

无参数。

响应：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `clusters` | integer | 集群数 |
| `nodes` | integer | 节点数（含已停用） |
| `onlineNodes` | integer | 最近 3 个心跳周期（45 秒）内有心跳的节点数（含已停用） |
| `sites` | integer | 网站数（含已停用） |
| `revisions` | array<[配置版本](#配置版本对象)> | 全部集群最近发布的 10 个配置版本，按发布时间从新到旧 |
| `attention` | array<[待处理事项](#待处理事项对象)> | 需要处理的事项，按 `kind` 在[待处理事项对象](#待处理事项对象)中的顺序排列，同一 `kind` 按集群名称排列；没有时为 `[]` |

## 统计

数据来自节点每分钟上报的统计，只含现存网站的统计。行为见 [概览：统计](../../guide/overview.md#统计) 与 [统计维度](../../guide/access-logs.md#统计维度)。

| `range` | 时长 | 桶宽（`bucketSeconds`） | 桶数 | 数据来源 |
| --- | --- | --- | --- | --- |
| `1h` | 1 小时 | 60 | 60 | 分钟统计 |
| `6h` | 6 小时 | 300 | 72 | 分钟统计 |
| `24h` | 24 小时 | 600 | 144 | 分钟统计 |
| `7d` | 7 天 | 3600 | 168 | 小时汇总 |
| `30d` | 30 天 | 21600 | 120 | 小时汇总 |

- 桶按 Unix 纪元（UTC）对齐；范围的最后一个桶包含当前时间（仍在累计），响应的 `to` 为当前时间。
- 带 `siteId` 的过程：网站不存在时 404 `SITE_NOT_FOUND`。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`analytics.traffic`](#analyticstraffic) | `GET /analytics/traffic` | 读 |
| [`analytics.breakdown`](#analyticsbreakdown) | `GET /analytics/breakdown` | 读 |
| [`analytics.topSites`](#analyticstopsites) | `GET /analytics/top-sites` | 读 |
| [`analytics.topNodes`](#analyticstopnodes) | `GET /analytics/top-nodes` | 读 |
| [`analytics.topRequests`](#analyticstoprequests) | `GET /analytics/top-requests` | 读 |
| [`analytics.dimensions`](#analyticsdimensions) | `GET /analytics/dimensions` | 读 |

### `analytics.traffic`

`GET /analytics/traffic` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `range` | query | enum | 否 | `1h` / `6h` / `24h` / `7d` / `30d`，默认 `24h` | 时间范围 |
| `siteId` | query | uuid | 否 | — | 只统计该网站；省略时为全部网站 |

响应：[流量对象](#流量对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | `siteId` 的网站不存在 |

### `analytics.breakdown`

`GET /analytics/breakdown` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `range` | query | enum | 否 | `1h` / `6h` / `24h` / `7d` / `30d`，默认 `24h` | 时间范围 |
| `siteId` | query | uuid | 否 | — | 只统计该网站；省略时为全部网站 |
| `by` | query | enum | 是 | `site` / `node` / `status` / `block_reason` | 按网站、边缘节点、HTTP 状态码或拦截原因（被拒绝或被挑战的请求）分解 |
| `metric` | query | enum | 否 | `requests` / `bytesSent`，默认 `requests` | 排名与曲线的指标；只对 `site`、`node` 生效，`status`、`block_reason` 总是按请求数 |
| `statusClass` | query | integer | 否 | 1–5 | 只对 `by: status` 生效：只保留以该数字开头的状态码（`4` 即 4xx） |
| `limit` | query | integer | 否 | 1–20，默认 `10` | 返回的项数 |

响应：[分解对象](#分解对象)。

- `items` 只含总量大于 0 的项，从大到小；总量相同时网站与节点按名称、状态码与拦截原因按代码排列。
- `total` 与 `totalSeries` 覆盖分解范围内的全部数据（`statusClass` 生效时只含该类状态码），减去 `items` 即其余部分。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | `siteId` 的网站不存在 |

### `analytics.topSites`

`GET /analytics/top-sites` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `range` | query | enum | 否 | `1h` / `6h` / `24h` / `7d` / `30d`，默认 `24h` | 时间范围 |
| `limit` | query | integer | 否 | 1–50，默认 `5` | 返回的网站数 |

响应：array<[排行项](#排行项对象)>，范围内有统计的网站按请求数从多到少，请求数相同时按名称；`parentId`、`parentName` 为网站所在集群。

### `analytics.topNodes`

`GET /analytics/top-nodes` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `range` | query | enum | 否 | `1h` / `6h` / `24h` / `7d` / `30d`，默认 `24h` | 时间范围 |
| `limit` | query | integer | 否 | 1–50，默认 `5` | 返回的节点数 |

响应：array<[排行项](#排行项对象)>，范围内有统计的节点（全部集群）按请求数从多到少，请求数相同时按名称；`parentId`、`parentName` 为节点所在集群。

### `analytics.topRequests`

`GET /analytics/top-requests` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `range` | query | enum | 否 | `1h` / `6h` / `24h` / `7d` / `30d`，默认 `24h` | 时间范围 |
| `siteId` | query | uuid | 否 | — | 只统计该网站；省略时为全部网站 |
| `by` | query | enum | 是 | `url` / `ip` | 按 URL 或客户端 IP 排行 |
| `limit` | query | integer | 否 | 1–50，默认 `10` | 返回的项数 |

> [!WARNING]
> `limit` 的校验不把字符串转换为数字：在查询字符串中传入 `limit` 返回 400 `BAD_REQUEST`。只能省略它，取默认值 `10`。

响应：`{ approximate: true, items: [{ value, requests }] }`。`value` 为 URL 或客户端 IP，`requests` 为节点每分钟预聚合的高频项之和，`approximate` 恒为 `true`。`items` 按 `requests` 从多到少，相同时按 `value`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | `siteId` 的网站不存在 |

### `analytics.dimensions`

`GET /analytics/dimensions` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `range` | query | enum | 否 | `1h` / `6h` / `24h` / `7d` / `30d`，默认 `24h` | 时间范围 |
| `siteId` | query | uuid | 否 | — | 只统计该网站；省略时为全部网站 |

响应：[统计维度对象](#统计维度对象)。维度由节点能力 `stats-dims-v1` 统计，只用于统计，不影响配置发布。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | `siteId` 的网站不存在 |

## 访问日志

- 存储由 `EDGEWEIR_ANALYTICS` 决定：`lite`（PostgreSQL）或 `clickhouse`；保留天数见系统设置 `settings.logRetention`。
- 行为见 [启用访问日志](../../guide/access-logs.md#启用访问日志)、[查询与导出日志](../../guide/access-logs.md#查询与导出日志) 与 [保留期](../../guide/access-logs.md#保留期)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`logs.settings`](#logssettings) | `GET /sites/{siteId}/logs/settings` | 读 |
| [`logs.configure`](#logsconfigure) | `PUT /sites/{siteId}/logs/settings` | 写 |
| [`logs.query`](#logsquery) | `GET /sites/{siteId}/logs` | 读 |
| [`logs.export`](#logsexport) | `GET /sites/{siteId}/logs/export` | 读 |

### `logs.settings`

`GET /sites/{siteId}/logs/settings` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `siteId` | path | uuid | 是 | — | 网站 ID |

响应：[日志设置对象](#日志设置对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

### `logs.configure`

`PUT /sites/{siteId}/logs/settings` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `siteId` | path | uuid | 是 | — | 网站 ID |
| `sampleRate` | body | integer | 否 | 0–10000，省略时不变 | 采样率，单位为万分之一（`10000` 为全部请求，`0` 为不采样） |
| `logBlocked` | body | boolean | 否 | 省略时不变 | 被拦截、被挑战与鉴权拒绝的请求总是记录 |
| `logQuery` | body | boolean | 否 | 省略时不变 | 记录查询字符串 |
| `logHeaders` | body | `array<string>` | 否 | 最多 8 个；每个去首尾空白、转小写后须为 1–64 个 `a-z`、`0-9`、`-` 字符，不得为 `authorization`、`cookie`、`proxy-authorization`；去重；省略时不变 | 记录的请求头名称，整体替换 |
| `logPeer` | body | boolean | 否 | 省略时不变 | 连接对端地址与客户端地址不同时记录对端地址 |

响应：`{ ok: true }`。

- 发布网站所在集群的配置版本（原因码 `site_updated`）；配置内容不变时不生成新版本。
- 审计 `site.logs_configure`，元数据为发生变化的字段（修改后的值）；没有字段变化时为 `{ sampleRate }`。
- 配置中有网站 `sampleRate` 大于 0 时要求节点能力 `access-logs-v1`；开启 `logBlocked`、`logQuery`、`logPeer` 或 `logHeaders` 非空时要求 `access-logs-v2`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

### `logs.query`

`GET /sites/{siteId}/logs` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `siteId` | path | uuid | 是 | — | 网站 ID |
| `from` | query | datetime | 是 | 须以 `Z` 结尾（UTC），不接受时区偏移 | 起始时间（含） |
| `to` | query | datetime | 是 | 须以 `Z` 结尾（UTC），不接受时区偏移 | 结束时间（不含） |
| `status` | query | integer | 否 | 100–599 | 状态码等于该值 |
| `statusClass` | query | enum | 否 | `1xx` / `2xx` / `3xx` / `4xx` / `5xx` | 状态码类别；与 `status` 同时给出时两者都须满足 |
| `ip` | query | string | 否 | ≤64 字符，默认 `""`（不筛选） | 客户端 IP 等于该值 |
| `cidr` | query | string | 否 | ≤64 字符；IPv4 或 IPv6 网段（如 `10.0.0.0/8`）或单个地址，主机位清零 | 客户端 IP 在该网段内 |
| `path` | query | string | 否 | ≤2048 字符，默认 `""`（不筛选） | 路径以该值开头 |
| `requestId` | query | string | 否 | ≤128 字符 | 请求 ID（`X-Request-Id`）等于该值；省略或为空时不筛选 |
| `host` | query | string | 否 | 去首尾空白后 ≤253 字符 | Host 等于该值，不区分大小写 |
| `method` | query | string | 否 | 0–32 个字母、`_`、`-` | 方法等于该值，不区分大小写 |
| `cacheStatus` | query | enum | 否 | `HIT` / `MISS` / `BYPASS` / `EXPIRED` / `STALE` / `UPDATING` / `REVALIDATED` | 缓存状态 |
| `blockReason` | query | enum | 否 | [拦截原因](#统计维度对象)之一，或 `any` | 拦截原因等于该值；`any` 匹配所有带拦截原因的请求 |
| `country` | query | string | 否 | 空或 2 个字母，不区分大小写 | 客户端国家或地区（ISO 3166-1 alpha-2） |
| `asn` | query | integer | 否 | 1–4294967295 | 客户端网络的 AS 号 |
| `ua` | query | string | 否 | ≤256 字符 | User-Agent 包含该值，不区分大小写 |
| `referer` | query | string | 否 | ≤256 字符 | Referer 包含该值，不区分大小写 |
| `minDuration` | query | integer | 否 | 0–86400000 | 耗时不少于该毫秒数 |
| `limit` | query | integer | 否 | 1–1000，默认 `100` | 返回的条数 |

响应：`{ entries: [日志条目](#日志条目对象)[], truncated }`。`entries` 按时间从新到旧（时间相同时按 `id` 倒序）；符合条件的日志多于 `limit` 条时 `truncated` 为 `true`。

- 各筛选条件同时满足；省略的条件不筛选。
- `from` 早于保留期起点（UTC 当日 0 点往前 `retentionDays - 1` 天）时按起点计；`to` 晚于当前时间加 5 分钟时按当前时间加 5 分钟计；调整后 `from` 不早于 `to` 时返回空列表。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

### `logs.export`

`GET /sites/{siteId}/logs/export` · 读

参数同 [`logs.query`](#logsquery)。

响应：`{ csv, truncated }`。`csv` 为 [`logs.query`](#logsquery) 同一结果的 CSV 文本，`truncated` 同 `logs.query`。

- 第一行为列名，行以 CRLF 分隔。列依次为：`time`、`clientIp`、`method`、`host`、`path`、`status`、`bytesSent`、`durationMs`、`cacheStatus`、`sampleRate`、`nodeId`、`requestId`、`ja4`、`wafRuleIds`、`wafBlocked`、`ruleIds`、`userAgent`、`referer`、`httpVersion`、`scheme`、`country`、`asn`、`asName`、`upstreamAddr`、`upstreamStatus`、`upstreamMs`、`requestBytes`、`contentType`、`tlsVersion`、`blockReason`、`blockRuleId`、`query`、`headers`、`peerIp`。
- 每个单元格加双引号，内部的 `"` 写成 `""`；数组以空格连接；`headers` 写成 `名称: 值`，以 `; ` 连接；去掉开头空白后以 `=`、`+`、`@`、`-` 开头的单元格前加 `'`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

## 用量

- 每个网站、每个 UTC 5 分钟窗口 `[windowStart, windowEnd)` 一条[用量记录](#用量记录对象)，数值为该窗口内全部节点上报的分钟统计之和；只有收到过统计的窗口有记录。网站删除后它的记录保留。
- 后台每分钟重算有新统计的已结束窗口：数值变化时 `revision` 加 1 并分配新的 `seq`；数值不变时两者都不变。
- 记录保留 `retentionDays` 天（默认 100，35–400）；`completeUntil` 的离线阈值为 `offlineThresholdMinutes`（默认 60，5–1440）。两者由 `settings.usage` / `settings.setUsage` 读取与修改，见 [系统设置：用量](../../guide/system.md#用量)。

`completeUntil`（datetime 或 `null`，两个过程返回同一个值）：结束时间不晚于它的窗口已包含当时所有参与节点的统计；此后到达的这些窗口的统计以修订出现（`revision` 加 1）。

| 项目 | 规则 |
| --- | --- |
| 节点水位 | 节点在全部统计批次被确认后上报 `complete_until`：最近一次成功取出统计时所在分钟的开始，此前的分钟都已上报。节点因本地缓冲超出上限丢弃过统计时，水位停在丢弃的最早一分钟，24 小时后恢复。控制台把水位截到整分钟，最多比控制台时钟晚 1 分钟，只增不减 |
| 参与的节点 | 状态为 `active`（已启用）且最近 `offlineThresholdMinutes` 分钟内有心跳的节点；已停用、已删除或超过阈值没有心跳的节点不参与 |
| 每个节点的值 | 节点水位；从未上报水位的节点（旧版本节点）取注册时间（没有时取创建时间）；早于「当前时间 − `offlineThresholdMinutes`」的值按该时间计，因此一个节点最多使 `completeUntil` 落后阈值 |
| 计算 | 取当前时间、各参与节点的值与尚未重算的最早窗口开始（含当前窗口）中的最小值，向下取整到 5 分钟 |
| 单调 | 计算结果晚于已保存的值时才保存；`completeUntil` 只前移不后退 |
| 频率 | 后台每分钟重算窗口后计算一次 |
| `null` | 尚未计算过 |

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`usage.list`](#usagelist) | `GET /usage` | 读；服务账号 `usage:read` |
| [`usage.changes`](#usagechanges) | `GET /usage/changes` | 读；服务账号 `usage:read` |

### `usage.list`

`GET /usage` · 读 · 服务账号 `usage:read`

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `from` | query | datetime | 是 | 5 分钟的整数倍（Unix 时间） | 起始，含该时刻开始的窗口 |
| `to` | query | datetime | 是 | 5 分钟的整数倍，晚于 `from` | 结束，不含该时刻开始的窗口 |
| `siteId` | query | uuid | 否 | — | 只返回该网站的记录；已删除网站的 ID 同样可用 |
| `cursor` | query | string | 否 | ≤200 字符 | 上一页的 `nextCursor` |
| `limit` | query | integer | 否 | 1–5000，默认 `1000` | 每页条数 |

响应：`{ items: [用量记录](#用量记录对象)[], nextCursor, completeUntil }`。

- `items` 按（`windowStart`，`siteId`）升序。
- `nextCursor`：string，或 `null`（没有下一页）。游标记录本页最后一条记录的窗口与网站，下一页从其后开始；翻页时 `from`、`to`、`siteId` 保持不变。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `USAGE_RANGE_INVALID` | 400 | `from` 或 `to` 不是 5 分钟的整数倍，或 `to` 不晚于 `from` |
| `USAGE_CURSOR_INVALID` | 400 | `cursor` 无法解析 |

### `usage.changes`

`GET /usage/changes` · 读 · 服务账号 `usage:read`

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `afterSeq` | query | string | 否 | 十进制非负整数，无前导零，≤9223372036854775807，默认 `"0"` | 返回 `seq` 大于该值的记录；`"0"` 从头开始 |
| `limit` | query | integer | 否 | 1–5000，默认 `1000` | 返回的条数 |

响应：`{ items: [用量记录](#用量记录对象)[], lastSeq, completeUntil }`。

- `items` 为 `afterSeq` 之后创建或修订的记录，按 `seq` 升序；被修订的记录以新的 `seq` 再次出现。
- `lastSeq`：本次最后一条记录的 `seq`；没有记录时等于 `afterSeq`。下次以它作为 `afterSeq`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `USAGE_CURSOR_INVALID` | 400 | `afterSeq` 大于 9223372036854775807 |

## 审计日志

- 管理操作在变更的同一事务中写入审计日志；审计日志不自动清理。字段含义见 [审计日志](../../guide/system.md#审计日志)。
- 操作代码与对象类型的全部取值见 [审计操作](#审计操作)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`auditLogs.list`](#auditlogslist) | `GET /audit-logs` | 读 |
| [`auditLogs.facets`](#auditlogsfacets) | `GET /audit-logs/facets` | 读 |

### `auditLogs.list`

`GET /audit-logs` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `action` | query | string | 否 | 去首尾空白后 ≤100 字符 | 操作代码等于该值（如 `site.create`） |
| `targetType` | query | string | 否 | 去首尾空白后 ≤100 字符 | 对象类型等于该值（如 `site`） |
| `from` | query | datetime | 否 | — | `occurredAt` 不早于该时间 |
| `to` | query | datetime | 否 | — | `occurredAt` 不晚于该时间 |
| `limit` | query | integer | 否 | 1–200，默认 `50` | 每页条数 |
| `offset` | query | integer | 否 | ≥0，默认 `0` | 跳过的条数 |

响应：`{ items: [审计条目](#审计条目对象)[], total }`。`items` 从新到旧（按 `id` 倒序）；`total` 为符合筛选条件的条目总数。

- 各筛选条件同时满足；空字符串的 `action`、`targetType` 不筛选。
- `action`、`targetType` 不校验是否为已知取值，未知取值返回空列表。

### `auditLogs.facets`

`GET /audit-logs/facets` · 读

无参数。

响应：`{ actions, targetTypes }`，均为 `array<string>`：审计日志中出现过的操作代码与对象类型，去重后升序；`targetTypes` 不含空字符串。包括[审计操作](#审计操作)中已不存在的旧代码。

## 告警渠道

- 最多 32 个渠道。渠道配置（地址、令牌、密钥）用 `EDGEWEIR_MASTER_KEY` 加密保存，任何过程都不返回。
- `platform` 为 `true` 的渠道接收全部告警，含集群与 DNS 告警；其他渠道只接收[订阅](#告警订阅)范围内的告警。`locale` 为通知语言。
- SMTP 设置供 `email` 渠道使用。
- 行为见 [配置告警渠道](../../guide/alerts.md#配置告警渠道)、[短信渠道](../../guide/alerts.md#短信渠道)、[SMTP](../../guide/alerts.md#smtp) 与 [投递行为](../../guide/alerts.md#投递行为)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`alerts.channels`](#alertschannels) | `GET /alerts/channels` | 读 |
| [`alerts.createChannel`](#alertscreatechannel) | `POST /alerts/channels` | 写 |
| [`alerts.updateChannel`](#alertsupdatechannel) | `PUT /alerts/channels/{id}` | 写 |
| [`alerts.deleteChannel`](#alertsdeletechannel) | `DELETE /alerts/channels/{id}` | 写 |
| [`alerts.testChannel`](#alertstestchannel) | `POST /alerts/channels/{id}/test` | 写 |
| [`alerts.smtp`](#alertssmtp) | `GET /alerts/smtp` | 读 |
| [`alerts.setSmtp`](#alertssetsmtp) | `PUT /alerts/smtp` | 写 |

### `alerts.channels`

`GET /alerts/channels` · 读

无参数。

响应：array<[渠道](#渠道对象)>，按名称排列。

### `alerts.createChannel`

`POST /alerts/channels` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `name` | body | string | 是 | 去首尾空白后 1–100 字符 | 名称 |
| `enabled` | body | boolean | 否 | 默认 `true` | 启用 |
| `platform` | body | boolean | 否 | 默认 `false` | 接收全部告警 |
| `locale` | body | enum | 否 | `zh-CN` / `en`，默认 `zh-CN` | 通知语言 |
| `config` | body | object | 是 | 见[渠道配置](#渠道配置) | 渠道类型（`config.kind`）与其配置 |

响应：[渠道](#渠道对象)。审计 `alert.channel_create`（`kind`、`platform`）。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `ALERT_CHANNEL_LIMIT` | 409 | 已有 32 个渠道 |

### `alerts.updateChannel`

`PUT /alerts/channels/{id}` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 渠道 ID |
| `name` | body | string | 否 | 去首尾空白后 1–100 字符，省略时不变 | 名称 |
| `enabled` | body | boolean | 否 | 省略时不变 | 启用 |
| `platform` | body | boolean | 否 | 省略时不变 | 接收全部告警 |
| `locale` | body | enum | 否 | `zh-CN` / `en`，省略时不变 | 通知语言 |
| `config` | body | object | 否 | 见[渠道配置](#渠道配置)，省略时不变 | 整体替换配置，可改变渠道类型 |

响应：[渠道](#渠道对象)。

- 给出 `config` 时清空 `lastError`，该渠道投递失败（已用完尝试次数）的通知重新排队，尝试次数清零。
- 审计 `alert.channel_update`（`credentialsRotated`：是否给出 `config`；`previousKind`：修改前的类型）。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `ALERT_CHANNEL_NOT_FOUND` | 404 | 渠道不存在 |

### `alerts.deleteChannel`

`DELETE /alerts/channels/{id}` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 渠道 ID |

响应：`{ ok: true }`。渠道的订阅一并删除。审计 `alert.channel_delete`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `ALERT_CHANNEL_NOT_FOUND` | 404 | 渠道不存在 |

### `alerts.testChannel`

`POST /alerts/channels/{id}/test` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 渠道 ID |

响应：`{ ok: true }`。

- 立即发送一条测试通知（对象名称为 `Edgeweir`，状态为告警中），已停用的渠道同样发送；短信渠道的测试计入发送频率上限。
- 发送前审计 `alert.channel_test_request`，发送成功后审计 `alert.channel_test`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `ALERT_CHANNEL_NOT_FOUND` | 404 | 渠道不存在 |
| `ALERT_SMTP_NOT_CONFIGURED` | 412 | `email` 渠道，SMTP 未设置或没有密码 |
| `ALERT_RATE_LIMITED` | 429 | 短信渠道达到每小时或每天的发送上限；`data.retryAt` 为可再次发送的时间 |
| `ALERT_SMS_REJECTED` | 502 | 短信服务商拒绝发送；`data.code` 为服务商错误码 |
| `ALERT_SEND_FAILED` | 502 | 其他发送失败 |

### `alerts.smtp`

`GET /alerts/smtp` · 读

无参数。

响应：[SMTP 设置](#smtp-设置对象)，未设置时为 `null`。

### `alerts.setSmtp`

`PUT /alerts/smtp` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `host` | body | string | 是 | 去首尾空白后 1–253 字符 | SMTP 服务器 |
| `port` | body | integer | 否 | 1–65535，默认 `465` | 端口 |
| `secure` | body | boolean | 否 | 默认 `true` | `true`：连接即 TLS；`false`：要求 STARTTLS |
| `from` | body | string | 是 | 电子邮件地址 | 发件人 |
| `username` | body | string | 是 | 1–320 字符 | 用户名 |
| `password` | body | string | 否 | 1–4096 字符 | 密码；省略时沿用已保存的密码 |
| `ca` | body | string | 否 | 去首尾空白后 ≤65536 字符，默认 `""` | 只含 PEM 证书，替代系统信任库验证该服务器；空时使用 `EDGEWEIR_SMTP_CA_FILE` 或系统信任库 |

响应：`{ ok: true }`。

- 整体替换：省略的 `port`、`secure`、`ca` 取默认值。
- 没有已保存的密码，或 `host`、`port`、`secure`、`username`、`ca` 与已保存的不同时必须给出 `password`。
- 审计 `alert.smtp_update`（`host`、`credentialsRotated`：是否给出 `password`；`customCa`：`ca` 是否非空）。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SMTP_PASSWORD_REQUIRED` | 400 | 需要密码而未给出 `password` |
| `SMTP_CA_INVALID` | 400 | `ca` 非空且含 PEM 证书以外的内容，或有证书无法解析 |

## 告警规则

告警种类的触发与恢复见 [设置告警规则](../../guide/alerts.md#设置告警规则) 与 [集群与 DNS 告警](../../guide/alerts.md#集群与-dns-告警)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`alerts.policy`](#alertspolicy) | `GET /alerts/policy` | 读 |
| [`alerts.setPolicy`](#alertssetpolicy) | `PUT /alerts/policy` | 写 |

### `alerts.policy`

`GET /alerts/policy` · 读

无参数。

响应：[告警规则对象](#告警规则对象)。

### `alerts.setPolicy`

`PUT /alerts/policy` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `nodeOfflineSeconds` | body | integer | 否 | 45–3600，默认 `90` | 见[告警规则对象](#告警规则对象) |
| `certificateHours` | body | integer | 否 | 1–720，默认 `72` | 同上 |
| `errorRatio` | body | number | 否 | 0.01–1，默认 `0.2` | 同上 |
| `minimumRequests` | body | integer | 否 | 1–1000000，默认 `100` | 同上 |
| `windowMinutes` | body | integer | 否 | 1–60，默认 `5` | 同上 |
| `clockSkewSeconds` | body | integer | 否 | 5–3600，默认 `30` | 同上 |

响应：[告警规则对象](#告警规则对象)。

- 整体替换：省略的字段取默认值，不保留原值。
- 审计 `alert.policy_update`，元数据为保存的全部字段。

## 告警订阅

- 订阅属于运营者账户；每个渠道最多一条订阅。只能订阅[告警种类](#告警种类)中可订阅的 8 种。
- 行为见 [订阅告警](../../guide/alerts.md#订阅告警)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`alerts.subscriptions`](#alertssubscriptions) | `GET /alerts/subscriptions` | 读 |
| [`alerts.subscribe`](#alertssubscribe) | `POST /alerts/subscriptions` | 写 |
| [`alerts.updateSubscription`](#alertsupdatesubscription) | `PUT /alerts/subscriptions/{id}` | 写 |
| [`alerts.unsubscribe`](#alertsunsubscribe) | `DELETE /alerts/subscriptions/{id}` | 写 |

### `alerts.subscriptions`

`GET /alerts/subscriptions` · 读

无参数。

响应：array<[订阅](#订阅对象)>，按渠道名称排列。

### `alerts.subscribe`

`POST /alerts/subscriptions` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `channelId` | body | uuid | 是 | — | 渠道 ID |
| `kinds` | body | `array<enum>` | 是 | 1–8 个可订阅的[告警种类](#告警种类)，去重 | 发送的告警种类 |
| `allSites` | body | boolean | 否 | 默认 `false` | 全部网站，含以后新建的网站 |
| `siteIds` | body | `array<uuid>` | 否 | 最多 1000 个，默认 `[]` | 覆盖的网站 |
| `enabled` | body | boolean | 否 | 默认 `true` | 启用 |

`allSites` 为 `true` 与 `siteIds` 非空必须恰好满足一项，否则 400 `BAD_REQUEST`（`siteIds`）。

响应：[订阅](#订阅对象)。

- 渠道还没有订阅时创建；已有时替换它的告警种类、网站与 `enabled`，ID 不变。
- 审计 `alert.subscribe`（`channelId`、`kinds`、`allSites`、`siteIds`、`enabled`）。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `ALERT_CHANNEL_NOT_FOUND` | 404 | 渠道不存在或已停用 |
| `SITE_NOT_FOUND` | 404 | `siteIds` 中有网站不存在 |

### `alerts.updateSubscription`

`PUT /alerts/subscriptions/{id}` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 订阅 ID |
| `kinds` | body | `array<enum>` | 是 | 1–8 个可订阅的[告警种类](#告警种类)，去重 | 发送的告警种类 |
| `allSites` | body | boolean | 否 | 默认 `false` | 全部网站，含以后新建的网站 |
| `siteIds` | body | `array<uuid>` | 否 | 最多 1000 个，默认 `[]` | 覆盖的网站 |
| `enabled` | body | boolean | 否 | 默认 `true` | 启用 |

`allSites` 为 `true` 与 `siteIds` 非空必须恰好满足一项，否则 400 `BAD_REQUEST`（`siteIds`）。

响应：[订阅](#订阅对象)。

- 整体替换：省略的 `allSites`、`siteIds`、`enabled` 取默认值。渠道不能修改。
- 审计 `alert.subscription_update`（字段同 `alert.subscribe`）。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `ALERT_SUBSCRIPTION_NOT_FOUND` | 404 | 订阅不存在 |
| `SITE_NOT_FOUND` | 404 | `siteIds` 中有网站不存在 |

### `alerts.unsubscribe`

`DELETE /alerts/subscriptions/{id}` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 订阅 ID |

响应：`{ ok: true }`。审计 `alert.unsubscribe`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `ALERT_SUBSCRIPTION_NOT_FOUND` | 404 | 订阅不存在 |

## 告警事件

- 同一条件进入告警与恢复时各产生一个事件；事件保留 90 天。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`alerts.events`](#alertsevents) | `GET /alerts/events` | 读 |

### `alerts.events`

`GET /alerts/events` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `siteId` | query | uuid | 否 | — | 只返回该网站的告警，以及该网站所在集群的节点的 `node_offline`、`node_clock_skew` |

响应：array<[告警事件](#告警事件对象)>，按发生时间从新到旧，最多 100 条。省略 `siteId` 时为集群与 DNS 告警、节点告警与现存网站的告警。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | `siteId` 的网站不存在 |

## 对象

### 配置版本对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `clusterId` | uuid | 集群 ID |
| `revision` | integer | 版本号 |
| `contentHash` | string | 配置内容的哈希 |
| `siteCount` | integer | 版本包含的网站数 |
| `reason` | string | 发布原因的英文文本 |
| `reasonCode` | string | 原因码；原因码出现之前发布的版本为空 |
| `reasonParams` | object | 原因参数，值为 string 或 number |
| `createdAt` | datetime | 发布时间 |

### 待处理事项对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `kind` | enum | 事项，取值见下表 |
| `clusterId` | uuid | 集群 ID |
| `clusterName` | string | 集群名称 |
| `revision` | integer 或 `null` | 见下表；不适用时为 `null` |
| `at` | datetime 或 `null` | 见下表；不适用时为 `null` |
| `count` | integer | 节点数；不适用时为 `0` |
| `version` | string | 目标版本；不适用时为空字符串 |

`kind` 按以下顺序排列：

| `kind` | 条件 | 字段 |
| --- | --- | --- |
| `nodes_unhealthy` | 已启用且连接过的节点离线、应用配置失败、证书被拒，或应用过配置后数据面不健康 | `count` |
| `dns_failed` | 集群的 DNS 绑定不是关闭状态，最近的 DNS 版本发布失败 | `revision`：DNS 版本 |
| `dns_blocked` | DNS 发布被大面积摘除保护拦截 | — |
| `upgrade_failed` | 集群最近一次节点升级失败或有节点升级失败，且在 24 小时内 | `version` |
| `canary_rolled_back` | 配置金丝雀在 24 小时内回滚 | `revision`：候选版本；`at`：回滚时间 |
| `canary_awaiting_promotion` | 配置金丝雀待推进 | `revision`：候选版本 |
| `canary_running` | 配置金丝雀观察中 | `revision`：候选版本；`at`：观察窗口结束时间（窗口尚未开始时为 `null`） |
| `nodes_lagging` | 已启用、在线且健康的节点落后于目标版本，或需要升级才能运行目标版本 | `count` |
| `nodes_no_address` | 集群的 DNS 绑定不是关闭状态，已启用且在线的节点没有可用于 DNS 的公网地址 | `count` |

各事项的判定见 [待处理](../../guide/overview.md#待处理)。

### 流量计数

[流量对象](#流量对象)的每个点与汇总都含以下字段（全部为 integer），为全部节点与所选网站之和：

| 字段 | 说明 |
| --- | --- |
| `requests` | 请求数 |
| `bytesSent` | 发送字节数 |
| `bytesReceived` | 接收字节数 |
| `cacheHits` | 缓存命中数 |
| `cacheMisses` | 缓存未命中数 |
| `status2xx`、`status3xx`、`status4xx`、`status5xx` | 各状态码类别的响应数 |

### 流量对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `range` | enum | 请求的 `range` |
| `bucketSeconds` | integer | 每个点的宽度（秒） |
| `from` | datetime | 第一个桶的开始 |
| `to` | datetime | 当前时间 |
| `points` | `array<object>` | 每个桶一个点，从旧到新：`time`（datetime，桶的开始）与[流量计数](#流量计数)；没有统计的桶各计数为 0 |
| `totals` | object | 范围内的[流量计数](#流量计数)之和，另有 `peakBytesPerSecond`（number）：发送字节最多的桶的每秒字节数 |
| `previous` | object | `from` 之前等长时段的汇总，字段同 `totals` |

### 排行项对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 网站或节点 ID |
| `name` | string | 网站或节点名称 |
| `parentId` | string | 所在集群的 ID |
| `parentName` | string | 所在集群的名称 |
| `requests` | integer | 请求数 |
| `bytesSent` | integer | 发送字节数 |
| `cacheHits` | integer | 缓存命中数 |
| `cacheMisses` | integer | 缓存未命中数 |

### 分解对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `range` | enum | 请求的 `range` |
| `bucketSeconds` | integer | 桶宽（秒） |
| `from` | datetime | 第一个桶的开始 |
| `to` | datetime | 当前时间 |
| `times` | `array<datetime>` | 每个桶的开始，从旧到新 |
| `items` | `array<object>` | 排名靠前的项，从大到小，字段见下表 |
| `total` | integer | 分解范围内的指标总量 |
| `totalSeries` | `array<integer>` | 每个桶的指标总量，与 `times` 对齐 |

`items` 的元素：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 网站或节点 ID、状态码（如 `"404"`）或拦截原因（如 `"cc"`） |
| `name` | string | 网站或节点名称；状态码与拦截原因同 `id` |
| `parentId` | string 或 `null` | 网站或节点所在集群的 ID；状态码与拦截原因为 `null` |
| `parentName` | string 或 `null` | 所在集群的名称；状态码与拦截原因为 `null` |
| `total` | integer | 该项在范围内的指标总量 |
| `series` | `array<integer>` | 该项每个桶的值，与 `times` 对齐 |

### 统计维度对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `countries` | `array<object>` | `{ country, requests, bytesSent }`，按请求数从多到少，最多 250 个；`country` 为 ISO 3166-1 alpha-2，空字符串表示未知 |
| `asns` | `array<object>` | `{ asn, name, requests }`，客户端网络，最多 50 个，近似值；`name` 未知时为空字符串 |
| `referers` | `array<object>` | `{ host, requests }`，来源主机，最多 50 个，近似值 |
| `browsers` | `array<object>` | `{ key, requests }`，浏览器 |
| `oses` | `array<object>` | `{ key, requests }`，操作系统 |
| `devices` | `array<object>` | `{ key, requests }`，设备 |
| `httpVersions` | `array<object>` | `{ key, requests }`，HTTP 版本 |
| `tlsVersions` | `array<object>` | `{ key, requests }`，TLS 版本 |
| `blockReasons` | `array<object>` | `{ key, requests }`，拦截原因 |
| `challenges` | object | `{ issued, passed }`：发出与通过的挑战数 |
| `unsupportedNodes` | integer | 不支持 `stats-dims-v1` 的已启用节点数（给出 `siteId` 时为该网站所在集群的节点，否则为全部节点）；大于 0 时各维度不完整 |

数组只含请求数大于 0 的键，按请求数从多到少，相同时按键排列。`key` 的取值：

| 维度 | 取值 |
| --- | --- |
| `browsers` | `chrome`、`edge`、`firefox`、`safari`、`opera`、`samsung`、`uc`、`qq`、`wechat`、`yandex`、`ie`、`crawler`、`tool`、`other` |
| `oses` | `windows`、`macos`、`ios`、`android`、`linux`、`chromeos`、`harmonyos`、`other` |
| `devices` | `desktop`、`mobile`、`tablet`、`crawler`、`other` |
| `httpVersions` | `1.0`、`1.1`、`2`、`3`、`other` |
| `tlsVersions` | `1.2`、`1.3`、`none`、`other` |
| `blockReasons` | `ip_banned`、`ip_blocked`、`rule`、`rate_limit`、`crs`、`cc`、`challenge`、`auth`、`referer`、`user_agent`、`region`、`cors`、`websocket_origin`、`client_cert`、`maintenance` |

拦截原因的含义见 [拦截原因](../../guide/access-logs.md#拦截原因)。

### 日志设置对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `sampleRate` | integer | 采样率，单位为万分之一（0–10000） |
| `storage` | enum | `lite` / `clickhouse`：当前存储 |
| `retentionDays` | integer | 当前存储的保留天数 |
| `logBlocked` | boolean | 被拦截、被挑战与鉴权拒绝的请求总是记录 |
| `logQuery` | boolean | 记录查询字符串 |
| `logHeaders` | `array<string>` | 记录的请求头名称（小写） |
| `logPeer` | boolean | 连接对端地址与客户端地址不同时记录对端地址 |

### 日志条目对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 日志 ID：`<节点 ID>/<批次序号>/<批内序号>` |
| `time` | datetime | 请求时间 |
| `nodeId` | string | 节点 ID |
| `siteId` | string | 网站 ID |
| `clientIp` | string | 客户端 IP |
| `method` | string | 方法 |
| `host` | string | Host（≤253 字符） |
| `path` | string | 路径，不含查询字符串与片段（≤2048 字符） |
| `status` | integer | 状态码 |
| `bytesSent` | integer | 发送字节数 |
| `durationMs` | integer | 耗时（毫秒） |
| `cacheStatus` | string | `HIT`、`MISS`、`BYPASS`、`EXPIRED`、`STALE`、`UPDATING`、`REVALIDATED` 或空字符串 |
| `sampleRate` | integer | 写入这行时的采样率（万分之一，1–10000） |
| `ja4` | string | JA4 TLS 客户端指纹；网站未记录时为空 |
| `wafRuleIds` | `array<integer>` | 请求匹配的 OWASP CRS 规则，升序，最多 16 个 |
| `wafBlocked` | boolean | CRS 拦截了请求 |
| `requestId` | string | 节点响应的请求 ID（`X-Request-Id`）；旧版本节点为空 |
| `ruleIds` | `array<string>` | 不受采样率限制写入这行的日志规则，最多 8 个 |
| `userAgent` | string | User-Agent（≤512 字符） |
| `referer` | string | Referer，不含查询字符串与片段（≤1024 字符） |
| `httpVersion` | string | `1.0`、`1.1`、`2`、`3` 或空字符串 |
| `scheme` | string | `http`、`https` 或空字符串 |
| `country` | string | 客户端国家或地区（ISO 3166-1 alpha-2）；未知时为空 |
| `asn` | integer | 客户端网络的 AS 号；未知时为 `0` |
| `asName` | string | AS 名称 |
| `upstreamAddr` | string | 应答的源站地址；未回源时为空 |
| `upstreamStatus` | integer | 源站状态码；未回源时为 `0` |
| `upstreamMs` | integer | 源站耗时（毫秒）；未回源时为 `0` |
| `requestBytes` | integer | 请求字节数 |
| `contentType` | string | 响应的媒体类型，小写，不含参数 |
| `tlsVersion` | string | `1.2`、`1.3`；明文 HTTP 为空 |
| `blockReason` | string | [拦截原因](#统计维度对象)；未拦截时为空 |
| `blockRuleId` | string | 拦截原因对应的规则（WAF、限速或访问鉴权规则）ID；没有时为空 |
| `query` | string | 查询字符串（不含 `?`）；网站开启 `logQuery` 时记录 |
| `headers` | object | 记录的请求头（小写名称 → 值）；网站设置 `logHeaders` 时记录 |
| `peerIp` | string | 与 `clientIp` 不同的连接对端地址；网站开启 `logPeer` 时记录 |

### 用量记录对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | `<siteId>.<windowStart 的 Unix 秒>`；同一网站同一窗口固定不变 |
| `siteId` | uuid | 网站 ID；网站删除后保留 |
| `windowStart` | datetime | 窗口开始（UTC，5 分钟对齐） |
| `windowEnd` | datetime | 窗口结束（`windowStart` 加 5 分钟） |
| `requests` | string | 请求数，十进制整数字符串（超过 2^53 时仍精确） |
| `bytesSent` | string | 发送字节数，十进制整数字符串 |
| `bytesReceived` | string | 接收字节数，十进制整数字符串 |
| `revision` | integer | 从 1 开始；重算后数值变化时加 1 |
| `seq` | string | 十进制整数字符串；全局递增（可有间隔），创建或修订时分配 |
| `updatedAt` | datetime | 最近一次写入时间 |

### 审计条目对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | integer | 条目 ID，按写入顺序递增 |
| `occurredAt` | datetime | 操作时间 |
| `actorType` | string | `user`、`api_key`、`service_account`、`node`、`probe` 或 `system` |
| `actorId` | string | 操作者 ID；`system` 为空 |
| `actorName` | string | 操作时记录的操作者名称；没有记录名称的旧条目为用户或节点的当前名称，查不到时为空 |
| `ip` | string | 请求的客户端地址；不经请求的操作为空 |
| `userAgent` | string | 请求的 User-Agent；不经请求的操作为空 |
| `action` | string | 操作代码，见[审计操作](#审计操作) |
| `targetType` | string | 对象类型，见[审计操作](#审计操作)；没有对象时为空 |
| `targetId` | string | 对象 ID |
| `targetName` | string | 操作时记录的对象名称；没有记录名称的旧条目为用户、节点、网站或集群的当前名称，查不到时为空 |
| `metadata` | object | 操作相关的参数与前后值 |

### 审计操作

当前写入的操作代码（`action`）：

| 前缀 | 操作 |
| --- | --- |
| `account` | `account.passkey_add`、`account.passkey_delete`、`account.password_change`、`account.recover`、`account.two_factor_disable`、`account.two_factor_enable` |
| `acme_account` | `acme_account.delete` |
| `alert` | `alert.channel_create`、`alert.channel_delete`、`alert.channel_test`、`alert.channel_test_request`、`alert.channel_update`、`alert.policy_update`、`alert.smtp_update`、`alert.subscribe`、`alert.subscription_update`、`alert.unsubscribe` |
| `api_key` | `api_key.create`、`api_key.revoke`、`api_key.update` |
| `auth` | `auth.sign_in`、`auth.sign_in_failed` |
| `ban` | `ban.create`、`ban.delete`、`ban.update` |
| `cache` | `cache.prefetch`、`cache.purge` |
| `certificate` | `certificate.delete`、`certificate.issued`、`certificate.names_extended`、`certificate.renew`、`certificate.renewal_rescheduled`、`certificate.request`、`certificate.unloadable`、`certificate.upload` |
| `cluster` | `cluster.cache_update`、`cluster.challenge_keys_rotate`、`cluster.client_ip_update`、`cluster.connection_limits_update`、`cluster.create`、`cluster.delete`、`cluster.listen_ports_update`、`cluster.port_pools_update`、`cluster.rollback`、`cluster.rollout_abort`、`cluster.rollout_direct`、`cluster.rollout_policy_update`、`cluster.rollout_promote`、`cluster.rollout_rollback`、`cluster.session_ticket_keys_rotate`、`cluster.unknown_hosts_update`、`cluster.update` |
| `dns` | `dns.applied`、`dns.binding_update`、`dns.force_publish`、`dns.protection_update`、`dns.provider_create`、`dns.provider_delete`、`dns.provider_update`、`dns.rollback` |
| `dns_credential` | `dns_credential.create`、`dns_credential.delete`、`dns_credential.update` |
| `enrollment_token` | `enrollment_token.create` |
| `greylist` | `greylist.create`、`greylist.delete`、`greylist.update` |
| `ip_list` | `ip_list.create`、`ip_list.delete`、`ip_list.update` |
| `l4` | `l4.cname_update` |
| `l4_app` | `l4_app.create`、`l4_app.delete`、`l4_app.disable`、`l4_app.enable`、`l4_app.update` |
| `node` | `node.cache_update`、`node.certificate_renew`、`node.debug_logs_pull`、`node.delete`、`node.disable`、`node.enable`、`node.enroll`、`node.move`、`node.set_addresses`、`node.set_probe`、`node.update`、`node.upgrade_cancel`、`node.upgrade_create`、`node.upgrade_promote`、`node.upgrade_result` |
| `node_group` | `node_group.create`、`node_group.delete`、`node_group.update` |
| `origin_ca` | `origin_ca.create`、`origin_ca.retire`、`origin_ca.rotation_cancel`、`origin_ca.rotation_start` |
| `origin_certificate` | `origin_certificate.issue`、`origin_certificate.revoke` |
| `origin_client_ca` | `origin_client_ca.activate`、`origin_client_ca.create`、`origin_client_ca.retire`、`origin_client_ca.rotation_cancel`、`origin_client_ca.rotation_start` |
| `origin_client_certificate` | `origin_client_certificate.rotate` |
| `platform` | `platform.rule_restore`、`platform.rules_update` |
| `probe` | `probe.certificate_renew`、`probe.delete`、`probe.enroll`、`probe.token_create`、`probe.update` |
| `region` | `region.create`、`region.delete`、`region.update` |
| `scheduling` | `scheduling.activate`、`scheduling.recover`、`scheduling.rule_create`、`scheduling.rule_delete`、`scheduling.rule_update` |
| `service_account` | `service_account.create`、`service_account.delete`、`service_account.key_create`、`service_account.key_revoke`、`service_account.update` |
| `site` | `site.access_control_update`、`site.auth_identity_forget`、`site.auth_sign_url`、`site.auth_update`、`site.auto_mitigation_apply`、`site.auto_mitigation_release`、`site.auto_mitigation_restore`、`site.auto_mitigation_update`、`site.bulk_redirects_update`、`site.clone`、`site.cname_update`、`site.create`、`site.delete`、`site.disable`、`site.enable`、`site.error_pages_update`、`site.https_update`、`site.image_convert_update`、`site.logs_configure`、`site.maintenance_update`、`site.protection_update`、`site.purge_all`、`site.rule_restore`、`site.rules_update`、`site.settings_copied`、`site.tags_update`、`site.update`、`site.usage_guard_apply`、`site.usage_guard_delete`、`site.usage_guard_release`、`site.usage_guard_restore`、`site.usage_guard_update`、`site.waf_update` |
| `site_tag` | `site_tag.delete`、`site_tag.rename` |
| `system` | `system.acme_directory_update`、`system.bans_update`、`system.cc_template_update`、`system.demo_update`、`system.error_pages_update`、`system.log_retention_update`、`system.login_allow_list_update`、`system.node_channel_update`、`system.node_log_retention_update`、`system.origin_allow_list_update`、`system.probes_update`、`system.protection_update`、`system.recompile`、`system.release_source_update`、`system.setup`、`system.setup_rejected`、`system.usage_update` |

对象类型（`targetType`）：`acme_account`、`alert_channel`、`alert_subscription`、`api_key`、`ban`、`cache_task`、`certificate`、`certificate_authority`、`cluster`、`dns_credential`、`dns_provider`、`greylist`、`ip_list`、`l4_app`、`node`、`node_group`、`node_upgrade`、`origin_certificate`、`origin_client_certificate`、`platform`、`probe`、`region`、`scheduling_rule`、`service_account`、`site`、`site_tag`、`system`、`system_setting`、`user`。

较早的条目可能含不在上表中的代码。

### 渠道对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 渠道 ID |
| `name` | string | 名称 |
| `kind` | string | 渠道类型，见[渠道配置](#渠道配置) |
| `enabled` | boolean | 启用 |
| `platform` | boolean | 接收全部告警 |
| `locale` | enum | `zh-CN` / `en`：通知语言 |
| `lastError` | string | 最近一次投递失败的原因：`alert_send_failed`、`alert_smtp_not_configured`、`alert_rate_limited` 或 `alert_sms_rejected:<服务商错误码>`；投递成功或替换 `config` 后为空 |

### 渠道配置

`config.kind` 决定其余字段：

| `kind` | 字段 | 类型 | 必填 | 约束与默认值 |
| --- | --- | --- | --- | --- |
| `webhook` | `url` | string | 是 | `http` 或 `https` URL，≤4096 字符，不含用户名、密码与片段 |
| `webhook` | `bearer` | string | 否 | ≤4096 字符；作为 Bearer 令牌发送 |
| `email` | `to` | `array<string>` | 是 | 1–20 个电子邮件地址 |
| `dingtalk` | `url` | string | 是 | 同 `webhook.url`，主机须为 `oapi.dingtalk.com` |
| `dingtalk` | `secret` | string | 否 | ≤4096 字符；加签密钥 |
| `wecom` | `url` | string | 是 | 同 `webhook.url`，主机须为 `qyapi.weixin.qq.com` |
| `telegram` | `token` | string | 是 | 机器人令牌：`<数字>:<20–200 个字母、数字、_、->` |
| `telegram` | `chatId` | string | 是 | 可带 `-` 的 1–24 位数字，或 `@` 加以字母开头的 5–32 个字母、数字、`_` |
| `aliyun_sms` | `accessKeyId` | string | 是 | 1–128 个字母或数字 |
| `aliyun_sms` | `accessKeySecret` | string | 是 | 1–256 字符 |
| `aliyun_sms` | `signName` | string | 是 | 去首尾空白后 1–64 字符；短信签名 |
| `aliyun_sms` | `templateCode` | string | 是 | 1–64 个字母、数字、`_` |
| `aliyun_sms` | `maxParamLength` | integer | 否 | 1–100，默认 `35`；每个模板变量的最大字符数 |
| `tencent_sms` | `secretId` | string | 是 | 1–128 个字母或数字 |
| `tencent_sms` | `secretKey` | string | 是 | 1–256 字符 |
| `tencent_sms` | `sdkAppId` | string | 是 | 1–20 位数字 |
| `tencent_sms` | `region` | enum | 否 | `ap-guangzhou` / `ap-beijing` / `ap-nanjing`，默认 `ap-guangzhou` |
| `tencent_sms` | `signName` | string | 是 | 去首尾空白后 1–64 字符；短信签名 |
| `tencent_sms` | `templateId` | string | 是 | 1–20 位数字 |
| `tencent_sms` | `maxParamLength` | integer | 否 | 1–100，默认 `6`；每个模板变量的最大字符数 |
| `aliyun_sms`、`tencent_sms` | `phoneNumbers` | `array<string>` | 是 | 1–20 个，每个为可带 `+` 的 5–15 位数字（E.164；中国大陆号码可省略 `+86`） |
| `aliyun_sms`、`tencent_sms` | `hourlyLimit` | integer | 否 | 1–100，默认 `10`；滑动 1 小时内最多发送次数（含测试） |
| `aliyun_sms`、`tencent_sms` | `dailyLimit` | integer | 否 | 1–1000，默认 `50`；滑动 24 小时内最多发送次数（含测试） |

### 告警种类

| 值 | 名称 | 对象 | 可订阅 |
| --- | --- | --- | --- |
| `node_offline` | 节点离线 | 节点 | 是 |
| `node_clock_skew` | 节点时钟偏差过大 | 节点 | 是 |
| `certificate_expiring` | 证书即将到期 | 网站 | 是 |
| `origin_unavailable` | 源站不可用 | 网站 | 是 |
| `high_5xx` | 服务端错误率过高 | 网站 | 是 |
| `cc_mitigation` | CC 防护升级 | 网站 | 是 |
| `usage_warning` | 用量接近上限 | 网站 | 是 |
| `usage_limit` | 用量达到上限 | 网站 | 是 |
| `config_rollout_failed` | 配置金丝雀发布已回滚 | 集群 | 否 |
| `config_rollout_no_canary` | 没有在线的金丝雀节点，配置已直接发布到全部节点 | 集群 | 否 |
| `config_rule_invalid` | 已存规则不再通过校验，沿用上次编译结果 | 规则 | 否 |
| `dns_mass_removal_blocked` | DNS 大面积摘除已阻止 | 集群 | 否 |
| `scheduling_action` | 智能调度规则已作用于节点 | 调度规则与节点 | 否 |
| `certificate_unloadable` | 节点无法加载证书 | 证书 | 否 |
| `dns_reconcile_failed` | DNS 对账持续失败 | 集群 | 否 |

不可订阅的种类只投递到 `platform` 为 `true` 的渠道。用量告警见 [用量保护：告警](../../guide/usage-protection.md#告警)。

### 告警规则对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `nodeOfflineSeconds` | integer | 已启用节点超过该秒数没有心跳，或上报数据面不健康时触发 `node_offline`；注册不足该时长的节点不检查。也是源站健康与时钟偏差上报的有效期 |
| `certificateHours` | integer | 网站当前证书在该小时数内到期时触发 `certificate_expiring` |
| `errorRatio` | number | 窗口内 5xx 响应占请求数的比例达到该值（小数，`0.2` 即 20%）时触发 `high_5xx` |
| `minimumRequests` | integer | 窗口内请求数达到该值才检查 `high_5xx` |
| `windowMinutes` | integer | `high_5xx` 的统计窗口（分钟） |
| `clockSkewSeconds` | integer | 节点上报的时钟偏差（快或慢）达到该秒数时触发 `node_clock_skew` |

### SMTP 设置对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `host` | string | SMTP 服务器 |
| `port` | integer | 端口 |
| `secure` | boolean | `true`：连接即 TLS；`false`：要求 STARTTLS |
| `from` | string | 发件人 |
| `username` | string | 用户名 |
| `ca` | string | 保存的 PEM 证书；空时使用 `EDGEWEIR_SMTP_CA_FILE` 或系统信任库 |
| `caFile` | boolean | 设置了 `EDGEWEIR_SMTP_CA_FILE` |

密码不返回。

### 订阅对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 订阅 ID |
| `channelId` | uuid | 渠道 ID |
| `channelName` | string | 渠道名称 |
| `kinds` | `array<enum>` | 发送的[告警种类](#告警种类) |
| `enabled` | boolean | 启用；停用的订阅不发送 |
| `allSites` | boolean | 全部网站，含以后新建的网站；此时 `sites` 为 `[]` |
| `sites` | `array<object>` | 覆盖的网站 `{ id, name }`，按名称排列；已删除的网站不在其中 |

### 告警事件对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 事件 ID |
| `siteId` | uuid 或 `null` | 网站 ID；节点告警与集群、DNS 告警为 `null` |
| `kind` | enum | [告警种类](#告警种类) |
| `status` | enum | `firing`（告警中）/ `resolved`（已恢复） |
| `occurredAt` | datetime | 发生时间 |
| `siteName` | string | 网站名称；节点告警为节点名称，集群与 DNS 告警为告警对象的名称（集群、规则、证书等） |
