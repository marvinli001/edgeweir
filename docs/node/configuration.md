# 节点配置

节点服务的环境变量与参数：路径、网络、共享内存、GeoIP、内核封禁、图片转换、日志、资源限制与旧 worker 的关闭时间。

网站、缓存、规则等配置由控制台下发；以下参数只在节点本机设置，控制台不能修改。升级相关参数见 [节点升级](../guide/node-upgrades.md#私有镜像与自有发行)。

## 设置方式

| 方式 | 位置 | 生效 |
| --- | --- | --- |
| 环境文件（deb、rpm、tar.gz） | `/etc/default/edgeweir-node`，每行 `EDGEWEIR_<参数>=<值>`；软件包安装的文件全部为注释，升级时保留本地修改 | `sudo systemctl restart edgeweir-node` |
| systemd drop-in | `/etc/systemd/system/edgeweir-node.service.d/<名称>.conf` | `sudo systemctl daemon-reload && sudo systemctl restart edgeweir-node` |
| 容器 | `docker run -e EDGEWEIR_<参数>=<值>`，或 Compose 的 `environment` | 重新创建容器 |
| 命令行 | `edgeweir-node supervise --manage-nginx --<参数> <值>` | 优先于环境变量 |

| 规则 | 说明 |
| --- | --- |
| 变量名 | `EDGEWEIR_` 加参数名的大写，`-` 换成 `_`：`--stream-shutdown-timeout` → `EDGEWEIR_STREAM_SHUTDOWN_TIMEOUT` |
| 布尔参数 | `true`、`false` |
| 时长 | Go 时长格式：`500ms`、`30s`、`10m`、`2h` |
| 路径 | 绝对路径，不含空格与特殊字符 |
| 校验 | 启动时检查全部参数；取值错误时进程以退出码 2 退出，systemd 不再重启（`RestartPreventExitStatus=2`），原因见 `journalctl -u edgeweir-node -n 20` |
| 单元预设 | systemd 单元设置 `EDGEWEIR_NGINX_BIN=/usr/lib/edgeweir-openresty/nginx/sbin/nginx` 与 `EDGEWEIR_LUA_DIR=/usr/share/edgeweir-node/lua`；环境文件中的同名变量覆盖它们 |
| 镜像预设 | `EDGEWEIR_STATE_DIR`、`EDGEWEIR_NGINX_BIN`、`EDGEWEIR_LUA_DIR`、`EDGEWEIR_CACHE_DIR`、`EDGEWEIR_CONTROL_SOCKET`、`EDGEWEIR_ORIGIN_SOCKET` 取默认路径 |

示例：

```bash title="/etc/default/edgeweir-node"
EDGEWEIR_LOG_FORMAT=json
EDGEWEIR_RESOLVER=1.1.1.1,8.8.8.8
EDGEWEIR_STREAM_SHUTDOWN_TIMEOUT=30m
```

## 参数

`supervise` 与 `run` 的参数相同。

### 路径与进程

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--state-dir` | `/var/lib/edgeweir-node` | 状态目录：身份、LKG 配置、密钥材料 |
| `--cache-dir` | `/var/cache/edgeweir-node` | 缓存区的上级目录 |
| `--manage-nginx` | `false` | 由节点运行 OpenResty；`supervise` 必须开启 |
| `--nginx-bin` | `/usr/lib/edgeweir-openresty/nginx/sbin/nginx`（存在时），否则 `PATH` 中的 `openresty` | OpenResty 可执行文件 |
| `--nginx-prefix` | `<state-dir>/nginx` | nginx prefix 目录 |
| `--nginx-user` | 空 | agent 以 root 运行时 nginx worker 的用户；systemd 单元与镜像不以 root 运行，不需要 |
| `--lua-dir` | `/usr/share/edgeweir-node/lua` | `edgeweir/*.lua` 所在目录 |
| `--worker-processes` | `auto` | nginx `worker_processes` |
| `--default-port` | `80` | 收到配置前的 HTTP 端口，1–65535 |
| `--control-socket` | `/run/edgeweir-node/control.sock` | 数据面控制 API |
| `--diag-socket` | `/run/edgeweir-node/diag.sock` | 诊断 socket（0600）；空值关闭，`diagnose` 的 agent 与配置两项随之失败 |
| `--origin-socket` | `/run/edgeweir-node/origin.sock` | 内部回源层；HTTP/2 与 gRPC 回源层在同一目录 |
| `--origin-socket-noverify` | 回源 socket 同目录的 `origin-noverify.sock` | 不校验证书的回源层 |
| `--edge-socket` | 控制 socket 同目录的 `edge.sock` | 预热专用的本地边缘监听 |
| `--l4-socket` | 控制 socket 同目录的 `l4.sock` | stream 子系统的控制中继 |

### 网络与解析

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--listen-ipv6` | `auto` | 监听 IPv6：`auto`（本机能绑定 IPv6 时）、`on`、`off` |
| `--resolver-ipv6` | `auto` | 解析源站 AAAA 记录：`auto`（本机有全局 IPv6 地址时）、`on`、`off` |
| `--resolv-conf` | `/etc/resolv.conf` | nginx resolver 的来源 |
| `--resolver` | 空 | resolver 地址，逗号分隔；设置时不读 `--resolv-conf` |
| `--trusted-ca` | 系统 CA 文件 | 校验 HTTPS 源站证书的 CA 文件（回源与主动健康检查）；默认依次查找 `/etc/ssl/certs/ca-certificates.crt`、`/etc/pki/tls/certs/ca-bundle.crt`、`/etc/ssl/ca-bundle.pem`、`/etc/ssl/cert.pem` |

### 共享内存与容量

全部 `*-dict-mb` 取值 1–65536（MiB）。站点表或四层应用表放不下时配置应用失败，原因提示调大对应参数。

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--sites-dict-mb` | `64` | 站点表（`edgeweir_sites`）：当前与上一版站点表，含错误页模板 |
| `--l4-dict-mb` | `32` | 四层应用表（`edgeweir_l4`）：当前与上一版，含所用 IP 名单 |
| `--stats-dict-mb` | `16` | 统计计数（`edgeweir_stats`），agent 每分钟取走 |
| `--purge-dict-mb` | `32` | 清缓存标记（`edgeweir_purge`） |
| `--purge-markers-per-site` | `1000` | 每个网站的 URL 与前缀标记上限，超出后合并为整站标记 |
| `--purge-tags-per-site` | `5000` | 每个网站的标签标记上限，超出后合并为整站标记 |
| `--tag-dict-mb` | `64` | Cache-Tag 索引（`edgeweir_tags`），满时按 LRU 淘汰 |
| `--ban-capacity` | `100000` | 动态封禁条数上限，1–10000000；满时先淘汰最早的自动封禁 |
| `--ban-dict-mb` | `32` | 封禁存储（`edgeweir_bans`） |
| `--cc-dict-mb` | `32` | CC 防护存储（`edgeweir_cc`） |
| `--challenge-dict-mb` | `8` | 挑战存储（`edgeweir_challenge`） |
| `--rate-limit-dict-kb` | `256` | 每个已发布网站的限速计数（`edgeweir_rate_<网站 ID 十六进制>`），64–65536 KiB；满时新计数放行 |

### 任务与上报

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--prefetch-budget` | `4m` | 一批预热任务的时间上限，须大于 0；控制台 5 分钟后重新分发未完成的任务 |
| `--cache-usage-interval` | `10m` | 测量缓存区磁盘用量的间隔（遍历缓存目录），至少 `1s` |
| `--stats-interval` | `1m` | 取出并上报统计的间隔，`1s`–`1m` |

### 安全模块

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--kernel-bans` | `auto` | 平台封禁写入 nftables：`auto`（`nft` 可执行且有 `CAP_NET_ADMIN` 时）、`off`；见 [内核封禁](#内核封禁) |
| `--nft-bin` | `nft` | nftables 可执行文件 |
| `--modsecurity-module` | `auto` | ModSecurity 动态模块：`auto`（`--nginx-bin` 所属 edgeweir-openresty 的 `modules/`）、文件路径、`off`；只在有网站启用 OWASP CRS 时加载 |
| `--crs-dir` | `/usr/share/edgeweir-openresty/crs` | OWASP CRS 目录（`crs-setup.conf`、`rules/`），不能为空 |

模块与 CRS 都存在、加载测试通过时节点上报 `modsecurity-v1`；缺少时启用 OWASP CRS 的网站不能由该节点服务。

### GeoIP

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--geoip-ipinfo` | `auto` | IPinfo Lite MMDB（国家、ASN）：`auto`（使用镜像内置的 `/usr/share/edgeweir-node/geoip/ipinfo_lite.mmdb`，不存在时不使用）、`off`、文件路径 |
| `--geoip-city` | 空 | City MMDB（一级行政区；IPinfo 查不到时也提供国家） |
| `--geoip-asn` | 空 | ASN MMDB（IPinfo 查不到时提供 ASN） |

| 项目 | 说明 |
| --- | --- |
| 内置数据 | 只有容器镜像内置 IPinfo Lite；deb、rpm、tar.gz 不含 GeoIP 数据，需要时以 `--geoip-ipinfo` 或 `--geoip-city` / `--geoip-asn` 指定文件 |
| 查询 | 在节点本机完成，运行时不下载数据，不向第三方发送访客地址 |
| 更新 | 替换文件或拉取新镜像后重启节点服务 |
| 能力 | 有国家数据时上报 `geoip-city-v1`，有 ASN 时上报 `geoip-asn-v1`，有 City MMDB 时上报 `geoip-subdivision-v1`；规则用到的 GeoIP 字段节点没有数据时配置被拒绝，见 [节点能力](../guide/node-upgrades.md#节点能力) |
| 文件权限 | 文件须对 `edgeweir` 用户可读；systemd 单元的文件系统除状态、缓存与运行目录外只读，放在 `/usr/share`、`/var/lib` 等已有目录下 |

### 图片转换

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--image-workers` | min(4, max(1, CPU 数 / 2)) | 同时进行的 WebP / AVIF 转换数，0–64；每个转换是一个只用一个 CPU 的子进程。`0` 关闭转换：节点不上报 `image-convert-v1`，开启转换的网站不能由该节点服务 |
| `--image-memory-mb` | `1024` | 进行中的转换合计可用的内存，64–1048576 MiB；按像素估算，超出时返回原图 |
| `--image-timeout` | `8s` | 单次转换的最长时间，`1s`–`5m`；超时杀掉子进程并返回原图 |

### 日志

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--log-level` | `info` | `debug`、`info`、`warn`、`error`；写到标准错误（systemd 为 journal） |
| `--log-format` | `text` | `text`、`json` |
| `--debug-log-buffer` | `5000` | 内存中保留的最近日志条数（全部级别，最多 4 MiB），0–100000；`0` 关闭，节点不上报 `debug-logs-v1`，见 [Debug 日志](../guide/node-logs.md#debug-日志) |

### 升级（supervise）

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--cosign-bin` | `cosign` | 签名验证程序 |
| `--upgrade-source` | `https://github.com/marvinli001/edgeweir-node/releases/download` | 本机信任的发布源；升级任务不能修改 |
| `--upgrade-public-key` | 空 | 运维提供的发布公钥；为空时校验官方发布工作流的 GitHub OIDC 身份 |
| `--upgrade-allow-http` | `false` | 允许明文 HTTP 发布源（本地测试、隔离网络） |
| `--upgrade-allow-downgrade` | `false` | 允许升级任务安装比当前更旧的版本 |

### 旧 worker 的关闭时间

reload 后，旧 worker 默认服务已有的连接（四层长连接、HTTP keep-alive、WebSocket）直到连接结束；频繁的结构性变更会留下多组旧 worker。

| `--stream-shutdown-timeout` | 行为 |
| --- | --- |
| `0`（默认） | 不限时，旧 worker 在最后一个连接结束后退出 |
| 时长，如 `30m`、`2h` | 到时后旧 worker 关闭仍在服务的全部连接（nginx `worker_shutdown_timeout`），四层、HTTP 与 WebSocket 连接都受影响 |

```bash title="/etc/default/edgeweir-node"
EDGEWEIR_STREAM_SHUTDOWN_TIMEOUT=30m
```

容器节点用 `-e EDGEWEIR_STREAM_SHUTDOWN_TIMEOUT=30m`。四层连接的说明见 [reload 与长连接](../guide/l4.md#reload-与长连接)。

## 内核封禁

平台封禁默认在 HTTP 层执行（`403`）。启用内核封禁后，被封地址的入站包由 nftables（`table inet edgeweir`）丢弃，节点上报 `kernel-ban-v1`，见 [封禁](../guide/bans.md)。

| 部署 | 步骤 |
| --- | --- |
| systemd | 安装 `nftables`（deb、rpm 推荐安装）；创建下面的 drop-in；`sudo systemctl daemon-reload && sudo systemctl restart edgeweir-node`；日志出现 `kernel bans active: nftables table inet edgeweir` 即生效 |
| 容器 | 以 `docker build --build-arg NFT_CAPABILITY=true` 构建镜像（给 `/usr/sbin/nft` 加 `cap_net_admin+ep`），容器以 `--cap-add NET_ADMIN`（Compose：`cap_add: [NET_ADMIN]`）启动；发布镜像不含该文件能力 |

```ini title="/etc/systemd/system/edgeweir-node.service.d/kernel-ban.conf"
[Service]
AmbientCapabilities=CAP_NET_BIND_SERVICE CAP_NET_ADMIN
CapabilityBoundingSet=CAP_NET_BIND_SERVICE CAP_NET_ADMIN
```

| 项目 | 说明 |
| --- | --- |
| 匹配 | 按 TCP 连接的源地址；节点前有 PROXY protocol 负载均衡或七层代理时只看到它们的地址，见 [节点前的负载均衡](../guide/bans.md#节点前的负载均衡) |
| 出站 | 被封地址的全部入站包被丢弃，节点也无法与该地址建立连接（例如该地址是源站） |
| 四层应用 | 动态封禁对四层应用只经内核执行 |
| 失败 | `nft` 不可用或缺少权限时退回 HTTP 层封禁 |

## 资源与内核参数

| 项目 | 值 |
| --- | --- |
| 打开文件数 | 单元 `LimitNOFILE=1048576`；节点把软限制提到硬限制，`worker_rlimit_nofile` 取硬限制（最多 1048576） |
| `worker_connections` | 4096；硬限制小于 8192 时为硬限制的一半（至少 256）；端口段较多时随监听 socket 数提高 |
| 特权端口 | 单元只授予 `CAP_NET_BIND_SERVICE`（OpenResty 继承），80、443 与 1024 以下的附加端口由 nginx 主进程绑定；容器以 uid 10001 运行，在容器网络命名空间内绑定 |
| 内核参数 | 节点不修改 sysctl |
| 内存 | 上表共享内存之和，加每个已发布网站 `--rate-limit-dict-kb`，加图片转换的 `--image-memory-mb` |
| 磁盘 | 缓存区容量由控制台设置（集群或单个节点），见 [缓存区](../guide/origins-and-cache.md#缓存区)；状态目录的暂存文件有各自的上限 |
| CPU | `worker_processes auto` 为每个 CPU 一个 worker；启用 OWASP CRS 的网站每个请求约多 0.5 ms CPU |
| systemd 加固 | `ProtectSystem=strict`、`NoNewPrivileges=yes`、`PrivateTmp=yes`、`RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK`、`SystemCallFilter=@system-service`；不设 `MemoryDenyWriteExecute`（LuaJIT 需要） |
