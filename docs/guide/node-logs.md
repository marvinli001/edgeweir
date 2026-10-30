# 节点日志

节点本地日志（journal）、控制台节点详情的「日志」页签（警告、错误与事件），以及按需拉取的 debug 日志。

## 本地日志

节点不写日志文件：agent、监督进程与 OpenResty 的日志都写到标准错误，systemd 下进入 journal，容器中为容器日志。

| 来源 | 内容 | 查看 |
| --- | --- | --- |
| agent、监督进程 | `--log-level`（默认 `info`）及以上，格式 `--log-format`（`text` 或 `json`） | `journalctl -u edgeweir-node` |
| OpenResty error log | `notice` 及以上，逐行转入节点日志，字段 `component=nginx` | 同上 |
| 访问日志 | 节点不写访问日志文件；采样访问日志上传到控制台，见[访问日志](access-logs.md) | 实时查看：`sudo edgeweir-node accesslog` |
| 探针 | 同 agent | `journalctl -u edgeweir-probe` |

```bash title="节点"
journalctl -u edgeweir-node -f
journalctl -u edgeweir-node --since "1 hour ago" | grep -E 'level=(WARN|ERROR)'
journalctl -u edgeweir-node -o cat | grep 'component=nginx'
docker logs -f edgeweir-node
```

