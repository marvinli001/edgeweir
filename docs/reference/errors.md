# 错误码

API 错误响应格式、通用代码、全部 207 个接口错误码与配置版本原因码。

## 错误响应

`/api/v1` 的错误响应体：

```json
{
  "defined": false,
  "code": "SITE_NOT_FOUND",
  "status": 404,
  "message": "site not found",
  "data": {}
}
```

| 字段 | 说明 |
| --- | --- |
| `code` | 稳定的错误代码 |
| `status` | HTTP 状态码，与响应状态相同 |
| `message` | 英文说明，供不识别代码的客户端使用；文本不保证稳定 |
| `data` | 消息参数，键见下表 `data` 列；没有参数时为 `{}` |
| `defined` | 固定为 `false` |

| 接口 | 格式 |
| --- | --- |
| `/api/v1/*` | 上述对象 |
| `/rpc/*` | 上述对象包在 `json` 字段中：`{ "json": { … } }` |
| `/api/auth/*` | better-auth 的 `{ code, message }`；登录白名单与演示账号的拒绝为 `{ "code": "LOGIN_IP_NOT_ALLOWED" \| "DEMO_READ_ONLY", "message" }`；限速（`NODE_ENV=production`）返回 429，不带代码 |
| 未匹配的 `/api/*`、`/rpc/*`、`/downloads/*`、`/install.sh`、`/healthz`、`/node-channel` | 404，`{ "error": "not found" }` |

控制台界面按代码显示 `error_<代码小写>` 文案（`apps/console/messages/zh-CN.json`、`en.json`），用 `data` 中的参数替换 `{参数}`；不识别的代码显示 `message`。

## 通用代码

oRPC 与 HTTP 层的代码，不在接口错误码表中。

| 代码 | 状态 | 文案 | 触发条件 |
| --- | --- | --- | --- |
| `BAD_REQUEST` | 400 | 输入有误 | 输入校验失败；`data.issues` 为 zod 校验问题（`path`、`message` 等），界面显示第一个问题所在字段 |
| `UNAUTHORIZED` | 401 | 请先登录 | 缺少会话或 `x-api-key`，或密钥无效、已吊销，或服务账号已停用 |
| `CSRF_TOKEN_MISMATCH` | 403 | — | `/rpc` 缺少 `x-csrf-token: orpc` 请求头 |
| `PAYLOAD_TOO_LARGE` | 413 | — | 请求体超过上限：无有效凭据 1 MiB，有有效凭据 16 MiB，`/api/auth` 64 KiB |
| `INTERNAL_SERVER_ERROR` | 500 | 服务器错误 | 未处理的服务器错误；控制台日志记录 `rpc error` |

`/api/auth` 的登录与账户端点另返回 better-auth 的代码，界面映射如下：

| 代码 | 文案 |
| --- | --- |
| `INVALID_EMAIL_OR_PASSWORD` | 邮箱或密码错误 |
| `INVALID_PASSWORD` | 密码错误 |
| `PASSWORD_TOO_SHORT`、`PASSWORD_TOO_LONG` | 密码至少 12 位；密码最多 128 位 |
| `SESSION_EXPIRED` | 登录已过期，请重新登录 |
| `SESSION_NOT_FRESH` | 请重新登录后再修改 |
| `INVALID_CODE`、`INVALID_BACKUP_CODE` | 验证码错误 |
| `INVALID_TWO_FACTOR_COOKIE` | 验证已过期，请重新登录 |
| `TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE`、`ACCOUNT_TEMPORARILY_LOCKED` | 请求过于频繁，请稍后重试 |
| `PREVIOUSLY_REGISTERED` | 这个设备已有本账号的通行密钥 |
| `AUTHENTICATION_FAILED`、`PASSKEY_NOT_FOUND`、`CHALLENGE_NOT_FOUND`、`FAILED_TO_VERIFY_REGISTRATION` | 通行密钥验证失败 |

## 接口错误码

