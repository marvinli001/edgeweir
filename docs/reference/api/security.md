# API：访问控制

网站规则、全局规则、批量重定向、IP 名单、IP 检查、封禁、灰名单、挑战与 CC 防护以及 OWASP CRS 的过程。

权限级别、认证、幂等键与错误格式见 [API 概览](../api.md)。

## 网站规则

- 保存与恢复发布网站所在集群的配置版本（原因 `rules_updated`），审计 `site.rules_update`、`site.rule_restore`（元数据含规则数 `count`；恢复另含规则 `{ id, name }` 与 `version`）。
- 每次保存为新增、修改或删除的规则各记一个版本；只调整顺序不记版本。每条规则保留最近 50 个版本，每个网站保留最近删除的 100 条规则。
- 规则对象与动作见[规则对象](#规则对象)、[规则动作](#规则动作)；表达式语言见[表达式](../../guide/rules.md#表达式)；行为见[规则、IP 名单与 GeoIP](../../guide/rules.md)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`rules.get`](#rulesget) | `GET /sites/{id}/rules` | 读 |
| [`rules.save`](#rulessave) | `PUT /sites/{id}/rules` | 写 |
| [`rules.versions`](#rulesversions) | `GET /sites/{id}/rules/{ruleId}/versions` | 读 |
| [`rules.deleted`](#rulesdeleted) | `GET /sites/{id}/rules/deleted` | 读 |
| [`rules.restore`](#rulesrestore) | `POST /sites/{id}/rules/{ruleId}/restore` | 写 |
| [`rules.topLogged`](#rulestoplogged) | `GET /sites/{id}/rules/logged` | 读 |
| [`rules.validate`](#rulesvalidate) | `POST /rules/validate` | 读 |

### `rules.get`

`GET /sites/{id}/rules` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |

响应：[规则](#规则对象)[]，按保存顺序。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

### `rules.save`

`PUT /sites/{id}/rules` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |
| `rules` | body | array<[规则](#规则对象)> | 是 | 最多 64 条；`ban` 动作的 `banScope` 只能为 `site` | 整体替换网站的全部规则，按数组顺序执行 |

规则的 `id` 是该网站已有规则的 ID 时保留，否则（省略或来自其他网站）重新生成。

响应：保存后的[规则](#规则对象)[]，带 `id`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |
| `RULE_INVALID` | 400 | 两条规则的 `id` 相同；`origin` 动作的 `originGroup` 不是网站的源站组；网站已保存的规则或缓存规则条件无法编译 |
| `ORIGIN_HOST_HEADER_INVALID` | 400 | `origin` 动作的 `hostHeader` 不是节点接受的主机名或 IP；`data.hostHeader` |
| `IP_LIST_REFERENCE_UNKNOWN` | 404 | 表达式引用的 IP 名单不存在；`data.lists` 为前 5 个名称，逗号分隔 |

### `rules.versions`

`GET /sites/{id}/rules/{ruleId}/versions` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |
| `ruleId` | path | uuid | 是 | — | 规则 ID，含已删除的规则 |

响应：[规则版本](#规则版本对象)[]，版本号大的在前。规则不属于该网站或没有版本时为空数组。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

### `rules.deleted`

`GET /sites/{id}/rules/deleted` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |

响应：[规则版本](#规则版本对象)[]，每条已删除规则的最后一个版本（`change` 为 `deleted`，`rule` 为删除前的内容），最近删除的在前。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

### `rules.restore`

`POST /sites/{id}/rules/{ruleId}/restore` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |
| `ruleId` | path | uuid | 是 | — | 规则 ID |
| `version` | body | integer | 是 | ≥1 | 该规则保留的版本号 |

把该版本保存为规则：规则存在时原位替换内容；已删除时沿用原 `id` 加到同阶段最后一条规则之后（该阶段没有规则时加到末尾）。版本按当前的规则检查校验。新版本的 `source` 为 `restore`，`restoredFrom` 为 `version`。

响应：恢复后网站的全部[规则](#规则对象)[]。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |
| `RULE_VERSION_NOT_FOUND` | 404 | 该网站没有保留这个规则版本（已清除，或属于其他网站） |
| `RULE_INVALID` | 400 | 版本内容不再通过规则检查；规则 ID 已被其他规则使用；源站组不存在；网站已保存的规则无法编译 |
| `RULE_LIMIT_REACHED` | 400 | 恢复已删除的规则会超过 64 条；`data.limit` |
| `ORIGIN_HOST_HEADER_INVALID` | 400 | `origin` 动作的 `hostHeader` 无效；`data.hostHeader` |
| `IP_LIST_REFERENCE_UNKNOWN` | 404 | 表达式引用的 IP 名单不存在；`data.lists` |

### `rules.topLogged`

`GET /sites/{id}/rules/logged` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |
| `range` | query | enum | 否 | `1h` / `6h` / `24h` / `7d` / `30d`，默认 `24h` | 时间范围 |
| `limit` | query | integer | 否 | 1–50，默认 `10` | 返回的规则数 |

网站规则与全局规则中 `log` 动作命中的请求数，来自节点的每分钟计数（每个节点每个网站每分钟最多 20 条规则），为近似值。

响应：`{ approximate: true, items, unsupportedNodes }`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `items[].ruleId` | uuid | 规则 ID |
| `items[].name` | string 或 `null` | 规则当前的名称；规则已删除时为 `null` |
| `items[].platform` | boolean | 是否为全局规则 |
| `items[].requests` | number | 命中的请求数，按此降序 |
| `unsupportedNodes` | integer | 网站所在集群中不上报命中（缺少节点能力 `rule-log-v1`）的活动节点数 |

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

### `rules.validate`

`POST /rules/validate` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `expression` | body | string | 是 | 最长 16384 字符 | 要检查的表达式 |
| `phase` | body | enum | 是 | 规则阶段之一，见[规则对象](#规则对象) | 表达式所在的阶段；`kind` 为 `cacheRule` 时忽略，但仍须填写 |
| `kind` | body | enum | 否 | `condition` / `value` / `cacheRule`，默认 `condition` | `condition`：规则条件；`value`：值表达式（重定向目标、改写路径、请求头与响应头的值、查询参数的值）；`cacheRule`：缓存规则条件 |

响应：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `valid` | boolean | 表达式是否有效 |
| `position` | integer | 出错的字符位置（从 0 计）；有效时为 `0` |
| `message` | string | 英文原因；有效时为空 |
| `code` | enum | 仅无效时：稳定的原因代码，如 `unknown_field`、`expected_token`、`ordered_comparison`；全部取值见 OpenAPI 文档 |
| `params` | object | 仅无效时：原因中的值（字符串到字符串），如 `expected_token` 的 `token` |

## 全局规则

全局规则作用于所有集群的全部网站，在每个阶段先于网站规则执行。

- 保存与恢复发布所有集群的配置版本（原因 `rules_updated`），审计 `platform.rules_update`、`platform.rule_restore`。
- 版本保留与[网站规则](#网站规则)相同：每条规则 50 个版本，最近删除的 100 条规则。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`platformRules.get`](#platformrulesget) | `GET /platform-rules` | 读 |
| [`platformRules.save`](#platformrulessave) | `PUT /platform-rules` | 写 |
| [`platformRules.versions`](#platformrulesversions) | `GET /platform-rules/{ruleId}/versions` | 读 |
| [`platformRules.deleted`](#platformrulesdeleted) | `GET /platform-rules/deleted` | 读 |
| [`platformRules.restore`](#platformrulesrestore) | `POST /platform-rules/{ruleId}/restore` | 写 |

### `platformRules.get`

`GET /platform-rules` · 读

无参数。

响应：[规则](#规则对象)[]，按保存顺序。

### `platformRules.save`

`PUT /platform-rules` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `rules` | body | array<[规则](#规则对象)> | 是 | 最多 32 条 | 整体替换全部全局规则 |

规则的 `id` 是已有全局规则的 ID 时保留，否则重新生成。全局规则的 `ban` 动作可用 `banScope: "platform"`；`origin` 动作不能选择源站组。

响应：保存后的[规则](#规则对象)[]。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `RULE_INVALID` | 400 | 两条规则的 `id` 相同；`origin` 动作的 `originGroup` 不为空 |
| `ORIGIN_HOST_HEADER_INVALID` | 400 | `origin` 动作的 `hostHeader` 无效；`data.hostHeader` |
| `IP_LIST_REFERENCE_UNKNOWN` | 404 | 表达式引用的 IP 名单不存在；`data.lists` |

### `platformRules.versions`

`GET /platform-rules/{ruleId}/versions` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `ruleId` | path | uuid | 是 | — | 全局规则 ID，含已删除的规则 |

响应：[规则版本](#规则版本对象)[]，版本号大的在前；不是全局规则时为空数组。

### `platformRules.deleted`

`GET /platform-rules/deleted` · 读

无参数。

响应：[规则版本](#规则版本对象)[]，每条已删除全局规则的最后一个版本，最近删除的在前。

### `platformRules.restore`

`POST /platform-rules/{ruleId}/restore` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `ruleId` | path | uuid | 是 | — | 全局规则 ID |
| `version` | body | integer | 是 | ≥1 | 该规则保留的版本号 |

行为同 [`rules.restore`](#rulesrestore)，上限为 32 条。

响应：恢复后的全部全局[规则](#规则对象)[]。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `RULE_VERSION_NOT_FOUND` | 404 | 没有保留这个全局规则版本 |
| `RULE_INVALID` | 400 | 版本内容不再通过规则检查；规则 ID 已被其他规则使用 |
| `RULE_LIMIT_REACHED` | 400 | 恢复已删除的规则会超过 32 条；`data.limit` |
| `ORIGIN_HOST_HEADER_INVALID` | 400 | `origin` 动作的 `hostHeader` 无效；`data.hostHeader` |
| `IP_LIST_REFERENCE_UNKNOWN` | 404 | 表达式引用的 IP 名单不存在；`data.lists` |

## 批量重定向

- 保存发布网站所在集群的配置版本（原因 `rules_updated`），审计 `site.bulk_redirects_update`（元数据 `count`、`revision`）。
- 批量重定向需要节点能力 `rules-v2`。行为见[批量重定向](../../guide/rules.md#批量重定向)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`bulkRedirects.get`](#bulkredirectsget) | `GET /sites/{id}/bulk-redirects` | 读 |
| [`bulkRedirects.save`](#bulkredirectssave) | `PUT /sites/{id}/bulk-redirects` | 写 |

### `bulkRedirects.get`

`GET /sites/{id}/bulk-redirects` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |

响应：[批量重定向条目](#批量重定向条目)[]，按保存顺序。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

### `bulkRedirects.save`

`PUT /sites/{id}/bulk-redirects` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |
| `redirects` | body | array<[批量重定向条目](#批量重定向条目)> | 是 | 最多 5000 条；`source` 不重复 | 整体替换网站的重定向表 |

响应：保存后的[批量重定向条目](#批量重定向条目)[]。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |
| `BULK_REDIRECT_HOST_UNKNOWN` | 400 | `域名/路径` 来源的域名不是网站的精确域名，也不是网站泛域名下一级的子域名；`data.hosts` 为前 5 个，逗号分隔 |

## IP 名单

- 名单作用于所有集群：创建、修改与删除都发布所有集群的配置版本（原因 `rules_updated`），审计 `ip_list.create`、`ip_list.update`（元数据 `entries` 条数、`kind`）、`ip_list.delete`。
- 配额：最多 128 份名单、合计 50000 条记录；不增加条目数的修改总能保存。
- 行为见 [IP 名单](../../guide/rules.md#ip-名单)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`ipLists.list`](#iplistslist) | `GET /ip-lists` | 读 |
| [`ipLists.create`](#iplistscreate) | `POST /ip-lists` | 写 |
| [`ipLists.update`](#iplistsupdate) | `PUT /ip-lists/{id}` | 写 |
| [`ipLists.delete`](#iplistsdelete) | `DELETE /ip-lists/{id}` | 写 |

### `ipLists.list`

`GET /ip-lists` · 读

无参数。

响应：[IP 名单](#ip-名单对象)[]，按名称排序。

### `ipLists.create`

`POST /ip-lists` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `name` | body | string | 是 | 以字母或下划线开头，只含字母、数字与下划线，1–64 字符 | 名称，表达式中写作 `$name`；创建后不可修改 |
| `entries` | body | `array<string>` | 是 | 最多 10000 条，每条最长 64 字符的 IPv4 / IPv6 地址或 CIDR | 清除主机位、去重并排序后保存；含无效条目时请求校验失败 |
| `kind` | body | enum | 否 | `collection` / `allow` / `block`，默认 `collection` | `collection`：供规则引用；`block`：拦截名单，作用于全部网站；`allow`：放行名单，作用于全部网站 |

响应：[IP 名单](#ip-名单对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `IP_LIST_NAME_TAKEN` | 409 | 名称已被使用 |
| `IP_LIST_LIMIT` | 409 | 超过名单数或记录总数配额 |

### `ipLists.update`

`PUT /ip-lists/{id}` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 名单 ID |
| `entries` | body | `array<string>` | 是 | 同 `ipLists.create` | 替换全部条目 |
| `kind` | body | enum | 是 | `collection` / `allow` / `block` | 名单动作 |

响应：[IP 名单](#ip-名单对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `IP_LIST_NOT_FOUND` | 404 | 名单不存在 |
| `IP_LIST_LIMIT` | 409 | 修改增加条目数且超过记录总数配额 |

### `ipLists.delete`

`DELETE /ip-lists/{id}` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 名单 ID |

响应：`{ ok: true }`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `IP_LIST_NOT_FOUND` | 404 | 名单不存在 |
| `IP_LIST_IN_USE` | 409 | 名单仍被规则、缓存规则条件、L4 应用引用，或被网站选为本站名单；`data.users` 为前 5 个引用者，逗号分隔（网站规则写作 `规则名 (网站名)`） |

## IP 检查

控制台对一个地址已知的信息：包含它的 IP 名单、覆盖它的有效封禁、各集群的访客 IP 设置如何看待它；指定网站时另给出边缘名单与封禁步骤的结果。不查询 GeoIP。行为见 [IP 检查](../../guide/access-control.md#ip-检查)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`ipCheck.check`](#ipcheckcheck) | `GET /ip-check` | 读 |

### `ipCheck.check`

`GET /ip-check` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `ip` | query | string | 是 | 去掉首尾空白后 1–64 字符；IPv4 或 IPv6 地址，不能是 CIDR | 要检查的地址 |
| `siteId` | query | uuid | 否 | — | 网站 ID；给出时 `bans` 只含全局与该网站的封禁，`clusters` 只含该网站的集群，并计算 `verdict` |

响应：[IP 检查结果](#ip-检查结果)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `IP_ADDRESS_INVALID` | 400 | `ip` 不是 IP 地址，或是 CIDR |
| `SITE_NOT_FOUND` | 404 | `siteId` 对应的网站不存在 |

## 封禁

- 封禁经节点通道在数秒内下发，不产生配置版本。审计 `ban.create`、`ban.update`（再次封禁有效的手动封禁）、`ban.delete`。
- 有效的手动封禁与灰名单条目合计不超过平台上限（`settings.bans` 的 `maxTotal`，默认 10000）。
- 行为见[封禁](../../guide/bans.md)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`bans.list`](#banslist) | `GET /bans` | 读 |
| [`bans.create`](#banscreate) | `POST /bans` | 写 |
| [`bans.delete`](#bansdelete) | `DELETE /bans/{id}` | 写 |

### `bans.list`

`GET /bans` · 读

只列出有效的封禁（未到期、未解封），按创建时间倒序。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `scope` | query | enum | 否 | `site` / `platform` | 范围 |
| `siteId` | query | uuid | 否 | — | 只列出该网站的封禁；不检查网站是否存在 |
| `source` | query | enum | 否 | `manual` / `auto` / `rule` | 来源 |
| `address` | query | string | 否 | 去掉首尾空白后 1–64 字符；IP 地址或任意前缀长度的 CIDR | 只列出覆盖它或位于它之内的封禁 |
| `page` | query | integer | 否 | ≥1，默认 `1` | 页码 |
| `pageSize` | query | integer | 否 | 1–100，默认 `50` | 每页条数 |

响应：`{ items: [封禁](#封禁对象)[], total }`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `BAN_INVALID_CIDR` | 400 | `address` 不是 IP 地址或 CIDR |

### `bans.create`

`POST /bans` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `scope` | body | enum | 是 | `site` / `platform` | `site`：一个网站；`platform`：所有集群的全部网站 |
| `siteId` | body | uuid | 视情况 | `scope` 为 `site` 时必填，为 `platform` 时不能填写 | 网站 ID |
| `cidr` | body | string | 是 | 去掉首尾空白后 1–64 字符；IP 地址或 CIDR，前缀不短于 `/16`（IPv4）或 `/48`（IPv6） | 清除主机位、IPv6 小写压缩、IPv4 映射地址转为 IPv4 后保存 |
| `reason` | body | enum | 是 | `abuse` / `attack` / `scanner` / `spam` / `other` | 原因 |
| `durationSeconds` | body | integer | 是 | 60–604800 | 时长（秒） |

同一范围、网站与 CIDR 已有有效的手动封禁时更新 `reason` 与到期时间，返回同一 `id`，不计入上限，审计 `ban.update`。全局范围已有同一 CIDR 的自动或规则封禁时，由这条手动封禁取代。

响应：[封禁](#封禁对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `BAN_INVALID_CIDR` | 400 | `cidr` 不是 IP 地址或 CIDR |
| `BAN_PREFIX_TOO_SHORT` | 400 | 前缀短于 `/16`（IPv4）或 `/48`（IPv6）；`data.min` |
| `BAN_EXPIRY_OUT_OF_RANGE` | 400 | `durationSeconds` 不在 60–604800 |
| `BAN_PROTECTED_ADDRESS` | 400 | 覆盖回环或未指定地址（`0.0.0.0/8`、`127.0.0.0/8`、`::/128`、`::1/128`）、节点地址（网站封禁：该网站集群的节点；全局封禁：全部节点）或放行名单的条目；`data.address` 为冲突的地址 |
| `BAN_PLATFORM_LIMIT` | 409 | 有效的手动封禁与灰名单条目已达上限；`data.limit` |
| `SITE_NOT_FOUND` | 404 | `siteId` 对应的网站不存在 |

### `bans.delete`

`DELETE /bans/{id}` · 写

解除一条有效的封禁，来源不限（手动、自动或规则）。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 封禁 ID |

响应：`{ ok: true }`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `BAN_NOT_FOUND` | 404 | 封禁不存在、已到期或已解封 |

## 灰名单

- 灰名单条目与封禁共用节点通道、地址规则、时长范围、原因取值与手动条目上限；同一 CIDR 的封禁是另一条记录，两者同时有效时封禁优先。
- 创建或更新动作为挑战的条目时发布其作用的集群（全局条目为所有集群，原因 `greylist_challenge`），以下发挑战密钥；配置已带挑战密钥的集群不产生新版本。
- 审计 `greylist.create`、`greylist.update`、`greylist.delete`。节点需要能力 `greylist-v1`。行为见[灰名单](../../guide/bans.md#灰名单)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`greylist.list`](#greylistlist) | `GET /greylist` | 读 |
| [`greylist.create`](#greylistcreate) | `POST /greylist` | 写 |
| [`greylist.delete`](#greylistdelete) | `DELETE /greylist/{id}` | 写 |

### `greylist.list`

`GET /greylist` · 读

只列出有效的条目，按创建时间倒序。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `scope` | query | enum | 否 | `site` / `platform` | 范围 |
| `siteId` | query | uuid | 否 | — | 只列出该网站的条目 |
| `address` | query | string | 否 | 去掉首尾空白后 1–64 字符；IP 地址或 CIDR | 只列出覆盖它或位于它之内的条目 |
| `page` | query | integer | 否 | ≥1，默认 `1` | 页码 |
| `pageSize` | query | integer | 否 | 1–100，默认 `50` | 每页条数 |

响应：`{ items: [灰名单条目](#灰名单条目对象)[], total, unsupportedNodes }`；`unsupportedNodes` 为缺少 `greylist-v1` 的活动节点数（所有集群），这些节点忽略全部条目。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `BAN_INVALID_CIDR` | 400 | `address` 不是 IP 地址或 CIDR |

### `greylist.create`

`POST /greylist` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `scope` | body | enum | 是 | `site` / `platform` | 范围 |
| `siteId` | body | uuid | 视情况 | `scope` 为 `site` 时必填，为 `platform` 时不能填写 | 网站 ID |
| `cidr` | body | string | 是 | 同 [`bans.create`](#banscreate) | IP 地址或 CIDR |
| `reason` | body | enum | 是 | `abuse` / `attack` / `scanner` / `spam` / `other` | 原因 |
| `durationSeconds` | body | integer | 是 | 60–604800 | 时长（秒） |
| `action` | body | object | 是 | 见[灰名单条目对象](#灰名单条目对象) | `{ kind: "challenge", challenge }` 或 `{ kind: "rate_limit", requests, windowSeconds }` |

同一范围、网站与 CIDR 已有有效条目时更新 `action`、`reason` 与到期时间，返回同一 `id`，不计入上限，审计 `greylist.update`。

响应：[灰名单条目](#灰名单条目对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `BAN_INVALID_CIDR` | 400 | `cidr` 不是 IP 地址或 CIDR |
| `BAN_PREFIX_TOO_SHORT` | 400 | 前缀短于 `/16`（IPv4）或 `/48`（IPv6）；`data.min` |
| `BAN_EXPIRY_OUT_OF_RANGE` | 400 | `durationSeconds` 不在 60–604800 |
| `BAN_PROTECTED_ADDRESS` | 400 | 覆盖受保护的地址，同 [`bans.create`](#banscreate)；`data.address` |
| `BAN_PLATFORM_LIMIT` | 409 | 有效的手动封禁与灰名单条目已达上限；`data.limit` |
| `SITE_NOT_FOUND` | 404 | `siteId` 对应的网站不存在 |

### `greylist.delete`

`DELETE /greylist/{id}` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 条目 ID |

响应：`{ ok: true }`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `BAN_NOT_FOUND` | 404 | 条目不存在、已到期或已移出 |

## 挑战与 CC 防护

- 挑战类型即级别，由弱到强：`cookie302`、`js`、`pow`、`captcha`；CC 级别另有 `normal`。
- 修改发布网站所在集群的配置版本（原因 `site_protection_updated`），审计 `site.protection_update`（元数据 `from`、`to`、`revision`）。
- 节点能力：Under Attack 与 CC 需要 `challenge-v1`；`allowVerifiedBots`、`challengeText`、`failureBan` 需要 `challenge-v2`；`logJa4` 需要 `ja4-v1`。
- 全局 Under Attack 与 CC 模板是系统设置（`settings.protection`、`settings.ccTemplate`）。行为见[挑战与 CC 防护](../../guide/challenges.md)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`protection.get`](#protectionget) | `GET /sites/{id}/protection` | 读 |
| [`protection.update`](#protectionupdate) | `PATCH /sites/{id}/protection` | 写 |
| [`security.state`](#securitystate) | `GET /sites/{id}/security` | 读 |
| [`security.events`](#securityevents) | `GET /sites/{id}/security/events` | 读 |

### `protection.get`

`GET /sites/{id}/protection` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |

响应：[网站防护](#网站防护对象)。从未保存过的网站返回默认值，`updatedAt` 为 `null`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

### `protection.update`

`PATCH /sites/{id}/protection` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |
| `underAttack` | body | boolean | 否 | 省略时不变 | 网站的 Under Attack |
| `underAttackChallenge` | body | enum | 否 | `cookie302` / `js` / `pow` / `captcha`；省略时不变 | Under Attack 的挑战类型 |
| `passTtlSeconds` | body | integer | 否 | 300–86400；省略时不变 | 通行凭证有效期（秒） |
| `powDifficulty` | body | integer | 否 | 8–24；省略时不变 | 工作量证明难度（前导零位数） |
| `powHighDifficulty` | body | integer | 否 | 8–26，合并后不低于 `powDifficulty`；省略时不变 | 高难度工作量证明 |
| `cc` | body | object | 否 | [CC 阈值](#cc-阈值对象)的任意字段，以及 `enabled`、`followTemplate`（boolean）；省略时不变 | 合并到已保存的 CC 策略 |
| `logJa4` | body | boolean | 否 | 省略时不变 | 在采样访问日志中记录 JA4 |
| `allowVerifiedBots` | body | boolean | 否 | 省略时不变 | 已验证的搜索引擎爬虫跳过 Under Attack 与 CC 挑战 |
| `challengeText` | body | object | 否 | `titleZh`、`hintZh`、`titleEn`、`hintEn`，各去掉首尾空白后最多 200 个字符，不含控制字符，省略的子字段为 `""`；省略时不变 | 整体替换挑战页的标题与提示；`""` 为内置文案 |
| `failureBan` | body | object | 否 | `{ enabled, threshold, banSeconds }` 均必填：`threshold` 3–100，`banSeconds` 60–86400；省略时不变 | 10 分钟内挑战失败 `threshold` 次后封禁该地址 `banSeconds` 秒 |

- `cc.followTemplate` 为 `true` 时阈值取平台 CC 模板，同时提交的阈值字段被保存但不生效。
- 给出 `underAttack` 视为手动操作：网站正由[自动缓解](../../guide/attack-dashboard.md#自动缓解)保持 Under Attack 时，开启即接管，关闭即结束保持并暂停自动缓解。

响应：[网站防护](#网站防护对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |
| `PROTECTION_POW_DIFFICULTY` | 400 | 合并后 `powHighDifficulty` 低于 `powDifficulty`；`data.min` 为允许的最小值 |

### `security.state`

`GET /sites/{id}/security` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |
| `hours` | query | integer | 否 | 1–720，默认 `24` | 汇总 `topIps`、`topPaths` 的小时数 |

响应：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `nodes` | `array<object>` | 网站所在集群的每个活动节点，按名称排序 |
| `nodes[].id`、`nodes[].name` | uuid、string | 节点 |
| `nodes[].online` | boolean | 节点是否在线 |
| `nodes[].level` | enum | 该网站在节点上的 CC 级别：`normal` / `cookie302` / `js` / `pow` / `captcha`；未上报时为 `normal` |
| `nodes[].escalatedPaths` | integer | 级别高于网站级别的路径数 |
| `nodes[].reportedAt` | datetime 或 `null` | 节点最后一次连接的时间 |
| `topIps`、`topPaths` | array<`{ value, count }`> | 近 `hours` 小时安全事件中最多的地址与路径，各最多 10 个，近似值 |
| `hours` | integer | 实际使用的小时数 |

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

### `security.events`

`GET /sites/{id}/security/events` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |
| `kind` | query | enum | 否 | `site_level` / `path_level` / `ip_banned` | 事件类型 |
| `hours` | query | integer | 否 | 1–720；省略时不限 | 只返回近这些小时的事件 |
| `page` | query | integer | 否 | ≥1，默认 `1` | 页码 |
| `pageSize` | query | integer | 否 | 1–100，默认 `50` | 每页条数 |

响应：`{ items: [安全事件](#安全事件对象)[], total }`，按发生时间倒序。事件保留天数由系统设置 `settings.protection` 的 `eventRetentionDays` 决定。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

## OWASP CRS

- 修改发布网站所在集群的配置版本（原因 `site_waf_updated`），审计 `site.waf_update`（元数据 `from`、`to`、`revision`）。
- 节点能力：开启 CRS 需要 `modsecurity-v1`；带 `path` 或 `targets` 的排除条目需要 `waf-v2`。
- 行为见 [OWASP CRS 托管规则](../../guide/waf.md)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`waf.get`](#wafget) | `GET /sites/{id}/waf` | 读 |
| [`waf.update`](#wafupdate) | `PATCH /sites/{id}/waf` | 写 |
| [`waf.topRules`](#waftoprules) | `GET /sites/{id}/waf/rules` | 读 |

### `waf.get`

`GET /sites/{id}/waf` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |

响应：[网站 CRS](#网站-crs-对象)。从未保存过时为默认值：`mode` `off`、`paranoiaLevel` `1`、`anomalyThreshold` `5`、`exclusions` `[]`、`requestBodyLimit` `131072`，`updatedAt` 为 `null`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

### `waf.update`

`PATCH /sites/{id}/waf` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |
| `mode` | body | enum | 否 | `off` / `detect` / `block`；省略时不变 | `detect` 只记录命中；`block` 在异常分数达到阈值时返回 403 |
| `paranoiaLevel` | body | integer | 否 | 1–4；省略时不变 | 偏执级别 |
| `anomalyThreshold` | body | integer | 否 | 1–1000；省略时不变 | 入站异常分数阈值 |
| `exclusions` | body | array<[CRS 排除条目](#crs-排除条目)> | 否 | 最多 100 个；省略时不变 | 整体替换全部排除条目 |
| `requestBodyLimit` | body | integer | 否 | 0–134217728；省略时不变 | 检查的请求体字节数，`0` 不检查请求体 |

响应：[网站 CRS](#网站-crs-对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `WAF_RULE_NOT_EXCLUDABLE` | 400 | `ruleIds` 含初始化与判定规则（901xxx、949xxx、959xxx、980xxx）；`data.ids` 为前 5 个，逗号分隔 |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

### `waf.topRules`

`GET /sites/{id}/waf/rules` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |
| `range` | query | enum | 否 | `1h` / `6h` / `24h` / `7d` / `30d`，默认 `24h` | 时间范围 |
| `limit` | query | integer | 否 | 1–50，默认 `10` | 返回的规则数 |

响应：`{ approximate: true, items: [{ ruleId, requests }] }`，按命中次数降序，近似值；只含检测规则，不含 901xxx、949xxx、959xxx、980xxx。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

## 对象

### 规则对象

请求中 `id` 可省略；省略的字段取默认值，响应写出全部字段。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 规则 ID；请求中可选 |
| `name` | string | 去掉首尾空白后 1–100 字符 |
| `phase` | enum | `request-transform`、`redirect`、`config`、`waf-custom`、`ratelimit`、`cache`、`origin`、`response-transform`、`compression` |
| `expression` | string | 条件表达式，1–4096 字符，按 `phase` 解析；语法见[表达式](../../guide/rules.md#表达式) |
| `enabled` | boolean | 默认 `false`：省略时规则保存为停用 |
| `action` | object | [规则动作](#规则动作)，按 `kind` 区分；`kind` 须是该阶段可用的动作 |

表达式或值表达式无效时返回 400 `BAD_REQUEST`，`data.issues` 中该项的 `params.expressionError` 为 `{ code, position, params }`，与 [`rules.validate`](#rulesvalidate) 的结果相同。

### 规则动作

| `kind` | 阶段 | 字段 | 节点能力 |
| --- | --- | --- | --- |
| `block` | `waf-custom` | `statusCode`：`403`（默认）或 `451` | — |
| `log` | `waf-custom` | `accessLog`：boolean，可选；不论采样率写一条访问日志 | `accessLog`：`waf-v2` |
| `allow` | `waf-custom` | 无 | — |
| `challenge` | `waf-custom` | `type`：`cookie302` / `js`（默认）/ `pow` / `captcha`；没有该级别或更高级别通行凭证的请求收到挑战 | `challenge-v1` |
| `ban` | `waf-custom` | 见 [`ban`](#ban) | `waf-v2` |
| `respond` | `waf-custom` | 见 [`respond`](#respond) | `waf-v2` |
| `close` | `waf-custom` | 无；不发送响应，关闭连接 | `waf-v2` |
| `skip` | `waf-custom` | `skip`：`rules`、`rate_limits`、`crs`、`challenges` 中不重复的 1–4 个 | `waf-v2` |
| `redirect` | `redirect` | 见 [`redirect`](#redirect) | 见该节 |
| `rewrite` | `request-transform` | 见 [`rewrite`](#rewrite) | 见该节 |
| `request_header` | `request-transform`、`origin` | 见 [`request_header`、`response_header`](#request_headerresponse_header) | 见该节 |
| `response_header` | `response-transform` | 见 [`request_header`、`response_header`](#request_headerresponse_header) | 见该节 |
| `config` | `config`、`cache` | 见 [`config`](#config) | 见该节 |
| `origin` | `origin` | 见 [`origin`](#origin) | `rules-v2` |
| `compression` | `compression` | `algorithms`：`zstd`、`br`、`gzip` 中不重复的若干个，按优先顺序；`[]` 不压缩 | `rules-v2` |
| `rate_limit` | `ratelimit` | 见 [`rate_limit`](#rate_limit) | 见该节 |

`skip` 的目标：`rules` 本作用域剩余的自定义 WAF 规则；`rate_limits` 限速（全局规则跳过全部限速，网站规则只跳过网站的）；`crs` OWASP CRS；`challenges` Under Attack 与 CC 挑战。动作行为见 [WAF 动作](../../guide/rules.md#waf-动作)与[动作字段](../../guide/rules.md#动作字段)；各能力的触发条件见[节点能力与发布](../../guide/rules.md#节点能力与发布)。

#### `ban`

把 `ip.src` 按前缀写入封禁（来源 `rule`，原因 `waf_rule`），本次请求返回 403。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `banSeconds` | integer | 60–604800，默认 `3600` |
| `banScope` | enum | `site`（默认）/ `platform`；`platform` 只用于全局规则 |
| `banPrefixV4` | integer | 16–32，默认 `32` |
| `banPrefixV6` | integer | 48–64，默认 `64` |

#### `respond`

以状态码与静态正文结束请求，或使用网站该状态码的错误页；响应带 `Cache-Control: no-store`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `statusCode` | integer | `200`、`204` 或 400–599，默认 `403` |
| `contentType` | enum | `text/plain`（默认）/ `text/html` / `application/json` |
| `body` | string | 最多 8192 字节，不含制表符与换行以外的控制字符，默认 `""`；`statusCode` 为 `204` 或 `errorPage` 为 `true` 时须为空 |
| `errorPage` | boolean | 默认 `false`；只用于 4xx 与 5xx |

#### `redirect`

`value` 与 `target` 恰好填一个。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `value` | string | 静态目标，默认 `""`：以单个 `/` 开头的本站路径，或不含凭据、空白与反斜杠的 `http(s)` URL；最长 4096 字符，不含控制字符 |
| `target` | string | 值表达式，按请求计算目标，最长 4096 字符，默认 `""`（`rules-v2`） |
| `statusCode` | integer | `301`（默认）、`302`、`303`、`307`、`308`；`303` 需要 `rules-v3` |
| `preserveQuery` | boolean | 默认 `false`；把请求的查询串附加到目标 |
| `setQuery` | `array<object>` | 最多 16 个[查询参数](#查询参数)，名称不重复，默认 `[]`；先移除同名参数再设置（`rules-v2`） |
| `removeQuery` | `array<string>` | 最多 16 个参数名（`[A-Za-z0-9._~-]{1,64}`），不能与 `setQuery` 的名称相同，默认 `[]`（`rules-v2`） |

#### `rewrite`

改写发往源站的路径与查询串。字段同 [`redirect`](#redirect)，没有 `statusCode`；`value` 为以单个 `/` 开头、不含 `?`、`#` 与反斜杠的路径；`preserveQuery` 默认 `true`，`false` 时先清空查询串再应用 `setQuery`、`removeQuery`。

#### 查询参数

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | string | `[A-Za-z0-9._~-]{1,64}` |
| `value` | string | 可打印 ASCII，最多 256 字符；节点百分号编码 |
| `expression` | string | 值表达式，最长 4096 字符，默认 `""`（`rules-v3`）；不为空时 `value` 须为空 |

#### `request_header`、`response_header`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `header` | string | 1–64 个 token 字符，转为小写；不能是 `host`、`authorization`、`proxy-authorization`、`cookie`、`set-cookie`、`content-length`、`transfer-encoding`、`connection`、`upgrade`、`te`、`trailer`、`cdn-loop`，也不能以 `x-edgeweir-` 开头 |
| `value` | string | 静态值，最长 4096 字符，不含控制字符，默认 `""` |
| `expression` | string | 值表达式，最长 4096 字符，默认 `""`（`rules-v3`）；不为空时 `value` 须为空、`remove` 须为 `false` |
| `remove` | boolean | 默认 `false`；移除该报头 |
| `append` | boolean | 仅 `response_header`；默认 `false`，在响应已有的同名报头之外再加一行（`rules-v3`）；不能与 `remove` 同时为 `true` |

#### `config`

覆盖网站设置，只对匹配的请求生效；后命中的规则逐项覆盖。所有字段可选，省略的不覆盖，至少给出一项。`cache` 阶段只接受 `cacheBypass`、`forceHttps`、`gzip`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `cacheBypass` | boolean | 绕过缓存 |
| `forceHttps` | boolean | 强制 HTTPS |
| `gzip` | boolean | Gzip（在网站开启的压缩算法之内） |
| `brotli`、`zstd` | boolean | 仅 `config` 阶段（`rules-v2`） |
| `websocket` | boolean | 仅 `config` 阶段（`rules-v2`） |
| `underAttack` | boolean | 网站的 Under Attack，不影响全局 Under Attack；仅 `config` 阶段（`rules-v2`） |
| `ccEnabled` | boolean | CC 升级；请求照常计数；仅 `config` 阶段（`rules-v2`） |
| `ccMaxLevel` | enum | `cookie302` / `js` / `pow` / `captcha`；仅 `config` 阶段（`rules-v2`） |
| `originConnectTimeoutMs` | integer | 100–120000；仅 `config` 阶段（`rules-v2`） |
| `originSendTimeoutMs`、`originReadTimeoutMs` | integer | 100–3600000；仅 `config` 阶段（`rules-v2`） |
| `logSampleRate` | integer | 访问日志采样率，0–10000（万分比，`0` 停止采样）；仅 `config` 阶段（`rules-v2`） |
| `requestBodyLimit` | integer | 按 `Content-Length` 的请求体上限（字节），0–10737418240，`0` 不限；仅 `config` 阶段（`site-content-v1`） |
| `crs` | enum | 本请求的 CRS 模式：`off` / `detect` / `block`；未开启 CRS 的网站忽略；仅 `config` 阶段（`waf-v2`） |

#### `origin`

至少修改一项。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `originGroup` | string | 网站的源站组，`""`（默认）为默认组；非空时为 `[a-z0-9_-]{1,32}`，须是网站已有的组；全局规则只能为 `""` |
| `hostHeader` | string | 回源 Host，去掉首尾空白、ASCII 字母转为小写，最长 259 字符，默认 `""` 不覆盖；须是主机名或 IP，可带端口，带端口的 IPv6 写在方括号内 |
| `sni` | string | TLS SNI 主机名，转为小写，最长 253 字符，默认 `""` 不覆盖 |
| `port` | integer | 0–65535，默认 `0` 不覆盖；作用于组内每个源站 |

#### `rate_limit`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `statusCode` | integer | `429`（默认）或 `403` |
| `limit` | integer | 1–100000，必填 |
| `windowSeconds` | integer | 1–3600，必填 |
| `key` | string | 计数键，默认 `ip.src`：`ip.src`、`http.host`、`tls.ja4`（`ja4-v1`）或 `http.request.headers.<名称>`（名称为 `[a-z0-9-]{1,64}`） |
| `banSeconds` | integer | 可选；`0` 关闭，或 60–86400：超额后在网站范围封禁该地址（IPv4 /32、IPv6 /64，来源 `rule`，原因 `rate_limit`）这么多秒（`waf-v2`） |

### 规则版本对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ruleId` | uuid | 规则 ID |
| `version` | integer | 版本号，每条规则从 1 递增 |
| `change` | enum | `created` / `updated` / `deleted` |
| `source` | enum | `ui`（控制台会话）、`api`（AccessKey 或服务账号）、`restore`、`copy`（复制设置）、`initial`（升级前已有的规则） |
| `restoredFrom` | integer 或 `null` | 恢复的版本号 |
| `rule` | object | 保存时的规则 `{ name, phase, expression, enabled, action }`；`deleted` 版本为删除前的内容。只在恢复时按当前规则检查 |
| `actor` | object | `{ type, id, name }`：操作者 |
| `createdAt` | datetime | 记录时间 |

### 批量重定向条目

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `source` | string | `/路径`（网站的全部域名）或 `域名/路径`（只匹配该域名，域名小写）；2–512 字节，不含空白、`?` 与控制字符 |
| `target` | string | 静态重定向目标：以单个 `/` 开头的本站路径，或不含凭据、空白与反斜杠的 `http(s)` URL；最长 1024 字节 |
| `statusCode` | integer | `301`（默认）、`302`、`307`、`308` |
| `preserveQuery` | boolean | 默认 `false`；把请求的查询串附加到目标 |

### IP 名单对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 名单 ID |
| `name` | string | 名称 |
| `entries` | `array<string>` | 规范化的地址与 CIDR，排序 |
| `kind` | enum | `collection` / `allow` / `block` |

### IP 检查结果

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ip` | string | 节点所见的地址（IPv4 映射的 IPv6 地址按 IPv4） |
| `site` | object 或 `null` | `{ id, name }`；未给出 `siteId` 时为 `null` |
| `lists` | `array<object>` | 含有该地址的名单，按名称排序 |
| `lists[].id`、`lists[].name`、`lists[].kind` | uuid、string、enum | 名单 |
| `lists[].entries` | `array<string>` | 含有该地址的条目 |
| `lists[].siteRole` | enum 或 `null` | 给出 `siteId` 时，名单是该网站的本站拦截名单（`block`）或本站放行名单（`allow`）；否则为 `null` |
| `bans` | array<[封禁](#封禁对象)> | 覆盖该地址的有效封禁，最多 100 条 |
| `clusters` | `array<object>` | 集群，按名称排序 |
| `clusters[].id`、`clusters[].name` | uuid、string | 集群 |
| `clusters[].clientIp` | enum | 访客 IP 模式：`direct` / `proxy_protocol` / `header` |
| `clusters[].trustedProxy` | boolean | `header` 模式下该地址是可信代理 |
| `clusters[].nodeAddress` | boolean | 该地址是集群的节点地址 |
| `verdict` | object 或 `null` | 给出 `siteId` 时为 `{ outcome, platformAllowed, siteAllowed }`，否则为 `null` |
| `verdict.outcome` | enum | 边缘按顺序第一个起决定作用的步骤：`platform_banned`、`site_banned`、`platform_blocked`、`site_blocked`、`allowed`、`none` |
| `verdict.platformAllowed` | boolean | 地址在放行名单中 |
| `verdict.siteAllowed` | boolean | 地址在网站的本站放行名单中 |

### 封禁对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 封禁 ID |
| `scope` | enum | `site` / `platform` |
| `cidr` | string | 规范化的 CIDR，如 `203.0.113.7/32` |
| `reason` | enum | 手动：`abuse`、`attack`、`scanner`、`spam`、`other`；自动：`cc_ip_rate`、`unknown_host_scan`、`challenge_failures`；规则：`waf_rule`、`rate_limit` |
| `source` | enum | `manual` / `auto` / `rule` |
| `siteId`、`siteName` | uuid、string 或 `null` | 全局封禁为 `null` |
| `node` | object 或 `null` | 自动与规则封禁的来源节点 `{ id, name }` |
| `trigger` | object 或 `null` | `{ metric, observed, threshold, windowSeconds, ruleId? }`：触发条件；`ruleId` 为规则封禁的规则 |
| `rule` | object 或 `null` | 规则封禁的规则 `{ id, name, platform }`；规则已删除时 `name` 为 `null` |
| `createdBy` | object 或 `null` | 手动封禁的操作者 `{ type, id, name }` |
| `createdAt`、`expiresAt` | datetime | 创建与到期时间 |
| `seq` | string | 封禁变化序号，十进制字符串 |
| `distributed` | boolean | 是否下发到节点；未共享的自动封禁为 `false` |
| `unappliedNodes` | integer | 上报因容量不足未应用这条手动封禁的在线节点数 |

### 灰名单条目对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 条目 ID |
| `scope` | enum | `site` / `platform` |
| `cidr` | string | 规范化的 CIDR |
| `reason` | enum | `abuse` / `attack` / `scanner` / `spam` / `other` |
| `siteId`、`siteName` | uuid、string 或 `null` | 全局条目为 `null` |
| `action` | object | `{ kind: "challenge", challenge }`：`challenge` 为 `cookie302` / `js` / `pow` / `captcha`，没有该级别通行凭证的请求收到挑战；或 `{ kind: "rate_limit", requests, windowSeconds }`：每个客户端（IPv4 地址、IPv6 `/64`）每窗口最多 `requests` 个请求（1–100000），`windowSeconds` 为 1–3600，超出返回 429 |
| `createdBy` | object 或 `null` | 操作者 `{ type, id, name }` |
| `createdAt`、`expiresAt` | datetime | 创建与到期时间 |
| `unappliedNodes` | integer | 上报因容量不足未应用这条条目的在线节点数 |

### 网站防护对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `siteId` | uuid | 网站 ID |
| `underAttack` | boolean | 网站的 Under Attack：没有有效通行凭证的 GET / HEAD 请求收到挑战；默认 `false` |
| `underAttackChallenge` | enum | 默认 `js` |
| `passTtlSeconds` | integer | 默认 `1800` |
| `powDifficulty` | integer | 默认 `16` |
| `powHighDifficulty` | integer | 默认 `20` |
| `cc` | object | 网站的 CC 策略：[CC 阈值](#cc-阈值对象)加 `enabled`（默认 `false`）与 `followTemplate`（默认 `true`）；跟随模板时阈值为模板的值 |
| `ccTemplate` | object | 平台当前的 [CC 阈值](#cc-阈值对象)模板 |
| `effectiveCc` | object 或 `null` | 节点使用的 [CC 阈值](#cc-阈值对象)；策略关闭时为 `null` |
| `logJa4` | boolean | 默认 `false` |
| `allowVerifiedBots` | boolean | 默认 `false` |
| `challengeText` | object | `{ titleZh, hintZh, titleEn, hintEn }`；`""` 为内置文案 |
| `failureBan` | object | `{ enabled, threshold, banSeconds }`；默认 `{ enabled: false, threshold: 10, banSeconds: 600 }`，关闭时也返回保存的值 |
| `platformUnderAttack` | boolean | 全局 Under Attack 是否开启 |
| `updatedAt` | datetime 或 `null` | 最后保存时间；从未保存时为 `null` |

### CC 阈值对象

速率均为滑动窗口内的每秒请求数，`0` 关闭该触发条件；各节点独立判断，阈值按节点计。括号内为平台模板的默认值。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `maxLevel` | enum | 可达到的最高级别：`cookie302` / `js` / `pow` / `captcha`（`captcha`） |
| `highPowInsteadOfCaptcha` | boolean | 在 `captcha` 级别改用高难度工作量证明（`false`） |
| `windowSeconds` | integer | 5–60（`10`） |
| `siteQps` | integer | 0–1000000（`1000`） |
| `urlQps` | integer | 0–1000000，只升级被攻击的路径（`200`） |
| `ipQps` | integer | 0–1000000，超过的地址自动封禁 `ipBanSeconds` 秒（`50`） |
| `ipBanSeconds` | integer | 60–86400（`600`） |
| `originErrorPercent` | integer | 0–100，回源错误（5xx 与失败的尝试）占回源请求的百分比（`50`） |
| `originErrorMinRequests` | integer | 0–1000000，错误率生效前窗口内的最少回源请求数（`100`） |
| `escalateAfterSeconds` | integer | 1–3600，触发条件持续这么久后升一级（`10`） |
| `cooldownSeconds` | integer | 1–86400，这么久没有触发后降一级（`60`） |

### 安全事件对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 事件 ID |
| `node` | object 或 `null` | `{ id, name }`；节点删除后为 `null` |
| `occurredAt` | datetime | 发生时间 |
| `kind` | enum | `site_level` / `path_level` / `ip_banned` |
| `level`、`previousLevel` | string | 变化后与变化前的级别（`site_level`、`path_level`） |
| `path` | string | `path_level` 事件的路径 |
| `address` | string | `ip_banned` 事件的地址 |
| `metric` | string | `site_qps`、`url_qps`、`ip_qps`、`origin_error_rate` 或 `cooldown` |
| `observed`、`threshold` | number | 观测值与阈值 |
| `topIps`、`topPaths` | array<`{ value, count }`> | 事件发生时最多的地址与路径 |

### 网站 CRS 对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `siteId` | uuid | 网站 ID |
| `mode` | enum | `off` / `detect` / `block` |
| `paranoiaLevel` | integer | 偏执级别 |
| `anomalyThreshold` | integer | 入站异常分数阈值 |
| `exclusions` | array<[CRS 排除条目](#crs-排除条目)> | 按保存顺序 |
| `requestBodyLimit` | integer | 检查的请求体字节数 |
| `updatedAt` | datetime 或 `null` | 最后保存时间 |

### CRS 排除条目

匹配的请求不运行这些规则；带 `targets` 时这些规则只是不检查所列目标。保存时 `ruleIds` 去重升序、`targets` 去重排序，`path` 为空时 `exact` 为 `false`。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `path` | string | `""`（默认，整站）或以 `/` 开头的路径，最多 1024 字节，不含 `?`、`#`、空白与控制字符；按规范化后的路径匹配（`waf-v2`） |
| `exact` | boolean | 默认 `false`（前缀匹配）；`true` 为精确匹配 |
| `ruleIds` | `array<integer>` | 1–200 个不重复的 CRS 规则 ID（900000–999999），不能是 901xxx、949xxx、959xxx、980xxx |
| `targets` | `array<string>` | 最多 16 个不重复的目标，默认 `[]`：`ARGS:<名称>`、`REQUEST_COOKIES:<名称>`（名称为 1–64 个 `A-Za-z0-9_.-[]`）或 `REQUEST_HEADERS:<名称>`（名称为 1–64 个 `A-Za-z0-9-`）（`waf-v2`） |
