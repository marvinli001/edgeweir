# API：网站

网站、启停、标签与批量操作、复制与克隆、缓存任务、HTTPS、错误页与维护模式、访问鉴权、访问控制、图片转换、用量保护与自动缓解的过程，共 51 个。

权限级别、认证、幂等键与错误格式见 [API 概览](../api.md)。

## 网站

- 写操作在同一事务内发布网站所在集群的配置版本并写审计：新建 `site_created` / `site.create`，修改 `site_updated` / `site.update`（元数据 `changed` 列出修改的部分），删除 `site_deleted` / `site.delete`。编译后的配置与最新版本相同时不生成新版本，响应中的 `revision` 为最新版本。
- 写操作要求网站已保存的规则都能编译（否则 400 `RULE_INVALID`）。集群中已启用的网站超过 512 个时 409 `CLUSTER_SITE_LIMIT`。
- 服务账号调用且新配置需要集群中某个活动节点缺少的节点能力时 409 `NODE_CAPABILITY_REQUIRED`（`data.features`、`data.nodes`），修改不保存；运营者的调用照常保存。
- 行为见[网站管理](../../guide/site-management.md)、[源站与缓存](../../guide/origins-and-cache.md)与[域名](../../guide/domains.md)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`sites.list`](#siteslist) | `GET /sites` | 读；服务账号 `sites:read` |
| [`sites.get`](#sitesget) | `GET /sites/{id}` | 读；服务账号 `sites:read` |
| [`sites.create`](#sitescreate) | `POST /sites` | 写 |
| [`sites.update`](#sitesupdate) | `PATCH /sites/{id}` | 写 |
| [`sites.delete`](#sitesdelete) | `DELETE /sites/{id}` | 写 |
| [`sites.launch`](#siteslaunch) | `GET /sites/{id}/launch` | 读；服务账号 `sites:read` |
| [`sites.originHealth`](#sitesoriginhealth) | `GET /sites/{id}/origin-health` | 读 |
| [`sites.originQuality`](#sitesoriginquality) | `GET /sites/{id}/origins/quality` | 读 |
| [`sites.features`](#sitesfeatures) | `GET /sites/{id}/features` | 读 |
| [`sites.setCnamePrefix`](#sitessetcnameprefix) | `PUT /sites/{id}/cname-prefix` | 写 |
| [`sites.starred`](#sitesstarred) | `GET /starred-sites` | 读 |
| [`sites.setStarred`](#sitessetstarred) | `PUT /sites/{id}/starred` | 写 |

### `sites.list`

`GET /sites` · 读 · 服务账号 `sites:read`

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `search` | query | string | 否 | 去首尾空白后最长 100 | 匹配网站名称、任一域名或任一标签名（部分匹配，不区分大小写）；Unicode 搜索词另按 Punycode 与解码后的名称匹配 |
| `clusterId` | query | uuid | 否 | — | 只列出该集群的网站；集群不存在时结果为空 |
| `tagIds` | query | `array<uuid>` | 否 | 至多 10 个；`tagIds[]=a&tagIds[]=b`，单个值也可写 `tagIds=a` | 只列出带这些标签的网站 |
| `tagMatch` | query | enum | 否 | `any` / `all`，省略时为 `any` | `any`：带任一标签；`all`：带全部标签 |
| `page` | query | integer | 否 | ≥1，默认 `1` | 页码 |
| `pageSize` | query | integer | 否 | 1–100，默认 `20` | 每页条数 |

响应：`{ items: [网站](#网站对象)[], total }`，按创建时间升序；`total` 为符合条件的网站总数。

### `sites.get`

`GET /sites/{id}` · 读 · 服务账号 `sites:read`

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |

响应：[网站](#网站对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

### `sites.create`

`POST /sites` · 写 · `201`

请求体为[网站输入](#网站输入)。新网站没有证书，生成 8 位随机 CNAME 前缀。

响应：[网站写入结果](#网站写入结果)（不含 `certificateReissue`）。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `NO_CLUSTER` | 412 | 省略 `clusterId` 且还没有集群 |
| `CLUSTER_NOT_FOUND` | 404 | `clusterId` 不存在 |
| `DOMAIN_INVALID` | 400 | 主机名不能按 UTS #46 转换，或正则域名超过 10 个；`data.domain` |
| `DOMAIN_IN_USE` | 409 | 域名已属于其他网站；`data.domains` |
| `SITE_PORT_UNAVAILABLE` | 400 | 端口不是 80、443 或集群的额外监听端口；`data.port` |
| `SITE_HTTPS_PORT_NEEDS_CERTIFICATE` | 400 | `ports.https` 含 443 以外的端口（新网站没有证书）；`data.port` |
| `SITE_PORTS_EMPTY` | 400 | `ports.http` 为空 |
| `ORIGIN_HOST_HEADER_INVALID` | 400 | 源站的 `hostHeader` 不是节点接受的主机名或 IP；`data.hostHeader` |
| `ORIGIN_ADDRESS_FORBIDDEN` | 400 | 源站地址是平台未允许的特殊用途 IP 或 localhost；`data.address`、`data.range` |
| `ORIGIN_PROXY_PROTOCOL_S3` | 400 | S3 源站的 `proxyProtocolVersion` 不为 0 |
| `S3_SECRET_REQUIRED` | 400 | S3 源站缺少 `secretAccessKey`；`data.accessKeyId` |
| `ORIGIN_GRPC_REQUIRES_HTTP2` | 400 | `originSettings.grpc` 为 `true` 而 `protocol` 不是 `http2` |
| `ORIGIN_TLS_TRUST_REQUIRES_VERIFY` | 400 | `tlsTrust` 为 `originCa` 而 `tlsVerify` 为 `false` |
| `ORIGIN_CA_S3` | 400 | `tlsTrust` 为 `originCa` 且有 S3 源站 |
| `ORIGIN_CA_NOT_FOUND` | 409 | `tlsTrust` 为 `originCa` 而 Origin CA 尚未创建 |
| `ORIGIN_CLIENT_CA_NOT_FOUND` | 409 | `originSettings.clientCertificate` 为 `true` 而回源客户端 CA 尚未创建 |
| `PURGE_KEY_REQUIRED` | 400 | 开启 PURGE 方法而没有 `key` |
| `CACHE_RULE_PRIORITY_DUPLICATE` | 400 | 缓存规则的 `priority` 重复；`data.priority` |
| `RULE_INVALID` | 400 | 缓存规则的条件不能编译 |
| `CLUSTER_SITE_LIMIT` | 409 | 集群已启用的网站超过 512 个；`data.limit` |

### `sites.update`

`PATCH /sites/{id}` · 写

只修改请求中出现的字段；字段说明见[网站输入](#网站输入)。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |
| `name` | body | string | 否 | 去首尾空白后 1–100；省略时不变 | 名称 |
| `domains` | body | `array<string>` | 否 | 同[网站输入](#网站输入)；省略时不变 | 整体替换域名。HTTPS 跳转不跳转的域名中不再属于网站的被去掉 |
| `origins` | body | array<[源站输入](#源站输入)> | 否 | 同[网站输入](#网站输入)；省略时不变 | 整体替换源站。scheme、地址、端口都相同的源站保留原 ID |
| `cacheRules` | body | array<[缓存规则输入](#缓存规则输入)> | 否 | ≤64；省略时不变 | 整体替换缓存规则；内容不变的规则保留原 ID |
| `originSettings` | body | [源站池设置](#源站池设置) | 否 | 省略时不变 | 整体替换：省略的字段取默认值，但 `activeHealthCheck`、`sessionAffinity`、`protocol`、`grpc`、`tries`、`statusRetry`、`tlsTrust`、`clientCertificate` 省略时保持原值 |
| `cacheSettings` | body | [缓存设置](#缓存设置) | 否 | 省略时不变 | 整体替换：省略的字段取默认值，但 `keepCacheTag`、`xCache`、`purgeMethod` 省略时保持原值 |
| `contentSettings` | body | [内容设置](#内容设置) | 否 | 省略时不变 | 整体替换：省略的字段取默认值，但 `rulesBodyLimit` 省略时保持原值 |
| `ports` | body | object | 否 | 同[网站输入](#网站输入)；省略时不变 | 替换监听端口；HTTPS 跳转的 `redirectPort` 须为 443 或其中的 HTTPS 端口 |

修改了 `domains` 且网站的首张证书是自动续期的 ACME 证书时，证书按新增的域名扩展并立即重新签发，响应带 `certificateReissue`；其他证书须覆盖全部域名。

响应：[网站写入结果](#网站写入结果)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |
| `DOMAIN_INVALID` | 400 | 同 `sites.create` |
| `DOMAIN_IN_USE` | 409 | 同 `sites.create` |
| `CERTIFICATE_DOMAIN_MISMATCH` | 400 | 网站的证书不覆盖新域名且不能自动扩展；`data.domains` |
| `CERTIFICATE_BUSY` | 409 | 该网站已有一个证书申请在进行 |
| `SITE_PORT_UNAVAILABLE` | 400 | 同 `sites.create` |
| `SITE_HTTPS_PORT_NEEDS_CERTIFICATE` | 400 | 网站没有证书而 `ports.https` 含 443 以外的端口；`data.port` |
| `SITE_PORTS_EMPTY` | 400 | 网站不会在任何端口上服务 |
| `HTTPS_REDIRECT_PORT_INVALID` | 400 | HTTPS 跳转端口不在新的 `ports.https` 中；`data.port` |
| `ORIGIN_HOST_HEADER_INVALID`、`ORIGIN_ADDRESS_FORBIDDEN`、`ORIGIN_PROXY_PROTOCOL_S3`、`S3_SECRET_REQUIRED` | 400 | 同 `sites.create` |
| `ORIGIN_GRPC_REQUIRES_HTTP2` | 400 | 修改后的 `grpc` 为 `true` 而 `protocol` 不是 `http2` |
| `ORIGIN_TLS_TRUST_REQUIRES_VERIFY`、`ORIGIN_CA_S3` | 400 | 同 `sites.create`，按修改后的设置与源站检查 |
| `ORIGIN_CA_NOT_FOUND`、`ORIGIN_CLIENT_CA_NOT_FOUND` | 409 | 同 `sites.create` |
| `PURGE_KEY_REQUIRED` | 400 | 开启 PURGE 方法而没有已保存的密钥，也没有 `key` |
| `CACHE_RULE_PRIORITY_DUPLICATE` | 400 | 同 `sites.create` |
| `RULE_INVALID` | 400 | 缓存规则的条件不能编译，或新源站列表去掉了规则使用的源站组 |

### `sites.delete`

`DELETE /sites/{id}` · 写

删除网站及其设置；先计算尚未计算的时间窗的用量；因此不再含任何网站的告警订阅一并删除。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |

响应：`{ revision: [配置版本](#配置版本对象) }`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

### `sites.launch`

`GET /sites/{id}/launch` · 读 · 服务账号 `sites:read`

当场解析网站的每个域名（并行，耗时可达数秒），并给出证书覆盖与交付状态。行为见[上线检查](../../guide/site-management.md#上线检查)。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |

响应：[上线检查](#上线检查对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

### `sites.originHealth`

`GET /sites/{id}/origin-health` · 读

节点上报的源站健康状态（被动与主动检查）。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |

响应：[源站健康](#源站健康对象)`[]`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

### `sites.originQuality`

`GET /sites/{id}/origins/quality` · 读

时间范围内每个源站的回源次数、失败与响应头时间（节点能力 `origin-stats-v1`）。行为见[回源质量](../../guide/origins-and-cache.md#回源质量)。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |
| `range` | query | enum | 否 | `1h` / `6h` / `24h` / `7d` / `30d`，默认 `24h` | 时间范围 |

响应：[回源质量](#回源质量对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

### `sites.features`

`GET /sites/{id}/features` · 读

各项功能现在能否为网站开启：网站所在集群的每个活动节点都上报对应的节点能力时可用。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |

响应：[网站能力](#网站能力对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

### `sites.setCnamePrefix`

`PUT /sites/{id}/cname-prefix` · 写

设置网站 CNAME 目标 `<前缀>.<集群域名>` 的第一段；省略 `prefix` 时生成新的随机前缀。被替换的前缀继续解析 24 小时（自动 DNS 从未发布过它时除外）。发布集群的 DNS 版本（原因 `cname`），不生成配置版本；审计 `site.cname_update`。行为见 [CNAME 前缀](../../guide/domains.md#cname-前缀)。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |
| `prefix` | body | string | 否 | 去首尾空白、转小写后 1–30 个 `[a-z0-9-]`，不以 `-` 开头或结尾；或 UUID | 新前缀。UUID 只接受网站在引入 CNAME 前缀之前的 ID 前缀，且须仍在解析：当前前缀（不变）或仍在 24 小时过渡期内的旧前缀（取回） |

响应：`{ prefix, retired: [{ prefix, expiresAt }] }`：当前前缀与仍在过渡期内的旧前缀（`expiresAt` 为 datetime）。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |
| `CNAME_PREFIX_INVALID` | 400 | UUID 不是网站自己仍在解析的前缀；`data.prefix` |
| `CNAME_PREFIX_CONFLICT` | 409 | 前缀已被网站或 L4 应用使用（含过渡期内的旧前缀），为 `all`、`all-<n>` 或 DNS 绑定的记录名，或自动 DNS 区域中该名称已有非本集群管理的记录；`data.prefix` |

### `sites.starred`

`GET /starred-sites` · 读

调用者（会话用户或 AccessKey 所属用户）加星标的网站。

无参数。

响应：`[{ id, name, domains }]`，最近加星标的在前；`domains` 为 `array<string>`。

### `sites.setStarred`

`PUT /sites/{id}/starred` · 写

为调用者加上或取消星标；不写审计，不发布配置。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |
| `starred` | body | boolean | 是 | — | `true` 加星标，`false` 取消 |

响应：`{ ok: true }`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

## 网站启停

- 停用的网站不下发到节点，其 DNS 记录保留。对停用的网站创建清缓存或预热任务返回 409 `SITE_DISABLED`。
- 状态改变时发布配置版本并写审计：单个网站 `site_enabled` / `site_disabled`，`site.enable` / `site.disable`。
- 启用网站时，用量保护若正以停用网站作为动作，则解除该动作并暂停到本周期结束（见[用量保护](#用量保护)）。
- 行为见[网站启停](../../guide/clusters.md#网站启停)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`sites.setEnabled`](#sitessetenabled) | `PUT /sites/{id}/enabled` | 写；服务账号 `sites:write` |
| [`sites.batchSetEnabled`](#sitesbatchsetenabled) | `POST /sites/batch/enabled` | 写 |

### `sites.setEnabled`

`PUT /sites/{id}/enabled` · 写 · 服务账号 `sites:write`

网站已是请求的状态时返回当前网站与集群的最新版本，不比较 `expectedUpdatedAt`，不生成版本，不写审计。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |
| `enabled` | body | boolean | 是 | — | `true` 启用，`false` 停用 |
| `expectedUpdatedAt` | body | datetime | 否 | — | 调用方读取时网站的 `updatedAt` |

响应：[网站写入结果](#网站写入结果)（不含 `certificateReissue`）；`site.enabled` 为当前状态。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |
| `UPDATED_AT_MISMATCH` | 409 | `expectedUpdatedAt` 与网站当前的 `updatedAt` 不一致；`data.updatedAt` |
| `CLUSTER_SITE_LIMIT` | 409 | 启用后集群已启用的网站超过 512 个；`data.limit` |
| `NODE_CAPABILITY_REQUIRED` | 409 | 服务账号调用，且配置需要集群中某个活动节点缺少的能力；`data.features`、`data.nodes` |

### `sites.batchSetEnabled`

`POST /sites/batch/enabled` · 写

在一个事务内启用或停用多个网站。已是该状态的网站不变、不写审计；其他网站各写一条审计（元数据 `batch` 为请求的网站数），每个集群只发布一次（原因 `sites_enabled` / `sites_disabled`，`count`；集群只有一个网站变化时为 `site_enabled` / `site_disabled`）。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `ids` | body | `array<uuid>` | 是 | 1–100 个，重复项去掉 | 网站 ID |
| `enabled` | body | boolean | 是 | — | 目标状态 |

响应：[批量结果](#批量结果)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 有网站不存在；整个操作不生效 |
| `CLUSTER_SITE_LIMIT` | 409 | 启用后某个集群已启用的网站超过 512 个；`data.limit` |

## 网站标签与批量操作

- 标签只在控制台使用，不发布配置版本。标签名去首尾空白并做 NFC 规范化后为 1–32 个字符（输入最长 256），不含控制字符；不区分大小写比较，与已有标签相同时沿用已有标签的写法，新名称创建标签。每个网站至多 10 个标签。
- 网站的标签改变时审计 `site.tags_update`（元数据 `added`、`removed`、`tags`）；改名审计 `site_tag.rename`，删除审计 `site_tag.delete`。
- 批量操作要么全部完成，要么一个都不改。行为见[标签](../../guide/site-management.md#标签)与[批量操作](../../guide/site-management.md#批量操作)；批量刷新缓存用 [`cacheTasks.create`](#cachetaskscreate)（`type` 为 `site`）。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`sites.setTags`](#sitessettags) | `PUT /sites/{id}/tags` | 写 |
| [`siteTags.list`](#sitetagslist) | `GET /site-tags` | 读 |
| [`siteTags.rename`](#sitetagsrename) | `PATCH /site-tags/{id}` | 写 |
| [`siteTags.delete`](#sitetagsdelete) | `DELETE /site-tags/{id}` | 写 |
| [`sites.batchTags`](#sitesbatchtags) | `POST /sites/batch/tags` | 写 |
| [`sites.batchDelete`](#sitesbatchdelete) | `POST /sites/batch/delete` | 写 |

### `sites.setTags`

`PUT /sites/{id}/tags` · 写

整体替换网站的标签。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |
| `tags` | body | `array<string>` | 是 | ≤10 个；不区分大小写的重复项去掉 | 标签名 |

响应：`{ tags: [{ id, name }] }`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

### `siteTags.list`

`GET /site-tags` · 读

无参数。

响应：`[{ id, name, sites }]`，按名称排序（不区分大小写），含没有网站使用的标签；`sites` 为带该标签的网站数。

### `siteTags.rename`

`PATCH /site-tags/{id}` · 写

为所有网站上的该标签改名。新名称是另一个标签的名称（不区分大小写）时两者合并：带本标签的网站改带那个标签，那个标签改用请求的写法，本标签删除。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 标签 ID |
| `name` | body | string | 是 | 标签名规则 | 新名称 |

响应：`{ id, name, sites }`；合并时为合并后的标签。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_TAG_NOT_FOUND` | 404 | 标签不存在 |

### `siteTags.delete`

`DELETE /site-tags/{id}` · 写

从所有网站移除并删除标签；审计元数据 `sites` 为受影响的网站数。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 标签 ID |

响应：`{ ok: true }`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_TAG_NOT_FOUND` | 404 | 标签不存在 |

### `sites.batchTags`

`POST /sites/batch/tags` · 写

为多个网站加上与移除标签。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `ids` | body | `array<uuid>` | 是 | 1–100 个，重复项去掉 | 网站 ID |
| `add` | body | `array<string>` | 否 | ≤10 个，默认 `[]` | 加上的标签名 |
| `remove` | body | `array<string>` | 否 | ≤10 个，默认 `[]` | 移除的标签名 |

`add` 与 `remove` 至少一个非空；同一名称（不区分大小写）不能同时出现在两边。

响应：[批量结果](#批量结果)；`changed` 为标签有变化的网站，`revisions` 为 `[]`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 有网站不存在 |
| `SITE_TAG_LIMIT` | 400 | 某个网站的标签将超过 10 个；`data.site`、`data.limit` |

### `sites.batchDelete`

`POST /sites/batch/delete` · 写

与 `sites.delete` 相同地删除多个网站；每个网站审计 `site.delete`（元数据 `batch`），每个集群只发布一次（原因 `sites_deleted`，`count`；集群只有一个网站时为 `site_deleted`）。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `ids` | body | `array<uuid>` | 是 | 1–100 个，重复项去掉 | 网站 ID |

响应：[批量结果](#批量结果)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 有网站不存在 |

## 复制设置与克隆

- `parts` 的取值：`cacheRules`、`cacheKey`（缓存键与分片）、`cacheTag`、`compression`、`https`（HTTPS 选项，不含证书与不跳转的域名）、`rules`（含 `rulesBodyLimit`）、`bulkRedirects`、`errorPages`、`waf`、`protection`（Under Attack、CC 策略与挑战设置）、`accessControl`、`authRules`（密钥为目标重新加密）、`originSettings`（源站池设置，不含源站）、`logs`（采样率与日志选项、JA4 日志）、`imageConvert`。复制的部分整体替换目标的该部分；与目标相同的部分不写入。
- 列表部分（`cacheRules`、`rules`、`bulkRedirects`、`errorPages`、`authRules`）的变化以前后条数表示，其他部分以变化的设置数表示。
- 目标缺少设置用到的对象时该目标失败，例如：规则选择的源站组不存在 `ORIGIN_GROUP_UNKNOWN`、目标没有证书却复制 HTTPS 跳转 / HSTS / 客户端证书 `HTTPS_REQUIRES_CERTIFICATE`、跳转端口不是目标的 HTTPS 端口 `HTTPS_REDIRECT_PORT_INVALID`、客户端证书与 HTTP/3 同时开启 `CLIENT_CERTIFICATE_HTTP3`、批量重定向的来源主机不是目标的域名 `BULK_REDIRECT_HOST_UNKNOWN`、访问鉴权范围的域名不是目标的域名 `AUTH_DOMAIN_UNKNOWN`、IP 名单不存在 `IP_LIST_NOT_FOUND`。
- 行为见[复制设置](../../guide/site-management.md#复制设置)与[克隆网站](../../guide/site-management.md#克隆网站)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`sites.copySettingsPreview`](#sitescopysettingspreview) | `GET /sites/{id}/copy-settings` | 读 |
| [`sites.copySettings`](#sitescopysettings) | `POST /sites/{id}/copy-settings` | 写 |
| [`sites.clone`](#sitesclone) | `POST /sites/{id}/clone` | 写 |

### `sites.copySettingsPreview`

`GET /sites/{id}/copy-settings` · 读

对每个目标试运行复制后回滚：不保存、不发布、不写审计。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 源网站 ID |
| `targetIds` | query | `array<uuid>` | 是 | 1–100 个，重复项去掉，不能含 `id`；`targetIds[]=a&targetIds[]=b` | 目标网站 |
| `parts` | query | `array<enum>` | 是 | 1–15 个，取值见上；`parts[]=a&parts[]=b` | 复制的部分 |

响应：[复制预览](#复制预览对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 源网站不存在（目标不存在时只有该目标的 `error` 为 `SITE_NOT_FOUND`） |

### `sites.copySettings`

`POST /sites/{id}/copy-settings` · 写

把源网站的部分设置复制到每个目标，每个目标一个事务：失败的目标保持原设置，其他目标照常保存。成功的目标发布所在集群（原因 `site_settings_copied`，`site`、`source`），审计 `site.settings_copied`（元数据 `source`、`parts`、`changed`、`revision`）。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 源网站 ID |
| `targetIds` | body | `array<uuid>` | 是 | 1–100 个，重复项去掉，不能含 `id` | 目标网站 |
| `parts` | body | `array<enum>` | 是 | 1–15 个，取值见上，按上面的顺序执行 | 复制的部分 |

响应：[复制结果](#复制结果对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 源网站不存在（目标不存在时只有该目标失败） |

### `sites.clone`

`POST /sites/{id}/clone` · 写 · `201`

在源网站的集群中新建网站，带源网站的全部可复制部分、源站（含 S3 凭据，重新加密）、PURGE 方法与密钥、内容设置、维护模式与标签。证书不复制；需要证书的设置（HTTPS 跳转、HSTS、客户端证书、443 以外的 HTTPS 端口）与不跳转的域名随之关闭或去掉。发布（原因 `site_cloned`，`site`、`source`），审计 `site.clone`。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 源网站 ID |
| `name` | body | string | 否 | 去首尾空白后 1–100；省略时为第一个域名的前 100 个字符 | 新网站名称 |
| `domains` | body | `array<string>` | 是 | 同[网站输入](#网站输入)的 `domains` | 新网站的域名 |
| `tags` | body | `array<string>` | 否 | ≤10 个；省略时为源网站的标签 | 标签名 |

响应：[网站写入结果](#网站写入结果)（不含 `certificateReissue`）。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 源网站不存在 |
| `DOMAIN_INVALID` | 400 | 同 `sites.create` |
| `DOMAIN_IN_USE` | 409 | 同 `sites.create` |
| `ORIGIN_ADDRESS_FORBIDDEN` | 400 | 源网站的源站地址已不在平台允许的范围内 |
| `AUTH_DOMAIN_UNKNOWN`、`BULK_REDIRECT_HOST_UNKNOWN`、`ORIGIN_GROUP_UNKNOWN` | 400 | 复制的设置引用了新网站没有的域名或源站组 |
| `CLUSTER_SITE_LIMIT` | 409 | 集群已启用的网站超过 512 个；`data.limit` |

## 缓存任务

- 任务类型：`url`、`prefix`、`site`、`host`、`tag` 清除缓存，`prefetch`、`sitemap` 预热。`host` 与 `tag` 需要节点能力 `purge-tag-v1`，`sitemap` 与预热 `mobile` 变体需要 `prefetch-v2`；集群中有活动节点缺少时任何调用方都返回 409 `NODE_CAPABILITY_REQUIRED`。
- 任务交给涉及集群的每个节点；已禁用的节点记为 `skipped`。任务不发布配置版本；审计 `cache.purge` 或 `cache.prefetch`。
- 行为见[刷新与预热](../../guide/origins-and-cache.md#刷新与预热)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`sites.purgeAll`](#sitespurgeall) | `POST /sites/{id}/purge` | 写 |
| [`cacheTasks.list`](#cachetaskslist) | `GET /cache-tasks` | 读 |
| [`cacheTasks.get`](#cachetasksget) | `GET /cache-tasks/{id}` | 读 |
| [`cacheTasks.create`](#cachetaskscreate) | `POST /cache-tasks` | 写 |

### `sites.purgeAll`

`POST /sites/{id}/purge` · 写

刷新网站的全部缓存，等同 `cacheTasks.create` 的 `{"type":"site","siteIds":["<id>"]}`，但状态码为 200。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |

响应：[缓存任务](#缓存任务对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |
| `SITE_DISABLED` | 409 | 网站已停用 |

### `cacheTasks.list`

`GET /cache-tasks` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `siteId` | query | uuid | 否 | — | 只列出涉及该网站的任务 |
| `page` | query | integer | 否 | ≥1，默认 `1` | 页码 |
| `pageSize` | query | integer | 否 | 1–100，默认 `20` | 每页条数 |

响应：`{ items: [缓存任务](#缓存任务对象)[], total }`，最新的在前。

### `cacheTasks.get`

`GET /cache-tasks/{id}` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 任务 ID |

响应：[缓存任务](#缓存任务对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CACHE_TASK_NOT_FOUND` | 404 | 任务不存在 |

### `cacheTasks.create`

`POST /cache-tasks` · 写 · `201`

清除缓存的任务按节点的方式找网站：在每个集群的已启用网站中按域名优先级查找，几个集群都服务一个主机名时任务包含每个集群的那个网站。预热与站点地图任务只交给一个集群：在全部集群的网站中按优先级选出的那个网站所在的集群。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `type` | body | enum | 是 | `url` / `prefix` / `site` / `prefetch` / `host` / `tag` / `sitemap` | 任务类型 |
| `urls` | body | `array<string>` | 否 | ≤500 个，每个去首尾空白后 1–2048，默认 `[]`；`url`、`prefix`、`prefetch` 至少一个，`sitemap` 恰好一个 | `http(s)` 绝对 URL（不含账号；主机为主机名）。`url`、`prefetch`：URL；`prefix`：URL 前缀（不含查询串）；`sitemap`：站点地图 URL。片段被去掉 |
| `siteIds` | body | `array<uuid>` | 否 | ≤100 个，默认 `[]`；`site`、`tag` 至少一个 | `site`：整站刷新的网站；`tag`：按标签刷新的网站 |
| `hosts` | body | `array<string>` | 否 | ≤500 个，每个去首尾空白后 1–253，默认 `[]`；`host` 至少一个 | `host`：刷新这些主机名的全部 URL；不带端口或通配符，转小写，去掉末尾的点 |
| `tags` | body | `array<string>` | 否 | ≤500 个，每个最长 1024，默认 `[]`；`tag` 至少一个 | `tag`：Cache-Tag 值；去首尾空白、ASCII 字母转小写后须为 1–128 字节可打印 ASCII，不含逗号 |
| `variants` | body | `array<enum>` | 否 | `desktop` / `mobile`，1–2 个，默认 `["desktop"]` | `prefetch`、`sitemap`：预热的设备变体；`mobile` 只在缓存键区分设备类型时不同 |
| `maxUrls` | body | integer | 否 | 1–10000，默认 `1000` | `sitemap`：最多预热的 URL 数（每个 URL 按每个变体各预热一次） |

响应：[缓存任务](#缓存任务对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | `siteIds` 中有网站不存在 |
| `SITE_DISABLED` | 409 | 任务涉及的网站已停用 |
| `CACHE_TASK_URL_INVALID` | 400 | URL 不是 `http(s)` 绝对 URL、带账号、主机不是主机名，或前缀带查询串；`data.urls`（前 5 个） |
| `CACHE_TASK_HOST_INVALID` | 400 | 主机名带端口、通配符或不合法；`data.hosts` |
| `CACHE_TASK_TAG_INVALID` | 400 | 标签不符合规则；`data.tags` |
| `CACHE_TASK_HOST_UNKNOWN` | 400 | URL 或 `hosts` 的主机名不属于任何网站；`data.hosts` |
| `NODE_CAPABILITY_REQUIRED` | 409 | 涉及的集群中有活动节点缺少 `purge-tag-v1` 或 `prefetch-v2`；`data.features`、`data.nodes` |

## HTTPS

- `https.update` 发布网站所在集群（原因 `certificate_updated`），审计 `site.https_update`。
- 证书本身的上传、申请与续期见 [API：证书](certificates.md)；行为见[配置网站 HTTPS](../../guide/https.md#配置网站-https)、[一键启用 HTTPS](../../guide/https.md#一键启用-https)与[压缩](../../guide/https.md#压缩)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`https.get`](#httpsget) | `GET /sites/{id}/https` | 读 |
| [`https.update`](#httpsupdate) | `PUT /sites/{id}/https` | 写 |
| [`https.check`](#httpscheck) | `GET /sites/{id}/https/check` | 读 |

### `https.get`

`GET /sites/{id}/https` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |

响应：[HTTPS 设置](#https-设置)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

### `https.update`

`PUT /sites/{id}/https` · 写

整体替换网站的证书、HTTPS 与压缩设置；省略的字段取默认值。`certificateId` 为 `null` 时，`redirectPort` 改为 443，`additionalCertificateIds` 清空，`clientCertificate.mode` 改为 `off`。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |
| `settings` | body | [HTTPS 设置](#https-设置) | 是 | — | 新设置 |

响应：保存后的 [HTTPS 设置](#https-设置)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |
| `CERTIFICATE_NOT_FOUND` | 404 | 证书不存在 |
| `CERTIFICATE_UNAVAILABLE` | 409 | 证书尚未签发或已过期 |
| `CERTIFICATE_CHAIN_EXPLICIT_CURVE`、`CERTIFICATE_KEY_EXPLICIT_CURVE` | 400 | 节点不能加载该证书（EC 密钥未写曲线名） |
| `CERTIFICATE_DOMAIN_MISMATCH` | 400 | 网站有域名不被任何一张证书覆盖；`data.domains` |
| `CLIENT_CERTIFICATE_HTTP3` | 400 | 客户端证书与 `http3` 同时开启 |
| `CLIENT_CA_INVALID` | 400 | `clientCertificate.caPem` 不是 1–10 张当前有效的 CA 证书 |
| `HTTPS_REDIRECT_PORT_INVALID` | 400 | `redirectPort` 不是 443 或网站的 HTTPS 端口；`data.port` |
| `HTTPS_REDIRECT_DOMAIN_INVALID` | 400 | `redirectExcludedDomains` 有网站没有的域名；`data.domains` |
| `SITE_PORTS_EMPTY` | 400 | 去掉证书后网站不会在任何端口上服务 |

### `https.check`

`GET /sites/{id}/https/check` · 读

一键启用 HTTPS 会发出的证书申请与阻碍它的全部原因。不保存任何内容。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |
| `ca` | query | enum | 否 | `letsencrypt` / `zerossl` / `google` / `custom`；省略时为 `certificates.settings` 的 `defaultCa` | 检查其 CAA 许可的 CA |

响应：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `request.name` | string | 证书名称（网站名称） |
| `request.names` | `array<string>` | 申请的名称：网站的域名，`.a.com` 按 `*.a.com`，正则域名不计 |
| `request.email` | string | 最近一个 ACME 账户或申请的邮箱，否则为运营者的邮箱 |
| `request.challenge` | enum | `http01`；网站有泛域名或后缀域名时为 `dns01` |
| `request.dnsCredentialId` | uuid | `dns01` 时区域覆盖全部名称的第一个 DNS 凭据，或 `null` |
| `blockers` | `array<object>` | 全部阻碍，每项为 `code` 与参数：`nodes_offline`（`cluster`：集群没有在线的活动节点）、`nodes_lack_http01`（`nodes`：在线节点缺少 `http01-v1`）、`dns_not_pointing`（`name`、`pointing`：`unresolved` / `elsewhere`）、`dns_credential_missing`（`names`）、`dns_credential_failed`（`credential`、`error`：API 错误代码）、`caa_forbidden`（`name`）、`no_certificate_names`（网站只有正则域名） |
| `certificates` | `array<object>` | 已签发、未过期且覆盖网站全部域名的证书 `{ id, name }` |

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

## 错误页与维护模式

- `errorPages.update` 发布网站所在集群（原因 `site_error_pages_updated`），审计 `site.error_pages_update`；`maintenance.update` 发布（原因 `site_maintenance_updated`），审计 `site.maintenance_update`。审计只记录状态码与模板字节数，不记录模板。
- 节点能力：403、429、502、503、504 的模板页需要 `error-pages-v1`；其他状态码、`4xx` / `5xx`、跳转页面、`responseStatus` 与维护模式需要 `site-content-v1`；模板含 `{{time}}` 或 `{{path}}` 需要 `rules-v3`。
- 平台错误页（未知域名、已停用网站）的过程在系统设置中（`settings.errorPages`、`settings.setErrorPages`）。行为见[错误页](../../guide/error-pages.md)与[维护模式](../../guide/error-pages.md#维护模式)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`errorPages.get`](#errorpagesget) | `GET /sites/{id}/error-pages` | 读 |
| [`errorPages.update`](#errorpagesupdate) | `PUT /sites/{id}/error-pages` | 写 |
| [`maintenance.get`](#maintenanceget) | `GET /sites/{id}/maintenance` | 读 |
| [`maintenance.update`](#maintenanceupdate) | `PUT /sites/{id}/maintenance` | 写 |

### `errorPages.get`

`GET /sites/{id}/error-pages` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |

响应：[错误页](#错误页对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

### `errorPages.update`

`PUT /sites/{id}/error-pages` · 写

整体替换网站的错误页；没有页面的状态码使用节点内置页面。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |
| `pages` | body | `array<object>` | 是 | ≤13 个，每个状态码至多一个 | 页面 |
| `pages[].status` | body | integer 或 enum | 是 | 400、401、403、404、405、410、429、500、502、503、504，或 `"4xx"` / `"5xx"` | 状态码；`4xx` / `5xx` 用于没有自己页面的同类状态码 |
| `pages[].template` | body | string | 否 | 默认 `""`；最大 65536 字节（UTF-8） | HTML 模板；与 `redirectUrl` 二选一 |
| `pages[].redirectUrl` | body | string | 否 | 去首尾空白，默认 `""`；1–2048 个不含空格的可打印 ASCII | 302 跳转的目标：不含账号的 `http(s)` 绝对 URL，或以单个 `/` 开头的路径；占位符只能是 `{{status}}`、`{{request_id}}`（不能在主机或端口中），`%` 后须为两位十六进制 |
| `pages[].responseStatus` | body | integer | 否 | 0 或 200–599，默认 `0` | 模板页发送的状态码，0 保持原状态码；跳转页面只能为 0 |
| `interceptOriginErrors` | body | boolean | 否 | 默认 `false` | 也替换状态码有页面的源站响应 |
| `expectedUpdatedAt` | body | datetime | 否 | — | 调用方读取时的 `updatedAt` |

响应：[错误页](#错误页对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |
| `ERROR_PAGE_TOO_LARGE` | 400 | 模板超过 65536 字节；`data.status`、`data.limit` |
| `UPDATED_AT_MISMATCH` | 409 | `expectedUpdatedAt` 不一致；`data.updatedAt` |

### `maintenance.get`

`GET /sites/{id}/maintenance` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |

响应：[维护模式](#维护模式对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

### `maintenance.update`

`PUT /sites/{id}/maintenance` · 写

整体替换维护模式设置；关闭时设置保留。开启后节点对网站的请求返回 503（`allowedCidrs` 的来源、`allowedPathPrefixes` 下的路径与源站的 HTTP-01 请求除外），不从缓存返回。关闭维护模式时，用量保护若正以维护模式作为动作，则解除该动作并暂停到本周期结束。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |
| `enabled` | body | boolean | 是 | — | 开启维护模式 |
| `template` | body | string | 否 | 默认 `""`；最大 65536 字节（UTF-8） | 维护页模板，可用错误页的占位符；空为节点内置维护页 |
| `retryAfterSeconds` | body | integer | 否 | 0–86400，默认 `0` | `Retry-After` 秒数，0 不发送 |
| `allowedCidrs` | body | `array<string>` | 否 | ≤64 个，每个去首尾空白后最长 64，默认 `[]` | 不受影响的地址或 CIDR；清除主机位，IPv4 映射地址按 IPv4 保存，短于 /96 的映射前缀被拒；重复项去掉 |
| `allowedPathPrefixes` | body | `array<string>` | 否 | ≤32 个，默认 `[]`；以 `/` 开头，不含空白、`?`、`#` 与控制字符，最长 1024 字节（UTF-8） | 不受影响的路径前缀；重复项去掉 |
| `expectedUpdatedAt` | body | datetime | 否 | — | 调用方读取时的 `updatedAt` |

响应：[维护模式](#维护模式对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |
| `ERROR_PAGE_TOO_LARGE` | 400 | 模板超过 65536 字节；`data.status` 为 503，`data.limit` |
| `UPDATED_AT_MISMATCH` | 409 | `expectedUpdatedAt` 不一致；`data.updatedAt` |

## 访问鉴权

- 规则按数组顺序匹配：请求由范围匹配的第一条启用的规则检查，在规则阶段与缓存查找之前。Basic 密码哈希与 URL 签名密钥只写，响应只说明是否设置。
- `authRules.update` 与 `authRules.forgetIdentityHeaders` 发布网站所在集群（原因 `site_auth_updated`），审计 `site.auth_update`、`site.auth_identity_forget`；`authRules.signUrl` 审计 `site.auth_sign_url`（规则、路径与到期时间，不含签名）。审计不含任何密钥。
- 有启用的规则时配置需要节点能力 `access-auth-v1`。行为见[访问控制](../../guide/access-control.md)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`authRules.get`](#authrulesget) | `GET /sites/{id}/auth-rules` | 读 |
| [`authRules.update`](#authrulesupdate) | `PUT /sites/{id}/auth-rules` | 写 |
| [`authRules.forgetIdentityHeaders`](#authrulesforgetidentityheaders) | `POST /sites/{id}/auth-rules/forget-identity-headers` | 写 |
| [`authRules.signUrl`](#authrulessignurl) | `POST /sites/{id}/auth-rules/{ruleId}/sign` | 写 |
| [`authRules.failures`](#authrulesfailures) | `GET /sites/{id}/auth-rules/failures` | 读 |

### `authRules.get`

`GET /sites/{id}/auth-rules` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |

响应：[访问鉴权](#访问鉴权对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

### `authRules.update`

`PUT /sites/{id}/auth-rules` · 写

整体替换网站的规则。带 `id` 的规则沿用它已保存的密码与密钥中输入省略的部分；密钥变化的规则获得新的密钥版本。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |
| `rules` | body | array<[访问鉴权规则输入](#访问鉴权规则输入)> | 是 | ≤16 条 | 规则，按顺序匹配 |
| `expectedUpdatedAt` | body | datetime | 否 | — | 调用方读取时的 `updatedAt` |

响应：[访问鉴权](#访问鉴权对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |
| `UPDATED_AT_MISMATCH` | 409 | `expectedUpdatedAt` 不一致；`data.updatedAt` |
| `AUTH_RULE_NOT_FOUND` | 404 | 规则 `id` 不属于该网站或重复 |
| `AUTH_DOMAIN_UNKNOWN` | 400 | `scope.domains` 有网站没有的域名；`data.domain` |
| `ORIGIN_ADDRESS_FORBIDDEN` | 400 | 转发鉴权服务的主机是平台未允许的特殊用途地址；`data.address`、`data.range` |
| `AUTH_PASSWORD_REQUIRED` | 400 | Basic 新用户没有 `password`；`data.user` |
| `AUTH_KEY_REQUIRED` | 400 | URL 鉴权规则没有 `primaryKey` 且没有已保存的主密钥 |

### `authRules.forgetIdentityHeaders`

`POST /sites/{id}/auth-rules/forget-identity-headers` · 写

节点不再从请求中删除这些以前规则的身份头（`formerIdentityHeaders` 中的名称；当前规则（含停用的）设置的名称除外）。没有可忘记的名称时不发布、不写审计，返回当前状态。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |
| `names` | body | `array<string>` | 是 | 1–64 个；小写后为 1–64 个 token 字符，不能是受保护的头或以 `x-edgeweir-` 开头 | 头名称 |
| `expectedUpdatedAt` | body | datetime | 否 | — | 调用方读取时的 `updatedAt` |

响应：[访问鉴权](#访问鉴权对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |
| `UPDATED_AT_MISMATCH` | 409 | `expectedUpdatedAt` 不一致；`data.updatedAt` |

### `authRules.signUrl`

`POST /sites/{id}/auth-rules/{ruleId}/sign` · 写 · 不接受 `Idempotency-Key`

用 URL 鉴权规则的主密钥签名；由控制台计算，不保存，不发送给节点。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |
| `ruleId` | path | uuid | 是 | — | 规则 ID |
| `url` | body | string | 是 | 去首尾空白后 1–4096 | 以单个 `/` 开头的路径，或主机属于网站域名的 `http(s)` URL（不含账号） |
| `validitySeconds` | body | integer | 否 | 1–31536000；默认为规则的 `validitySeconds` | 有效期，不能超过规则的有效期 |

响应：`{ url, expiresAt }`：签名后的 URL（输入为完整 URL 时带协议与主机）与到期时间（datetime）。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |
| `AUTH_RULE_NOT_FOUND` | 404 | 规则不属于该网站 |
| `AUTH_RULE_NOT_URL` | 400 | 规则不是 URL 鉴权（`url_a`–`url_d`） |
| `AUTH_KEY_REQUIRED` | 400 | 规则没有主密钥 |
| `AUTH_SIGN_VALIDITY` | 400 | `validitySeconds` 超过规则的有效期；`data.max` |
| `AUTH_SIGN_URL_INVALID` | 400 | `url` 不是路径，也不是网站域名的 `http(s)` URL |

### `authRules.failures`

`GET /sites/{id}/auth-rules/failures` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |
| `range` | query | enum | 否 | `1h` / `6h` / `24h` / `7d` / `30d`，默认 `24h` | 时间范围 |

响应：`{ requests, unsupportedNodes }`：时间范围内被访问鉴权拒绝的请求数（number），以及集群中不统计它的活动节点数（integer，缺少 `access-auth-v1`）。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

## 访问控制

- 本站名单、防盗链、UA 名单、CORS、地区、WebSocket 来源与空闲超时、安全响应头与编码路径例外。各项关闭时设置保留；从未保存的网站返回默认值。
- `accessControl.update` 发布网站所在集群（原因 `site_access_control_updated`），审计 `site.access_control_update`（元数据 `parts`，以及各项的开关与条目数，不含名单本身）。
- 有开启的项时配置需要节点能力 `access-control-v1`；`encodedPaths` 需要 `encoded-path-exemptions-v1`。行为见[访问控制](../../guide/access-control.md)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`accessControl.get`](#accesscontrolget) | `GET /sites/{id}/access-control` | 读 |
| [`accessControl.update`](#accesscontrolupdate) | `PATCH /sites/{id}/access-control` | 写 |

### `accessControl.get`

`GET /sites/{id}/access-control` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |

响应：[访问控制](#访问控制对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

### `accessControl.update`

`PATCH /sites/{id}/access-control` · 写

只替换请求中出现的项，其他项不变；出现的项整体替换，项内省略的字段取默认值。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |
| `siteLists`、`hotlink`、`userAgents`、`cors`、`geo`、`websocket`、`securityHeaders`、`encodedPaths` | body | object | 否 | 字段见[访问控制](#访问控制对象)；省略时不变 | 各项设置 |
| `expectedUpdatedAt` | body | datetime | 否 | — | 调用方读取时的 `updatedAt` |

响应：[访问控制](#访问控制对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |
| `UPDATED_AT_MISMATCH` | 409 | `expectedUpdatedAt` 不一致；`data.updatedAt` |
| `CORS_CREDENTIALS_WILDCARD` | 400 | `cors.allowCredentials` 为 `true` 且 `allowedOrigins` 含 `*` |
| `IP_LIST_NOT_FOUND` | 404 | `siteLists` 中的 IP 名单不存在 |
| `SITE_LIST_CONFLICT` | 400 | 同一名单同时在 `blockListIds` 与 `allowListIds` 中；`data.lists` |

## 图片格式转换

- 节点按请求的 `Accept` 返回 AVIF、WebP 或原图，只转换缓存规则缓存的 JPEG 与 PNG 响应；转换失败、超出限制或不更小时返回原图。
- `imageConvert.update` 发布网站所在集群（原因 `site_updated`；节点配置不变时，例如关闭期间修改，不生成新版本），审计 `site.image_convert_update`（元数据 `changed`、`enabled`）。开启的设置需要节点能力 `image-convert-v1`。
- 行为见[图片格式转换](../../guide/image-convert.md)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`imageConvert.get`](#imageconvertget) | `GET /sites/{id}/image-convert` | 读 |
| [`imageConvert.update`](#imageconvertupdate) | `PUT /sites/{id}/image-convert` | 写 |
| [`imageConvert.savings`](#imageconvertsavings) | `GET /sites/{id}/image-convert/savings` | 读 |

### `imageConvert.get`

`GET /sites/{id}/image-convert` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |

响应：设置对象，字段同 `imageConvert.update` 的请求体（不含 `id`）；从未保存时为默认值。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

### `imageConvert.update`

`PUT /sites/{id}/image-convert` · 写

整体替换设置；全部字段必填，关闭时也按下列条件检查。不接受 `expectedUpdatedAt`。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |
| `enabled` | body | boolean | 是 | 默认值 `false` | 开启转换 |
| `webp` | body | boolean | 是 | 默认值 `true`；`webp`、`avif` 至少一个为 `true` | 提供 WebP |
| `avif` | body | boolean | 是 | 默认值 `false` | 提供 AVIF |
| `webpQuality` | body | integer | 是 | 1–100，默认值 `80` | WebP 质量 |
| `avifQuality` | body | integer | 是 | 1–100，默认值 `50` | AVIF 质量 |
| `jpeg` | body | boolean | 是 | 默认值 `true`；`jpeg`、`png` 至少一个为 `true` | 转换 `image/jpeg` |
| `png` | body | boolean | 是 | 默认值 `true` | 转换 `image/png` |
| `minSize` | body | integer | 是 | 0–67108864，默认值 `1024`；不大于 `maxSize` | 转换的原图最小字节数 |
| `maxSize` | body | integer | 是 | 1–67108864，默认值 `10485760` | 转换的原图最大字节数 |
| `maxPixels` | body | integer | 是 | 1–50000000，默认值 `16000000` | 转换的图片最大像素数 |

“默认值”为从未保存的网站返回的值。

响应：保存的设置（不含 `id`）。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

### `imageConvert.savings`

`GET /sites/{id}/image-convert/savings` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |
| `range` | query | enum | 否 | `1h` / `6h` / `24h` / `7d` / `30d`，默认 `24h` | 时间范围 |

响应：`{ bytesSaved, unsupportedNodes }`：时间范围内以变体完整返回的 GET 200 响应（含缓存命中）比原图少的字节数之和（number），以及集群中不转换的活动节点数（integer，缺少 `image-convert-v1`）。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

## 用量保护

- 网站发送的字节数、请求数与带宽的上限，在预警阈值与 100% 时告警，100% 时可开启维护模式或停用网站。每分钟按节点的统计检查一次；设置在下一次检查（1 分钟内）生效。
- 审计：`site.usage_guard_update`（元数据 `from`、`to`）、`site.usage_guard_delete`、`site.usage_guard_restore`；解除动作时发布配置版本（原因 `usage_limit_released`），删除设置时另审计 `site.usage_guard_release`。系统执行与解除动作时为 `usage_limit_reached` / `usage_limit_released`，`site.usage_guard_apply` / `site.usage_guard_release`。
- 行为见[用量保护](../../guide/usage-protection.md)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`usageGuard.get`](#usageguardget) | `GET /sites/{id}/usage-guard` | 读 |
| [`usageGuard.update`](#usageguardupdate) | `PUT /sites/{id}/usage-guard` | 写 |
| [`usageGuard.delete`](#usageguarddelete) | `DELETE /sites/{id}/usage-guard` | 写 |
| [`usageGuard.restore`](#usageguardrestore) | `POST /sites/{id}/usage-guard/restore` | 写 |

### `usageGuard.get`

`GET /sites/{id}/usage-guard` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |

响应：[用量保护](#用量保护对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

### `usageGuard.update`

`PUT /sites/{id}/usage-guard` · 写

新建或整体替换设置，并取消手动恢复带来的暂停（`pausedUntil` 清空）。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |
| [用量保护设置](#用量保护设置)的字段 | body | — | — | 见该表 | 设置 |
| `expectedUpdatedAt` | body | datetime | 否 | — | 调用方读取时的 `updatedAt` |

响应：[用量保护](#用量保护对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |
| `UPDATED_AT_MISMATCH` | 409 | `expectedUpdatedAt` 不一致；`data.updatedAt` |

### `usageGuard.delete`

`DELETE /sites/{id}/usage-guard` · 写

删除设置，并解除它正在执行的动作。没有设置时不做任何事。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |

响应：[用量保护](#用量保护对象)（`settings` 为 `null`）。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

### `usageGuard.restore`

`POST /sites/{id}/usage-guard/restore` · 写

解除正在执行的动作，本周期结束前不再执行（告警照常）。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |

响应：[用量保护](#用量保护对象)；`pausedUntil` 为本周期结束时间。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |
| `USAGE_GUARD_NOT_HELD` | 409 | 没有设置，或没有正在执行的动作 |

## 自动缓解

- 节点对网站的 CC 级别达到 `threshold` 时，系统开启网站的 Under Attack（使用网站自己的挑战类型）并发布（原因 `auto_mitigation_started`，审计 `site.auto_mitigation_apply`）；级别最后一次达到 `threshold` 后保持 `durationMinutes` 分钟，到期时关闭（`auto_mitigation_ended`，`site.auto_mitigation_release`）。未设置时不启用。
- 发布失败（例如 `NODE_CAPABILITY_REQUIRED`）时回滚，错误码记入 `lastError`，下一分钟重试。`protection.update` 修改 `underAttack` 视为手动操作：开启即接管，关闭即结束并暂停。
- 审计：`site.auto_mitigation_update`（元数据 `from`、`to`）、`site.auto_mitigation_restore`。行为见[自动缓解](../../guide/attack-dashboard.md#自动缓解)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`autoMitigation.get`](#automitigationget) | `GET /sites/{id}/auto-mitigation` | 读 |
| [`autoMitigation.update`](#automitigationupdate) | `PUT /sites/{id}/auto-mitigation` | 写 |
| [`autoMitigation.restore`](#automitigationrestore) | `POST /sites/{id}/auto-mitigation/restore` | 写 |

### `autoMitigation.get`

`GET /sites/{id}/auto-mitigation` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |

响应：[自动缓解](#自动缓解对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

### `autoMitigation.update`

`PUT /sites/{id}/auto-mitigation` · 写

新建或整体替换设置，从下一次检查（1 分钟内）生效，并清除 `paused` 与 `lastError`。正在保持 Under Attack 时：设为禁用立即关闭它（发布 `auto_mitigation_ended`，审计 `site.auto_mitigation_release`）；缩短 `durationMinutes` 时到期时间不晚于现在加新的时长。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |
| `enabled` | body | boolean | 否 | 默认 `true` | 启用 |
| `threshold` | body | enum | 否 | `cookie302` / `js` / `pow` / `captcha`，默认 `pow` | 触发的 CC 级别 |
| `durationMinutes` | body | integer | 否 | 5–1440，默认 `30` | 级别最后一次达到触发级别后保持的分钟数 |
| `expectedUpdatedAt` | body | datetime | 否 | — | 调用方读取时的 `updatedAt` |

响应：[自动缓解](#自动缓解对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |
| `UPDATED_AT_MISMATCH` | 409 | `expectedUpdatedAt` 不一致；`data.updatedAt` |

### `autoMitigation.restore`

`POST /sites/{id}/auto-mitigation/restore` · 写

立即结束：关闭自动缓解保持的 Under Attack（已关闭时只写审计），级别降到触发级别以下之前不再开启（`paused` 为 `true`）。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 网站 ID |

响应：[自动缓解](#自动缓解对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |
| `AUTO_MITIGATION_NOT_ACTIVE` | 409 | 自动缓解没有保持 Under Attack |

## 对象

### 网站对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 网站 ID |
| `name` | string | 名称 |
| `enabled` | boolean | 是否启用；停用的网站不下发到节点 |
| `usageGuardHeld` | enum | 用量保护正在执行的动作：`maintenance` / `disable`，或 `null` |
| `clusterId` | uuid | 集群 ID |
| `clusterName` | string | 集群名称 |
| `domains` | `array<string>` | 域名，ASCII（Punycode）形式：`a.com`、`*.a.com`、`.a.com`、`~正则` |
| `cnamePrefix` | string | CNAME 目标 `<前缀>.<集群域名>` 的第一段 |
| `tags` | `array<object>` | 标签 `{ id, name }` |
| `origins` | array<[源站](#源站对象)> | 源站，按保存顺序 |
| `cacheRules` | array<[缓存规则](#缓存规则对象)> | 缓存规则 |
| `originSettings` | [源站池设置](#源站池设置) | 全部字段 |
| `cacheSettings` | [缓存设置](#缓存设置) | 全部字段；`purgeMethod` 为 `{ enabled, keySet }`，不返回密钥 |
| `contentSettings` | [内容设置](#内容设置) | 全部字段 |
| `cacheGeneration` | integer | 节点配置中的缓存代数；全站刷新不改变它 |
| `ports` | object | 监听端口 `{ http: integer[], https: integer[] }`；HTTPS 端口只在有证书时服务 |
| `delivery` | [交付状态](#交付状态对象) | 网站配置在在线节点上的生效情况 |
| `createdAt` | datetime | 创建时间 |
| `updatedAt` | datetime | 修改时间 |

### 源站对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 源站 ID |
| `address` | string | 主机名或 IP |
| `port` | integer | 端口 |
| `scheme` | enum | `http` / `https` |
| `weight` | integer | 权重 |
| `backup` | boolean | 备用源站 |
| `hostHeader` | string | 发往源站的 Host；空为保留请求的 Host |
| `sni` | string | HTTPS 源站的 TLS 服务器名；空为由 Host 或地址推出 |
| `s3` | object | `{ region, bucket, accessKeyId }`，不返回密钥；非 S3 源站为 `null` |
| `group` | string | 源站组；空为默认组 |
| `proxyProtocolVersion` | integer | 发送的 PROXY protocol 版本，0 为不发送 |

### 缓存规则对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 规则 ID |
| `priority` | integer | 优先级，升序执行 |
| `expression` | string | 请求条件；`true` 匹配所有请求 |
| `pathPrefixes`、`paths`、`extensions` | `array<string>` | 条件的结构化形式（表达式有该形式时），否则为空 |
| `statusCodes` | `array<integer>` | 响应状态码；空为任何可缓存的状态码 |
| `minSizeBytes`、`maxSizeBytes` | integer | 响应大小范围，0 为不限 |
| `action` | enum | `cache` / `bypass` |
| `edgeTtlSeconds` | integer | 边缘缓存时间 |
| `originCacheControl` | enum | `override` / `respect` |
| `staleWhileRevalidateSeconds`、`staleIfErrorSeconds` | integer | 过期内容的使用时间 |
| `cacheAuthorized` | boolean | 缓存带 `Authorization` 的请求的响应 |
| `browserTtlSeconds` | integer | 发给客户端的 `max-age`，0 为保留源站的 |
| `cacheSetCookie` | boolean | 缓存带 `Set-Cookie` 的响应 |

### 交付状态对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `state` | enum | `disabled`：已停用；`pending`：没有在线节点运行该网站；`partial`：部分在线节点运行旧版本或数据面异常；`live`：全部在线节点运行最新版本 |
| `totalNodes` | integer | 集群的在线活动节点数 |
| `servingNodes` | integer | 其中已应用的配置含该网站（任意版本）的节点数；停用的网站为仍在运行它的节点数 |
| `currentNodes` | integer | 其中运行该网站最新版本且数据面正常的节点数 |
| `canary` | object | 集群的配置金丝雀让金丝雀外的节点暂不获得最新版本时为 `{ endsAt, autoPromote }`（窗口结束时间；结束时是否自动推进到全部节点），否则为 `null` |

### 配置版本对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `clusterId` | uuid | 集群 ID |
| `revision` | integer | 版本号 |
| `contentHash` | string | 配置内容哈希 |
| `siteCount` | integer | 配置中的网站数 |
| `reason` | string | 英文原因 |
| `reasonCode` | string | 原因代码；原因代码出现前的版本为空 |
| `reasonParams` | object | 原因参数，值为 string 或 number |
| `createdAt` | datetime | 创建时间 |

### 网站写入结果

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `site` | [网站](#网站对象) | 写入后的网站 |
| `revision` | [配置版本](#配置版本对象) | 集群的配置版本 |
| `certificateReissue` | object | 只出现在 `sites.update`：网站的 ACME 证书因新增域名重新签发时为 `{ id, name }` |

### 网站输入

`sites.create` 的请求体。

| 字段 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `name` | string | 否 | 去首尾空白后 1–100；省略时为 `domains[0]` 的前 100 个字符 | 名称 |
| `clusterId` | uuid | 否 | 省略时为最早创建的集群 | 集群 |
| `domains` | `array<string>` | 是 | 1–50 个，每个最长 1024；`~正则` 至多 10 个；重复项去掉 | `a.com`、`*.a.com`（左侧一级）、`.a.com`（任意层级子域名，不含 `a.com`）或 `~正则`（对小写 Host 整串匹配）；Unicode 主机名按 UTS #46 转为 Punycode 保存。写法见[域名写法](../../guide/domains.md#域名写法) |
| `origins` | array<[源站输入](#源站输入)> | 是 | 1–32 个，至少一个在默认组（`group` 为空） | 源站，按顺序保存 |
| `cacheRules` | array<[缓存规则输入](#缓存规则输入)> | 否 | ≤64 条，默认 `[]` | 缓存规则 |
| `originSettings` | [源站池设置](#源站池设置) | 否 | 省略的字段取默认值 | 源站池设置 |
| `cacheSettings` | [缓存设置](#缓存设置) | 否 | 省略的字段取默认值 | 缓存设置 |
| `ports` | object | 否 | 默认 `{ "http": [80], "https": [443] }` | 监听端口 |
| `ports.http` | `array<integer>` | 是 | ≤17 个，1–65535；去重并升序 | 80 或集群的额外 HTTP 端口 |
| `ports.https` | `array<integer>` | 是 | ≤17 个，1–65535；去重并升序 | 443 或集群的额外 HTTPS 端口；443 以外的端口需要证书 |
| `contentSettings` | [内容设置](#内容设置) | 否 | 省略的字段取默认值 | 内容设置 |
| `tags` | `array<string>` | 否 | ≤10 个，默认 `[]`；标签名规则见[网站标签与批量操作](#网站标签与批量操作) | 标签名 |

### 源站输入

| 字段 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `address` | string | 是 | 去首尾空白后 1–253；主机名或 IPv4 / IPv6 字面量（不带端口与方括号）；最后一级不能是数字 | 源站地址；特殊用途 IP 与 localhost 需在平台允许列表中 |
| `port` | integer | 否 | 1–65535；省略时 `http` 为 80，`https` 为 443 | 端口 |
| `scheme` | enum | 否 | `http` / `https`，默认 `http` | 协议 |
| `weight` | integer | 否 | 1–100，默认 `1` | 权重 |
| `backup` | boolean | 否 | 默认 `false` | 备用源站 |
| `hostHeader` | string | 否 | 去首尾空白后最长 259，默认 `""` | 发往源站的 Host：空为保留请求的 Host；主机名或 IP，可带端口（IPv6 带端口时加方括号） |
| `sni` | string | 否 | 去首尾空白、转小写后最长 253 的主机名，默认 `""` | HTTPS 源站的 TLS 服务器名；空为由 Host 或地址推出 |
| `s3` | object | 否 | 默认 `null` | S3 兼容对象存储：请求按 AWS Signature V4 签名 |
| `s3.region` | string | 是 | 转小写后匹配 `[a-z0-9][a-z0-9-]{0,63}` | 区域 |
| `s3.bucket` | string | 否 | 默认 `""`；3–63 个 `[a-z0-9.-]`，首尾为字母或数字 | 路径形式的存储桶；源站地址已含存储桶时为空 |
| `s3.accessKeyId` | string | 是 | 去首尾空白后 1–128 | 访问密钥 ID |
| `s3.secretAccessKey` | string | 否 | 1–256 | 只写；省略时沿用同一 `accessKeyId` 已保存的密钥，新的 `accessKeyId` 必填 |
| `group` | string | 否 | 0–32 个 `[a-z0-9_-]`，默认 `""` | 源站组；空为默认组，其他组只由源站规则选择 |
| `proxyProtocolVersion` | integer | 否 | 0–2，默认 `0`；S3 源站只能为 0 | 每个连接开头发送的 PROXY protocol 版本（节点能力 `origin-proxy-protocol-v1`） |

### 缓存规则输入

| 字段 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `priority` | integer | 否 | 0–10000，网站内唯一；省略时为（序号 + 1）× 10 | 升序执行 |
| `expression` | string | 否 | 最长 16384，默认 `""` | 请求条件（`cache` 阶段，按客户端的原始请求求值）；空时以下三个列表为条件 |
| `pathPrefixes` | `array<string>` | 否 | ≤32 个，默认 `[]`；以 `/` 开头，最长 1024，不含空白 | 路径前缀 |
| `paths` | `array<string>` | 否 | ≤32 个，默认 `[]`；规则同上 | 精确路径 |
| `extensions` | `array<string>` | 否 | ≤64 个，默认 `[]`；转小写、去掉开头的点后为 `[a-z0-9]{1,16}` | 扩展名 |
| `statusCodes` | `array<integer>` | 否 | ≤16 个，100–599，默认 `[]` | 响应状态码；空为任何可缓存的状态码 |
| `minSizeBytes` | integer | 否 | 0–9007199254740991，默认 `0` | 响应最小字节数，0 为不限 |
| `maxSizeBytes` | integer | 否 | 0–9007199254740991，默认 `0`；非 0 时不小于 `minSizeBytes` | 响应最大字节数，0 为不限 |
| `action` | enum | 否 | `cache` / `bypass`，默认 `cache` | 缓存或绕过 |
| `edgeTtlSeconds` | integer | 否 | 0–31536000，默认 `3600` | 边缘缓存时间 |
| `originCacheControl` | enum | 否 | `override` / `respect`，默认 `respect` | `override` 也缓存 `private` 与 `no-store` 的响应 |
| `staleWhileRevalidateSeconds` | integer | 否 | 0–2592000，默认 `0` | 后台更新期间返回过期内容的时间 |
| `staleIfErrorSeconds` | integer | 否 | 0–2592000，默认 `0` | 源站出错时返回过期内容的时间 |
| `cacheAuthorized` | boolean | 否 | 默认 `false` | 缓存带 `Authorization` 的请求的响应；关闭时这些请求绕过缓存 |
| `browserTtlSeconds` | integer | 否 | 0–31536000，默认 `0` | 发给客户端的 `Cache-Control: max-age`，0 为保留源站的 |
| `cacheSetCookie` | boolean | 否 | 默认 `false` | 缓存带 `Set-Cookie` 的响应（`site-content-v1`）；只有回源取得的那个响应带 Cookie |

有 `expression` 时三个列表须为空，或与表达式的结构化形式相同（即 `sites.get` 返回的形式）；表达式不合法时为输入校验错误。

### 源站池设置

请求中省略的字段取默认值（`sites.update` 的例外见该过程）；响应含全部字段。

| 字段 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `policy` | enum | 否 | `weighted_random` / `round_robin` / `consistent_hash`，默认 `weighted_random` | 负载均衡 |
| `tlsVerify` | boolean | 否 | 默认 `true` | 验证 HTTPS 源站的证书 |
| `tlsTrust` | enum | 否 | `system` / `originCa`，默认 `system` | 验证的信任锚：节点的信任库，或只信任 Origin CA（`origin-ca-v1`；需要 `tlsVerify`，不能有 S3 源站） |
| `clientCertificate` | boolean | 否 | 默认 `false` | 向要求客户端证书的 HTTPS 源站出示集群的回源客户端证书（`origin-mtls-v1`；不对 S3 源站） |
| `maxFails` | integer | 否 | 1–100，默认 `3` | 被动健康检查：连续失败多少次标记为不可用 |
| `recoverySeconds` | integer | 否 | 1–3600，默认 `30` | 被动健康检查：不可用的源站多少秒后再试 |
| `connectTimeoutMs` | integer | 否 | 100–120000，默认 `10000` | 连接超时 |
| `sendTimeoutMs` | integer | 否 | 100–3600000，默认 `60000` | 发送超时 |
| `readTimeoutMs` | integer | 否 | 100–3600000，默认 `60000` | 读取超时 |
| `keepalive` | boolean | 否 | 默认 `true` | 复用回源连接 |
| `keepaliveIdleSeconds` | integer | 否 | 1–3600，默认 `60` | 空闲连接保持秒数 |
| `keepaliveMaxRequests` | integer | 否 | 1–100000，默认 `1000` | 每个连接最多请求数 |
| `websocket` | boolean | 否 | 默认 `true` | 代理 WebSocket 升级 |
| `protocol` | enum | 否 | `http1` / `http2`，默认 `http1` | 回源 HTTP 版本；`http2`（`origin-http2-v1`）对 HTTPS 源站用 ALPN h2，对 HTTP 源站用 h2c，不回退 HTTP/1.1；WebSocket 始终用 HTTP/1.1 |
| `grpc` | boolean | 否 | 默认 `false`；需要 `protocol` 为 `http2` | 端到端以 HTTP/2 代理 gRPC 请求（不缓存，不经 OWASP CRS 检查） |
| `activeHealthCheck` | object | 否 | 省略的字段取默认值 | 主动健康检查（`active-health-v1`），关闭时设置保留 |
| `activeHealthCheck.enabled` | boolean | 否 | 默认 `false` | 开启 |
| `activeHealthCheck.type` | enum | 否 | `http` / `grpc`，默认 `http` | `grpc`（`active-health-grpc-v1`）：`grpc.health.v1.Health/Check`，回答 `SERVING` 为健康，不使用 `path`、`method` 与状态码范围 |
| `activeHealthCheck.grpcService` | string | 否 | 0–255 个不含空格的可打印 ASCII，默认 `""` | gRPC 检查的服务名；空为服务器整体 |
| `activeHealthCheck.path` | string | 否 | `/` 开头，1–1024 个不含空格的可打印 ASCII（可带查询串），默认 `/` | 请求路径 |
| `activeHealthCheck.method` | enum | 否 | `GET` / `HEAD`，默认 `GET` | 请求方法 |
| `activeHealthCheck.expectedStatusMin` | integer | 否 | 100–599，默认 `200`；不大于 `expectedStatusMax` | 健康状态码下限（含） |
| `activeHealthCheck.expectedStatusMax` | integer | 否 | 100–599，默认 `399` | 健康状态码上限（含） |
| `activeHealthCheck.host` | string | 否 | 主机名，默认 `""` | 探测的 Host；空为源站的 `hostHeader`，否则为其地址 |
| `activeHealthCheck.intervalSeconds` | integer | 否 | 5–300，默认 `30` | 探测间隔 |
| `activeHealthCheck.timeoutSeconds` | integer | 否 | 1–60，默认 `5`；不超过 `intervalSeconds` | 探测超时 |
| `activeHealthCheck.healthyThreshold` | integer | 否 | 1–10，默认 `2` | 连续成功多少次恢复 |
| `activeHealthCheck.unhealthyThreshold` | integer | 否 | 1–10，默认 `3` | 连续失败多少次标记为不可用 |
| `sessionAffinity` | object | 否 | 省略的字段取默认值 | 基于 Cookie 的会话保持（`session-affinity-v1`），关闭时设置保留 |
| `sessionAffinity.enabled` | boolean | 否 | 默认 `false` | 开启 |
| `sessionAffinity.ttlSeconds` | integer | 否 | 60–604800，默认 `3600` | 客户端固定到源站的秒数 |
| `tries` | integer | 否 | 1–5，默认 `3` | 一个请求最多尝试的源站数（非 3 时需要 `site-content-v1`） |
| `statusRetry` | boolean | 否 | 默认 `true` | 源站返回 502、503、504 后重试（关闭时需要 `site-content-v1`） |

### 缓存设置

请求中省略的字段取默认值（`sites.update` 的例外见该过程）。响应中 `purgeMethod` 为 `{ enabled, keySet }`。

| 字段 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `cacheKey` | object | 否 | 省略的字段取默认值 | 缓存键 |
| `cacheKey.query` | enum | 否 | `all` / `ignore` / `include` / `exclude`，默认 `all` | 查询参数：全部、忽略、只保留 `queryParams`、去掉 `queryParams`（`exclude` 需要 `site-content-v1`） |
| `cacheKey.queryParams` | `array<string>` | 否 | ≤32 个，默认 `[]`；每个去首尾空白后 1–128，不含空白、`&`、`=`、`#` | `include` 保留或 `exclude` 去掉的参数；`exclude` 下名称可以以 `*` 结尾表示前缀（单独的 `*` 不行） |
| `cacheKey.sortQuery` | boolean | 否 | 默认 `false` | 排序参数 |
| `cacheKey.headers` | `array<string>` | 否 | ≤8 个，默认 `[]`；转小写后为 1–64 个 token 字符，不能是 `cookie`、`host` | 参与缓存键的请求头 |
| `cacheKey.cookies` | `array<string>` | 否 | ≤8 个，默认 `[]`；1–64 个 token 字符 | 参与缓存键的 Cookie |
| `cacheKey.deviceType` | boolean | 否 | 默认 `false` | 区分移动端与桌面端 |
| `cacheKey.includeHost` | boolean | 否 | 默认 `true` | 包含 Host；关闭时网站的全部域名共用缓存对象 |
| `rangeSlice` | boolean | 否 | 默认 `false` | 大文件按 1 MiB 分片回源与缓存 |
| `keepCacheTag` | boolean | 否 | 默认 `false` | 把源站的 `Cache-Tag` 响应头转发给客户端；节点总是索引它 |
| `xCache` | boolean | 否 | 默认 `true` | 发送 `X-Cache`（关闭时需要 `site-content-v1`） |
| `purgeMethod` | object | 否 | 默认 `{ "enabled": false }` | PURGE 方法（`site-content-v1`）：`PURGE <URL>` 带 `X-Purge-Key` 刷新该 URL |
| `purgeMethod.enabled` | boolean | 否 | 默认 `false` | 开启；需要已保存的密钥或 `key` |
| `purgeMethod.key` | string | 否 | 16–256 个不含空格的可打印 ASCII | 只写；省略时保留已保存的密钥 |

### 内容设置

| 字段 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `charset` | object | 否 | 省略的字段取默认值 | 加到 `text/*`、`application/javascript`、`application/json`、`application/xml` 响应的字符集 |
| `charset.name` | enum | 否 | `off` / `utf-8` / `gbk` / `gb18030` / `gb2312` / `big5` / `iso-8859-1` / `shift_jis` / `euc-kr`，默认 `off` | 字符集；`off` 不添加 |
| `charset.force` | boolean | 否 | 默认 `false` | 也替换响应已声明的字符集 |
| `charset.uppercase` | boolean | 否 | 默认 `false` | 以大写发送名称 |
| `requestBodyLimit` | integer | 否 | 0–10737418240，默认 `104857600` | 按 `Content-Length` 的最大请求体字节数，超过时 413；0 为不限 |
| `rulesBodyLimit` | integer | 否 | 1024–1048576，默认 `65536` | 规则读取的最大请求体字节数（`rules-body-v1`）；更大的请求体按截断处理 |

不是默认值的内容设置需要节点能力 `site-content-v1`。

### 上线检查对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `addresses` | `array<string>` | 集群的边缘地址（A / AAAA 记录的值）：在线活动节点配置的调度地址，没有时为其上报的公网地址 |
| `domains` | `array<object>` | 每个域名一项 |
| `domains[].name` | string | 网站上的写法 |
| `domains[].probe` | string | 实际解析的名称：域名本身，泛域名为其下的 `edgeweir-check.<后缀>`；`unchecked` 时为空 |
| `domains[].pointing` | enum | `ok`：解析到的地址都属于集群的活动节点；`elsewhere`：有地址不属于；`unresolved`：没有 A / AAAA 记录；`unknown`：解析失败或节点没有已知地址；`unchecked`：`.a.com` 或 `~正则` 域名，不对应单个主机 |
| `certificate.state` | enum | `none`：网站没有证书；`covered`：证书链覆盖全部域名；`uncovered`：不覆盖 `uncovered` 中的域名；`issuing`：ACME 签发排队或进行中；`failed`：上次签发失败或节点不能加载证书；`expired`：已过期 |
| `certificate.id` | uuid | 证书 ID，或 `null` |
| `certificate.name` | string | 证书名称 |
| `certificate.uncovered` | `array<string>` | 当前证书链不覆盖的域名（首次签发前为全部）；`.a.com` 与正则域名不检查 |
| `certificate.error` | string | 失败时的证书错误代码 |
| `delivery` | [交付状态](#交付状态对象) | 交付状态 |

### 源站健康对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `originId` | uuid | 源站 ID |
| `downNodes` | integer | 任一检查把该源站标记为不可用的在线节点数 |
| `onlineNodes` | integer | 集群的在线节点数 |
| `lastError` | string | 各节点最近一次失败的节点文本 |
| `lastErrorCode` | string | 其稳定代码；未知时为空 |
| `lastErrorParams` | object | 代码的参数，值为 string |
| `lastFailureAt` | datetime | 最近一次失败的时间，或 `null` |
| `nodes` | `array<object>` | 每个节点每种来源一项；主动检查的项只在主动检查运行时存在 |
| `nodes[].nodeId`、`nodes[].nodeName` | uuid、string | 节点 |
| `nodes[].source` | enum | `passive`（真实流量）/ `active`（主动探测） |
| `nodes[].healthy` | boolean | 是否健康 |
| `nodes[].consecutiveFailures` | integer | 连续失败次数 |
| `nodes[].lastError`、`nodes[].lastErrorCode`、`nodes[].lastErrorParams`、`nodes[].lastFailureAt` | — | 该节点该来源的最近失败，含义同上 |
| `nodes[].downUntil` | datetime | 被动检查不可用期的结束时间；主动检查的项总为 `null` |
| `nodes[].reportedAt` | datetime | 上报时间 |

### 回源质量对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `range` | enum | 请求的时间范围 |
| `bucketSeconds` | integer | 每个时间桶的秒数 |
| `from`、`to` | datetime | 统计的起止时间 |
| `times` | `array<datetime>` | 每个时间桶的开始时间，从早到晚 |
| `items` | `array<object>` | 网站当前的源站，按源站池顺序；已删除的源站不列出 |
| `items[].originId` | uuid | 源站 ID |
| `items[].address`、`items[].port`、`items[].scheme`、`items[].group`、`items[].backup` | — | 源站的地址、端口、协议、组与是否备用 |
| `items[].requests` | integer | 回源次数（重试另计） |
| `items[].failures` | object | 按类别的失败次数 `{ connect, timeout, tls, invalid, server }`；`server` 为源站返回 5xx 的次数 |
| `items[].errors` | integer | 全部失败与 5xx 响应 |
| `items[].errorRate` | number | `errors / requests`；没有回源时为 0 |
| `items[].answered` | integer | 源站有响应（有响应头时间）的次数 |
| `items[].meanMs`、`items[].p50Ms`、`items[].p95Ms`、`items[].p99Ms` | number | 到响应头的时间：平均值与分位数（在桶内插值，近似），毫秒；没有响应时为 `null` |
| `items[].series` | object | 与 `times` 对齐的每桶数据 `{ requests: integer[], errors: integer[], p95Ms: (number 或 null)[] }` |
| `unsupportedNodes` | integer | 集群中缺少 `origin-stats-v1` 的活动节点数；不为 0 时统计不完整 |

### 网站能力对象

每个字段为 `{ available, reason }`：`available` 为 boolean；集群有活动节点缺少对应能力时 `available` 为 `false`、`reason` 为 `nodes`，否则 `reason` 为 `null`。`available` 为 `false` 时运营者仍可经 API 开启，缺少能力的节点保留原配置。

| 字段 | 节点能力 | 功能 |
| --- | --- | --- |
| `brotli`、`zstd` | `brotli-v1`、`zstd-v1` | Brotli、Zstandard 压缩 |
| `crs` | `modsecurity-v1` | OWASP CRS |
| `activeHealthCheck` | `active-health-v1` | 主动健康检查 |
| `sessionAffinity` | `session-affinity-v1` 与 `challenge-v1` | 会话保持 |
| `originHttp2` | `origin-http2-v1` | 回源 HTTP/2 与 gRPC |
| `originProxyProtocol` | `origin-proxy-protocol-v1` | 回源 PROXY protocol |
| `activeHealthGrpc` | `active-health-grpc-v1` | gRPC 主动健康检查 |
| `originMtls` | `origin-mtls-v1` | 回源客户端证书 |
| `originCa` | `origin-ca-v1`（CA 轮换期间另需 `origin-ca-rotation-v1`） | 只信任 Origin CA |
| `errorPages` | `error-pages-v1` | 错误页 |
| `purgeByTag` | `purge-tag-v1` | 按 Host 与 Cache-Tag 刷新 |
| `prefetchVariants` | `prefetch-v2` | 预热移动端变体与站点地图 |
| `rulesV2` | `rules-v2` | 规则引擎扩展：函数与新字段、动态跳转与重写、源站与压缩等配置动作、非构建器形式的缓存规则表达式、浏览器 TTL、批量重定向与源站组 |
| `rulesV3` | `rules-v3` | 规则引擎新增字段、函数与通配比较，按请求计算的头值与查询参数，跳转状态码 303，错误页占位符 `{{time}}`、`{{path}}` |
| `edgePorts` | `edge-ports-v1` | 80、443 以外的端口与 HTTPS 跳转的状态码、端口和不跳转的域名 |
| `clientIp` | `client-ip-v1` | 规则字段 `ip.peer` |
| `siteContent` | `site-content-v1` | 去掉参数的缓存键、缓存 `Set-Cookie` 响应、PURGE 方法、隐藏 `X-Cache`、更多错误页状态码与跳转、维护模式、字符集、gzip 级别与最大压缩长度、请求体上限与回源尝试次数 |
| `domainsV2` | `domains-v2` | `.a.com` 与 `~正则` 域名 |
| `multiCertificate` | `multi-certificate-v1` | 多张证书 |
| `clientCertificate` | `client-cert-v1` | 客户端证书与 `tls.client.*` 字段 |
| `accessAuth` | `access-auth-v1` | 访问鉴权 |
| `accessControl` | `access-control-v1` | 访问控制 |
| `encodedPaths` | `encoded-path-exemptions-v1` | 编码路径例外 |
| `wafV2` | `waf-v2` | WAF 动作 ban、respond、close、skip，日志规则的访问日志，限速封禁，配置规则覆盖 CRS，CRS 按路径或目标排除 |
| `rulesBody` | `rules-body-v1` | 规则中的请求体字段与 `form_value` / `json_value` |
| `challengeV2` | `challenge-v2` | 已验证爬虫、挑战页文字与挑战失败封禁 |
| `accessLogsV2` | `access-logs-v2` | 访问日志选项：总记录被拦截的请求、查询串、请求头与对端地址 |
| `imageConvert` | `image-convert-v1` | 图片格式转换 |

### 批量结果

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `changed` | `array<object>` | 发生变化的网站 `{ id, name }`；已是所请求状态的网站不列出 |
| `revisions` | `array<object>` | 每个发布的集群一项 `{ clusterId, revision, created }`；`created` 为 `false` 时配置不变，`revision` 为最新版本 |

### 复制预览对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `source` | object | 源网站 `{ id, name }` |
| `targets` | `array<object>` | 每个目标一项 |
| `targets[].id`、`targets[].name` | uuid、string | 目标网站 |
| `targets[].changes` | `array<object>` | 每个部分一项 `{ part, changed, before, after, fields }`：`changed` 为 boolean；列表部分的 `before`、`after` 为前后条数（其他部分为 `null`）；其他部分的 `fields` 为会变化的设置数（列表部分为 `null`） |
| `targets[].error` | object | 复制会失败时为 `{ code, message, data }`（API 错误代码、英文消息与参数，参数值为 string 或 number），否则为 `null`；失败的目标不改变任何部分 |

### 复制结果对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `targets` | `array<object>` | 每个目标一项 |
| `targets[].id`、`targets[].name` | uuid、string | 目标网站 |
| `targets[].ok` | boolean | 复制成功 |
| `targets[].changed` | `array<enum>` | 设置发生变化的部分 |
| `targets[].revision` | [配置版本](#配置版本对象) | 目标所在集群复制后的版本；失败时为 `null` |
| `targets[].error` | object | 失败原因 `{ code, message, data }`，成功时为 `null` |

### 缓存任务对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 任务 ID |
| `type` | enum | `url` / `prefix` / `site` / `prefetch` / `host` / `tag` / `sitemap` |
| `targets` | `array<string>` | 请求的内容：URL、前缀、网站名称、Host、规范化后的标签或站点地图 URL |
| `sites` | `array<object>` | 涉及的网站 `{ id, name }`；已删除的网站不列出 |
| `variants` | `array<enum>` | 预热与站点地图任务的设备变体（`desktop`、`mobile`）；清缓存任务为 `[]` |
| `maxUrls` | integer | 站点地图任务的 URL 上限；其他类型为 `null` |
| `state` | enum | `pending`：没有节点完成；`running`：部分节点完成；之后为 `succeeded` 或 `failed`。`skipped` 的节点不计 |
| `nodes` | `array<object>` | 每个节点一项 |
| `nodes[].nodeId`、`nodes[].nodeName` | uuid、string | 节点 |
| `nodes[].state` | enum | `pending` / `running` / `succeeded` / `failed` / `skipped`（节点在执行前被禁用） |
| `nodes[].message` | string | 节点的结果文本（未知代码时为英文） |
| `nodes[].errorCode` | string | 结果的稳定代码；成功时为空 |
| `nodes[].errorParams` | object | 代码的参数，值为 string |
| `nodes[].succeeded`、`nodes[].failed` | integer | 成功与失败的条目数 |
| `nodes[].finishedAt` | datetime | 完成时间，或 `null` |
| `nodes[].recoveredAt` | datetime | 错过的清缓存（`task_expired`、`node_disabled`）由整站刷新补上的时间，或 `null` |
| `source` | enum | `user`：控制台或 API 创建；`recovery`：控制台为错过清缓存的节点发出的整站刷新；`purge_method`：节点接受的 PURGE 请求（`createdByName` 为节点名） |
| `createdByName` | string | 创建者名称 |
| `createdAt` | datetime | 创建时间 |
| `finishedAt` | datetime | 完成时间，或 `null` |

### HTTPS 设置

`https.update` 的 `settings` 与 `https.get` 的响应。请求中省略的字段取默认值。

| 字段 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `certificateId` | uuid | 否 | 默认 `null` | 网站的首张证书；`null` 为只用 HTTP |
| `additionalCertificateIds` | `array<uuid>` | 否 | 0–3 个，默认 `[]`；需要 `certificateId`，不重复，不含 `certificateId` | 其他证书（`multi-certificate-v1`）；网站的每个域名须被其中一张覆盖，握手按 SNI 选证书 |
| `forceHttps` | boolean | 否 | 默认 `false`；需要证书 | HTTP 跳转到 HTTPS |
| `hstsMaxAge` | integer | 否 | 0–63072000，默认 `0`；非 0 时需要证书 | HSTS `max-age`，0 为不发送 |
| `hstsIncludeSubdomains` | boolean | 否 | 默认 `false` | HSTS `includeSubDomains` |
| `hstsPreload` | boolean | 否 | 默认 `false` | HSTS `preload` |
| `minimumVersion` | enum | 否 | `1.2` / `1.3`，默认 `1.2` | 最低 TLS 版本 |
| `cipherProfile` | enum | 否 | `modern` / `compatible`，默认 `modern` | 密码套件 |
| `http2` | boolean | 否 | 默认 `true` | HTTP/2 |
| `http3` | boolean | 否 | 默认 `false` | HTTP/3 |
| `brotli` | boolean | 否 | 默认 `false` | Brotli 压缩（`brotli-v1`） |
| `brotliLevel` | integer | 否 | 1–11，默认 `6` | Brotli 级别 |
| `brotliMinLength` | integer | 否 | 1–1048576，默认 `256` | 压缩的最小响应字节数 |
| `brotliTypes` | `array<string>` | 否 | ≤32 个 MIME 类型（`类型/子类型`，小写，不带参数）；默认 `text/html`、`text/plain`、`text/css`、`application/javascript`、`application/json`、`image/svg+xml` | 压缩的类型 |
| `zstd` | boolean | 否 | 默认 `false` | Zstandard 压缩（`zstd-v1`） |
| `zstdLevel` | integer | 否 | 1–19，默认 `3` | Zstandard 级别 |
| `zstdMinLength`、`zstdTypes` | integer、`array<string>` | 否 | 同 `brotliMinLength`、`brotliTypes` | Zstandard 的最小字节数与类型 |
| `gzip` | boolean | 否 | 默认 `true` | gzip 压缩 |
| `gzipMinLength`、`gzipTypes` | integer、`array<string>` | 否 | 同 `brotliMinLength`、`brotliTypes` | gzip 的最小字节数与类型 |
| `gzipLevel` | integer | 否 | 0–9，默认 `0` | gzip 级别；0 为节点默认（1），其他值需要 `site-content-v1` |
| `compressMaxLength` | integer | 否 | 0–9007199254740991，默认 `0` | 按已知长度压缩的最大响应字节数；0 为不限（非 0 需要 `site-content-v1`）；长度未知的响应照常压缩 |
| `ocspStapling` | boolean | 否 | 默认 `false` | OCSP 装订 |
| `redirectStatus` | integer | 否 | 301 / 302 / 303 / 307 / 308，默认 `301` | `forceHttps` 与配置规则 `forceHttps` 的跳转状态码 |
| `redirectPort` | integer | 否 | 1–65535，默认 `443`；须为 443 或网站的 HTTPS 端口 | 跳转目标 URL 的端口 |
| `redirectExcludedDomains` | `array<string>` | 否 | ≤50 个域名，默认 `[]`；去重并排序；须为网站的精确或 `*.` 域名 | `forceHttps` 不跳转的域名（配置规则仍会跳转） |
| `clientCertificate` | object | 否 | 省略的字段取默认值 | 客户端证书（`client-cert-v1`） |
| `clientCertificate.mode` | enum | 否 | `off` / `optional` / `required`，默认 `off`；非 `off` 时需要证书与 `caPem` | `optional` 验证访客出示的证书；`required` 对没有有效证书的请求（含 HTTP）返回 403 错误页 |
| `clientCertificate.caPem` | string | 否 | 最多 65536 字节，默认 `""` | 客户端 CA（PEM），由服务器重新编码 |
| `clientCertificate.depth` | integer | 否 | 1–5，默认 `2` | 验证深度 |
| `clientCertificate.forwardHeaders` | boolean | 否 | 默认 `false` | 向源站发送 `X-Client-Verify`、`X-Client-Cert-SHA256`、`X-Client-Cert-Subject`、`X-Client-Cert-Serial`；访客自带的同名头总被删除 |

客户端同时接受多种编码且 q 值相同时，节点依次选 zstd、br、gzip。

### 错误页对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `siteId` | uuid | 网站 ID |
| `pages` | `array<object>` | 每个状态码至多一页；`4xx`、`5xx` 在最前，其后按状态码升序 |
| `pages[].status` | integer 或 enum | 状态码，或 `"4xx"` / `"5xx"` |
| `pages[].template` | string | HTML 模板；跳转页面为空 |
| `pages[].redirectUrl` | string | 302 跳转的目标；模板页面为空 |
| `pages[].responseStatus` | integer | 模板页面发送的状态码；0 保持原状态码 |
| `interceptOriginErrors` | boolean | 也替换状态码有页面的源站响应 |
| `updatedAt` | datetime | 修改时间；从未保存时为 `null` |

### 维护模式对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `siteId` | uuid | 网站 ID |
| `enabled` | boolean | 是否开启 |
| `template` | string | 维护页模板；空为节点内置页面 |
| `retryAfterSeconds` | integer | `Retry-After` 秒数，0 为不发送 |
| `allowedCidrs` | `array<string>` | 不受影响的地址或 CIDR |
| `allowedPathPrefixes` | `array<string>` | 不受影响的路径前缀 |
| `updatedAt` | datetime | 修改时间；从未保存时为 `null` |

### 访问鉴权对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `siteId` | uuid | 网站 ID |
| `rules` | `array<object>` | 规则，按匹配顺序 |
| `rules[].id` | uuid | 规则 ID |
| `rules[].kind` | enum | `basic` / `forward` / `url_a` / `url_b` / `url_c` / `url_d` |
| `rules[].enabled` | boolean | 是否启用 |
| `rules[].scope` | object | `{ domains, pathPrefixes, extensions, excludePathPrefixes }`，均为 `array<string>` |
| `rules[].basic` | object | `{ realm, keepAuthorization, userHeader, users: [{ name }] }`，只有用户名；其他类型为 `null` |
| `rules[].forward` | object | `{ url, method, timeoutMs, requestHeaders, responseHeaders, cacheSeconds, passRedirects, allowUnavailable }`；其他类型为 `null` |
| `rules[].url` | object | `{ validitySeconds, skewSeconds, signParam, timeParam, backupKey }`，`backupKey` 为是否设置了备用密钥（boolean）；其他类型为 `null` |
| `updatedAt` | datetime | 修改时间；从未保存时为 `null` |
| `formerIdentityHeaders` | `array<string>` | 以前的规则设置、节点仍从网站每个请求中删除的身份头（停用的规则算作当前规则），从早到晚 |

### 访问鉴权规则输入

| 字段 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `id` | uuid | 否 | — | 已有规则的 ID：沿用其已保存的密码与密钥；省略为新规则 |
| `kind` | enum | 是 | `basic` / `forward` / `url_a` / `url_b` / `url_c` / `url_d` | 类型；只带与类型对应的 `basic`、`forward` 或 `url` |
| `enabled` | boolean | 否 | 默认 `true` | 启用 |
| `scope` | object | 否 | 默认各列表为空 | 规则检查的请求；空列表不收窄范围 |
| `scope.domains` | `array<string>` | 否 | ≤50 个，默认 `[]` | 网站的域名，按网站上的写法 |
| `scope.pathPrefixes` | `array<string>` | 否 | ≤32 个，默认 `[]`；以 `/` 开头，不含空白、`?`、`#` 与控制字符，最长 1024 字节（UTF-8） | 路径前缀 |
| `scope.extensions` | `array<string>` | 否 | ≤64 个，默认 `[]`；小写，不带点，`[a-z0-9]{1,16}` | 扩展名 |
| `scope.excludePathPrefixes` | `array<string>` | 否 | ≤32 个，默认 `[]`；规则同 `pathPrefixes` | 排除的路径前缀 |
| `basic.realm` | string | 是 | 去首尾空白后 1–64 字符，不含 `"`、`\` 与控制字符 | `WWW-Authenticate` 的 realm |
| `basic.keepAuthorization` | boolean | 否 | 默认 `false` | 回源保留 `Authorization`；关闭时删除 |
| `basic.userHeader` | boolean | 否 | 默认 `false` | 回源附加 `X-Auth-User`（覆盖访客自带的同名头） |
| `basic.users` | `array<object>` | 是 | 1–100 个，用户名不重复 | 用户 |
| `basic.users[].name` | string | 是 | 1–64 个不含空格与 `:` 的可打印 ASCII | 用户名 |
| `basic.users[].password` | string | 否 | 8–128 字符，不含控制字符 | 只写；省略时沿用该用户已保存的密码，新用户必填 |
| `forward.url` | string | 是 | 去首尾空白后最长 2048；`http(s)` URL，主机为主机名、IPv4 或带方括号的 IPv6，不含账号、片段、空格与 `\` | 鉴权服务 |
| `forward.method` | enum | 否 | `GET` / `HEAD`，默认 `GET` | 请求方法 |
| `forward.timeoutMs` | integer | 否 | 100–10000，默认 `5000` | 超时 |
| `forward.requestHeaders` | `array<string>` | 否 | ≤16 个，默认 `["authorization", "cookie"]`；不能是 `host`、逐跳头、`content-length`、`x-original-*`、`x-real-ip`、`x-forwarded-for` 或 `x-edgeweir-*` | 发给鉴权服务的访客请求头 |
| `forward.responseHeaders` | `array<string>` | 否 | ≤8 个，默认 `[]`；1–64 个 token 字符，不能是受保护的头或 `x-edgeweir-*` | 2xx 响应中复制到回源请求的头 |
| `forward.cacheSeconds` | integer | 否 | 0–300，默认 `0` | 缓存鉴权结果的秒数，0 为不缓存 |
| `forward.passRedirects` | boolean | 否 | 默认 `false` | 鉴权服务返回 3xx 时原样返回状态码与 `Location` |
| `forward.allowUnavailable` | boolean | 否 | 默认 `false` | 鉴权服务不可用（5xx、连接失败、超时）时请求不经鉴权继续处理 |
| `url.validitySeconds` | integer | 否 | 1–31536000，默认 `1800` | 签名有效期 |
| `url.skewSeconds` | integer | 否 | 0–600，默认 `300` | 允许的时钟偏差 |
| `url.signParam` | string | 否 | `[A-Za-z0-9_-]{1,32}`，默认 `sign` | 签名参数名 |
| `url.timeParam` | string | 否 | `[A-Za-z0-9_-]{1,32}`，默认 `t`；`url_d` 时不能与 `signParam` 相同 | 时间参数名 |
| `url.primaryKey` | string | 否 | 16–128 个可打印 ASCII（不含空格） | 只写；省略时保留已保存的主密钥，新规则必填 |
| `url.backupKey` | string | 否 | 同 `primaryKey`；或 `null` | 只写；省略时保留，`null` 删除备用密钥 |

### 访问控制对象

`accessControl.get` 与 `accessControl.update` 的响应另有 `siteId`（uuid）与 `updatedAt`（datetime；从未保存时为 `null`）。请求中各项省略的字段取下列默认值。

| 字段 | 类型 | 约束与默认值 | 说明 |
| --- | --- | --- | --- |
| `siteLists.blockListIds` | `array<uuid>` | ≤16 个，默认 `[]`；去重 | 地址在其中的请求得到 403 的 IP 名单 |
| `siteLists.allowListIds` | `array<uuid>` | ≤16 个，默认 `[]`；去重 | 地址在其中的请求跳过本站封锁名单、封禁、地区、防盗链、UA 检查与挑战的 IP 名单 |
| `hotlink.enabled` | boolean | 默认 `false` | 开启防盗链 |
| `hotlink.allowEmpty` | boolean | 默认 `true` | 允许没有 `Referer` 的请求 |
| `hotlink.allowSiteDomains` | boolean | 默认 `true` | 允许来自网站自己域名的请求 |
| `hotlink.allowed`、`hotlink.denied` | `array<string>` | 各 ≤200 个，默认 `[]`；`a.com`、`*.a.com`、`.a.com` 或 `*`，最长 256，转小写，去重 | 允许与拒绝的来源 |
| `hotlink.checkOrigin` | boolean | 默认 `false` | 请求带 `Origin` 时同样检查它 |
| `hotlink.extensions` | `array<string>` | ≤64 个；默认 49 个常见图片、音视频与下载类型 | 检查的扩展名 |
| `hotlink.pathPrefixes`、`hotlink.excludePathPrefixes` | `array<string>` | 各 ≤32 个，默认 `[]`；以 `/` 开头，不含空白、`?`、`#` 与控制字符，最长 1024 字节 | 检查与排除的路径前缀 |
| `hotlink.action` | enum | `deny` / `redirect`，默认 `deny` | `deny`：403 错误页；`redirect`：302 到 `redirectUrl` |
| `hotlink.redirectUrl` | string | 去首尾空白后最长 2048，默认 `""`；`redirect` 时必填 | 本站路径或 `http(s)` URL |
| `userAgents.rules` | `array<object>` | ≤200 条，默认 `[]` | `{ pattern, action }`：`pattern` 为空字符串或 1–512 个可打印 ASCII 的通配模式（至多 8 个 `*`，只能转义 `*` 与 `\`）；`action` 为 `allow` / `deny` |
| `userAgents.pathPrefixes`、`userAgents.excludePathPrefixes` | `array<string>` | 同 `hotlink.pathPrefixes` | 检查与排除的路径前缀 |
| `cors.enabled` | boolean | 默认 `false`；开启时 `allowedOrigins` 至少一个 | 开启 CORS |
| `cors.allowedOrigins` | `array<string>` | ≤100 个，默认 `[]`；`scheme://host[:port]`、`https://*.a.com` 或 `*`，最长 300 | 允许的来源 |
| `cors.allowCredentials` | boolean | 默认 `false`；不能与 `*` 同用 | `Access-Control-Allow-Credentials` |
| `cors.allowedMethods` | `array<string>` | 1–16 个，转大写；默认 `GET`、`HEAD`、`POST`、`PUT`、`PATCH`、`DELETE`、`OPTIONS` | 允许的方法 |
| `cors.allowedHeaders`、`cors.exposedHeaders` | `array<string>` | 各 ≤64 个，默认 `[]`；转小写后为 1–64 个 token 字符 | 允许与暴露的头 |
| `cors.echoRequestHeaders` | boolean | 默认 `false` | 预检响应回送 `Access-Control-Request-Headers` |
| `cors.maxAgeSeconds` | integer | 0–86400，默认 `600` | 预检缓存秒数 |
| `cors.preflightToOrigin` | boolean | 默认 `false` | 预检照常回源，不在边缘应答 |
| `cors.keepOriginHeaders` | boolean | 默认 `false` | 源站响应已有 `Access-Control-Allow-Origin` 时不改动任何 `Access-Control-*` 头 |
| `cors.pathPrefixes` | `array<string>` | 同 `hotlink.pathPrefixes` | 适用的路径前缀 |
| `geo.enabled` | boolean | 默认 `false`；开启时 `countries`、`subdivisions`、`asns` 至少一项 | 开启地区访问控制 |
| `geo.mode` | enum | `allow` / `deny`，默认 `deny` | `allow`：只放行匹配的客户端；`deny`：匹配的客户端得到 403 |
| `geo.countries` | `array<string>` | ≤256 个，默认 `[]`；两位字母，转大写 | 国家或地区代码 |
| `geo.subdivisions` | `array<string>` | ≤256 个，默认 `[]`；`CC-行政区`，如 `US-CA` | 行政区 |
| `geo.asns` | `array<integer>` | ≤256 个，1–4294967295，默认 `[]` | ASN |
| `geo.pathPrefixes`、`geo.exceptPathPrefixes` | `array<string>` | 同 `hotlink.pathPrefixes` | 适用与例外的路径前缀 |
| `websocket.allowAllOrigins` | boolean | 默认 `true`；为 `false` 时 `origins` 至少一个 | 允许任何来源的 WebSocket |
| `websocket.origins` | `array<string>` | ≤100 个，默认 `[]`；`https://a.com[:port]` 或 `https://*.a.com`，最长 300 | 允许的来源 |
| `websocket.idleTimeoutSeconds` | integer | 60–86400，默认 `3600` | 空闲超时 |
| `securityHeaders.nosniff` | boolean | 默认 `false` | `X-Content-Type-Options: nosniff` |
| `securityHeaders.frameOptions` | enum | `off` / `DENY` / `SAMEORIGIN`，默认 `off` | `X-Frame-Options` |
| `securityHeaders.referrerPolicy` | enum | `off`、`no-referrer`、`no-referrer-when-downgrade`、`origin`、`origin-when-cross-origin`、`same-origin`、`strict-origin`、`strict-origin-when-cross-origin`、`unsafe-url`，默认 `off` | `Referrer-Policy` |
| `securityHeaders.permissionsPolicy` | string | 去首尾空白后最长 1024 个可打印 ASCII，默认 `""` | `Permissions-Policy`；空为不设置 |
| `securityHeaders.hideServer` | boolean | 默认 `false` | 隐藏 `Server` |
| `securityHeaders.removePoweredBy` | boolean | 默认 `false` | 删除 `X-Powered-By` |
| `encodedPaths.exemptions` | `array<object>` | ≤32 个，默认 `[]`；`prefix` 不重复 | `{ prefix, encodedSlash, semicolon }`：原始路径以 `prefix` 开头的请求可以原样带 `%2F`（`encodedSlash`）和 / 或 `;`（`semicolon`），两者至少一个为 `true`（默认均为 `false`）；`prefix` 为以 `/` 开头的 1–256 个可打印 ASCII，不含 `%`、`;`、`\`、`#`、`?`、`//` 与点路径段 |

### 用量保护设置

`usageGuard.update` 的请求字段与 `usageGuard.get` 的 `settings`。`bytesLimit`、`requestsLimit`、`bandwidthBps` 至少一个不为 `null`。

| 字段 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `period` | enum | 否 | `day` / `month`，默认 `month` | 自然日 / 自然月 |
| `timeZone` | string | 是 | 去首尾空白后 1–64 的 IANA 时区名 | 周期从该时区的 0 点开始 |
| `bytesLimit` | string | 否 | 1–38 位十进制正整数（不以 0 开头），或 `null`；默认 `null` | 每个周期发送给访客的字节数上限 |
| `requestsLimit` | string | 否 | 同 `bytesLimit` | 每个周期的请求数上限 |
| `bandwidthBps` | integer | 否 | 1000–10000000000000，或 `null`；默认 `null` | 带宽上限（bit/s，所有节点最近 5 个完整分钟的平均） |
| `warnPercent` | integer | 否 | 1–99，或 `null`；默认 `80` | 预警阈值（百分比）；`null` 不预警 |
| `action` | enum | 否 | `alert` / `maintenance` / `disable`，默认 `maintenance` | 达到 100% 时：只告警、开启维护模式、停用网站 |
| `recovery` | enum | 否 | `auto` / `manual`，默认 `auto` | `auto`：周期不再超限时（下个周期、提高上限，或带宽在保持时间后）解除动作；`manual`：只能手动恢复 |
| `bandwidthHoldMinutes` | integer | 否 | 5–1440，默认 `30` | 自动恢复时，带宽触发的动作在最后一次超限后保持的分钟数 |

### 用量保护对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `siteId` | uuid | 网站 ID |
| `settings` | [用量保护设置](#用量保护设置) | 设置；未设置时为 `null` |
| `updatedAt` | datetime | 修改时间，或 `null` |
| `period` | object | 本周期 `{ start, end }`（datetime）；未设置时为 `null` |
| `usage` | object | 本周期用量 `{ bytes, requests, bandwidthBps, bandwidthPeakBps }`：`bytes`、`requests` 为十进制字符串；`bandwidthBps` 为最近 5 个完整分钟的平均，`bandwidthPeakBps` 为本周期最高值（number，bit/s）；未设置时为 `null` |
| `held` | object | 用量保护执行且仍在生效的动作 `{ action, metric, since }`：`action` 为 `maintenance` / `disable`，`metric` 为 `bytes` / `requests` / `bandwidth`；没有时为 `null` |
| `pausedUntil` | datetime | 手动恢复后到此时间（周期结束）前不执行动作，或 `null` |
| `lastError` | string | 最近一次动作发布失败的错误码；没有时为空 |

### 自动缓解对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `siteId` | uuid | 网站 ID |
| `settings` | object | `{ enabled, threshold, durationMinutes }`；从未设置（未启用）时为 `null` |
| `updatedAt` | datetime | 修改时间，或 `null` |
| `level` | enum | 在线节点中该网站当前最高的 CC 级别：`normal` / `cookie302` / `js` / `pow` / `captcha` |
| `active` | object | 自动缓解开启且仍在保持的 Under Attack `{ since, expiresAt, level }`；级别保持在触发级别时 `expiresAt` 后移；没有时为 `null` |
| `paused` | boolean | 运营者接管：级别降到触发级别以下之前不再开启 |
| `lastError` | string | 最近一次不能发布的变更的错误码；没有时为空 |
