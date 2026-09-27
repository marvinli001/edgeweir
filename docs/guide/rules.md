# 规则、IP 名单与 GeoIP

M4 规则使用有类型的表达式。控制面先解析、检查字段和动作，再发布 AST；节点验证整个配置并把 AST 编译成闭包，不执行租户提供的 Lua 文本。需要 `rules-v1` 能力；缺少能力的节点继续使用 last-known-good，后台显示需要升级。

租户保存或后台自动发布新增能力时，会检查集群内所有活动节点的能力清单（包含暂时离线的活动节点）。缺少能力则拒绝本次变更，原规则与版本保持不变，避免影响同集群其他网站。平台管理员可以明确发布需要升级的配置；相关节点仍保留 LKG，直到升级或配置所需数据库。

限速计数按站点分配固定 256 KiB 共享内存，最多 512 个已发布站点，每节点计数分区合计最多 128 MiB；WAF 记录去重另用 1 MiB。站点不能借用其他站点的分区；本分区无法创建计数时，该站点的限速请求返回 503。新增或移除站点需要重载，但既有分区的名称与大小不变；同一批站点的规则和名单修改仍热更新。节点重启或移除后重新加入某站点会清空对应计数。

## 执行顺序与动作

| 阶段 | 动作 |
| --- | --- |
| request-transform | 改写路径；设置或移除请求头 |
| redirect | 301、302、307、308，目标为站内绝对路径或 HTTP(S) URL |
| config | 覆盖绕过缓存、强制 HTTPS；关闭压缩 |
| waf-custom | 403 / 451 拦截；记录；放行 |
| ratelimit | 按 IP、Host 或请求头键的固定窗口计数，超额返回 429 或 403（按动作选择） |
| cache | 覆盖缓存设置 |
| origin | 设置或移除发往源站的请求头 |
| response-transform | 根据状态码和响应头设置或移除响应头 |

平台 IP 黑白名单先执行，同一地址同时在两种名单中时白名单优先。随后每个阶段先执行平台规则、再执行网站规则。拦截和重定向结束请求；放行只跳过同一作用域剩余 WAF 规则，不跳过另一作用域或限速。其余匹配动作依次叠加，后面的覆盖前面的设置。平台 WAF 拦截无法被站点放行规则绕过。拖动只改变同一阶段的顺序。

限速是**单节点固定窗口**，不宣称全网共享配额。计数器在 Nginx reload 时保留，在节点重启后重置；共享内存不足时返回 503，不放宽限速。记录模式不改变响应，每条规则每个节点 worker 集合每分钟最多输出一条包含站点 ID、规则 ID 的日志，不输出请求头、URL 或客户 IP。

改写影响回源路径；缓存键和刷新标记仍按改写前的标准化路径构造。响应变换同时作用于缓存命中与回源响应。关闭 Gzip 会移除发往源站的 Accept-Encoding 并绕过缓存，避免取出此前缓存的压缩响应。规则不能开启未构建的压缩模块。强制 HTTPS 要求站点已有可用证书，否则请求返回 503。

## 表达式

```text
ip.src in $blocked
http.request.uri.path matches "^/(admin|private)/" and not ssl eq true
http.request.method in {"POST" "PUT"}
http.request.headers["x-region"] eq "nz"
ip.geoip.country eq "NZ" and ip.geoip.asnum in {64512 64513}
http.response.code ge 500
```

| 字段 | 类型 |
| --- | --- |
| `http.host`、`http.request.method` | 字符串 |
| `http.request.uri.path`、`.query`、`http.request.uri` | 字符串；path 为 Nginx 标准化路径，query 不含问号 |
| `http.request.headers["name"]` | 字符串；名称不区分大小写，多值用逗号和空格连接 |
| `http.response.code` | 整数，仅 response-transform 可用 |
| `http.response.headers["name"]` | 字符串，仅 response-transform 可用 |
| `ip.src` | TCP 客户端地址；启用 PROXY 协议时为受信负载均衡提供的地址 |
| `ssl` | 布尔值 |
| `ip.geoip.country` | ISO 国家代码，无记录为空字符串；需要 `geoip-country-v1` |
| `ip.geoip.subdivision` | City MMDB 中的一级行政区代码，无代码时使用其英文名称；只在 City MMDB 与国家结果一致时有值；需要 `geoip-city-v1` |
| `ip.geoip.asnum` | ASN 整数，无记录为 0；需要 `geoip-asn-v1` |

支持 `eq`、`ne`、整数的 `lt/le/gt/ge`、字符串 `contains/matches`、集合或命名名单的 `in`、`not/and/or` 及括号；优先级为 not → and → or。IP 的 eq/ne 使用地址或 CIDR 包含关系。IPv4-mapped IPv6 与对应 IPv4 一致；NAT64 是独立 IPv6 地址。CIDR 保存前会清除主机位，拒绝八进制简写、zone ID 和歧义地址。

组织名单只能被该组织网站引用；同名组织名单覆盖同名平台集合。创建时名字绑定到 ID，修改条目热更新；被规则引用的名单不能删除。回滚站点配置沿用**当前**名单和平台规则，已删除的引用会阻止回滚。

