# HTTPS 与证书

证书页面的上传、ACME 申请与续期、DNS 凭据和源站保护，以及网站「HTTPS」页签、压缩、监听端口与网站端口的设置。

## 概念

| 术语 | 定义 |
| --- | --- |
| 证书 | 证书链与私钥。网站的每个域名都须被网站的某一张证书覆盖。 |
| ACME 证书 | 控制台向 Let's Encrypt、ZeroSSL、Google Trust Services 或自定义 ACME 目录申请、自动续期的证书。 |
| ACME 账户 | 控制台在 CA 注册的账户，按目录、EAB 密钥 ID 与邮箱区分，同一组合的证书共用。 |
| DNS 凭据 | DNS 服务商凭据，供 DNS-01 验证写入 TXT 记录。与 DNS 调度的服务商账号相互独立。 |
| HTTPS 设置 | 网站「HTTPS」页签中的证书（最多 4 张）、跳转、HSTS、TLS、HTTP/2、HTTP/3、OCSP 装订与客户端证书选项；压缩在「缓存」页签的「压缩」卡片中设置，与 HTTPS 设置保存在同一组字段中。 |
| 客户端证书 | 访客在 TLS 握手中出示、由网站配置的 CA 签发的证书（双向 TLS）。 |
| 监听端口 | 节点接收 HTTP / HTTPS 流量的端口：80、443 与集群的附加端口；网站在「端口」卡片中选择其中一部分。 |
| 源站保护 | Origin CA 签发只有节点信任的源站证书；回源客户端 CA 签发节点回源时出示的客户端证书。 |

## 证书页面

