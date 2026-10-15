# 节点日志

节点自己的警告、错误与关键事件：在控制台查看，不用登录节点主机。

## 内容

节点详情的「日志」页签列出节点最近的条目，最新的在前，每 10 秒刷新。每条显示时间、级别、来源、消息；点开可看结构化字段。

| 来源 | 收集的内容 |
| --- | --- |
| Agent | `edgeweir-node` 的警告与错误，例如配置应用失败、节点通道连接失败、证书无法加载 |
| 监督进程 | `edgeweir-node supervise` 的警告与错误，例如升级回滚 |
| OpenResty | OpenResty error log 中 warn 及以上的条目（crit、alert、emerg 记为错误，原级别在字段 `severity`），例如连接源站失败、上游超时 |
| Lua | 数据面 Lua 代码写的警告与错误，例如源站因连续失败（含域名解析失败）被标记为不可用 |

事件（级别为「事件」）只有以下几种：Agent 启动、配置已应用、使用上次可用的配置、OpenResty 启动、节点证书续期、节点通道地址切换、升级完成。其他 info 级别的日志不上传，仍在节点本地（`journalctl -u edgeweir-node`）。

OpenResty 的请求上下文在字段里：`client`（访客地址）、`server`、`request`（请求行）、`upstream`、`host`、`referrer`。访问日志另见[访问日志与 AccessKey](access-logs.md)。

## 筛选

| 筛选 | 说明 |
| --- | --- |
| 级别 | 全部级别、警告及以上、错误 |
| 来源 | Agent、监督进程、OpenResty、Lua |
| 时间 | 最近 1 小时、24 小时、7 天，或全部 |
| 搜索 | 消息包含的文字，不区分大小写 |

一页 100 条，「加载更多」继续向前翻。API：`GET /api/v1/nodes/{id}/logs`（参数 `minLevel`、`source`、`from`、`to`、`q`、`cursor`、`limit`，返回 `nextCursor`）。

## 脱敏

节点在保存条目前去掉以下内容，控制台入库时再检查一遍：

- URL 与请求行中的查询串（整段替换为 `[redacted]`，包括带签名的 URL）
- URL 中的用户名与密码
- PEM 块（证书、私钥）
- `Authorization`、`Proxy-Authorization`、`Cookie`、`Set-Cookie`、`X-Api-Key` 的值，以及 `Bearer` 令牌
- 名称含 token、secret、password、api key、access key、private key、auth key、signature、credential、session id 的字段与键值对的值
- 控制台签发的令牌与密钥（`ewt_`、`ewp_`、`ews_`、`ewk_`）和 JWT

单条消息最长 2048 字节，最多 16 个字段，字段值最长 512 字节；超出部分截断，条目标「已截断」。演示账号看到的访客地址截为 /24（IPv4）或 /48（IPv6）。

## 限速与丢弃

- 相同的条目（来源、级别与消息相同，数字和 ID 不计）每分钟保留 3 条，其余合并为一条「另有 N 条相同」；持续重复时合并窗口逐步延长到 1 小时。
- 每个节点每秒最多上传节点进程自己的 5 条与 OpenResty 的 10 条（允许短时突发）。
- 控制台不可达时，条目保存在节点的 `nodelogs-spool.json`（最多 5000 条），恢复后按顺序上传；Agent 重启、升级或崩溃时，监督进程保存的 OpenResty 条目不丢。
- 超出限速或缓冲区时丢弃的条数在日志中显示为一行「节点丢弃了 N 条」。

## 保留期

**系统设置** 的「节点日志保留期」：保留天数 1–30（默认 7），每个节点最多 1,000–100,000 条（默认 10,000）。控制台启动时与之后每 10 分钟删除超出的条目。删除节点时一并删除它的日志。

## 节点版本

需要上报 `node-logs-v1` 的节点版本；更早的节点显示「节点版本过低」，升级见[节点升级](node-upgrades.md)。节点远程升级后，旧的监督进程仍在运行时只上传 Agent 的条目，并记一条「重启节点服务后才能收到 OpenResty 日志」；重启节点服务（`systemctl restart edgeweir-node`）后恢复。不由监督进程运行 OpenResty 的节点（`edgeweir-node run` 不带 `--manage-nginx`）只有 Agent 的条目。
