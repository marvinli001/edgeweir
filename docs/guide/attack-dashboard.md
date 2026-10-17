# 攻击与自动缓解

网站的 **攻击** 页签汇总这个网站正在拦截什么、被谁攻击、命中了哪些规则，并可从任一行跳到按条件筛选的访问日志。**自动缓解** 在站点的 CC 级别升到阈值时自动开启该网站的 Under Attack，攻击停止后自动关闭。

## 概念

| 术语 | 定义 |
| --- | --- |
| 拦截原因 | 请求被拦截的原因，见[访问日志](access-logs.md#拦截原因)。 |
| CC 级别 | 节点上网站的挑战级别，从低到高为「正常」「Cookie 跳转」「JS 计算」「工作量证明」「图片验证码」，见[挑战与 CC 防护](challenges.md)。 |
| 触发级别 | 自动缓解开启 Under Attack 的 CC 级别，不含「正常」。 |
| 持续时间 | 级别最后一次达到触发级别之后保持 Under Attack 的分钟数（5–1440）。 |
| 保持 | 自动缓解已经开启 Under Attack 且尚未关闭。 |

## 攻击页签

页签顶部的时间范围（1 小时、6 小时、24 小时、7 天、30 天）对下面所有卡片生效：

| 卡片 | 内容 |
| --- | --- |
| 自动缓解 | 设置与当前状态，见[自动缓解](#自动缓解) |
| 拦截原因 | 各拦截原因的请求数随时间的堆叠图与列表；行右侧的「查看日志」打开访问日志，已筛选该原因与同一时间范围 |
| 节点当前级别 | 集群中每个活动节点上该网站的级别、在线状态与已升级的路径数（每 15 秒刷新） |
| Top IP、Top 路径 | 事件中请求最多的地址与路径（近似值）；点击地址或路径打开访问日志，已筛选该值与同一时间范围；行右侧的「⋯」可「封禁 IP」或「刷新 URL」 |
| 命中最多的 CRS 规则 | WAF 命中最多的 CRS 规则 ID，可「排除 CRS 规则」或「按路径排除」，见[WAF](waf.md) |
| 记录命中 | 只记录不拦截的规则的命中次数，见[规则](rules.md) |
| 挑战通过率 | 下发的挑战、通过后签发的通行凭证与两者之比 |
| 鉴权失败 | 外部鉴权的失败次数，见[访问控制](access-control.md) |
| 事件 | 级别变化、路径升降级与自动封禁的时间线，可按类型筛选 |

Top IP、Top 路径与事件只来自节点上报的安全事件，每个事件携带当时请求最多的地址与路径，所以结果是近似值；事件的保留天数见[挑战与 CC 防护](challenges.md#查看状态与事件)，超出保留期的范围没有数据。

从其他页面跳转时，访问日志的筛选条件与时间范围随链接带入：`/sites/<网站 ID>?tab=logs`（「日志」页签） 可加 `blockReason`、`ip`、`cidr`、`path`、`from`、`to`。切换页签清除它们。

## 自动缓解

在 **攻击** 页签的「自动缓解」卡片点击「设置」，填写：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| 启用 | 开 | 关闭后不再自动开启；正在保持时立即关闭 Under Attack |
| 触发级别 | 工作量证明 | 「Cookie 跳转」「JS 计算」「工作量证明」「图片验证码」 |
| 持续时间（分钟） | 30 | 5–1440 |

1. 集群中任一在线的活动节点上，该网站的 CC 级别达到触发级别。
2. 自动缓解开启该网站的 Under Attack（挑战类型沿用该网站「挑战类型」的设置），发布网站所在集群的配置版本。卡片显示「Under Attack 已开启，至 …」，网站的 Under Attack 卡片显示「自动开启，至 …」。
3. 级别保持在触发级别以上期间，到期时间不断推迟到「现在 + 持续时间」，不产生新的配置版本。
4. 级别低于触发级别并且到期后，自动关闭 Under Attack，发布配置版本。

> [!NOTE]
> 网站的 CC 防护必须开启，并且「最高级别」不低于触发级别，否则级别升不到触发级别；卡片在这两种情况下显示提示。节点上网站的所有请求都计入 QPS，所以 Under Attack 开启后级别仍保持在高位，攻击停止后才逐级回落，到期不会在攻击中途误关。

### 手动操作

自动缓解只关闭它自己开启的 Under Attack：

| 操作 | 结果 |
| --- | --- |
| 开启前 Under Attack 已由人开启 | 不处理，也不会关闭 |
| 保持期间手动开启 Under Attack | 视为手动开启，自动缓解不再关闭，状态清空 |
| 保持期间手动关闭 Under Attack | 保持结束，卡片显示「已手动结束」，级别降到触发级别以下之前不会再次开启 |
| 点击「立即结束」 | 关闭 Under Attack，同上暂停；没有保持时返回 409 `AUTO_MITIGATION_NOT_ACTIVE` |
| 修改设置 | 禁用时立即关闭；缩短持续时间时到期时间随之缩短；清除暂停 |
| 网站停用 | 不开启 |

「复制网站设置」既不复制自动缓解保持的 Under Attack，也不会在目标网站保持它时将其关闭；复制时把 Under Attack 打开则视为手动开启。

### 失败与重试

开启或关闭不能发布时（例如集群的活动节点缺少 `challenge-v1`），该次变更回滚，卡片显示「未能应用，每分钟重试」，错误码保存在 `lastError`，之后每分钟重试。

### 执行方式

后台任务 `mitigation.evaluate` 每分钟检查所有设置了自动缓解的网站；节点上报某个网站的级别升高后立即检查它，不必等下一个整分钟。到期时间保存在数据库，控制台重启后继续有效。

网站的级别取在线活动节点中最高的一个：节点最近一次心跳带来的级别，其后收到的级别变化事件（5 分钟内）优先。

## 权限与审计

修改需要控制台会话或读写 AccessKey；只读 AccessKey 只能读取；服务账号不能调用这些接口（`SERVICE_ACCOUNT_FORBIDDEN`）。审计：

| 动作 | 触发 |
| --- | --- |
| `site.auto_mitigation_update` | 修改设置 |
| `site.auto_mitigation_apply` | 自动开启 Under Attack（操作者为系统，元数据含 `level`、`threshold`、`durationMinutes`、`revision`） |
| `site.auto_mitigation_release` | 自动关闭 Under Attack（另含 `reason`：`expired` 或 `disabled`，以及 `since`） |
| `site.auto_mitigation_restore` | 「立即结束」 |

发布的配置版本原因为「自动缓解为 {site} 开启 / 关闭 Under Attack」（`auto_mitigation_started` / `auto_mitigation_ended`）。

## API

| 过程 | 端点 |
| --- | --- |
| `autoMitigation.get` | `GET /sites/{id}/auto-mitigation` |
| `autoMitigation.update` | `PUT /sites/{id}/auto-mitigation` |
| `autoMitigation.restore` | `POST /sites/{id}/auto-mitigation/restore` |
| `analytics.breakdown`（`by=block_reason`） | 按拦截原因的请求数 |
| `security.state`、`security.events` | 近 `hours`（最多 720）小时的节点级别、Top 与事件 |

字段见 [API 与端点](../reference/api.md#自动缓解)。
