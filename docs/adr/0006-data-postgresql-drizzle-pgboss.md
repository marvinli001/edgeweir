# ADR-0006: 数据层：PostgreSQL 18 + Drizzle + pg-boss

- 状态：已接受
- 日期：2026-09-25
- 适用仓库：edgeweir

## 背景

控制面需要：

- 关系型存储：配置、租户、节点、审计。
- 任务队列和定时任务：证书签发与续期、DNS 同步、统计汇总、过期数据清理。
- 多实例广播：一个实例发布了新配置，连接在其他实例上的节点也要尽快收到通知。

自托管用户希望依赖越少越好，每多一个有状态组件，就多一份部署、备份和监控工作。

## 决策

1. **PostgreSQL 18 是唯一必需的外部依赖。**
2. **Drizzle ORM** 在 `packages/db` 中定义 schema。迁移由 `drizzle-kit generate` 生成纯 SQL 文件，随代码提交，并在代码评审中阅读。better-auth 需要的表纳入同一套 schema 和迁移。
3. **迁移在容器启动时自动执行**，在开始监听端口和消费任务之前完成：
   - 执行前获取 PostgreSQL advisory lock。多个实例同时启动时只有一个执行迁移，其余等待，拿到锁后发现已是最新版本直接继续。
   - 迁移只向前。要撤销一个迁移，就写一个新迁移。
   - 生产环境不使用 `drizzle-kit push`。
4. **多实例配置广播用 LISTEN/NOTIFY，频道 `edgeweir_config`：**
   - 配置发布事务内执行 `NOTIFY edgeweir_config`，payload 只带定位信息（例如集群 id 和 revision），不带配置内容。NOTIFY 的 payload 上限是 8000 字节。
   - 每个 `app` 实例保持一条专用连接执行 `LISTEN edgeweir_config`（不从连接池借用），收到通知后推送给本实例上的 WatchConfig 流（[ADR-0008](0008-node-channel-connect-rpc-mtls.md)）。
   - NOTIFY 在事务提交时才发出，节点不会收到尚未提交的 revision。
   - NOTIFY 不持久。LISTEN 连接断开并重连后，实例重新查询各集群的最新 revision，补上断开期间漏掉的通知。节点侧还有轮询兜底（[ADR-0014](0014-node-agent-responsibilities.md)）。
5. **pg-boss 12 做任务队列和定时任务**，数据存在同一个 PostgreSQL 的独立 schema 中。业务写入和入队可以在同一个事务里完成。`ROLE=worker` 或 `ROLE=all` 的实例消费任务，`ROLE=app` 只入队（[ADR-0001](0001-monolithic-console-and-toolchain.md)）。
6. **Valkey 是可选组件**，通过 `docker compose --profile cache` 启用。启用后可作为会话与限流计数的二级存储（例如 better-auth 的 `secondaryStorage`）和热点数据缓存。所有功能在没有 Valkey 时必须可用，缺少缓存只影响性能。

## 备选方案与取舍

- **强依赖 Redis（例如 BullMQ）**：多一个有状态组件要部署、备份和监控；任务和业务数据不在同一个事务里，会出现"数据写入了但任务丢了"或者反过来的情况。
- **可选缓存用 Redis 而不是 Valkey**：Redis 在 2024 年改为 RSALv2/SSPL 双许可，2025 年的 Redis 8 又加入了 AGPLv3 选项；Valkey 是 Linux 基金会托管的 BSD 许可分支，协议兼容。用户也可以把连接地址指向自己已有的 Redis。
- **MySQL（GoEdge 所用）**：没有 LISTEN/NOTIFY，pg-boss 也只支持 PostgreSQL。
- **SQLite**：无法支撑多实例部署。
- **Prisma**：需要代码生成步骤，查询层抽象更厚。Drizzle 的 schema 是普通 TypeScript，查询贴近 SQL，迁移是可读的 SQL。
- **Kysely**：只有查询构建器，没有 schema 定义和迁移生成。
- **NATS、Kafka 等消息总线广播配置变更**：在我们的规模下没有必要，LISTEN/NOTIFY 足够。

## 后果

### 正面

- 必需依赖只有 PostgreSQL，备份一个数据库就覆盖了配置、任务和审计数据。
- 入队与业务写入是同一个事务。
- 迁移是可评审的 SQL，数据库变更有据可查。

### 负面

- LISTEN 需要到 PostgreSQL 的直连。PgBouncer 事务池模式下 LISTEN 不可用；使用连接池中间件时，要为 LISTEN 单独提供直连地址或使用 session 模式。
- pg-boss 的轮询和任务表会给数据库带来额外负载，任务量大时需要调整保留期和清理策略。
- 升级镜像即升级数据库 schema，回退镜像版本不会回退 schema。升级前应先备份数据库。

## Phase 0 落地情况

Phase 0 范围：

- 数据模型 v0：organization、user 等 better-auth 表，以及 cluster、node_group、node、node_ip、enrollment_token、site、site_domain、origin_pool、origin、cache_rule、config_revision、node_config_status、audit_log。
- 容器启动时自动执行迁移。
- LISTEN/NOTIFY 频道 `edgeweir_config`。
- 接入 pg-boss，并按 `ROLE` 决定是否启动 worker。
- `compose.yml` 中的 `cache` profile（Valkey 容器）。

后续：

- 具体的后台任务：证书签发与续期、DNS 同步、统计汇总、数据清理。
- Valkey 的实际用途接入。
- 升级前的备份提示或自动备份。

## 版本核实

核实日期：2026-09-25。来源：Docker Hub、npm registry。

| 组件 | 版本 | 来源 |
| --- | --- | --- |
| PostgreSQL | 18.6，镜像 `postgres:18.6-alpine` | Docker Hub |
| drizzle-orm | 0.45.3 | npm registry |
| drizzle-kit | 0.31.11 | npm registry |
| pg | 8.23.0 | npm registry |
| pg-boss | 12.34.0 | npm registry |
| Valkey | 9.2，镜像 `valkey/valkey:9.2-alpine` | Docker Hub |

> 更新记录：
> - 2026-09-25：Drizzle 采用 npm `latest` 0.45.3（1.0 仍为 beta）。迁移由 `drizzle-orm/node-postgres/migrator` 在启动时执行，外加 advisory lock 保证多实例安全。单元/集成测试用 PGlite（进程内 PostgreSQL）跑同一套 SQL 迁移，`pnpm test` 不依赖 Docker。pg-boss 12 使用命名导出 `PgBoss`，schema 为 `pgboss`。
