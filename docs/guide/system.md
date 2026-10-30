# 系统设置与审计

系统设置（通用、监控与服务账号页签）、审计日志与防护设置页。

集群、节点与区域见 [集群与节点](clusters.md)，DNS 调度见 [DNS 调度](dns.md)，告警见 [告警](alerts.md)，区域探针与智能调度见 [区域探针与智能调度](scheduling.md)，侧边栏全部页面见 [控制台导航](account.md#控制台导航)。

## 系统设置

页面：**系统设置**（`/system`），页签：

| 页签 | 内容 |
| --- | --- |
| **通用** | 以下各节，按页面顺序：系统信息、节点通道、源站地址允许清单、节点发布源、证书颁发机构、用量、访问日志、节点日志保留期、平台错误页、登录 IP 白名单、演示账号 |
| **监控** | `/system?tab=probes`：区域探针列表（页面操作 **添加探针**）、**最近一轮** 卡片（探测方 × 节点的延迟矩阵）与 **探测设置** 卡片，见 [区域探针](scheduling.md#区域探针)；`/regions?tab=probes` 跳转到这里 |
| **服务账号** | `/system?tab=service-accounts`，见 [服务账号](#服务账号) |

### 系统信息

只读。

| 项目 | 来源 |
| --- | --- |
| **版本** | 镜像版本 `<YYYYMMDD>-<commit>`；源码运行为 `dev` |
| **控制台地址** | `EDGEWEIR_PUBLIC_URL`；localhost 或回环地址标「仅本机可达」，内网地址标「内网地址」：其他网络的节点无法从此下载 `install.sh`；公网地址使用 HTTP 时标「未加密」：`install.sh` 以明文传给要用 root 运行它的主机 |
| **CA 指纹** | 节点通道内部 CA 的 SHA-256；安装命令中的 `--ca-sha256` 与之相同 |
| **统计模式** | `EDGEWEIR_ANALYTICS`（`lite` / `clickhouse`） |
| **初始化令牌** | **未使用** 或 **已于 {时间} 使用** |
| **OpenAPI** | `/api/v1/openapi.json` |

### 节点通道

**地址**：节点与区域探针连接节点通道的地址，即安装命令中的 `--server`。输入框为空时使用 `EDGEWEIR_NODE_API_URL`；未设置时为 `https://<EDGEWEIR_PUBLIC_URL 的主机名>:<NODE_API_PORT>`，`EDGEWEIR_NODE_API_WEBSOCKET=true` 时为 `wss://<EDGEWEIR_PUBLIC_URL 的主机与端口>`（控制台地址为 `http://` 时为 `ws://`）；占位文字为当前生效的地址，标签显示其来源。

| 约束 | 说明 |
| --- | --- |
| 格式 | `https://主机[:端口]`（节点通道端口），或 `wss://主机[:端口]`、`ws://主机[:端口]`（Web 端口上的 [WebSocket 入口](../deploy/networking.md#节点通道的-websocket-入口)）；不含路径、查询参数与账号；保存为主机名小写、去掉末尾 `/` 与默认端口（443，`ws://` 为 80）的形式 |
| 生效 | 保存后立即生效，不重启控制台：新的安装命令与探针命令使用该地址，节点通道证书加入其主机名或 IP |
| 已注册的节点 | v1.2.0 起的节点与探针检查新地址后自动切换，旧地址的名称留在证书中；编辑时提示「全部节点切换前保持原地址可用」。过程见 [更换节点通道地址](../deploy/networking.md#更换节点通道地址) |
| 清空 | 保存空值后回退到环境变量或默认值 |

地址为 localhost、回环或内网地址时标「仅本机可达」或「内网地址」：其他网络的节点无法注册。地址下方显示 [连接检查](../deploy/nodes.md#节点通道连接检查) 的结果：**连接正常**、**控制台无法连接该地址**、**证书不符，前面可能有代理或 CDN**，或 **出站策略不允许连接该地址**（保存的地址是内网、回环等特殊用途地址，`EDGEWEIR_OUTBOUND_ALLOW_CIDRS` 未放行，控制台不连接）。修改写审计 `system.node_channel_update`。证书名称见 [节点通道地址与证书](../deploy/networking.md#节点通道地址与证书)。

有已注册的节点或探针时，地址下方显示 **已切换节点 N/M** 与 **已切换探针 N/M**（证书仍有效的节点与探针中，已用上当前地址的），每 15 秒刷新。

| 项目 | 说明 |
| --- | --- |
| **证书中的旧名称** | 此前生效过的地址留在证书中的主机名或 IP（环境变量产生的名称不列出），以及仍用它连接的节点与探针数（**节点 N · 探针 N**，或 **未使用**）。**未使用** 时可点 **移除**，名称随即从所有控制台实例的证书中去掉；仍有节点或探针使用时按钮不可用，接口返回 `NODE_CHANNEL_NAME_IN_USE`。节点保留的备用地址不计入 |
| **WebSocket 入口** | 此前用过 `wss://`、`ws://` 地址、现在的地址不再需要时显示，带仍经入口连接的节点与探针数；**未使用** 时可点 **关闭**。`EDGEWEIR_NODE_API_WEBSOCKET=true` 或当前地址是 `wss://`、`ws://` 时入口保持开放，不显示此项 |

移除名称与关闭入口同样写审计 `system.node_channel_update`（元数据 `removedName`、`webSocket: closed`）。

### 源站地址允许清单

**允许的地址段（每行一个 CIDR）**，最多 256 条。清单内的内网、回环等特殊用途地址可作为源站。保存后所有集群各发布一个配置版本，并写审计 `system.origin_allow_list_update`。源站地址规则见 [源站地址限制](origins-and-cache.md#源站地址限制)。

### 节点发布源

**发布源地址**：节点升级读取发布清单的镜像地址，布局为 `<地址>/v<版本>/checksums.txt`。

| 约束 | 说明 |
| --- | --- |
| 格式 | `http(s)` URL，不含账号、查询参数或片段 |
| 协议 | 公网地址须使用 HTTPS；HTTP 只用于 `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` 放行的内网地址 |
| 出站策略 | 保存时解析主机名，地址须为公网或 `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` 放行的地址 |
| 清空 | 保存空值后回退到环境变量或默认值 |

每个节点另有本机固定的发布源与签名信任锚，控制台不能修改；见 [节点升级](node-upgrades.md)。

### 证书颁发机构

自定义 ACME 目录：申请证书时「证书颁发机构」除 Let's Encrypt、ZeroSSL、Google Trust Services 外可选的「自定义 ACME 目录」，例如私有 PKI 或测试 CA。

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| **自定义 ACME 目录** | `https://` URL，最长 2048 字符，不含账号或片段；空 | ACME 目录地址。保存前控制台读取该地址（10 秒、最大 1 MiB、不跟随跳转），返回的不是 ACME 目录（缺少 `newNonce`、`newAccount`、`newOrder`）时拒绝（「该地址没有返回 ACME 目录」）。允许内网地址，不受 `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` 限制。保存空值后回退到环境变量或不配置 |
| **EAB 密钥 ID** / **EAB HMAC 密钥** | 两者同时填写或都留空 | 该目录要求的外部账户绑定；申请证书时留空即使用这里的值。HMAC 密钥信封加密保存，只写不读：已保存时占位文字为「已保存，留空不修改」，不改密钥 ID 时留空保留原密钥 |
| **CA 证书（PEM）** | 1–10 张证书，最大 64 KiB；空 | 目录 HTTPS 证书的签发者，与系统信任库一起使用；空时只用系统信任库 |

URL 与 CA 证书分别显示来源标签（**已保存**、**环境变量** 或 **默认**）：界面保存的值优先，其次是 `EDGEWEIR_ACME_DIRECTORY` 与 `EDGEWEIR_ACME_CA_FILE`。目录的 `meta.caaIdentities` 显示为「CAA 签发者」，申请时据此检查 CAA；目录没有提供时不检查。修改写审计 `system.acme_directory_update`。申请与 ACME 账户见 [HTTPS 与证书](https.md#证书颁发机构)。

### 用量

| 字段 | 取值 | 默认值 | 说明 |
| --- | --- | --- | --- |
| **保留天数** | 35–400 | 100 | 用量记录保留时间 |
| **离线节点不阻塞完整性（分钟）** | 5–1440 | 60 | 超过该时间没有心跳的节点不再阻塞 `completeUntil` |

修改写审计 `system.usage_update`。用量接口与 `completeUntil` 的定义见 [用量](../reference/api/monitoring.md#用量)。

### 访问日志

| 字段 | 取值 | 默认值 | 说明 |
| --- | --- | --- | --- |
| **保留天数** | PostgreSQL 1–30，ClickHouse 1–90 | 7 | 访问日志的保留时间；卡片只显示当前统计模式（`EDGEWEIR_ANALYTICS`）的天数 |

修改写审计 `system.log_retention_update`，下一次每分钟维护按新的天数删除分区（ClickHouse 修改 TTL），见[访问日志的保留期](access-logs.md#保留期)。

### 节点日志保留期

| 字段 | 取值 | 默认值 | 说明 |
| --- | --- | --- | --- |
| **保留天数** | 1–30 | 7 | 节点日志条目的保留时间 |
| **每个节点最多条数** | 1000–100000 | 10000 | 每个节点保留的条目上限 |

修改写审计 `system.node_log_retention_update`。删除时机见 [节点日志的保留期](node-logs.md#保留期)。

### 平台错误页

| 字段 | 适用的请求 | 说明 |
| --- | --- | --- |
| **未知域名** | Host 不属于集群的任何网站（集群可以改为关闭连接或交给默认网站，见[未知域名](domains.md#未知域名与节点-ip-访问)） | 状态码 404；留空使用内置页面 |
| **网站已停用** | 已停用网站的域名 | 状态码 503 |

每个模板最多 65536 字节（UTF-8），占位符 `{{status}}`、`{{request_id}}`、`{{client_ip}}`、`{{host}}`、`{{time}}`、`{{path}}` 的值经 HTML 转义；用到 `{{time}}` 或 `{{path}}` 时所有集群的配置要求节点能力 `rules-v3`。保存后所有集群各发布一个配置版本（原因「修改平台错误页」）；修改写审计 `system.error_pages_update`。旧节点忽略平台错误页。见 [错误页](error-pages.md#平台错误页)。

### 登录 IP 白名单

只允许名单内的地址登录控制台。名单为空时关闭（默认）。

| 字段 | 说明 |
| --- | --- |
| **允许登录的地址段** | 每行一个 IPv4 或 IPv6 CIDR，单个地址按 /32、/128 处理，最多 64 条。IPv4 映射的 IPv6 地址（`::ffff:1.2.3.4`）按 IPv4 比较 |
| **当前 IP** | 控制台为这次请求解析出的地址，规则见 [可信代理与客户端 IP](../deploy/networking.md#可信代理与客户端-ip)；**加入当前 IP** 把它加入名单 |

名单不为空时：

| 范围 | 名单外的地址 |
| --- | --- |
| 登录：密码、两步验证、通行密钥 | 返回 `LOGIN_IP_NOT_ALLOWED`（403），不校验密码，不计入登录限速 |
| 已有会话：`/rpc` 与 `/api/auth`（读取会话、修改密码、两步验证与通行密钥管理） | 返回 `LOGIN_IP_NOT_ALLOWED`，会话本身保留，回到名单内的地址后继续可用。退出登录不受限 |
| `/api/v1` 的 AccessKey 与服务账号 key | 不受限 |
| [演示账号](#演示账号) | 不受限 |
| 初始化向导（`system.setup`）、登录页、节点通道与安装脚本 | 不受限 |

| 项目 | 说明 |
| --- | --- |
| 防止锁住自己 | 保存不含当前 IP 的名单时拒绝（`LOGIN_ALLOW_LIST_EXCLUDES_CURRENT_IP`），通过 AccessKey 保存时同样检查调用方的地址 |
| 代理提示 | 当前 IP 是内网、CGNAT、回环等地址，或请求带了转发头而对端不在 `EDGEWEIR_TRUSTED_PROXIES` 内时，卡片提示它可能是代理的地址。控制台部署在 Zeabur、Render、Fly.io、Railway、bunny.net 等平台的代理后面而没有设置 `EDGEWEIR_TRUSTED_PROXIES` 时，所有访问者显示同一个代理地址，名单起不到作用 |
| 被锁在外面 | 在服务器上执行 `recover.js --clear-login-allowlist`，见 [找回账户](account.md#找回账户) |
| 记录 | 修改写审计 `system.login_allow_list_update`（`cidrs`、`added`、`removed`）；被拒绝的请求只写控制台日志（同一地址每分钟一行，每分钟最多 20 行），不写审计 |

### 演示账号

公开演示用的只读账号，与管理账户并存，不修改管理账户。

| 字段 | 说明 |
| --- | --- |
| **允许演示账号登录** | 打开后创建账号 `demo@edgeweir.com`，密码 `demo`，登录页出现 **使用演示账号登录**；关闭后删除该账号并结束它的全部会话。默认关闭 |

演示账号能查看控制台的全部页面，但不能做任何修改：

- 所有修改操作返回 `DEMO_READ_ONLY`（403），包括 `rules.validate` 以外的全部非 GET 接口；它不能创建 AccessKey、注册令牌或服务账号
- 不能修改密码、开关两步验证、添加或删除通行密钥
- 审计日志与访问日志中的客户端地址只显示所在网段（IPv4 /24、IPv6 /48），访问日志不显示记录的请求头，登录失败条目不显示输入的邮箱
- [登录 IP 白名单](#登录-ip-白名单) 不限制演示账号；它看到的名单与相关审计条目同样只显示所在网段
- 密钥本来就不会返回给任何人；其他内容（网站、节点、证书、DNS 与告警设置等）与管理账户看到的相同，公开前请确认其中没有不想公开的信息

管理账户的邮箱为 `demo@edgeweir.com` 时不能打开（`DEMO_EMAIL_TAKEN`）。修改写审计 `system.demo_update`；演示账号的登录同样写入审计日志。

### 设置优先级

控制台中保存的值优先于环境变量，环境变量优先于默认值。环境变量只作为已有部署的后备。

| 设置 | 位置 | 环境变量 | 默认值 |
| --- | --- | --- | --- |
| 节点通道 | **系统设置 → 节点通道** | `EDGEWEIR_NODE_API_URL` | `https://<EDGEWEIR_PUBLIC_URL 的主机名>:<NODE_API_PORT>`；`EDGEWEIR_NODE_API_WEBSOCKET=true` 时为 `wss://<EDGEWEIR_PUBLIC_URL 的主机与端口>` |
| 节点发布源 | **系统设置 → 节点发布源** | `EDGEWEIR_NODE_RELEASE_BASE_URL` | `https://github.com/marvinli001/edgeweir-node/releases/download` |
| 自定义 ACME 目录 | **系统设置 → 证书颁发机构** | `EDGEWEIR_ACME_DIRECTORY` | 不配置 |
| ACME 目录的 CA 证书 | **系统设置 → 证书颁发机构 → CA 证书（PEM）** | `EDGEWEIR_ACME_CA_FILE`（PEM 文件路径） | 系统信任库 |
| ACME 目录的 EAB | **系统设置 → 证书颁发机构** | 无 | 无 |
| SMTP CA 证书 | **告警 → SMTP → CA 证书（PEM）** | `EDGEWEIR_SMTP_CA_FILE`（PEM 文件路径） | 系统信任库 |
| SMTP 服务器与账户 | **告警 → SMTP** | 无 | 未配置 |
| 源站地址允许清单 | **系统设置 → 源站地址允许清单** | 无 | 空 |
| 登录 IP 白名单 | **系统设置 → 登录 IP 白名单** | 无 | 空（关闭） |
| 用量 | **系统设置 → 用量** | 无 | 保留 100 天，离线阈值 60 分钟 |
| 访问日志保留期 | **系统设置 → 访问日志** | 无 | 7 天 |
| 节点日志保留期 | **系统设置 → 节点日志保留期** | 无 | 7 天，每个节点 10000 条 |
| 封禁 | **防护设置 → 封禁** | 无 | 上限 10000，共享自动封禁 |
| 防护 | **防护设置 → 防护** | 无 | 全局 Under Attack 关闭，挑战类型 JS 计算，事件保留 30 天 |

**节点通道**、**节点发布源** 与 **证书颁发机构** 的标签显示当前生效值的来源：**已保存**、**环境变量** 或 **默认**。系统设置中保存的发布源地址受 `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` 约束；环境变量中的值由运维设置，不经该检查。全部环境变量见 [环境变量](../reference/environment.md)。

## 服务账号

页面：**系统设置** 的 **服务账号** 页签（`/system?tab=service-accounts`；`/service-accounts` 跳转到这里），页面操作为 **新建服务账号**。服务账号是供集成调用 `/api/v1` 的身份：不能登录控制台，只能用 key（`ews_` 开头，请求头 `x-api-key`）调用下表中的过程。

| 操作 | 说明 |
| --- | --- |
| **新建服务账号** | **名称**（最多 64 字符，不能重复）、**权限范围**（scope）、**启用** |
| **编辑服务账号** | 行末 **⋯** 中；修改名称、scope 与启用状态；停用的服务账号的 key 被拒绝 |
| **密钥** | 点击服务账号所在行打开；**新建密钥**（可填 **密钥名称**；key 仅显示一次）；**吊销** 需要确认。列表显示 **已吊销** 与 **最后使用** |
| 删除 | 行末 **⋯** 中的 **删除**，需要确认；它的全部 key 同时失效 |

| Scope | 可调用的过程 |
| --- | --- |
| 无需 scope | `system.status`、`account.me`、`dns.catalog` |
| `system:read` | `settings.get` |
| `clusters:read` | `clusters.list`、`clusters.get` |
| `sites:read` | `sites.list`、`sites.get`、`sites.launch`、`dns.siteTarget` |
| `sites:write` | `sites.setEnabled` |
| `usage:read` | `usage.list`、`usage.changes` |

| 项目 | 行为 |
| --- | --- |
| 其他过程 | 403 `SERVICE_ACCOUNT_FORBIDDEN` |
| 缺少 scope | 403 `SCOPE_REQUIRED`，`data.scope` 为所需的 scope |
| 节点能力 | 变更需要集群活动节点缺少的能力时返回 409 `NODE_CAPABILITY_REQUIRED`，见 [配置版本](clusters.md#配置版本) |
| 审计 | 服务账号做出的变更以 **服务账号** 身份写审计；服务账号与 key 本身的变更写审计 `service_account.*` |

端点与请求格式见 [API 与端点](../reference/api.md#服务账号)。

## 审计日志

页面：**审计日志**（`/audit`）。管理操作写入审计日志。控制台自身的变更与审计条目在同一事务中提交；登录、修改密码、两步验证与通行密钥的变更由 better-auth 完成，审计条目在其提交后写入，写入失败只记录日志。审计日志不自动清理。

| 字段 | 内容 |
| --- | --- |
| 时间 | 操作时间 |
| 操作者 | 类型（**用户**、**AccessKey**、**服务账号**、**节点**、**探针**、**系统**）、ID、名称 |
| IP、User-Agent | 请求来源；不经请求的操作（节点、探针、系统）为空。IP 取值规则见 [可信代理与客户端 IP](../deploy/networking.md#可信代理与客户端-ip) |
| 操作 | 代码形如 `site.create`，界面显示其名称（如 **创建网站**） |
| 对象 | 类型、ID、名称；名称在操作时记录，对象删除后仍可读 |
| 元数据 | JSON，操作相关的参数与前后值 |

页面显示 **时间**、**操作者**、**操作**（名称与代码）、**对象**，每页 50 条；筛选 **操作**、**对象** 类型与时间范围（**全部时间**、**近 1 小时**、**近 24 小时**、**近 7 天**、**近 30 天**）。行末的 **详情** 显示全部字段：完整时间、操作者与对象的 ID、IP、User-Agent 与格式化的元数据 JSON。没有名称的旧代码按原样显示。`/api/v1` 返回全部字段，读取方式见 [API 与端点](../reference/api.md)。

| 操作前缀 | 内容 |
| --- | --- |
| `system.*` | 初始化（`system.setup`；setup token 错误为 `system.setup_rejected`）、节点通道（`system.node_channel_update`）、源站地址允许清单（`system.origin_allow_list_update`）、节点发布源（`system.release_source_update`）、证书颁发机构（`system.acme_directory_update`）、用量（`system.usage_update`）、访问日志保留期（`system.log_retention_update`）、节点日志保留期（`system.node_log_retention_update`）、平台错误页（`system.error_pages_update`）、登录 IP 白名单（`system.login_allow_list_update`）、演示账号（`system.demo_update`）、封禁设置（`system.bans_update`）、防护（`system.protection_update`）、CC 模板（`system.cc_template_update`）、探测设置（`system.probes_update`）、升级后重新编译（`system.recompile`） |
| `auth.*` | 登录成功（`auth.sign_in`，含登录方式）与失败（`auth.sign_in_failed`） |
| `account.*` | 修改密码、启用 / 停用两步验证、添加 / 删除通行密钥、在服务器上找回账户（`account.recover`，见 [找回账户](account.md#找回账户)） |
| `api_key.*` | AccessKey 创建（`api_key.create`）、修改名称与每分钟请求数（`api_key.update`）、吊销（`api_key.revoke`） |
| `service_account.*` | 服务账号与其 key |
| `cluster.*`、`node_group.*`、`region.*`、`node.*`、`enrollment_token.*` | 集群（含配置金丝雀、回滚、挑战密钥与会话票据密钥轮换、监听端口、访客 IP、未知域名、缓存区、端口池 `cluster.port_pools_update`、连接限制 `cluster.connection_limits_update`）、节点组、区域、节点（含注册、证书续期、升级、调度地址 `node.set_addresses`、兼任探针 `node.set_probe`、拉取 Debug 日志 `node.debug_logs_pull`）、安装命令 |
| `probe.*` | 探针令牌（`probe.token_create`）、注册（`probe.enroll`）与证书续期（`probe.certificate_renew`，操作者为 **探针**）、改名与启停（`probe.update`）、删除（`probe.delete`） |
| `scheduling.*` | 调度规则的增删改（`scheduling.rule_create`、`scheduling.rule_update`、`scheduling.rule_delete`）；规则动作的生效与恢复（`scheduling.activate`、`scheduling.recover`，操作者为 **系统**） |
| `greylist.*` | 灰名单：`greylist.create`、`greylist.update`、`greylist.delete` |
| `origin_ca.*`、`origin_certificate.*`、`origin_client_ca.*`、`origin_client_certificate.*` | [源站保护](https.md#源站保护)：Origin CA 与其证书、回源客户端 CA 与证书的创建、轮换、签发、吊销与停用 |
| `site_tag.*` | 网站标签改名（`site_tag.rename`）与删除（`site_tag.delete`） |
| `acme_account.*` | 删除 ACME 账户（`acme_account.delete`） |
| `l4.*` | L4 应用的 CNAME 前缀（`l4.cname_update`） |
| `l4_app.*` | L4 应用：`l4_app.create`、`l4_app.update`、`l4_app.enable`、`l4_app.disable`、`l4_app.delete` |
| `site.*`、`cache.*`、`certificate.*`、`dns_credential.*`、`ip_list.*`、`platform.*` | 网站（含启停、HTTPS、日志、防护、OWASP CRS 与网站规则）、刷新预热、证书、DNS 凭据、IP 名单、全局规则 |
| `ban.*` | 手动封禁：`ban.create`、`ban.update`（再次封禁）、`ban.delete`（解封） |
| `dns.*`、`alert.*` | DNS 调度（含服务商账号、集群绑定、回滚、大面积摘除保护与强制发布）、告警渠道、告警规则、SMTP、告警订阅 |

## 防护设置

页面：**防护设置**（`/protection`），在侧边栏 **访问控制** 下。卡片按页面顺序：防护、封禁、CC 模板、连接限制、GeoIP 数据库。

### 防护

| 字段 | 取值 | 默认值 | 说明 |
| --- | --- | --- | --- |
| **全局 Under Attack** | 开 / 关 | 关 | 所有网站没有通行凭证的 GET/HEAD 请求先挑战；切换前需确认 |
| **挑战类型** | Cookie 跳转 / JS 计算 / 非交互式挑战 / 托管挑战 / 交互式挑战 | JS 计算 | 全局 Under Attack 的挑战类型 |
| **交互式挑战** | 内置图片验证码或第三方服务商与密钥 | 内置图片验证码 | 跟随全局的网站使用的验证码，见[验证码服务商](challenges.md#验证码服务商) |
| **安全事件保留天数** | 7–365 | 30 | 节点上报的 CC 防护事件保留时间 |

开关变化，或开启时更换挑战类型，所有集群各发布一个配置版本。修改写审计 `system.protection_update`。全局 Under Attack 需要节点能力 `challenge-v1`，缺少该能力的节点继续使用原配置，见 [配置版本](clusters.md#配置版本)。网站自己的 Under Attack 与 CC 防护见 [挑战与 CC 防护](challenges.md)。

### 封禁

| 字段 | 取值 | 默认值 | 说明 |
| --- | --- | --- | --- |
| **手动封禁上限** | 100–100000 | 10000 | 有效的手动封禁总数，网站封禁与全局封禁合计；超出返回 `BAN_PLATFORM_LIMIT` |
| **集群内共享自动封禁** | 开 / 关 | 开 | 节点产生的自动封禁是否下发到同集群的其他节点；关闭时只保存供查看 |

修改写审计 `system.bans_update`。见 [封禁](bans.md)。

### CC 模板

网站开启 CC 防护并 **跟随默认模板** 时使用的阈值：最高级别、验证码级别改用高难度计算验证、窗口、网站 QPS、单 URL QPS、单 IP QPS、IP 封禁时长、源站错误率、最小回源请求数、升级前持续、降级前冷却。「预设」选择宽松、标准或严格，或选择「自定义」逐项填写；字段、范围、默认值与各预设的取值见 [CC 防护](challenges.md#cc-防护)。保存后，有网站跟随模板的集群各发布一个配置版本；修改写审计 `system.cc_template_update`。

### 连接限制

按集群在节点内核中限制每个客户端（IPv4 地址或 IPv6 /64）的 TCP 连接，随配置版本下发。

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| **集群** | 集群 | 有多个集群时显示 |
| **启用** | 开 / 关 | — |
| **每 IP 并发连接** | 0–100000 | 0 为不限 |
| **每 IP 每秒新建连接** | 0–100000 | 0 为不限 |
| **突发** | 0–1000000 | 允许一次超出速率的新建连接数；0 取每秒新建连接的值；不能小于每秒新建连接 |
| **端口** | **集群监听端口** / **指定端口** | 集群监听端口含集群的 HTTP / HTTPS 监听与 TCP L4 应用端口；指定端口时填写 **端口列表**，1–64 个端口或端口段 |

启用时至少设置一项限制（「至少设置一项限制」）。卡片显示 **生效端口** 与「N / M 个节点已生效」；未生效的节点与「节点版本过低」（缺少 `conn-limit-v1`）逐条列出。修改写审计 `cluster.connection_limits_update`，配置版本原因「修改连接限制」。行为与节点要求见 [连接数限制](bans.md#连接数限制)。

### GeoIP 数据库

只读。逐个节点显示 **国家**、**省份** 与 **ASN** 数据状态（**可用** / **未配置**），并带 IPinfo 署名链接。国家和 ASN 数据随节点发布镜像内置，其余数据库由各节点本机配置；**配置数据库** 链接到 [规则、IP 名单与 GeoIP](rules.md)。

## 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| **服务账号名称已存在：…** | 名称重复 | 更换名称 |
| **服务账号不能调用此接口** | 服务账号调用了 [服务账号](#服务账号) 表之外的过程 | 改用 AccessKey |
| **缺少权限范围：…** | 服务账号缺少该过程需要的 scope | 在 **系统设置** 的 **服务账号** 页签编辑其 **权限范围** |
| **发布源须使用 HTTPS 并解析到允许的地址** | 公网 HTTP 地址，或解析到未放行的内网地址 | 使用 HTTPS，或在 `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` 放行 |
