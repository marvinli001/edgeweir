# 备份与恢复

数据库、主密钥与节点状态的备份、恢复与恢复验收。

## 备份对象

| 对象 | 位置 | 方式 | 约束 |
| --- | --- | --- | --- |
| PostgreSQL | 数据库 `edgeweir` | `pg_dump --format=custom` | 使用与服务器同主版本的 PostgreSQL 工具。 |
| `EDGEWEIR_MASTER_KEY` | `.env` | 离线副本，与数据库备份分开保存 | 缺失时库中加密的 CA 私钥、证书私钥、S3 源站密钥、DNS 与通知凭据不可解密。 |
| `BETTER_AUTH_SECRET` | `.env`（设置过时） | 与主密钥一起保存 | 未设置时会话密钥由主密钥派生。 |
| 部署配置 | `.env`、`compose.yml` | 文件副本 | — |
| ClickHouse | 卷 `clickhouse-data`（启用时） | 另行备份 | 与 PostgreSQL 来自同一恢复点，见 [ClickHouse](#clickhouse)。 |
| 节点状态 | 每个节点的 `/var/lib/edgeweir-node` | 节点本机备份 | 含节点私钥与 `config/receipts.json`；私钥不上传到控制台。 |
| 节点缓存 | 每个节点的 `/var/cache/edgeweir-node` | 不备份 | 可重建。 |

> [!WARNING]
> 备份文件含账户信息与日志，限制读取权限。数据库凭据经受限的 `.pgpass` 或环境变量提供，不写入命令行或 Git。

## 1. 制作备份

Docker Compose 内置数据库：

```bash
umask 077
docker compose exec -T postgres pg_dump -U edgeweir -d edgeweir --format=custom > edgeweir.dump
docker compose exec -T postgres pg_restore --list < edgeweir.dump > edgeweir.dump.list
```

外部 PostgreSQL：

```bash
umask 077
pg_dump --format=custom --file=edgeweir.dump --dbname=edgeweir
pg_restore --list edgeweir.dump > edgeweir.dump.list
```

验证：

```bash
grep -c 'TABLE DATA' edgeweir.dump.list
```

预期：大于 0。

`deploy.sh` 部署执行 `./deploy.sh backup`（`update` 前自动执行），写出同格式的 `edgeweir.dump` 以及 `.env`（不含主密钥与 `BETTER_AUTH_SECRET`）与编排文件，保留最近 5 份，见 [deploy.sh 参考](deploy-script.md#备份)。主密钥另行离线保存。

## 2. 恢复

先在隔离环境验证。恢复环境的要求：

| 项目 | 要求 |
| --- | --- |
| 主密钥 | 原 `EDGEWEIR_MASTER_KEY`。备份之后[轮换](docker.md#轮换主密钥)过主密钥时，用新主密钥并把原主密钥设为 `EDGEWEIR_MASTER_KEY_PREVIOUS`。 |
| `BETTER_AUTH_SECRET` | 设置过时使用原值；未设置时由主密钥派生。 |
| 节点通道地址 | 原 `EDGEWEIR_NODE_API_URL` 与 `EDGEWEIR_NODE_API_HOSTNAMES`：已注册节点按注册时的名称校验证书。**系统设置** 中保存的地址在数据库中，随备份恢复。 |
| 控制台版本 | 与备份相同或更新：迁移只向前执行。 |
| 后台任务 | 同一时间只允许一个恢复环境对真实 DNS 服务商与通知渠道执行后台任务；演练使用本地模拟服务。 |

### deploy.sh

`deploy.sh` 部署在部署目录执行：

```bash
./deploy.sh restore backups/20261001-080000
```

先备份当前数据库，停止控制台，删除并重建数据库，导入备份中的 `edgeweir.dump`，再启动并等待健康检查。`.env` 不变，其中须为上表的主密钥。前提与失败时的行为见 [deploy.sh 参考](deploy-script.md#restore)。

### Docker Compose

在新主机或新的 Compose 项目中执行：

1. 放置 `compose.yml`、原 `.env` 与 `edgeweir.dump`。
2. 启动空数据库：

   ```bash
   docker compose up -d --wait postgres
   ```

3. 导入：

   ```bash
   docker compose exec -T postgres pg_restore -U edgeweir -d edgeweir --exit-on-error < edgeweir.dump
   ```

4. 启动控制台：

   ```bash
   docker compose up -d
   ```

5. 验证：`curl -s http://127.0.0.1:3000/healthz` 返回 `"status":"ok"`。

### 外部 PostgreSQL

1. 恢复到新数据库：

   ```bash
   createdb edgeweir_restored
   pg_restore --exit-on-error --dbname=edgeweir_restored edgeweir.dump
   ```

2. 将控制台的 `DATABASE_URL` 指向 `edgeweir_restored`，按上表配置后启动。
3. 验证：`curl -s http://127.0.0.1:3000/healthz` 返回 `"status":"ok"`。

## 3. 节点重新同步

1. 数据库中的 CA 恢复后，已注册节点经 mTLS 重新连接。等待每个节点在恢复后上报新的心跳；恢复前的心跳不计入。
2. 发布一次配置（任一网站或集群配置变更）。

配置版本号规则：

| 规则 | 说明 |
| --- | --- |
| 新版本号 | max（数据库最新配置版本，本集群节点经回执验证的最大已应用版本）+ 1。 |
| 内容未变 | 节点版本领先时仍生成更高版本号；节点不会停留在最后可用配置。 |
| 回执 | 绑定节点、集群、版本号与内容哈希，由原主密钥认证；未经验证的版本号不参与计算。 |
| 示例 | 备份时版本 112 → 节点已应用 113 → 恢复后首次发布 114。 |

旧版节点在备份前升级并完成一次配置同步；节点状态备份保留 `config/receipts.json`。

## 4. 恢复验收

| 检查项 | 通过条件 |
| --- | --- |
| 控制台 | `/healthz` 返回 `"status":"ok"`。 |
| 节点 | **集群与节点** 中状态为「在线」。 |
| 配置 | 节点为「已同步」：已应用版本等于最新配置版本，内容哈希相同。 |
| 数据面 | 节点数据面健康；经节点的 HTTP 与 HTTPS 请求成功。 |

验收通过后保留旧数据库，按备份保留策略处理。

## ClickHouse

- ClickHouse 与 PostgreSQL 来自同一恢复点，或改用新的 ClickHouse 数据库（`EDGEWEIR_CLICKHOUSE_DATABASE`）开始写入。
- 恢复较旧的 PostgreSQL 游标而继续使用较新的 ClickHouse 表，可能与已有批次序号冲突。
- 跨存储恢复不自动完成；PostgreSQL 恢复成功不代表 ClickHouse 已恢复。

## 演练

```bash
node scripts/e2e-restore.mjs
```

| 项目 | 说明 |
| --- | --- |
| 范围 | 仅针对 `compose.e2e.yml` 的测试数据库。`pnpm e2e` 包含此演练；单独运行需要已启动的 e2e 环境与此前步骤生成的 `.e2e/m5-state.json`。 |
| 步骤 | 执行真实 `pg_dump`；节点应用高于备份的配置版本；新建数据库并执行 `pg_restore`；切换控制台连接；收到新心跳后发布相同内容；确认节点接受更高版本。随后切回原测试数据库并重新同步，保留恢复出的数据库供检查。 |
| 结果 | `.e2e/restore-result.json`。 |
| 约束 | 测试数据与凭据不得用于正式部署。 |
