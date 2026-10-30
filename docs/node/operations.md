# 节点运维

服务管理、本机检查命令、重新注册、证书轮换、更换节点通道地址、停用与删除、迁移与卸载。

控制台中的节点操作（详情、改名、移动到节点组、停用、删除）见 [集群与节点](../guide/clusters.md#节点)；升级见 [节点升级](../guide/node-upgrades.md)。

## 服务管理

| 操作 | systemd | 容器 |
| --- | --- | --- |
| 状态 | `systemctl status edgeweir-node` | `docker ps --filter name=edgeweir-node` |
| 启动 | `sudo systemctl start edgeweir-node` | `docker start edgeweir-node` |
| 停止 | `sudo systemctl stop edgeweir-node` | `docker stop edgeweir-node` |
| 重启 | `sudo systemctl restart edgeweir-node` | `docker restart edgeweir-node` |
| 开机启动 | `sudo systemctl enable edgeweir-node` / `disable` | `--restart unless-stopped` |
| 日志 | `journalctl -u edgeweir-node -f` | `docker logs -f edgeweir-node` |

| 项目 | 行为 |
| --- | --- |
| 重启 | 停止监督进程、agent 与 OpenResty 后重新启动：已有连接断开，共享内存（封禁、CC 状态、限速计数、未上报的统计计数）清空；统计计数在 agent 退出前写入 `traffic-spool.json` |
| 无 reload 命令 | 单元没有 `ExecReload`；配置由控制台下发并自动 reload，本机参数修改后重启服务 |
| 停止期间 | 节点不服务流量；控制台在 45 秒无心跳后标「离线」 |
| 启动 | 已注册时按 LKG 配置启动 OpenResty，随后连接控制台；控制台不可达时继续按 LKG 服务 |
| 退出码 2 | 参数或本机设置错误，systemd 不再重启；修正后 `sudo systemctl restart edgeweir-node` |
| `openresty.service` | 单元声明 `Conflicts=openresty.service`；不启用 OpenResty 官方包的服务 |
| 探针 | 单元 `edgeweir-probe.service`，命令同上 |

## 本机检查命令

`diagnose`、`bans`、`security`、`accesslog`、`healthcheck` 读取状态目录与 `/run/edgeweir-node/` 下的 socket，以 root 或服务用户执行（`sudo`，或 `sudo -u edgeweir`）。

| 命令 | 输出 | 退出码 |
| --- | --- | --- |
| `edgeweir-node healthcheck` | `healthy: revision N, M sites`，或 `unhealthy: <原因>` | 数据面有站点表时 0，否则 1 |
| `edgeweir-node diagnose [--json]` | 逐项检查，每行 `ok`、`warn`、`fail` 或 `skip`；`--json` 另含 agent 的完整状态 | 有 `fail` 时 1 |
| `edgeweir-node bans [--list]` | 数据面的封禁状态（JSON）；`--list` 另列出最多 1000 条封禁 | 失败时 1 |
| `edgeweir-node security` | 挑战密钥、验证码池、各网站 CC 级别与升级路径（JSON） | 失败时 1 |
| `edgeweir-node accesslog [--site ID] [--json]` | 实时请求，每行：时间（UTC，毫秒）、客户端 IP、方法、Host、路径、状态码、发送字节、耗时、缓存状态，有拦截原因时追加 `blocked=<原因>`；`--json` 为 JSON Lines；Ctrl-C 结束 | — |
| `edgeweir-node pprof PROFILE [--seconds N] [--output FILE]` | 运行中 agent 的 Go profile：`profile`（CPU，`--seconds` 默认 30，最多 120）、`trace`、`heap`、`allocs`、`goroutine`、`block`、`mutex`、`threadcreate`；用 `go tool pprof` / `go tool trace` 查看 | 失败时 1 |
| `edgeweir-node version` | 版本、commit、构建时间、Go 版本与平台 | 0 |

`diagnose` 的检查项：

| 项 | `ok` | `warn` / `fail` |
| --- | --- | --- |
| `identity` | 节点 ID、名称与集群 | `fail`：未注册（`identity.json` 不存在）或无法读取 |
| `certificate` | 有效期 | `warn`：已到续期时间（agent 连上控制台时自动续期）；`fail`：已过期，需 [重新注册](#重新注册) |
| `console` | 用节点身份向当前节点通道地址做一次 mTLS 调用，显示耗时 | `fail`：地址、原因码与错误 |
| `clock` | 与控制台的时钟偏差（以往返中点计算） | `warn`：偏差 1 秒及以上；`fail`：30 秒及以上，开启 NTP |
| `agent` | 诊断 socket 返回的版本、最近一次成功心跳距今多久 | `warn`：等待注册；`fail`：agent 未运行（或 `--diag-socket` 不同）、启动后从未连上控制台，或最近一次成功心跳早于 3 个心跳间隔，附最近的错误 |
| `configuration` | 已应用的配置版本 | `warn`：落后于控制台、有证书未加载；`fail`：最新版本应用失败及原因 |
| `data plane` | 配置版本与网站数 | `fail`：控制 socket 无响应或尚无站点表 |

`accesslog` 不受采样率限制，只在有人查看时采集（停止查看 5 秒后数据面不再记录），不带 `--site` 时也包括未知域名的请求；超出每节点每秒 2000 条或过期而缺失的请求在标准错误输出计数。查询串、请求头与对端地址不在这里显示。

## 重新注册

以新 token 替换节点身份：控制台中出现一个新节点，原节点需删除。

| 场景 | 说明 |
| --- | --- |
| 证书已过期 | 节点离线超过证书剩余有效期，未能续期；控制台标「证书已过期」 |
| 节点被删除 | 控制台删除节点时吊销其证书 |
| 换到其他集群 | 用目标集群的安装命令注册 |
| 内部 CA 改变 | 控制台以新的内部 CA 运行（例如以新的数据库初始化）；节点不支持 CA 轮换 |

安装命令（systemd 主机）：

1. 在 **集群与节点** 为目标集群点击 **添加节点**，复制 **安装命令**。
2. 在节点上执行该命令，末尾加 `--force`。`install.sh` 停止服务，以新 token 执行 `edgeweir-node enroll --force`，再启动服务并做健康检查。
3. 在控制台删除原来的节点。

手动：

```bash title="节点"
sudo systemctl stop edgeweir-node
sudo install -m 0600 /dev/stdin /root/edgeweir-token <<< '<一次性 token>'
sudo edgeweir-node enroll --force --server https://cdn-admin.example.com:8443 \
  --token-file /root/edgeweir-token --ca-sha256 <CA 指纹>
sudo rm /root/edgeweir-token
sudo systemctl start edgeweir-node
```

容器（运行中的节点持有运行锁，先停止容器）：

```bash title="节点"
docker stop edgeweir-node
read -rs EDGEWEIR_TOKEN && export EDGEWEIR_TOKEN
docker run --rm -e EDGEWEIR_TOKEN -v edgeweir-node:/var/lib/edgeweir-node \
  --entrypoint /usr/local/bin/edgeweir-node ghcr.io/marvinli001/edgeweir-node:<版本> \
  enroll --force --server https://cdn-admin.example.com:8443 --ca-sha256 <CA 指纹>
docker start edgeweir-node
```

| 项目 | 行为 |
| --- | --- |
| `--force` | 删除旧身份与旧 LKG 配置后写入新身份；节点运行时拒绝（运行锁 `run.lock`，最多等 30 秒） |
| 运行中的 agent | 每 10 秒比较 `identity.json`，身份改变时退出并以新身份重启 |
| 保留 | 缓存目录、`/etc/default/edgeweir-node` 不变 |

## 证书轮换

| 证书 | 有效期 | 轮换 |
| --- | --- | --- |
| 节点证书（`node.crt`） | 30 天 | 剩余不足三分之一（10 天）或控制台要求时，节点生成新私钥并调用 `RenewCertificate`；先写 `node.key.new` / `node.crt.new` 再原子替换，中断后启动时自动完成；审计 `node.certificate_renew`；节点日志事件「节点证书已续期」 |
| 内部 CA（`ca.crt`） | 10 年 | 不轮换；续期的节点证书须由注册时固定的 CA 签发 |
| 节点通道服务器证书 | 由控制台签发与续期 | 节点只信任内部 CA，服务器证书更换不影响节点，见 [节点通道地址与证书](../deploy/networking.md#节点通道地址与证书) |
| 健康证书（`health.crt`） | 10 年，节点自签名 | agent 启动时缺失、损坏或剩余不足 30 天则重新生成 |
| 网站证书 | 由控制台申请与续期 | 节点经 mTLS 获取，见 [HTTPS 与证书](../guide/https.md) |

| 控制台显示（节点详情「证书到期」） | 含义 | 处理 |
| --- | --- | --- |
| 日期 | 节点证书到期时间 | — |
| 即将到期 | 剩余不足 10 天；节点连上控制台时自动续期 | 确认节点在线 |
| 证书已过期 | 证书已过期，节点通道拒绝它 | [重新注册](#重新注册) |
| 证书被拒绝 | 节点通道因其他原因拒绝证书（悬停显示原因） | 检查节点是否已删除、身份是否被替换；需要时重新注册 |

停用的节点仍可续期，重新启用时证书有效。

## 更换节点通道地址

节点 1.2.0 起跟随控制台给出的节点通道地址：心跳应答带控制台当前的地址，节点先用固定的 CA 与自己的证书检查新地址，通过后改写 `identity.json`，原地址留作备用地址。检查失败时 1、5、15、60 分钟后重试；在用地址连续 3 分钟失败时临时改用备用地址，每 5 分钟试回。控制台中的状态（「未切换」「无法切换」「用备用地址」「需升级才能切换」）见 [更换节点通道地址](../deploy/networking.md#更换节点通道地址)。

旧地址已下线、节点失联时，在节点上执行：

```bash title="节点"
sudo edgeweir-node set-server --server https://new-admin.example.com:8443
```

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--server` | 必填 | 新地址：`https://<主机>[:端口]`，或 `wss://`、`ws://`，不带路径 |
| `--server-name` | `--server` 的主机名 | 校验的 TLS 服务器名 |
| `--probe` | 关 | 更换探针的地址（状态目录默认 `/var/lib/edgeweir-probe`） |
| `--state-dir` | `/var/lib/edgeweir-node` | 身份所在的状态目录 |
| `--timeout` | `30s` | 检查的超时 |

`set-server` 先用节点身份向新地址做一次 mTLS 调用，通过后原子改写 `identity.json`（原地址留作备用地址），身份与证书不变，运行中的 agent 几秒内改用新地址；检查失败时退出码 1，不改任何文件。

## 停用与删除

| 操作 | 节点上的行为 |
| --- | --- |
| 停用 | 节点通道拒绝其心跳与配置请求（证书续期除外）；节点不再进入 DNS 记录；节点进程继续按最后一次成功应用的配置服务直接到达的请求 |
| 删除 | 吊销节点证书，删除节点日志；节点继续按 LKG 服务，日志记录 `the console rejected this node's credentials`；不再使用的主机按 [卸载](#卸载) 处理，继续使用时 [重新注册](#重新注册) |

## 迁移到新主机

1. 在新主机按 [接入节点](../deploy/nodes.md) 安装并注册，加入同一节点组。
2. 确认新节点「在线」、**已应用版本** 为「已同步」。
3. 在控制台停用原节点：停用的节点不再进入 DNS 记录。等待 DNS 记录的 TTL 过去，确认原节点的流量降为零。
4. 删除原节点，卸载原主机。

不复制状态目录到新主机：新主机使用自己的身份。

## 卸载

1. 在控制台删除节点（吊销证书）。
2. 在节点上按安装形式执行：

| 安装形式 | 命令 |
| --- | --- |
| deb | `sudo apt-get purge edgeweir-node edgeweir-openresty-modsecurity edgeweir-openresty` |
| rpm | `sudo dnf remove edgeweir-node edgeweir-openresty-modsecurity edgeweir-openresty`，然后 `sudo rm -rf /var/lib/edgeweir-node /var/cache/edgeweir-node /var/lib/edgeweir-probe` |
| tar.gz | `sudo systemctl disable --now edgeweir-node`；`sudo rm -rf /usr/bin/edgeweir-node /usr/share/edgeweir-node /etc/systemd/system/edgeweir-node.service /var/lib/edgeweir-node /var/cache/edgeweir-node`；`sudo systemctl daemon-reload`；OpenResty 包按 deb 或 rpm 卸载 |
| 容器 | `docker rm -f edgeweir-node`，`docker volume rm edgeweir-node edgeweir-node-cache` |

| 项目 | 行为 |
| --- | --- |
| 停止服务 | deb、rpm 的卸载脚本停用并停止 `edgeweir-node.service` 与 `edgeweir-probe.service` |
| 状态与缓存 | deb `purge` 删除 `/var/lib/edgeweir-node`、`/var/cache/edgeweir-node`、`/var/lib/edgeweir-probe`；deb `remove` 与 rpm 卸载保留它们 |
| 用户 | `edgeweir` 用户与组保留：`sudo userdel edgeweir`；组仍存在时 `sudo groupdel edgeweir` |
| 内核封禁 | 启用过内核封禁时删除 nftables 表：`sudo nft delete table inet edgeweir`，并删除 `/etc/systemd/system/edgeweir-node.service.d/` |
| cosign | `install.sh` 安装的 `/usr/local/bin/cosign` 不随卸载删除 |
