# 故障排查

控制台的启动、登录、节点通道、后台任务、DNS 与证书、性能问题的现象、原因与处理。

先收集：

```bash
curl -s http://127.0.0.1:3000/healthz
docker compose ps
docker compose logs --tail 200 console | grep -E '"level":"(warn|error)"'
```

`deploy.sh` 部署用 `./deploy.sh status` 与 `./deploy.sh logs console`。日志格式见 [日志](maintenance.md#日志)。

## 启动失败

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `invalid configuration: <变量>: <原因>`，进程退出 | 环境变量缺失或格式错误；每个问题一行 | 按列出的变量修正，全部变量见 [环境变量](../reference/environment.md) |
| `EDGEWEIR_MASTER_KEY: is not valid base64` 或 `must be at least 32 bytes` | 主密钥被截断或改写：值带引号或空格，面板把 `+` 换成了空格 | 使用 `openssl rand -base64 32` 的原样输出 |
| `EDGEWEIR_MASTER_KEY_PREVIOUS: is the same key as EDGEWEIR_MASTER_KEY` | 轮换时两个变量设成了同一个值 | `EDGEWEIR_MASTER_KEY_PREVIOUS` 设为轮换前的主密钥，见 [主密钥轮换](maintenance.md#主密钥轮换) |
| `<变量>_FILE: set either <变量> or <变量>_FILE, not both` | 同时设置了变量与对应的文件变量 | 只保留一个 |
| `<变量>_FILE: cannot read <文件>` 或 `<文件> is empty` | 文件未挂载、权限不足（镜像以 uid 1000 运行）或为空 | 检查挂载与 `chown 1000` |
| `EDGEWEIR_PUBLIC_URL: expected http:// or https://host[:port] without a path` | 地址带路径、查询串，或平台变量未展开（如 `https://${DOMAIN}`） | 改为 `https://主机[:端口]` |
| `EDGEWEIR_NODE_API_URL: expected https://, wss:// or ws://host[:port] without a path` | 同上；或旧版 Zeabur 模板的端口转发变量未展开 | 修正地址；Zeabur 见 [从旧模板部署迁移](zeabur.md#从旧模板部署迁移) |
| 重复输出 `database not reachable yet`，60 秒后退出 | 数据库未启动、地址或凭据错误、网络不通 | `docker compose ps postgres`；外部数据库检查 `DATABASE_URL` 与防火墙 |
| `database not reachable yet` 带 `hint`：`node-postgres verifies the server certificate for sslmode=require too` | `sslmode=require` 时 node-postgres 也校验服务器证书 | `DATABASE_URL` 加 `sslrootcert=<CA 文件>`；或用 `uselibpqcompat=true&sslmode=require`（不校验证书）或 `sslmode=no-verify` |
| 迁移报 `permission denied` | `DATABASE_URL` 的用户在数据库或 `public` schema 上没有 `CREATE` 权限 | 让该用户成为数据库所有者，或授予 `CREATE`；迁移失败时事务回滚，修正后重启即可 |
| 启动停在迁移，日志没有 `database migrated` | 另一个控制台实例正在迁移，或残留会话持有迁移锁 | 等待其他实例；`select pid from pg_locks where locktype = 'advisory' and objid = 727274` 找到持锁会话，确认无用后 `select pg_terminate_backend(<pid>)` |
| `EDGEWEIR_MASTER_KEY does not match this database` | 主密钥不是该数据库所用的：更换了主密钥，或数据库来自另一次安装 | 恢复原主密钥；需要更换时按 [主密钥轮换](maintenance.md#主密钥轮换) 把原主密钥设为 `EDGEWEIR_MASTER_KEY_PREVIOUS`。设置 `BETTER_AUTH_SECRET` 无济于事 |
| `BETTER_AUTH_SECRET is not set, but this database was used with another secret` | 已有部署删除了 `BETTER_AUTH_SECRET` | 恢复原值 |
| `the stored session secret cannot be opened with the configured master key` | 主密钥轮换后保存的会话密钥无法用当前主密钥解开：主密钥被换成了第三个值 | 恢复轮换后的主密钥 |
| 旧版本启动后请求报错，日志出现字段或表不存在 | 旧镜像运行在已被新版本迁移的数据库上 | 按 [降级](downgrade.md#按备份回退) 用备份恢复，或换回新版本 |
| `console` 为 `unhealthy`，进程在运行 | `/healthz` 无响应：启动尚未完成（等待数据库、迁移） | `docker compose logs console` 查看停在哪一步，见 [启动时的步骤](upgrade.md#启动时的步骤) |
| `shutdown timed out`，退出码 1 | 停止时 8 秒内未关闭完进行中的请求、节点连接与 pg-boss | 进程在容器运行时默认 10 秒的强制结束之前退出；平台的停止宽限期不要低于 10 秒 |

## 登录与会话

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 打开控制台跳转到 `/setup`，没有 setup token | 尚未初始化；setup token 每次启动输出在日志中 | `docker compose logs console \| grep setupToken`；`deploy.sh` 部署为 `./deploy.sh setup-token` |
| 登录失败或提示来源不受信任 | `EDGEWEIR_PUBLIC_URL` 与浏览器地址栏的协议、主机名或端口不一致 | 修正 `EDGEWEIR_PUBLIC_URL`，重建容器 |
| 登录成功后又回到登录页 | `EDGEWEIR_PUBLIC_URL` 为 `https://` 时会话 cookie 带 `Secure`，经 `http://` 访问时浏览器不保存 | 经 HTTPS 访问；反向代理见 [反向代理 Web 控制台](networking.md#反向代理-web-控制台) |
| 「请求过于频繁，请稍后重试」 | 登录限速；计数保存在数据库中，各实例共享，重启不清零 | 10 秒后重试 |
| 限速对所有人同时生效，审计日志 IP 都是同一地址 | 控制台前有反向代理，`EDGEWEIR_TRUSTED_PROXIES` 未设置，所有请求按代理地址计数 | 设置 `EDGEWEIR_TRUSTED_PROXIES`，见 [可信代理与客户端 IP](networking.md#可信代理与客户端-ip) |
| 「此 IP 不在登录白名单内」 | 当前地址不在登录 IP 白名单内 | 换到名单内的网络；或在服务器上执行 `recover.js --clear-login-allowlist`，见 [找回账户](maintenance.md#找回账户) |
| 忘记密码、两步验证设备与备用码丢失 | — | [找回账户](maintenance.md#找回账户) |
| 更换 `BETTER_AUTH_SECRET` 后全部退出登录，两步验证失败 | TOTP 密钥与备用码用原来的 secret 加密 | 改回原值；原值已丢失时在服务器上停用两步验证后重新启用 |
| 通行密钥无法登录 | 控制台主机名已更换，通行密钥绑定原主机名 | 用密码登录，删除旧通行密钥后重新添加 |

其他登录界面的提示见 [账户与登录的故障排查](../guide/account.md#故障排查)。

## 节点通道

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 启动日志 `the node channel URL names this machine only` 或 `is a private address` | 节点通道地址是 `localhost` 或内网地址：其他网络的节点无法注册与连接 | 在 **系统设置** 的「节点通道」保存公网地址，或设置 `EDGEWEIR_NODE_API_URL` |
| 启动日志 `EDGEWEIR_PUBLIC_URL is plain HTTP` | 控制台经 HTTP 提供 `install.sh`，节点以 root 执行未加密传输的脚本 | 经 HTTPS 提供控制台 |
| 连接检查「证书不符，前面可能有代理或 CDN」；节点报 `CA pin mismatch` | 8443 前面的代理、CDN 终结了 TLS；节点通道必须由控制台自己终结 TLS（mTLS） | 直连或 [四层透传](networking.md#节点通道四层透传)；Cloudflare 记录改为仅 DNS |
| 连接检查「控制台无法连接该地址」 | 地址解析错误、端口未发布或未放行 | 核对 `EDGEWEIR_NODE_API_PORT` 的发布与防火墙；在节点上执行 `curl -k https://<地址>:8443/` 应返回 404 |
| `install.sh`：`answers 404: the console's WebSocket entry is closed` | 节点通道地址为 `wss://`、`ws://`，控制台未开放 WebSocket 入口 | 在 **系统设置** 保存该地址，或设置 `EDGEWEIR_NODE_API_WEBSOCKET=true`，见 [WebSocket 入口](networking.md#节点通道的-websocket-入口) |
| `install.sh`：`cannot reach the node channel WebSocket entry` | 反向代理未转发 `/node-channel` 的 WebSocket 升级，或证书不受节点信任 | 按 [WebSocket 入口](networking.md#节点通道的-websocket-入口) 配置反向代理 |
| 节点 `x509: certificate is valid for ..., not ...` | 节点连接的名称不在节点通道服务器证书中 | 把该名称加入 `EDGEWEIR_NODE_API_HOSTNAMES` 后重启控制台，见 [节点通道地址与证书](networking.md#节点通道地址与证书) |
| 节点标「证书已过期」 | 节点离线超过证书剩余有效期（30 天证书），未能续期 | 在节点上以 `--force` 执行新的安装命令重新注册，删除控制台中原来的节点 |
| 平台部署后节点周期性断开重连 | 平台替换实例（部署、重启、维护）时关闭连接 | 节点自动重连，断开期间按最后可用配置服务；见各平台文档的「限制」 |
| 节点详情「连接来源地址」不是节点的公网地址 | 平台的 TCP 代理或 HTTP 入口不传递节点地址 | 预期行为，见各平台文档的「限制」 |

注册与节点侧的错误见 [接入节点的排障](nodes.md#排障) 与 [节点故障排查](../node/troubleshooting.md)。

## 后台任务

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 证书不续期、DNS 不同步、没有告警、旧数据不删除 | 没有运行 worker：全部实例都是 `ROLE=app` | 至少一个实例为 `ROLE=all` 或 `ROLE=worker`；日志应有 `worker started` |
| 日志 `pg-boss error` | worker 与数据库的连接或查询失败 | 检查数据库可用性与连接数上限；pg-boss 自动重连 |
| 某个队列的 `failed` 任务持续增加 | 该任务每次执行都出错 | 按 [后台任务](maintenance.md#后台任务) 的查询找到队列，在日志中查找该队列对应模块的错误 |
| 升级后部分集群没有新配置，日志 `recompile after upgrade failed` | 该集群的配置发布失败，保留原版本 | 按日志中的 `clusterId` 与错误修正，下一次修改该集群的配置时发布 |
| 金丝雀不推进、节点升级任务过期 | worker 未运行，或节点不满足健康观察条件 | 确认 worker；节点升级见 [节点升级的故障排查](../guide/node-upgrades.md#故障排查) |
| 主密钥轮换后一直 `envelopes still use EDGEWEIR_MASTER_KEY_PREVIOUS` | 有密文无法重新加密 | 按 `cannot re-seal an envelope of the previous master key` 日志的表与记录排查，见 [主密钥轮换](maintenance.md#主密钥轮换) |

## DNS 与证书

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 证书状态「签发失败」 | 卡片上的原因：域名验证、CAA、频率限制、EAB 等 | 见 [HTTPS 的故障排查](../guide/https.md#故障排查) |
| 连接自建 ACME 目录、DNS 端点、Webhook 失败，提示出站策略 | 目标解析到内网或保留地址，出站策略默认拒绝 | 在 `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` 放行该地址段 |
| 自定义 ACME 目录证书不受信任 | 私有 CA 签发的 ACME 目录 | 在 **系统设置** 的证书颁发机构中保存 CA 证书，或设置 `EDGEWEIR_ACME_CA_FILE` |
| 从源码运行时证书无法签发 | 未构建证书助手 `edgeweir-certd` | 构建并设置 `EDGEWEIR_CERTD_BIN`，见 [命令行](../reference/cli.md#本地运行) |
| DNS 记录未更新、被阻止或摘除 | 服务商凭据、配额，或触发大面积摘除保护 | 见 [DNS 调度的故障排查](../guide/dns.md#故障排查) |
| 告警未送达 | 渠道配置、SMTP 端口被平台封禁、发送频率上限 | 见 [告警的故障排查](../guide/alerts.md#故障排查) |

## 性能与资源

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 数据库持续增长 | 访问日志采样率高或保留期长；节点日志条数上限高；审计日志不自动删除 | 按 [数据保留](maintenance.md#数据保留) 调整；访问日志量大时改用 ClickHouse |
| 统计与日志页面查询慢 | PostgreSQL 中的访问日志量大 | 缩短保留期、降低采样率，或改用 ClickHouse，见 [访问日志](../guide/access-logs.md#使用-clickhouse-存储) |
| API 返回 429「AccessKey 请求过于频繁，请 N 秒后重试」 | 超过该 AccessKey 的请求限制；按进程计数 | 按 `retryAfterSeconds` 重试，降低并发 |
| 「此集群最多发布 512 个网站」 | 集群内已启用的网站达到上限 | 停用不用的网站，或在其他集群新建网站 |
| 容器内存持续接近上限，被 OOM 结束 | 实例规格不足 | `docker stats --no-stream` 确认；按 [运行要求](README.md#运行要求) 调整，或按 [进程角色](README.md#进程角色) 拆分 Web 与 worker |
| 磁盘占满 | 旧镜像、未限制大小的容器日志、备份 | 见 [磁盘与资源](maintenance.md#磁盘与资源) |
