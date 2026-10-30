# API：证书

证书、ACME 账户、DNS 凭据、回源客户端 CA、Origin CA 与源站证书的过程，共 28 个。

权限级别、认证、幂等键与错误格式见 [API 概览](../api.md)。

## 证书

- 行为见 [HTTPS 与证书](../../guide/https.md)：[上传证书](../../guide/https.md#上传证书)、[申请 ACME 证书](../../guide/https.md#申请-acme-证书)、[续期](../../guide/https.md#续期)、[删除](../../guide/https.md#删除)。
- ACME 证书由后台任务签发（`ROLE=worker` 或 `ROLE=all` 的控制台进程）；`certificates.request` 与 `certificates.renew` 只把证书置为 `pending`。
- 网站使用哪些证书由 `https.update`（`PUT /sites/{id}/https`）设置，不在本页。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`certificates.list`](#certificateslist) | `GET /certificates` | 读 |
| [`certificates.settings`](#certificatessettings) | `GET /certificates/settings` | 读 |
| [`certificates.upload`](#certificatesupload) | `POST /certificates/upload` | 写 |
| [`certificates.request`](#certificatesrequest) | `POST /certificates/request` | 写 |
| [`certificates.renew`](#certificatesrenew) | `POST /certificates/{id}/renew` | 写 |
| [`certificates.delete`](#certificatesdelete) | `DELETE /certificates/{id}` | 写 |

### `certificates.list`

`GET /certificates` · 读

无参数。

响应：[证书](#证书对象)`[]`，未排序。

### `certificates.settings`

`GET /certificates/settings` · 读

无参数。

响应：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `acmeDirectory` | string | 生效的自定义 ACME 目录（系统设置中保存的，否则 `EDGEWEIR_ACME_DIRECTORY`），或 `null`：不能选 `ca` `custom` |
| `acmeDirectoryEab` | boolean | 系统设置中保存的自定义目录带 EAB 密钥：`ca` 为 `custom` 的申请可省略 EAB |
| `defaultCa` | enum | `letsencrypt` / `custom`。省略 `ca` 的申请使用的 CA：系统设置未保存目录而 `EDGEWEIR_ACME_DIRECTORY` 已设置时为 `custom`，否则 `letsencrypt` |

### `certificates.upload`

`POST /certificates/upload` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `name` | body | string | 是 | 去掉首尾空格后 1–100 字符 | 证书名称 |
| `chainPem` | body | string | 是 | 32–131072 字符 | PEM 证书链：1–10 张证书，叶证书在前，每张由下一张签发；不能含其他 PEM 块 |
| `privateKeyPem` | body | string | 是 | 32–32768 字符 | 叶证书的 PEM 私钥，不能加密 |

只保存证书链与 PKCS #8 私钥，其他内容丢弃；`names` 取叶证书的 DNS 主题备用名称，状态为 `ready`。审计 `certificate.upload`。

响应：[证书](#证书对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CERTIFICATE_CHAIN_FOREIGN_BLOCK` | 400 | 证书链含 `CERTIFICATE` 以外的 PEM 块 |
| `CERTIFICATE_CHAIN_UNREADABLE` | 400 | 证书链不是 1–10 张可读的 PEM 证书 |
| `CERTIFICATE_CHAIN_EXPLICIT_CURVE` | 400 | 链中某张证书的 EC 公钥写出了曲线参数，而不是曲线名 |
| `CERTIFICATE_KEY_UNREADABLE` | 400 | 私钥无法读取或已加密 |
| `CERTIFICATE_KEY_EXPLICIT_CURVE` | 400 | EC 私钥写出了曲线参数，而不是曲线名 |
| `CERTIFICATE_CHAIN_ORDER` | 400 | 第一张是 CA 证书，或某张证书不是由下一张 CA 证书签发 |
| `CERTIFICATE_KEY_TYPE_UNSUPPORTED` | 400 | 叶证书的密钥不是 RSA（2048 位以上）或 ECDSA P-256 / P-384 / P-521 |
| `CERTIFICATE_KEY_MISMATCH` | 400 | 私钥与叶证书不匹配 |
| `CERTIFICATE_NOT_CURRENTLY_VALID` | 400 | 叶证书尚未生效或已过期；`data.notBefore`、`data.notAfter` |
| `CERTIFICATE_NO_DNS_NAMES` | 400 | 叶证书没有 DNS 主题备用名称，或名称含无效字符 |
| `CERTIFICATE_ORIGIN_CA` | 400 | 证书由 Origin CA 签发 |

### `certificates.request`

`POST /certificates/request` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `name` | body | string | 是 | 去掉首尾空格后 1–100 字符 | 证书名称 |
| `names` | body | `array<string>` | 是 | 1–100 个域名，不重复；`*.` 前缀为泛域名；转为小写 | 证书包含的名称 |
| `email` | body | string | 是 | 电子邮件地址 | ACME 账户邮箱 |
| `ca` | body | enum | 否 | `letsencrypt` / `zerossl` / `google` / `custom`；省略时为 `certificates.settings` 的 `defaultCa` | 证书颁发机构；`custom` 为系统设置中的自定义目录 |
| `keyType` | body | enum | 否 | `ec256` / `rsa2048`，默认 `ec256` | 证书密钥：ECDSA P-256 或 RSA 2048 |
| `challenge` | body | enum | 否 | `http01` / `dns01`，默认 `http01` | 验证方式；`http01` 不能含泛域名 |
| `dnsCredentialId` | body | uuid | 否 | `challenge` 为 `dns01` 时必填 | DNS 凭据；`names` 须都在其区域内 |
| `eabKid` | body | string | 否 | 最长 256 字符；与 `eabHmacKey` 同时提供或都省略；`ca` 为 `zerossl` / `google` 时必填 | EAB 密钥 ID |
| `eabHmacKey` | body | string | 否 | 最长 1024 字符；`ca` 为 `zerossl` / `google` 时必填 | EAB HMAC 密钥 |
| `autoRenew` | body | boolean | 否 | 默认 `true` | 自动续期 |
| `skipDnsCheck` | body | boolean | 否 | 默认 `false` | 仅 `http01`：申请时与每次签发前不检查名称是否只解析到服务该名称的集群的节点 |
| `bindSiteId` | body | uuid | 否 | — | 签发后把证书设为该网站的第一张证书，`forceHttps` 等其他 HTTPS 设置不变（审计 `site.https_update`，操作者 system）；`names` 须覆盖网站全部精确域名与泛域名；签发时网站已有其他已签发、未过期、节点可加载的第一张证书则不绑定 |

`http01` 的每个名称须是某个网站的精确域名；服务这些名称的集群须有在线活动节点，且在线活动节点都支持 `http01-v1`。新证书状态为 `pending`。审计 `certificate.request`。

响应：[证书](#证书对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `ACME_DIRECTORY_NOT_CONFIGURED` | 409 | CA 为 `custom` 而没有生效的自定义目录 |
| `SITE_NOT_FOUND` | 404 | `bindSiteId` 的网站不存在 |
| `CERTIFICATE_DOMAIN_MISMATCH` | 400 | `bindSiteId`：`names` 不覆盖网站的某些域名；`http01`：某些名称不是网站的精确域名；`dnsCredentialId`：某些名称不在凭据区域内。`data.domains` 列出最多 5 个 |
| `CERTIFICATE_BUSY` | 409 | 已有另一张等待签发后绑定到该网站的证书 |
| `NODE_CAPABILITY_REQUIRED` | 409 | `http01`：在线活动节点缺少 `http01-v1`；`data.features`、`data.nodes` |
| `CERTIFICATE_NODES_OFFLINE` | 409 | `http01`：服务这些名称的集群没有在线活动节点；`data.clusters` |
| `CERTIFICATE_DNS_NOT_POINTING` | 409 | `http01` 且未设 `skipDnsCheck`：名称没有解析到节点，或解析结果含其他地址；`data.names` |
| `DNS_CREDENTIAL_NOT_FOUND` | 404 | `dnsCredentialId` 的凭据不存在 |

### `certificates.renew`

`POST /certificates/{id}/renew` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 证书 ID |

把 ACME 证书置为 `pending` 并清空 `lastError`，由后台任务的下一次检查续期。审计 `certificate.renew`。

响应：[证书](#证书对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CERTIFICATE_NOT_FOUND` | 404 | 证书不存在 |
| `CERTIFICATE_BUSY` | 409 | 证书是上传的，或状态为 `issuing` |

### `certificates.delete`

`DELETE /certificates/{id}` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 证书 ID |

待清理的 DNS-01 TXT 记录不再清理，审计 `certificate.delete` 的 `leftDnsRecords` 列出这些记录。

响应：`{ ok: true }`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `CERTIFICATE_NOT_FOUND` | 404 | 证书不存在 |
| `CERTIFICATE_IN_USE` | 409 | 有网站使用该证书（第一张或其他）；`data.sites` 列出最多 5 个 |
| `CERTIFICATE_IN_USE_BY_L4` | 409 | 有 L4 应用使用该证书；`data.apps` 列出最多 5 个 |
| `CERTIFICATE_BUSY` | 409 | 证书状态为 `issuing` |

## ACME 账户

控制台为 ACME 申请注册的账户。行为见 [ACME 账户](../../guide/https.md#acme-账户)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`acmeAccounts.list`](#acmeaccountslist) | `GET /acme-accounts` | 读 |
| [`acmeAccounts.delete`](#acmeaccountsdelete) | `DELETE /acme-accounts/{id}` | 写 |

### `acmeAccounts.list`

`GET /acme-accounts` · 读

无参数。

响应：[ACME 账户](#acme-账户对象)`[]`，按创建时间从新到旧。

### `acmeAccounts.delete`

`DELETE /acme-accounts/{id}` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 账户 ID |

只删除控制台保存的账户，不在 CA 注销。审计 `acme_account.delete`。

响应：`{ ok: true }`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `ACME_ACCOUNT_NOT_FOUND` | 404 | 账户不存在 |
| `ACME_ACCOUNT_IN_USE` | 409 | 有证书使用该账户；`data.certificates` 列出最多 5 张 |

## DNS 凭据

DNS-01 验证使用的服务商凭据。凭据加密保存，任何过程都不返回。行为见 [添加 DNS 凭据](../../guide/https.md#添加-dns-凭据)，各服务商的凭据字段见 [服务商与凭据](../../guide/dns.md#服务商与凭据)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`dnsCredentials.list`](#dnscredentialslist) | `GET /dns-credentials` | 读 |
| [`dnsCredentials.create`](#dnscredentialscreate) | `POST /dns-credentials` | 写 |
| [`dnsCredentials.update`](#dnscredentialsupdate) | `PUT /dns-credentials/{id}` | 写 |
| [`dnsCredentials.delete`](#dnscredentialsdelete) | `DELETE /dns-credentials/{id}` | 写 |
| [`dnsCredentials.zones`](#dnscredentialszones) | `POST /dns-credentials/zones` | 写 |
| [`dnsCredentials.test`](#dnscredentialstest) | `POST /dns-credentials/test` | 写 |

### `dnsCredentials.list`

`GET /dns-credentials` · 读

无参数。

响应：[DNS 凭据](#dns-凭据对象)`[]`，按名称排序。

### `dnsCredentials.create`

`POST /dns-credentials` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `name` | body | string | 是 | 去掉首尾空格后 1–100 字符 | 凭据名称 |
| `provider` | body | enum | 是 | `cloudflare` / `alidns` / `huaweicloud` / `dnspod` / `tencentcloud` / `volcengine` / `baiducloud` / `westcn` / `dnsla` / `route53` / `googleclouddns` / `azure` / `digitalocean` / `vultr` / `linode` / `hetzner` / `ovh` / `gandi` / `godaddy` / `porkbun` / `namesilo` / `gcore` / `bunny` / `desec` / `powerdns` / `rfc2136` / `webhook` | DNS 服务商 |
| `zone` | body | string | 是 | 域名，不能是泛域名；转为小写 | DNS 区域 |
| `credentials` | body | object | 是 | 1–10 个字段；字段名最长 64 字符，值最长 16384 字符；须符合服务商的字段定义 | 凭据字段 |

保存前不测试凭据。审计 `dns_credential.create`。

响应：[DNS 凭据](#dns-凭据对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `DNS_CREDENTIAL_INVALID` | 400 | `credentials` 不符合服务商的字段定义 |

### `dnsCredentials.update`

`PUT /dns-credentials/{id}` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 凭据 ID |
| `name` | body | string | 否 | 去掉首尾空格后 1–100 字符；省略时不变 | 凭据名称 |
| `credentials` | body | object | 否 | 同 `dnsCredentials.create`，须给出全部字段；省略时不变 | 新凭据 |

`provider` 与 `zone` 不能修改。提供 `credentials` 时，使用该凭据且状态为 `error` 的证书与清理失败的 TXT 记录立即重试。审计 `dns_credential.update`。

响应：[DNS 凭据](#dns-凭据对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `DNS_CREDENTIAL_NOT_FOUND` | 404 | 凭据不存在 |
| `DNS_CREDENTIAL_INVALID` | 400 | `credentials` 不符合服务商的字段定义 |

### `dnsCredentials.delete`

`DELETE /dns-credentials/{id}` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 凭据 ID |

审计 `dns_credential.delete`。

响应：`{ ok: true }`。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `DNS_CREDENTIAL_NOT_FOUND` | 404 | 凭据不存在 |
| `DNS_CREDENTIAL_IN_USE` | 409 | 有证书使用该凭据；`data.certificates` 列出最多 5 张 |

### `dnsCredentials.zones`

`POST /dns-credentials/zones` · 写

请求体为以下两种之一：

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | body | uuid | 是 | — | 已保存的凭据 |

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `provider` | body | enum | 是 | 同 `dnsCredentials.create` | DNS 服务商 |
| `credentials` | body | object | 是 | 同 `dnsCredentials.create` | 未保存的凭据字段 |

只适用于能列出区域的服务商。不写审计。

响应：`{ zones: string[] }`：区域名，小写、去掉末尾的点、去重、排序，最多 1000 个。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `DNS_CREDENTIAL_NOT_FOUND` | 404 | `id` 的凭据不存在 |
| `DNS_CREDENTIAL_INVALID` | 400 | `credentials` 不符合服务商的字段定义 |
| `DNS_ZONES_UNSUPPORTED` | 400 | 服务商不能列出区域 |
| `DNS_PROVIDER_AUTH_FAILED` | 400 | 服务商拒绝凭据 |
| `DNS_PROVIDER_ZONE_NOT_FOUND` | 400 | 服务商没有该区域 |
| `DNS_ADDRESS_REFUSED` | 400 | 服务商地址被出站策略拒绝 |
| `DNS_PROVIDER_UNREACHABLE` | 502 | 无法连接服务商 |
| `DNS_PROVIDER_RATE_LIMITED` | 429 | 服务商限流，或控制台进程已有 4 个服务商检查在进行 |
| `DNS_PROVIDER_FAILED` | 502 | 服务商请求的其他失败 |

### `dnsCredentials.test`

`POST /dns-credentials/test` · 写

请求体为以下两种之一：

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | body | uuid | 是 | — | 已保存的凭据，测试其区域 |

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `provider` | body | enum | 是 | 同 `dnsCredentials.create` | DNS 服务商 |
| `credentials` | body | object | 是 | 同 `dnsCredentials.create` | 未保存的凭据字段 |
| `zone` | body | string | 是 | 域名，不能是泛域名；转为小写 | DNS 区域 |

用凭据读取区域的记录，不写入。不写审计。

响应：`{ ok: true, records }`：`records` 为读到的记录数（integer）。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `DNS_CREDENTIAL_NOT_FOUND` | 404 | `id` 的凭据不存在 |
| `DNS_CREDENTIAL_INVALID` | 400 | `credentials` 不符合服务商的字段定义 |
| `DNS_PROVIDER_AUTH_FAILED` | 400 | 服务商拒绝凭据 |
| `DNS_PROVIDER_ZONE_NOT_FOUND` | 400 | 服务商没有该区域 |
| `DNS_ADDRESS_REFUSED` | 400 | 服务商地址被出站策略拒绝 |
| `DNS_ZONES_UNSUPPORTED` | 400 | 服务商不支持该操作 |
| `DNS_PROVIDER_UNREACHABLE` | 502 | 无法连接服务商 |
| `DNS_PROVIDER_RATE_LIMITED` | 429 | 服务商限流，或控制台进程已有 4 个服务商检查在进行 |
| `DNS_PROVIDER_FAILED` | 502 | 服务商请求的其他失败 |

## 回源客户端 CA（源站双向 TLS）

节点回源时出示的客户端证书由回源客户端 CA 签发。行为见 [回源客户端证书](../../guide/https.md#回源客户端证书) 与 [轮换 CA](../../guide/https.md#轮换-ca)。

- CA 为 ECDSA P-256，有效期 10 年；轮换生成的 CA 名称带代数（如 `Edgeweir Origin Client CA G2`）。
- 每个有网站出示客户端证书的集群持有一张证书，有效期 90 天，到期前 30 天由每小时的任务更换。
- 轮换：`rotate`（新 CA 为 `next`，只受信任、不签发）→ `activate`（新 CA 签发，原 CA 为 `previous`）→ `retire`；`activate` 之前可 `cancel`。
- 所有过程都返回 [回源客户端 CA](#回源客户端-ca-对象)；除 `get` 与 `create` 外，CA 未创建时返回 409 `ORIGIN_CLIENT_CA_NOT_FOUND`。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`originClientCa.get`](#originclientcaget) | `GET /origin-client-ca` | 读 |
| [`originClientCa.create`](#originclientcacreate) | `POST /origin-client-ca` | 写 |
| [`originClientCa.rotate`](#originclientcarotate) | `POST /origin-client-ca/rotation` | 写 |
| [`originClientCa.activate`](#originclientcaactivate) | `POST /origin-client-ca/rotation/activate` | 写 |
| [`originClientCa.retire`](#originclientcaretire) | `POST /origin-client-ca/rotation/retire` | 写 |
| [`originClientCa.cancel`](#originclientcacancel) | `DELETE /origin-client-ca/rotation` | 写 |

### `originClientCa.get`

`GET /origin-client-ca` · 读

无参数。

响应：[回源客户端 CA](#回源客户端-ca-对象)。

### `originClientCa.create`

`POST /origin-client-ca` · 写

无参数。

创建 CA；已存在时不变并原样返回。创建时审计 `origin_client_ca.create`。

响应：[回源客户端 CA](#回源客户端-ca-对象)。

### `originClientCa.rotate`

`POST /origin-client-ca/rotation` · 写

无参数。

生成新 CA 作为 `next`，还不签发；源站应先信任它（`trustBundlePem`）。审计 `origin_client_ca.rotation_start`。

响应：[回源客户端 CA](#回源客户端-ca-对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `ORIGIN_CLIENT_CA_NOT_FOUND` | 409 | CA 未创建 |
| `CA_ROTATION_IN_PROGRESS` | 409 | 已有 `next` 或 `previous` |

### `originClientCa.activate`

`POST /origin-client-ca/rotation/activate` · 写

无参数。

`next` 改为在用，原 CA 改为 `previous`；随后为每个有网站出示客户端证书的集群签发新 CA 的证书，最新配置版本已带回源客户端证书的集群发布新版本（原因 `origin_client_certificate_rotated`），每个集群审计 `origin_client_certificate.rotate`。失败的集群保留原证书，由每小时的任务重试。审计 `origin_client_ca.activate`。

响应：[回源客户端 CA](#回源客户端-ca-对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `ORIGIN_CLIENT_CA_NOT_FOUND` | 409 | CA 未创建 |
| `CA_ROTATION_STEP_UNAVAILABLE` | 409 | 没有 `next` |

### `originClientCa.retire`

`POST /origin-client-ca/rotation/retire` · 写

无参数。

删除 `previous`。审计 `origin_client_ca.retire`。

响应：[回源客户端 CA](#回源客户端-ca-对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `ORIGIN_CLIENT_CA_NOT_FOUND` | 409 | CA 未创建 |
| `CA_ROTATION_STEP_UNAVAILABLE` | 409 | 没有 `previous` |
| `CA_ROTATION_INCOMPLETE` | 409 | 仍有集群出示 `previous` 签发的证书；`data.clusters` 列出最多 5 个，其余为 `+N` |

### `originClientCa.cancel`

`DELETE /origin-client-ca/rotation` · 写

无参数。

删除 `next`。审计 `origin_client_ca.rotation_cancel`。

响应：[回源客户端 CA](#回源客户端-ca-对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `ORIGIN_CLIENT_CA_NOT_FOUND` | 409 | CA 未创建 |
| `CA_ROTATION_STEP_UNAVAILABLE` | 409 | 没有 `next` |

## Origin CA

Origin CA 签发只有边缘节点信任的源站服务器证书。行为见 [Origin CA](../../guide/https.md#origin-ca) 与 [轮换 CA](../../guide/https.md#轮换-ca)。

- CA 为 ECDSA P-256，有效期 20 年。
- 轮换：`rotate`（新 CA 立即签发，原 CA 为 `previous`，节点同时信任两者）→ `retire`；新 CA 签发的证书都已吊销或过期时可 `cancel`。
- `rotate`、`retire`、`cancel` 为有网站信任 Origin CA 的集群发布配置版本，原因依次为 `origin_ca_rotation_started`、`origin_ca_retired`、`origin_ca_rotation_cancelled`。
- 所有过程都返回 [Origin CA](#origin-ca-对象)；除 `get` 与 `create` 外，CA 未创建时返回 409 `ORIGIN_CA_NOT_FOUND`。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`originCa.get`](#origincaget) | `GET /origin-ca` | 读 |
| [`originCa.create`](#origincacreate) | `POST /origin-ca` | 写 |
| [`originCa.rotate`](#origincarotate) | `POST /origin-ca/rotation` | 写 |
| [`originCa.retire`](#origincaretire) | `POST /origin-ca/rotation/retire` | 写 |
| [`originCa.cancel`](#origincacancel) | `DELETE /origin-ca/rotation` | 写 |

### `originCa.get`

`GET /origin-ca` · 读

无参数。

响应：[Origin CA](#origin-ca-对象)。

### `originCa.create`

`POST /origin-ca` · 写

无参数。

创建 CA；已存在时不变并原样返回。创建时审计 `origin_ca.create`。

响应：[Origin CA](#origin-ca-对象)。

### `originCa.rotate`

`POST /origin-ca/rotation` · 写

无参数。

生成新 CA 并从此用它签发，原 CA 改为 `previous`。审计 `origin_ca.rotation_start`。

响应：[Origin CA](#origin-ca-对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `ORIGIN_CA_NOT_FOUND` | 409 | CA 未创建 |
| `CA_ROTATION_IN_PROGRESS` | 409 | 已有 `previous` |
| `NODE_CAPABILITY_REQUIRED` | 409 | 有网站信任 Origin CA 的集群中，有活动节点缺少 `origin-ca-rotation-v1`；`data.features`、`data.nodes` |

### `originCa.retire`

`POST /origin-ca/rotation/retire` · 写

无参数。

删除 `previous`，节点不再信任它签发的证书，即使这些证书仍有效（`previousCertificates`）。审计 `origin_ca.retire`（`validCertificates`）。

响应：[Origin CA](#origin-ca-对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `ORIGIN_CA_NOT_FOUND` | 409 | CA 未创建 |
| `CA_ROTATION_STEP_UNAVAILABLE` | 409 | 没有 `previous` |

### `originCa.cancel`

`DELETE /origin-ca/rotation` · 写

无参数。

删除新 CA 及其签发的证书，`previous` 恢复在用。审计 `origin_ca.rotation_cancel`。

响应：[Origin CA](#origin-ca-对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `ORIGIN_CA_NOT_FOUND` | 409 | CA 未创建 |
| `CA_ROTATION_STEP_UNAVAILABLE` | 409 | 没有 `previous` |
| `CA_ROTATION_IN_USE` | 409 | 新 CA 签发的证书中仍有未吊销、未过期的；`data.count` |

## 源站证书

Origin CA 签发的源站服务器证书。行为见 [Origin CA](../../guide/https.md#origin-ca)。

| 过程 | 方法与路径 | 权限 |
| --- | --- | --- |
| [`originCertificates.list`](#origincertificateslist) | `GET /origin-certificates` | 读 |
| [`originCertificates.issue`](#origincertificatesissue) | `POST /origin-certificates` | 写 |
| [`originCertificates.revoke`](#origincertificatesrevoke) | `POST /origin-certificates/{id}/revoke` | 写 |

### `originCertificates.list`

`GET /origin-certificates` · 读

无参数。

响应：[源站证书](#源站证书对象)`[]`，按签发时间从新到旧。

### `originCertificates.issue`

`POST /origin-certificates` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `hostnames` | body | `array<string>` | 是 | 1–50 项，去重；每项为主机名（可为单标签、可带 `*.` 前缀）或 IP 地址，最长 253 字符，转为小写 | 证书名称；第一项为 CN |
| `validityYears` | body | integer | 否 | `1` / `3` / `5` / `10` / `15`，默认 `15` | 有效期（年，每年按 365 天），不超过 Origin CA 的到期时间 |
| `keyType` | body | enum | 否 | `ec256` / `rsa2048`，默认 `ec256` | 控制台生成的密钥类型；提供 `csrPem` 时忽略 |
| `csrPem` | body | string | 否 | 去掉首尾空格后最长 16384 字符；空字符串视为未提供 | PEM 证书签名请求：校验签名，只取公钥（RSA 2048 / 3072 / 4096 或 ECDSA P-256 / P-384） |

不提供 `csrPem` 时控制台生成私钥，只在本次响应中返回。审计 `origin_certificate.issue`（不含私钥）。

响应：[源站证书](#源站证书对象)，另有 `privateKeyPem`（string）：生成的 PKCS #8 PEM 私钥；提交 CSR 时为空字符串。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `ORIGIN_CA_NOT_FOUND` | 409 | Origin CA 未创建 |
| `ORIGIN_CERTIFICATE_CSR_INVALID` | 400 | CSR 无法读取、密钥类型不支持或签名无效 |

### `originCertificates.revoke`

`POST /origin-certificates/{id}/revoke` · 写

| 参数 | 位置 | 类型 | 必填 | 约束与默认值 | 说明 |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | 是 | — | 源站证书 ID |

由签发它的 CA 重新生成 CRL，为有网站信任 Origin CA 的集群发布配置版本（原因 `origin_certificate_revoked`），节点从该版本起拒绝该证书。签发它的 CA 已退役时只做标记，不发布。审计 `origin_certificate.revoke`。

响应：[源站证书](#源站证书对象)。

| 错误 | 状态 | 条件 |
| --- | --- | --- |
| `ORIGIN_CERTIFICATE_NOT_FOUND` | 404 | 证书不存在 |
| `ORIGIN_CERTIFICATE_REVOKED` | 409 | 证书已吊销 |

## 对象

### 证书对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 证书 ID |
| `name` | string | 名称 |
| `names` | `array<string>` | 证书包含的名称 |
| `source` | enum | `upload`（上传）/ `acme`（控制台申请） |
| `status` | enum | `pending`（等待签发）/ `issuing`（签发中）/ `ready`（已签发）/ `error`（签发失败，或上传的证书节点无法加载） |
| `fingerprint` | string | 叶证书 SHA-256 指纹，小写十六进制；未签发时为空字符串 |
| `notBefore` | datetime | 生效时间，或 `null`（未签发） |
| `notAfter` | datetime | 到期时间，或 `null`（未签发） |
| `autoRenew` | boolean | 自动续期 |
| `renewAt` | datetime | 下次续期时间，或 `null` |
| `lastError` | string | 上次签发或续期失败的代码（如 `acme_rate_limited`；DNS-01 的服务商失败为 `dns_auth_failed` 等 DNS 代码），没有时为空字符串；上传的证书节点无法加载时为 `certificate_chain_explicit_curve` 或 `certificate_key_explicit_curve`。见 [故障排查](../../guide/https.md#故障排查) |
| `bindSiteId` | uuid | 签发后要绑定的网站（`certificates.request` 的 `bindSiteId`），或 `null`；签发后为 `null` |
| `nodeFailures` | `array<object>` | 报告无法加载该证书的节点（需要 `certificate-isolation-v1`）：`nodeId`（uuid）、`nodeName`（string）、`reason`（enum：`invalid_material` / `fingerprint_mismatch` / `unavailable`）、`servingEarlier`（boolean：节点继续使用之前的证书，否则拒绝相应的 TLS 握手）。只有 `certificates.list` 填写，其他过程返回 `[]` |

### ACME 账户对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 账户 ID |
| `directoryUrl` | string | ACME 目录地址 |
| `ca` | enum | 目录对应的 CA：`letsencrypt` / `zerossl` / `google`，`custom`（当前生效的自定义目录），或 `null`（其他目录） |
| `email` | string | 账户邮箱 |
| `eabKid` | string | EAB 密钥 ID，没有 EAB 时为空字符串 |
| `createdAt` | datetime | 创建时间 |
| `certificates` | integer | 使用该账户的证书数 |

### DNS 凭据对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 凭据 ID |
| `name` | string | 名称 |
| `provider` | string | DNS 服务商（`dnsCredentials.create` 的 `provider` 取值） |
| `zone` | string | DNS 区域 |

### 回源客户端 CA 对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `authority` | [CA](#ca-对象) | 在用的 CA（签发集群的证书），或 `null`（未创建） |
| `next` | [CA](#ca-对象) | 轮换中尚未启用的新 CA，或 `null` |
| `previous` | [CA](#ca-对象) | 轮换替换下、尚未退役的原 CA，或 `null` |
| `trustBundlePem` | string | 源站此时应信任的全部 CA 证书（PEM）：在用的在前，轮换中另有 `next` 或 `previous`；未创建时为空字符串 |
| `certificates` | array<[回源客户端证书](#回源客户端证书对象)> | 每个集群当前的证书，按集群名称排序；未创建时为 `[]` |
| `pendingClusters` | `array<object>` | 有 `previous` 时，网站出示客户端证书、当前证书不是在用 CA 签发的集群：`clusterId`（uuid）、`clusterName`（string），按名称排序；否则为 `[]` |

### CA 对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `certificatePem` | string | CA 证书（PEM） |
| `fingerprint` | string | DER 证书的 SHA-256，小写十六进制 |
| `notBefore` | datetime | 生效时间 |
| `notAfter` | datetime | 到期时间 |

### 回源客户端证书对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 证书 ID |
| `clusterId` | uuid | 集群 ID |
| `clusterName` | string | 集群名称 |
| `serial` | string | 序列号 |
| `fingerprint` | string | SHA-256 指纹 |
| `notBefore` | datetime | 生效时间 |
| `notAfter` | datetime | 到期时间 |
| `authority` | enum | 签发它的 CA：`active`（在用）/ `previous`（轮换中的原 CA）/ `retired`（已退役） |

不含私钥。

### Origin CA 对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `authority` | [CA](#ca-对象) | 在用的 CA（签发源站证书），或 `null`（未创建） |
| `previous` | [CA](#ca-对象) | 轮换替换下的原 CA，退役前节点仍信任它；平时为 `null` |
| `previousCertificates` | integer | `previous` 签发、未吊销且未过期的证书数；退役会使这些证书失效。没有 `previous` 时为 `0` |

### 源站证书对象

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 证书 ID |
| `hostnames` | `array<string>` | 证书名称（主机名或 IP 地址） |
| `keyType` | string | 密钥类型：`ec256` / `ec384` / `rsa2048` / `rsa3072` / `rsa4096`（CSR 的密钥） |
| `source` | enum | `generated`（控制台生成密钥）/ `csr`（提交 CSR） |
| `serial` | string | 序列号 |
| `fingerprint` | string | SHA-256 指纹 |
| `certificatePem` | string | 证书（PEM） |
| `notBefore` | datetime | 生效时间 |
| `notAfter` | datetime | 到期时间 |
| `revokedAt` | datetime | 吊销时间，或 `null` |
| `createdAt` | datetime | 签发时间 |
| `authority` | enum | 签发它的 CA：`active`（在用）/ `previous`（轮换中的原 CA）/ `retired`（已退役） |
