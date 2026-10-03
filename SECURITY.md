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
| 控制台 | 最新滚动版本：`master` 最新提交对应的 `<YYYYMMDD>-<commit>` 镜像（`latest`） | 更早的滚动版本 |
| edgeweir-node | `master` 最新代码 | 其他提交 |

安全修复只进入 `master`，不回移到旧版本。控制台的修复随 `master` 上下一个通过 CI 的提交发布为新的滚动版本。

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

### 存储方式

| 数据 | 存储 | 位置 |
| --- | --- | --- |
| 内部 CA 私钥 | 信封加密 | `pki_authority.private_key_envelope` |
| 证书私钥 | 信封加密 | `certificate.private_key_envelope` |
| ACME 账户 | 信封加密 | `acme_account.account_envelope`；申请时的 EAB 密钥在 `certificate.account_envelope` |
| ACME DNS-01 凭据 | 信封加密 | `dns_credential.credential_envelope` |
| DNS 调度服务商凭据 | 信封加密 | `platform_dns_provider.credential_envelope` |
| S3 源站密钥 | 信封加密 | `origin_credential.secret_envelope` |
| 告警渠道配置（webhook 地址与 Bearer token、邮件收件人） | 信封加密 | `alert_channel.config_envelope` |
| SMTP 设置（含密码） | 信封加密 | `system_setting` 的 `notification_smtp` |
| setup token | 信封加密；另存 SHA-256 用于比对 | `system_setting` 的 `setup_token` |
| 挑战页签名密钥 | 信封加密 | `challenge_key.secret` |
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
| 证书私钥与 S3 源站密钥只经 mTLS 通道发给服务引用网站的集群节点，不写入 NodeConfig | 其他集群的节点或配置快照泄露密钥 |
| revision 回执由主密钥封装并绑定节点；节点报告高于控制台最新 revision 的版本时必须附有效回执，只有经验证的版本参与 revision 序号计算 | 数据库从备份恢复后，未经认证的上报操纵 revision 序号 |
| 敏感数据信封加密，主密钥不入库；附加认证数据绑定表、字段与记录 id | 数据库备份或只读 SQL 注入泄露私钥与凭据；有库写权限者在行之间互换密文 |
| 管理操作写审计，与变更同事务提交 | 越权或误操作无法追溯 |
| `/api/auth/*` 只放行控制台界面用到的 better-auth 端点（不含注册、admin 与 api-key 端点），其余 404；AccessKey 只能由已登录的会话经 `accessKeys.*` 创建与吊销；`x-api-key` 在 `/api/auth/*` 与 `/rpc` 上被丢弃，只在 `/api/v1` 生效 | 借 better-auth 插件端点绕过审计与配置版本（创建账户、冒充用户、改密码）；API key 变成会话或签发新 key |
| `/rpc` 要求 `x-csrf-token` 头；响应带 CSP `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'` | 跨站请求伪造；页面被嵌入第三方站点 |
| 客户端 IP 取 TCP 对端地址，转发头只信任 `EDGEWEIR_TRUSTED_PROXIES`；登录与两步验证的限速计数存 PostgreSQL，多实例共享，重启不清零 | 伪造 IP 绕过登录与两步验证限速；审计日志中的 IP 失真 |
| `install.sh` 与 agent 自升级先校验 cosign 签名（证书身份精确匹配待安装版本的 release 工作流）与 SHA-256，再执行；控制台 `/downloads` 镜像（`EDGEWEIR_DOWNLOADS_DIR`）只是传输通道，未镜像的文件返回 404 | 下载链路或镜像被篡改 |
| 源站不能是特殊用途地址（回环、链路本地、私网、CGNAT、组播等）或 `localhost`：控制台拒绝这类 IP 字面量，节点对配置和每个 DNS 解析结果执行同一清单（`packages/contract/src/addresses.ts`）；只有经审计的源站地址允许清单能放行地址段；节点回源请求带 `CDN-Loop`（RFC 8586），收到带自身标识的请求返回 508 | 借回源访问云元数据（`169.254.169.254`）、探测内网，或造成回环 |
| 控制台向 Web 界面保存的目标（告警 webhook、SMTP 服务器、节点发布源）发起的请求先解析一次、拒绝特殊用途地址，再连接该地址；`EDGEWEIR_OUTBOUND_ALLOW_CIDRS` 放行指定地址段 | 借控制台的出站请求访问内网 |
| 填写地址的 DNS 服务商（PowerDNS、RFC 2136、自定义 HTTP）由证书助手在连接建立时检查实际连接的地址，特殊用途地址只在 `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` 内放行；公网地址必须使用 HTTPS，不跟随重定向。自定义 HTTP 请求带时间戳与 HMAC-SHA256 签名；DNS 服务商的错误以分类码返回，不回传服务商原文 | 借 DNS 服务商配置访问内网（含 DNS 重绑定），或凭据经明文或错误信息泄露 |
| 节点端清缓存标记超过上限时合并为站点级标记 | 大量刷新任务填满节点的清缓存存储，影响同节点其他网站 |
| agent 只执行类型化操作，没有执行任意命令的接口 | 控制台失陷后在节点上执行任意代码 |
| 发布物 keyless 签名、SBOM、SLSA provenance | 发布的程序与源码不一致，或被投毒 |