由 `packages/contract/src/errors.ts` 定义；`fail(代码, message, data)` 抛出，HTTP 状态取自定义。权限类代码（`ACCESS_KEY_READ_ONLY`、`SCOPE_REQUIRED`、`SERVICE_ACCOUNT_FORBIDDEN`、`DEMO_READ_ONLY`）见 [API 概览](api.md#权限)。

### 认证、密钥与初始化

| 代码 | 状态 | `data` | 文案 | 触发条件 |
| --- | --- | --- | --- | --- |
| `ACCESS_KEY_NOT_FOUND` | 404 | — | 密钥不存在 | 修改或吊销的 AccessKey 不存在 |
| `ACCESS_KEY_READ_ONLY` | 403 | — | 此密钥只有只读权限 | 只读 AccessKey 调用 `GET` 与 `rules.validate` 以外的过程 |
| `ACCESS_KEY_REVOKED` | 409 | — | 密钥已吊销 | 修改已吊销的 AccessKey |
| `ACCESS_KEY_SESSION_REQUIRED` | 403 | — | 请登录控制台后创建或修改密钥 | 用 `x-api-key` 调用 `accessKeys.create` 或 `accessKeys.update`；只能在已登录的会话中调用 |
| `DEMO_READ_ONLY` | 403 | — | 演示账号为只读 | 演示账号调用写操作，或经 `/api/auth` 修改账户 |
| `LOGIN_IP_NOT_ALLOWED` | 403 | — | 此 IP 不在登录白名单内 | 会话请求或 `/api/auth` 登录请求的客户端 IP 不在登录白名单内（AccessKey 不受限制） |
| `LOGIN_ALLOW_LIST_EXCLUDES_CURRENT_IP` | 400 | `ip` | 名单不含当前 IP {ip}，保存后将无法登录 | 保存的登录白名单不包含调用方当前的 IP |
| `DEMO_EMAIL_TAKEN` | 409 | — | 管理账号的邮箱与演示账号相同 | 开启演示账号时，运营者账户的邮箱与演示账号相同 |
| `SCOPE_REQUIRED` | 403 | `scope` | 缺少权限范围：{scope} | 服务账号缺少过程所需的 scope |
| `SERVICE_ACCOUNT_FORBIDDEN` | 403 | — | 服务账号不能调用此接口 | 服务账号调用不在允许列表中的过程 |
| `SERVICE_ACCOUNT_NOT_FOUND` | 404 | — | 服务账号不存在 | 服务账号不存在 |
| `SERVICE_ACCOUNT_KEY_NOT_FOUND` | 404 | — | 密钥不存在 | 吊销的服务账号 key 不存在或不属于该账号 |
| `SERVICE_ACCOUNT_NAME_TAKEN` | 409 | `name` | 服务账号名称已存在：{name} | 服务账号名称重复 |
| `IDEMPOTENCY_KEY_INVALID` | 400 | — | Idempotency-Key 无效 | `Idempotency-Key` 不是 1–255 个可打印 ASCII 字符 |
| `IDEMPOTENCY_KEY_MISMATCH` | 422 | — | 该 Idempotency-Key 已用于另一个请求 | 同一 `Idempotency-Key` 用于不同的方法、路径或请求体 |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | — | 同一 Idempotency-Key 的请求仍在处理中 | 同一 `Idempotency-Key` 的第一次请求仍在执行 |
| `IDEMPOTENCY_KEY_UNSUPPORTED` | 400 | — | 该请求只返回一次凭据，不能带 Idempotency-Key | 对只返回一次凭据的过程带 `Idempotency-Key` |
| `SETUP_DONE` | 403 | — | 初始化已完成 | 初始化完成后再调用 `system.setup` |
| `SETUP_IN_PROGRESS` | 409 | — | 初始化正在进行，请稍后重试 | 另一个 `system.setup` 请求正在执行 |
| `SETUP_TOKEN_INVALID` | 403 | — | 初始化令牌无效 | `system.setup` 的初始化令牌错误；写审计 `system.setup_rejected` |
| `API_KEY_RATE_LIMITED` | 429 | `retryAfterSeconds` | AccessKey 请求过于频繁，请 {retryAfterSeconds} 秒后重试 | AccessKey 超出「每分钟请求数」 |

### 告警

| 代码 | 状态 | `data` | 文案 | 触发条件 |
| --- | --- | --- | --- | --- |
| `ALERT_CHANNEL_NOT_FOUND` | 404 | — | 告警渠道不存在 | 告警渠道不存在 |
| `ALERT_CHANNEL_LIMIT` | 409 | — | 告警渠道数量已达上限 | 已有 32 个告警渠道 |
| `ALERT_SEND_FAILED` | 502 | — | 通知发送失败 | 测试发送失败（Webhook、邮件或短信服务商返回错误或不可达） |
| `ALERT_SMTP_NOT_CONFIGURED` | 412 | — | 尚未配置 SMTP | 测试或使用邮件渠道时没有保存 SMTP 设置 |
| `ALERT_RATE_LIMITED` | 429 | `retryAt` | 已达发送频率上限 | 短信渠道用完每小时或每天的发送次数；`data.retryAt` 为下一次可发送的时间 |
| `ALERT_SMS_REJECTED` | 502 | `code` | 短信服务商拒绝发送：{code} | 短信服务商拒绝发送；`data.code` 为服务商的错误代码 |
| `ALERT_SUBSCRIPTION_NOT_FOUND` | 404 | — | 告警订阅不存在 | 告警订阅不存在 |
| `SMTP_PASSWORD_REQUIRED` | 400 | — | 更换 SMTP 服务器或账户时需填写新密码 | 更换 SMTP 服务器或用户名时没有填写密码 |
| `SMTP_CA_INVALID` | 400 | — | CA 证书须为 PEM 格式 | SMTP 的 CA 证书不是 PEM |

### DNS

| 代码 | 状态 | `data` | 文案 | 触发条件 |
| --- | --- | --- | --- | --- |
| `DNS_ZONE_MISMATCH` | 400 | — | CNAME 域不属于该 DNS 区域 | DNS 名称不在绑定的区域内 |
| `DNS_PROVIDER_NOT_FOUND` | 404 | — | DNS 服务商不存在 | DNS 服务商不存在 |
| `DNS_TEST_DISABLED` | 400 | — | 未启用 DNS 测试服务商 | 使用 `test` 服务商而未设置 `EDGEWEIR_DNS_TEST_ENDPOINT` |
| `DNS_PROVIDER_IN_USE` | 409 | — | DNS 服务商仍在使用中 | 删除仍有托管 DNS 记录的服务商；先完成对账 |
| `DNS_POLICY_INVALID` | 400 | — | 请检查 DNS 线路和目标地址 | DNS 绑定的线路或目标不合法，或服务商凭据字段不合法 |
| `DNS_REVISION_NOT_FOUND` | 404 | — | DNS 版本不存在 | 集群没有该 DNS 版本 |
| `DNS_NOT_BLOCKED` | 409 | — | 这个 DNS 版本没有被阻止 | 放行的 DNS 版本不处于阻止状态 |
| `DNS_RECORD_CONFLICT` | 409 | `name` | DNS 名称 {name} 已有非系统管理的记录 | DNS 名称已有不由控制台管理的记录 |
| `DNS_BINDING_CONFLICT` | 409 | `name` | {name} 已被其他集群的 DNS 绑定或 CNAME 前缀占用 | DNS 名称已被其他集群的绑定或 CNAME 前缀占用 |
| `DNS_BINDING_IN_USE` | 409 | — | 先关闭该集群的 DNS，等待记录清理完成 | 集群 DNS 为 **自动**，或仍有已写入的记录：删除集群或绑定前先关闭 DNS 并等待记录清理完成 |
| `DNS_PROVIDER_AUTH_FAILED` | 400 | — | DNS 服务商认证失败，请检查凭据与权限 | 服务商拒绝凭据 |
| `DNS_PROVIDER_ZONE_NOT_FOUND` | 400 | — | DNS 服务商中找不到该区域 | 服务商账户中没有该区域 |
| `DNS_PROVIDER_UNREACHABLE` | 502 | — | DNS 服务商暂时不可用 | 服务商 API 不可达或超时 |
| `DNS_PROVIDER_RATE_LIMITED` | 429 | — | DNS 服务商请求过于频繁，请稍后重试 | 服务商 API 限速 |
| `DNS_PROVIDER_FAILED` | 502 | — | DNS 服务商请求失败 | 服务商 API 返回其他错误 |
| `DNS_ADDRESS_REFUSED` | 400 | — | 服务器地址是内网或特殊用途地址，或公网地址未使用 HTTPS | 服务商地址（如自建 PowerDNS）是内网或特殊用途地址，或公网地址未使用 HTTPS |
| `DNS_ZONES_UNSUPPORTED` | 400 | — | 该服务商不支持列出区域，请手动填写 | 服务商不支持列出区域 |
| `DNS_LINE_UNSUPPORTED` | 400 | `line` | 该 DNS 服务商不支持 {line} 解析线路 | 绑定线路使用服务商不支持的解析线路 |
| `DNS_RECONCILE_BUSY` | 409 | — | 该集群的 DNS 同步仍在进行，请稍后重试 | 请求的 DNS 对账等待进行中的对账超时 |

### 规则、IP 名单与 WAF

| 代码 | 状态 | `data` | 文案 | 触发条件 |
| --- | --- | --- | --- | --- |
| `RULE_INVALID` | 400 | — | 规则无效 | 规则的表达式、动作或引用无效，或规则 ID 重复；原因在 `message` 中 |
| `RULE_VERSION_NOT_FOUND` | 404 | — | 规则版本不存在 | 规则没有该历史版本（已清理，或属于其他网站） |
| `RULE_LIMIT_REACHED` | 400 | `limit` | 规则已达上限 {limit} 条 | 恢复已删除的规则将超过上限：网站 64 条、全局 32 条 |
| `WAF_RULE_NOT_EXCLUDABLE` | 400 | `ids` | {ids} 用于 CRS 初始化或拦截判定，不能排除；如需停止拦截，请将模式设为「仅检测」 | 排除的 CRS 规则用于初始化或拦截判定（前 5 个） |
| `BULK_REDIRECT_HOST_UNKNOWN` | 400 | `hosts` | 网站没有这些域名：{hosts} | `host/path` 形式的批量重定向来源，其主机不是网站的域名 |
| `IP_LIST_NOT_FOUND` | 404 | — | IP 名单不存在 | IP 名单不存在 |
| `IP_LIST_REFERENCE_UNKNOWN` | 404 | `lists` | IP 名单不存在：{lists} | 规则或缓存规则条件引用不存在的名单（`$name`） |
| `IP_LIST_NAME_TAKEN` | 409 | — | IP 名单名称已存在 | IP 名单名称重复 |
| `IP_LIST_LIMIT` | 409 | — | IP 名单已达上限（128 份名单、50,000 条记录） | 超过 128 份名单或 50,000 条记录 |
| `IP_LIST_IN_USE` | 409 | `users` | IP 名单正在被使用：{users} | 删除仍被规则、缓存规则或 L4 应用使用的名单（前 5 个） |

### 封禁、灰名单与防护

| 代码 | 状态 | `data` | 文案 | 触发条件 |
| --- | --- | --- | --- | --- |
| `BAN_INVALID_CIDR` | 400 | — | IP 地址或 CIDR 无效 | 不是 IP 地址或 CIDR |
| `BAN_PREFIX_TOO_SHORT` | 400 | `min` | 前缀过短，最短为 /{min} | 前缀短于下限（IPv4 `/16`、IPv6 `/48`） |
| `BAN_EXPIRY_OUT_OF_RANGE` | 400 | — | 封禁时长须在 1 分钟到 7 天之间 | 时长不在 60–604800 秒 |
| `BAN_PROTECTED_ADDRESS` | 400 | `address` | 封禁范围包含受保护的地址 {address} | 范围包含节点地址、回环或未指定地址，或与放行类 IP 名单重叠 |
| `BAN_PLATFORM_LIMIT` | 409 | `limit` | 手动封禁已达上限（{limit} 条） | 有效的手动封禁达到 `maxTotal` |
| `BAN_NOT_FOUND` | 404 | — | 封禁不存在或已失效 | 封禁或灰名单条目不存在、已到期或已解除 |
| `PROTECTION_POW_DIFFICULTY` | 400 | `min` | 高难度计算验证的难度不能低于 {min} | 高难度计算验证的难度低于普通难度 |

### 证书与 ACME

| 代码 | 状态 | `data` | 文案 | 触发条件 |
| --- | --- | --- | --- | --- |
| `CERTIFICATE_NOT_FOUND` | 404 | — | 证书不存在 | 证书不存在 |
| `CERTIFICATE_INVALID` | 400 | — | 无法读取已保存的证书 | 已保存的证书无法读取 |
| `CERTIFICATE_CHAIN_FOREIGN_BLOCK` | 400 | — | 证书链只能包含证书，私钥请填到私钥栏 | 证书链中含证书以外的 PEM 块（如私钥） |
| `CERTIFICATE_CHAIN_UNREADABLE` | 400 | — | 证书链须包含 1–10 张可读取的 PEM 证书 | 没有 PEM 证书、超过 10 张或无法解析 |
| `CERTIFICATE_KEY_UNREADABLE` | 400 | — | 无法读取私钥；不支持加密的私钥 | 私钥无法读取，如加密的私钥 |
| `CERTIFICATE_KEY_MISMATCH` | 400 | — | 私钥与证书不匹配 | 私钥与叶证书不匹配 |
| `CERTIFICATE_KEY_EXPLICIT_CURVE` | 400 | — | EC 私钥使用显式曲线参数，请转换为命名曲线 | EC 私钥使用显式曲线参数而非曲线 OID |
| `CERTIFICATE_CHAIN_EXPLICIT_CURVE` | 400 | — | 证书的 EC 公钥使用显式曲线参数，请用命名曲线私钥重新签发 | 链中证书的 EC 公钥使用显式曲线参数 |
| `CERTIFICATE_CHAIN_ORDER` | 400 | — | 证书链顺序错误：叶证书在前，签发者依次在后 | 第一张是 CA 证书，或某张不是由下一张签发 |
| `CERTIFICATE_NOT_CURRENTLY_VALID` | 400 | `notBefore`、`notAfter` | 证书当前不在有效期内（{notBefore} 至 {notAfter}） | 证书尚未生效或已过期；`data` 为 UTC 有效期，如 `2026-10-02 12:00 UTC` |
| `CERTIFICATE_NO_DNS_NAMES` | 400 | — | 证书没有 DNS 类型的 SAN | 证书没有 DNS 类型的 SAN |
| `CERTIFICATE_KEY_TYPE_UNSUPPORTED` | 400 | — | 不支持的密钥类型，请使用 RSA（2048 位及以上）或 ECDSA P-256、P-384、P-521 | 叶证书密钥不是 RSA（2048 位及以上）或 ECDSA P-256、P-384、P-521 |
| `CERTIFICATE_UNAVAILABLE` | 409 | — | 证书尚未签发或已过期 | 为网站选择的证书尚未签发或已过期 |
| `CERTIFICATE_DOMAIN_MISMATCH` | 400 | `domains` | 证书域名与网站或 DNS 区域不匹配：{domains} | 证书或 DNS 区域不覆盖的名称，或没有网站使用的 HTTP-01 名称（前 5 个） |
| `CERTIFICATE_BUSY` | 409 | — | 证书正在处理中 | 删除正在签发的证书；续期上传的证书或正在签发的证书；绑定网站的申请时该网站已有等待签发的申请 |
| `CERTIFICATE_IN_USE` | 409 | `sites` | 证书仍被网站使用：{sites} | 删除仍被网站使用的证书（前 5 个） |
| `CERTIFICATE_IN_USE_BY_L4` | 409 | `apps` | 证书仍被 L4 应用使用：{apps} | 删除仍被 L4 应用用于 TLS 卸载的证书（前 5 个） |
| `DNS_CREDENTIAL_NOT_FOUND` | 404 | — | DNS 凭据不存在 | DNS 凭据不存在 |
| `DNS_CREDENTIAL_INVALID` | 400 | — | DNS 凭据字段无效 | DNS 凭据字段不符合服务商要求 |
| `DNS_CREDENTIAL_IN_USE` | 409 | `certificates` | DNS 凭据仍被证书使用：{certificates} | 删除仍被证书使用的 DNS 凭据（前 5 个） |
| `CERTIFICATE_DNS_NOT_POINTING` | 409 | `names` | 以下名称未解析到节点：{names} | HTTP-01 名称没有解析到节点，或也解析到其他地址（前 5 个） |
| `CERTIFICATE_NODES_OFFLINE` | 409 | `clusters` | 集群 {clusters} 没有在线节点应答 HTTP-01 | 提供 HTTP-01 名称的集群没有在线节点（前 5 个） |
| `CLIENT_CA_INVALID` | 400 | — | 客户端 CA 须为 1–10 张当前有效的 CA 证书（PEM） | 网站的客户端 CA 不是 1–10 张当前有效的 PEM CA 证书 |
| `CLIENT_CERTIFICATE_HTTP3` | 400 | — | 客户端证书与 HTTP/3 不能同时开启 | 客户端证书与 HTTP/3 同时开启 |
| `ACME_DIRECTORY_INVALID` | 400 | — | 该地址没有返回 ACME 目录 | 自定义 ACME 目录无法读取或不是 ACME 目录 |
| `ACME_DIRECTORY_CA_INVALID` | 400 | — | CA 证书须为 1–10 张 PEM 证书 | 自定义 ACME 目录的 CA 证书不是 1–10 张 PEM 证书 |
| `ACME_DIRECTORY_EAB_INCOMPLETE` | 400 | — | 请同时填写 EAB 密钥 ID 和 HMAC 密钥 | 填写了 EAB 密钥 ID，但没有 HMAC 密钥（也没有已保存的） |
| `ACME_DIRECTORY_NOT_CONFIGURED` | 409 | — | 请先在系统设置中配置自定义 ACME 目录 | 申请自定义 CA 的证书而未配置自定义 ACME 目录 |
| `ACME_ACCOUNT_NOT_FOUND` | 404 | — | ACME 账户不存在 | ACME 账户不存在 |
| `ACME_ACCOUNT_IN_USE` | 409 | `certificates` | ACME 账户仍被证书使用：{certificates} | 删除仍被证书使用的 ACME 账户（前 5 个） |
| `CERTIFICATE_ORIGIN_CA` | 400 | — | Origin CA 签发的证书只能用于源站 | 上传 Origin CA 签发的证书作为访客证书 |

### 源站 PKI

| 代码 | 状态 | `data` | 文案 | 触发条件 |
| --- | --- | --- | --- | --- |
| `ORIGIN_CA_NOT_FOUND` | 409 | — | 请先创建 Origin CA（证书 → 源站证书） | Origin CA 尚未创建（签发源站证书，或网站信任 Origin CA） |
| `ORIGIN_CLIENT_CA_NOT_FOUND` | 409 | — | 请先创建回源客户端 CA（证书 → 回源客户端） | 回源客户端 CA 尚未创建 |
| `CA_ROTATION_IN_PROGRESS` | 409 | — | 已经在轮换 | 已有进行中的轮换时开始新的轮换 |
| `CA_ROTATION_STEP_UNAVAILABLE` | 409 | — | 轮换的当前阶段不能执行这一步 | 轮换步骤不适用于当前阶段 |
| `CA_ROTATION_INCOMPLETE` | 409 | `clusters` | 这些集群仍在出示旧 CA 签发的证书：{clusters} | 退役旧回源客户端 CA 时，仍有集群出示其签发的证书（前 5 个，其后 `+N`） |
| `CA_ROTATION_IN_USE` | 409 | `count` | 新 CA 已签发 {count} 张有效证书，不能取消 | 取消 Origin CA 轮换时，新 CA 已签发仍有效的证书 |
| `ORIGIN_CERTIFICATE_NOT_FOUND` | 404 | — | 源站证书不存在 | 源站证书不存在 |
| `ORIGIN_CERTIFICATE_REVOKED` | 409 | — | 证书已经吊销 | 吊销已吊销的源站证书 |
| `ORIGIN_CERTIFICATE_CSR_INVALID` | 400 | — | CSR 无法读取、签名无效，或密钥不是 RSA 2048–4096、ECDSA P-256 / P-384 | CSR 无法读取、签名无效，或密钥不是 RSA 2048–4096、ECDSA P-256 / P-384 |

### 集群、节点与区域

| 代码 | 状态 | `data` | 文案 | 触发条件 |
| --- | --- | --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | — | 集群不存在 | 集群不存在 |
| `CLUSTER_SITE_LIMIT` | 409 | `limit` | 此集群最多发布 {limit} 个网站 | 集群的已启用网站将超过 512 个 |
| `NODE_CAPABILITY_REQUIRED` | 409 | `features`、`nodes` | 节点尚不支持：{features}（{nodes}） | 服务账号或自动任务发布的配置需要活动节点缺少的能力；`data.features` 为能力（逗号分隔），`data.nodes` 为前 5 个节点 |
| `CLUSTER_NAME_TAKEN` | 409 | `name` | 集群名称已存在：{name} | 集群名称重复 |
| `CLUSTER_NOT_EMPTY` | 409 | `nodes`、`sites` | 集群还有 {nodes} 个节点和 {sites} 个网站，不能删除 | 删除仍有节点或网站的集群 |
| `NO_CLUSTER` | 412 | — | 还没有集群 | 新建网站不带 `clusterId`，而还没有集群 |
| `NODE_GROUP_NOT_FOUND` | 404 | — | 节点组不存在 | 节点组不存在 |
| `NODE_GROUP_NAME_TAKEN` | 409 | `name` | 节点组已存在：{name} | 节点组名称在集群内重复 |
| `NODE_GROUP_IS_DEFAULT` | 409 | — | 默认节点组不能删除 | 删除默认节点组 |
| `NODE_GROUP_CLUSTER_MISMATCH` | 400 | — | 节点组不属于该节点所在的集群 | 注册 token 或节点使用其他集群的节点组 |
| `REGION_NOT_FOUND` | 404 | — | 区域不存在 | 区域不存在 |
| `REGION_CODE_TAKEN` | 409 | `code` | 区域代码已存在：{code} | 区域代码重复 |
| `REGION_IN_USE` | 409 | `probes` | 该区域下还有 {probes} 个探针 | 删除仍有探针的区域 |
| `PROBE_NOT_FOUND` | 404 | — | 探针不存在 | 探针不存在 |
| `NODE_REGION_REQUIRED` | 409 | — | 节点组须先设置区域 | 节点兼任探针，而其节点组没有区域 |
| `NODE_ADDRESS_INVALID` | 400 | `address` | 不是单个单播 IP 地址：{address} | 调度地址不是单个单播 IP |
| `SCHEDULING_RULE_NOT_FOUND` | 404 | — | 调度规则不存在 | 调度规则不存在 |
| `SCHEDULING_RULE_INVALID` | 400 | — | 规则需要集群 DNS 绑定中的一条线路 | 集群无法执行的调度规则（如 `backup_group` 没有线路，或线路不在集群 DNS 绑定中） |
| `NODE_NOT_FOUND` | 404 | — | 节点不存在 | 节点不存在 |
| `NODE_CHANNEL_NAME_NOT_FOUND` | 404 | — | 证书中没有这个旧名称 | 移除的名称不是早先节点通道地址留在证书中的名称 |
| `NODE_CHANNEL_NAME_IN_USE` | 409 | `nodes`、`probes` | 仍有节点 {nodes} 个、探针 {probes} 个可能使用这个名称 | 仍有节点或探针可能用该名称连接 |
| `NODE_CHANNEL_WEBSOCKET_IN_USE` | 409 | `nodes`、`probes` | 仍有节点 {nodes} 个、探针 {probes} 个可能经 WebSocket 入口连接 | 关闭 WebSocket 入口时，仍有节点或探针可能经它连接 |
| `NODE_CHANNEL_WEBSOCKET_REQUIRED` | 409 | — | WebSocket 入口仍需开放（当前地址或 EDGEWEIR_NODE_API_WEBSOCKET） | 当前节点通道地址或 `EDGEWEIR_NODE_API_WEBSOCKET` 需要 WebSocket 入口 |
| `ENROLLMENT_TOKEN_NOT_FOUND` | 404 | — | 注册令牌不存在 | 注册 token 不存在 |
| `DEFAULT_SITE_INVALID` | 400 | — | 默认网站须为本集群已启用的网站 | 未知域名的默认网站不是本集群已启用的网站 |
| `DEFAULT_SITE_CERTIFICATE_REQUIRED` | 409 | — | 默认网站没有证书 | 未知 SNI 使用默认网站的证书，而默认网站没有证书 |
| `REVISION_NOT_FOUND` | 404 | — | 版本不存在 | 集群没有该配置版本 |
| `ROLLOUT_NOT_ACTIVE` | 409 | — | 没有进行中的金丝雀发布 | 推进或中止金丝雀发布时没有进行中的发布 |
| `ROLLBACK_RESOURCE_UNAVAILABLE` | 409 | — | 回滚引用的资源已移除、转移或不可用 | 回滚的版本引用的网站、域名、证书、IP 名单或 CA 已删除、转移或不可用，或证书已过期 |

### 节点升级

| 代码 | 状态 | `data` | 文案 | 触发条件 |
| --- | --- | --- | --- | --- |
| `UPGRADE_RELEASE_UNAVAILABLE` | 502 | — | 无法读取此版本的发布清单 | 发布清单无法读取，或版本没有支持的架构的软件包 |
| `RELEASE_SOURCE_REFUSED` | 400 | — | 发布源须使用 HTTPS 并解析到允许的地址 | 节点发布源解析到不允许的地址，或公网地址未使用 HTTPS |
| `UPGRADE_NOT_FOUND` | 404 | — | 升级任务不存在 | 升级任务不存在 |
| `UPGRADE_BUSY` | 409 | `nodes` | 这些节点已有未完成的升级：{nodes} | 节点已在未完成的升级中（前 10 个，其后 `+N`） |
| `UPGRADE_FINISHED` | 409 | — | 升级已结束 | 取消已结束的升级 |
| `UPGRADE_NODES_UNAVAILABLE` | 409 | `nodes` | 这些节点须在线、数据面正常、配置同步且支持签名升级：{nodes} | 活动节点离线、数据面异常、配置未同步或不能自升级（前 10 个，其后 `+N`） |
| `UPGRADE_CANARY_EMPTY` | 409 | — | 金丝雀节点组没有启用的节点 | 金丝雀节点组没有活动节点 |
| `UPGRADE_TOO_MANY_NODES` | 409 | `limit` | 一次升级最多 {limit} 个节点 | 一次升级超过 1000 个节点 |
| `UPGRADE_NOT_READY` | 409 | — | 金丝雀节点尚未通过健康观察 | 推进升级时金丝雀节点尚未通过健康观察 |

### 网站

| 代码 | 状态 | `data` | 文案 | 触发条件 |
| --- | --- | --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | — | 网站不存在 | 网站不存在 |
| `CACHE_RULE_PRIORITY_DUPLICATE` | 400 | `priority` | 两条缓存规则的优先级都是 {priority} | 两条缓存规则的优先级相同 |
| `SITE_DISABLED` | 409 | — | 网站已停用 | 对停用的网站清缓存或预热 |
| `UPDATED_AT_MISMATCH` | 409 | `updatedAt` | 内容已被修改，请刷新后重试 | `expectedUpdatedAt` 与资源当前的 `updatedAt` 不同；`data.updatedAt` 为当前值（尚无值时为空字符串） |
| `DOMAIN_IN_USE` | 409 | `domains` | 域名已被使用：{domains} | 域名已被其他网站使用 |
| `DOMAIN_INVALID` | 400 | `domain` | 域名无效：{domain} | 国际化域名或 `xn--` 主机名不符合 UTS #46 或 LDH 规则 |
| `CNAME_PREFIX_CONFLICT` | 409 | `prefix` | CNAME 前缀 {prefix} 已被使用或保留 | CNAME 前缀已被使用、仍在为其他网站或 L4 应用解析，或是 DNS 记录名 |
| `CNAME_PREFIX_INVALID` | 400 | `prefix` | CNAME 前缀 {prefix} 无效 | 前缀不符合 `^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$`（例外：对象当前的或仍在解析的旧前缀） |
| `PURGE_KEY_REQUIRED` | 400 | — | 开启 PURGE 方法需要先设置密钥 | 开启 PURGE 方法而未设置 `cacheSettings.purgeMethod.key` |
| `SITE_TAG_LIMIT` | 400 | `site`、`limit` | 网站 {site} 最多 {limit} 个标签 | 网站的标签超过 10 个 |
| `SITE_TAG_NOT_FOUND` | 404 | — | 标签不存在 | 标签不存在 |
| `ORIGIN_GROUP_UNKNOWN` | 400 | `group`、`rule` | 规则「{rule}」选择的源站组 {group} 在该网站不存在 | 复制或克隆设置时，规则选择的源站组在目标网站不存在 |
| `HTTPS_REQUIRES_CERTIFICATE` | 400 | — | HTTPS 跳转、HSTS 和客户端证书需要网站有证书 | 复制设置时，HTTPS 跳转、HSTS 或客户端证书用于没有证书的网站 |

### 源站

| 代码 | 状态 | `data` | 文案 | 触发条件 |
| --- | --- | --- | --- | --- |
| `S3_SECRET_REQUIRED` | 400 | `accessKeyId` | 请填写 {accessKeyId} 的 Secret Key | 新的或更换 Access Key 的 S3 源站没有 Secret Key |
| `ORIGIN_ADDRESS_FORBIDDEN` | 400 | `address`、`range` | 源站地址 {address} 属于特殊用途地址段 {range}，不在源站地址允许清单中 | 源站或鉴权服务地址属于特殊用途地址段，且不在源站地址允许清单中 |
| `ORIGIN_GRPC_REQUIRES_HTTP2` | 400 | — | gRPC 需要以 HTTP/2 回源 | `originSettings.grpc` 用于回源协议不是 `http2` 的源站组 |
| `ORIGIN_TLS_TRUST_REQUIRES_VERIFY` | 400 | — | 信任 Origin CA 需要先开启校验源站证书 | `originSettings.tlsTrust` 为 `originCa` 而未开启 `tlsVerify` |
| `ORIGIN_CA_S3` | 400 | — | S3 源站不能用 Origin CA 校验 | 有 S3 源站的网站使用 `tlsTrust: originCa` |
| `ORIGIN_PROXY_PROTOCOL_S3` | 400 | — | S3 源站不支持 PROXY protocol | S3 源站设置 `proxyProtocolVersion` |
| `ORIGIN_HOST_HEADER_INVALID` | 400 | `hostHeader` | 回源 Host 无效：{hostHeader} | 源站或源站规则的 Host 不是主机名或 IP（可带端口） |

### 端口与 HTTPS 跳转

| 代码 | 状态 | `data` | 文案 | 触发条件 |
| --- | --- | --- | --- | --- |
| `LISTEN_PORT_CONFLICT` | 400 | `port` | 端口 {port} 不能同时用于 HTTP 和 HTTPS | 同一端口同时在额外 HTTP 与额外 HTTPS 端口中 |
| `LISTEN_PORT_IN_POOL` | 400 | `port`、`pools` | 端口 {port} 在端口池内：{pools} | 额外监听端口在集群的端口池内 |
| `LISTEN_PORT_IN_USE` | 409 | `port`、`sites` | 端口 {port} 仍被网站使用：{sites} | 移除仍被网站使用的监听端口（前 5 个网站） |
| `SITE_PORT_UNAVAILABLE` | 400 | `port` | 端口 {port} 不是集群的监听端口 | 网站端口不是集群的 HTTP 或 HTTPS 监听端口 |
| `SITE_PORTS_EMPTY` | 400 | — | 网站至少需要一个可用端口 | 网站没有任何可用端口 |
| `SITE_HTTPS_PORT_NEEDS_CERTIFICATE` | 400 | `port` | HTTPS 端口 {port} 需要证书 | 没有证书的网站使用 443 以外的 HTTPS 端口 |
| `HTTPS_REDIRECT_PORT_INVALID` | 400 | `port` | 跳转端口 {port} 不是网站的 HTTPS 端口 | HTTPS 跳转端口既不是 443 也不是网站的 HTTPS 端口 |
| `HTTPS_REDIRECT_DOMAIN_INVALID` | 400 | `domains` | 网站没有这些域名：{domains} | 排除 HTTPS 跳转的域名不属于网站 |

### 缓存任务与错误页

| 代码 | 状态 | `data` | 文案 | 触发条件 |
| --- | --- | --- | --- | --- |
| `CACHE_TASK_NOT_FOUND` | 404 | — | 任务不存在 | 缓存任务不存在 |
| `CACHE_TASK_URL_INVALID` | 400 | `urls` | URL 无效：{urls} | URL 或前缀不能按任务类型解析（前 5 个） |
| `CACHE_TASK_HOST_UNKNOWN` | 400 | `hosts` | 没有网站使用 {hosts} | 没有网站使用这些主机 |
| `CACHE_TASK_HOST_INVALID` | 400 | `hosts` | Host 无效：{hosts} | 主机名无效 |
| `CACHE_TASK_TAG_INVALID` | 400 | `tags` | 缓存标签无效：{tags} | Cache-Tag 无效 |
| `ERROR_PAGE_TOO_LARGE` | 400 | `status`、`limit` | {status} 错误页超过 {limit} 字节 | 错误页模板超过 65536 字节；`data.status` 为页面（平台页面为 404 / 503） |

### 访问鉴权与访问控制

| 代码 | 状态 | `data` | 文案 | 触发条件 |
| --- | --- | --- | --- | --- |
| `AUTH_DOMAIN_UNKNOWN` | 400 | `domain` | 网站没有域名 {domain} | 鉴权规则范围中的域名不属于网站 |
| `AUTH_PASSWORD_REQUIRED` | 400 | `user` | 用户 {user} 需要设置密码 | 新的 Basic 用户（或原先没有用户的规则中的用户）没有密码 |
| `AUTH_KEY_REQUIRED` | 400 | — | 需要设置签名密钥 | URL 鉴权规则没有已保存的主密钥，且未提供 |
| `AUTH_RULE_NOT_FOUND` | 404 | — | 鉴权规则不存在，刷新后再试 | 鉴权规则不存在 |
| `AUTH_RULE_NOT_URL` | 400 | — | 只有 URL 鉴权规则能生成签名 URL | 对 URL 鉴权（A–D 型）以外的规则签名 URL |
| `AUTH_SIGN_URL_INVALID` | 400 | — | 填写以 / 开头的路径，或本网站域名的 http(s) 地址 | 签名的 URL 不是路径，也不是网站域名的 `http(s)` 地址 |
| `AUTH_SIGN_VALIDITY` | 400 | `max` | 有效期不能超过规则的 {max} 秒 | 签名 URL 的有效期超过规则的有效期（秒） |
| `SITE_LIST_CONFLICT` | 400 | `lists` | 同一名单不能同时作为本站拦截与放行名单：{lists} | 同一 IP 名单同时作为网站拦截名单与放行名单 |
| `CORS_CREDENTIALS_WILDCARD` | 400 | — | 允许凭据时来源不能用 * | CORS 允许凭据时来源为 `*` |
| `IP_ADDRESS_INVALID` | 400 | — | IP 地址无效 | `ipCheck.check` 的地址不是 IPv4 或 IPv6 地址 |

### 用量、自动缓解与节点日志

| 代码 | 状态 | `data` | 文案 | 触发条件 |
| --- | --- | --- | --- | --- |
| `USAGE_RANGE_INVALID` | 400 | — | 时间范围必须按 5 分钟对齐，且结束晚于开始 | 时间范围没有按 5 分钟对齐，或结束不晚于开始 |
| `USAGE_CURSOR_INVALID` | 400 | — | 分页游标无效 | 用量分页游标无效 |
| `USAGE_GUARD_NOT_HELD` | 409 | — | 用量保护没有正在执行的动作 | 恢复没有执行中动作的用量保护 |
| `AUTO_MITIGATION_NOT_ACTIVE` | 409 | — | 自动缓解没有开启 Under Attack | 结束没有开启 Under Attack 的自动缓解 |
| `NODE_LOG_CURSOR_INVALID` | 400 | — | 分页游标无效 | 节点日志分页游标无效 |
| `NODE_DEBUG_LOGS_BUSY` | 409 | — | 该节点还有一次拉取未完成 | 节点有一次未完成的调试日志拉取 |
| `NODE_DEBUG_LOG_NOT_FOUND` | 404 | — | 拉取记录不存在 | 调试日志拉取记录不存在 |

### L4 应用

| 代码 | 状态 | `data` | 文案 | 触发条件 |
| --- | --- | --- | --- | --- |
| `L4_APP_NOT_FOUND` | 404 | — | L4 应用不存在 | L4 应用不存在 |
| `L4_APP_LIMIT` | 409 | `limit` | 每个集群最多 {limit} 个 L4 应用 | 集群已有 256 个 L4 应用 |
| `L4_PORT_OUTSIDE_POOL` | 400 | `port` | 端口 {port} 不在集群此协议的端口池内 | 应用端口不在集群该协议的任何端口池内 |
| `L4_PORT_IN_USE` | 409 | `apps` | 端口已被占用：{apps} | 端口已被集群的其他应用使用，或端口池变更会使应用端口落在池外；`data.apps` 为 `名称 (端口/协议)` |
| `L4_PORT_RESERVED` | 400 | `port` | 端口 {port} 是集群的 HTTP 监听端口 | 端口池或应用使用集群的 HTTP(S) 监听端口 |
| `L4_PORT_POOL_OVERLAP` | 400 | `pools` | 端口池重叠：{pools} | 同一协议的端口池重叠（`起-止/协议`） |
| `L4_PROXY_PROTOCOL_UNSUPPORTED` | 400 | — | PROXY protocol 只用于 TCP 应用 | UDP 应用接收或发送 PROXY protocol |
| `L4_PORT_LIMIT` | 409 | `limit` | 集群的 L4 应用最多使用 {limit} 个端口 | 集群 L4 应用的端口（区间按全部端口计）超过 2048 个 |
| `L4_PORT_RANGE_INVALID` | 400 | `max` | 结束端口须大于监听端口，最多 {max} 个端口 | 端口区间的结束端口不大于起始端口，或超过 1000 个端口 |
| `L4_ORIGIN_PORT_REQUIRED` | 400 | — | 固定源站端口时每个源站都要填写端口 | `originPortMode` 为固定时源站没有端口 |
| `L4_TLS_UNSUPPORTED` | 400 | — | TLS 卸载只用于 TCP 应用 | UDP 应用开启 TLS 卸载 |
| `L4_CERTIFICATE_UNAVAILABLE` | 400 | — | 证书尚未签发或已过期 | 选择的证书尚未签发或已过期 |

## 版本原因码

配置版本（`GET /clusters/{id}/revisions`）的发布原因，存为 `reason_code` 与参数。界面显示 `revision_reason_<代码>` 文案；API 另返回英文文本（`reasonText`）。共 49 个。

| 代码 | 参数 | 文案 | API 英文文本（`reasonText`） |
| --- | --- | --- | --- |
| `rules_updated` | — | 已更新规则与 IP 名单 | rules and IP lists updated |
| `certificate_updated` | `site` | 已更新 {site} 的证书配置 | certificate policy for {site} updated |
| `acme_challenge_updated` | — | 已更新 ACME 验证 | ACME challenge updated |
| `cluster_created` | `cluster` | 创建集群 {cluster} | cluster {cluster} created |
| `site_created` | `site` | 新建网站 {site} | site {site} created |
| `site_updated` | `site` | 修改网站 {site} | site {site} updated |
| `site_deleted` | `site` | 删除网站 {site} | site {site} deleted |
| `site_purged` | `site` | 清除网站 {site} 的缓存 | site {site} purged |
| `site_enabled` | `site` | 启用网站 {site} | site {site} enabled |
| `site_disabled` | `site` | 停用网站 {site} | site {site} disabled |
| `rollback` | `revision` | 回滚到 #{revision} | rollback to revision {revision} |
| `rollout_rollback` | `revision` | 版本 #{revision} 的金丝雀发布已回滚 | canary of revision {revision} rolled back |
| `origin_allow_list_updated` | — | 更新源站地址允许清单 | origin allow list updated |
| `site_protection_updated` | `site` | 修改网站 {site} 的防护 | protection of {site} updated |
| `platform_protection_updated` | — | 修改全局 Under Attack | global Under Attack updated |
| `cc_template_updated` | — | 修改 CC 模板 | CC template updated |
| `challenge_keys_rotated` | — | 轮换挑战密钥 | challenge keys rotated |
| `session_ticket_keys_rotated` | — | 轮换 TLS 会话票据密钥 | TLS session ticket keys rotated |
| `site_waf_updated` | `site` | 修改网站 {site} 的 OWASP CRS | OWASP CRS of {site} updated |
| `site_error_pages_updated` | `site` | 修改网站 {site} 的错误页 | error pages of {site} updated |
| `site_maintenance_updated` | `site` | 修改网站 {site} 的维护模式 | maintenance of {site} updated |
| `site_auth_updated` | `site` | 修改网站 {site} 的访问鉴权 | access authentication of {site} updated |
| `site_access_control_updated` | `site` | 修改网站 {site} 的访问控制 | access control of {site} updated |
| `cluster_cache_updated` | — | 修改缓存区 | cache zone updated |
| `node_cache_updated` | `node` | 修改节点 {node} 的缓存容量 | cache size of node {node} updated |
| `error_pages_updated` | — | 修改平台错误页 | platform error pages updated |
| `recompiled` | — | 升级后重新编译配置 | configuration recompiled after an upgrade |
| `l4_app_created` | `app` | 新建 L4 应用 {app} | L4 application {app} created |
| `l4_app_updated` | `app` | 修改 L4 应用 {app} | L4 application {app} updated |
| `l4_app_deleted` | `app` | 删除 L4 应用 {app} | L4 application {app} deleted |
| `listen_ports_updated` | — | 修改监听端口 | listener ports updated |
| `client_ip_updated` | — | 修改访客 IP 来源 | client address setting updated |
| `unknown_hosts_updated` | — | 修改未知域名设置 | unknown host settings updated |
| `connection_limits_updated` | — | 修改连接限制 | connection limits updated |
| `greylist_challenge` | — | 为灰名单挑战下发密钥 | challenge keys for the greylist |
| `sites_enabled` | `count` | 启用 {count} 个网站 | {count} sites enabled |
| `sites_disabled` | `count` | 停用 {count} 个网站 | {count} sites disabled |
| `sites_deleted` | `count` | 删除 {count} 个网站 | {count} sites deleted |
| `site_settings_copied` | `site`、`source` | 把 {source} 的设置复制到 {site} | settings of {source} copied to {site} |
| `site_cloned` | `site`、`source` | 从 {source} 克隆网站 {site} | site {site} cloned from {source} |
| `usage_limit_reached` | `site` | 网站 {site} 达到用量上限 | usage limit of {site} reached |
| `usage_limit_released` | `site` | 解除网站 {site} 的用量保护动作 | usage protection of {site} lifted |
| `auto_mitigation_started` | `site` | 自动缓解为 {site} 开启 Under Attack | automatic mitigation turned on Under Attack for {site} |
| `auto_mitigation_ended` | `site` | 自动缓解为 {site} 关闭 Under Attack | automatic mitigation turned off Under Attack for {site} |
| `origin_certificate_revoked` | — | 吊销源站证书 | origin certificate revoked |
| `origin_client_certificate_rotated` | — | 更换回源客户端证书 | origin client certificate replaced |
| `origin_ca_rotation_started` | — | 开始轮换 Origin CA | Origin CA rotation started |
| `origin_ca_rotation_cancelled` | — | 取消轮换 Origin CA | Origin CA rotation cancelled |
| `origin_ca_retired` | — | 退役旧 Origin CA | previous Origin CA retired |
