# 节点升级

控制台分批签名升级（金丝雀、推进、节点侧验签与自动回滚）、手动升级、回滚到旧版本，以及节点能力。

## 概念

| 术语 | 定义 |
| --- | --- |
| 金丝雀组 | 金丝雀节点组。其余节点在推进前保持「等待金丝雀组」 |
| 发布源 | 节点发布物所在的基础 URL，按 `v<版本>/` 分目录 |
| 监督进程 | `edgeweir-node supervise --manage-nginx`，负责下载、验签、切换和回滚 |
| 基础安装 | 软件包或镜像安装的 `edgeweir-node` 与 Lua 模块；签名升级的版本保存在状态目录 `upgrades/releases/` |
| 节点能力 | 节点上报的功能标识。集群配置要求的能力节点缺少时，**集群与节点** 中显示「需要升级」 |

## 升级方式

| 方式 | 更新内容 | 适用 |
| --- | --- | --- |
| [控制台签名升级](#升级节点) | agent 程序与 Lua 模块 | systemd 或容器中以 `supervise` 运行的节点 |
| [软件包或镜像](#手动升级) | agent、Lua、监督进程、cosign、OpenResty | 全部节点；OpenResty 与监督进程的修复只能这样更新 |

## 前提

| 项目 | 要求 |
| --- | --- |
| 集群节点 | 集群中全部已启用节点：45 秒内有心跳、数据面健康、已应用集群当前配置版本、系统为 Linux、架构（amd64 或 arm64）在发布物中、上报 `self-upgrade-v1`。因缺少当前配置要求的[能力](#节点能力)而显示「需要升级」的节点，已应用此前的配置版本即可 |
| 数量 | 每个集群最多 1000 个已启用节点 |
| 并发 | 集群中的节点没有进行中的其他升级 |
| 监督进程 | 节点以 `supervise --manage-nginx` 运行（节点镜像和 systemd 单元的默认方式），且能找到 `cosign`；设置了 `EDGEWEIR_UPGRADE_PUBLIC_KEY` 时该文件存在 |
| 发布物 | 发布源的 `v<版本>/` 目录中有 `checksums.txt`、`checksums.txt.sigstore.json`，以及 `checksums.txt` 列出的 `edgeweir-node_<版本>_linux_<架构>.tar.gz` |

不满足监督进程条件的节点不上报 `self-upgrade-v1`。以 `--allow-unsigned` 安装的节点不会安装 `cosign`；主机上没有 `cosign` 时不具备远程升级能力。节点安装见[接入节点](../deploy/nodes.md)。

## 升级节点

1. 打开 **集群与节点**，选择集群，切换到「发布」页签（`/clusters?tab=releases`）。
2. 在「节点升级」中点击「发起升级」。
3. 填写「目标版本」，例如 `1.6.2`（也可写成标签 `v1.6.2`）；选择「金丝雀节点组」。
4. 点击「开始升级」。对话框列出「未就绪的节点」时不能开始，先处理这些节点（见下表）。
5. 等待金丝雀组的节点显示「已成功」，并持续健康 30 秒。
6. 点击「推进剩余节点」。其余节点分批升级：同时升级的节点最多为其余节点数的四分之一（至少 1 个，按节点名称排序），一个节点成功后下发下一个。
7. 验证：任务显示「已成功」；「节点」页签中节点的「Agent / 引擎」为目标版本。

升级重启节点的 agent。OpenResty 由监督进程运行，升级时继续服务并重新加载配置，封禁、CC 状态与限速计数保留；回滚到较旧版本时 OpenResty 会重启。不承诺无中断，选择一个流量可由其他节点承接的金丝雀组。

### 对话框

| 项目 | 行为 |
| --- | --- |
| 目标版本 | 预填发布源的最新版本：默认发布源取 GitHub 最新发布，镜像取其 `latest` 文件（与 `install.sh` 相同），控制台缓存 10 分钟；读取失败时留空。全部已启用节点已是该版本或更新时提示「全部节点已是 … 或更新的版本」，不能开始 |
| 金丝雀节点组 | 默认选有已启用节点的金丝雀组（节点组设置中开启「金丝雀」），没有时选已启用节点最少的非默认节点组。选项显示组内已启用节点数；所选组包含全部节点（多于 1 个）时提示「该组包含全部 … 个节点，推进阶段无剩余节点」 |
| 未就绪的节点 | 集群中阻止开始的已启用节点及原因：升级进行中、离线、不是 Linux、架构不受支持、不支持签名升级、数据面异常、配置未应用、落后。显示「需要升级」、应用着此前配置版本的节点不算落后 |

### 健康观察

| 项目 | 行为 |
| --- | --- |
| 条件 | 金丝雀节点的上报中，agent 版本、配置版本和内容哈希都与目标一致，且数据面健康 |
| 时长 | 连续满足至少 30 秒（两个心跳间隔）后才可推进（「金丝雀组健康 30 秒后可推进」） |
| 重新计时 | 出现不健康的上报或心跳间隔超过 45 秒时重新开始观察 |

### 状态

| 任务状态 | 含义 |
| --- | --- |
| 金丝雀 | 金丝雀组在升级或观察中 |
| 全量推进 | 其余节点分批升级中 |
| 已成功 / 失败 / 已取消 | 最终结果。最新的任务列出各节点；更早的已结束任务各为一行：版本、结果与时间，点击行末的箭头展开其节点与错误 |

| 节点状态 | 含义 |
| --- | --- |
| 等待金丝雀组 | 非金丝雀节点，等待推进 |
| 排队中 | 已推进，等待前一批节点完成 |
| 待执行 | 已下发，节点尚未开始；显示完成期限 |
| 升级中 | 节点正在下载、验签或试运行；显示完成期限 |
| 已成功 / 失败 / 已取消 | 该节点的结果；「诊断信息」显示节点上报的详情 |

### 取消与过期

| 操作 | 行为 |
| --- | --- |
| 「取消待执行任务」 | 取消「等待金丝雀组」「排队中」和「待执行」的节点任务；已升级的节点保持当前版本；有节点「升级中」时不能取消 |
| 过期 | 节点任务下发后 30 分钟仍未完成时记为「升级任务已过期」，整个任务失败；金丝雀组在任务创建时下发，其余节点在各自那一批下发时开始计时。推进前的观察没有时间限制 |
| 停用或删除节点 | 该节点的任务记为「节点已停用或删除，不再升级」，其余节点继续；金丝雀组的节点全部停用或删除后不能推进，取消后重新发起 |

## 节点侧校验

节点只接受本机配置的发布源（`--upgrade-source` / `EDGEWEIR_UPGRADE_SOURCE`，默认 `https://github.com/marvinli001/edgeweir-node/releases/download`）。控制台下发的地址必须精确匹配目标版本、本机 Linux 架构和预期文件名。

1. 下载 `checksums.txt`（最大 2 MiB）、`checksums.txt.sigstore.json`（最大 4 MiB）和归档（最大 128 MiB），HTTP 超时 90 秒，整个准备阶段最长 4 分钟。跳转只允许同协议、同主机，最多 5 次；使用默认发布源时另允许 GitHub 的下载主机（`release-assets.githubusercontent.com`、`objects.githubusercontent.com`）。
2. 用 `cosign` 验证 `checksums.txt`：证书身份固定为 `https://github.com/marvinli001/edgeweir-node/.github/workflows/release.yml@refs/tags/v<版本>`，签发者为 `https://token.actions.githubusercontent.com`。
3. 检查任务中的 SHA-256 与已签名清单一致，再校验归档的 SHA-256。
4. 解包时拒绝路径穿越、链接、特殊文件和重复条目；最多 512 个条目、单个文件 128 MiB、合计 256 MiB；检查 ELF 架构和 `edgeweir-node version` 输出的版本。
5. 把程序和 Lua 放入状态目录下的私有目录 `upgrades/releases/<任务 ID>/`（0700），持久化状态后切换。

控制台不能下发 shell 命令、更换节点信任的公钥或跳过签名校验。明文 HTTP 的测试镜像同样须验签。

## 监督进程与回滚

| 项目 | 行为 |
| --- | --- |
| 互斥 | 监督进程持有状态目录中的独占锁 `upgrades/supervisor.lock`，第二个进程不会把进行中的试运行误判为中断；私有 Unix socket `upgrade.sock` 权限 0600 |
| 确认成功 | 候选程序完成 mTLS 通信、应用期望配置（已应用、数据面健康、版本与控制台最新版本一致），并在 90 秒试运行期内持续健康至少 10 秒；agent 每 5 秒向监督进程报告一次，与心跳间隔无关 |
| 回滚 | 90 秒内未通过、试运行期间进程退出或监督进程重启时，恢复上一版程序、Lua 和配置快照 |
| 降级 | 比节点当前版本旧的版本被拒绝（「版本 … 未通过升级检查，保留原版本」）；节点以 `--upgrade-allow-downgrade` 启动时放行，见 [回滚到旧版本](#回滚到旧版本) |
| 结果 | 升级结果保存在磁盘，直到控制台确认；确认写入失败不丢弃结果；下载、验签或持久化失败不报告为成功 |
| 不回退 | 身份密钥、证书、凭据和统计游标不随程序回滚而倒退 |
| 磁盘 | 只保留当前、上一版和正在准备的版本目录 |

| 组件 | 更新方式 |
| --- | --- |
| agent 程序、Lua | 签名升级，或软件包、镜像 |
| 监督进程、`cosign`、OpenResty | 只能更新节点镜像或 deb / rpm 软件包；涉及这些组件的安全修复须更新完整镜像或系统包 |

软件包或镜像更新后，基础安装的程序与 Lua 发生变化时，监督进程优先采用新安装，不被状态目录中较旧的签名升级版本遮蔽；尚未确认的升级任务记为「版本 … 的任务因本机软件包更新而终止」。控制台显示运行中的 agent 版本；直接执行系统路径中的 `edgeweir-node version` 显示的是基础安装的版本。

## 手动升级

先 [校验发布物](../deploy/nodes.md#校验发布物)。软件包升级后包脚本重启运行中的 `edgeweir-node.service`（`systemctl try-restart`），OpenResty 随服务重启。

| 安装形式 | 命令 |
| --- | --- |
| 安装命令 | 在已注册的主机上重新执行原安装命令（不需要 token），末尾加 `--version <版本>`：校验并安装该版本，重启服务并做健康检查 |
| deb | `sudo apt-get install ./edgeweir-node_<版本>_amd64.deb`（OpenResty 版本变化时同时列出 `edgeweir-openresty` 与 `edgeweir-openresty-modsecurity` 的新包） |
| rpm | `sudo dnf install ./edgeweir-node-<版本>-1.x86_64.rpm`（同上） |
| tar.gz | 按 [tar.gz](../deploy/nodes.md#targz) 替换 `/usr/bin/edgeweir-node` 与 Lua 模块，`sudo systemctl restart edgeweir-node` |
| 容器 | 拉取新标签，以同样的卷与参数重新创建容器：`docker pull ghcr.io/marvinli001/edgeweir-node:<版本>` |

```bash title="节点（已注册）"
curl -fsSL https://cdn-admin.example.com/install.sh | sudo bash -s -- \
  --server https://cdn-admin.example.com:8443 --ca-sha256 <CA 指纹> --version 1.6.2
```

验证：`edgeweir-node version` 输出新版本；**集群与节点** 中「Agent / 引擎」为新版本。

## 回滚到旧版本

签名升级失败时节点自动回滚，不需要操作。需要主动换回旧版本时：

| 方式 | 步骤 |
| --- | --- |
| deb | `sudo apt-get install --allow-downgrades ./edgeweir-node_<旧版本>_amd64.deb` |
| rpm | `sudo dnf downgrade ./edgeweir-node-<旧版本>-1.x86_64.rpm` |
| 容器 | 以旧版本标签和同一状态卷重新创建容器 |
| 控制台任务 | 节点设置 `EDGEWEIR_UPGRADE_ALLOW_DOWNGRADE=true` 并重启服务；对话框在全部节点已是目标版本或更新时不能开始，此时经 API `POST /api/v1/node-upgrades` 发起 |

| 约束 | 说明 |
| --- | --- |
| 基础安装优先 | 降级软件包或镜像后，监督进程采用新的基础安装，状态目录中更新的签名升级版本不再使用 |
| 能力 | 旧版本缺少集群配置要求的能力时，节点保留最后可用的配置并显示「需要升级」，见 [节点能力](#节点能力)；签名任务中的这种候选版本应用不了当前配置，90 秒后回滚 |
| 主版本 | 跨主版本降级时状态目录可能不兼容；同一主版本内兼容 |
| OpenResty | 切换到更旧的程序版本前监督进程停止 OpenResty，随后重新启动 |

## 私有镜像与自有发行

| 项目 | 设置 |
| --- | --- |
| 控制台发布源 | 控制台读取发布清单的地址，在 **系统设置 → 节点发布源** 设置，见[节点发布源](system.md#节点发布源) |
| 节点发布源 | 节点的 `EDGEWEIR_UPGRADE_SOURCE`，与控制台发布源指向同一个按 `v<版本>/` 分目录的地址 |
| 镜像要求 | 镜像直接提供文件；节点拒绝跨来源跳转 |
| 自有签名 | 节点设置 `EDGEWEIR_UPGRADE_PUBLIC_KEY` 指向运维部署的本机公钥，按该公钥验证，不使用公共透明日志；只修改控制台数据库无法改变节点信任的公钥 |
| 明文镜像 | `EDGEWEIR_UPGRADE_ALLOW_HTTP=true` 仅用于明确选择的本地测试或隔离网络镜像，默认 `false` |

```bash title="/etc/default/edgeweir-node"
EDGEWEIR_UPGRADE_SOURCE=https://mirror.example.com/edgeweir-node
EDGEWEIR_UPGRADE_PUBLIC_KEY=/etc/edgeweir-node/release.pub
```

修改后执行 `sudo systemctl restart edgeweir-node`。参数表见 [节点配置](../node/configuration.md#升级supervise)；签名的生成与验证见 [Sigstore 文档](https://docs.sigstore.dev/cosign/signing/signing_with_blobs/)。

## 节点能力

节点在心跳中上报能力列表。控制台编译每个集群的配置时得出它需要的能力。

### 配置要求的能力

缺少时节点列表显示「需要升级」；该节点继续使用最后一次成功应用的配置，并拒绝含未知能力或未知枚举的配置。

| 能力 | 需要的场景 |
| --- | --- |
| `tls-v1` | 网站有 HTTPS 设置（保存过「HTTPS」页签） |
| `http01-v1` | ACME HTTP-01 验证 |
| `tls-pending-domains-v1` | 证书尚未覆盖的域名先以 HTTP 服务 |
| `http3-v1` | 网站开启 HTTP/3 |
| `brotli-v1`、`zstd-v1` | 网站开启 Brotli、Zstandard 压缩 |
| `modsecurity-v1` | 网站启用 OWASP CRS；节点需安装 `edgeweir-openresty-modsecurity` |
| `rules-v1` | 网站规则、全局规则、「放行」或「拦截」类 IP 名单 |
| `rules-v2` | 规则扩展：函数与新字段、表达式目标与查询参数编辑、源站覆盖、压缩规则、新的覆盖设置、缓存规则的表达式条件与浏览器 TTL、批量重定向、源站组，见[规则](rules.md#节点能力与发布) |
| `rules-v3` | 表达式变量与报头值：Cookie 与查询参数按名取值、User-Agent / Referer 等新字段、新函数与通配比较、请求头 / 响应头 / 查询参数的表达式值、响应头追加、重定向 303、错误页的 `{{time}}` 与 `{{path}}`，见[规则](rules.md#节点能力与发布) |
| `rules-body-v1` | 规则读取请求体字段，或设置了规则的请求体上限 |
| `waf-v2` | 规则动作封禁、自定义应答、断开连接、跳过；`log` 规则写访问日志；限速封禁；CRS 覆盖与按路径的排除规则 |
| `challenge-v1` | 挑战动作、Under Attack、CC 防护，或会话保持（需要挑战密钥） |
| `challenge-v2` | 已验证的搜索引擎爬虫、爬虫字段、挑战页文案、挑战失败封禁 |
| `ja4-v1` | 规则读取或按 `tls.ja4` 计数，或访问日志记录 JA4 |
| `geoip-city-v1` | 规则或地区访问控制使用国家（或一级行政区）；节点有国家数据时上报 |
| `geoip-asn-v1` | 规则或地区访问控制使用 ASN；节点有 ASN 数据时上报 |
| `geoip-subdivision-v1` | 规则使用 `ip.geoip.subdivision`，或地区访问控制按一级行政区；节点配置了 City MMDB 时上报，只由控制台检查；未上报 `geoip-country-v1` 的旧版节点以 `geoip-city-v1` 代替 |
| `access-logs-v1` | 访问日志采样 |
| `access-logs-v2` | 网站开启了「始终记录被拦截、挑战与鉴权失败的请求」、记录查询字符串、请求头或直连对端地址，见[访问日志](access-logs.md#启用访问日志) |
| `access-auth-v1` | 访问鉴权规则 |
| `access-control-v1` | 网站的访问控制 |
| `error-pages-v1` | 网站错误页 |
| `site-content-v1` | 缓存键排除参数、缓存带 `Set-Cookie` 的响应、PURGE 方法、隐藏 `X-Cache`、更多状态码与跳转的错误页、维护模式、字符集、gzip 级别与最大压缩大小、请求体上限、回源重试设置 |
| `cache-zone-v1` | 单个节点设置了自己的缓存容量 |
| `active-health-v1`、`active-health-grpc-v1` | 源站池的主动健康检查；gRPC 类型的检查 |
| `session-affinity-v1` | 会话保持 |
| `origin-http2-v1` | HTTP/2 回源与端到端 gRPC |
| `origin-proxy-protocol-v1` | 向源站发送 PROXY protocol |
| `origin-mtls-v1` | 回源客户端证书 |
| `origin-ca-v1`、`origin-ca-rotation-v1` | 只信任 Origin CA；Origin CA 轮换期间同时信任上一 CA |
| `multi-certificate-v1` | 一个网站多张证书 |
| `client-cert-v1` | 访客客户端证书（mTLS）与 `tls.client.*` 字段 |
| `image-convert-v1` | 网站开启了图片格式转换，见[图片格式转换](image-convert.md)；节点以 `--image-workers 0` 运行时不上报 |
| `edge-ports-v1` | 集群有附加监听端口、网站绑定了非默认端口，或 HTTPS 跳转用了非默认的状态码、端口或不跳转的域名，见 [HTTPS](https.md#集群的监听端口) |
| `client-ip-v1` | 集群的访客 IP 不是直连（或打开了「丢弃访客自带的 X-Forwarded-For」），或规则读取 `ip.peer`，见 [访客 IP](../deploy/nodes.md#访客-ip) |
| `domains-v2` | 网站（含停用网站）有 `.` 后缀或正则域名，见[域名写法](domains.md#域名写法) |
| `unknown-host-v1` | 集群的未知域名设置不是默认值（处理方式不是「未知域名页」，或开启了扫描防护），见[未知域名与节点 IP 访问](domains.md#未知域名与节点-ip-访问) |
| `l4-v1` | 集群有启用的 [L4 应用](l4.md)：L4 转发与 L4 统计。缺少时端口池页签、L4 应用列表与对话框提示「集群 {集群} 的节点 {节点} 不支持 L4 转发，升级前不应用含 L4 应用的配置」 |
| `l4-v2` | L4 应用使用端口段、同号源站端口或 TLS 卸载，见 [L4 转发](l4.md#端口段与源站端口) |
| `stats-sequence-v1` | 带序号的统计上报；缺少时节点始终显示「需要升级」 |

这类节点可以直接[升级](#升级节点)，升级后应用当前配置；目标版本须具备所缺的能力，否则候选程序应用不了当前配置，90 秒后回滚。控制台账户（会话或 AccessKey）可以发布需要新能力的配置，缺少能力的节点按上述方式保留原配置；服务账号与后台任务发布这类配置时返回 409 `NODE_CAPABILITY_REQUIRED`。

### 任务能力

缺少时控制台拒绝向受影响集群下发该任务，不显示「需要升级」。

| 能力 | 任务 |
| --- | --- |
| `purge-tag-v1` | 按 Host 与 Cache-Tag 清缓存 |
| `prefetch-v2` | 桌面与移动变体预热、sitemap 预热 |
| `debug-logs-v1` | 拉取 debug 日志（缺少时显示「节点版本过低」），见[节点日志](node-logs.md#debug-日志) |

### 其他能力

缺少时不显示「需要升级」；对应功能对该节点不可用或数据不完整。

| 能力 | 作用 |
| --- | --- |
| `self-upgrade-v1` | 签名升级；监督进程运行且找到 `cosign` 时上报 |
| `metrics-v1` | 心跳中的主机指标（CPU、负载、内存、出口带宽、活动连接），Linux 节点上报；缺少时节点指标与调度规则的节点指标条件为「无数据」 |
| `stats-dims-v1` | 统计维度（地区、运营商、来源、终端、协议、拦截原因、挑战）；集群有活动节点缺少时统计页提示数据不完整 |
| `origin-stats-v1`、`rule-log-v1` | 按源站的回源统计；`log` 规则的命中计数；缺少时数据不完整 |
| `probe-health-v1` | 边缘监听的健康端点 `/.edgeweir/health`；集群全部活动节点具备时，[区域探针](scheduling.md#探测方式) 以 HTTP / HTTPS 探测，否则只建立 TCP 连接 |
| `node-logs-v1` | 上传节点日志，见[节点日志](node-logs.md) |
| `channel-follow-v1` | 跟随控制台给出的节点通道地址（1.2.0 起）；缺少时节点标「需升级才能切换」 |
| `bans-v1`、`greylist-v1`、`kernel-ban-v1`、`conn-limit-v1` | 接收动态封禁；接收灰名单；内核封禁生效中；理解集群的每 IP 连接数限制（经 nftables 执行） |
| `auth-identity-headers-v1`、`certificate-isolation-v1` | 安全修复：删除已停用访问鉴权规则的身份请求头；单张证书无法加载时只跳过该证书。缺少任一项且未标「需要升级」的节点在「Agent / 引擎」标「建议升级」（悬停：「缺少新版节点的安全修复」） |
| `encoded-path-exemptions-v1` | 网站列出的路径前缀中含 `%2F` 或 `;` 的路径按原样比较与缓存；旧节点忽略该设置 |

## API

| 过程 | 端点 | 作用 |
| --- | --- | --- |
| `upgrades.release` | `GET /node-releases/{version}` | 读取发布清单：每个架构的归档、SHA-256 与签名地址 |
| `upgrades.latestVersion` | `GET /node-upgrades/latest-version` | 发布源的最新版本 `version`；无法得知时为 `null` |
| `upgrades.list` | `GET /node-upgrades` | 升级任务及每个节点的状态；可用 `clusterId` 只列出一个集群 |
| `upgrades.create` | `POST /node-upgrades` | 发起升级：`version`（开头的 `v` 会被去掉）、`nodeGroupId`（金丝雀组） |
| `upgrades.promote` | `POST /node-upgrades/{id}/promote` | 推进剩余节点 |
| `upgrades.cancel` | `POST /node-upgrades/{id}/cancel` | 取消待执行任务 |

端点位于 `/api/v1` 之下。只读 AccessKey 只能调用 GET 端点；服务账号不能调用这些接口。

## 限制

| 项目 | 说明 |
| --- | --- |
| 中断 | 签名升级重启 agent；OpenResty 只在回滚到较旧版本、更新节点镜像或软件包时重启。不是无中断升级 |
| 平台 | 只支持 Linux amd64 和 arm64 |
| 范围 | 签名升级只更新 agent 程序和 Lua |

## 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 「这些节点须在线、数据面正常、配置同步且支持签名升级：…」 | 列出的已启用节点（最多 10 个，其余显示为「+N」）离线、未应用当前版本（只因缺少能力而落后的除外）、数据面不健康、缺少 `self-upgrade-v1`，或架构不在发布物中 | 修复或停用这些节点后重试 |
| 「金丝雀节点组没有启用的节点」 | 所选节点组没有已启用节点 | 选择其他节点组 |
| 「一次升级最多 1000 个节点」 | 集群的已启用节点超过 1000 个 | 拆分集群 |
| 「版本号格式如 0.2.0」 | 「目标版本」不是 `主版本.次版本.修订号`（可带预发布后缀，如 `1.0.0-rc.1`）格式 | 改正版本号 |
| 「无法读取此版本的发布清单」 | 版本不存在、发布源不可达，或清单缺少 Linux 归档 | 核对版本号和控制台发布源 |
| 「发布源须使用 HTTPS 并解析到允许的地址」 | **系统设置 → 节点发布源** 中保存的发布源不满足出站策略 | 见[节点发布源](system.md#节点发布源) |
| 「这些节点已有未完成的升级：…」 | 列出的节点已有任务，或取消时这些节点「升级中」 | 等待当前任务结束 |
| 「升级已结束」 | 取消已结束的任务 | — |
| 「金丝雀节点尚未通过健康观察」 | 金丝雀组健康未满 30 秒 | 等待后再推进 |
| 「版本 … 未通过升级检查，保留原版本」 | 下载、签名、校验和、归档或版本检查失败，或目标版本比当前旧 | 查看「诊断信息」；核对节点发布源和公钥 |
| 「版本 … 未通过健康检查，已回滚」 | 候选程序未在 90 秒内应用配置并保持健康 | 查看[节点日志](node-logs.md) |
| 「升级任务已过期」 | 下发后 30 分钟内未完成 | 检查节点连接后重新发起 |
| 「版本 … 的任务因本机软件包更新而终止」 | 升级确认前节点的软件包或镜像被更新 | 以当前安装版本为准，按需重新发起 |
| 「后续节点升级已取消」 | 点击了「取消待执行任务」，或有节点升级失败后其余待执行任务被停止 | 处理失败节点后按需重新发起 |
| 「节点已停用或删除，不再升级」 | 升级期间节点被停用或删除 | — |
| 节点不上报 `self-upgrade-v1` | 以 `run` 运行、找不到 `cosign`，或 `EDGEWEIR_UPGRADE_PUBLIC_KEY` 指向的文件不存在 | 使用默认 systemd 单元或镜像；安装 `cosign`；[手动升级](#手动升级) |
