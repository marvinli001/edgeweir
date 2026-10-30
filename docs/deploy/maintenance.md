# 维护

密钥轮换、数据库容量与保留期、后台任务、健康检查、日志、监控、证书轮换、磁盘占用与找回账户。

## 例行检查

| 检查项 | 命令或位置 | 正常 |
| --- | --- | --- |
| 控制台 | `curl -s http://127.0.0.1:3000/healthz`；`docker compose ps` | `"status":"ok"`；`console` 为 `healthy` |
| 错误日志 | `docker compose logs --since 24h console \| grep -E '"level":"(warn\|error)"'` | 无持续出现的同一错误 |
| 待处理 | **概览** 的「待处理」 | 不显示（没有事项），见 [待处理](../guide/clusters.md#待处理) |
| 节点 | **集群与节点** | 节点「在线」、「已同步」，无「数据面异常」「证书已过期」「需要升级」 |
| 证书 | **证书** | 无「签发失败」 |
| 告警 | **告警** | 告警渠道最近一次投递成功，见 [告警](../guide/alerts.md) |
| 备份 | 备份目录或平台的备份页 | 最近一份备份的时间与大小正常，见 [备份与恢复](backup.md) |
| 数据库与磁盘 | 见 [数据库](#数据库) 与 [磁盘与资源](#磁盘与资源) | 增长与保留期相符 |
| 版本 | [GitHub Releases](https://github.com/marvinli001/edgeweir/releases) | 运行版本没有落后于含安全修复的 `stable` |

## 主密钥轮换

更换 `EDGEWEIR_MASTER_KEY`（例如怀疑泄露）。数据库中的加密数据在启动时改用新主密钥重新加密。

1. 备份数据库与 `.env`，见 [备份与恢复](backup.md)。
2. `.env` 中把原值移到 `EDGEWEIR_MASTER_KEY_PREVIOUS`，`EDGEWEIR_MASTER_KEY` 设为新值：

   ```bash
   openssl rand -base64 32
   ```

   使用文件时对应 `EDGEWEIR_MASTER_KEY_PREVIOUS_FILE` 与 `EDGEWEIR_MASTER_KEY_FILE`。
3. 重建控制台：`docker compose up -d`（`deploy.sh` 部署为 `./deploy.sh restart`）。
4. 查看结果：

   ```bash
   docker compose logs console | grep -E 'master key rotation|EDGEWEIR_MASTER_KEY_PREVIOUS'
   ```

   | 日志 | 含义 | 操作 |
   | --- | --- | --- |
   | `no envelope uses EDGEWEIR_MASTER_KEY_PREVIOUS any more: remove it and restart the console` | 全部密文已改用新主密钥 | 执行第 5 步 |
   | `envelopes still use EDGEWEIR_MASTER_KEY_PREVIOUS: keep it set` | 仍有密文使用旧主密钥 | 保留旧主密钥，按 `cannot re-seal an envelope of the previous master key` 日志排查后重启 |
   | `envelopes sealed with neither master key cannot be opened` | 有密文既不是新主密钥也不是旧主密钥加密的 | 核对 `EDGEWEIR_MASTER_KEY_PREVIOUS` 是否为轮换前的主密钥 |

5. 删除 `EDGEWEIR_MASTER_KEY_PREVIOUS`，再次重建控制台。
6. 离线保存新主密钥；旧主密钥保留到轮换前的备份全部过期。

| 项目 | 说明 |
| --- | --- |
| 校验 | `EDGEWEIR_MASTER_KEY_PREVIOUS` 与 `EDGEWEIR_MASTER_KEY` 相同时拒绝启动；两者都须为 32 字节以上的 base64 |
| 会话与两步验证 | 不受影响：未设置 `BETTER_AUTH_SECRET` 时，由旧主密钥派生的会话密钥用新主密钥加密后保存在数据库中，删除 `EDGEWEIR_MASTER_KEY_PREVIOUS` 后仍然使用 |
| 节点 | 无需操作；节点保存的配置回执在下一次拉取配置时由新主密钥重新签发 |
| 多个控制台实例 | 全部实例用同一组变量重建 |
| 轮换前的备份 | 仍由旧主密钥加密：恢复时把旧主密钥设为 `EDGEWEIR_MASTER_KEY_PREVIOUS` |
| `deploy.sh` 备份 | 不含 `EDGEWEIR_MASTER_KEY_PREVIOUS` |

## 会话密钥

`BETTER_AUTH_SECRET` 签名会话 cookie，并加密 TOTP 密钥与备用码。

| 情况 | 结果 |
| --- | --- |
| 未设置 | 由主密钥派生；日志 `session secret` 的 `source` 为 `master_key`，主密钥轮换后为 `stored` |
| 设置为新值 | 启动时警告 `BETTER_AUTH_SECRET changed`：全部会话失效，已启用的两步验证无法验证；在服务器上停用两步验证后重新启用，见 [找回账户](#找回账户) |
| 已有部署删除该变量 | 拒绝启动：`BETTER_AUTH_SECRET is not set, but this database was used with another secret`；恢复原值 |
| 主密钥泄露 | 轮换主密钥，同时设置新的 `BETTER_AUTH_SECRET`（`openssl rand -base64 32`，至少 32 字符） |

## 数据库

### 容量

```bash
docker compose exec -T postgres psql -U edgeweir -d edgeweir -c \
  "select pg_size_pretty(pg_database_size('edgeweir'))"
docker compose exec -T postgres psql -U edgeweir -d edgeweir -c \
  "select schemaname, relname, pg_size_pretty(pg_total_relation_size(relid)) from pg_statio_user_tables order by pg_total_relation_size(relid) desc limit 15"
```

| 增长来源 | 控制方式 |
| --- | --- |
| 访问日志（`EDGEWEIR_ANALYTICS=lite`） | 保留天数、网站的采样率；量大时改用 ClickHouse，见 [访问日志](../guide/access-logs.md) |
| 节点日志 | 保留天数与每个节点最多条数，见 [节点日志的保留期](../guide/node-logs.md#保留期) |
| 统计、用量、安全事件 | 下表的保留期 |
| 审计日志 | 不自动删除 |

PostgreSQL 的 autovacuum 回收清理任务删除的行；分区表按分区删除。

### 数据保留

清理由 worker 执行（`ROLE` 为 `all` 或 `worker`）；没有 worker 时数据不会被删除。

| 数据 | 保留 | 设置 |
| --- | --- | --- |
| 访问日志 | 默认 7 天；PostgreSQL 1–30 天，ClickHouse 1–90 天 | **系统设置** 的「访问日志」，见 [访问日志](../guide/system.md#访问日志) |
| 节点日志 | 默认 7 天（1–30），每个节点最多 10000 条（1000–100000） | **系统设置** 的「节点日志保留期」，见 [节点日志保留期](../guide/system.md#节点日志保留期) |
| 安全事件 | 默认 30 天（7–365） | **防护设置** 的「安全事件保留天数」，见 [防护设置](../guide/system.md#防护) |
| 用量 | 默认 100 天（35–400） | **系统设置** 的「用量」，见 [用量](../guide/system.md#用量) |
| 流量统计 | 分钟粒度 7 天，小时粒度 90 天，天粒度 365 天 | 固定 |
| 配置版本 | 每个集群最近 200 个；最新版本与配置金丝雀的稳定、候选版本始终保留 | 固定 |
| DNS 版本 | 每个集群最近 200 个；期望、已应用与被阻止的版本始终保留 | 固定 |
| 刷新预热任务 | 创建 90 天后 | 固定 |
| 已过期的封禁 | 到期 1 小时后 | 固定 |
| 节点注册 token | 过期或使用 7 天后 | 固定 |
| API 幂等键 | 24 小时 | 固定 |
| 已过期的回源客户端证书 | 过期 7 天后 | 固定 |
| 审计日志 | 不删除 | — |

### 后台任务

worker 使用 pg-boss，任务表在数据库的 `pgboss` schema 中。cron 时间为 UTC。

| 队列 | 计划 | 作用 |
| --- | --- | --- |
| `alerts.sweep` | 每分钟 | 告警检查与投递 |
| `mitigation.evaluate` | 每分钟 | 自动缓解的开启与结束 |
| `rollouts.evaluate` | 每分钟 | 配置金丝雀的推进 |
| `dns.reconcile` | 每分钟 | DNS 记录同步；移除已过 24 小时的被替换 CNAME 前缀 |
| `traffic.rollup` | 每分钟 | 统计汇总与清理、用量与用量保护、访问日志分区与保留、节点升级任务过期 |
| `certificates.sweep` | 每分钟 | 证书申请与续期 |
| `maintenance.recompile` | 每次启动 | 升级后重新编译配置 |
| `maintenance.check-certificates` | 每次启动 | 标记节点无法加载的已上传证书 |
| `maintenance.link-acme-accounts` | 每次启动 | 关联 ACME 证书与账户 |
| `maintenance.prune-bans` | 每 10 分钟 | 删除过期封禁 |
| `maintenance.prune-node-logs` | 每次启动与每 10 分钟 | 删除超出保留期与条数的节点日志、过期的 Debug 日志 |
| `maintenance.expire-enrollment-tokens` | 每 30 分钟 | 删除过期的注册 token |
| `maintenance.rotate-challenge-keys` | 每小时第 11 分 | 轮换满 1 天的挑战密钥 |
| `maintenance.rotate-session-ticket-keys` | 每小时第 13 分 | 轮换满 12 小时的 TLS 会话票据密钥 |
| `maintenance.prune-revisions` | 每小时第 17 分 | 清理配置版本与 DNS 版本 |
| `maintenance.rotate-origin-client-certificates` | 每小时第 19 分 | 到期前 30 天替换回源客户端证书 |
| `maintenance.prune-idempotency-keys` | 每小时第 29 分 | 删除过期的幂等键 |
| `maintenance.prune-security-events` | 每小时第 37 分 | 删除超出保留期的安全事件 |
| `maintenance.expire-cache-tasks` | 每小时第 43 分 | 过期未送达的刷新预热任务，删除旧任务 |

智能调度（探针可达性与调度规则）由进程内定时器每 10 秒求值一次，多个控制台进程经租约同一时间只有一个求值。

任务状态：

```bash
docker compose exec -T postgres psql -U edgeweir -d edgeweir -c \
  "select name, state, count(*) from pgboss.job group by 1, 2 order by 1, 2"
```

`failed` 计数增长时按队列名在控制台日志中查找错误。不要手动删除 `pgboss` schema 中的表。

## 健康检查

| 检查 | 行为 |
| --- | --- |
| `GET /healthz` | 返回 `{"status":"ok","version":"<版本>"}`；只表示 HTTP 服务在运行，不检查数据库与 worker；不需要登录 |
| 容器 `HEALTHCHECK` | `edgeweir-healthcheck`：间隔 10 秒，超时 3 秒，启动期 30 秒，重试 5 次；`ROLE=worker` 时直接成功，其他角色请求 `http://127.0.0.1:${PORT}/healthz`，超时 2 秒 |
| 平台健康检查 | 路径填 `/healthz` |
| 数据库 | `/healthz` 不覆盖；数据库连接中断时日志 `database connection lost` |
| 节点 | 节点心跳间隔 15 秒，45 秒内有心跳为「在线」 |

## 日志

| 项目 | 说明 |
| --- | --- |
| 格式 | 每行一个 JSON 对象：`time`、`level`、`msg` 与字段；`info`、`debug` 写到标准输出，`warn`、`error` 写到标准错误 |
| 级别 | `LOG_LEVEL`：`debug`、`info`（默认）、`warn`、`error` |
| 查看 | `docker compose logs -f console`；`deploy.sh` 部署为 `./deploy.sh logs console` |
| 轮转 | 由容器运行时负责：Docker 的 `json-file` 驱动默认不限制大小，在 `/etc/docker/daemon.json` 设置 `log-opts`（如 `"max-size": "50m"`、`"max-file": "5"`） |
| 节点日志 | 节点上报的日志在控制台查看，见 [节点日志](../guide/node-logs.md) |

## 监控

| 对象 | 方式 |
| --- | --- |
| 节点离线、证书、DNS | 告警规则与告警渠道，见 [告警](../guide/alerts.md) |
| 外部可达性 | 区域探针从各区域探测节点，见 [区域探针与智能调度](../guide/scheduling.md#区域探针) |
| 控制台本身 | 外部监控请求 `https://<控制台>/healthz`；告警由控制台发出，控制台停止时不会发出告警 |
| 审计 | 管理操作写入 [审计日志](../guide/system.md#审计日志) |

## 证书与密钥的自动轮换

| 对象 | 有效期 | 轮换 |
| --- | --- | --- |
| 网站证书（ACME） | CA 决定 | `certificates.sweep` 按 [续期](../guide/https.md#续期) 规则续期；失败时状态为「签发失败」并按间隔重试 |
| 上传的证书 | 证书决定 | 不自动续期；到期前上传新证书 |
| 节点通道服务器证书 | 90 天 | 控制台每小时检查，剩余不足 30 天或名称变化时重新签发，日志 `node channel certificate rotated` |
| 节点客户端证书 | 30 天 | 节点自动续期；剩余不足 10 天时节点详情标「即将到期」 |
| 回源客户端证书 | — | 到期前 30 天替换 |
| 挑战密钥 | 1 天 | 每小时检查 |
| TLS 会话票据密钥 | 12 小时 | 每小时检查 |
| 节点通道 CA | — | 不轮换 |
| Origin CA、回源客户端 CA | — | 不自动轮换；手动轮换见 [轮换 CA](../guide/https.md#轮换-ca) |

## 磁盘与资源

| 对象 | 检查 | 处理 |
| --- | --- | --- |
| Docker 总占用 | `docker system df` | 删除不再使用的旧版本镜像：`docker image rm ghcr.io/marvinli001/edgeweir:<旧 tag>`；保留当前与上一个版本以便回退 |
| PostgreSQL 卷 | `docker system df -v \| grep postgres-data` | 见 [数据库](#数据库) |
| ClickHouse 卷 | `docker system df -v \| grep clickhouse-data` | 缩短访问日志保留期 |
| 备份目录 | `du -sh backups` | `deploy.sh` 按 `EDGEWEIR_BACKUP_KEEP` 保留；cron 备份按 [定期备份](backup.md#定期备份) 清理 |
| 内存与 CPU | `docker stats --no-stream` | 运行要求见 [部署概览](README.md#运行要求)；分离 Web 与 worker 见 [进程角色](README.md#进程角色) |

> [!WARNING]
> `docker compose down -v`、`docker volume prune` 删除 `postgres-data` 等卷，即全部数据。

## 找回账户

无法登录时（忘记密码、两步验证设备丢失、登录 IP 白名单不含当前地址），在运行控制台的服务器上执行：

```bash
docker compose exec console node dist/server/recover.js --reset-password --disable-two-factor
```

选项 `--reset-password`、`--disable-two-factor`、`--clear-login-allowlist` 可组合。步骤见 [找回账户](../guide/account.md#找回账户)，选项、输出与退出码见 [命令行](../reference/cli.md#找回账户)。
