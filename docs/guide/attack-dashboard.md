# 攻击与自动缓解

网站「攻击」页签的拦截、来源与命中统计，以及按 CC 级别自动开启和关闭网站 Under Attack 的自动缓解。

## 概念

| 术语 | 定义 |
| --- | --- |
| 拦截原因 | 请求被拒绝或挑战的原因，见[访问日志](access-logs.md#拦截原因)。 |
| CC 级别 | 节点上网站的挑战级别，从低到高为「正常」「Cookie 跳转」「JS 计算」「非交互式挑战」「交互式挑战」，见[挑战与 CC 防护](challenges.md)。 |
| 网站级别 | 集群中在线的活动节点上该网站最高的 CC 级别。 |
| 触发级别 | 自动缓解开启 Under Attack 的 CC 级别，不含「正常」。 |
| 保持时间 | 网站级别最后一次达到触发级别之后保持 Under Attack 的分钟数（5–1440）。 |
| 保持 | 自动缓解已经开启 Under Attack 且尚未关闭。 |

## 攻击页签

页面：**网站 →（网站）→ 攻击**（`/sites/<网站 ID>?tab=attacks`）。右上角的「时间范围」（过去 1 小时、过去 6 小时、过去 24 小时（默认）、过去 7 天、过去 30 天）对「自动缓解」与「节点当前级别」以外的卡片生效，保存在 URL 的 `range`（`1h`、`6h`、`24h`、`7d`、`30d`，与「统计」页签共用）。

| 卡片 | 内容 |
| --- | --- |
| 自动缓解 | 设置与当前状态，见[自动缓解](#自动缓解) |
| 拦截原因 | 来自统计：请求数最多的 5 个拦截原因随时间的堆叠柱状图（其余合为「其他」）与按请求数排序的列表；行右侧的「查看日志」打开访问日志，已筛选该原因与同一时间范围 |
| 节点当前级别 | 集群中每个活动节点的名称、「在线」/「离线」、该网站的级别与「N 条路径已升级」；每 15 秒刷新 |
| 近期 Top IP 与路径 | 时间范围内安全事件中请求最多的地址与路径（近似值）；行右侧的「查看日志」打开访问日志，已筛选该地址（或路径）与同一时间范围；IP 行的「⋯」→「封禁 IP」，路径行的「⋯」→「刷新 URL」 |
| 命中最多的 CRS 规则 | WAF 命中最多的 10 个 CRS 规则 ID（近似值）；检测规则的「⋯」→「排除 CRS 规则 {id}」或「按路径排除」，见[WAF](waf.md) |
| 记录命中 | 「记录」动作的规则命中次数最多的 10 条（近似值）；全局规则标「（全局）」，已删除的规则显示「已删除的规则」，见[规则](rules.md) |
| 挑战通过率 | 「通过率」（已通过 / 已下发，最高 100%）、「已下发」、「已通过」 |
| 鉴权失败 | 访问鉴权拒绝的请求数，见[访问控制](access-control.md) |
| 事件 | 级别变化、路径升降级与自动封禁的时间线，见[事件](#事件) |

集群中有节点不上报相应数据时，卡片显示「集群中有节点不上报这些统计」「集群中有节点不上报规则命中」或「集群中有节点不上报鉴权失败」。

「近期 Top IP 与路径」与「事件」只来自节点上报的安全事件，每个事件携带当时请求最多的地址与路径，结果为近似值；事件保留天数见[查看状态与事件](challenges.md#查看状态与事件)，超出保留期的范围没有数据。

### 事件

每页 20 条，每 30 秒刷新；「事件类型」可选「全部」「网站级别」「路径级别」「自动封禁」。

| 字段 | 内容 |
| --- | --- |
| 类型 | 「网站级别」「路径级别」「自动封禁」 |
| 变化 | 级别变化「{from} → {to}」，路径级别另显示路径；自动封禁显示被封地址 |
| 节点 | 产生事件的节点；节点已删除时显示「已删除的节点」 |
| 触发条件 | 「{metric} {observed} / {threshold}」，指标为「网站 QPS」「单 URL QPS」「单 IP QPS」「源站错误率」「冷却」等 |
| 时间 | 距今多久，悬停显示具体时间 |

行右侧的「查看日志」打开事件前后各 5 分钟的访问日志（自动封禁筛选该地址，路径级别筛选该路径）。自动封禁行的「⋯」：「在所有网站封禁」打开范围为「全局」的封禁对话框；「解封」解除本网站对该地址的封禁（覆盖它的网段封禁保留），见[封禁](bans.md#从其他页面封禁)。

### 访问日志链接

链接 `/sites/<网站 ID>?tab=logs` 打开「日志」页签，查询参数作为筛选条件带入：

| 参数 | 内容 |
| --- | --- |
| `blockReason` | 拦截原因，`any` 为任一原因 |
| `ip`、`cidr` | 客户端地址或网段（最长 64 字符） |
| `path` | 路径（最长 2048 字符） |
| `from`、`to` | 时间窗口，ISO 8601 |

切换页签时清除这些参数。

## 自动缓解

在「自动缓解」卡片点击「设置」（已设置时点击卡片右上角的「编辑」），填写后点击「保存」：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| 启用 | 开 | 关闭后不再自动开启；正在保持时立即关闭 Under Attack |
| 触发级别 | 非交互式挑战 | 「Cookie 跳转」「JS 计算」「非交互式挑战」「交互式挑战」 |
| 低于触发级别后保持（分钟） | 30 | 5–1440 |

未设置的网站不启用自动缓解，卡片显示「未设置」。卡片每 15 秒刷新，显示「状态」（「已开启」「待命」「已关闭」）、「触发级别」、「保持时间」与「当前级别」（网站级别）。

1. 网站级别达到或超过触发级别。
2. 自动缓解开启该网站的 Under Attack（挑战类型沿用该网站 Under Attack 卡片的「挑战类型」），发布网站所在集群的配置版本。卡片显示「Under Attack 已开启，至 {time}」与「立即结束」，网站「安全」页签的 Under Attack 卡片显示「自动开启，至 {time}」。
3. 网站级别保持在触发级别及以上期间，到期时间推迟到「现在 + 保持时间」，不产生新的配置版本。
4. 网站级别低于触发级别并且到期后，自动关闭 Under Attack，发布配置版本。

| 条件 | 行为 |
| --- | --- |
| 开始 | 已启用、未暂停、网站已启用、网站自己的 Under Attack 未开启、网站级别达到触发级别 |
| 网站级别 | 在线活动节点中最高的一个：节点最近一次心跳带来的级别；其后 5 分钟内收到的该节点「网站级别」事件优先 |
| CC 未开启 | 卡片显示「该网站未开启 CC，级别不会上升」 |
| CC 最高级别低于触发级别 | 卡片显示「CC 最高升到 {max}，达不到触发级别」 |

> [!NOTE]
> 节点上网站的所有请求都计入 CC 的 QPS，所以 Under Attack 开启后级别仍保持在高位，攻击停止后才逐级回落，到期不会在攻击中途误关。

### 手动操作

自动缓解只关闭它自己开启的 Under Attack：

| 操作 | 结果 |
| --- | --- |
| 开始前 Under Attack 已手动开启 | 不处理，也不会关闭 |
| 保持期间手动开启 Under Attack | 视为手动开启，自动缓解不再关闭，保持状态清空 |
| 保持期间手动关闭 Under Attack | 保持结束并暂停：卡片显示「已手动结束，级别低于 {level} 前不再自动开启」 |
| 点击「立即结束」并确认 | 关闭 Under Attack，同上暂停；没有保持时返回 409 `AUTO_MITIGATION_NOT_ACTIVE`（「自动缓解没有开启 Under Attack」） |
| 修改设置 | 清除暂停与错误；禁用时立即关闭 Under Attack；缩短保持时间时到期时间最晚为「现在 + 新的保持时间」 |
| 网站停用 | 不开始 |

暂停在网站级别低于触发级别后自动解除。「复制网站设置」不复制自动缓解保持的 Under Attack；目标网站正在保持时，复制不会将其关闭；复制把 Under Attack 打开时视为手动开启。

### 失败与重试

开启或关闭不能发布时（例如集群的活动节点缺少所需能力，`NODE_CAPABILITY_REQUIRED`），该次变更回滚，错误码保存在 `lastError`，卡片显示「未能应用，每分钟重试」，之后每次检查重试。

### 执行方式

pg-boss 任务 `mitigation.evaluate` 每分钟检查所有已启用、正在保持或已暂停的网站；节点上报某个网站的级别升高后立即检查它，不等下一个整分钟。每次检查在一个事务内完成，保持状态与到期时间保存在数据库，控制台重启或任务重复执行不影响结果。

## 权限与审计

修改需要控制台会话或读写 AccessKey；只读 AccessKey 与演示账号只能读取（403 `ACCESS_KEY_READ_ONLY` / `DEMO_READ_ONLY`）；服务账号不能调用这些接口（403 `SERVICE_ACCOUNT_FORBIDDEN`）。

| 审计动作 | 触发 | 元数据 |
| --- | --- | --- |
| `site.auto_mitigation_update` | 修改设置 | `from`、`to` |
| `site.auto_mitigation_apply` | 自动开启 Under Attack（操作者为系统） | `level`、`threshold`、`durationMinutes`、`revision` |
| `site.auto_mitigation_release` | 关闭 Under Attack：到期（操作者为系统）或在设置中禁用（操作者为修改者） | `reason`（`expired` / `disabled`）、`since`、`revision` |
| `site.auto_mitigation_restore` | 「立即结束」 | `level`、`threshold`、`since`；发布了配置版本时另含 `revision` |

发布的配置版本原因为「自动缓解为 {site} 开启 Under Attack」「自动缓解为 {site} 关闭 Under Attack」（`auto_mitigation_started` / `auto_mitigation_ended`）。

## API

路径位于 `/api/v1` 下。

| 过程 | 端点 | 说明 |
| --- | --- | --- |
| `autoMitigation.get` | `GET /sites/{id}/auto-mitigation` | `settings`（未设置为 `null`）、`updatedAt`、`level`、`active`（`since`、`expiresAt`、`level`）、`paused`、`lastError` |
| `autoMitigation.update` | `PUT /sites/{id}/auto-mitigation` | `enabled`、`threshold`（`cookie302` / `js` / `pow` / `captcha`）、`durationMinutes`；可带 `expectedUpdatedAt`，不一致时返回 409 `UPDATED_AT_MISMATCH` |
| `autoMitigation.restore` | `POST /sites/{id}/auto-mitigation/restore` | 立即结束 |
| `analytics.breakdown` | `GET /analytics/breakdown?by=block_reason&siteId=…&range=…` | 按拦截原因的请求数随时间变化 |
| `analytics.dimensions` | `GET /analytics/dimensions?siteId=…&range=…` | 拦截原因与挑战下发、通过数 |
| `security.state` | `GET /sites/{id}/security?hours=…` | 节点当前级别与近 `hours`（1–720，默认 24）小时的 Top IP、Top 路径 |
| `security.events` | `GET /sites/{id}/security/events` | 事件；查询参数 `kind`（`site_level` / `path_level` / `ip_banned`）、`hours`（1–720）、`page`、`pageSize` |
| `waf.topRules` | `GET /sites/{id}/waf/rules?range=…&limit=…` | 命中最多的 CRS 规则 |
| `rules.topLogged` | `GET /sites/{id}/rules/logged?range=…&limit=…` | 「记录」规则的命中 |
| `authRules.failures` | `GET /sites/{id}/auth-rules/failures?range=…` | 鉴权失败数 |

`range` 为 `1h`、`6h`、`24h`（默认）、`7d`、`30d`。字段见 [API 与端点](../reference/api/sites.md#自动缓解)。
