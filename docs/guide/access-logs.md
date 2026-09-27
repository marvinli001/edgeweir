# 访问日志与 AccessKey

访问日志在网站的「日志」Tab 设置，默认关闭。采样率可选 1%、10%、100%；API 使用万分比整数（0–10000）。日志包括时间、客户端 IP、方法、Host、路径、状态码、发送字节、耗时、缓存状态及采样率。不会记录查询参数、请求头、Cookie 或正文；路径本身仍可能包含业务标识，应按需要启用。

可按时间、状态码、IP、路径前缀检索。界面最多显示 100 条，CSV 最多 1000 条；达到上限会明确提示，需要缩小时间范围。CSV 对引号、换行和电子表格公式前缀做转义。权限与当前网站归属一致，租户不能查询其他组织的网站。配置回滚保留当前采样策略，不会重新启用已关闭的日志收集。

默认 `EDGEWEIR_ANALYTICS=lite`：日志在 PostgreSQL 按 UTC 日期分区，保留今天及前 6 天；后台每分钟维护分区。删除节点保留网站的历史日志及流量，删除网站会清理其 PostgreSQL 日志。

可选 `EDGEWEIR_ANALYTICS=clickhouse`：执行 `docker compose --profile analytics up -d`，并配置 `EDGEWEIR_CLICKHOUSE_URL`、`EDGEWEIR_CLICKHOUSE_DATABASE`、`EDGEWEIR_CLICKHOUSE_USER`、`EDGEWEIR_CLICKHOUSE_PASSWORD`。ClickHouse 原始日志使用按天分区的 ReplacingMergeTree、7 天 TTL 和查询时的 FINAL 去重。切换模式只影响新的写入，不自动迁移历史日志；删除网站后原始 ClickHouse 数据按 TTL 清理，控制台立即停止授权查询。

分钟统计同步到 ClickHouse 的 `minute_stats` 表，用节点持久批次序号作为版本；直接分析时使用 `FINAL`。控制台图表和告警继续共用 PostgreSQL 的精确分钟/小时/天汇总，保留 7/90/365 天，避免两个后端采用不同的计数口径。采样日志不会用于冒充全量流量统计。

节点通过 mTLS 上报固定批次，控制台使用持久游标防止重试重复计数。ClickHouse 写入失败时不确认批次，也不偷偷改写入 PostgreSQL。内存队列最多约 2000 条，磁盘队列最多 10000 条、32 MiB、权限 0600；队列满时丢弃旧的未发送日志并记录警告。采样日志是有上限的诊断数据，不能当作零丢失的审计账本。请求结束到批次落盘之间，进程或机器崩溃也可能丢失日志。

「设置」中的 AccessKey 可创建为只读或读写，密钥只显示一次。创建新密钥必须使用已登录控制台的会话；读写及旧版 API key 同样不能签发新凭据。列表显示最后使用时间与吊销状态；吊销后再次请求返回 401，只读密钥调用写接口返回 403。旧版未设置范围的密钥保持原有业务读写权限，建议按用途吊销并重建。

单个节点/站点/时间桶的累计计数最多为 `Number.MAX_SAFE_INTEGER`（9,007,199,254,740,991）。超过范围时保持该上限，避免整数溢出阻塞汇总与保留任务；迁移会修整旧数据中的超范围计数。正常范围内的统计保持原有精确口径。

验证入口：`scripts/e2e-m6-logs.mjs`、`apps/console/e2e/m6-logs.spec.ts`、`apps/console/scripts/e2e-clickhouse.ts`。ClickHouse 的 HTTP 参数绑定与 FINAL 行为参考[官方 HTTP 文档](https://clickhouse.com/docs/interfaces/http)和[ReplacingMergeTree 文档](https://clickhouse.com/docs/engines/table-engines/mergetree-family/replacingmergetree)。
