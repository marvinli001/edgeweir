# API：DNS 与调度

DNS 服务商账号、集群 DNS 绑定与记录、DNS 版本与对账、区域探针与智能调度规则的过程。

权限级别、认证、幂等键与错误格式见 [API 概览](../api.md)。

## DNS 服务商

- 服务商账号的凭据加密保存，任何过程都不返回凭据。
- 审计动作：`dns.provider_create`、`dns.provider_update`、`dns.provider_delete`。
- 每个控制台进程同时至多 4 个服务商检查（`dns.zones`、`dns.testProvider`），超出返回 429 `DNS_PROVIDER_RATE_LIMITED`。
- 行为见 [DNS 调度：服务商与凭据](../../guide/dns.md#服务商与凭据)；全部服务商与凭据字段见[服务商与凭据字段](#服务商与凭据字段)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`dns.catalog`](#dnscatalog) | `GET /dns/catalog` | 读；服务账号（无需 scope） |
| [`dns.providers`](#dnsproviders) | `GET /dns/providers` | 读 |
| [`dns.createProvider`](#dnscreateprovider) | `POST /dns/providers` | 写 |
| [`dns.updateProvider`](#dnsupdateprovider) | `PUT /dns/providers/{id}` | 写 |
| [`dns.deleteProvider`](#dnsdeleteprovider) | `DELETE /dns/providers/{id}` | 写 |
| [`dns.zones`](#dnszones) | `POST /dns/zones` | 写 |
| [`dns.testProvider`](#dnstestprovider) | `POST /dns/test` | 写 |

### `dns.catalog`

`GET /dns/catalog` · 读 · 服务账号（无需 scope）

无参数。

响应：[DNS 服务商目录对象](#dns-服务商目录对象)[]，按[服务商与凭据字段](#服务商与凭据字段)中的顺序。目录总是包含 `test`；只有设置了 `EDGEWEIR_DNS_TEST_ENDPOINT` 时才能使用它。

### `dns.providers`

`GET /dns/providers` · 读

无参数。

响应：`{ items: `[DNS 服务商账号](#dns-服务商账号对象)`[], testEnabled }`。`items` 按名称排序；`testEnabled` 为 `true` 表示设置了 `EDGEWEIR_DNS_TEST_ENDPOINT`，可以使用 `test` 服务商。

### `dns.createProvider`

`POST /dns/providers` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `name` | body | string | 是 | 去掉首尾空白后 1–100 字符 | 账号名称 |
| `provider` | body | enum | 是 | [服务商与凭据字段](#服务商与凭据字段)中的服务商 ID | 服务商 |
| `zone` | body | string | 是 | 域名，转为小写，至多 253 字符，不能以 `*.` 开头 | 账号管理的区域 |
| `credentials` | body | object | 是 | 键至多 64 字符，值至多 16384 字符；按服务商的字段校验 | 凭据，键为字段的 `key` |

`credentials` 的校验：只接受该服务商的字段；必填字段不能为空；省略或为空的可选字段不保存；`text`、`select`、`url` 字段去掉首尾空白；不能含控制字符（`textarea` 字段允许制表符与换行）；不超过 `maxLength`，符合 `pattern` 与 `options`；`url` 字段只能是 `http` / `https`，不含用户信息与片段。保存时不连接服务商。

响应：[DNS 服务商账号](#dns-服务商账号对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `DNS_POLICY_INVALID` | 400 | `credentials` 未通过校验 |
| `DNS_TEST_DISABLED` | 400 | `provider` 为 `test`，且未设置 `EDGEWEIR_DNS_TEST_ENDPOINT` |

### `dns.updateProvider`

`PUT /dns/providers/{id}` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 账号 ID |
| `name` | body | string | 否 | 去掉首尾空白后 1–100 字符；省略时不变 | 账号名称 |
| `credentials` | body | object | 否 | 同 `dns.createProvider`，按账号原有的服务商校验；省略时不变 | 新凭据，整体替换原凭据 |

服务商与区域不能修改。

响应：[DNS 服务商账号](#dns-服务商账号对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `DNS_PROVIDER_NOT_FOUND` | 404 | 账号不存在 |
| `DNS_POLICY_INVALID` | 400 | `credentials` 未通过校验 |
| `DNS_TEST_DISABLED` | 400 | 账号的服务商为 `test`，且未设置 `EDGEWEIR_DNS_TEST_ENDPOINT` |

### `dns.deleteProvider`

`DELETE /dns/providers/{id}` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 账号 ID |

响应：`{ ok: true }`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `DNS_PROVIDER_NOT_FOUND` | 404 | 账号不存在 |
| `DNS_PROVIDER_IN_USE` | 409 | 有集群的 DNS 绑定选择了该账号，或该账号中仍有集群写入的记录 |

### `dns.zones`

`POST /dns/zones` · 写

列出凭据可以管理的区域。请求体为下列两种形式之一。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | body | uuid | 形式一 | — | 已保存账号的 ID，使用其凭据 |
| `provider` | body | enum | 形式二 | 服务商 ID | 服务商 |
| `credentials` | body | object | 形式二 | 同 `dns.createProvider` | 未保存的凭据 |

响应：`{ zones: string[] }`。区域名转为小写，去掉末尾的点，去重排序，至多 1000 个。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `DNS_PROVIDER_NOT_FOUND` | 404 | `id` 对应的账号不存在 |
| `DNS_POLICY_INVALID` | 400 | `credentials` 未通过校验 |
| `DNS_TEST_DISABLED` | 400 | `provider` 为 `test`，且未设置 `EDGEWEIR_DNS_TEST_ENDPOINT` |
| `DNS_ZONES_UNSUPPORTED` | 400 | 服务商不能列出区域（`capabilities.listZones` 为 `false`），或服务商拒绝该操作 |
| `DNS_PROVIDER_AUTH_FAILED` | 400 | 服务商拒绝凭据 |
| `DNS_ADDRESS_REFUSED` | 400 | 自建端点的地址不符合出站策略 |
| `DNS_PROVIDER_RATE_LIMITED` | 429 | 服务商限流，或本进程已有 4 个服务商检查在进行 |
| `DNS_PROVIDER_UNREACHABLE` | 502 | 无法连接服务商 |
| `DNS_PROVIDER_FAILED` | 502 | 服务商请求的其他失败 |

### `dns.testProvider`

`POST /dns/test` · 写

用凭据读取区域的记录（连接测试），不写入。请求体为下列两种形式之一。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | body | uuid | 形式一 | — | 已保存账号的 ID，使用其凭据与区域 |
| `provider` | body | enum | 形式二 | 服务商 ID | 服务商 |
| `credentials` | body | object | 形式二 | 同 `dns.createProvider` | 未保存的凭据 |
| `zone` | body | string | 形式二 | 同 `dns.createProvider` 的 `zone` | 区域 |

响应：`{ ok: true, records }`。`records` 为区域中读到的记录数。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `DNS_PROVIDER_NOT_FOUND` | 404 | `id` 对应的账号不存在 |
| `DNS_POLICY_INVALID` | 400 | `credentials` 未通过校验 |
| `DNS_TEST_DISABLED` | 400 | `provider` 为 `test`，且未设置 `EDGEWEIR_DNS_TEST_ENDPOINT` |
| `DNS_PROVIDER_AUTH_FAILED` | 400 | 服务商拒绝凭据 |
| `DNS_PROVIDER_ZONE_NOT_FOUND` | 400 | 服务商中没有该区域 |
| `DNS_ADDRESS_REFUSED` | 400 | 自建端点的地址不符合出站策略 |
| `DNS_ZONES_UNSUPPORTED` | 400 | 服务商不支持该操作 |
| `DNS_PROVIDER_RATE_LIMITED` | 429 | 服务商限流，或本进程已有 4 个服务商检查在进行 |
| `DNS_PROVIDER_UNREACHABLE` | 502 | 无法连接服务商 |
| `DNS_PROVIDER_FAILED` | 502 | 服务商请求的其他失败 |

## DNS 绑定与记录

- 每个集群有一个 DNS 绑定，`mode` 为 `off`（不管理）、`manual`（手动创建记录）或 `auto`（经服务商账号写入）。没有保存过的集群按 `off`、TTL 600 返回。
- 保存绑定发布一个 DNS 版本（原因 `manual`），不发布节点的配置版本；审计动作 `dns.binding_update`。
- 记录名在版本与 `dns.binding` 中相对于区域（`@` 为区域根），在 `dns.exportBinding` 中为完整名称。
- 行为见 [DNS 调度：绑定集群](../../guide/dns.md#绑定集群)、[绑定字段](../../guide/dns.md#绑定字段)、[生成的记录](../../guide/dns.md#生成的记录)与[手动模式](../../guide/dns.md#手动模式)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`dns.bindings`](#dnsbindings) | `GET /dns/bindings` | 读 |
| [`dns.binding`](#dnsbinding) | `GET /clusters/{clusterId}/dns` | 读 |
| [`dns.saveBinding`](#dnssavebinding) | `PUT /clusters/{clusterId}/dns` | 写 |
| [`dns.exportBinding`](#dnsexportbinding) | `GET /clusters/{clusterId}/dns/export` | 读 |
| [`dns.siteTarget`](#dnssitetarget) | `GET /sites/{siteId}/cname` | 读；服务账号 `sites:read` |

### `dns.bindings`

`GET /dns/bindings` · 读

无参数。

响应：每个集群一项，按集群名称排序。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `clusterId` | uuid | 集群 ID |
| `clusterName` | string | 集群名称 |
| `mode` | enum | `off` / `manual` / `auto` |
| `providerId` | uuid | 服务商账号 ID，或 `null` |
| `zone` | string | 账号的区域；没有账号时为空字符串 |
| `domain` | string | 集群记录的上级名称；未设置时为空字符串 |
| `revision` | [DNS 版本](#dns-版本对象) | 目标版本，或 `null` |
| `applied` | boolean | 目标版本已写入并读回确认 |
| `blocked` | boolean | 有被大面积摘除保护拦下的版本 |

### `dns.binding`

`GET /clusters/{clusterId}/dns` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | 是 | — | 集群 ID |

响应：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `binding` | [DNS 绑定](#dns-绑定对象) | 保存的绑定 |
| `revision` | [DNS 版本](#dns-版本对象) | 目标版本，或 `null` |
| `applied` | boolean | 目标版本已写入并读回确认 |
| `records` | [DNS 记录](#dns-记录对象)[] | 目标版本的记录；没有版本时为 `[]` |
| `blocked` | object | 被大面积摘除保护拦下的最新版本，或 `null`：[DNS 版本](#dns-版本对象)的字段，另有 `removedRecords`（integer，该版本会移除的地址记录数）、`previousRecords`（integer，目标版本中的地址记录数） |

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |

### `dns.saveBinding`

`PUT /clusters/{clusterId}/dns` · 写

整体替换集群的绑定，并发布 DNS 版本。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | 是 | — | 集群 ID |
| `binding` | body | object | 是 | — | 绑定 |
| `binding.mode` | body | enum | 否 | `off` / `manual` / `auto`，默认 `off` | 管理方式 |
| `binding.providerId` | body | uuid | 否 | 默认 `null`；`auto` 时必填 | 服务商账号 ID，或 `null` |
| `binding.domain` | body | string | 否 | 空字符串或域名（转为小写，不能以 `*.` 开头），至多 180 字符，默认 `""`；`mode` 不为 `off` 时必填；有账号时须为账号区域本身或其下级名称 | 集群记录的上级名称；网站的目标为 `<CNAME 前缀>.<domain>` |
| `binding.ttl` | body | integer | 否 | 30–3600，默认 `600` | 记录的 TTL（秒） |
| `binding.lines` | body | `array<object>` | 否 | 至多 128 个 [DNS 线路](#dns-线路对象)，默认 `[]`；`name` 不重复，`nodeGroupId` 不重复 | 线路 |
| `binding.lineAliases` | body | boolean | 否 | 默认 `false` | 为每个网站另外保留 `<线路名称>.<CNAME 前缀>.<domain>` |

`mode` 为 `off` 时不检查服务商账号、节点组、解析线路与名称冲突。

响应：本次发布的 [DNS 版本](#dns-版本对象)，或 `null`。记录与目标版本相同时返回目标版本；大面积摘除保护拦下时返回仍生效的目标版本，没有目标版本时返回被拦下的版本。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |
| `DNS_PROVIDER_NOT_FOUND` | 404 | `providerId` 对应的账号不存在 |
| `NODE_GROUP_NOT_FOUND` | 404 | 线路的 `nodeGroupId` 或 `backupNodeGroupIds` 不是本集群的节点组 |
| `DNS_ZONE_MISMATCH` | 400 | `domain` 不在账号的区域内 |
| `DNS_LINE_UNSUPPORTED` | 400 | 线路的 `resolutionLine` 不在账号服务商支持的线路中；`data.line` |
| `DNS_POLICY_INVALID` | 400 | 线路名称与汇总记录名（`allLabel`）相同；`overrides` 中节点重复、节点不属于该线路的节点组或地址不是单播地址；管理的记录超过 10000 条 |
| `DNS_BINDING_CONFLICT` | 409 | 同一区域与 `domain` 下另一个集群的绑定使用了相同的汇总记录名或线路名称，或网站、L4 应用的 CNAME 前缀（含仍在过渡期内的旧前缀）使用了该名称；`data.name` |

### `dns.exportBinding`

`GET /clusters/{clusterId}/dns/export` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | 是 | — | 集群 ID |

响应：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `origin` | string | 区域：账号的区域，没有账号时为 `domain`；都没有时为空字符串 |
| `records` | [DNS 记录](#dns-记录对象)[] | 完整名称的记录。`manual`：按当前状态计算的记录；`auto`：目标版本的记录；`off`：`[]` |
| `zoneFile` | string | BIND 区域文件：`$ORIGIN`、`$TTL` 与默认线路的记录，其他解析线路的记录以注释列在 `; line <线路>` 之后；`origin` 为空时为空字符串 |

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |

### `dns.siteTarget`

`GET /sites/{siteId}/cname` · 读 · 服务账号 `sites:read`

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `siteId` | path | uuid | 是 | — | 网站 ID |

响应：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `target` | string | 网站的 CNAME 目标 `<CNAME 前缀>.<domain>`；集群绑定为 `off` 或没有 `domain` 时为 `null` |
| `mode` | enum | `off` / `manual` / `auto` |
| `published` | boolean | 只在 `auto` 时可能为 `true`：目标版本已写入，且其中有该目标在默认线路上的 CNAME 记录 |
| `healthy` | boolean | 只在 `auto` 时可能为 `true`：目标版本的汇总记录中有地址记录 |
| `lines` | `array<object>` | 每条线路 `{ name, target }`：开启 `lineAliases` 时 `target` 为 `<线路名称>.<CNAME 前缀>.<domain>`，否则为 `<线路名称>.<domain>`；`off` 时为 `[]` |
| `retired` | `array<object>` | 修改 CNAME 前缀后仍在解析的旧名称 `{ name, expiresAt }`（`expiresAt` 为 datetime）；`off` 时为 `[]` |

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | 网站不存在 |

## DNS 版本与对账

- 每个 DNS 版本是一次发布的完整记录集；版本号在全部集群中递增且唯一。每个集群保留最新 200 个版本，目标版本、已写入的版本与被拦下的版本不删除。
- 大面积摘除保护：一次发布移除的地址记录占上一版本地址记录的比例超过 `massRemovalRatio`，或会让仍在管理的记录集变空时，新版本以 `blocked` 状态保存，上一版本继续生效，并触发告警 `dns_mass_removal_blocked`。
- 审计动作：`dns.rollback`、`dns.force_publish`、`dns.protection_update`；版本写入完成时 `dns.applied`。
- 行为见 [DNS 调度：大面积摘除保护](../../guide/dns.md#大面积摘除保护)、[DNS 版本与回滚](../../guide/dns.md#dns-版本与回滚)与[健康摘除与修复](../../guide/dns.md#健康摘除与修复)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`dns.bindingRevisions`](#dnsbindingrevisions) | `GET /clusters/{clusterId}/dns/revisions` | 读 |
| [`dns.rollbackBinding`](#dnsrollbackbinding) | `POST /clusters/{clusterId}/dns/revisions/{revision}/rollback` | 写 |
| [`dns.forcePublishBinding`](#dnsforcepublishbinding) | `POST /clusters/{clusterId}/dns/force-publish` | 写 |
| [`dns.protection`](#dnsprotection) | `GET /dns/protection` | 读 |
| [`dns.setProtection`](#dnssetprotection) | `PUT /dns/protection` | 写 |
| [`dns.reconcile`](#dnsreconcile) | `POST /dns/reconcile` | 写 |

### `dns.bindingRevisions`

`GET /clusters/{clusterId}/dns/revisions` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | 是 | — | 集群 ID |

响应：[DNS 版本](#dns-版本对象)[]，从新到旧，至多 200 个。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |

### `dns.rollbackBinding`

`POST /clusters/{clusterId}/dns/revisions/{revision}/rollback` · 写

恢复该版本保存时的绑定设置，并以原因 `rollback` 发布新版本；地址按节点当前的健康状态计算。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | 是 | — | 集群 ID |
| `revision` | path | integer | 是 | ≥1 | 要恢复的版本号 |

响应：新的 [DNS 版本](#dns-版本对象)。被大面积摘除保护拦下时返回仍生效的版本，没有时返回被拦下的版本。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `DNS_REVISION_NOT_FOUND` | 404 | 该集群没有此版本，或版本中的绑定设置不能恢复 |
| `DNS_PROVIDER_NOT_FOUND` | 404 | 版本中的服务商账号已不存在 |
| `NODE_GROUP_NOT_FOUND`、`DNS_ZONE_MISMATCH`、`DNS_LINE_UNSUPPORTED`、`DNS_POLICY_INVALID`、`DNS_BINDING_CONFLICT` | 见 [`dns.saveBinding`](#dnssavebinding) | 恢复的设置不再有效 |

### `dns.forcePublishBinding`

`POST /clusters/{clusterId}/dns/force-publish` · 写

不经大面积摘除保护，按集群当前的绑定发布新版本（原因 `force`）。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | 是 | — | 集群 ID |
| `revision` | body | integer | 是 | ≥1 | 被拦下的版本号（`status` 为 `blocked`） |

响应：新的 [DNS 版本](#dns-版本对象)；记录与目标版本相同时返回目标版本。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `DNS_NOT_BLOCKED` | 409 | 该集群的此版本不存在或不是 `blocked` |

### `dns.protection`

`GET /dns/protection` · 读

无参数。

响应：`{ massRemovalRatio }`（number）。从未保存时为 `0.5`。

### `dns.setProtection`

`PUT /dns/protection` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `massRemovalRatio` | body | number | 是 | 0.05–1 | 一次发布最多可移除的地址记录比例，适用于全部集群 |

响应：`{ massRemovalRatio }`。

### `dns.reconcile`

`POST /dns/reconcile` · 写

重新计算并写入记录。请求体可以省略。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | body | uuid | 否 | — | 只对账该集群 |

- 带 `clusterId`：对账该集群并返回其错误。该集群已有对账在进行时，等待至多 30 秒后再运行一次。
- 不带 `clusterId`：对账每个 `auto` 绑定与仍有记录的绑定，同时至多 4 个；单个集群的失败只记在其版本的 `lastError` 中，不返回错误。
- `manual` 绑定不写入服务商。

响应：`{ ok: true }`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |
| `DNS_RECONCILE_BUSY` | 409 | 等待 30 秒后该集群的对账仍在进行 |
| `DNS_BINDING_CONFLICT` | 409 | 另一个集群管理同一名称；`data.name` |
| `DNS_RECORD_CONFLICT` | 409 | 要写入的名称上已有不由本集群管理的记录；`data.name` |
| `DNS_PROVIDER_AUTH_FAILED` | 400 | 服务商拒绝凭据 |
| `DNS_PROVIDER_ZONE_NOT_FOUND` | 400 | 服务商中没有该区域 |
| `DNS_ADDRESS_REFUSED` | 400 | 自建端点的地址不符合出站策略 |
| `DNS_ZONES_UNSUPPORTED` | 400 | 服务商不支持该操作 |
| `DNS_PROVIDER_RATE_LIMITED` | 429 | 服务商限流 |
| `DNS_PROVIDER_UNREACHABLE` | 502 | 无法连接服务商 |
| `DNS_PROVIDER_FAILED` | 502 | 服务商请求的其他失败 |

## 区域探针

- 探针属于一个区域，从该区域测量各节点的调度地址；节点也可以兼任探针（`nodes.setProbe`）。探测设置为 `settings.probes` / `settings.setProbes`。
- 审计动作：`probe.token_create`、`probe.update`、`probe.delete`。
- 行为见[区域探针与智能调度：区域探针](../../guide/scheduling.md#区域探针)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`probes.list`](#probeslist) | `GET /probes` | 读 |
| [`probes.createToken`](#probescreatetoken) | `POST /probe-tokens` | 写 |
| [`probes.update`](#probesupdate) | `PATCH /probes/{id}` | 写 |
| [`probes.delete`](#probesdelete) | `DELETE /probes/{id}` | 写 |
| [`probes.results`](#probesresults) | `GET /probe-results` | 读 |

### `probes.list`

`GET /probes` · 读

无参数。

响应：[探针](#探针对象)[]，按创建时间排序。

### `probes.createToken`

`POST /probe-tokens` · 写 · 不接受 `Idempotency-Key`

创建在一个区域注册一个探针的一次性令牌。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `name` | body | string | 是 | 去掉首尾空白后 1–64 字符 | 探针名称 |
| `regionId` | body | uuid | 是 | — | 区域 ID |
| `ttlMinutes` | body | integer | 否 | 5–10080，默认 `60` | 令牌有效期（分钟） |

响应：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `tokenId` | uuid | 令牌 ID |
| `token` | string | `ewp_` 开头的令牌，只返回一次；控制台只保存其 SHA-256 |
| `expiresAt` | datetime | 令牌过期时间 |
| `serverUrl` | string | 节点通道地址（`EDGEWEIR_SERVER`） |
| `caSha256` | string | 节点 CA 证书的 SHA-256（`EDGEWEIR_CA_SHA256`） |
| `command` | string | 启动探针的命令：`export EDGEWEIR_TOKEN=…` 与 `docker run`（节点镜像的 `probe` 模式） |

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `REGION_NOT_FOUND` | 404 | 区域不存在 |

### `probes.update`

`PATCH /probes/{id}` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 探针 ID |
| `name` | body | string | 否 | 去掉首尾空白后 1–64 字符；省略时不变 | 探针名称 |
| `enabled` | body | boolean | 否 | 省略时不变 | `false`：节点通道拒绝其证书（续期除外），忽略其结果，并删除其已有结果 |

响应：[探针](#探针对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `PROBE_NOT_FOUND` | 404 | 探针不存在 |

### `probes.delete`

`DELETE /probes/{id}` · 写

删除探针及其结果，并吊销其当前与上一张证书。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 探针 ID |

响应：`{ ok: true }`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `PROBE_NOT_FOUND` | 404 | 探针不存在 |

### `probes.results`

`GET /probe-results` · 读

每个探测方、节点、地址与端口的最新结果。结果保留 1 小时。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `probeId` | query | uuid | 否 | — | 只返回该探测方的结果：探针 ID，或兼任探针的节点 ID |
| `nodeId` | query | uuid | 否 | — | 只返回对该节点的测量 |

响应：[探测结果](#探测结果对象)[]：取最新的至多 5000 条，按节点名称、地址、端口、探测方名称排序。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `PROBE_NOT_FOUND` | 404 | `probeId` 既不是探针也不是节点 |
| `NODE_NOT_FOUND` | 404 | `nodeId` 对应的节点不存在 |

## 外部探测源

- 行为见 [外部探测源](../../guide/scheduling.md#外部探测源)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| `probeSources.list` | `GET /probe-sources` | 读 |
| `probeSources.create` | `POST /probe-sources` | 写 |
| `probeSources.update` | `PATCH /probe-sources/{id}` | 写 |
| `probeSources.delete` | `DELETE /probe-sources/{id}` | 写 |
| `probeSources.rotateWebhookSecret` | `POST /probe-sources/{id}/webhook-secret` | 写 |
| `probeSources.check` | `POST /probe-sources/check` | 写 |
| `probeSources.monitors` | `GET /probe-sources/{id}/monitors` | 读 |
| `probeSources.mappings` | `GET /probe-sources/{id}/mappings` | 读 |
| `probeSources.setMappings` | `PUT /probe-sources/{id}/mappings` | 写 |
| `probeSources.results` | `GET /probe-sources/{id}/results` | 读 |
| `probeSources.modes` | `GET /probe-modes` | 读 |
| `probeSources.setClusterMode` | `PUT /clusters/{clusterId}/probe-mode` | 写 |

请求与响应的字段以 `GET /api/v1/openapi.json` 为准。

## 智能调度规则

- 规则属于一个集群，按节点指标与探针指标的条件对节点执行 DNS 动作：`remove_node`（节点退出规则的线路，或全部线路）、`backup_group`（规则的线路改用其备用节点组）、`backup_ip`（节点改用下一级调度地址）。
- 动作开始与结束时发布 DNS 版本（原因 `scheduling`，`reasonParams.event` 为 `activated` / `recovered`），审计动作 `scheduling.activate` / `scheduling.recover`（操作者为系统）。
- 审计动作：`scheduling.rule_create`、`scheduling.rule_update`、`scheduling.rule_delete`。
- 行为见[区域探针与智能调度：智能调度规则](../../guide/scheduling.md#智能调度规则)、[动作](../../guide/scheduling.md#动作)与[状态与时间](../../guide/scheduling.md#状态与时间)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`scheduling.list`](#schedulinglist) | `GET /scheduling/rules` | 读 |
| [`scheduling.create`](#schedulingcreate) | `POST /scheduling/rules` | 写 |
| [`scheduling.update`](#schedulingupdate) | `PATCH /scheduling/rules/{id}` | 写 |
| [`scheduling.delete`](#schedulingdelete) | `DELETE /scheduling/rules/{id}` | 写 |
| [`scheduling.preview`](#schedulingpreview) | `GET /clusters/{clusterId}/scheduling/preview` | 读 |

### `scheduling.list`

`GET /scheduling/rules` · 读

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | query | uuid | 否 | — | 只返回该集群的规则 |

响应：[调度规则](#调度规则对象)[]，按创建时间排序。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | `clusterId` 对应的集群不存在 |

### `scheduling.create`

`POST /scheduling/rules` · 写 · `201`

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | body | uuid | 是 | — | 集群 ID |
| `lineName` | body | string | 否 | 集群 DNS 绑定中的线路名称，或 `null`，默认 `null`；`action` 为 `backup_group` 时必填 | 规则作用的线路；`null` 为全部线路 |
| `name` | body | string | 是 | 去掉首尾空白后 1–100 字符 | 规则名称 |
| `enabled` | body | boolean | 否 | 默认 `true` | 启用 |
| `match` | body | enum | 否 | `all` / `any`，默认 `all` | `all`：全部条件成立；`any`：任一条件成立 |
| `conditions` | body | `array<object>` | 是 | 1–8 个[调度条件](#调度条件对象) | 条件 |
| `action` | body | enum | 是 | `remove_node` / `backup_group` / `backup_ip` | 动作 |
| `holdSeconds` | body | integer | 否 | 0–86400，默认 `300` | 动作至少保持的秒数 |
| `recoverSeconds` | body | integer | 否 | 0–86400，默认 `300` | 条件持续不成立多少秒后动作恢复 |

响应：[调度规则](#调度规则对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |
| `SCHEDULING_RULE_INVALID` | 400 | `backup_group` 没有 `lineName`，或 `lineName` 不在集群的 DNS 绑定中 |
| `REGION_NOT_FOUND` | 404 | 条件的 `regionId` 对应的区域不存在 |

### `scheduling.update`

`PATCH /scheduling/rules/{id}` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 规则 ID |
| `lineName` | body | string | 否 | 同 `scheduling.create`；省略时不变 | 线路名称，或 `null` |
| `name` | body | string | 否 | 同 `scheduling.create`；省略时不变 | 规则名称 |
| `enabled` | body | boolean | 否 | 省略时不变 | 启用 |
| `match` | body | enum | 否 | `all` / `any`；省略时不变 | 条件的组合方式 |
| `conditions` | body | `array<object>` | 否 | 1–8 个[调度条件](#调度条件对象)，整体替换；省略时不变 | 条件 |
| `action` | body | enum | 否 | 同 `scheduling.create`；省略时不变 | 动作 |
| `holdSeconds` | body | integer | 否 | 0–86400；省略时不变 | 动作至少保持的秒数 |
| `recoverSeconds` | body | integer | 否 | 0–86400；省略时不变 | 恢复前条件持续不成立的秒数 |

- 集群不能修改。
- 从启用改为 `enabled: false`，或 `lineName`、`match`、`action`、`conditions` 与当前不同时，规则当前的动作结束（必要时发布 DNS 版本），状态重新开始；只修改 `name`、`holdSeconds`、`recoverSeconds` 时不影响。
- 只在给出 `lineName` 或 `action` 时检查线路，只在给出 `conditions` 时检查区域。

响应：[调度规则](#调度规则对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SCHEDULING_RULE_NOT_FOUND` | 404 | 规则不存在 |
| `SCHEDULING_RULE_INVALID` | 400 | 修改后的 `backup_group` 没有 `lineName`，或 `lineName` 不在集群的 DNS 绑定中 |
| `REGION_NOT_FOUND` | 404 | 条件的 `regionId` 对应的区域不存在 |

### `scheduling.delete`

`DELETE /scheduling/rules/{id}` · 写

删除规则；规则当前的动作结束，每个受影响的节点发布一次 DNS 版本（原因 `scheduling`，`event` 为 `recovered`）。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 规则 ID |

响应：`{ ok: true }`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `SCHEDULING_RULE_NOT_FOUND` | 404 | 规则不存在 |

### `scheduling.preview`

`GET /clusters/{clusterId}/scheduling/preview` · 读

按当前指标对集群的每条规则与每个节点求值，不写入。行为见[预览](../../guide/scheduling.md#预览)。

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `clusterId` | path | uuid | 是 | — | 集群 ID |

响应：[调度预览](#调度预览对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | 集群不存在 |

## 对象

### DNS 服务商目录对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | enum | 服务商 ID，见[服务商与凭据字段](#服务商与凭据字段) |
| `name` | string | 英文名称 |
| `fields` | `array<object>` | 凭据字段，见下表 |
| `capabilities.recordTypes` | `array<enum>` | 可写的记录类型：`A`、`AAAA`、`CNAME`、`TXT` |
| `capabilities.listZones` | boolean | 能列出账号的区域（`dns.zones`） |
| `capabilities.lines` | `array<enum>` | 适配器写入的解析线路，`default` 在前：`default`、`telecom`、`unicom`、`mobile`、`edu`、`overseas` 的子集 |
| `capabilities.apex` | enum | 区域根指向主机名的方式：`cname`（CNAME 展平）、`alias`（ALIAS 记录），或 `null`（不支持） |
| `capabilities.endpoint` | enum | `fixed`：服务商的固定接入点；`custom`：用户填写服务器地址，适用出站地址策略 |

`fields[]`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `key` | string | 凭据键（snake_case），即 `credentials` 中的键 |
| `type` | enum | `text` / `secret` / `select` / `textarea` / `url` |
| `secret` | boolean | 保存后不再显示，以密码框输入 |
| `required` | boolean | 必填 |
| `placeholder` | string | 格式示例；可省略 |
| `pattern` | string | 值须匹配的正则表达式（JavaScript 与 RE2 通用，有锚点）；可省略 |
| `maxLength` | number | 最大长度 |
| `options` | `array<string>` | `select` 字段的可选值；可省略 |
| `default` | string | 默认值；可省略 |

### 服务商与凭据字段

全部服务商的记录类型均为 `A`、`AAAA`、`CNAME`、`TXT`。「全部线路」指 `default`、`telecom`、`unicom`、`mobile`、`edu`、`overseas`；其余服务商只有 `default`。

| ID | 名称 | 列出区域 | 解析线路 | 区域根 | 接入点 |
| --- | --- | --- | --- | --- | --- |
| `cloudflare` | Cloudflare | 是 | `default` | `cname` | `fixed` |
| `alidns` | Alibaba Cloud DNS | 是 | 全部线路 | `null` | `fixed` |
| `huaweicloud` | Huawei Cloud DNS | 是 | 全部线路 | `null` | `fixed` |
| `dnspod` | DNSPod (token API) | 是 | 全部线路 | `null` | `fixed` |
| `tencentcloud` | Tencent Cloud DNSPod (API 3.0) | 是 | 全部线路 | `null` | `fixed` |
| `volcengine` | Volcengine DNS | 是 | `default` | `null` | `fixed` |
| `baiducloud` | Baidu AI Cloud DNS | 是 | `default` | `null` | `fixed` |
| `westcn` | West.cn | 是 | `default` | `null` | `fixed` |
| `dnsla` | DNS.LA | 是 | `default` | `null` | `fixed` |
| `route53` | Amazon Route 53 | 是 | `default` | `null` | `fixed` |
| `googleclouddns` | Google Cloud DNS | 是 | `default` | `alias` | `fixed` |
| `azure` | Azure DNS | 是 | `default` | `null` | `fixed` |
| `digitalocean` | DigitalOcean | 是 | `default` | `null` | `fixed` |
| `vultr` | Vultr | 是 | `default` | `null` | `fixed` |
| `linode` | Akamai Cloud (Linode) | 是 | `default` | `null` | `fixed` |
| `hetzner` | Hetzner Cloud DNS | 是 | `default` | `null` | `fixed` |
| `ovh` | OVHcloud | 是 | `default` | `null` | `fixed` |
| `gandi` | Gandi LiveDNS | 是 | `default` | `alias` | `fixed` |
| `godaddy` | GoDaddy | 是 | `default` | `null` | `fixed` |
| `porkbun` | Porkbun | 是 | `default` | `alias` | `fixed` |
| `namesilo` | NameSilo | 是 | `default` | `null` | `fixed` |
| `gcore` | Gcore | 是 | `default` | `cname` | `fixed` |
| `bunny` | Bunny DNS | 是 | `default` | `cname` | `fixed` |
| `desec` | deSEC | 是 | `default` | `null` | `fixed` |
| `powerdns` | PowerDNS | 是 | `default` | `null` | `custom` |
| `rfc2136` | RFC 2136 (TSIG) | 否 | `default` | `null` | `custom` |
| `webhook` | Custom HTTP | 是 | `default` | `null` | `custom` |
| `test` | Local test fixture | 是 | 全部线路 | `null` | `fixed` |

`test` 只在设置了 `EDGEWEIR_DNS_TEST_ENDPOINT` 时可用。

凭据字段（类型为 `secret` 与 `textarea` 的字段保存后不再显示）：

| 服务商 | 字段 | 类型 | 必填 | 最大长度 | 格式与默认值 |
| --- | --- | --- | --- | --- | --- |
| `cloudflare` | `api_token` | secret | 是 | 256 | 20–256 位字母、数字、`_`、`.`、`-` |
| `cloudflare` | `zone_token` | secret | 否 | 256 | 同 `api_token` |
| `alidns` | `access_key_id` | text | 是 | 128 | 1–128 位字母、数字、`.` |
| `alidns` | `access_key_secret` | secret | 是 | 256 | — |
| `alidns` | `region_id` | text | 否 | 32 | 1–32 位小写字母、数字、`-`；示例 `cn-hangzhou` |
| `alidns` | `security_token` | secret | 否 | 4096 | — |
| `huaweicloud` | `access_key_id` | text | 是 | 128 | 1–128 位字母、数字 |
| `huaweicloud` | `secret_access_key` | secret | 是 | 256 | — |
| `huaweicloud` | `region_id` | text | 否 | 32 | 1–32 位小写字母、数字、`-`；示例 `cn-north-4` |
| `dnspod` | `auth_token` | secret | 是 | 149 | `<ID>,<Token>`：1–20 位数字，逗号，8–128 位字母、数字 |
| `tencentcloud` | `secret_id` | text | 是 | 128 | 1–128 位字母、数字 |
| `tencentcloud` | `secret_key` | secret | 是 | 256 | — |
| `tencentcloud` | `site` | select | 否 | 4 | `cn` / `intl`，默认 `cn` |
| `volcengine` | `access_key_id` | text | 是 | 128 | 16–128 位字母、数字 |
| `volcengine` | `secret_access_key` | secret | 是 | 256 | — |
| `baiducloud` | `access_key_id` | text | 是 | 128 | 16–128 位字母、数字 |
| `baiducloud` | `secret_access_key` | secret | 是 | 256 | — |
| `westcn` | `username` | text | 是 | 64 | — |
| `westcn` | `api_password` | secret | 是 | 256 | — |
| `dnsla` | `api_id` | text | 是 | 128 | 1–128 位可打印 ASCII 字符，不含空格与 `:` |
| `dnsla` | `api_secret` | secret | 是 | 256 | — |
| `route53` | `access_key_id` | text | 是 | 128 | 16–128 位字母、数字、`_` |
| `route53` | `secret_access_key` | secret | 是 | 128 | — |
| `route53` | `session_token` | secret | 否 | 8192 | — |
| `route53` | `hosted_zone_id` | text | 否 | 44 | 1–32 位大写字母、数字，可带前缀 `/hostedzone/` |
| `route53` | `partition` | select | 否 | 10 | `aws` / `aws-cn` / `aws-us-gov`，默认 `aws` |
| `googleclouddns` | `service_account_json` | textarea | 是 | 16384 | 服务账号密钥 JSON |
| `googleclouddns` | `project_id` | text | 否 | 100 | 6–30 位，小写字母开头，小写字母、数字、`-`，不以 `-` 结尾；可带 `<域名>:` 前缀 |
| `googleclouddns` | `managed_zone` | text | 否 | 63 | 托管区域名称（小写字母开头，1–63 位小写字母、数字、`-`）或 1–20 位数字 ID |
| `azure` | `tenant_id` | text | 是 | 253 | GUID 或域名 |
| `azure` | `client_id` | text | 是 | 36 | GUID |
| `azure` | `client_secret` | secret | 是 | 1024 | — |
| `azure` | `subscription_id` | text | 是 | 36 | GUID |
| `azure` | `resource_group` | text | 是 | 90 | 1–90 位字母、数字、`_`、`(`、`)`、`.`、`-`，不以 `.` 结尾 |
| `digitalocean` | `api_token` | secret | 是 | 128 | 64 位小写十六进制，可带前缀 `dop_v1_` |
| `vultr` | `api_key` | secret | 是 | 64 | — |
| `linode` | `api_token` | secret | 是 | 128 | — |
| `hetzner` | `api_token` | secret | 是 | 128 | — |
| `ovh` | `endpoint` | select | 是 | 6 | `ovh-eu` / `ovh-ca` / `ovh-us`，默认 `ovh-eu` |
| `ovh` | `application_key` | text | 是 | 128 | 8–128 位字母、数字 |
| `ovh` | `application_secret` | secret | 是 | 128 | 8–128 位字母、数字 |
| `ovh` | `consumer_key` | secret | 是 | 128 | 8–128 位字母、数字 |
| `gandi` | `bearer_token` | secret | 是 | 512 | 16–512 位字母、数字、`_`、`.`、`-` |
| `godaddy` | `api_token` | secret | 是 | 4096 | `key:secret`（两部分各 8–128 位字母、数字、`_`），或至少 16 位字母、数字与 `_.~+/=-` |
| `porkbun` | `api_key` | secret | 是 | 260 | `pk1_` 加 8–256 位字母、数字、`_` |
| `porkbun` | `api_secret_key` | secret | 是 | 260 | `sk1_` 加 8–256 位字母、数字、`_` |
| `namesilo` | `api_token` | secret | 是 | 128 | 8–128 位字母、数字 |
| `gcore` | `api_key` | secret | 是 | 4096 | `<数字>$<字母、数字与 ._~+/=->` |
| `bunny` | `access_key` | secret | 是 | 128 | 16–128 位字母、数字、`-` |
| `desec` | `token` | secret | 是 | 128 | 16–128 位字母、数字、`_`、`-` |
| `powerdns` | `server_url` | url | 是 | 256 | `http://` 或 `https://` 加主机（可带端口），可带末尾 `/`，不含路径、查询、`@` 与片段 |
| `powerdns` | `api_key` | secret | 是 | 256 | — |
| `powerdns` | `server_id` | text | 否 | 64 | 1–64 位字母、数字、`.`、`_`、`-`，默认 `localhost` |
| `rfc2136` | `server` | text | 是 | 261 | 主机或 `主机:端口`：1–261 位字母、数字与 `._:[]-` |
| `rfc2136` | `tsig_key_name` | text | 是 | 253 | 1–253 位字母、数字、`.`、`_`、`-` |
| `rfc2136` | `tsig_algorithm` | select | 是 | 11 | `hmac-sha256` / `hmac-sha512` / `hmac-sha384` / `hmac-sha224` / `hmac-sha1`，默认 `hmac-sha256` |
| `rfc2136` | `tsig_secret` | secret | 是 | 512 | Base64 |
| `webhook` | `url` | url | 是 | 512 | `http://` 或 `https://` URL，不含空白、`@` 与 `#` |
| `webhook` | `secret` | secret | 是 | 256 | 至少 16 字符 |
| `test` | `api_token` | secret | 是 | 1024 | — |

### DNS 服务商账号对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 账号 ID |
| `name` | string | 账号名称 |
| `provider` | enum | 服务商 ID |
| `zone` | string | 区域 |

### DNS 绑定对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `clusterId` | uuid | 集群 ID |
| `mode` | enum | `off` / `manual` / `auto` |
| `providerId` | uuid | 服务商账号 ID，或 `null` |
| `zone` | string | 账号的区域；没有账号时为空字符串 |
| `domain` | string | 集群记录的上级名称 |
| `ttl` | number | TTL（秒） |
| `lines` | [DNS 线路](#dns-线路对象)[] | 线路；此前保存的线路缺少的字段按默认值返回 |
| `lineAliases` | boolean | 为每个网站保留线路别名 |
| `allLabel` | string | 包含全部线路地址的汇总记录名：`all`，或从全局 DNS 配置迁移的共用域名为 `all-<n>` |
| `updatedAt` | datetime | 最近保存时间；从未保存时为 `1970-01-01T00:00:00.000Z` |

### DNS 线路对象

`dns.saveBinding` 的 `binding.lines[]` 与 [DNS 绑定](#dns-绑定对象)的 `lines[]`。

| 字段 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `name` | string | 是 | 1–32 位小写字母、数字、`-`，以字母或数字开头和结尾，不能为 `all` | 线路名称，记录名为 `<name>.<domain>` |
| `nodeGroupId` | uuid | 是 | 本集群的节点组 | 线路的节点组 |
| `overrides` | `array<object>` | 否 | 至多 1000 个 `{ nodeId, addresses }`，默认 `[]`；`nodeId` 为该节点组的节点，不重复；`addresses` 为 1–8 个 IP 地址（规范化），不能是回环、链路本地、组播、文档等特殊用途地址（私网 `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`fc00::/7` 除外） | 节点在该线路上使用的地址 |
| `resolutionLine` | enum | 否 | `default` / `telecom` / `unicom` / `mobile` / `edu` / `overseas`，默认 `default` | 汇总记录在该解析线路上返回本线路的地址 |
| `backupNodeGroupIds` | `array<uuid>` | 否 | 至多 4 个本集群的节点组，不重复，不含 `nodeGroupId`，默认 `[]` | 备用节点组 |
| `minHealthyIps` | integer | 否 | 1–64，默认 `1` | 本线路节点组的健康地址少于此数时，由第一个达到此数的备用节点组应答 |

行为见 [DNS 调度：按解析线路写入](../../guide/dns.md#按解析线路写入)与[备用节点组](../../guide/dns.md#备用节点组)。

### DNS 记录对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | string | 记录名：相对于区域（`@` 为区域根），`dns.exportBinding` 中为完整名称 |
| `type` | enum | `A` / `AAAA` / `CNAME` / `TXT` |
| `data` | string | 记录值 |
| `ttl` | number | TTL（秒） |
| `line` | enum | 解析线路：`telecom` / `unicom` / `mobile` / `edu` / `overseas`；默认线路的记录没有此字段 |

### DNS 版本对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `revision` | number | 版本号 |
| `status` | enum | `pending`（待写入）/ `applied`（已写入；`manual` 的版本保存即为 `applied`）/ `failed` / `superseded`（被更新的版本取代）/ `blocked`（被大面积摘除保护拦下） |
| `reason` | string | 发布原因代码，见下表；未知代码按原样显示 |
| `reasonParams` | object | 原因的参数，值为 string 或 number；没有参数时为 `{}` |
| `recordCount` | number | 记录数 |
| `createdAt` | datetime | 创建时间 |
| `appliedAt` | datetime | 写入完成时间，或 `null` |
| `lastError` | string | 最近一次失败的代码，没有时为空字符串；例如 `dns_reconcile_failed`、`dns_auth_failed`、`dns_zone_not_found`、`dns_provider_unreachable`、`dns_rate_limited`、`dns_record_conflict`、`dns_binding_conflict`、`dns_zone_mismatch`、`dns_mass_removal_blocked`、`certd_failed`、`certd_timeout` |
| `lastErrorParams` | object | 错误代码的参数（string）：`dns_record_conflict`、`dns_binding_conflict` 为 `name` |

| 原因 | 参数 | 发布时机 |
| --- | --- | --- |
| `manual` | — | 保存绑定（`dns.saveBinding`），或修改节点的调度地址（`nodes.setAddresses`） |
| `health` | — | 对账时节点健康变化，或探针判定的调度地址可达性变化 |
| `rollback` | — | `dns.rollbackBinding` |
| `force` | — | `dns.forcePublishBinding` |
| `scheduling` | `rule`、`node`、`ruleId`、`nodeId`、`action`（`remove_node` / `backup_group` / `backup_ip`）、`event`（`activated` / `recovered`） | 智能调度规则的动作开始或结束 |
| `cname` | `name` | 网站或 L4 应用的 CNAME 前缀变化 |
| `cname_expired` | — | 被替换的 CNAME 前缀在 24 小时后停止解析 |

### 探针对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 探针 ID |
| `name` | string | 名称 |
| `regionId` | uuid | 区域 ID |
| `regionName` | string | 区域名称 |
| `regionCode` | string | 区域代码 |
| `enabled` | boolean | 启用 |
| `online` | boolean | 在 `max(3 × 探测间隔, 30 秒)` 内获取过目标或上报过结果 |
| `lastSeenAt` | datetime | 最近一次连接时间，或 `null` |
| `enrolledAt` | datetime | 注册时间，或 `null` |
| `hostname` | string | 主机名 |
| `agentVersion` | string | 探针程序版本 |
| `os` | string | 操作系统 |
| `arch` | string | CPU 架构 |
| `certNotAfter` | datetime | 证书到期时间，或 `null` |
| `targets` | integer | 探针当前的目标数：每个启用节点的每个调度地址 × 其集群的每个监听端口 |
| `lastRound` | object | 最近一轮结果，没有结果时为 `null`：`checkedAt`（datetime）、`results`（integer，目标数）、`failed`（integer，全部尝试丢失的目标数）、`lossPercent`（number，丢失尝试 / 发送尝试，百分比，一位小数）、`avgRttMs`（number，有应答目标的往返时间中位数的平均值，没有应答时为 `null`） |
| `channel` | [节点通道状态](#节点通道状态对象) | 探针连接节点通道的状态；探针尚未向记录此信息的控制台连接时为 `null` |
| `createdAt` | datetime | 创建时间 |

### 节点通道状态对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `url` | string | 当前使用的节点通道地址，或 `null` |
| `serverName` | string | 当前地址的 TLS 服务器名称 |
| `fallbackUrl` | string | 上一次切换前的地址，当前地址失败时尝试；或 `null` |
| `fallbackServerName` | string | 回退地址的 TLS 服务器名称 |
| `onFallback` | boolean | 因当前地址失败而在使用回退地址 |
| `source` | enum | 当前地址的来源：`enroll`（注册）/ `console`（控制台下发）/ `command`（`edgeweir-node set-server`），或 `null` |
| `switchedAt` | datetime | 最近一次切换时间，或 `null` |
| `error` | object | 最近一次检查地址失败，或 `null`：`code`、`message`、`url`、`serverName`、`at`（datetime） |
| `observedServerName` | string | 最近一次连接的 TLS 服务器名称；未发送（使用 IP 地址）时为空字符串 |
| `observedWebSocket` | boolean | 最近一次连接经 WebSocket 入口 |
| `observedAt` | datetime | 最近一次连接时间 |

### 探测结果对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `proberKind` | enum | `probe`（探针）/ `node`（兼任探针的节点） |
| `proberId` | uuid | 探测方 ID |
| `proberName` | string | 探测方名称 |
| `regionId` | uuid | 探测方的区域 ID，或 `null` |
| `regionName` | string | 区域名称，或 `null` |
| `nodeId` | uuid | 被测量的节点 ID |
| `nodeName` | string | 节点名称 |
| `address` | string | 调度地址 |
| `port` | integer | 端口 |
| `method` | enum | `tcp` / `http` / `https` |
| `sent` | integer | 发送的尝试数 |
| `lost` | integer | 丢失的尝试数 |
| `lossPercent` | number | 丢失比例（百分比，一位小数） |
| `rttMs` | integer | 有应答尝试的往返时间中位数；全部丢失时为 `0` |
| `error` | string | 最近一次失败的代码：`timeout`、`refused`、`reset`、`tls`、`status`、`unreachable` |
| `checkedAt` | datetime | 测量时间 |

### 调度条件对象

| 字段 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `metric` | enum | 是 | `cpu_percent` / `load1` / `memory_percent` / `egress_mbps` / `connections` / `probe_loss_percent` / `probe_latency_ms` | 指标；后两个为探针指标 |
| `aggregate` | enum | 否 | `avg` / `max` / `min`，默认 `avg` | 探针指标在各探测方之间的聚合方式；节点指标取节点自身的值 |
| `comparator` | enum | 是 | `gt` / `ge` / `lt` / `le` | 比较方式 |
| `threshold` | number | 是 | 0–10¹² | 阈值 |
| `durationSeconds` | integer | 否 | 0–3600，默认 `0` | 比较持续成立多少秒后条件才算成立 |
| `regionId` | uuid | 否 | 默认 `null`；只能用于探针指标，否则 400 `BAD_REQUEST` | 只计该区域的探测方 |

### 调度规则对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 规则 ID |
| `clusterId` | uuid | 集群 ID |
| `lineName` | string | 线路名称，或 `null`（全部线路） |
| `name` | string | 规则名称 |
| `enabled` | boolean | 启用 |
| `match` | enum | `all` / `any` |
| `conditions` | [调度条件](#调度条件对象)[] | 条件，已补齐默认值 |
| `action` | enum | `remove_node` / `backup_group` / `backup_ip` |
| `holdSeconds` | integer | 动作至少保持的秒数 |
| `recoverSeconds` | integer | 恢复前条件持续不成立的秒数 |
| `activeNodes` | `array<object>` | 动作当前作用的节点（生效中与恢复中）`{ nodeId, nodeName, since }`，按节点名称排序；`since` 为 datetime |
| `createdAt` | datetime | 创建时间 |
| `updatedAt` | datetime | 最近修改时间 |

### 调度预览对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `clusterId` | uuid | 集群 ID |
| `evaluatedAt` | datetime | 求值时间 |
| `rules` | `array<object>` | 每条规则：`ruleId`、`ruleName`、`enabled`、`lineName`（或 `null`）、`match`、`action`、`nodes` |
| `rules[].nodes` | `array<object>` | 规则涉及的每个节点，字段见下表 |

`rules[].nodes[]`：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `nodeId` | uuid | 节点 ID |
| `nodeName` | string | 节点名称 |
| `state` | enum | `idle`（条件不成立）/ `pending`（条件成立但未满持续时间）/ `active` / `recovering`（条件已不成立，等待恢复） |
| `conditions` | `array<object>` | 每个条件：[调度条件](#调度条件对象)的字段，另有 `value`（number，当前值；没有新的指标或探测结果时为 `null`）、`holds`（boolean，比较当前成立）、`heldSeconds`（integer，截至最近一次求值已成立的秒数）、`satisfied`（boolean，已成立至少 `durationSeconds`） |
| `matches` | boolean | 条件按 `match` 及其持续时间当前成立 |
| `inEffect` | boolean | 动作当前作用于该节点（`active` 或 `recovering`） |
| `wouldActivate` | boolean | 下一次求值开始动作 |
| `wouldRecover` | boolean | 下一次求值结束动作 |
| `activeSince` | datetime | 动作开始时间，或 `null` |
| `recoveringSince` | datetime | 开始恢复的时间，或 `null` |
| `recoversAt` | datetime | 条件保持不成立时动作最早结束的时间，或 `null` |
