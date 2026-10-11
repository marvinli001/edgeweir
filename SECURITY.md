# 安全策略

`edgeweir` 与 `edgeweir-node` 的漏洞报告、支持版本、信任基线、威胁控制与发布物验证。

English: [summary](#english) · [full policy](SECURITY.en.md)

## 范围

| 对象 | 位置 |
| --- | --- |
| 控制台源码 | [marvinli001/edgeweir](https://github.com/marvinli001/edgeweir) |
| 节点源码 | [marvinli001/edgeweir-node](https://github.com/marvinli001/edgeweir-node) |
| 控制台镜像 | `ghcr.io/marvinli001/edgeweir` |
| 节点发布物 | [edgeweir-node Releases](https://github.com/marvinli001/edgeweir-node/releases) |

## 报告漏洞

> [!WARNING]
> 不要通过公开 issue、讨论区或 PR 报告安全漏洞。

| 渠道 | 地址 |
| --- | --- |
| GitHub 私密安全公告（控制台） | <https://github.com/marvinli001/edgeweir/security/advisories/new> |
| GitHub 私密安全公告（节点） | <https://github.com/marvinli001/edgeweir-node/security/advisories/new> |

报告内容：

| 项 | 内容 |
| --- | --- |
| 组件与版本 | 受影响的组件；镜像版本、发布版本或提交哈希 |
| 复现 | 复现步骤或概念验证代码 |
| 影响 | 可达成的效果与所需前提条件 |
| 公开状态 | 是否已公开，是否已知被利用 |

处理流程：

1. 3 个工作日内确认收到报告。
2. 完成评估后告知初步结论与修复计划，处理期间同步进展。
3. 协调披露期为 90 天，从收到报告之日起算。修复发布后公开安全公告；经报告者同意，在公告中致谢。
4. 90 天内无法修复时，与报告者协商延期；漏洞已被在野利用时，可提前披露缓解措施。

## 支持的版本

| 组件 | 支持 | 不支持 |
| --- | --- | --- |
| 控制台 | 当前 `stable` 渠道的日期 tag（`<YYYYMMDD>-<commit>`）；`master` 最新提交的镜像（`latest`） | 更早的日期 tag |
| edgeweir-node | 最新发布的 1.x 版本；`master` 最新代码 | 更早的 1.x 补丁版本、0.x 版本 |

安全修复只进入 `master`，不回移到旧版本，也没有维护分支：控制台的修复随下一个日期 tag 发布并移动 `stable`，节点的修复随下一个补丁版本发布。`stable` 控制台支持 edgeweir-node 1.x 的全部次版本；0.x 节点继续工作，只能使用其上报的能力，控制台提示升级。

## 信任基线

以下规则是 `edgeweir` 与 `edgeweir-node` 全部代码的硬性约束。

| 规则 | 内容 |
| --- | --- |
| 无 phone-home | 控制台与节点不主动连接 Edgeweir 项目的任何服务器（edgeweir.com、edgeweir.dev 等），版本检查也不例外 |
| 无授权校验 | 代码中没有许可证密钥、联网授权或功能锁 |
| 遥测默认关闭 | 不发送任何遥测数据，也没有遥测开关；遥测只能由运营者显式开启，开启前列出将要发送的字段和目的地址；better-auth 自带的遥测强制关闭 |
| 敏感数据信封加密 | 私钥与第三方凭据经主密钥 `EDGEWEIR_MASTER_KEY` 信封加密后入库；只需比对的秘密只存哈希（见 [敏感数据](#敏感数据)） |
| 绝不保存 SSH 凭据 | 控制台没有保存 SSH 凭据的选项；节点只经控制台生成的一次性安装命令接入，由节点主动注册 |
| 管理操作写审计 | 见 [审计日志](#审计日志) |
| 发布物可验证 | cosign keyless 签名、SBOM、SLSA provenance（见 [验证发布物](#验证发布物)） |

独立商业产品（见 [LICENSING.md](LICENSING.md)）可在管理员主动启用后按明示条款使用授权与云服务，但不得向开源核心加入商业功能锁，不得因官方许可证失效或授权服务故障中断已有 CDN 流量。

## 敏感数据

### 信封加密

| 项 | 值 |
| --- | --- |
| 主密钥 | `EDGEWEIR_MASTER_KEY`：至少 32 字节随机数的 base64（`openssl rand -base64 32`），不入库 |
| 主密钥格式 | 规范的 base64（标准或 URL 安全字母表）；含空格、引号或多余字符时拒绝启动，不会按另一个密钥解码 |
| 主密钥标识 | 信封记录密钥标识 `kid`（原始主密钥 SHA-256 的前 16 个十六进制字符），按它选择解密的主密钥；启动时内部 CA 私钥信封的 `kid` 须为当前主密钥或 `EDGEWEIR_MASTER_KEY_PREVIOUS` 的标识，否则报主密钥与数据库不匹配并拒绝启动，再检查会话 secret |
| 主密钥轮换 | `EDGEWEIR_MASTER_KEY_PREVIOUS`（轮换前的主密钥）只用于解密。启动时在 advisory lock 下把它加密的全部入库信封解开，用当前主密钥和新的数据密钥重新加密，绑定不变，并在日志中记录仍使用它的信封数；节点保存的 revision 回执在它设置期间仍可验证。步骤见[轮换主密钥](docs/deploy/docker.md#轮换主密钥) |
| 密钥加密密钥 | HKDF-SHA256，salt `edgeweir/kek/v1`，info `envelope`，32 字节 |
| 数据密钥 | 每条记录随机生成；数据与数据密钥均用 AES-256-GCM 加密 |
| 附加认证数据 | `edgeweir/envelope/v2`、`<表>.<字段>`、`<记录 id>` 三段；密文移到其他行或字段后无法解密 |
| 格式版本 | v2；旧版本写入的 v1 密文（只绑定用途）在控制台启动时重新加密，读取路径拒绝 v1 |
| 复制设置与克隆 | 访问鉴权的密码哈希与签名密钥、PURGE 密钥、S3 源站密钥只在控制台内存中解密，为目标网站的新记录重新加密（绑定新的记录 id）；预览、结果与审计记录都不含密钥 |

### 存储方式

| 数据 | 存储 | 位置 |
| --- | --- | --- |
| 内部 CA 私钥 | 信封加密 | `pki_authority.private_key_envelope` |
| 证书私钥 | 信封加密 | `certificate.private_key_envelope` |
| ACME 账户 | 信封加密 | `acme_account.account_envelope`；申请时的 EAB 密钥在 `certificate.account_envelope` |
| ACME DNS-01 凭据 | 信封加密 | `dns_credential.credential_envelope` |
| DNS 调度服务商凭据 | 信封加密 | `platform_dns_provider.credential_envelope` |
| S3 源站密钥 | 信封加密 | `origin_credential.secret_envelope` |
| 网站 PURGE 密钥 | 信封加密 | `site_secret.secret_envelope` |
| 访问鉴权的 Basic 密码与签名 URL 密钥 | Basic 密码只存 PBKDF2-HMAC-SHA256 加盐哈希（10000 次迭代）；哈希与签名密钥一起信封加密 | `site_auth_rule.secret_envelope` |
| 告警渠道配置（webhook 地址与 Bearer token、邮件收件人） | 信封加密 | `alert_channel.config_envelope` |
| SMTP 设置（含密码） | 信封加密 | `system_setting` 的 `notification_smtp` |
| setup token | 信封加密；另存 SHA-256 用于比对 | `system_setting` 的 `setup_token` |
| 挑战页签名密钥 | 信封加密 | `challenge_key.secret` |
| TLS 会话票据密钥 | 信封加密 | `session_ticket_key.secret` |
| 自定义 ACME 目录的 EAB HMAC 密钥 | 信封加密 | `system_setting` 的 `acme_directory` |
| 节点注册 token | SHA-256 | `enrollment_token` |
| 探针注册 token | SHA-256 | `probe_token` |
| AccessKey | 哈希（better-auth） | `apikey` |
| 用户密码 | scrypt 哈希（better-auth） | `account` |
| TOTP 密钥与备用码 | 以会话 secret 加密（better-auth） | `two_factor` |
| 会话 secret | 不入库，只存 HMAC-SHA256 校验值；轮换主密钥后，由旧主密钥派生的值信封加密入库 | `system_setting` 的 `auth_secret_check`、`auth_secret` |
| 主密钥 | 不入库 | 环境变量 `EDGEWEIR_MASTER_KEY`，或 `EDGEWEIR_MASTER_KEY_FILE` 指定的文件；轮换期间另有 `EDGEWEIR_MASTER_KEY_PREVIOUS` |

### 会话 secret

better-auth 的会话 secret 用于签名会话 cookie，并加密 TOTP 密钥与备用码。

| 情况 | 行为 |
| --- | --- |
| 设置了 `BETTER_AUTH_SECRET`（至少 32 个字符） | 使用该值 |
| 未设置 `BETTER_AUTH_SECRET` | 由主密钥经 HKDF-SHA256 派生：salt `edgeweir/auth-secret/v1`，info `better-auth.secret`，32 字节，base64url 编码；与信封加密的密钥加密密钥（salt `edgeweir/kek/v1`，info `envelope`）相互独立 |
| 轮换主密钥，数据库此前使用旧主密钥派生的值 | 继续使用该值：设置 `EDGEWEIR_MASTER_KEY_PREVIOUS` 后首次启动时，用当前主密钥信封加密存入 `system_setting` 的 `auth_secret`，此后（包括移除 `EDGEWEIR_MASTER_KEY_PREVIOUS` 后）从这里读取；会话与两步验证不受影响 |
| 派生值与数据库此前使用的 secret 不一致（例如已有部署删除了 `BETTER_AUTH_SECRET`） | 控制台拒绝启动 |
| 显式设置的值发生变化 | 控制台启动并记录警告；现有会话失效，已启用的两步验证密钥无法再读取 |

## 审计日志

| 项 | 行为 |
| --- | --- |
| 范围 | 经 `/rpc` 与 `/api/v1` 的写操作；初始化；安装命令生成；节点注册、证书轮换与删除；探针令牌生成、注册、证书续期与删除；智能调度动作的生效与恢复（系统身份）；登录成功与失败、改密码、两步验证开关、passkey 增删、API key 创建与删除；在服务器上找回账户 |
| 事务 | Edgeweir 自己的写操作与审计记录在同一事务内提交；经 better-auth 完成的登录与账号变更由 better-auth 先提交，审计紧接着写入 |
| 内容 | 不记录密码、token 或密钥明文 |
| 来源 IP | TCP 对端地址；`X-Forwarded-For` 与 `X-Real-IP` 只在对端属于 `EDGEWEIR_TRUSTED_PROXIES` 时采用 |
| 修改 | 应用层只提供查询接口，不提供修改或删除接口 |

## 威胁与控制

| 控制 | 防范 |
| --- | --- |
| 控制台绝不保存 SSH 凭据；节点只经一次性安装命令接入，由节点主动注册 | 控制台失陷后借 SSH 凭据控制所有节点 |
| 节点私钥在节点本地生成，不离开节点；控制台只签发证书 | 控制台数据库泄露后冒充节点 |
| 安装命令固定 CA 指纹，节点先核对指纹再发送 token；token 一次性、有过期时间、只存 SHA-256 | 首次连接被中间人劫持；token 泄露或重放 |
| 除 `Enroll` 外强制 mTLS，客户端证书序列号须等于库中记录的当前值（续期后、节点首次使用新证书前也接受被替换的那一张）；证书 30 天有效并自动轮换；停用或删除节点立即生效（停用的节点只能续期证书），删除时吊销两张证书的序列号 | 已下线节点继续拉取配置 |
| 区域探针的证书由同一内部 CA 签发（`O=Edgeweir Probe`），节点通道按证书的组织区分：探针证书只能调用 `ProbeService`，节点证书不能注册或续期探针，只有兼任探针的启用节点能上报结果；探针令牌一次性、有过期时间、只存 SHA-256；停用的探针只能续期证书，删除探针时吊销其证书 | 探针凭据泄露后冒充节点拉取配置与密钥 |
| 探针结果只接受探测方当前的目标（节点、地址、端口）与有效范围内的数值；地址按全部探测方的严格多数判为不可达；调度规则的摘除受大面积摘除保护约束 | 单个故障或失陷的探针让节点离开 DNS |
| 节点通道在读取请求体之前检查客户端证书，未带证书只受理 `Enroll`、`EnrollProbe`，请求不超过 64 KiB；其余请求解压后不超过 16 MiB；连续 2 分钟没有流量的连接被关闭 | 未认证的客户端用压缩请求或空闲连接耗尽控制台内存 |
| 证书私钥、S3 源站密钥与 PURGE 密钥只经 mTLS 通道发给服务引用网站的集群节点，不写入 NodeConfig | 其他集群的节点或配置快照泄露密钥 |
| PURGE 密钥只在节点 agent 内：数据面把 `PURGE` 请求的 URL 与 `X-Purge-Key` 经本机 unix socket（0600）交给 agent，agent 以常数时间比较；每个节点上每个网站每个客户端网络（IPv6 按 /64，计数器在单独的共享内存中）每秒 20 次、密钥正确的请求每个网站每秒 20 次（没有密钥的客户端只能用完自己的额度），控制台在插入任务的事务中按网站加锁计数，每个网站每分钟至多 120 个任务；控制台只为节点所在集群服务、开启了 PURGE 且 Host 属于该网站的 URL 创建任务 | 密钥进入 nginx 共享内存或日志；用 PURGE 猜测密钥或刷爆缓存；节点替其他集群或网站刷新 |
| 缓存带 `Set-Cookie` 的响应时，源站层把 Cookie 移到内部头，边缘层对所有带缓存的 location 静态隐藏该头，只在本次请求确实回源（`MISS`、`EXPIRED`、`BYPASS`）时还原给该请求；命中、过期副本与后台更新的响应从不带 Cookie | 缓存把一个访客的会话 Cookie 发给其他访客 |
| revision 回执由主密钥封装并绑定节点；节点报告高于控制台最新 revision 的版本时必须附有效回执，只有经验证的版本参与 revision 序号计算 | 数据库从备份恢复后，未经认证的上报操纵 revision 序号 |
| 敏感数据信封加密，主密钥不入库；附加认证数据绑定表、字段与记录 id | 数据库备份或只读 SQL 注入泄露私钥与凭据；有库写权限者在行之间互换密文 |
| 管理操作写审计，与变更同事务提交 | 越权或误操作无法追溯 |
| `/api/auth/*` 只放行控制台界面用到的 better-auth 端点（不含注册、admin 与 api-key 端点），其余 404；AccessKey 只能由已登录的会话经 `accessKeys.*` 创建与吊销；`x-api-key` 在 `/api/auth/*` 与 `/rpc` 上被丢弃，只在 `/api/v1` 生效 | 借 better-auth 插件端点绕过审计与配置版本（创建账户、冒充用户、改密码）；API key 变成会话或签发新 key |
| `/rpc` 要求 `x-csrf-token` 头；响应带 CSP `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'` | 跨站请求伪造；页面被嵌入第三方站点 |
| 客户端 IP 取 TCP 对端地址，转发头只信任 `EDGEWEIR_TRUSTED_PROXIES`；登录与两步验证的限速计数存 PostgreSQL，多实例共享，重启不清零 | 伪造 IP 绕过登录与两步验证限速；审计日志中的 IP 失真 |
| `install.sh` 与 agent 自升级先校验 cosign 签名（证书身份精确匹配待安装版本的 release 工作流）与 SHA-256，再执行；控制台 `/downloads` 镜像（`EDGEWEIR_DOWNLOADS_DIR`）只是传输通道，未镜像的文件返回 404 | 下载链路或镜像被篡改 |
| 源站不能是特殊用途地址（回环、链路本地、私网、CGNAT、组播等）或 `localhost`：控制台拒绝这类 IP 字面量，节点对配置和每个 DNS 解析结果执行同一清单（`packages/contract/src/addresses.ts`）；只有经审计的源站地址允许清单能放行地址段；节点回源请求带 `CDN-Loop`（RFC 8586），收到带自身标识的请求返回 508 | 借回源访问云元数据（`169.254.169.254`）、探测内网，或造成回环 |
| 控制台向 Web 界面保存的目标（告警 webhook、SMTP 服务器、节点发布源、节点通道地址的连接检查）发起的请求先解析一次、拒绝特殊用途地址，再连接该地址；`EDGEWEIR_OUTBOUND_ALLOW_CIDRS` 放行指定地址段 | 借控制台的出站请求访问内网 |
| 填写地址的 DNS 服务商（PowerDNS、RFC 2136、自定义 HTTP）由证书助手在连接建立时检查实际连接的地址，特殊用途地址只在 `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` 内放行；公网地址必须使用 HTTPS，不跟随重定向。自定义 HTTP 请求带时间戳与 HMAC-SHA256 签名；DNS 服务商的错误以分类码返回，不回传服务商原文 | 借 DNS 服务商配置访问内网（含 DNS 重绑定），或凭据经明文或错误信息泄露 |
| 正则域名只用规则引擎的正则子集（不含反向引用、环视），最长 256 字符、每个网站最多 10 条，形状受限：最多两个可重复的量词（固定次数的 `{n}` 不算），各组的选项与可选部分相乘最多 16，`{n,m}` 之外没有逗号。控制台（刷新与预热按 Host 找网站）开启 V8 的 `--enable-experimental-regexp-engine-on-excessive-backtracks`（`apps/console/src/server/lib/regexp-engine.ts`），回溯过多的匹配改由 V8 的线性引擎完成；节点上 Go 的匹配器（RE2）是线性的，nginx 的 `server_name` 不另设 PCRE 上限，靠形状限制约束，且不匹配超过 253 字符的 Host（正则名以 `(?!.{254})` 开头），Lua 的匹配带 PCRE 上限 `LIMIT_MATCH=1000000`；各处都区分大小写，节点渲染进 `server_name` 前拒绝引号、转义的反斜杠与空白 | 运营者写下的正则拖慢每个请求或控制台，或注入 nginx 配置 |
| 国际化域名按 UTS #46（含双向文字与连接符检查）转换后保存；界面只把单一文字（或拉丁字母与汉字、假名、注音、谚文组合）的标签显示为 Unicode，混用文字或含不可见字符的标签保持 Punycode，悬停显示 Punycode | 外观相同的同形字域名被误认（整个标签由另一种文字写成的仿冒名称仍显示为 Unicode，见已知限制） |
| 只有交给默认网站的请求跳过「SNI 须与 Host 一致」；默认网站须为本集群已启用的网站 | 借未知 SNI 的握手访问其他网站 |
| 每个网站有自己的 TLS 会话上下文，会话只在创建它的网站复用；票据密钥按集群、每 12 小时轮换，只经 mTLS 通道发给本集群的节点，不写入 NodeConfig；不接受 TLS 1.3 early data | 用一个网站的会话恢复到另一个网站（跳过后者的客户端证书要求）；0-RTT 数据被重放；其他集群的节点解开票据 |
| 访问鉴权的 Basic 密码哈希与签名 URL 密钥只经 mTLS 通道发给服务该网站的集群节点，不写入配置版本、快照、审计与 API 响应（界面只写不读）；Basic 用常数时间比较派生结果，未知用户同样计算一次哈希，每个网站每个客户端网络 10 秒内至多 10 次失败校验；签名用主、备两把密钥都计算并常数时间比较；鉴权在缓存查找之前，缓存命中同样鉴权；明文 HTTP 请求在鉴权前按网站的强制 HTTPS 跳转 | 密码或密钥经配置、审计或日志泄露；按用户名是否存在或比较时长猜测凭据；在线暴力猜测 Basic 密码；绕过鉴权直接取缓存；凭据经明文发送 |
| 转发鉴权的子请求经回源层发出，遵守源站地址策略与 TLS 校验，只发送转发列表中的请求头与节点设置的 `X-Original-*`、`X-Real-IP`、`X-Forwarded-For`；复制到回源的响应头没有出现在鉴权应答中时从回源请求删除 | 用鉴权地址探测内网；访客的其他请求头（含 Cookie 以外的凭据）流向鉴权服务；访客自带 `X-Auth-User` 冒充已认证用户 |
| 「必须」客户端证书的网站在网站逻辑之前拒绝没有通过验证的证书的请求，明文 HTTP 同样拒绝（开启强制 HTTPS 时跳转）；访客自带的 `X-Client-Verify`、`X-Client-Cert-*` 请求头在所有网站删除，源站收到的值只来自节点 | 绕过双向 TLS；伪造客户端证书信息骗过信任这些头的源站 |
| 访问日志默认不记录查询字符串、请求头、Cookie 与正文，Referer 去掉查询字符串与片段；查询字符串、指定请求头（不能选 `Authorization`、`Cookie`、`Proxy-Authorization`）与直连对端地址只在网站开启后记录，关闭后控制台不再保存；保留期可缩短到 1 天；`edgeweir-node accesslog` 只在有人查看时采集、只经控制套接字读取，不进入上报队列，节点不写本地日志文件 | 访问日志泄露令牌、凭据或过多个人数据；实时查看在没人查看时持续收集请求 |
| 节点端清缓存标记超过上限时合并为站点级标记 | 大量刷新任务填满节点的清缓存存储，影响同节点其他网站 |
| 图片格式转换在 agent 的子进程中进行：纯 Go（WebAssembly 转写）的编码器与标准库解码器，内存越界是 panic 而不是内存破坏；子进程只有 `GOMAXPROCS=1`、`RLIMIT_DATA`（已有数据段之外，估算内存加 256 MiB）、不能写文件、最多 16 个描述符、能力集清空、没有环境变量，超时即杀，随 agent 退出；同时进行的转换数与估算内存总量有上限，超出的图片返回原图；`image.sock` 只有 nginx 的用户能连接，只转发到 agent 渲染的回源层 | 访客可影响的源站图片借解码器漏洞控制节点；大图或大量图片耗尽节点的 CPU 与内存 |
| agent 只执行类型化操作，没有执行任意命令的接口 | 控制台失陷后在节点上执行任意代码 |
| 发布物 keyless 签名、SBOM、SLSA provenance | 发布的程序与源码不一致，或被投毒 |

## 已知限制

| 限制 | 影响与处理 |
| --- | --- |
| `install.sh` 由控制台提供 | 信任控制台（运营者自己的服务器）是前提；需要更强保证时，先下载脚本审阅，或与 GitHub 上同版本的脚本比对 |
| 控制台被攻破 | 攻击者可以下发恶意配置（例如把网站指向恶意源站），但不能让节点运行未签名的程序，也拿不到节点私钥 |
| 转发鉴权 | 开启结果缓存时，应答按转发的请求头缓存，不区分路径与访客地址；开启「服务不可用时放行」时，鉴权服务出错期间请求不经鉴权放行。鉴权服务按路径或地址决定时不要开启缓存，受保护内容不要开启放行 |
| Basic 认证 | 凭据随每个请求发送，只在 HTTPS 下安全：开启网站的强制 HTTPS；同一出口地址后的多个访客共享失败限速（10 秒内 10 次） |
| 防盗链与 UA 名单 | 依据访客自己发送的 `Referer`、`Origin` 与 `User-Agent`，非浏览器客户端可以伪造；它们挡住的是其他网站的嵌入与常见爬虫，不是访问控制的边界，需要保护的内容用访问鉴权 |
| 地区访问控制 | 精度取决于节点的 GeoIP 数据库；代理、VPN 与地址数据过时都会让判断失准，GeoIP 服务不可用时生效范围内的请求返回 503 |
| CORS | 「允许凭据」时任一允许的来源（含 `*.a.com` 覆盖的子域名）都能带着访客的 Cookie 读取响应；只列出完全受信的来源。CORS 只约束浏览器，不阻止直接请求 |
| 本站放行名单 | 名单中的地址跳过该网站的封禁、拦截名单、地区、防盗链、UA 名单与挑战；名单条目被改动时所有选用它的网站一起生效 |
| 规则读取请求体 | 只读取 `Content-Length` 不超过网站「规则检查请求体上限」（最大 1 MiB）的请求；分块编码、没有 `Content-Length` 的 HTTP/2 与 HTTP/3 请求、超过上限的请求都标为截断、不读取，规则读到空值。依据请求体字段拦截时同时判断 `http.request.body.truncated`，否则攻击者把载荷放进这类请求即可绕过。表单、multipart 与 JSON 的解析与源站框架可能不同（JSON 重复的键取最后一个，multipart 遇到格式错误即停止），请求体检查不能代替源站自己的校验 |
| 规则封禁 | 「封禁」动作与限速的「超额后封禁」按规则写入自动封禁（来源「规则」），条件写得过宽会封掉正常访客；前缀与时长有上限，封禁列表中可随时解除 |
| 已验证的搜索引擎爬虫 | 节点按访客地址做反向解析与正向确认，结果取决于节点解析器的应答；解析器被劫持或不可信时可能放过伪造的爬虫。开启后通过校验的爬虫跳过 Under Attack 与 CC 挑战，挑战规则、封禁与其他检查照常 |
| CRS 按路径 | 按客户端请求的规范化路径判断排除与覆盖；排除的规则对该路径完全失效，范围越宽风险越大，优先用精确路径或排除目标 |
| 节点本地凭据 | 节点在状态目录（默认 `/var/lib/edgeweir-node`，权限 0700）以 0600 权限明文保存节点私钥、S3 源站密钥、PURGE 密钥与访问鉴权的 Basic 密码哈希和签名密钥（`credentials.json`）与网站证书私钥（`certificates.json`），控制台不可达时节点重启后仍能服务；拿到节点 root 权限者可以读取 |
| 主密钥与数据库同时泄露 | 信封加密失效；未设置 `BETTER_AUTH_SECRET` 时，泄露的主密钥还能伪造登录会话。经 `EDGEWEIR_MASTER_KEY_FILE` 从 secret 文件读取（[主密钥文件](docs/deploy/docker.md#主密钥文件)）或由编排平台的 secret 机制注入，不与数据库备份放在一起。主密钥泄露后[轮换](docs/deploy/docker.md#轮换主密钥)：轮换保留会话 secret，未设置 `BETTER_AUTH_SECRET` 的部署另设一个新值（全部会话失效，两步验证需重新启用）；数据库也泄露时，更换其中的凭据 |
| setup token 写入日志 | 首次初始化需要控制台启动时写入日志的一次性 setup token；能读控制台日志者即可完成初始化。按主密钥的级别控制日志访问 |
| 在服务器上找回账户 | 能在控制台容器内执行命令者（本就能读取 `DATABASE_URL` 直接修改数据库）可以用 `recover.js` 重置账户密码、停用两步验证；找回让全部会话退出登录并写入审计日志（`account.recover`），Web 界面与 HTTP 没有找回入口（[命令行](docs/reference/cli.md#找回账户)）。按主密钥的级别控制服务器访问 |
| 探针本地凭据 | 探针在状态目录（默认 `/var/lib/edgeweir-probe`，权限 0700）以 0600 权限明文保存探针私钥；拿到探针主机 root 权限者可以冒充该探针上报结果，直到探针在控制台被删除 |
| 健康端点 | 节点在每个边缘监听上对任意 Host 应答 `GET /.edgeweir/health`，HTTPS 对 SNI `health.edgeweir.invalid` 或无 SNI 的握手出示节点自生成的自签名证书，扫描者能据此识别 Edgeweir 节点；探针不校验该证书，探测路径上的中间人可以伪造可达结果，影响调度但接触不到机密 |
| TLS 会话票据密钥 | 节点在状态目录以 0600 权限明文保存本集群的票据密钥（`session-ticket-keys.json` 与 nginx 读取的密钥文件）；拿到节点 root 权限者可以解开密钥有效期内（最长约 36 小时）以票据恢复的会话。轮换后旧密钥从节点删除 |
| 客户端证书 | 节点不检查客户端证书的吊销（CRL、OCSP）：吊销的客户端证书在到期前仍能通过；需要立即撤销时更换网站的 CA 证书。客户端证书不能与 HTTP/3 同时开启 |
| 自定义 ACME 目录 | 运营者在系统设置中保存的 ACME 目录不受 `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` 限制（私有 CA 常在内网）：控制台保存时读取该地址（只读 10 秒、最多 1 MiB，不跟随跳转），证书助手签发时连接它。只有能修改系统设置的运营者能设置它 |
| 节点通道 `:8443` | 只能直接暴露或四层透传；反向代理终结 TLS 会使 mTLS 失效（[端口、反向代理与可信代理](docs/deploy/networking.md)） |
| 节点通道的 WebSocket 入口 | Web 端口的 `/node-channel` 把 WebSocket 接到节点通道，握手本身不认证；节点通道的 TLS 在 WebSocket 内运行，CA 指纹固定、token 与 mTLS 校验与 `:8443` 相同，前面的代理只转发 TLS 记录。默认关闭，`EDGEWEIR_NODE_API_WEBSOCKET=true` 或使用过 `wss://`、`ws://` 节点通道地址后开放；开放后与 `:8443` 一样从公网可达，拒绝带 `Origin` 头的浏览器请求（[节点通道的 WebSocket 入口](docs/deploy/networking.md#节点通道的-websocket-入口)） |
| 四层转发 | L4 应用的流量不经过 HTTP 层：WAF、规则、挑战、CC 防护、网站封禁与全局「拦截」「放行」名单都不作用于它，只有应用自己的 IP 名单、每节点连接上限与内核封禁（`kernel-ban-v1`）。端口只来自集群的端口池（1024–65535），节点不需要额外权限。开启「接受 PROXY protocol」时客户端地址取自头部：该端口只应对负载均衡器开放，否则任何客户端都能声明别的地址绕过放行名单（[四层转发](docs/guide/l4.md)） |
| gRPC 不经过 OWASP CRS | 网站打开「gRPC」后，`Content-Type` 为 `application/grpc` 的请求不经过 CRS（ModSecurity 读完整个请求体才转发，流式调用无法完成）；客户端可以自行设置该类型，同一网站的其他接口也能借此绕过 CRS。封禁、规则、限速与人机验证照常生效。只在源站的 gRPC 接口与其他接口分开（或另设网站）时打开（[HTTP/2 与 gRPC](docs/guide/origins-and-cache.md#http2-与-grpc)） |
| 节点的访客 IP 来源 | 默认取 TCP 对端，不信任任何请求头。集群选择「PROXY protocol」时，能直接连到节点 HTTP / HTTPS 端口的客户端可以在 PROXY 头中声明任意地址，这些端口只应对负载均衡器开放；选择「可信代理报头」时只有可信 CIDR 内的对端能指定访客地址，可信 CIDR 只写代理实际使用的地址。两种模式下内核封禁只匹配 TCP 对端（[访客 IP](docs/deploy/nodes.md#访客-ip)） |
| 缓存带 Set-Cookie 的响应 | 缓存规则打开「缓存带 Set-Cookie 的响应」后，节点磁盘上的缓存对象保存着回源时的 `Set-Cookie`（只还原给那一次请求）；拿到节点磁盘者可以读取这些 Cookie。只对正文与访客无关的内容打开（[Set-Cookie](docs/guide/origins-and-cache.md#set-cookie)） |
| 扫描防护 | 按访客 IP（经集群选定的可信机制）计数，触发后在全部网站封禁该地址；放行名单与本集群的可信代理不计数，节点的内核封禁不丢弃本集群的可信代理，覆盖其他集群可信代理或节点地址的封禁不分发到其他节点。节点前的负载均衡没有对应的访客 IP 设置（PROXY protocol 或可信代理报头）时，计数与封禁的是负载均衡器的地址。访客 IP 来自 PROXY protocol 或可信报头时，伪造来源地址需要能连到节点的负载均衡或可信代理；误封的地址在「封禁」中解除 |
| 同形字域名 | 界面只把混用文字或含不可见字符的标签保持为 Punycode；整个标签由另一种文字写成的仿冒名称（例如全部用西里尔字母写的 `аррӏе.com`）仍显示为 Unicode。核对陌生的国际化域名时把鼠标悬停在名称上查看 Punycode |
| 报头值表达式 | 请求头、响应头与查询参数的值表达式可以把访客可控的内容（Cookie、查询参数、请求头）写进发往源站或访客的报头与跳转地址；节点只拒绝控制字符与超过 4096 字节的报头值（跳过该动作），不做其他转义。不要把访客可控的值写进会被当作指令解释的响应头（例如 `Content-Security-Policy`、`Link` 的预加载目标）；受保护头不能通过规则设置（[规则](docs/guide/rules.md#报头值与查询参数值)） |

## 验证发布物

所有签名均为 cosign keyless 签名：证书身份是对应仓库的 release 工作流，签发者是 GitHub Actions 的 OIDC 服务 `https://token.actions.githubusercontent.com`。

| 工具 | 用途 |
| --- | --- |
| [cosign](https://github.com/sigstore/cosign) | 验证签名 |
| [GitHub CLI](https://cli.github.com/) | 验证 provenance（`gh attestation verify`） |

### 节点包（deb、rpm、tar.gz）

1. 从 [edgeweir-node Releases](https://github.com/marvinli001/edgeweir-node/releases) 下载要安装的包、`checksums.txt` 与 `checksums.txt.sigstore.json`。
2. 验证 `checksums.txt` 由 edgeweir-node 的 release 工作流在 `v*` tag 上签名：

   ```bash
   cosign verify-blob \
     --bundle checksums.txt.sigstore.json \
     --certificate-identity-regexp '^https://github\.com/marvinli001/edgeweir-node/\.github/workflows/release\.yml@refs/tags/v.*$' \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com \
     checksums.txt
   ```

   预期输出：`Verified OK`。

3. 验证下载的包与 `checksums.txt` 一致（macOS 使用 `shasum -a 256 -c`）：

   ```bash
   sha256sum -c checksums.txt --ignore-missing
   ```

   预期输出：每个已下载的文件显示 `OK`。

4. 验证构建来源证明（可选）：

   ```bash
   gh attestation verify edgeweir-node_<版本>_linux_amd64.tar.gz --repo marvinli001/edgeweir-node
   ```

第 2、3 步都通过后再安装。`install.sh` 在执行任何下载的程序之前自动完成同样的校验，且更严格：证书身份必须精确等于 `https://github.com/marvinli001/edgeweir-node/.github/workflows/release.yml@refs/tags/v<版本>`；机器上没有 cosign 时，先下载 cosign v3.1.3 并核对脚本中固定的 SHA-256。注册 token 只经 `EDGEWEIR_TOKEN` 环境变量或 `--token-file` 传递，不出现在命令行参数中。

### 控制台镜像

控制台镜像没有语义化版本号：`master` 上通过 CI 的每个提交发布为 `<YYYYMMDD>-<提交前 7 位>`（例如 `20260929-a1b2c3d`），`latest` 只在该提交仍是 `master` 最新提交时移动；`stable` 由 promote 工作流指向某个日期 tag 的同一 digest，签名随 digest 有效。签名证书身份是 `master` 分支上的 release 工作流。`stable` 同样可以按下面的命令验证（把 tag 换成 `stable`）。

1. 验证签名：

   ```bash
   cosign verify ghcr.io/marvinli001/edgeweir:<YYYYMMDD>-<commit> \
     --certificate-identity https://github.com/marvinli001/edgeweir/.github/workflows/release.yml@refs/heads/master \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com
   ```

   预期结果：退出码为 0。

2. 验证构建来源证明：

   ```bash
   gh attestation verify oci://ghcr.io/marvinli001/edgeweir:<YYYYMMDD>-<commit> --repo marvinli001/edgeweir
   ```

3. 按 digest 固定镜像：`.env` 中写 `EDGEWEIR_VERSION=<YYYYMMDD>-<commit>@sha256:<digest>`，不只写 tag。升级与回滚见 [版本、升级与回滚](docs/deploy/upgrade.md)。

镜像标签 `org.opencontainers.image.revision` 是完整的提交 ID。

### 从源码重建

| 发布物 | 步骤 |
| --- | --- |
| 节点 | 检出发布对应的 tag，使用 `go.mod` 中固定的 Go 版本执行与 CI 相同的 goreleaser 构建；二进制的 SHA-256 应与发布物一致 |
| 控制台镜像 | 检出 `org.opencontainers.image.revision` 记录的提交；`scripts/image-version.sh` 输出同一版本号；按 release 工作流的参数构建（见下方命令） |

```bash
git checkout <commit>
SOURCE_DATE_EPOCH=$(git log -1 --pretty=%ct) docker buildx build \
  --build-arg VERSION=$(scripts/image-version.sh) \
  --build-arg REVISION=$(git rev-parse HEAD) \
  -t edgeweir:rebuild .
```

控制台 Dockerfile 的 `apk add tini` 取构建时 Alpine 软件源中的版本，镜像不保证逐字节一致。

---

<a id="english"></a>

## English

Full English policy: [SECURITY.en.md](SECURITY.en.md).

**Scope.** [marvinli001/edgeweir](https://github.com/marvinli001/edgeweir) (console), [marvinli001/edgeweir-node](https://github.com/marvinli001/edgeweir-node) (edge node), the console image `ghcr.io/marvinli001/edgeweir`, and edgeweir-node release artifacts. Separate commercial products may offer explicitly enabled licensing and cloud services under their own terms; an expired vendor license or a licensing outage must not gate core functionality or interrupt existing CDN traffic ([LICENSING.md](LICENSING.md)).

**Reporting a vulnerability.** Do not open a public issue, discussion, or pull request. Open a private GitHub security advisory ([console](https://github.com/marvinli001/edgeweir/security/advisories/new), [node](https://github.com/marvinli001/edgeweir-node/security/advisories/new)). Reports are acknowledged within 3 working days. Coordinated disclosure window: 90 days from the day the report is received; the advisory is published after the fix, with credit when the reporter agrees.

**Supported versions.** Console: the dated tag (`<YYYYMMDD>-<commit>`) of the current `stable` channel, and the image of the newest `master` commit (`latest`). Node: the latest 1.x release and the latest `master`. Security fixes land on `master` only and ship with the next dated tag moved to `stable` and the next node patch release; there are no maintenance branches. A `stable` console supports every 1.x node minor version; 0.x nodes keep working with the capabilities they report.

**Trust baseline.** No phone-home of any kind and no license-check code. Telemetry is off by default and requires explicit opt-in; the current version sends no telemetry, and better-auth's own telemetry is hard-disabled. The console never stores SSH credentials; nodes join only through the one-time install command. Private keys and third-party credentials (internal CA key, certificate keys, ACME accounts and EAB keys, TLS session ticket keys, DNS provider credentials, S3 origin keys, site PURGE keys, Basic password hashes and signed URL keys of access authentication, alert channel and SMTP settings, the setup token) are envelope-encrypted with `EDGEWEIR_MASTER_KEY` before they reach the database: AES-256-GCM with a random data key per record, and additional authenticated data that binds table, column, and record id (envelope format v2; v1 envelopes written by older versions are re-encrypted at startup and rejected otherwise). Copying settings to another site or cloning a site decrypts these secrets in the console's memory only and seals them again for the new records. Enrollment tokens, API keys, and passwords are stored as hashes only. Unless `BETTER_AUTH_SECRET` is set, better-auth's session secret (session cookie signatures, TOTP secrets and backup codes at rest) is derived from `EDGEWEIR_MASTER_KEY` with HKDF-SHA256 (salt `edgeweir/auth-secret/v1`, info `better-auth.secret`, 32 bytes, base64url), independent of the envelope KEK (salt `edgeweir/kek/v1`, info `envelope`); the database keeps only an HMAC check value, and the console refuses to start when the derived secret differs from the one the database was used with (for example `BETTER_AUTH_SECRET` removed from an existing deployment). Before that, the console refuses a master key that is not canonical base64, and one whose key id differs from the one recorded in the internal CA key's envelope ("EDGEWEIR_MASTER_KEY does not match this database"). To rotate the master key, the old one goes into `EDGEWEIR_MASTER_KEY_PREVIOUS`, which only decrypts: at startup every stored envelope it sealed is re-encrypted with the new key under an advisory lock, the log reports how many still use it, and revision receipts held by nodes keep verifying while it is set; a session secret derived from the old key is kept, sealed with the new key in `system_setting`, so sessions and two-factor secrets survive. With the derived secret, a leaked master key also allows forging sessions. Every management action is written to the audit log: Edgeweir's own changes commit their audit entry in the same transaction; sign-ins, password changes, two-factor changes, passkeys, and API keys are completed by better-auth and audited right after it commits. Account recovery has no web or HTTP entry: `recover.js`, run on the server with the console's environment, resets the password or turns two-factor authentication off, signs out every session, and audits the change in the same transaction. Releases are signed with cosign keyless and ship with an SBOM and SLSA provenance.

**Access logs.** No query strings, request headers, cookies or bodies by default; Referers are stored without query strings. Query strings, chosen headers (never `Authorization`, `Cookie`, `Proxy-Authorization`) and the peer address are recorded only while a site opts in; retention is 1–30 days (PostgreSQL) or 1–90 days (ClickHouse). The node live view (`edgeweir-node accesslog`) collects only while someone watches over the control socket; nodes write no local log files.

**Image conversion.** WebP / AVIF conversion runs in a child process of the node agent with pure Go codecs, a memory limit (`RLIMIT_DATA`), no file writes, no capabilities, no environment and a timeout; concurrency and total memory are bounded per node and images over a limit keep their original.

**Known limitations.** The node keeps its private key, the S3 origin and PURGE keys (`credentials.json`), and site certificate keys (`certificates.json`) in plain text with mode 0600 in its state directory; PURGE keys stay in the agent, which compares them in constant time, and never enter the data plane; access authentication secrets (salted PBKDF2-HMAC-SHA256 password hashes and signing keys) are in the data plane's shared memory, as S3 keys are. Forward authentication with cached answers does not tell paths or visitor addresses apart, and "allow when the service fails" lets requests through without authentication while the service is down. Rules read request bodies only up to the site's rules body limit (1 MiB at most) and only with a `Content-Length`; other bodies count as truncated and are not read, so rules that block on body fields must also check `http.request.body.truncated`. Verified search engine crawlers (reverse and forward DNS through the node's resolver) skip Under Attack and CC challenges. Hotlink protection and user agent lists rely on headers clients choose (`Referer`, `Origin`, `User-Agent`) and are no access boundary; geo access is as accurate as the node's GeoIP data; CORS with credentials lets every allowed origin read responses with the visitor's cookies; addresses on a site allow list skip that site's bans, block lists, geo, hotlink and user agent checks and challenges. A cache rule that caches `Set-Cookie` responses keeps the fetched cookies in the object on the node's disk; they are only restored for the request that fetched it, never sent with cache hits. A regional probe keeps its private key the same way. Nodes answer `/.edgeweir/health` on every edge listener with a self-signed health certificate that probes do not verify, so a man in the middle on a probe's path can fake reachability. A leaked master key together with the database defeats envelope encryption; rotating the key keeps the session secret, so after a leak also set a new `BETTER_AUTH_SECRET` (everyone is signed out, two-factor authentication must be enrolled again) and replace the credentials stored in the database. The node channel on `:8443` must not sit behind a TLS-terminating proxy; its WebSocket entry on the web port (`/node-channel`, closed by default) carries the node channel's TLS inside the WebSocket, so proxies in front of it only forward TLS records. L4 apps bypass the HTTP-layer protections (WAF, rules, challenges, site bans) and rely on their own IP lists, per-node limits, and kernel bans; a listener that accepts PROXY protocol must be reachable from the load balancer only. On a site with **gRPC** on, requests with `Content-Type: application/grpc` skip the OWASP CRS (ModSecurity would hold streaming calls until their body ends); clients choose that header themselves, so turn gRPC on only where the origin keeps its gRPC endpoints apart from the rest (or on a site of their own); bans, rules, rate limits and challenges still apply. Header value expressions of rules can copy visitor-controlled data (cookies, query parameters, request headers) into headers sent to the origin or the visitor and into redirect targets; nodes only refuse control characters and header values over 4096 bytes (skipping the action), so do not put such values into response headers that clients interpret as directives. Nodes take the visitor address from the TCP peer by default and trust no request header; with a cluster's PROXY protocol mode any client that reaches a node's HTTP or HTTPS port directly can claim any address, so open those ports to the load balancer only, and in the trusted header mode list only the proxies' own addresses as trusted CIDRs; kernel bans match the TCP peer only in both modes. Scan protection (unknown hosts) bans a client IP on every site after a threshold; allow lists and the cluster's trusted proxies are exempt, and behind a load balancer the cluster's client IP setting must name the visitor, or the balancer's address is banned. Pattern domains use the rule engine's regular expression subset in a bounded shape; the console runs them with V8's linear fallback for excessive backtracking. Nodes keep their cluster's TLS session ticket keys in plain text with mode 0600 (rotated every 12 hours, never in the configuration); each site has its own session context, so a session never resumes on another site, and TLS 1.3 early data is never accepted. Client certificates are not checked for revocation and cannot be combined with HTTP/3; visitors' own `X-Client-*` headers are removed on every site. A custom ACME directory saved in system settings may be a private address (outside `EDGEWEIR_OUTBOUND_ALLOW_CIDRS`).

**Verifying releases.** Console image: `cosign verify ghcr.io/marvinli001/edgeweir:<YYYYMMDD>-<commit> --certificate-identity https://github.com/marvinli001/edgeweir/.github/workflows/release.yml@refs/heads/master --certificate-oidc-issuer https://token.actions.githubusercontent.com`, then `gh attestation verify` for provenance. Node packages: verify `checksums.txt` with `cosign verify-blob`, the certificate identity pinned to the `marvinli001/edgeweir-node` release workflow on a `v*` tag and the issuer to `https://token.actions.githubusercontent.com`, then run `sha256sum -c checksums.txt --ignore-missing`. Full commands: [SECURITY.en.md](SECURITY.en.md#verifying-releases).