表达式最多 4096 字符、512 token、16 层语法嵌套、128 个基本条件，集合最多 256 项；一个站点最多 64 条规则，平台最多 32 条。每个组织和平台分别最多 128 份名单、合计 50000 条记录，每份最多 10000 条。正则限 256 个 ASCII 字符，不支持反向引用、环视、Unicode 类、带量词的分组。PCRE 有独立的匹配/递归预算，执行错误返回 503。支持范围是 wirefilter 风格子集，不是 wirefilter 的完整实现。

Host、Authorization、Cookie、Set-Cookie、消息边界/连接头、CDN-Loop 和 X-Edgeweir-* 属于受保护头，不能通过规则修改。普通自定义头的静态值进入配置版本，**不要填入 API 密钥或其他秘密**。

## 本地 GeoIP 数据

国家和 ASN 默认来自 [IPinfo Lite](https://ipinfo.io/lite)。节点发布镜像在**构建时**用 IPinfo token 下载 `ipinfo_lite.mmdb`，按 IPinfo 公布的 sha256 校验后放在 `/usr/share/edgeweir-node/geoip/`，同目录 `NOTICE` 记录下载时间和 sha256。许可证为 CC BY-SA 4.0，IPinfo 每日更新数据；镜像里的是构建当天的快照。引用数据的页面应保留署名 IP address data is powered by [IPinfo](https://ipinfo.io)，后台 GeoIP 卡片已带有该链接。节点运行时只读本地文件，不向 IPinfo 或其他数据商发送访客地址，也不自动下载更新；token 只用于构建，不进入镜像。

| 能力 | 数据来源 | 回答的字段 |
| --- | --- | --- |
| `geoip-country-v1` | IPinfo Lite 或 City MMDB | `ip.geoip.country` |
| `geoip-city-v1` | City MMDB | `ip.geoip.subdivision` |
| `geoip-asn-v1` | IPinfo Lite 或 ASN MMDB | `ip.geoip.asnum` |

国家和 ASN 优先取 IPinfo，IPinfo 没有记录时回落到运维提供的 City / ASN MMDB；一级行政区只来自 City MMDB，且 City MMDB 的国家与最终国家一致时才采用。IPinfo Lite 不含省份，需要按省份匹配时另行提供 City MMDB（例如 [DB-IP Lite](https://db-ip.com/db/lite.php) City，CC BY 4.0，按月更新，使用时保留 [IP Geolocation by DB-IP](https://db-ip.com) 署名）。

1. 容器节点：使用发布镜像即可获得 IPinfo Lite；需要新数据时拉取新镜像，或挂载自己的副本并设置 `EDGEWEIR_GEOIP_IPINFO=/path/ipinfo_lite.mmdb`。自行构建镜像时执行 `IPINFO_TOKEN=... make docker`（节点仓库），token 以 BuildKit secret 传入；不提供 token 时镜像不含数据。
2. 安装包 / 压缩包节点不内置数据：从 IPinfo 下载 `ipinfo_lite.mmdb`（免费账号），放在节点可读的只读目录，并在 `/etc/default/edgeweir-node` 设置 `EDGEWEIR_GEOIP_IPINFO`。
3. 需要省份时另设 `EDGEWEIR_GEOIP_CITY=/path/city.mmdb`；也可设置 `EDGEWEIR_GEOIP_ASN`。对应命令行为 `--geoip-ipinfo`（默认 `auto`：镜像内置时使用，`off` 关闭）、`--geoip-city`、`--geoip-asn`。容器需挂载相应目录。
4. 重启节点以装入新数据库。后台系统设置显示各节点的国家、省份和 ASN 能力；未配置的数据类型不会上报能力，对应规则不会下发给该节点。
5. 更新时先在一个节点替换数据库并重启、验证，再更新其余节点。不要原地改写正在使用的 MMDB。

`geoip-country-v1` 由新版节点上报。旧节点即使配置了 City MMDB 也只上报 `geoip-city-v1`，按国家匹配的规则需要先升级这些节点；升级顺序为先节点、后控制台。

Go agent 使用 [maxminddb-golang v2.6.0](https://github.com/oschwald/maxminddb-golang) 校验、读取本地文件（按数据库类型拒绝放错位置的文件），仅通过权限为 0600 的 Unix socket 向同机 Lua worker 提供结果。每个 worker 缓存最多 10000 个结果、有效期五分钟；服务不可用时依赖 GeoIP 的请求返回 503。Compose 验收使用自行生成的合成 MMDB：测试网段在 City / ASN 中为 NZ/AUK/64512，在 IPinfo Lite 结构中为 NZ/64513，用于证明国家和 ASN 取自 IPinfo、省份取自 City，不代表真实地理信息。

## 验收

- `pnpm --filter @edgeweir/rule-engine test`：解析、类型、复杂度及共享向量。
- `make lua-test`（节点仓库）：同一份表达式向量，含 IPv4-mapped、IPv6、GeoIP 属性、响应阶段和 UTF-8 字符串。
- `node scripts/e2e-m4.mjs`：真实节点规则执行、热更新无 reload、合成 IPinfo Lite + City/ASN 数据查询。
- `pnpm --filter @edgeweir/console exec playwright test e2e/m4.spec.ts`：名单、错误字符定位、规则顺序、375px 深色和 pageerror。