页面：**证书**（`/certificates`），侧边栏「网站」组。页签：「证书」（默认）、「源站证书」（`/certificates?tab=origin-ca`，见 [Origin CA](#origin-ca)）、「回源客户端」（`/certificates?tab=origin-client`，见 [回源客户端证书](#回源客户端证书)）。`/certificates?request=true`（命令菜单的申请证书）直接打开「申请证书」对话框。

「证书」页签的页面操作为「添加 DNS 凭据」「上传证书」「申请证书」，其下依次是证书列表、「DNS 凭据」卡片与「ACME 账户」卡片。证书列表每 5 秒刷新；没有证书时显示「暂无证书」与「申请证书」。

| 证书行 | 内容 |
| --- | --- |
| 名称与状态 | 见下表 |
| 域名 | 证书的全部名称 |
| 原因 | 签发失败或节点无法加载时的原因，见[故障排查](#故障排查) |
| 节点报告 | 「{节点} 无法加载此证书，已拒绝其 TLS 握手」或「{节点} 无法加载此证书，仍在使用上一版」，见[上传证书](#上传证书) |
| 有效期 | 「到期时间 {时间} · 剩余 {N} 天」；过期后为「已于 {时间} 过期」 |
| 续期 | 「已开启自动续期」或「未开启自动续期」；开启时另显示「下次续期：{时间}」 |
| 「⋯」 | 「立即续期」（只有 ACME 证书，「等待签发」「签发中」时不可用）与「删除」 |

列表底部显示「共 N 项」。

| 状态 | 条件 |
| --- | --- |
| 等待签发 | ACME 证书等待后台任务签发或续期 |
| 签发中 | 后台任务正在签发 |
| 可用 | 已签发、未过期 |
| 签发失败 | 最近一次签发或续期失败；已签发的证书继续使用 |
| 已过期 | 已过有效期；续期中的证书保持「等待签发」或「签发中」 |
| 不可用 | 上传的证书使用显式曲线参数（节点无法加载），或有节点报告无法加载且没有上一版可用 |

## 上传证书

1. 打开 **证书**，点击「上传证书」。
2. 填写「名称」。
3. 在「证书链（PEM）」中选择文件（`.pem`、`.crt`、`.cer`）或粘贴内容，叶证书在前，中间证书依次在后。
4. 在「私钥（PEM）」中选择文件（`.pem`、`.key`）或粘贴内容。
5. 点击「上传证书」。
6. 验证：证书行状态为「可用」，显示「到期时间 … · 剩余 … 天」。

| 要求 | 值 |
| --- | --- |
| 名称 | 1–100 字符 |
| 证书链 | 1–10 张证书，最大 128 KiB；每张由下一张签发；只能包含证书，合并了私钥的 PEM 被拒绝（「证书链只能包含证书，私钥请填到私钥栏」） |
| 叶证书 | 不是 CA 证书，含 DNS 类型的 SAN，当前处于有效期内 |
| 密钥类型 | 叶证书的密钥为 RSA（2048 位及以上）或 ECDSA P-256、P-384、P-521；其他曲线（secp256k1、Brainpool、SM2、P-224）、Ed25519、Ed448、ML-DSA、RSA-PSS、DSA 被拒绝 |
| 私钥 | 与叶证书匹配，不加密，最大 32 KiB |
| EC 密钥 | 证书与私钥都须使用命名曲线（曲线 OID），不接受显式曲线参数 |
| Origin CA | Origin CA 签发的证书被拒绝（「Origin CA 签发的证书只能用于源站」） |

保存的只有重新编码的证书与 PKCS #8 私钥，粘贴内容里的其他文字不保存。上传写审计 `certificate.upload`。上传的证书不自动续期（「未开启自动续期」）；到期前上传新证书并在网站中改选。

此前上传、使用显式曲线参数的证书节点同样无法加载：

| 项目 | 行为 |
| --- | --- |
| 后台检查 | 后台任务每次启动时检查已上传的证书：这类证书状态变为「不可用」并显示原因，审计日志记录「证书标记为节点无法加载」（`certificate.unloadable`）和使用它的网站与 L4 应用 |
| 网站 | 网站与「已有证书」列表不再提供它；已选用它的网站不被自动改动，保存这些网站的「HTTPS」页签时返回同样的错误 |
| 节点 1.1.0 及以上 | 跳过无法加载的证书，照常应用配置版本的其余部分：节点上还有该证书的上一版时继续使用上一版，没有时拒绝用到它的 TLS 握手，不换用其他证书 |
| 更早的节点 | 该集群的所有节点都不应用这个版本 |
| 上报 | 节点上报后，证书行显示节点报告（拒绝握手时状态为「不可用」），节点显示「N 张证书未加载」，并发出告警「节点无法加载证书」 |
| 处理 | 上传命名曲线的证书（见[故障排查](#故障排查)），在这些网站的「HTTPS」页签改选并保存，或改为「仅 HTTP」，再删除旧证书 |

## 添加 DNS 凭据

DNS-01 验证需要先添加凭据。

1. 打开 **证书**，点击「添加 DNS 凭据」。
2. 填写「名称」，选择「DNS 服务商」，按表单填写凭据字段。
3. 能列出区域的服务商：点击「列出区域」并选择「区域」；其他服务商直接填写「区域」。
4. 点击「测试连接」，确认显示「连接正常：区域内有 N 条记录」。
5. 点击「创建」。保存前先执行与「测试连接」相同的测试；失败时对话框显示错误，按钮变为「仍然保存」。
6. 验证：凭据出现在「DNS 凭据」卡片中，显示其区域与服务商。

| 字段 | 取值 |
| --- | --- |
| 名称 | 1–100 字符 |
| DNS 服务商 | 服务商目录中的服务商，见[服务商与凭据](dns.md#服务商与凭据) |
| 凭据字段 | 1–10 个字段，各最长 16384 字符；字段与最小权限见[服务商与凭据](dns.md#服务商与凭据) |
| 区域 | 域名，不能是泛域名；证书名称须为区域本身或其下的子域名 |

凭据使用主密钥信封加密后保存，只写不读。点击凭据所在行打开「编辑」对话框：可改名，或打开「重新填写凭据」轮换密钥；服务商与区域不能修改。新凭据保存前同样先测试；只改名时不测试；测试失败后修改任一字段，下次保存重新测试。轮换后，使用该凭据且处于「签发失败」的证书和待清理的 TXT 记录立即重试。审计：`dns_credential.create`、`dns_credential.update`、`dns_credential.delete`。

## 申请 ACME 证书

前提：

- HTTP-01：每个证书名称都是某个网站的精确域名（不能是泛域名），已解析到服务该网站的集群的节点，节点 80 端口可从公网访问；该集群有在线节点，在线节点都支持 `http01-v1`。
- DNS-01：已添加区域覆盖全部证书名称的 DNS 凭据；证书名称不必已加入网站。

1. 打开 **证书**，点击「申请证书」。
2. 填写「名称」「域名」「账户邮箱」。
3. 选择「证书颁发机构」「密钥类型」和「验证方式」。选择 DNS-01 时选择「DNS 凭据」；选择 ZeroSSL 或 Google Trust Services 时填写「EAB 密钥 ID」和「EAB HMAC 密钥」。
4. 点击「申请证书」。
5. 验证：证书行状态依次变为「等待签发」「签发中」「可用」，并显示「已开启自动续期」和「下次续期：…」。

### 申请字段

| 字段 | 取值 | 默认值 | 作用 |
| --- | --- | --- | --- |
| 名称 | 1–100 字符 | 无 | 证书在控制台中的名称 |
| 域名 | 1–100 个域名，逗号或空格分隔，不重复；可含 `*.` 泛域名 | 无 | 证书 SAN |
| 账户邮箱 | 邮箱地址 | 无 | ACME 账户联系邮箱 |
| 证书颁发机构 | Let's Encrypt / ZeroSSL / Google Trust Services / 自定义 ACME 目录 | Let's Encrypt；自定义目录的地址只来自 `EDGEWEIR_ACME_DIRECTORY` 时为自定义 ACME 目录 | 签发证书的 CA，见[证书颁发机构](#证书颁发机构)；「自定义 ACME 目录」在[系统设置](system.md#证书颁发机构)配置后才出现，选择后表单显示目录地址 |
| 密钥类型 | ECDSA P-256 / RSA 2048 | ECDSA P-256 | 证书私钥的类型，续期沿用。需要同时服务只支持 RSA 的旧客户端时，另申请一张 RSA 证书加入网站，见[多张证书](#多张证书) |
| 验证方式 | HTTP-01 / DNS-01 | HTTP-01 | 域名控制验证方式；泛域名必须使用 DNS-01，选择 HTTP-01 时「域名」下提示「泛域名需要 DNS-01 验证」，不能提交 |
| DNS 凭据 | 已添加的 DNS 凭据 | 按名称排序的第一个 | 仅 DNS-01：写入 TXT 所用的凭据；每张证书一个区域 |
| 跳过解析检查 | 开 / 关 | 关 | 仅 HTTP-01：不检查名称是否解析到节点（申请时与每次签发前），例如节点前面还有负载均衡 |
| EAB 密钥 ID / EAB HMAC 密钥 | CA 提供的 EAB 凭据，最长 256 / 1024 字符 | 无 | Let's Encrypt 不显示；ZeroSSL 与 Google Trust Services 必填；两者同时填写或都留空；自定义目录留空时使用系统设置中的 EAB（占位文字「留空使用系统设置中的 EAB」）。加密保存 |

申请写审计 `certificate.request`。同一 ACME 目录、EAB 密钥 ID 与账户邮箱的证书共用一个 ACME 账户：CA 限制每个 IP 新注册的账户数（Let's Encrypt 为 3 小时 10 个）。账户列在「ACME 账户」卡片中，见 [ACME 账户](#acme-账户)。

### 证书颁发机构

| CA | ACME 目录 | EAB | CAA 签发者 |
| --- | --- | --- | --- |
| Let's Encrypt | `https://acme-v02.api.letsencrypt.org/directory` | 不需要 | `letsencrypt.org` |
| ZeroSSL | `https://acme.zerossl.com/v2/DV90` | 必填（ZeroSSL 控制台生成） | `sectigo.com`、`trust-provider.com`、`usertrust.com` |
| Google Trust Services | `https://dv.acme-v02.api.pki.goog/directory` | 必填（`gcloud publicca external-account-keys create` 生成，7 天内使用、只能注册一次） | `pki.goog` |
| 自定义 ACME 目录 | **系统设置 → 证书颁发机构** 中的地址，或 `EDGEWEIR_ACME_DIRECTORY` | 目录要求时填写；申请时留空使用系统设置中的 EAB | 系统设置中保存的目录 `meta.caaIdentities` 列出的名称；没有时或地址只来自环境变量时不检查 CAA |

自定义目录的地址、EAB 与 CA 证书见[系统设置](system.md#证书颁发机构)，界面保存的值优先于 `EDGEWEIR_ACME_DIRECTORY` 与 `EDGEWEIR_ACME_CA_FILE`。没有指定 CA 的 API 申请在自定义目录的地址只来自环境变量时使用自定义目录，其余情况使用 Let's Encrypt：只用环境变量的已有部署升级后行为不变；此前用环境变量签发的证书在后台任务启动时记为「自定义 ACME 目录」，续期仍向该目录申请。删除自定义目录的配置后，选择它的证书续期失败（「已不再配置自定义 ACME 目录」）。

### ACME 账户

「ACME 账户」卡片列出控制台注册的账户：邮箱、CA、目录地址、「EAB 密钥 ID」、「创建于 …」与「使用中的证书：N」；没有账户时显示「还没有 ACME 账户」。没有证书使用的账户可以删除（确认「删除 ACME 账户 {email}？」）：只删除控制台保存的账户与私钥，不在 CA 注销账户；仍有证书使用时删除按钮不可用，API 返回「ACME 账户仍被证书使用：…」。删除写审计 `acme_account.delete`。之后用同一目录、EAB 与邮箱申请时重新注册账户。

### 验证方式

| 方式 | 行为 |
| --- | --- |
| HTTP-01 | 每个名称都必须是某个网站的精确域名，否则申请被拒绝（「证书域名与网站或 DNS 区域不匹配：…」）：挑战只由服务该名称的集群应答。申请时依次检查：服务这些名称的集群中在线节点都支持 `http01-v1`（「节点尚不支持：HTTP-01 验证（…）」），集群有在线节点（「集群 … 没有在线节点应答 HTTP-01」），名称解析到节点（「以下名称未解析到节点：…」）。控制台把一张证书的全部挑战一次发布到这些集群（每个集群一个版本，原因「已更新 ACME 验证」，网站已停用时同样发布），集群内所有在线节点在 40 秒内应用后才请求 CA 验证，同时验证 4 个名称。申请时和每次签发前，控制台用系统 DNS 解析各名称（每次 3 秒、最多 2 次）：名称没有 A/AAAA 记录，或解析结果中有不属于该集群活动节点的地址（节点配置的调度地址或上报的公网地址）时，申请被拒绝，签发不联系 CA 直接失败（「有域名未解析到节点」）；解析超时或节点没有已知公网地址时不拦截。挑战在 80 端口应答，不跳转、不缓存，10 分钟后或签发结束后失效（其他 HTTP-01 token 转给源站，源站可自行签发证书，这类请求不缓存、不挑战）；挑战版本不计入保留的配置版本数 |
| DNS-01 | 每个名称都必须在 DNS 凭据的区域内（区域本身或其下的子域名），否则申请被拒绝（「证书域名与网站或 DNS 区域不匹配：…」）。在 `_acme-challenge.<域名>` 写入 TXT，最长等待 3 分钟传播。同一凭据同时只有一次签发写入记录。签发结束、超时或进程中断后删除本次写入的 TXT 值；删除失败时按 1 分钟起、每次加倍、最长 6 小时的间隔重试，服务商已没有该区域时视为已删除 |

### 续期

| 项目 | 行为 |
| --- | --- |
| 自动续期 | 控制台申请的证书默认开启；API 可用 `autoRenew: false` 关闭 |
| 续期时间 | CA 提供 ARI（ACME Renewal Information）窗口时按窗口；否则在证书有效期过去三分之二时；最晚为到期前 1 分钟。证书行显示「下次续期：…」 |
| 窗口变化 | 签发后按 CA 的建议间隔（1–24 小时，默认 6 小时；查询失败时 1 小时）重新查询 ARI；窗口提前到下次续期时间之前（例如 CA 将提前吊销证书）时，续期改到新窗口内的随机时间，写审计 `certificate.renewal_rescheduled` |
| 检查周期 | 后台任务每分钟检查到期的证书，每次最多 10 张，新申请与「立即续期」优先，其余按续期时间先后，同时签发 3 张；需要 `ROLE=worker` 或 `ROLE=all` 的控制台进程 |
| 续期域名 | HTTP-01 证书续期时去掉已没有网站使用的名称，只要至少还剩一个名称；使用该证书的网站的域名都会保留，网站仍被覆盖。签发成功后证书的域名列表随之更新。网站新增的域名见[为 HTTPS 网站添加域名](#为-https-网站添加域名) |
| 生效 | 签发或续期成功后写审计 `certificate.issued`，为引用该证书的网站所在集群发布新版本（原因「已更新 {证书} 的证书配置」） |
| 失败 | 状态变为「签发失败」，证书行显示原因，保留当前证书；重试间隔为证书剩余有效期的十分之一（10 分钟到 12 小时），首次签发 1 小时后重试，见[故障排查](#故障排查)。因名称未解析到节点而失败（「有域名未解析到节点」）的 HTTP-01 证书，后台每 5 分钟重新解析，名称都解析到节点后立即重试 |
| 过期 | 续期失败直到证书过期时，状态显示「已过期」，证书行仍显示失败原因 |
| 手动 | 「⋯」中的「立即续期」把状态改为「等待签发」，在下一次检查时执行，写审计 `certificate.renew` |
| 中断 | 「签发中」超过 10 分钟视为中断，下一次检查重新执行；单次签发最长 8 分钟 |

### 删除

「删除」在证书行与 DNS 凭据行末的「⋯」中，需要确认（「删除 {名称}？」）。

| 对象 | 规则 |
| --- | --- |
| 证书 | 被网站引用（第一张或其他证书）时返回「证书仍被网站使用：…」，被 L4 应用的 TLS 卸载引用时返回「证书仍被 L4 应用使用：…」（各列出最多 5 个）；处于「签发中」时返回「证书正在处理中」。仍有 DNS-01 TXT 记录待清理时照常删除，不再清理这些记录：审计 `certificate.delete` 的 `leftDnsRecords` 列出记录，需在 DNS 服务商处手动删除 |
| DNS 凭据 | 被任一证书引用时返回「DNS 凭据仍被证书使用：…」（最多 5 张） |

## 一键启用 HTTPS

网站没有证书，或第一张证书是未签发、已过期的上传证书时，「HTTPS」页签只显示「HTTPS 未启用」卡片。

1. 打开 **网站**，选择网站，进入「HTTPS」页签。
2. 控制台先检查能否签发，有阻碍时逐条列出且「启用 HTTPS」不可用；修正后点击「重新检查」。
3. 需要时点击「自定义」，修改「证书颁发机构」「账户邮箱」或打开「跳过解析检查」。
4. 点击「启用 HTTPS」。
5. 验证：卡片标题变为「正在申请证书」；签发后切换为 HTTPS 设置，「证书」为新证书。「强制 HTTPS」保持关闭，需要时在 HTTPS 设置中打开。

| 项目 | 取值 |
| --- | --- |
| 证书名称、域名 | 网站名称（前 100 字符）；网站的精确与泛域名，后缀域名 `.a.com` 申请 `*.a.com`，正则域名不申请（[后缀与正则域名的限制](domains.md#后缀与正则域名的限制)） |
| 验证方式 | HTTP-01；网站有泛域名或后缀域名时用 DNS-01，凭据为按名称排序后第一个区域覆盖全部域名的 DNS 凭据 |
| 账户邮箱 | 最近注册的 ACME 账户的邮箱，否则最近一次申请的邮箱，否则控制台账户的邮箱；可在「自定义」中修改 |
| 证书颁发机构 | 与「申请证书」的默认值相同；可在「自定义」中改选（ZeroSSL、Google Trust Services 需要填写 EAB，未填时按钮不可用） |
| 密钥类型 | ECDSA P-256 |
| 自动续期 | 开 |
| 签发后 | 证书绑定到网站（「强制 HTTPS」等其他设置不变），发布网站所在集群，写审计 `site.https_update`（操作者 system）；申请后网站新增的域名随即重新签发。网站此时已有其他可用证书时不改动 |

| 检查提示 | 原因 |
| --- | --- |
| 「集群 … 没有在线节点」 | HTTP-01：网站所在集群没有在线的活动节点 |
| 「以下节点需要升级才能应答 HTTP-01：…」 | HTTP-01：在线节点缺少 `http01-v1` |
| 「… 还没有解析记录」「… 未解析到节点」 | HTTP-01：名称没有 A/AAAA 记录，或解析到不属于该集群节点的地址；解析超时或节点没有已知地址时不提示。控制台看到的解析与 CA 不同（内外网分离解析、前面另有代理）时，在「自定义」中打开「跳过解析检查」，这两条不再阻止申请，签发前也不再检查 |
| 「泛域名需要区域覆盖 … 的 DNS 凭据」 | DNS-01：没有这样的 DNS 凭据；提示旁的「添加 DNS 凭据」打开添加对话框 |
| 「DNS 凭据 …：…」 | DNS-01：凭据的连接测试失败 |
| 「网站只有正则域名，没有可签发的名称」 | 网站的域名全部是正则域名 |
| 「… 的 CAA 记录不允许 … 签发」 | 名称或其上级域名的 CAA 记录不允许所选 CA（签发者见[证书颁发机构](#证书颁发机构)），含 `issuewild` 与 `validationmethods`；自定义目录没有 `meta.caaIdentities` 时不检查 |

检查结果缓存 30 秒。签发中页签每 3 秒刷新状态。签发失败时显示分类后的原因（与证书行相同），可「重试」或「取消」（确认「删除 {名称}？」后删除这张证书）。已有覆盖网站全部域名的可用证书时，页签显示「已有证书」，点击「使用」直接选用。网站使用的 ACME 证书正在签发或签发失败时，HTTPS 设置上方显示同样的状态与「重试」。

## 配置网站 HTTPS

1. 打开 **网站**，选择网站，进入「HTTPS」页签（网站还没有证书时见[一键启用 HTTPS](#一键启用-https)）。
2. 在「证书」中选择证书。列表包含全部已签发、未过期且节点能加载的证书，以及网站已选用的证书；「仅 HTTP」表示不启用 HTTPS。需要更多证书时点击「添加证书」，见[多张证书](#多张证书)。
3. 设置「最低 TLS 版本」「密码套件」「HSTS 有效期（秒）」和各开关。
4. 点击「保存」。控制台提示「已保存」，为网站所在集群发布新的配置版本（原因「已更新 {网站} 的证书配置」），写审计 `site.https_update`。
5. 验证：节点应用该版本后：

   ```bash
   curl -sI --resolve www.example.com:443:<节点 IP> https://www.example.com/
   ```

   返回 `HTTP/2 200`（开启 HTTP/2 时）；开启 HSTS 时含 `strict-transport-security`；开启 HTTP/3 时含 `alt-svc: h3=":443"; ma=86400`。

节点报告已应用该版本，才表示配置在该节点生效。保存前表单先校验，字段不合法时提示「检查「{字段}」」。

### HTTPS 字段

| 字段 | 取值 | 默认值 | 作用 |
| --- | --- | --- | --- |
| 证书 | 可用的证书 / 仅 HTTP | 仅 HTTP | 网站的第一张证书。网站的每个域名都须被网站的某一张证书覆盖；网站的泛域名 `*.example.com` 要求证书含相同的 `*.example.com`。之后为网站添加的域名见[为 HTTPS 网站添加域名](#为-https-网站添加域名) |
| 证书 2–4 | 可用的证书 | 无 | 「添加证书」加入的其他证书，不能重复，见[多张证书](#多张证书) |
| 最低 TLS 版本 | TLS 1.2 / TLS 1.3 | TLS 1.2 | 握手接受的最低版本 |
| 密码套件 | 现代 / 兼容 | 现代 | TLS 1.2 密码套件档位，见下表 |
| HSTS 有效期（秒） | 0–63072000 | 0 | 大于 0 时在 HTTPS 响应中发送 `Strict-Transport-Security`；没有证书时不可编辑 |
| 强制 HTTPS | 开 / 关 | 关 | HTTP 请求跳转到 `https://<Host><请求 URI>`，状态码与端口见[HTTPS 跳转选项](#https-跳转选项)；没有证书时不可用；ACME 挑战路径不跳转 |
| HTTP/2 | 开 / 关 | 开 | 该网站的 HTTPS 连接协商 HTTP/2 |
| HTTP/3 | 开 / 关 | 关 | 在网站 HTTPS 端口的同号 UDP 端口提供 QUIC，并发送 `Alt-Svc: h3=":<端口>"; ma=86400`；开启客户端证书时不可用 |
| HSTS 包含子域名 | 开 / 关 | 关 | HSTS 附加 `includeSubDomains` |
| HSTS 预加载 | 开 / 关 | 关 | HSTS 附加 `preload` |
| OCSP 装订 | 开 / 关 | 关 | 在握手中附带 OCSP 响应，见 [OCSP 装订](#ocsp-装订) |
| 客户端证书 | 关闭 / 可选 / 必须 | 关闭 | 见[客户端证书](#客户端证书) |

选择「仅 HTTP」时，「强制 HTTPS」关闭、HSTS 有效期归零，其他证书与客户端证书一并去掉，跳转端口恢复为 443。

| 密码套件 | TLS 1.2 套件 |
| --- | --- |
| 现代 | `ECDHE-ECDSA-AES128-GCM-SHA256`、`ECDHE-RSA-AES128-GCM-SHA256`、`ECDHE-ECDSA-CHACHA20-POLY1305`、`ECDHE-RSA-CHACHA20-POLY1305` |
| 兼容 | 现代档位加 `ECDHE-ECDSA-AES256-GCM-SHA384`、`ECDHE-RSA-AES256-GCM-SHA384` |

| 保存时校验 | 错误 |
| --- | --- |
| 每张证书已签发、未过期 | 「证书尚未签发或已过期」 |
| 每张证书节点能加载 | 「EC 私钥使用显式曲线参数，请转换为命名曲线」「证书的 EC 公钥使用显式曲线参数，请用命名曲线私钥重新签发」 |
| 网站每个域名被某一张证书覆盖（第一张 ACME 证书正在为新域名重新签发时，这些域名除外） | 「证书域名与网站或 DNS 区域不匹配：…」 |
| 客户端证书不与 HTTP/3 同时开启 | 「客户端证书与 HTTP/3 不能同时开启」 |
| 客户端 CA 有效 | 「客户端 CA 须为 1–10 张当前有效的 CA 证书（PEM）」 |
| 跳转端口为 443 或网站的 HTTPS 端口 | 「跳转端口 {port} 不是网站的 HTTPS 端口」 |
| 不跳转的域名是网站的精确或泛域名 | 「网站没有这些域名：…」 |
| 去掉证书后网站仍有可用端口 | 「网站至少需要一个可用端口」 |

### HTTPS 跳转选项

打开「强制 HTTPS」后，开关下方出现跳转选项：

| 字段 | 取值 | 默认值 | 作用 |
| --- | --- | --- | --- |
| 跳转状态码 | 301、302、303、307、308 | 301 | 跳转响应的状态码 |
| 跳转端口 | 443 或网站绑定的 HTTPS 端口 | 443 | 跳转目标 URL 的端口；443 时 URL 不带端口 |
| 不跳转的域名 | 网站的精确与泛域名，最多 50 个 | 无 | 这些域名不因「强制 HTTPS」跳转；泛域名写作 `*.example.com`，网站同时有的精确域名不受它影响。网站的精确与泛域名多于一个时才显示。后缀与正则域名匹配的主机名在证书不覆盖时本来就不跳转 |

[配置规则](rules.md)的 `forceHttps` 照旧按请求打开或关闭跳转：规则打开时也使用这里的状态码与端口，不跳转的域名同样跳转。网站去掉跳转端口所在的 HTTPS 端口时，保存被拒绝；删除网站的域名时它也从不跳转的域名中去掉。用到非默认值的配置需要 `edge-ports-v1`；集群有活动节点缺少它时这三项不可用，显示「集群中有节点不支持」。

验证：

```bash
curl -sI -H 'Host: www.example.com' http://<节点 IP>:8081/a
```

返回所选状态码，`location: https://www.example.com:9443/a`（跳转端口为 9443 时）。

### 多张证书

一个网站最多 4 张证书：「证书」为第一张，「添加证书」加入其余 3 张（「证书 2」…「证书 4」），每张旁的「移除证书」按钮去掉它。网站选择了第一张证书且还有未选用的可用证书时才显示「添加证书」。

| 项目 | 行为 |
| --- | --- |
| 覆盖 | 每个域名至少被其中一张证书覆盖，不要求每张都覆盖全部域名；否则保存被拒绝，列出未覆盖的域名（「证书域名与网站或 DNS 区域不匹配：…」）。例如 `a.example.com` 与 `b.example.com` 各用一张证书 |
| 握手选证书 | 每次握手只出示一张：在覆盖 SNI 的证书中只考虑客户端能用的密钥类型（ECDSA 要求签名算法含该证书曲线的方案，且使用 TLS 1.3 或提供档位内的 `ECDHE-ECDSA-*` 套件；都不能用时考虑全部），其中精确名称优先于泛域名，再优先 ECDSA，最后按网站中的顺序；没有证书覆盖 SNI 时用第一张 |
| ECDSA 与 RSA | 同一组名称各有一张 ECDSA 与 RSA 证书时，现代客户端得到 ECDSA，只支持 RSA 的旧客户端得到 RSA |
| OCSP 装订 | 按所选证书装订其自己的 OCSP 响应 |
| 添加域名 | 新域名只扩展第一张证书（控制台申请且自动续期时），见[为 HTTPS 网站添加域名](#为-https-网站添加域名) |
| 删除证书 | 网站的任一证书都算被使用，删除返回「证书仍被网站使用：…」 |
| 节点能力 | 多于一张证书需要 `multi-certificate-v1`；集群有活动节点缺少它时「添加证书」不可用，显示「集群中有节点不支持」 |

验证（节点应用该版本后）：

```bash
openssl s_client -connect <节点 IP>:443 -servername a.example.com </dev/null 2>/dev/null | grep -E 'subject=|Server public key'
openssl s_client -connect <节点 IP>:443 -servername a.example.com -tls1_2 -cipher ECDHE-RSA-AES128-GCM-SHA256 -sigalgs 'rsa_pss_rsae_sha256:RSA+SHA256' </dev/null 2>/dev/null | grep 'Server public key'
```

第一条显示覆盖 `a.example.com` 的证书（ECDSA 为 `256 bit`），第二条模拟只支持 RSA 的客户端，显示 `2048 bit`。

### 客户端证书

「HTTPS」页签的「客户端证书」要求访客在握手中出示网站信任的 CA 签发的证书（双向 TLS），例如只给内部系统或合作方访问的网站。

| 字段 | 取值 | 默认值 | 作用 |
| --- | --- | --- | --- |
| 客户端证书 | 关闭 / 可选 / 必须 | 关闭 | 可选：握手时请求证书，没有或无法验证时照常处理请求，结果可在规则中使用；必须：没有通过验证的证书时返回 403。网站没有证书、开启了 HTTP/3 或节点不支持时不可选 |
| 校验深度 | 1–5 | 2 | 客户端证书链的最大深度 |
| CA 证书（PEM） | 1–10 张当前有效的 CA 证书（`CA:TRUE`），最大 64 KiB；密钥要求与上传的叶证书相同，EC 须为命名曲线 | 无 | 签发客户端证书的 CA；只保存重新编码的证书 |
| 向源站传递证书信息 | 开 / 关 | 关 | 向源站发送下表的请求头 |

「校验深度」「CA 证书（PEM）」「向源站传递证书信息」在选择「可选」或「必须」后显示。

| 项目 | 行为 |
| --- | --- |
| 「必须」 | 没有证书、证书不是该 CA 签发或已过期时返回 403 错误页，`X-Edgeweir-Error: client-cert-required`，在网站其他逻辑之前。握手本身不中止，浏览器能看到错误页 |
| 明文 HTTP | 「必须」的网站经 HTTP 到达的请求：开启「强制 HTTPS」时照常跳转，否则返回同样的 403；HTTP-01 挑战照常应答 |
| 请求头 | `X-Client-Verify`（`SUCCESS`、`FAILED` 或 `NONE`）总是发送；`X-Client-Cert-SHA256`（DER 的 SHA-256，小写十六进制）、`X-Client-Cert-Subject`（RFC 2253 格式的主体）与 `X-Client-Cert-Serial`（大写十六进制序列号）只在证书通过验证时发送 |
| 访客自带的头 | 所有网站都删除访客请求中的这四个头，源站收到的值只来自节点 |
| 规则字段 | `tls.client.verified`（布尔）、`tls.client.cert_sha256`、`tls.client.subject`（字符串），未通过验证时为 `false` 与空字符串，见[规则字段](rules.md#字段) |
| 会话复用 | 复用的会话保留首次握手的验证结果 |
| HTTP/3 | 与 HTTP/3 不能同时开启：开启客户端证书后 HTTP/3 开关不可用；HTTP/3 已开启时显示「客户端证书与 HTTP/3 不能同时开启」 |
| 节点能力 | `client-cert-v1`；集群有活动节点缺少它时不可选，显示「集群中有节点不支持」 |

验证：

```bash
curl -s -o /dev/null -w '%{http_code}\n' --resolve m.example.com:443:<节点 IP> https://m.example.com/
curl -s --cert client.pem --key client.key --resolve m.example.com:443:<节点 IP> https://m.example.com/
```

「必须」时第一条返回 403，第二条返回源站内容；开启传递时源站收到 `X-Client-Verify: SUCCESS`。

### 为 HTTPS 网站添加域名

在网站的「域名」页签保存新的域名时：

| 网站的证书 | 行为 |
| --- | --- |
| 网站的某一张证书已覆盖新域名（含上一级的泛域名 `*.example.com`） | 直接保存 |
| 第一张证书是控制台申请且开启自动续期的证书 | 保存，证书的域名列表加入新域名并立即重新签发（提示「证书 {name} 正在为新域名重新签发」，写审计 `certificate.names_extended`）。签发完成前新域名先走 HTTP：不接受 TLS 握手、不跳转 HTTPS、没有 HSTS，其他域名照常使用当前证书；新证书签发后新域名改为 HTTPS。集群有活动节点缺少 `tls-pending-domains-v1` 时，新域名在新证书签发后才生效。HTTP-01 挑战在此期间照常应答。证书正在签发时，本次签发结束后立即再签发一次 |
| 上传的证书，或未开启自动续期的证书 | 拒绝，返回「证书域名与网站或 DNS 区域不匹配：…」，列出未覆盖的域名 |

HTTP-01 证书不能扩展到泛域名，DNS-01 证书只能扩展到其 DNS 凭据区域内的名称；一张证书最多 100 个名称。`.` 后缀与正则域名不扩展证书：节点只为证书覆盖的主机名（同名或上一级 `*.`）完成握手，其余主机名中止握手，见[后缀与正则域名的限制](domains.md#后缀与正则域名的限制)。

### TLS 会话复用

| 项目 | 行为 |
| --- | --- |
| 会话缓存 | 每个节点 16 MiB 共享内存（约 6.4 万个会话），会话有效 1 小时；TLS 1.2 的会话 ID 只在同一节点复用 |
| 会话票据 | TLS 1.2 与 TLS 1.3 的票据用集群共享的密钥加密，同一集群的节点都能复用；每个集群 3 把密钥，角色每 12 小时轮换（发布原因「轮换 TLS 会话票据密钥」，审计 `cluster.session_ticket_keys_rotate`），节点用当前密钥加密、用 3 把密钥解密，票据在 1 小时会话有效期内可复用 |
| 网站隔离 | 会话只在创建它的网站复用：带着 A 网站的会话以 B 网站的 SNI 连接时完整握手 |
| 0-RTT | 不接受 TLS 1.3 early data：票据不允许 early data，节点配置显式关闭 |
| 票据密钥 | 集群配置第一次带有证书网站时由控制台生成，信封加密保存；节点经 mTLS 获取后写入状态目录（0600）；旧节点忽略它们，不复用会话。界面不显示票据密钥 |

验证：

```bash
openssl s_client -connect <节点 IP>:443 -servername www.example.com -sess_out sess.pem </dev/null
openssl s_client -connect <节点 IP>:443 -servername www.example.com -sess_in sess.pem </dev/null | grep -E '^(New|Reused)'
```

第二条输出 `Reused, TLSv1.3`（加 `-tls1_2` 时为 `TLSv1.2`）。

### OCSP 装订

| 项目 | 行为 |
| --- | --- |
| 响应校验 | 只接受签名、证书身份和有效期都通过验证且状态为 good 的响应；签发者证书须在证书链中 |
| 出站限制 | 拒绝私网等特殊用途地址和跳转；连接 5 秒、单次请求 8 秒，响应最大 1 MiB |
| 刷新 | 每 5 分钟及每次应用配置时检查，剩余有效期少于 1 小时时刷新 |
| 无 OCSP 地址 | 证书没有 OCSP 服务地址时不装订 |

### 压缩

网站「缓存」页签的「压缩」卡片中，Zstandard、Brotli、Gzip 各有一组设置，单独保存（不影响「HTTPS」页签未保存的修改）：

| 字段 | 取值 | 默认值 | 作用 |
| --- | --- | --- | --- |
| 开启 | 开 / 关 | Gzip 开，Brotli、Zstandard 关 | 按该算法压缩响应 |
| 压缩级别 | Brotli 1–11，Zstandard 1–19，Gzip 1–9 | Brotli 6，Zstandard 3，Gzip 空（占位文字「默认」，节点默认 1） | 级别越高压缩率越高、CPU 开销越大；Gzip 级别不是默认值时需要节点能力 `site-content-v1` |
| 最小压缩大小（字节） | 1–1048576 | 256 | 小于该长度的响应不压缩 |
| 压缩内容类型 | MIME 类型，逗号或空格分隔，最多 32 个 | `text/html`、`text/plain`、`text/css`、`application/javascript`、`application/json`、`image/svg+xml` | 压缩的响应类型；`text/html` 始终压缩 |
| 最大压缩长度（字节） | 不小于 0，三种算法共用 | 空（占位文字「不限」） | `Content-Length` 超过该值的响应不压缩；长度未知（分块）的响应照常压缩。需要 `site-content-v1` |

| 行为 | 说明 |
| --- | --- |
| 生效 | 保存经 `PUT /sites/{id}/https` 写入，发布网站所在集群（原因「已更新 {网站} 的证书配置」）；没有证书的网站同样压缩 |
| 协商 | 按请求 `Accept-Encoding` 的 q 值选择一种已开启的算法；q 值相同时顺序为 zstd > br > gzip，`q=0` 表示不接受。每个响应只由一种算法压缩 |
| `Vary` | 压缩的响应带 `Vary: Accept-Encoding` |
| 不重复压缩 | 响应已有 `Content-Encoding`（如源站已压缩）时原样返回 |
| 缓存 | 缓存保存未压缩或源站原样的内容，每次响应时按请求压缩；缓存命中后编码同样按请求协商 |
| 规则 | 覆盖设置可按请求关闭或重新允许某种算法，压缩规则可限定本次响应的算法与 q 值相同时的顺序；只在已开启的算法中选择，不绕过缓存，见[覆盖设置](rules.md#覆盖设置) |
| 能力 | 开启 Brotli 需要集群全部活动节点支持 `brotli-v1`，Zstandard 需要 `zstd-v1`。有节点不支持时开关不可用，并显示「集群中有节点不支持」；已开启的算法仍可关闭 |

验证（节点应用该版本后）：

```bash
curl -s -o /dev/null -D - -H 'Accept-Encoding: zstd' --resolve www.example.com:443:<节点 IP> https://www.example.com/
curl -s -o /dev/null -D - -H 'Accept-Encoding: br' --resolve www.example.com:443:<节点 IP> https://www.example.com/
```

分别返回 `content-encoding: zstd` 与 `content-encoding: br`，并带 `vary: Accept-Encoding`。

### 监听端口

| 端口 | 协议 | 条件 |
| --- | --- | --- |
| 80/TCP | HTTP、HTTP-01 挑战 | 始终监听；HTTP-01 挑战始终在 80 应答，与网站选择的端口无关 |
| 443/TCP | HTTPS（HTTP/1.1、HTTP/2） | 集群中有选择了证书的已启用网站绑定 443 |
| 集群的附加 HTTP 端口 | HTTP | 始终监听，见[集群的监听端口](#集群的监听端口) |
| 集群的附加 HTTPS 端口 | HTTPS（HTTP/1.1、HTTP/2） | 始终监听 |
| HTTPS 端口的同号 UDP | HTTP/3（QUIC） | 该端口上有开启 HTTP/3 的网站 |

HTTPS 请求的 SNI 必须与 `Host` 一致，否则返回 421（`X-Edgeweir-Error: sni-host-mismatch`；交给[默认网站](domains.md#未知域名与节点-ip-访问)的请求除外）。`Alt-Svc` 的端口取请求的 `Host` 中的端口（没有端口时为 443）。增删端口是结构性变更：节点重新渲染 `nginx.conf` 并 reload，已有连接由旧 worker 继续服务。

### 集群的监听端口

1. 打开 **集群与节点**，选择集群，切换到「设置」页签（`/clusters?tab=network`）。
2. 在「监听端口」卡片的「附加 HTTP 端口」「附加 HTTPS 端口」中填写端口，逗号或空格分隔；80 与 443 显示为「始终监听」。
3. 点击「保存」。控制台提示「已保存」，并发布新的配置版本（原因「修改监听端口」）。
4. 在节点主机的防火墙与云安全组中放行这些端口（HTTPS 端口有 HTTP/3 网站时同时放行 UDP），见[端口与防火墙](../deploy/nodes.md#端口与防火墙)。

| 项目 | 规则 |
| --- | --- |
| 端口 | 1–65535，不含 80、443；附加 HTTP、附加 HTTPS 端口各最多 16 个，去重排序；表单不合法时提示「端口须为 1–65535，不含 80、443，每类最多 16 个」；同一端口不能同时是 HTTP 和 HTTPS（「端口 {port} 不能同时用于 HTTP 和 HTTPS」） |
| 端口池 | 不能落在集群的 [L4 端口池](l4.md#设置端口池)内（「端口 {port} 在端口池内：…」）；端口池也不能包含监听端口 |
| 移除 | 仍有网站绑定的端口不能移除（「端口 {port} 仍被网站使用：…」） |
| 未变化 | 端口与当前相同时不发布、不写审计 |
| 审计 | `cluster.listen_ports_update`，元数据为修改前后的端口与版本号 |
| 节点能力 | 有附加端口的配置需要 `edge-ports-v1`；集群有活动节点缺少它时卡片显示「集群中有节点不支持」，只能移除端口 |

### 网站端口

网站「域名」页签的「端口」卡片选择网站在哪些端口提供服务：「HTTP」为 80 与集群的附加 HTTP 端口，「HTTPS」为 443 与集群的附加 HTTPS 端口。默认 80 与 443。点击「保存」后发布网站所在集群。

| 项目 | 规则 |
| --- | --- |
| 至少一个 | 网站至少要在一个可用端口上提供服务（表单提示「至少选择一个端口」，API 返回「网站至少需要一个可用端口」）；没有证书时 HTTPS 端口不算可用 |
| HTTPS 端口 | 需要证书：没有证书时只能保留默认的 443，卡片显示「HTTPS 端口需要证书」（API 返回「HTTPS 端口 {port} 需要证书」）；去掉证书时网站必须还有 HTTP 端口 |
| 集群端口 | 只能选择集群的监听端口（「端口 {port} 不是集群的监听端口」） |
| 跳转端口 | 去掉「HTTPS 跳转选项」的跳转端口被拒绝（「跳转端口 {port} 不是网站的 HTTPS 端口」） |
| 未绑定的端口 | 请求到达网站未绑定的端口时按[未知域名](domains.md#未知域名与节点-ip-访问)处理：默认 HTTP 返回 404 平台页（`X-Edgeweir-Error: unknown-host`），HTTPS 中止 TLS 握手 |
| ACME | HTTP-01 挑战始终在 80 应答；源站自己的 HTTP-01 token 在 80 仍转给源站 |
| 缓存 | 缓存键不含端口：同一网站各端口共用缓存对象 |
| 节点能力 | 绑定非默认端口需要 `edge-ports-v1`；集群有活动节点缺少它时 80、443 以外未选中的端口不可选，显示「集群中有节点不支持」。网站保持默认端口时配置与之前逐字节相同，不需要 `edge-ports-v1` |

## 源站保护

让源站只接受边缘节点的连接：节点回源时出示控制台签发的客户端证书（源站验证它），源站使用控制台的 Origin CA 签发的证书（只有节点信任它）。两者可以单独或一起使用，在 **证书** 页的「源站证书」与「回源客户端」页签管理，在网站「源站」页签的「源站池设置」中开启（「回源 TLS」下的「校验源站证书」「信任」「出示客户端证书」，见[源站与缓存](origins-and-cache.md)）。

### Origin CA

「源站证书」页签：没有 Origin CA 时显示「还没有 Origin CA」与「创建 Origin CA」；创建后页面操作为「签发证书」。Origin CA 只用于回源：浏览器和其他客户端不信任它，它签发的证书也不能作为网站证书上传（「Origin CA 签发的证书只能用于源站」）。

| 项目 | 说明 |
| --- | --- |
| Origin CA | ECDSA P-256，有效期 20 年，私钥信封加密保存在控制台；与节点通道的 CA、回源客户端 CA 各自独立。卡片显示「有效期至 …」、「CA 指纹」与「下载 CA 证书」 |
| 主机名 | 1–50 个，每行一个：域名、`*.` 泛域名或 IP 地址，重复的只保留一个；须覆盖节点回源时校验的名称（源站的「SNI」，没有时为「回源 Host」或地址） |
| 有效期 | 1、3、5、10、15 年，默认 15 年；不超过 Origin CA 的到期时间 |
| 密钥类型 | ECDSA P-256（默认）或 RSA 2048 |
| CSR（可选） | 提交 CSR 时私钥留在源站，控制台只取它的公钥（RSA 2048–4096 或 ECDSA P-256 / P-384，最大 16 KiB），主机名以表单为准；签名无效或密钥不支持时报错 |
| 私钥 | 控制台生成的私钥只在「证书已签发」对话框中显示一次（「私钥只显示一次」），可「下载私钥」，不保存 |
| 下载 | 证书行的「下载证书」与页签的「下载 CA 证书」都为 PEM；源站只需配置自己的证书与私钥 |
| 吊销 | 「吊销」需要确认（「吊销 {name} 的证书？」）；控制台重新签发吊销列表（CRL）并随配置下发，信任 Origin CA 的集群立即发布新配置（原因「吊销源站证书」）；节点随后拒绝该证书，主动健康检查同样拒绝。证书标为「已吊销」；吊销不能撤销，回滚配置也保留吊销 |

审计：`origin_ca.create`、`origin_certificate.issue`、`origin_certificate.revoke`。

在源站使用签发的证书，例如 nginx：

```nginx
ssl_certificate     /etc/nginx/origin.pem;
ssl_certificate_key /etc/nginx/origin.key;
```

然后把网站「源站池设置」的「信任」改为「Origin CA」（需要开启「校验源站证书」）。此后该网站只接受 Origin CA 签发且未吊销的源站证书，公共 CA 签发的证书一律拒绝；S3 源站使用公共证书，不能与它一起用（「S3 源站不能用 Origin CA 校验」）。

### 回源客户端证书

「回源客户端」页签：没有回源客户端 CA 时显示「还没有回源客户端 CA」与「创建回源客户端 CA」。创建后点击「下载 CA 证书」并配置到源站，例如 nginx：

```nginx
ssl_client_certificate /etc/nginx/origin-client-ca.pem;
ssl_verify_client      on;
```

然后打开网站「源站池设置」的「出示客户端证书」。

| 项目 | 说明 |
| --- | --- |
| 回源客户端 CA | ECDSA P-256，有效期 10 年，私钥信封加密 |
| 集群证书 | 「集群证书」卡片列出每个集群一张，CN 为集群 ID，`O=Edgeweir Origin Client`，只用于 TLS 客户端认证，有效期 90 天；第一个开启的网站保存时签发，剩余不足 30 天时由每小时运行的后台任务更换；还没有网站开启时显示「还没有网站出示客户端证书」 |
| 更换 | 新证书随新配置下发（原因「更换回源客户端证书」）；旧证书到期前仍然有效，已建立的连接不中断 |
| 出示范围 | 该网站的 HTTPS 源站，HTTP/1.1、HTTP/2 与 gRPC 回源都出示，主动健康检查同样出示；S3 源站不出示 |
| 私钥 | 只经节点通道（mTLS）下发，节点上的私钥文件权限为 0600 |
| 连接复用 | 出示证书与不出示证书的请求、信任方式不同的请求不复用同一条回源连接 |

源站可以按客户端证书的 CN（集群 ID）进一步限制，例如 nginx 的 `$ssl_client_s_dn`。

### 轮换 CA

两个 CA 都可以换成新的，换的过程中新旧 CA 并存，已有的连接与证书不中断。新 CA 的名称带代数（如 `Edgeweir Origin CA G2`），私钥同样信封加密；每一步都需要确认并写审计日志。

Origin CA（「源站证书」页签）：

1. 「轮换 CA」（确认「开始轮换 Origin CA？」）：新 CA 立即开始签发源站证书；信任 Origin CA 的集群发布新配置（原因「开始轮换 Origin CA」），节点同时信任新旧 CA，各自按自己的 CRL 检查吊销。这些集群里所有活动节点都要支持 `origin-ca-rotation-v1`，否则拒绝（「节点尚不支持：Origin CA 轮换（…）」）。审计 `origin_ca.rotation_start`。
2. 用新 CA 给各源站重新签发证书并部署。「旧 Origin CA」卡片显示它签发、仍然有效的证书数（「N 张有效证书」）；列表中旧 CA 签发的证书标为「旧 CA」。重叠期内仍可吊销旧 CA 的证书。
3. 「退役旧 CA」（确认「退役旧 Origin CA？」，并提示「节点不再信任旧 CA 签发的 N 张有效证书」）：删除旧 CA 与它的私钥，集群发布新配置（原因「退役旧 Origin CA」），节点不再信任旧 CA 签发的证书（列表中标为「CA 已退役」）。审计 `origin_ca.retire`。

新 CA 还没有签发仍有效的证书时可以「取消轮换」（确认「取消轮换并删除新 CA？」）：删除新 CA，旧 CA 恢复签发，集群发布新配置（原因「取消轮换 Origin CA」），审计 `origin_ca.rotation_cancel`。轮换期间回滚配置使用当前的两个 CA，退役后回滚也不会再信任旧 CA。

回源客户端 CA（「回源客户端」页签）：

1. 「轮换 CA」（确认「开始轮换回源客户端 CA？」）：生成「新回源客户端 CA」，但还不用它签发。点击「下载信任包」（新旧两张 CA 证书）替换源站上的 `ssl_client_certificate`。审计 `origin_client_ca.rotation_start`。
2. 「启用新 CA」（确认「启用新回源客户端 CA？」）：各集群改为出示新 CA 签发的证书并发布新配置（原因「更换回源客户端证书」）；旧证书到期前仍然有效。没能换上的集群在「旧回源客户端 CA」卡片上列出（「仍出示旧证书：…」），每小时重试。审计 `origin_client_ca.activate`。
3. 「退役旧 CA」（确认「退役旧回源客户端 CA？」）：所有集群都换上新证书后才能退役；之后源站只需信任新 CA，可以再下载一次信任包。审计 `origin_client_ca.retire`。

启用前可以「取消轮换」，审计 `origin_client_ca.rotation_cancel`。

| 错误 | 原因 |
| --- | --- |
| 「请先创建 Origin CA（证书 → 源站证书）」 | 网站选择信任 Origin CA，或签发证书时，Origin CA 还没有创建 |
| 「请先创建回源客户端 CA（证书 → 回源客户端）」 | 网站开启出示客户端证书时，回源客户端 CA 还没有创建 |
| 「信任 Origin CA 需要先开启校验源站证书」 | 关闭校验时不能选择信任 |
| 「已经在轮换」 | 上一次轮换还没有退役旧 CA 或取消 |
| 「轮换的当前阶段不能执行这一步」 | 例如没有新 CA 时启用，或没有旧 CA 时退役 |
| 「这些集群仍在出示旧 CA 签发的证书：…」 | 退役旧回源客户端 CA 时，还有集群没换上新证书 |
| 「新 CA 已签发 N 张有效证书，不能取消」 | 取消 Origin CA 轮换时新 CA 签发的证书还有效；先吊销它们，或继续轮换 |
| 「CSR 无法读取、签名无效，或密钥不是 RSA 2048–4096、ECDSA P-256 / P-384」 | 签发时提交的 CSR 不可用 |
| 「证书已经吊销」 | 重复吊销 |

## 节点上的证书

| 项目 | 行为 |
| --- | --- |
| 下发 | 节点通过 mTLS 单独获取证书材料；只有集群节点可能运行的配置版本（稳定版本、候选版本与最新版本）引用的证书 ID 与指纹获准下发 |
| 校验 | 节点检查指纹、私钥匹配和域名覆盖（等待新证书、先走 HTTP 的域名除外）；节点 1.1.0 及以上跳过无法加载的证书并上报，见[上传证书](#上传证书)；更早的节点有一张证书无法加载时整个配置版本不应用，继续使用上一份配置，每次同步重试 |
| 存储 | 节点状态目录的 `certificates.json`（0600）；节点上的私钥不加密，主机管理员可读取 |
| 热更新 | 证书内容与最低 TLS 版本变化不重载 nginx |
| 票据密钥 | 轮换时节点写入新密钥文件并重载 nginx |
| 重载 | HTTP/2、HTTP/3、压缩、密码套件、是否有证书、域名列表或网站集合变化时，先执行配置测试再重载；失败时恢复原配置 |
| 应用成功 | 配置持久化成功后才报告已应用；当前与上一份 last-known-good 配置引用的密钥都保留 |
| 回滚 | 配置回滚使用仍可用的当前证书材料；证书已删除、过期、节点无法加载或不覆盖目标域名时拒绝回滚 |

## 密钥处理

ACME 账户私钥、证书私钥、EAB HMAC 密钥（证书的与系统设置中自定义目录的）、DNS 凭据、TLS 会话票据密钥、Origin CA 与回源客户端 CA 的私钥（轮换产生的新 CA 也一样）以及集群回源客户端证书的私钥分别使用绑定记录 ID 的主密钥信封加密。证书助手 `edgeweir-certd` 由后台任务启动，凭据只经 stdin/stdout 传递，不出现在命令行、日志或节点配置中。

## 节点能力

| 能力 | 需要的场景 |
| --- | --- |
| `tls-v1` | 集群有网站（网站的 HTTPS 与压缩设置总是下发） |
| `http01-v1` | HTTP-01 验证 |
| `http3-v1` | 任一网站开启 HTTP/3 |
| `brotli-v1` | 任一网站开启 Brotli |
| `zstd-v1` | 任一网站开启 Zstandard |
| `site-content-v1` | 任一网站设置了 Gzip 级别或最大压缩长度（及其他内容设置） |
| `tls-pending-domains-v1` | HTTPS 网站新增的域名在证书覆盖前先走 HTTP；缺少时这些域名在新证书签发前不生效，不阻止发布 |
| `edge-ports-v1` | 集群有附加监听端口、网站绑定了非默认端口，或 HTTPS 跳转用了非默认的状态码、端口或不跳转的域名 |
| `multi-certificate-v1` | 任一网站有多于一张证书 |
| `client-cert-v1` | 任一网站开启客户端证书，或规则用到 `tls.client.*` 字段 |
| `certificate-isolation-v1` | 不要求；有它的节点（1.1.0 及以上）跳过无法加载的证书并上报 |
| `origin-mtls-v1` | 任一网站回源时出示客户端证书 |
| `origin-ca-v1` | 任一网站信任 Origin CA |
| `origin-ca-rotation-v1` | Origin CA 轮换期间任一网站信任 Origin CA |

在控制台或用 AccessKey 保存的改动，即使需要集群中部分活动节点缺少的能力也会发布；缺少能力的节点保留 last-known-good 配置，**集群与节点** 中显示「需要升级」，见[节点升级](node-upgrades.md)。服务账号与后台任务发布的配置引入活动节点缺少的能力时被拒绝（`NODE_CAPABILITY_REQUIRED`），原配置不变。HTTP-01 申请与 Origin CA 轮换在节点缺少能力时直接拒绝。

## API

路径相对 `/api/v1`，使用 AccessKey（`x-api-key`）认证；这些过程不对服务账号开放（403 `SERVICE_ACCOUNT_FORBIDDEN`），见 [API 与端点](../reference/api.md#accesskey)。错误码见[错误码](../reference/errors.md)。

| 过程 | 方法与路径 | 说明 |
| --- | --- | --- |
| `certificates.list` | `GET /certificates` | 全部证书：`id`、`name`、`names`、`source`（`upload` / `acme`）、`status`（`pending` / `issuing` / `ready` / `error`）、`fingerprint`、`notBefore`、`notAfter`、`autoRenew`、`renewAt`、`lastError`（失败代码或空）、`bindSiteId`、`nodeFailures` |
| `certificates.settings` | `GET /certificates/settings` | `acmeDirectory`（生效的自定义目录或 `null`）、`acmeDirectoryEab`、`defaultCa`（`letsencrypt` / `custom`） |
| `certificates.upload` | `POST /certificates/upload` | `{ name, chainPem, privateKeyPem }`；`chainPem` 32–131072 字符，`privateKeyPem` 32–32768 字符 |
| `certificates.request` | `POST /certificates/request` | `name`、`names`、`email`、`ca`（`letsencrypt` / `zerossl` / `google` / `custom`，省略时为 `defaultCa`）、`keyType`（`ec256` / `rsa2048`）、`challenge`（`http01` / `dns01`）、`dnsCredentialId`（DNS-01 必填）、`eabKid`、`eabHmacKey`、`autoRenew`（默认 `true`）、`skipDnsCheck`（默认 `false`）、`bindSiteId`（签发后绑定到该网站，`names` 须覆盖网站全部域名，每个网站同时只有一个，409 `CERTIFICATE_BUSY`） |
| `certificates.renew` | `POST /certificates/{id}/renew` | 只用于 ACME 证书；上传的证书或「签发中」时 409 `CERTIFICATE_BUSY` |
| `certificates.delete` | `DELETE /certificates/{id}` | 409 `CERTIFICATE_IN_USE`、`CERTIFICATE_IN_USE_BY_L4`、`CERTIFICATE_BUSY` |
| `acmeAccounts.list` | `GET /acme-accounts` | `{ id, directoryUrl, ca, email, eabKid, createdAt, certificates }` |
| `acmeAccounts.delete` | `DELETE /acme-accounts/{id}` | 409 `ACME_ACCOUNT_IN_USE` |
| `dnsCredentials.list` | `GET /dns-credentials` | `{ id, name, provider, zone }`，不返回凭据 |
| `dnsCredentials.create` | `POST /dns-credentials` | `{ name, provider, zone, credentials }`；API 保存前不测试，先调用 `dnsCredentials.test` |
| `dnsCredentials.update` | `PUT /dns-credentials/{id}` | `name` 和 / 或 `credentials`（全部字段） |
| `dnsCredentials.delete` | `DELETE /dns-credentials/{id}` | 409 `DNS_CREDENTIAL_IN_USE` |
| `dnsCredentials.zones` | `POST /dns-credentials/zones` | `{ id }` 或 `{ provider, credentials }`；返回最多 1000 个区域；服务商不能列出区域时 `DNS_ZONES_UNSUPPORTED` |
| `dnsCredentials.test` | `POST /dns-credentials/test` | `{ id }` 或 `{ provider, credentials, zone }`；返回 `{ ok, records }` |
| `https.get` | `GET /sites/{id}/https` | 网站的 HTTPS 与压缩设置 |
| `https.update` | `PUT /sites/{id}/https` | `settings` 整体替换，缺省字段取默认值；先 `GET` 再修改。发布网站所在集群 |
| `https.check` | `GET /sites/{id}/https/check` | 查询参数 `ca`；返回一键启用 HTTPS 的 `request`、`blockers` 与覆盖全部域名的 `certificates` |
| `sites.update` | `PATCH /sites/{id}` | `ports`：`{ http, https }`，各最多 17 个，去重排序 |
| `sites.features` | `GET /sites/{id}/features` | 各功能在网站所在集群的可用性，含 `edgePorts`、`multiCertificate`、`clientCertificate`、`brotli`、`zstd`、`siteContent` |
| `clusters.listenPorts` | `GET /clusters/{clusterId}/listen-ports` | `httpPorts`、`httpsPorts`（不含 80、443）、`nodesWithout`（缺少 `edge-ports-v1` 的活动节点） |
| `clusters.setListenPorts` | `PUT /clusters/{clusterId}/listen-ports` | `{ httpPorts, httpsPorts }` 整体替换 |
| `originCa.get` / `originCa.create` | `GET` / `POST /origin-ca` | Origin CA（`authority`、`previous`、`previousCertificates`）；已存在时 `create` 原样返回 |
| `originCa.rotate` / `originCa.retire` / `originCa.cancel` | `POST /origin-ca/rotation`、`POST /origin-ca/rotation/retire`、`DELETE /origin-ca/rotation` | 轮换的三步 |
| `originCertificates.list` / `originCertificates.issue` | `GET` / `POST /origin-certificates` | `issue`：`hostnames`、`validityYears`（1、3、5、10、15，默认 15）、`keyType`（`ec256` / `rsa2048`）、`csrPem`；响应的 `privateKeyPem` 只返回一次（CSR 时为空） |
| `originCertificates.revoke` | `POST /origin-certificates/{id}/revoke` | 吊销 |
| `originClientCa.get` / `originClientCa.create` | `GET` / `POST /origin-client-ca` | 回源客户端 CA（`authority`、`next`、`previous`、`trustBundlePem`、`certificates`、`pendingClusters`） |
| `originClientCa.rotate` / `activate` / `retire` / `cancel` | `POST /origin-client-ca/rotation`、`POST …/rotation/activate`、`POST …/rotation/retire`、`DELETE /origin-client-ca/rotation` | 轮换的各步 |
| `settings.acmeDirectory` / `settings.setAcmeDirectory` | `GET` / `PUT /settings/acme-directory` | 自定义 ACME 目录，见[系统设置](system.md#证书颁发机构) |

## 限制

| 项目 | 说明 |
| --- | --- |
| 证书颁发机构 | 内置 Let's Encrypt、ZeroSSL 与 Google Trust Services；其他 CA 通过一个自定义 ACME 目录使用，见[系统设置](system.md#证书颁发机构) |
| 证书数量 | 每个网站最多 4 张；一张 ACME 证书最多 100 个名称；ACME 密钥类型只有 ECDSA P-256 与 RSA 2048 |
| 客户端证书 | 不能与 HTTP/3 同时开启；不检查吊销（CRL、OCSP） |
| 会话复用 | TLS 1.2 会话用同一网站的另一个域名复用时返回 421（`sni-host-mismatch`），浏览器按主机名保存会话，不受影响；[L4 应用的 TLS 卸载](l4.md#tls-卸载)不复用会话 |
| 0-RTT | 不支持 TLS 1.3 early data |
| TLS 版本 | 不支持 TLS 1.0 和 1.1 |
| 密码套件 | 只有「现代」「兼容」两档，不能写入任意 nginx 配置 |
| 压缩 | Gzip、Brotli、Zstandard |
| 节点软件包 | 节点使用为 Edgeweir 构建的 OpenResty 1.31.1.1（`edgeweir-openresty`），含 HTTP/2、HTTP/3、Brotli 与 Zstandard，见[接入节点](../deploy/nodes.md) |
| 失败原因 | 证书行显示分类后的原因：CA 的问题类型（RFC 8555）、DNS 服务商错误或控制台一侧的原因；未知代码显示为「签发失败（{代码}）」。CA 或 DNS 服务商返回的原文不保存、不记录；控制台日志的 `certificate operation failed` 记录证书 ID、`code` 与控制台一侧的原因 |

## 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 「证书链须包含 1–10 张可读取的 PEM 证书」 | 证书链为空、超过 10 张或内容损坏 | 重新导出 PEM 格式的证书链 |
| 「证书链只能包含证书，私钥请填到私钥栏」 | 证书链中有私钥或其他 PEM 块 | 证书链只保留 `CERTIFICATE` 块，私钥填到「私钥（PEM）」 |
| 「无法读取私钥；不支持加密的私钥」 | 私钥损坏或带口令 | `openssl pkey -in key.pem -out plain.pem` 去掉口令后上传 |
| 「私钥与证书不匹配」 | 私钥属于另一张证书 | 上传与叶证书配对的私钥 |
| 「EC 私钥使用显式曲线参数，请转换为命名曲线」 | 私钥写出了完整曲线参数而不是曲线名称，节点无法加载；保存网站 HTTPS 时出现表示所选证书是此前上传的这类证书。macOS 自带的 LibreSSL 用 `openssl req -newkey ec` 或 `openssl genpkey` 生成时默认如此 | 用 OpenSSL 3 转换后上传：`openssl pkey -in key.pem -ec_param_enc named_curve -out key-named.pem`（LibreSSL 不能转换）；以后生成私钥时加 `-pkeyopt ec_param_enc:named_curve` |
| 「证书的 EC 公钥使用显式曲线参数，请用命名曲线私钥重新签发」 | 证书本身的公钥使用显式曲线参数，例如 LibreSSL 生成的自签名证书；保存网站 HTTPS 时出现表示所选证书是此前上传的这类证书 | 用转换后的私钥重新签发，或重新生成：`openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -pkeyopt ec_param_enc:named_curve …` |
| 证书状态「不可用」，原因「节点无法加载：证书的 EC 公钥使用显式曲线参数」或「节点无法加载：EC 私钥使用显式曲线参数」 | 此前上传的证书使用显式曲线参数 | 按上面两行转换或重新签发后上传，在使用它的网站中改选，再删除旧证书 |
| 证书行显示「… 无法加载此证书，已拒绝其 TLS 握手」，节点显示「N 张证书未加载」 | 节点无法加载该证书材料，且没有上一版可用 | 按上面几行检查证书；换用节点能加载的证书后发布的新版本即可应用 |
| 节点「应用失败」，原因含 `invalid certificate material`（如 `x509: invalid ECDSA parameters`、`unknown elliptic curve`） | 1.1.0 以前的节点遇到无法加载的证书，整个版本不应用 | 在证书列表中找到「不可用」的证书，按上面的行处理；或升级节点，见[节点升级](node-upgrades.md) |
| 「证书链顺序错误：叶证书在前，签发者依次在后」 | 中间证书排在叶证书前，或某张证书不是下一张签发的 | 按叶证书、中间证书的顺序重新组织 PEM |
| 「证书当前不在有效期内（… 至 …）」 | 证书未生效或已过期（时间为 UTC） | 核对服务器时间，或换用有效的证书 |
| 「证书没有 DNS 类型的 SAN」 | 证书只有 IP 地址或只有 CN | 换用含 DNS SAN 的证书 |
| 「不支持的密钥类型，请使用 RSA（2048 位及以上）或 ECDSA P-256、P-384、P-521」 | 叶证书的密钥节点无法加载（secp256k1、Brainpool、SM2 等曲线，Ed448、RSA-PSS、DSA，或公钥指数大于 2³¹−1 的 RSA），或者浏览器无法使用（P-224、Ed25519、ML-DSA、小于 2048 位的 RSA） | `openssl x509 -in cert.pem -noout -text` 的「Public Key Algorithm」一段显示密钥类型与位数；用 RSA 2048 位或 ECDSA P-256 私钥重新签发，例如 `openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -pkeyopt ec_param_enc:named_curve -out key.pem` |
| 「Origin CA 签发的证书只能用于源站」 | 上传的证书由控制台的 Origin CA 签发 | 网站使用公共 CA 的证书或 ACME 证书 |
| 「证书尚未签发或已过期」 | 网站选择的证书还在等待签发，或已过期 | 等待签发完成，或续期后再选择 |
| 「以下名称未解析到节点：…」 | HTTP-01 名称没有解析记录，或解析到源站、其他代理等不属于该集群节点的地址 | 把名称解析到节点；节点前面另有负载均衡或解析在变更中时，打开「跳过解析检查」 |
| 「集群 … 没有在线节点应答 HTTP-01」 | 服务这些名称的集群没有在线的活动节点 | 检查节点状态，或改用 DNS-01 |
| 「节点尚不支持：HTTP-01 验证（…）」 | 列出的在线节点缺少 `http01-v1` | 升级这些节点，见[节点升级](node-upgrades.md) |
| 「证书域名与网站或 DNS 区域不匹配：…」 | 列出的名称：HTTP-01 申请的名称不是任何网站的精确域名；DNS 凭据的区域不覆盖；所选证书不覆盖网站的这些域名；为网站添加的域名不在上传的证书中，或 HTTP-01 证书无法签发的泛域名、DNS-01 证书凭据区域外的域名 | 先把域名加入网站，或改用 DNS-01；改用匹配的 DNS 凭据或证书 |
| 证书状态「签发失败」 | 证书行上的原因，见下面几行 | 修正后点击「立即续期」；否则按[重试间隔](#续期)自动重试 |
| 「CA 未通过域名验证」「CA 收到的挑战应答不正确」「CA 无法连接到该域名」 | HTTP-01：域名未解析到节点、80 端口不通，或前面还有其他代理；DNS-01：TXT 记录写到了别的区域 | 核对 DNS 解析与 80 端口 |
| 「CA 无法解析该域名」 | 域名没有解析记录，或权威 DNS 不可用 | 添加解析记录 |
| 「CAA 记录不允许该 CA 签发」 | 域名的 CAA 记录未列出所选 CA | 在 CAA 中加入该 CA 的签发者（见[证书颁发机构](#证书颁发机构)），或删除 CAA |
| 「触发 CA 频率限制」 | 同一域名或账户短时间内申请过多 | 等待 CA 的限制窗口结束 |
| 「CA 要求 EAB 凭据」 | ZeroSSL、Google Trust Services 或自定义目录需要 EAB | 填写 EAB 密钥 ID 与 HMAC 密钥后重新申请；自定义目录可在系统设置中保存 |
| 「CA 账户需要处理（如接受新条款）」「ACME 账户在 CA 已不存在」 | CA 一侧的账户状态 | 在「ACME 账户」卡片删除不再使用的账户后重新申请，或按 CA 的要求处理 |
| 「无法连接 CA」「无法读取 ACME 目录」 | 控制台无法访问 CA 的 ACME 目录（出站网络、代理、自定义目录的 TLS 证书） | 检查运行后台任务的控制台进程的出站网络；自定义目录见下面「该地址没有返回 ACME 目录」 |
| 「TXT 记录 3 分钟内未生效」 | DNS 服务商同步慢，或凭据区域不是域名的权威区域 | 稍后重试；核对凭据区域 |
| 「服务商认证失败」等 DNS 服务商原因 | DNS-01 写入 TXT 时服务商返回错误 | 编辑 DNS 凭据，重新填写凭据后会立即重试 |
| 「没有能应答 HTTP-01（http01-v1）的在线节点」「节点未在 40 秒内应用挑战」 | 服务该域名的集群没有在线节点、节点缺少 `http01-v1` 或应用配置过慢 | 检查集群节点状态，必要时升级节点 |
| 「有域名不属于任何网站」 | 证书的名称都已不是网站的域名 | 把域名加入网站，或改用 DNS-01 |
| 「有域名未解析到节点」 | 签发前的解析检查发现名称未解析到集群的节点，没有联系 CA | 修正解析；5 分钟内自动重试，或点击「立即续期」 |
| 「签发失败，详见控制台日志」 | 未分类的错误 | 在运行后台任务的控制台进程日志中查找 `certificate operation failed`，按 `reason` 处理 |
| 证书长期停在「等待签发」 | 没有运行后台任务的控制台进程 | 确认存在 `ROLE=worker` 或 `ROLE=all` 的进程 |
| 「证书正在处理中」 | 证书处于「签发中」；网站已有一个等待绑定的申请；或对上传的证书续期 | 等待签发结束；在网站的「HTTPS」页签重试或取消该申请 |
| 「证书仍被网站使用：…」 | 列出的网站选择了该证书（第一张或其他证书） | 先在这些网站的「HTTPS」页签改选或移除证书 |
| 「证书仍被 L4 应用使用：…」 | 列出的 L4 应用用该证书做 TLS 卸载 | 先在这些 L4 应用中改选证书，见 [TLS 卸载](l4.md#tls-卸载) |
| 「检查「CA 证书（PEM）」」 | 客户端证书为「可选」或「必须」，但 CA 证书栏为空 | 粘贴签发客户端证书的 CA |
| 403，`X-Edgeweir-Error: client-cert-required` | 网站的客户端证书为「必须」，请求没有出示该 CA 签发的有效证书，或经明文 HTTP 到达 | 用 `curl --cert … --key …` 出示证书；核对 CA 证书与校验深度；需要 HTTP 时开启「强制 HTTPS」 |
| 出示了 CA 签发的客户端证书仍是 403，或源站收到 `X-Client-Verify: FAILED` | 证书链用 SHA-1 签名或密钥太弱（RSA 小于 2048 位）：节点的 OpenSSL 拒绝这类证书。macOS 自带的 LibreSSL `openssl x509 -req` 默认用 SHA-1 签名；证书已过期或尚未生效（核对节点时钟）；链深度超过「校验深度」 | `openssl x509 -in client.pem -noout -text \| grep 'Signature Algorithm'` 查看签名算法，加 `-sha256` 重新签发；核对有效期与深度 |
| 「客户端 CA 须为 1–10 张当前有效的 CA 证书（PEM）」 | CA 证书栏不是 CA 证书（`CA:TRUE`）、已过期、密钥不受支持、使用显式曲线参数或超过 10 张 | 粘贴签发客户端证书的 CA |
| 「客户端证书与 HTTP/3 不能同时开启」 | 网站开启了 HTTP/3 | 先关闭 HTTP/3 |
| 「跳转端口 {port} 不是网站的 HTTPS 端口」 | 跳转端口不是 443，也不在网站的 HTTPS 端口中；或在「端口」卡片去掉了它 | 改选跳转端口，或先在「端口」卡片绑定该端口 |
| 「请先在系统设置中配置自定义 ACME 目录」「已不再配置自定义 ACME 目录」 | 选择了自定义 ACME 目录，但系统设置与环境变量中都没有它的地址 | 在 **系统设置 → 证书颁发机构** 填写地址，或改选其他 CA |
| 「该地址没有返回 ACME 目录」 | 控制台读取不到该地址的 ACME 目录：地址错误、TLS 证书不受信任（未填写 CA 证书）、超时或返回的不是目录 | 用 `curl` 核对地址；私有 CA 时在「CA 证书（PEM）」中粘贴签发者 |
| 「请同时填写 EAB 密钥 ID 和 HMAC 密钥」 | 只填了 EAB 密钥 ID，且没有已保存的同一 ID 的密钥 | 同时填写两者，或都留空 |
| 「ACME 账户仍被证书使用：…」 | 列出的证书用该账户签发 | 先删除这些证书 |
| 「DNS 凭据仍被证书使用：…」 | 列出的证书使用该凭据做 DNS-01 验证 | 先删除这些证书 |
| 「该服务商不支持列出区域，请手动填写」 | 服务商不能列出区域 | 在「区域」中直接填写 |
| `openssl s_client -sess_in` 总是 `New` | 用了另一个网站的 SNI；节点版本早于会话复用；会话超过 1 小时；TLS 1.2 会话 ID（`-no_ticket`）换了节点 | 用同一 SNI 并核对节点版本 |
| 节点显示「需要升级」 | 节点缺少配置所需能力（如 `http3-v1`），保留 last-known-good 配置 | 升级节点，见[节点升级](node-upgrades.md) |
| 404，`X-Edgeweir-Error: unknown-host`（网站已配置） | 请求到达网站未绑定的端口 | 在「域名」页签的「端口」卡片绑定该端口，或改用网站的端口 |
| 附加 HTTPS 端口上 TLS 握手失败 | 网站没有绑定该端口，或网站没有证书 | 绑定端口并选择证书 |
| 附加端口连接超时 | 节点防火墙或安全组未放行；容器节点未发布端口 | 按[端口与防火墙](../deploy/nodes.md#端口与防火墙)放行 |
| 「端口 {port} 仍被网站使用：…」 | 移除集群附加端口时仍有网站绑定 | 先在这些网站的「端口」卡片取消该端口 |
| 421，`X-Edgeweir-Error: sni-host-mismatch` | TLS SNI 与 `Host` 不一致，例如客户端复用了其他域名的连接 | 客户端按请求的域名建立连接 |
| 浏览器不使用 HTTP/3 | 网站所在 HTTPS 端口的 UDP 未放通（如 UDP 443、UDP 9443）；节点缺少 `http3-v1`；客户端首次访问后才读取 `Alt-Svc` | 放通对应的 UDP 端口，检查节点能力 |
| 响应未压缩 | 内容类型不在列表中；响应小于最小压缩大小或大于最大压缩长度；客户端未发送 `Accept-Encoding`；源站响应已带 `Content-Encoding` | 检查「缓存」页签的「压缩」设置 |
| 拿到 gzip 而不是 br / zstd | 客户端的 `Accept-Encoding` 不含该算法或 q 值更低；该算法未开启 | 检查请求头与「压缩」设置 |
| Brotli / Zstandard 开关不可用 | 集群中有活动节点不支持 `brotli-v1` / `zstd-v1` | 升级节点 |
