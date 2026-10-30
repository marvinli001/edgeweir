# 节点概览

边缘节点的组件、进程、与控制台的通信、配置生效方式、端口、文件布局与版本规则。

节点由 Go agent `edgeweir-node` 与 OpenResty 数据面组成，经 mTLS 从控制台接收配置并服务访客流量。安装与注册见 [接入节点](../deploy/nodes.md)，参数见 [节点配置](configuration.md)。

## 组件

| 组件 | 交付 | 职责 |
| --- | --- | --- |
| agent | `edgeweir-node`（静态二进制）：软件包 `/usr/bin/edgeweir-node`，镜像 `/usr/local/bin/edgeweir-node` | 注册、mTLS 通道、配置校验与应用、任务（清缓存、预热、升级、debug 日志）、心跳与统计上报、封禁同步、主动健康检查、OCSP |
| 监督进程 | 同一二进制的 `supervise --manage-nginx` 模式；systemd 单元与镜像的入口 | 运行 agent 与 OpenResty，签名升级、试运行与回滚，见 [节点升级](../guide/node-upgrades.md) |
| OpenResty | 软件包 `edgeweir-openresty` 1.31.1.1-3：`/usr/lib/edgeweir-openresty/`（含 HTTP/2、HTTP/3、Brotli、Zstandard） | 数据面：路由、缓存、回源、规则、WAF、挑战、四层转发（stream） |
| Lua 模块 | `/usr/share/edgeweir-node/lua/edgeweir/` | 数据面逻辑；经本机 unix socket 接收 agent 推送的站点表 |
| ModSecurity 与 OWASP CRS | 软件包 `edgeweir-openresty-modsecurity`（可选）：模块 `/usr/lib/edgeweir-openresty/modules/`，CRS 4.29.0 `/usr/share/edgeweir-openresty/crs/` | 只在有网站启用 [OWASP CRS](../guide/waf.md) 时加载 |
| cosign | 主机已有的 `cosign`，或 `install.sh` 安装的 v3.1.3（`/usr/local/bin/cosign`）；镜像内置 | 签名升级时校验 `checksums.txt` |
| 图片转换 | `edgeweir-node` 的内部子进程 | WebP / AVIF 转换，见 [图片格式转换](../guide/image-convert.md) |
| 区域探针 | `edgeweir-node probe`，单元 `edgeweir-probe.service` | 探测各节点的调度地址；不运行 OpenResty，见 [区域探针](../deploy/nodes.md#区域探针) |

网站证书由控制台申请与续期，节点经 mTLS 获取证书材料；ACME HTTP-01 验证由节点在 80 端口应答。

## 进程

```text
systemd: edgeweir-node.service（用户 edgeweir）
└─ edgeweir-node supervise --manage-nginx        监督进程
   ├─ edgeweir-node run --manage-nginx …          agent（基础安装或自升级版本）
   │  └─ edgeweir-node imgconv                    图片转换，每次转换一个
   └─ nginx master（edgeweir-openresty）
      └─ nginx worker × worker_processes
```

| 项目 | 行为 |
| --- | --- |
| OpenResty 归属 | 由监督进程运行；agent 经监督进程测试配置与 reload。agent 重启或升级不重启 OpenResty，共享内存（封禁、CC 状态、限速计数、统计计数）保留 |
| agent 重启 | 意外退出时监督进程重启它，间隔 2 秒起翻倍至 1 分钟；退出码 2（参数或本机设置错误）时监督进程以退出码 2 退出，systemd 不再重启（`RestartPreventExitStatus=2`） |
| 停止 | SIGTERM 发给监督进程，agent 先停止，OpenResty 随后优雅退出；`TimeoutStopSec=30s` 后剩余进程被杀死 |
| 无配置时 | 尚未注册或没有可用配置时，数据面在 `--default-port`（默认 80）监听，所有域名返回 `404`（`X-Edgeweir-Error: unknown-host`） |
| `run` 模式 | `edgeweir-node run --manage-nginx` 不经监督进程，agent 自己运行 OpenResty；不支持签名升级，不上报 `self-upgrade-v1` |

## 与控制台的通信

节点只主动连接控制台的节点通道，控制台不连接节点。

| 项目 | 行为 |
| --- | --- |
| 地址 | 注册时的 `--server`：节点通道端口（默认 `https://<控制台>:8443`），或控制台 Web 端口上的 WebSocket 入口（`wss://`、`ws://`，节点 0.2.0 起），见 [端口、反向代理与可信代理](../deploy/networking.md) |
| 协议 | Connect RPC（protobuf），HTTP/2；`HTTPS_PROXY`、`HTTP_PROXY`、`NO_PROXY` 生效 |
| 注册 | 一次性 token（`ewt_` 前缀）；TLS 证书链须含 `--ca-sha256` 固定的内部 CA，校验通过后才发送 token；私钥（ECDSA P-256）在节点生成，不离开节点 |
| 注册之后 | 每个 RPC 使用 mTLS：客户端证书为节点证书，只信任内部 CA |
| 配置下发 | `WatchConfig` 流推送新版本；另每 30 秒（±20%）`GetConfig` 轮询一次 |
| 心跳 | `ReportStatus` 每 15 秒一次（应用配置后立即一次）；45 秒内有心跳为「在线」 |
| 统计与日志 | 统计每 60 秒上报；采样访问日志每 10 秒；节点日志每秒取出，见 [节点日志](../guide/node-logs.md) |
| 节点证书 | 有效期 30 天；剩余不足三分之一（10 天）或控制台要求时，以新生成的私钥自动续期 |
| 控制台不可达 | 按最后一次成功应用的配置（last-known-good，LKG）继续服务；统计、访问日志、节点日志暂存在状态目录 |
| 地址跟随 | 节点 1.2.0 起跟随控制台给出的节点通道地址，见 [更换节点通道地址](../deploy/networking.md#更换节点通道地址) |

## 配置生效

| 步骤 | 行为 |
| --- | --- |
| 校验 | 内容哈希、集群、能力与各字段的取值范围；整份配置不合法时拒绝，继续服务 LKG，同一版本 5 分钟内不重试 |
| 单项错误 | 非法的域名、源站、监听等被跳过并记为告警，其余部分照常应用 |
| 结构性变更 | 监听、缓存区、站点集合、HTTPS 网站的域名、协议与压缩设置、OWASP CRS、四层应用的端口与协议：重新渲染 `nginx.conf`，`openresty -t` 通过后 reload，已有连接由旧 worker 服务到结束（时限见 [旧 worker 的关闭时间](configuration.md#旧-worker-的关闭时间)） |
| 其余变更 | 经本机控制 socket 热更新站点表，不 reload |
| 持久化 | 应用成功后写入 `config/current.binpb`，原版本留作 `config/previous.binpb` |
| 能力 | 配置要求节点没有的能力时整份拒绝，控制台标「需要升级」，见 [节点能力](../guide/node-upgrades.md#节点能力) |

## 端口

入站（主机防火墙与云安全组放行，条件见 [端口与防火墙](../deploy/nodes.md#端口与防火墙)）：

| 端口 | 用途 |
| --- | --- |
| 80/TCP | HTTP、ACME HTTP-01；收到配置前的默认监听 |
| 443/TCP、443/UDP | HTTPS、HTTP/3 |
| 集群的附加 HTTP / HTTPS 端口 | 见 [集群的监听端口](../guide/https.md#集群的监听端口) |
| 集群的端口池（1024–65535） | [L4 转发](../guide/l4.md) |

出站：

| 目标 | 用途 |
| --- | --- |
| 控制台节点通道（默认 8443/TCP；WebSocket 入口为控制台 Web 端口） | 注册与全部 RPC |
| 控制台 `EDGEWEIR_PUBLIC_URL` | `install.sh` 与 [下载镜像](../deploy/nodes.md#下载镜像)（只在安装时） |
| `github.com`、`api.github.com` 及 GitHub 的下载主机 | `install.sh` 与签名升级的默认发布源 |
| 源站 | 回源与主动健康检查 |
| OCSP 响应方 | 网站开启 OCSP stapling 时 |
| DNS 服务器 | `/etc/resolv.conf` 或 `--resolver`，解析源站域名 |
| 其他节点的调度地址 | 节点兼任探针时，见 [节点兼任探针](../guide/scheduling.md#节点兼任探针) |

本机 unix socket（不监听 TCP）：

| 路径 | 用途 |
| --- | --- |
| `/run/edgeweir-node/control.sock` | 数据面控制 API；`healthcheck`、`bans`、`security`、`accesslog` 使用 |
| `/run/edgeweir-node/diag.sock` | agent 诊断（0600）；`diagnose`、`pprof` 使用 |
| `/run/edgeweir-node/control.sock.geo` | GeoIP 查询（agent 提供给 Lua） |
| `/run/edgeweir-node/edge.sock`、`edge-tls.sock` | 预热专用的本地边缘监听 |
| `/run/edgeweir-node/origin*.sock` | 内部回源层（`origin`、`origin-noverify` 及其 `-h2`、`-grpc` 版本） |
| `/run/edgeweir-node/l4.sock` | stream 子系统的控制中继（有四层应用时） |
| `/run/edgeweir-node/agent.sock`、`image.sock` | PURGE 方法、图片转换 |
| `/var/lib/edgeweir-node/upgrade.sock` | 监督进程（0600） |

## 文件与目录

| 路径 | 内容 |
| --- | --- |
| `/usr/bin/edgeweir-node` | agent（tar.gz 安装同样位置；镜像为 `/usr/local/bin/edgeweir-node`） |
| `/usr/share/edgeweir-node/lua/edgeweir/` | Lua 模块 |
| `/usr/share/edgeweir-node/geoip/` | 内置 IPinfo Lite 与 `NOTICE`（仅容器镜像） |
| `/usr/lib/edgeweir-openresty/` | OpenResty：`nginx/sbin/nginx`、`luajit/`、`lualib/`；`modules/` 与 `lib/libmodsecurity.so.3` 来自 `edgeweir-openresty-modsecurity` |
| `/usr/share/edgeweir-openresty/` | OWASP CRS（`crs/`）与 `modsecurity/unicode.mapping` |
| `/etc/default/edgeweir-node` | 服务的环境变量（deb、rpm；保留本地修改），见 [节点配置](configuration.md) |
| `/etc/default/edgeweir-probe` | 探针服务的环境变量（0600） |
| `/usr/lib/systemd/system/edgeweir-node.service`、`edgeweir-probe.service` | systemd 单元（deb、rpm）；tar.gz 安装为 `/etc/systemd/system/edgeweir-node.service` |
| `/var/lib/edgeweir-node/` | 状态目录（`edgeweir` 用户，0700），见下表 |
| `/var/cache/edgeweir-node/<缓存区>/` | 缓存（0750） |
| `/var/lib/edgeweir-probe/` | 探针身份（0700）：`probe.key`（0600）、`probe.crt`、`ca.crt`、`probe.json` |

状态目录 `/var/lib/edgeweir-node/`：

| 文件 | 内容 |
| --- | --- |
| `node.key`（0600）、`node.crt`、`ca.crt` | 节点私钥、节点证书、内部 CA 证书 |
| `identity.json` | 节点 ID、集群 ID、节点名称、节点通道地址与服务器名、CA 指纹、注册时间、备用地址；存在即表示已注册 |
| `config/current.binpb`、`previous.binpb`、`receipts.json` | LKG 配置及其上一版本、控制台签发的配置回执（0600） |
| `certificates.json`、`origin-client-certificates.json` | 网站证书链、私钥与 OCSP 响应；回源客户端证书（0600） |
| `credentials.json` | S3 源站凭据、PURGE 密钥、访问鉴权密钥（明文，0600） |
| `challenge-keys.json`、`session-ticket-keys.json` | 挑战凭证密钥、TLS 会话票据密钥（0600） |
| `bans.json`、`purge.json` | 动态封禁、清缓存标记（0600） |
| `health.crt`、`health.key` | 健康端点的自签名证书（0600） |
| `traffic-spool.json`、`logs-spool.json`、`nodelogs-spool.json` | 控制台尚未确认的统计、访问日志与节点日志批次（0600） |
| `run.lock`、`identity.lock` | agent 运行锁、身份改写锁 |
| `upgrades/` | 监督进程状态 `state.json` 与版本目录 `releases/<任务 ID>/`（0700） |
| `nginx/` | nginx prefix：`conf/nginx.conf`、`logs/`、`tmp/` |

> [!WARNING]
> 状态目录含节点私钥、网站私钥与源站凭据，复制该目录即复制节点身份。新主机使用新的安装命令注册，不复制其他节点的状态目录。

## 命令

| 命令 | 作用 |
| --- | --- |
| `edgeweir-node enroll` | 以一次性 token 注册；`--force` 替换已有身份 |
| `edgeweir-node supervise --manage-nginx` | 监督进程（systemd 单元与镜像入口） |
| `edgeweir-node run [--manage-nginx]` | 不经监督进程运行 agent |
| `edgeweir-node probe` | 区域探针 |
| `edgeweir-node set-server` | 检查后更换节点通道地址 |
| `edgeweir-node healthcheck` | 数据面已有站点表时退出码 0，输出 `healthy: revision N, M sites` |
| `edgeweir-node diagnose [--json]` | 逐项检查身份、证书、控制台连通、时钟、agent、配置与数据面 |
| `edgeweir-node pprof PROFILE` | 读取运行中 agent 的 Go profile |
| `edgeweir-node bans [--list]` | 数据面封禁状态（JSON），`--list` 列出最多 1000 条 |
| `edgeweir-node security` | 挑战密钥、验证码池与各网站 CC 级别（JSON） |
| `edgeweir-node accesslog [--site ID] [--json]` | 实时查看本节点的请求 |
| `edgeweir-node version` | 版本、commit、构建时间、Go 版本与平台 |

参数与用法见 [节点运维](operations.md) 与 [节点配置](configuration.md)。

## 支持的平台

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Linux；glibc 2.34 及以上：RHEL、Rocky、AlmaLinux 9 及以上，Debian 12 及以上，Ubuntu 22.04 及以上 |
| 架构 | amd64（rpm 为 `x86_64`）、arm64（rpm 为 `aarch64`） |
| 服务管理 | systemd；容器镜像不需要 |
| 安装形式 | deb、rpm、tar.gz（需另装 `edgeweir-openresty` 的 deb 或 rpm）、容器镜像 `ghcr.io/marvinli001/edgeweir-node` |

## 版本

| 项目 | 规则 |
| --- | --- |
| 版本号 | 语义化版本 `vX.Y.Z`，发布在 [GitHub Releases](https://github.com/marvinli001/edgeweir-node/releases)；镜像标签 `X.Y.Z`、`X.Y` 与 `latest`（最新正式版本） |
| 修订版本 | 只含修复 |
| 次版本 | 新能力（`*-vN`）、新命令、新的可选参数 |
| 主版本 | 去掉能力或 proto 字段、状态目录或 `identity.json` 不兼容、提高系统要求、需要重新注册 |
| 与控制台 | 控制台按节点上报的能力下发配置，不比较版本号；节点 1.x 的全部次版本可与当前控制台配合 |
