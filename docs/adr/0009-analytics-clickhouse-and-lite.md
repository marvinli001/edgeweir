# ADR-0009: 分析与日志：ClickHouse 可选，lite 模式存 Postgres

- 状态：已接受
- 日期：2026-09-25
- 适用仓库：两者

## 背景

CDN 需要统计（请求数、流量、带宽、命中率、状态码、Top URL 和 IP）和访问日志。日志量随流量线性增长，中等规模的集群每天就可能产生上亿条。

参考系统的做法：

- CDNFly 用 Elasticsearch，需要 8 到 16 GB 内存。
- GoEdge 把访问日志按天写入 MySQL 表，量大之后要手工分库。

小规模用户（几台节点）不应该为了统计多部署一个重型组件；大规模用户又需要原始日志和灵活的聚合查询。

## 决策

1. **两种模式：**

   | 模式 | 存储 | 内容 | 启用方式 |
   | --- | --- | --- | --- |
   | lite（默认） | PostgreSQL | 节点预聚合的分钟级统计 | 默认启用 |
   | analytics | ClickHouse | 分钟级统计，加上可采样的原始访问日志 | `docker compose --profile analytics` |

2. **节点侧先预聚合再上报。** 每个节点按（分钟，站点）汇总请求数、发送和接收字节、缓存命中与未命中次数、状态码分布，通过 `ReportStats` 批量上报（[`MinuteStats`](../../proto/edgeweir/node/v1/node.proto)）。控制面不接收逐条请求的统计。
3. **lite 模式**：分钟级数据写入 PostgreSQL，由 pg-boss 定时任务汇总成小时和天粒度，并按保留期清理分钟明细。
4. **analytics 模式**：
   - 原始日志写入 ClickHouse 的 MergeTree 表：按天分区，按站点和时间排序，用 TTL 控制保留期。
   - 分钟和小时级聚合由物化视图写入聚合表（SummingMergeTree 或 AggregatingMergeTree），查询统计时读聚合表。
5. **原始日志支持采样**：采样率可以按站点配置；每条日志携带自己的采样率，聚合时按 1/采样率 加权还原。
6. **高基数指标（Top URL、Top IP）**：lite 模式下由节点每分钟上报 Top-K 结果（需要在 `MinuteStats` 中新增字段，属于向后兼容的变更）；analytics 模式下直接从原始日志计算。

## 备选方案与取舍

- **Elasticsearch 或 OpenSearch**：内存占用高（CDNFly 需要 8 到 16 GB），JVM 调优和分片管理的运维负担重；做日志聚合分析时，存储效率不如列式数据库。
- **按天写 MySQL 表（GoEdge）**：表的数量随时间增长，跨天聚合查询慢，分库要手工操作。
- **原始日志也写 PostgreSQL**：在原始日志的量级下，写入和聚合成本过高。TimescaleDB 需要扩展，官方 `postgres` 镜像不带，会把用户绑定到特定的 PostgreSQL 发行版。
- **Prometheus 或 InfluxDB**：URL、IP 这类高基数维度不适合时序数据库；ATC 的 InfluxDB 正是它运维负担的来源之一。
- **Loki**：擅长日志检索，不擅长聚合分析。

## 后果

### 正面

- 小规模部署不需要任何额外组件。
- 大规模部署时，ClickHouse 以较低的资源处理原始日志。
- 节点预聚合大幅减少上报流量和控制面负载。

### 负面

- 两条存储路径，统计查询层要适配两种后端。
- lite 模式没有原始日志，无法按单条请求排查问题。
- 采样后的原始日志只能给出估计值。
- ClickHouse 的运维（备份、升级、磁盘）由用户负责，compose profile 只提供默认配置。

## Phase 0 落地情况

Phase 0 范围：

- proto 中的 `ReportStats` 与 `MinuteStats` 契约。
- `compose.yml` 的 `analytics` profile（ClickHouse 容器）。

后续：

- MVP：lite 模式的分钟统计入库、汇总、清理与图表；Top URL 和 Top IP；ClickHouse 表结构。
- v1：原始日志写入 ClickHouse；Logpush（S3、HTTP、Kafka）。

## 版本核实

核实日期：2026-09-25。来源：Docker Hub、npm registry。

| 组件 | 版本 | 来源 |
| --- | --- | --- |
| ClickHouse | 26.9，镜像 `clickhouse/clickhouse-server:26.9-alpine` | Docker Hub |
| PostgreSQL | 18.6，镜像 `postgres:18.6-alpine` | Docker Hub |
| pg-boss | 12.34.0 | npm registry |

> 更新记录：
> - 2026-09-25（数据展示重做）：lite 模式的查询与图表先落地。`analytics.traffic` 按范围（1h、6h、24h、7d、30d）选桶宽（1 分钟到 6 小时），用 `date_bin` 在 PostgreSQL 里按 Unix 纪元对齐分桶，状态码按首位数字汇总成 2xx–5xx；服务端补齐没有数据的桶，并一次查出紧挨着的上一等长时段，用于涨跌比较。Top 网站、Top 节点按请求数排序。小时 / 天汇总表与分钟明细的保留期清理（决策 3）尚未实现，目前所有范围都直接读分钟明细。


## 2026-09-27 M5 更新

M5 已完成永久批次游标与 ReportStatsV2、私有磁盘重试队列、UTC 小时/天增量汇总和 7/90/365 天保留。脏桶队列与入库同事务，明细在汇总完成后清理。Top URL/IP 为有界近似计数，长范围查询用不重叠的小时/分钟视图。ClickHouse 的可选访问日志存储与 M6 一并接入。

实现、边界与本地证据见 [DNS 与告警指南](../../docs/guide/dns-and-alerts.md)。

> - 2026-09-27（MVP M6）：采样日志提前纳入 MVP，lite 使用 PostgreSQL UTC 日分区，保留今天及前 6 天。ClickHouse 模式写原始日志和绝对值分钟快照，ReplacingMergeTree 配合 FINAL 避免 ACK 丢失后重复；写失败不确认节点游标。图表与告警继续使用同一 PostgreSQL 精确汇总，未采用原始 ADR 中基于采样日志推算全量流量或异步物化视图累加的方案，以免低采样率、重复写入改变计数口径。采样率默认 0，队列有上限，日志不包含查询参数、请求头或正文。两种存储切换不自动迁移历史数据；跨后端备份需匹配恢复点。见日志指南与备份指南。

> - 2026-09-27（最终审查）：计数写入与汇总以 `Number.MAX_SAFE_INTEGER` 为上限，使用 numeric 中间运算后饱和，匹配公共 API 的 number 类型；状态码和 Top 计数同样处理。`0022_bound_traffic_counters` 修整既有超范围值。流量汇总、日志维护与升级到期任务分别执行，一个任务失败不阻塞其他维护。正常数值范围内仍是精确汇总。
