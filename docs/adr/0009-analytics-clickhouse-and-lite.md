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
