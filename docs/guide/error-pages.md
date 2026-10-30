# 错误页

节点返回的错误页：网站的模板与跳转、维护模式、平台错误页、内置页面、`X-Edgeweir-Error` 错误码与请求 ID。

## 概念

| 术语 | 定义 |
| --- | --- |
| 网站错误页 | 网站为某个状态码或「其他 4xx」「其他 5xx」设置的 HTML 模板或跳转 URL，替换节点的内置页面，也可替换源站的错误响应。 |
| 维护模式 | 网站暂停服务：除放行的地址和路径外，所有请求得到 503 维护页。 |
| 平台错误页 | 为未知域名和已停用网站填写的 HTML 模板，对所有集群生效。 |
| 内置页面 | 没有模板时节点使用的页面，按 `Accept-Language` 显示中文或英文。 |
| `X-Edgeweir-Error` | 节点自己生成的错误响应带的响应头，值为错误码（如 `policy-denied`），说明请求被拒绝或失败的原因。 |
| 请求 ID | 节点为每个请求确定的 ID，出现在响应头 `X-Request-Id`、错误页和采样日志中。 |
| 离线 Host | 已停用网站的域名；节点据此显示平台的停用页面，而不是未知域名页面。 |

## 设置网站错误页

页面：**网站** → 选择网站 →「错误页」页签（`/sites/<网站 ID>?tab=errors`）。页签上方是「维护模式」卡片（见[维护模式](#维护模式)），下方是「错误页」卡片。

1. 在「错误页」卡片中找到状态码所在的行。行右上角的切换选择「HTML 模板」或「跳转到 URL」。
2. 「HTML 模板」：在文本框中填写模板，右侧显示「{bytes} / 65,536 字节」；需要改写发出的状态码时填写「响应状态码」。「跳转到 URL」：填写 URL（占位示例 `/error?code={{status}}`）。留空的行使用内置页面。
3. 需要替换源站自己返回的错误时，打开「替换源站错误响应」。
4. 点击「保存」。控制台发布网站所在集群的新配置版本（原因「修改网站 {site} 的错误页」），节点热更新，不重新加载 nginx。
5. 验证：

   ```bash
   curl -s -D - -H 'Host: www.example.com' http://<节点 IP>/<被规则拒绝的路径>
   ```

   返回 403、`Content-Type: text/html; charset=utf-8`、`Cache-Control: no-store` 和模板内容。

| 字段 | 取值 | 默认值 | 说明 |
| --- | --- | --- | --- |
| 模式 | 「HTML 模板」/「跳转到 URL」 | 「HTML 模板」 | 每个状态码一个页面，二选一；集群有活动节点缺少 `site-content-v1` 时不显示切换 |
| 模板 | HTML，1–65536 字节（UTF-8） | 空（内置页面） | 规则见[模板](#模板)；超过上限时显示「{status} 错误页超过 65,536 字节」，不能保存 |
| 跳转 URL | 见[跳转页面](#跳转页面) | 空 | 不合法时显示「检查「跳转到 URL」」，不能保存 |
| 响应状态码 | 200–599 的整数 | 空（保持原状态码） | 只用于模板页面；超出范围时显示「须为 200 到 599 之间的整数」 |
| 替换源站错误响应 | 开 / 关 | 关 | 见下表「替换源站错误响应」 |

卡片底部列出模板可用的占位符（「可用变量（值经 HTML 转义）：」）。保存为整体替换：清空的行删除该状态码的页面。修改写审计 `site.error_pages_update`（记录变化的状态码、模板字节数与跳转页面，不记录模板内容）。

| 状态码 | 使用该页面的响应 | `X-Edgeweir-Error` |
| --- | --- | --- |
| 400 请求无效 | 节点无法解析的请求、请求头过大、HTTPS 端口收到明文请求（能确定网站时）；OWASP CRS 无法解析请求体时拒绝 | `bad-request`、`header-too-large`、`https-required`、`waf-blocked` |
| 401 需要认证 | [访问鉴权](access-control.md)的 Basic 认证没有凭据或凭据错误（带 `WWW-Authenticate`）；也用于替换源站返回的 401 | `auth-required`；源站的为 `origin-error` |
| 403 拒绝访问 | 规则拒绝与 IP 名单（含限速规则选 403 时）、封禁与 CC 自动封禁、OWASP CRS 拦截、关闭 WebSocket 时的升级请求、URL 鉴权失败、转发鉴权拒绝、[访问控制](access-control.md)的拒绝、网站要求客户端证书而请求没有 | `policy-denied`、`ip-banned`、`waf-blocked`、`websocket-disabled`、`auth-denied`、`auth-expired`、`ip-blocked`、`geo-denied`、`cors-origin-denied`、`hotlink-denied`、`ua-denied`、`websocket-origin-denied`、`client-cert-required` |
| 404 页面不存在 | 只用于替换源站返回的错误 | `origin-error` |
| 405 方法不允许 | S3 源站不接收的方法 | `method-not-allowed` |
| 410 已删除 | 只用于替换源站返回的错误 | `origin-error` |
| 429 请求过多 | 限速规则、[灰名单](bans.md#灰名单)的限速、Basic 认证失败限速 | `policy-denied`、`ip-greylisted`、`auth-rate-limited` |
| 500 服务器错误 | 节点处理请求时出错（能确定网站时） | `internal-error` |
| 502 网关错误 | 节点连不上源站、全部源站在尝试前被剔除、回源签名失败 | `origin-unreachable`、`no-origin`、`origin-signing` |
| 503 服务不可用 | 节点暂时无法完成检查（例如挑战密钥尚未下发、限速分区缺失）、转发鉴权的鉴权服务不可用 | `challenge-unavailable`、`policy-unavailable`、`rate-limit-unavailable`、`auth-unavailable` |
| 504 网关超时 | 源站响应超时 | `origin-timeout` |
| 其他 4xx / 其他 5xx | 上面没有单独页面的 4xx / 5xx：节点生成的 413、414，源站返回的其他状态码 | 同对应状态 |
| 规则设置的状态码 | 规则的「自定义响应」打开「使用错误页」（4xx、5xx），见[WAF 动作](rules.md#waf-动作) | `rule-response` |

| 查找顺序 | 说明 |
| --- | --- |
| 1 | 该状态码自己的页面 |
| 2 | 「其他 4xx」或「其他 5xx」 |
| 3 | 内置页面；源站的错误没有页面时原样返回 |

| 项目 | 行为 |
| --- | --- |
| 替换源站错误响应 | 打开后，源站自己返回 400–599 且按查找顺序找到网站的页面时，节点改为返回该页面（`origin-error`），并去掉源站的 `Content-Encoding`、`ETag`、`Last-Modified`、`Expires`；找不到页面时原样返回源站的响应 |
| 401 | 带 `WWW-Authenticate`，状态固定 401：401 页面是跳转页面时改用「其他 4xx」的模板页面，再没有时用内置页面；「响应状态码」不生效 |
| 维护模式 | 503 使用维护页，不使用 503 页面，见[维护模式](#维护模式) |
| 过期内容优先 | 规则设置了「回源出错时用旧缓存（秒）」且节点持有过期副本时，仍返回旧内容，不返回错误页；过期副本已不能使用时返回 502 错误页（`origin-unreachable`） |
| 不缓存 | 错误页带 `Cache-Control: no-store`，节点也不把它存入缓存 |
| 其他状态码 | 节点自己返回的 404（ACME 挑战不存在）、421（`sni-host-mismatch`）、508（`loop-detected`）等仍为纯文本；没有通行凭证的非 GET/HEAD 请求被挑战拒绝时（`X-Edgeweir-Challenge: required`）也是纯文本；PURGE 方法的应答为 JSON |

## 跳转页面

页面选择「跳转到 URL」后，该状态的响应改为 302 跳转。

| 项目 | 规则 |
| --- | --- |
| URL | 绝对 `http://` / `https://` URL 或以单个 `/` 开头的路径；1–2048 个可打印 ASCII 字符，不含空格与 `\`；`%` 后必须是两位十六进制数字 |
| 绝对 URL 的主机 | 点分十进制 IPv4 地址、最后一段以字母开头的域名，或方括号中的 IPv6 地址；不含账号，可带端口 |
| 占位符 | 只允许 `{{status}}` 与 `{{request_id}}`，不能出现在主机或端口中，值按 URL 编码后替换，例如 `/error?code={{status}}&id={{request_id}}` |
| 响应 | 302、`Location`、`Cache-Control: no-store`、`X-Edgeweir-Error`，正文为空 |
| 响应状态码 | 跳转页面固定 302；HTML 模板页面可填写 200–599 改写发出的状态码，留空保持原状态码 |

## 维护模式

「错误页」页签的「维护模式」卡片：打开「启用」，按需填写「Retry-After（秒）」「放行地址」「放行路径前缀」与「维护页」，点击「保存」。关闭时其余设置保留。

| 字段 | 取值 | 默认值 | 作用 |
| --- | --- | --- | --- |
| 启用 | 开 / 关 | 关 | 开启维护模式 |
| Retry-After（秒） | 0–86400 的整数 | 0（不发送） | 503 响应的 `Retry-After` |
| 放行地址 | IP 或 CIDR，每个最长 64 字符，最多 64 个；以逗号、空格或换行分隔；主机位清零，`::ffff:` 形式的 IPv4 映射地址按对应的 IPv4 保存，短于 /96 的映射前缀被拒（同 IP 名单）；重复项合并 | 空 | 来自这些地址的请求照常访问 |
| 放行路径前缀 | 以 `/` 开头，不含 `?`、`#` 与控制字符，每个最长 1024 字节（UTF-8），最多 32 个；分隔方式同上 | 空 | 路径以其中之一开头的请求照常访问 |
| 维护页 | HTML 模板，0–65536 字节，规则同[模板](#模板) | 空（内置维护页） | 503 响应的页面 |

| 项目 | 行为 |
| --- | --- |
| 响应 | 503、`X-Edgeweir-Error: maintenance`、`Cache-Control: no-store`；不查缓存、不回源，维护期间的响应不进入缓存 |
| 判断位置 | 在封禁与 PURGE 之后、规则之前；放行地址与访客地址比较（同规则的 `ip.src`，由集群的[访客 IP](../deploy/nodes.md#访客-ip) 决定），路径前缀与规范化后、规则改写前的路径比较 |
| ACME | 证书的 HTTP-01 验证请求不受影响 |
| 生效 | 保存后发布版本（原因「修改网站 {site} 的维护模式」），节点热更新 |
| 审计 | `site.maintenance_update`（记录各字段与维护页字节数，不记录维护页内容） |
| 用量保护 | [用量保护](usage-protection.md)的「开启维护模式」动作只切换「启用」，沿用这里保存的其余设置；在此关闭维护模式等于手动恢复该动作 |
| 节点要求 | `site-content-v1`；集群有活动节点不支持时卡片显示「集群中有节点不支持」，不能开启；已开启的可以关闭 |

## 模板

| 项目 | 规则 |
| --- | --- |
| 大小 | 每个模板 1–65536 字节（UTF-8）；维护页可为空 |
| 内容 | 原样发送，节点不检查也不转义模板本身；模板引用的脚本、样式和图片由网站负责 |
| 占位符 | 下表六个；值替换前做 HTML 转义（`&`、`<`、`>`、`"`、`'`）；其他 `{{…}}` 原样保留 |
| 响应头 | `Content-Type: text/html; charset=utf-8`、`Cache-Control: no-store`、`X-Edgeweir-Error`、`X-Request-Id` |

| 占位符 | 值 |
| --- | --- |
| `{{status}}` | 状态码，例如 `403` |
| `{{request_id}}` | 请求 ID，与响应头 `X-Request-Id` 相同 |
| `{{client_ip}}` | 访问者 IP，与规则的 `ip.src` 相同（按集群的[访客 IP](../deploy/nodes.md#访客-ip) 设置取得） |
| `{{host}}` | 请求的 Host，小写，不含端口；请求没有合法的 Host 时为空 |
| `{{time}}` | 节点应答的时间，UTC，RFC 3339，例如 `2026-10-06T12:34:56Z`；需要 `rules-v3` |
| `{{path}}` | 请求路径（nginx 规范化后的 `$uri`，与规则的 `http.request.uri.path` 相同，改写后为改写后的路径）；需要 `rules-v3` |

示例：

```html
<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<title>{{status}}</title>
<h1>请求未完成</h1>
<p>请求 ID：{{request_id}}</p>
<p>{{time}} · {{path}}</p>
```

## 内置页面

没有模板时，节点返回自包含的内置页面：不引用外部资源，没有脚本，跟随系统的浅色或深色。页面显示状态码和一条从访客经边缘节点到源站的链路，标出出问题的一环（访客、边缘节点或源站）及其状态；下方是标题、访客可以怎么做、可能有用时的「重新加载」，以及请求 ID、节点应答的时间（UTC）、域名和访客的 IP（点击显示）。动效只用 CSS，系统开启「减少动态效果」时为静止画面。语言按 `Accept-Language` 中权重最高的中文或英文选择，两者都没有时为英文。

| 页面 | 状态码 | `X-Edgeweir-Error` |
| --- | --- | --- |
| 需要认证 / 拒绝访问 / 请求过于频繁 / 无法连接源站 / 服务暂不可用 / 源站响应超时 | 401 / 403 / 429 / 502 / 503 / 504 | 见[设置网站错误页](#设置网站错误页)的状态码表 |
| 不支持的请求方法 | 405 | `method-not-allowed` |
| 维护中 | 503 | `maintenance` |
| 站点不存在 | 404 | `unknown-host` |
| 站点已停用 | 503 | `site-disabled` |

节点自己拒绝的请求和节点内部错误：能确定网站时按[查找顺序](#设置网站错误页)使用网站的页面，否则返回内置页面。拒绝的请求在链路上标出访客，内部错误标出边缘节点：

| 页面 | 状态码 | 适用的请求 | `X-Edgeweir-Error` |
| --- | --- | --- | --- |
| 请求无效 | 400 | 无法解析的请求（例如向 HTTP 端口发起 TLS 握手）、缺少或非法的 Host；OWASP CRS 无法解析的请求体 | `bad-request`；CRS 拒绝时为 `waf-blocked` |
| 请求头过大 | 400 | 单个请求头超过 8 KB 或全部请求头超过 32 KB，常见于 Cookie 过多 | `header-too-large` |
| 需要使用 HTTPS | 400 | 向 HTTPS 端口发送明文 HTTP 请求 | `https-required` |
| 网址过长 | 414 | 请求行超过 8 KB | `uri-too-long` |
| 请求内容过大 | 413 | 请求体超过网站或规则的[请求体上限](origins-and-cache.md#请求体上限)，或分块请求超过节点全局上限 | `body-too-large` |
| 边缘节点出错 | 500 | 节点处理请求时出错 | `internal-error` |

## 平台错误页

页面：**系统设置** →「通用」页签 →「平台错误页」卡片。字段为「未知域名」与「网站已停用」两个模板，规则与网站模板相同，留空使用内置页面。保存后所有集群各发布一个配置版本（原因「修改平台错误页」），修改写审计 `system.error_pages_update`，见[系统设置](system.md#平台错误页)。模板用到 `{{time}}` 或 `{{path}}` 时卡片提示「{time} 与 {path} 需要 rules-v3，未升级的节点沿用上一版配置」。

| 字段 | 适用的请求 | 状态码 | `X-Edgeweir-Error` |
| --- | --- | --- | --- |
| 未知域名 | Host 不属于集群的任何网站，也不是离线 Host；集群的[未知域名设置](domains.md#未知域名与节点-ip-访问)为「未知域名页（404）」时 | 404 | `unknown-host` |
| 网站已停用 | Host 是已停用网站的域名 | 503 | `site-disabled` |

节点从配置中的离线 Host 列表（已停用网站的域名）识别已停用的网站；泛域名按网站域名的规则匹配。重新启用网站后，该 Host 恢复服务；删除网站或从网站移除该域名后，它不再是离线 Host，返回 404。两个页面只用于 HTTP 请求：节点不为这些 Host 完成 TLS 握手，HTTPS 请求在握手时失败。

## 请求 ID

| 项目 | 行为 |
| --- | --- |
| 生成 | 请求带有符合 `^[A-Za-z0-9._:-]{8,128}$` 的 `X-Request-Id` 时沿用，否则节点生成 32 位十六进制 ID |
| 响应 | 每个响应都带 `X-Request-Id`；源站自己返回的 `X-Request-Id` 被替换 |
| 回源 | 以 `X-Request-Id` 请求头转发给源站 |
| 日志 | 采样访问日志记录请求 ID，「日志」页签可按「请求 ID」精确查询，CSV 有 `requestId` 列，见[访问日志](access-logs.md) |

## 节点要求

| 功能 | 要求 |
| --- | --- |
| 网站错误页 | 节点能力 `error-pages-v1`；集群有活动节点不支持时「错误页」卡片显示「集群中有节点不支持」，各行不可编辑 |
| 平台错误页、离线 Host | 不要求能力；旧节点忽略它们，仍返回纯文本，对离线 Host 返回 404 |
| `{{time}}`、`{{path}}` | 网站模板或平台错误页用到它们时，配置要求节点能力 `rules-v3`；网站所在集群有活动节点不支持时，「错误页」卡片不列这两个占位符，模板用到时显示「集群中有节点不支持」。缺少能力的节点保留 last-known-good 配置，见[节点能力与发布](rules.md#节点能力与发布) |
| 拒绝的请求与内部错误的内置页面 | 不要求能力；旧节点返回 nginx 自带的错误页 |
| 400、401、404、405、410、500、「其他 4xx」「其他 5xx」、跳转页面、响应状态码、维护模式 | 节点能力 `site-content-v1`；集群有活动节点不支持时「错误页」卡片只能新填 403、429、502、503、504 的模板，不显示「HTML 模板」/「跳转到 URL」切换与「响应状态码」，并显示「集群中有节点不支持」；已保存的页面仍可修改或清空 |
| 经 API 保存 | 控制台账户（会话或 AccessKey）保存需要新能力的配置时照常发布，缺少能力的节点显示「需要升级」并沿用原配置 |
| 模板容量 | 模板随网站表下发到节点共享内存；网站很多且模板很大时，用节点参数 `--sites-dict-mb`（默认 64）增大 |

## 接口

| 操作 | 过程 | 方法与路径（`/api/v1`） |
| --- | --- | --- |
| 读取网站错误页 | `errorPages.get` | `GET /sites/{id}/error-pages` |
| 保存网站错误页 | `errorPages.update` | `PUT /sites/{id}/error-pages` |
| 读取维护模式 | `maintenance.get` | `GET /sites/{id}/maintenance` |
| 保存维护模式 | `maintenance.update` | `PUT /sites/{id}/maintenance` |
| 读取平台错误页 | `settings.errorPages` | `GET /settings/error-pages` |
| 保存平台错误页 | `settings.setErrorPages` | `PUT /settings/error-pages` |

| 请求 | 字段 |
| --- | --- |
| `PUT /sites/{id}/error-pages` | `pages`：至多 13 项，每个状态码至多一项，`{ status, template, redirectUrl, responseStatus }`；`status` 为 400、401、403、404、405、410、429、500、502、503、504 或 `"4xx"`、`"5xx"`；`template` 与 `redirectUrl` 二选一；`responseStatus` 为 0（不改）或 200–599，跳转页面只能为 0。`interceptOriginErrors`（默认 `false`）。可选 `expectedUpdatedAt`。整体替换 |
| `PUT /sites/{id}/maintenance` | `enabled`、`template`（默认 `""`）、`retryAfterSeconds`（默认 0）、`allowedCidrs`、`allowedPathPrefixes`（默认 `[]`）、可选 `expectedUpdatedAt` |
| `PUT /settings/error-pages` | `unknownHost`、`siteDisabled`（默认 `""`） |

响应中的 `updatedAt` 在从未保存时为 `null`。只读 AccessKey 只能调用 `GET`；服务账号不能调用这些过程（403 `SERVICE_ACCOUNT_FORBIDDEN`）。字段的完整说明见 [API 参考](../reference/api.md)。

## 故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 仍是纯文本错误 | 节点版本过旧；节点自己返回的状态码没有页面（404、421、508） | 升级节点，见[节点升级](node-upgrades.md) |
| 错误页底部显示 openresty | 节点版本过旧，返回的是 nginx 自带的错误页 | 升级节点 |
| 源站的错误页没有被替换 | 没有打开「替换源站错误响应」，或该状态码与其类都没有页面 | 打开开关并填写对应状态码或「其他 4xx」「其他 5xx」的页面 |
| 跳转 URL 下方提示「检查「跳转到 URL」」 | URL 不是 `http(s)` URL 或以单个 `/` 开头的路径、含空格或其他占位符、占位符在主机中、超过 2048 字符 | 修正 URL，只用 `{{status}}`、`{{request_id}}` |
| 「须为 200 到 599 之间的整数」 | 「响应状态码」超出范围或不是整数 | 填写 200–599，或留空 |
| 保存提示「{status} 错误页超过 65536 字节」（`ERROR_PAGE_TOO_LARGE`，400） | 模板按 UTF-8 计算超过 64 KiB | 精简模板，把大图片放到外部地址 |
| 保存提示「内容已被修改，请刷新后重试」（`UPDATED_AT_MISMATCH`，409） | 读取之后错误页或维护模式被其他会话修改 | 刷新页面后重新修改 |
| 「输入有误」（`BAD_REQUEST`，400） | API 请求的字段不合法：模板与跳转 URL 同时填写或都为空、同一状态码出现两次、跳转页面带 `responseStatus`、放行地址不是 IP 或 CIDR | 按[接口](#接口)修正请求 |
| 「集群中有节点不支持」，不能编辑或开启 | 集群有活动节点缺少 `error-pages-v1`、`site-content-v1` 或 `rules-v3` | 升级节点，见[节点要求](#节点要求) |
| 所有访客都看到维护页 | 维护模式已启用，访客的地址与路径不在放行范围内 | 关闭维护模式，或补充放行地址、路径前缀 |
| 维护模式自己开启了 | 用量保护的动作为「开启维护模式」且达到上限 | 见[用量保护](usage-protection.md) |
| 放行地址仍得到维护页 | 节点前有代理而集群的访客 IP 为直连时，访客地址是代理的地址 | 把集群的[访客 IP](../deploy/nodes.md#访客-ip) 设为 PROXY protocol 或可信代理报头；或放行代理的地址段 |
| 停用的网站返回 404 | 节点版本过旧，不认识离线 Host | 升级节点 |
| 日志里找不到页面上的请求 ID | 访问日志未启用或该请求没有被采样 | 在「日志」页签提高采样率，或打开「始终记录被拦截、挑战与鉴权失败的请求」 |