更细的日志：在 `/etc/default/edgeweir-node` 设置 `EDGEWEIR_LOG_LEVEL=debug` 后重启服务，排查后改回；或不重启而从控制台[拉取 debug 日志](#debug-日志)。参数见 [节点配置](../node/configuration.md#日志)。

## 「日志」页签

节点详情的「日志」页签列出节点上传的条目，最新的在前，每 10 秒刷新。每条显示时间、级别、来源、消息；点开可看结构化字段。

| 来源 | 收集的内容 |
| --- | --- |
| Agent | `edgeweir-node` 的警告与错误，例如配置应用失败、节点通道连接失败、证书无法加载 |
| 监督进程 | `edgeweir-node supervise` 的警告与错误，例如升级回滚 |
| OpenResty | OpenResty error log 中 warn 及以上的条目（crit、alert、emerg 记为错误，原级别在字段 `severity`），例如连接源站失败、上游超时 |
| Lua | 数据面 Lua 代码写的警告与错误，例如源站因连续失败（含域名解析失败）被标记为不可用 |

级别为「事件」的条目只有：「Agent 已启动」「配置已应用」「使用上次可用的配置」「OpenResty 已启动」「节点证书已续期」「节点通道地址已切换」「升级已完成」「重启节点服务后才能收到 OpenResty 日志」。其他 info 级别的日志不上传，只在本地 journal。

OpenResty 的请求上下文在字段里：`client`（访客地址）、`server`、`request`（请求行）、`upstream`、`host`、`referrer`。

### 筛选

| 筛选 | 说明 |
| --- | --- |
| 级别 | 全部级别、警告及以上、错误 |
| 来源 | Agent、监督进程、OpenResty、Lua |
| 时间 | 最近 1 小时、24 小时、7 天，或全部时间 |
| 搜索 | 消息包含的文字，不区分大小写 |

一页 100 条，「加载更多」继续向前翻。API：`GET /api/v1/nodes/{id}/logs`（参数 `minLevel`、`source`、`from`、`to`、`q`、`cursor`、`limit`，返回 `nextCursor`）。

### 脱敏

节点在保存条目前去掉以下内容，控制台入库时再检查一遍：

- URL 与请求行中的查询串（整段替换为 `[redacted]`，包括带签名的 URL）
- URL 中的用户名与密码
- PEM 块（证书、私钥）
- `Authorization`、`Proxy-Authorization`、`Cookie`、`Set-Cookie`、`X-Api-Key` 的值，以及 `Bearer` 令牌
- 名称含 token、secret、password、api key、access key、private key、auth key、signature、credential、session id 的字段与键值对的值
- 控制台签发的令牌与密钥（`ewt_`、`ewp_`、`ews_`、`ewk_`）和 JWT

单条消息最长 2048 字节，最多 16 个字段，字段名最长 64 字节，字段值最长 512 字节；超出部分截断，条目标「已截断」。演示账号看到的访客地址截为 /24（IPv4）或 /48（IPv6）。

### 限速与丢弃

| 项目 | 行为 |
| --- | --- |
| 合并 | 相同的条目（来源、级别与消息相同，数字和 ID 不计）每个窗口保留 3 条，其余合并为一条「另有 N 条相同」；窗口为 1 分钟，持续重复时依次延长到 5 分钟、15 分钟、1 小时 |
| 限速 | 每个节点每秒上传节点进程自己的 5 条（突发 50）与 OpenResty 的 10 条（突发 100） |
| 暂存 | 控制台不可达时，条目保存在状态目录的 `nodelogs-spool.json`（最多 5000 条、4 MiB），恢复后按顺序上传；agent 重启、升级或崩溃时，监督进程保存的 OpenResty 条目不丢 |
| 丢弃 | 超出限速或暂存上限的条数显示为一行「节点丢弃了 N 条（超出限速 … 条，缓冲区已满 … 条）」 |

## Debug 日志

「日志」页签只有警告、错误与事件。在同一页签点「拉取 debug 日志」取得节点内存中的全部级别日志：

| 项目 | 行为 |
| --- | --- |
| 缓冲区 | 节点在内存中保留最近的日志：Agent 与监督进程的 debug 及以上，OpenResty error log 的全部级别；默认 5000 条、最多 4 MiB，满时丢弃最旧的；不写磁盘，平时不上传 |
| 拉取条件 | 时间（缓冲区全部、最近 15 分钟、最近 1 小时）、来源与组件（如 `channel`、`tasks`，逗号分隔，最多 16 个，只含小写字母、数字、`_`、`.`、`-`） |
| 上传 | 节点收到后把匹配的条目一次上传，最多 10,000 条、4 MiB，超出时只保留最新的部分并标「只含最新部分」 |
| 失败 | 「节点未在 2 分钟内上传」「节点关闭了 debug 缓冲区」「节点版本过低」（未上报 `debug-logs-v1`）「上传失败」；同一节点同时只能有一次未完成的拉取 |
| 查看 | 完成的拉取可以「查看」（按级别、消息筛选）或「下载」为 JSON Lines 文件 |
| 保留 | 每个节点保留最近 10 次，与节点日志保留期相同的天数后删除 |
| 权限 | 条目与「日志」页签同样脱敏；演示账号可以查看与下载，不能拉取；每次拉取记入审计日志 |
| 节点参数 | `--debug-log-buffer` 设置条数（`0` 关闭，最多 100,000） |
| 旧监督进程 | 远程升级后监督进程仍是旧版本时，结果标「缺少监督进程与 OpenResty 的条目」，重启节点服务后恢复 |

API：`POST /api/v1/nodes/{id}/debug-logs`（`from`、`to`、`components`、`sources`）、`GET /api/v1/nodes/{id}/debug-logs`、`GET /api/v1/nodes/{id}/debug-logs/{pullId}`。

## 保留期

**系统设置** 的「节点日志保留期」：保留天数 1–30（默认 7），每个节点最多 1,000–100,000 条（默认 10,000）。控制台启动时与之后每 10 分钟删除超出的条目。删除节点时一并删除它的日志。

## 节点版本

| 情况 | 行为 |
| --- | --- |
| 节点未上报 `node-logs-v1` | 页签显示「节点版本过低」，升级见[节点升级](node-upgrades.md) |
| 远程升级后旧监督进程仍在运行 | 只上传 Agent 的条目，并记一条「重启节点服务后才能收到 OpenResty 日志」；执行 `sudo systemctl restart edgeweir-node` 后恢复 |
| `edgeweir-node run` 不带 `--manage-nginx` | 只有 Agent 的条目 |
