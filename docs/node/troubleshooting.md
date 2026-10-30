# 节点排障

节点运行中的连接、配置应用、证书、缓存与端口冲突问题，以及 OpenResty 与 agent 的启动问题。

安装与注册阶段的错误见 [添加节点](../deploy/nodes.md#排障)；L4 应用与 HTTPS 的问题另见 [L4 转发](../guide/l4.md#故障排查) 与 [HTTPS 与证书](../guide/https.md#故障排查)。

## 先检查

1. 在节点上执行 `sudo edgeweir-node diagnose`，看 `fail` 与 `warn` 的项目，检查项见 [本机检查命令](operations.md#本机检查命令)。
2. 查看最近的日志：`journalctl -u edgeweir-node -n 100`；OpenResty 的条目带 `component=nginx`。
3. 在控制台节点详情查看「状态」「已应用版本」「证书到期」「时钟偏差」与「日志」页签，见 [节点日志](../guide/node-logs.md)。
4. 需要更细的日志时从「日志」页签拉取 debug 日志，或在 `/etc/default/edgeweir-node` 设置 `EDGEWEIR_LOG_LEVEL=debug` 后重启服务。

控制台中节点的状态：

| 状态 | 含义 |
| --- | --- |
| 在线 | 45 秒内有心跳 |
| 离线 | 超过 45 秒没有心跳 |
| 已停用 | 在控制台停用 |
| 等待心跳 | 已注册，agent 还没有经 mTLS 连上节点通道 |
| 数据面异常 | 在线，但已应用过配置的数据面不健康（OpenResty 未运行或站点表推送失败） |

「已应用版本」列：

| 标记 | 含义 |
| --- | --- |
| 已同步 | 已应用集群当前（或金丝雀发布分给它的）配置版本 |
| 落后 | 已应用的版本低于目标版本 |
| 待应用配置 | 在线、已启用，还没有应用过任何配置 |
| 应用失败 | 最近一次应用失败，悬停显示原因；节点继续使用上一份配置 |
| 需要升级 | 节点缺少集群配置要求的能力，见 [节点能力](../guide/node-upgrades.md#节点能力) |

## 连接

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 一直显示「等待心跳」 | 服务未启动（如 `--no-start`），或连接节点通道失败 | `systemctl status edgeweir-node`，`journalctl -u edgeweir-node -n 50`；按下面各行处理连接错误 |
| 节点离线，日志有 `cannot reach`、`connection refused`、`i/o timeout` | 节点通道地址解析错误，防火墙或安全组未放行端口，控制台未运行 | 在节点上执行 `curl -k https://<地址>:8443/`，应返回 404；核对解析与放行规则 |
| `x509: certificate signed by unknown authority`，或 `diagnose` 的 `console` 项报证书错误 | 节点通道前有终结 TLS 的代理或 CDN（包括开启代理的 Cloudflare 记录），或地址指向其他服务 | 直连或 [四层透传](../deploy/networking.md#节点通道四层透传)；Cloudflare 记录改为仅 DNS |
| `x509: certificate is valid for ..., not ...` | 节点连接的名称不在节点通道证书中，例如注册后改过 `EDGEWEIR_NODE_API_URL` | 把该名称加入 `EDGEWEIR_NODE_API_HOSTNAMES` 并重启控制台，见 [节点通道地址与证书](../deploy/networking.md#节点通道地址与证书) |
| `the console rejected this node's credentials` | 节点在控制台已被删除、身份已被新的注册替换，或证书已过期 | 主机继续使用时 [重新注册](operations.md#重新注册)，否则 [卸载](operations.md#卸载) |
| 「证书到期」显示「证书已过期」 | 节点离线超过证书剩余有效期，未能续期 | [重新注册](operations.md#重新注册)，删除控制台中原来的节点 |
| 「证书到期」显示「证书被拒绝」 | 节点通道因其他原因拒绝证书，原因在悬停提示 | 确认节点未被删除、身份未被替换；需要时重新注册 |
| 修改节点通道地址后节点离线 | 1.2.0 以前的节点只使用注册时的地址；或旧地址在节点切换前下线 | 恢复旧地址，等节点切换（先升级 1.2.0 以前的节点）；已失联的 1.2.0 及以上节点执行 `sudo edgeweir-node set-server --server <新地址>`，见 [更换节点通道地址](operations.md#更换节点通道地址) |
| 节点标「无法切换」 | 节点检查新地址失败，原因在悬停提示与节点详情：无法连接新地址、该地址没有节点通道的 WebSocket 入口、该地址的证书不是本控制台签发的等 | 从节点所在网络确认新地址可达且为四层透传；修正后节点在下一次重试（至多 60 分钟）时切换，重启节点服务立即重试 |
| 节点标「用备用地址」 | 当前地址连续 3 分钟失败，节点临时改用备用地址，每 5 分钟重试主地址 | 恢复主地址的可达性 |
| 「时钟偏差」显示「偏差过大」，或收到「节点时钟偏差过大」告警 | 节点主机没有时间同步，与控制台相差达到告警规则的秒数（默认 30） | 开启 NTP（`sudo timedatectl set-ntp true`，或 chrony）；之后的心跳更新偏差，见 [告警](../guide/alerts.md) |

## 配置应用

一次应用依次获取凭据、挑战密钥、会话票据密钥与证书，生成 `nginx.conf`，执行 `openresty -t`，重载 OpenResty 并推送站点表。任何一步失败时节点继续使用上一份配置，记录 `configuration not applied; still serving the previous configuration`，控制台标「应用失败」，原因形如 `revision N not applied: …`。配置本身导致的失败（校验、`openresty -t`、表放不下）在出现新版本或 5 分钟后重试；网络或超时导致的失败在下一次同步时重试。

| 现象（「应用失败」的原因） | 原因 | 处理 |
| --- | --- | --- |
| `the site table does not fit the data plane's site store (--sites-dict-mb N)` | 站点表超出共享内存 | 调大 `--sites-dict-mb` 后重启服务，见 [共享内存与容量](configuration.md#共享内存与容量) |
| `the layer-4 table does not fit the data plane's store (--l4-dict-mb N)` | 四层应用表超出共享内存 | 调大 `--l4-dict-mb` 后重启服务 |
| `nginx configuration test failed: …` | `openresty -t` 不通过，原文为 nginx 的诊断 | 按诊断处理；常见为本机文件缺失或权限错误、`EDGEWEIR_*` 参数与配置冲突 |
| `nginx did not load the new configuration within 15s (still running …); see the nginx log` | 重载未生效，旧 worker 继续运行：通常是端口被占用 | 见 [端口冲突](#端口冲突) |
| `nginx did not come up with the new configuration within 15s` | OpenResty 未能启动 | 见 [OpenResty 无法启动](#openresty-无法启动) |
| `data plane rejected the site table` | 数据面拒绝了站点表 | 拉取 debug 日志，带 agent 与 OpenResty 的条目报告问题 |
| `cannot persist last-known-good configuration` | 状态目录无法写入（磁盘满、只读、权限） | 检查 `df -h /var/lib/edgeweir-node` 与目录属主（`edgeweir`） |
| `create cache dir: …` | 缓存目录无法创建 | 检查 `--cache-dir`（默认 `/var/cache/edgeweir-node`）的属主与磁盘空间 |
| 「需要升级」 | 集群配置用到了节点缺少的能力；节点继续使用最后一份成功应用的配置 | 升级节点，见 [节点升级](../guide/node-upgrades.md) |
| 「数据面异常」 | 站点表在推送期限内一直推送失败，或 OpenResty 未运行 | `sudo edgeweir-node diagnose`；`journalctl -u edgeweir-node -o cat \| grep component=nginx` |
| 「落后」且不变化 | 节点在线但未拉取新版本 | 查看节点日志中 `GetConfig failed` 的原因；重启节点服务立即重新同步 |

## 证书

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 节点详情显示「{count} 张证书未加载」，悬停列出证书 | 节点无法加载这些证书（材料缺失、私钥不匹配、不覆盖域名），已跳过；只用这些证书的网站或 L4 应用拒绝 TLS 握手，不会以其他证书应答 | 在 **证书** 页检查并替换这些证书，见 [HTTPS 与证书](../guide/https.md#节点上的证书) |
| 1.1.0 以前的节点「应用失败」，原因为证书 | 旧节点有一张证书无法加载时整个版本不应用 | 修正证书，或升级节点 |
| 节点证书「即将到期」 | 剩余不足 10 天，节点在线时自动续期 | 确认节点在线；离线到过期后需重新注册，见 [证书轮换](operations.md#证书轮换) |

## 缓存

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 响应没有 `X-Cache` 头 | 网站关闭了 X-Cache | 见 [X-Cache](../guide/origins-and-cache.md#x-cache) |
| 刷新后部分内容仍为旧版本 | 清缓存标记放不下，节点改为整站标记，日志有 `cannot install the purge markers; installed site-level markers for the affected sites instead` | 调大 `--purge-dict-mb` 后重启服务 |
| 节点详情「缓存」显示「尚未上报」 | 节点还没有测量缓存用量 | 等待下一次上报 |
| 磁盘用量超过预期 | 缓存容量由集群缓存区与节点缓存容量决定 | 在节点详情「缓存」设置「容量（GiB）」，或修改集群缓存区，见 [缓存区](../guide/origins-and-cache.md#缓存区) |

`sudo edgeweir-node accesslog --site <网站 ID>` 实时显示每个请求的缓存状态。

## 端口冲突

OpenResty 监听集群的 HTTP、HTTPS 监听端口与 L4 端口池中使用的端口。端口被其他进程占用时：

| 场景 | 现象 |
| --- | --- |
| 新增监听端口或 L4 应用后重载 | nginx 记录 `bind() to …:<端口> failed (98: Address already in use)` 并保留旧 worker；agent 15 秒内等不到新配置，本次应用失败，恢复上一份 `nginx.conf` |
| 服务启动 | OpenResty 退出，日志有 `bind() … failed` 与 `nginx exited unexpectedly, restarting`；agent 以 1 秒起、最多 30 秒的间隔重试 |
| 容器 | `docker run` 报 `port is already allocated`，或主机网络模式下同上 |

处理：

1. 找出占用端口的进程：`sudo ss -ltnup 'sport = :80'`（替换为报错中的端口；UDP 端口用 `-lunp`）。
2. 停止并禁用该服务，常见为发行版自带的 `nginx`、`apache2` / `httpd`、`caddy`、`openresty`（单元声明了 `Conflicts=openresty.service`）。
3. 端口必须保留给其他服务时，在集群修改监听端口或端口池，见 [集群的监听端口](../guide/https.md#集群的监听端口) 与 [设置端口池](../guide/l4.md#设置端口池)。
4. 重启节点服务，或等待下一次同步重新应用。

## OpenResty 无法启动

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `bind() … failed (98: Address already in use)` | 端口被占用 | 见 [端口冲突](#端口冲突) |
| `nginx exited unexpectedly` 反复出现 | OpenResty 崩溃或被终止（如内存不足被 OOM killer 结束） | `journalctl -k \| grep -i oom`；检查共享内存参数与主机内存，见 [资源与内核参数](configuration.md#资源与内核参数) |
| 服务以退出码 2 停止，systemd 不重启 | 参数或本机设置无效 | 按日志修正 `/etc/default/edgeweir-node` 或 drop-in，再 `sudo systemctl restart edgeweir-node` |
| `openresty.service` 启动后节点服务停止 | 两个单元互相冲突 | `sudo systemctl disable --now openresty` |