## 已知限制

| 限制 | 影响与处理 |
| --- | --- |
| `install.sh` 由控制台提供 | 信任控制台（运营者自己的服务器）是前提；需要更强保证时，先下载脚本审阅，或与 GitHub 上同版本的脚本比对 |
| 控制台被攻破 | 攻击者可以下发恶意配置（例如把网站指向恶意源站），但不能让节点运行未签名的程序，也拿不到节点私钥 |
| 节点本地凭据 | 节点在状态目录（默认 `/var/lib/edgeweir-node`，权限 0700）以 0600 权限明文保存节点私钥、S3 源站密钥（`credentials.json`）与网站证书私钥（`certificates.json`），控制台不可达时节点重启后仍能服务；拿到节点 root 权限者可以读取 |
| 主密钥与数据库同时泄露 | 信封加密失效；未设置 `BETTER_AUTH_SECRET` 时，泄露的主密钥还能伪造登录会话。经 `EDGEWEIR_MASTER_KEY_FILE` 从 secret 文件读取（[主密钥文件](docs/deploy/docker.md#主密钥文件)）或由编排平台的 secret 机制注入，不与数据库备份放在一起。主密钥泄露后[轮换](docs/deploy/docker.md#轮换主密钥)：轮换保留会话 secret，未设置 `BETTER_AUTH_SECRET` 的部署另设一个新值（全部会话失效，两步验证需重新启用）；数据库也泄露时，更换其中的凭据 |
| setup token 写入日志 | 首次初始化需要控制台启动时写入日志的一次性 setup token；能读控制台日志者即可完成初始化。按主密钥的级别控制日志访问 |
| 在服务器上找回账户 | 能在控制台容器内执行命令者（本就能读取 `DATABASE_URL` 直接修改数据库）可以用 `recover.js` 重置账户密码、停用两步验证；找回让全部会话退出登录并写入审计日志（`account.recover`），Web 界面与 HTTP 没有找回入口（[命令行](docs/reference/cli.md#找回账户)）。按主密钥的级别控制服务器访问 |
| 探针本地凭据 | 探针在状态目录（默认 `/var/lib/edgeweir-probe`，权限 0700）以 0600 权限明文保存探针私钥；拿到探针主机 root 权限者可以冒充该探针上报结果，直到探针在控制台被删除 |
| 健康端点 | 节点在每个边缘监听上对任意 Host 应答 `GET /.edgeweir/health`，HTTPS 对 SNI `health.edgeweir.invalid` 或无 SNI 的握手出示节点自生成的自签名证书，扫描者能据此识别 Edgeweir 节点；探针不校验该证书，探测路径上的中间人可以伪造可达结果，影响调度但接触不到机密 |
| 节点通道 `:8443` | 只能直接暴露或四层透传；反向代理终结 TLS 会使 mTLS 失效（[端口、反向代理与可信代理](docs/deploy/networking.md)） |
| 四层转发 | L4 应用的流量不经过 HTTP 层：WAF、规则、挑战、CC 防护、网站封禁与全局「拦截」「放行」名单都不作用于它，只有应用自己的 IP 名单、每节点连接上限与内核封禁（`kernel-ban-v1`）。端口只来自集群的端口池（1024–65535），节点不需要额外权限。开启「接受 PROXY protocol」时客户端地址取自头部：该端口只应对负载均衡器开放，否则任何客户端都能声明别的地址绕过放行名单（[四层转发](docs/guide/l4.md)） |

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

控制台镜像滚动发布，没有版本 tag：`master` 上通过 CI 的每个提交发布为 `<YYYYMMDD>-<提交前 7 位>`（例如 `20260929-a1b2c3d`），`latest` 只在该提交仍是 `master` 最新提交时移动。签名证书身份是 `master` 分支上的 release 工作流。

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

**Supported versions.** Console: the latest rolling image (`<YYYYMMDD>-<commit>` of the newest `master` commit, `latest`). Node: the latest `master`. Security fixes land on `master` only.

**Trust baseline.** No phone-home of any kind and no license-check code. Telemetry is off by default and requires explicit opt-in; the current version sends no telemetry, and better-auth's own telemetry is hard-disabled. The console never stores SSH credentials; nodes join only through the one-time install command. Private keys and third-party credentials (internal CA key, certificate keys, ACME accounts, DNS provider credentials, S3 origin keys, alert channel and SMTP settings, the setup token) are envelope-encrypted with `EDGEWEIR_MASTER_KEY` before they reach the database: AES-256-GCM with a random data key per record, and additional authenticated data that binds table, column, and record id (envelope format v2; v1 envelopes written by older versions are re-encrypted at startup and rejected otherwise). Enrollment tokens, API keys, and passwords are stored as hashes only. Unless `BETTER_AUTH_SECRET` is set, better-auth's session secret (session cookie signatures, TOTP secrets and backup codes at rest) is derived from `EDGEWEIR_MASTER_KEY` with HKDF-SHA256 (salt `edgeweir/auth-secret/v1`, info `better-auth.secret`, 32 bytes, base64url), independent of the envelope KEK (salt `edgeweir/kek/v1`, info `envelope`); the database keeps only an HMAC check value, and the console refuses to start when the derived secret differs from the one the database was used with (for example `BETTER_AUTH_SECRET` removed from an existing deployment). Before that, the console refuses a master key that is not canonical base64, and one whose key id differs from the one recorded in the internal CA key's envelope ("EDGEWEIR_MASTER_KEY does not match this database"). To rotate the master key, the old one goes into `EDGEWEIR_MASTER_KEY_PREVIOUS`, which only decrypts: at startup every stored envelope it sealed is re-encrypted with the new key under an advisory lock, the log reports how many still use it, and revision receipts held by nodes keep verifying while it is set; a session secret derived from the old key is kept, sealed with the new key in `system_setting`, so sessions and two-factor secrets survive. With the derived secret, a leaked master key also allows forging sessions. Every management action is written to the audit log: Edgeweir's own changes commit their audit entry in the same transaction; sign-ins, password changes, two-factor changes, passkeys, and API keys are completed by better-auth and audited right after it commits. Account recovery has no web or HTTP entry: `recover.js`, run on the server with the console's environment, resets the password or turns two-factor authentication off, signs out every session, and audits the change in the same transaction. Releases are signed with cosign keyless and ship with an SBOM and SLSA provenance.

**Known limitations.** The node keeps its private key, the S3 origin keys (`credentials.json`), and site certificate keys (`certificates.json`) in plain text with mode 0600 in its state directory; a regional probe keeps its private key the same way. Nodes answer `/.edgeweir/health` on every edge listener with a self-signed health certificate that probes do not verify, so a man in the middle on a probe's path can fake reachability. A leaked master key together with the database defeats envelope encryption; rotating the key keeps the session secret, so after a leak also set a new `BETTER_AUTH_SECRET` (everyone is signed out, two-factor authentication must be enrolled again) and replace the credentials stored in the database. The node channel on `:8443` must not sit behind a TLS-terminating proxy. L4 apps bypass the HTTP-layer protections (WAF, rules, challenges, site bans) and rely on their own IP lists, per-node limits, and kernel bans; a listener that accepts PROXY protocol must be reachable from the load balancer only.

**Verifying releases.** Console image: `cosign verify ghcr.io/marvinli001/edgeweir:<YYYYMMDD>-<commit> --certificate-identity https://github.com/marvinli001/edgeweir/.github/workflows/release.yml@refs/heads/master --certificate-oidc-issuer https://token.actions.githubusercontent.com`, then `gh attestation verify` for provenance. Node packages: verify `checksums.txt` with `cosign verify-blob`, the certificate identity pinned to the `marvinli001/edgeweir-node` release workflow on a `v*` tag and the issuer to `https://token.actions.githubusercontent.com`, then run `sha256sum -c checksums.txt --ignore-missing`. Full commands: [SECURITY.en.md](SECURITY.en.md#verifying-releases).
