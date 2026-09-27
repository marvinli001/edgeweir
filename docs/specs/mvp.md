# MVP 规格

来源：[BOOTSTRAP.md](../../BOOTSTRAP.md) §2、§4，[ROADMAP.md](../../ROADMAP.md) 的 MVP 部分，[PROGRESS.md](../../PROGRESS.md) 的已知限制，2026-09-25 确定的界面规范（[ADR-0003](../adr/0003-ui-shadcn-preset.md) 决策 7–9、[ADR-0007](../adr/0007-auth-better-auth-multitenancy.md) 更新记录），对标调研（[docs/research/benchmark.md](../research/benchmark.md)），以及 2026-09-25 的收尾审计（[docs/audits/2026-09-25-wrapup.md](../audits/2026-09-25-wrapup.md)）。标有「对标补充」的条目是 2026-09-25 对照调研补进来的，标有「收尾延后」的条目来自收尾审计第 3 节（见 0.5）。

MVP 分成 6 个里程碑，每个里程碑对应一个 `/goal` 会话（第 8 节）。按 M1 → M6 的顺序做，后一个里程碑依赖前一个的页面和数据模型。每个会话结束时更新 PROGRESS.md 和 ROADMAP.md 的勾选。M1、M2 已于 2026-09-25 完成；M3 于 2026-09-27 完成核心实现与本地验收（PROGRESS「MVP M3」）。M4 于 2026-09-27 完成本地验收；M5 与 M6 已完成核心实现和本地专项验收，包含 ClickHouse、签名升级和恢复；最终审查与整套 CI 记录以 PROGRESS 和 implementation/mvp-completion.md 为准。

## 0. 所有里程碑都要遵守

### 0.1 界面

- **文案**：面向用户，简短明确。页面不加副标题；对话框、卡片、表单不加说明段落；字段提示优先用 placeholder；空状态只有标题和操作按钮。只保留与安全相关的一句话（例如"仅显示一次"）。原理和注意事项写进 `docs/`，不写进界面。
- **营销页例外**：公开落地页（`/`，见 0.2）面向访客，可以有营销文案（标语、说明段落、FAQ），但文案仍全部走 i18n（zh-CN、en）。落地页只用浅色：挂载时根节点固定为浅色，离开后恢复用户选择的主题，首屏（`public/theme-init.js`）也不加 `.dark`。模板用中性名称（Horizon、Orbit），界面、文案和代码注释里不出现其他厂商的名称，也不写"仿照某站"。字体和图片只从本站加载（自托管，不引用第三方 URL）。控制台和后台没有这条例外。
- **加载**：不用骨架屏。路由、请求、提交由顶部进度条（`TopProgress`）表示；首次加载用 `LoadingState`（居中 appica Loader）；刷新保留旧数据；提交按钮内显示 `Spinner` 并禁用，直到整个动作完成（包括随后的跳转）。轮询查询加 `meta: { background: true }`。
- **视觉与动效**：新页面沿用现有做法：卡片分层阴影；列表和卡片用 `animate-enter` 依次入场；遵循 `prefers-reduced-motion`。数据展示参考 Cloudflare 仪表盘，统一用 `src/web/components/analytics/` 的扁平面板：`AnalyticsSection`（时间范围、带数值轴的大图、通到卡片边缘的小图、状态码分布、Top 列表）、`MetricCard`（数值动画 + 与上一时段相比的涨跌）；概览页的资源列表用 `ResourceList`；状态用 `StatusDot`（状态点 + 文字）。指标卡片点开是详情浮窗（`MetricDetailDialog`：按维度拆分的时间图 + 排行列表）。图表只用 `index.css` 里校验过的颜色 token（`--metric`、`--series-*`、`--status-2xx`…`--status-5xx`、`--delta-*`、`--state-*`）。
- **组件**：shadcn 已有的用 shadcn；shadcn 没有的（颜色选择、评分、倒计时、仪表、迷你图、数字输入、OTP 输入、时间与日期输入、轮播等）用 appica-ui，只能经 `src/web/components/appica/` 封装后使用，新组件要在 `appica-bridge.css` 加对应的 `@source` 和 token 映射。
- **状态**：每个页面都有加载态、空状态和错误态；深浅色都要检查（落地页只有浅色）；375px 宽度下可用。
- **i18n**：所有字符串走 Paraglide（zh-CN、en）。服务端返回的错误和配置版本原因也要能本地化（见 0.4）。

### 0.2 控制台与后台

所有用户（包括平台管理员）的主视图是控制台，首页是 `/overview`；平台管理员拥有控制台的全部功能，另外通过顶栏的 [控制台 | 后台] 切换进入 `/admin/*`。后台只放系统级配置。

`/` 是可选的公开落地页：平台管理员在后台系统设置里选模板（`landing` 过程），关闭（默认）时 `/` 直接跳到 `/overview`（未登录再去 `/login`）。落地页不属于控制台，不放管理功能，文案规则见 0.1「营销页例外」。

功能按下表归属（「已有」是当前代码里的页面，新功能放进「计划」对应的一侧）：

| | 控制台（`/overview` 等） | 后台（`/admin/*`） |
| --- | --- | --- |
| 已有 | 概览 `/overview`；网站 `/sites`（详情页 Tab：概览、统计、域名、源站、缓存）；刷新预热 `/purge`；组织成员 `/members`（组织 owner / admin 可见）；账户安全 `/security`；设置 `/settings`（偏好、AccessKey 的创建和删除） | 平台概览 `/admin`；集群与节点 `/admin/clusters`（节点组、节点、安装命令、配置版本与回滚）；区域 `/admin/regions`；组织与用户 `/admin/organizations`；审计日志 `/admin/audit`；系统设置 `/admin/settings`（节点通道与 CA 指纹、setup token、源站地址允许清单、落地页模板） |
| 计划 | 网站详情页的 HTTPS、规则、日志 Tab；证书；IP 名单；告警订阅；AccessKey 的吊销、最后使用时间和只读范围 | 平台 DNS（服务商、CNAME 域、线路）、平台级 IP 名单、告警渠道、节点版本与升级、系统设置里的 SMTP 和 GeoIP 数据 |

后台过程在服务端一律用 `admin` 守卫；控制台过程按组织隔离（ADR-0007），平台管理员在控制台里看到的是全部组织的数据。

### 0.3 工程约束

- API 先改 `packages/contract`，同一过程同时服务 `/rpc` 和 `/api/v1`。每个新过程都有 Vitest 用例，涉及权限的要有租户成员访问后台过程返回 403 的用例。
- 管理操作写审计日志；私钥、DNS API 密钥等敏感数据用主密钥信封加密后入库；绝不存 SSH 凭据。
- proto 改动：改 `proto/` → `pnpm proto:lint` → `pnpm proto:gen` → 打 tag `proto/v0.x.0` → edgeweir-node 重新生成并实现。保持向后兼容，旧 agent 遇到未知字段不能崩溃。
- 两个仓库都要改的里程碑，两边都要小步提交、测试齐全。
- 每个里程碑都扩展 `scripts/e2e.sh` 和 Playwright，把该里程碑的核心链路跑通；Playwright 断言页面没有 `pageerror`。
- 依赖版本和 API 以官方文档为准；和本文件冲突时以官方文档为准，更新对应 ADR 并记到 PROGRESS.md。
- 需要维护者拍板的事写进 PROGRESS.md「待决策」，选一个合理默认值继续做。

### 0.4 Phase 0 遗留项的归属

| 遗留项 | 里程碑 |
| --- | --- |
| 初始化窗口风险：增加一次性 setup token（启动时打印到容器日志，初始化时必须输入） | M1 |
| 配置版本原因是服务端生成的英文：改为存 `reason_code` + 参数，界面按 i18n 渲染 | M1 |
| 服务端错误信息是英文：对外返回稳定的错误码，界面按错误码本地化，未知错误码回退到服务端文本 | M1 |
| 审计日志只显示 ID：显示操作者名称和对象名称，支持按操作、对象、时间筛选 | M1 |
| 负载均衡 round_robin / consistent_hash 暂按加权随机，没有被动健康检查 | M2 |
| 清缓存只支持全站 | M2 |
| 回源 HTTPS 不校验证书 | M2 |
| proto 没有下发证书材料的接口，节点不开 HTTPS 监听 | M3 |
| 节点仓库 CI 的 proto 一致性检查依赖公开的 GitHub 仓库 | 仓库公开时处理，MVP 期间保持本地 `make proto-check` |

### 0.5 收尾审计延后项的归属

2026-09-25 收尾审计第 3 节列出的问题不在收尾时修，按下表归到对应的里程碑，写在该里程碑的章节里并进入它的「验收」。

| 编号 | 问题 | 归属 |
| --- | --- | --- |
| D1 | 没有最低 agent 版本门槛：旧节点遇到新的枚举值会退回宽松默认（监听协议变 HTTP、源站协议变 http、缓存头变覆盖），只保证不崩溃，不保证行为正确 | M3（第 3 节「兼容性」） |
| D2 | `ReportStats` 重试会重复计数；`node_minute_stats` 没有保留期和小时 / 天汇总 | M5（第 5 节「统计」） |
| D3 | 控制台从备份恢复后，节点把恢复后的 revision 当成"更旧"而忽略，停在 last-known-good | M6（第 6 节「备份与恢复」） |
| D4 | 预热只预热桌面变体；前缀与全站预热 | v1（ROADMAP v1「缓存与调度」，节点 ROADMAP 同） |
| D5 | 容器镜像与 GitHub Actions 没有按 digest / commit SHA 固定 | 首次正式发布前（ROADMAP「首次发布前」，[ADR-0017](../adr/0017-release-supply-chain.md) 收尾记录） |
| D6 | 节点仓库 CI 的 proto 一致性检查依赖公开的控制面仓库 | 仓库公开时（同 0.4 最后一行） |

## 1. M1 集群、租户与站点基础

**后台**

- 集群：创建、改名、删除（有节点或网站时拒绝）。
- 节点组：属于集群，可设置区域标签；节点可在组之间移动。
- 区域：平台级的区域字典（名称、代码），供节点组和以后的调度使用。
- 节点：改名、停用、启用、删除（删除时吊销证书，节点再连接会被拒绝）。
- 组织与用户：创建组织；创建用户或发送邀请；设置或取消平台管理员；禁用用户；把用户加入组织并指定角色。组织可设置默认集群，租户新建的网站落在默认集群。
- 审计日志：显示操作者名称和对象名称；按操作、对象类型、时间范围筛选；分页。
- setup token：见 0.4。

**控制台**

- 组织切换：用户属于多个组织时，在侧边栏顶部切换当前组织；只属于一个组织时不显示。
- 组织成员（组织 owner / admin 可见）：邀请、改角色、移除。
- 账户安全：修改密码、TOTP 两步验证、passkey。组织可以要求成员启用两步验证。
- 网站详情页 `/sites/$id`：Tab 结构（概览、域名、源站、缓存），后续里程碑往里加 Tab。可编辑名称、域名（含泛域名）、源站、缓存规则；每次保存生成新的配置版本并在界面上提示版本号。
- 网站列表：搜索、按集群筛选（平台管理员）、分页。

**验收**：Playwright 覆盖：带 setup token 初始化 → 创建第二个组织和成员 → 成员登录后只看到控制台、看不到后台切换，直接访问 `/admin` 被重定向 → 成员新建并编辑网站（改域名、改源站） → 管理员在后台创建集群和节点组，把 e2e 节点移入节点组，节点仍在线且配置版本一致 → 审计日志显示操作者名称并能按操作筛选 → 切换英文后版本原因和错误提示是英文。

## 2. M2 源站与缓存

**节点与 proto**

- 源站池：权重、备用源站（主源全部不可用时启用）、被动健康检查（失败次数 + 恢复时间）、round_robin 与 consistent_hash 真正实现、回源 Host 和 SNI、回源 HTTPS 证书校验开关（默认校验）。
- 对象存储源站：S3 兼容的 SigV4 签名回源（密钥信封加密后入库，通过 mTLS 下发）。
- 缓存规则：按后缀、路径、前缀、状态码、响应大小匹配；自定义缓存键（查询参数全部 / 忽略 / 白名单、参数排序、指定请求头、指定 Cookie、按设备类型区分移动与桌面、是否包含 Host）；遵循或覆盖源站缓存头；stale-while-revalidate、stale-if-error；Range 请求走 slice。
- 回源连接（对标补充）：回源 keep-alive 连接池、连接 / 读取 / 发送超时可配置；WebSocket 透传（按站点开关，默认开）。
- 刷新和预热：URL、前缀、全站刷新；URL 预热。通过类型化的节点任务下发（参考 GoEdge 的类型化任务），节点回报执行结果。proto 升级到 v0.2.0。

**控制台**

- 网站详情页：源站 Tab（源站池编辑、健康状态）、缓存 Tab（规则列表可拖动排序）。
- 刷新预热页面：提交 URL / 前缀 / 预热任务，显示每个任务在各节点的执行进度和结果。

**验收**：e2e 证明：URL 刷新后下一次请求是 `MISS`；前缀刷新只影响该前缀；主源停掉后请求落到备用源，恢复后回到主源；带 `Range` 的请求命中 slice 缓存；忽略查询参数的缓存键让 `?a=1` 与 `?a=2` 命中同一缓存，参数排序让 `?a=1&b=2` 与 `?b=2&a=1` 命中同一缓存；经节点的 WebSocket（whoami 的 `/echo`）能收发消息。Playwright 覆盖刷新任务提交和结果展示。

## 3. M3 HTTPS、证书与协议

**控制面**

- `edgeweir-certd`：lego 签发 ACME 证书，支持 HTTP-01（挑战文件经节点下发）和 DNS-01（libdns，DNS 凭据由组织在控制台配置，信封加密）；支持 ARI 续期；pg-boss 定时续期。
- 证书寿命变短（对标补充）：Let's Encrypt 的默认有效期将降到 64 天（2027-02）和 45 天（2028-02），6 天短期证书已可用。续期以 ARI 为准，没有 ARI 时按剩余寿命 1/3 续期，不写死天数；CA 可选 Let's Encrypt 或 ZeroSSL（EAB 凭据信封加密）。
- 上传证书：校验证书链、私钥匹配和域名覆盖，私钥信封加密。
- 证书经 mTLS 通道下发到节点（proto v0.3.0），节点以 0600 权限落盘或只放内存。

**节点**

- HTTPS 监听，按 SNI 选择证书（`ssl_certificate_by_lua`），证书热更新不 reload。
- TLS 选项（对标补充）：最低 TLS 版本（1.2 / 1.3）、OCSP stapling；密码套件用安全的固定档位（现代 / 兼容），不开放任意字符串。
- HTTP 跳转 HTTPS、HSTS、HTTP/2。
- HTTP/3、Brotli、Zstd：先核实官方 OpenResty 包是否包含对应模块；缺少的按 ADR-0015 做自定义构建，工作量过大时记入「待决策」并在界面上把该开关标为不可用。
- Gzip 按类型和最小长度配置。

**兼容性（收尾延后 D1）**

- 最低 agent 版本门槛：proto v0.3.0 加 `min_agent_version` 或 `required_features`（实现时二选一，记入 ADR-0008 / ADR-0011 更新记录）。M3 新增的枚举值和语义（HTTPS 监听、证书、TLS 选项等）只下发给满足门槛的节点：控制台按节点上报的 `NodeInfo.agent_version` 判断，不满足的节点拿不到需要新功能的 revision（继续用 last-known-good），后台节点列表显示"需要升级"。
- 节点遇到不认识的枚举值时拒绝整个配置（回报 `FAILED`，继续用 last-known-good），不再退回宽松默认；自身版本低于门槛时同样拒绝。

**控制台**

- 证书页面：列表、到期倒计时、自动续期状态、手动续期；网站详情页新增 HTTPS Tab（证书选择、强制 HTTPS、HSTS、HTTP/2、HTTP/3、压缩）。

**验收**：compose.e2e.yml 加入 Pebble（ACME 测试服务器）；e2e 证明：为 `demo.test` 签发证书后，`curl --resolve` 走 HTTPS 成功且证书由 Pebble 签发；HTTP 请求被 301 到 HTTPS；响应带 HSTS；ALPN 协商为 h2；证书续期后节点无需 reload 就生效；上报的 agent 版本低于门槛的节点拿不到需要 HTTPS 的 revision，后台显示需要升级；节点收到含未知枚举值的配置时回报失败并继续按 last-known-good 服务（D1）。Playwright 覆盖申请证书和开启强制 HTTPS。

## 4. M4 访问控制与规则引擎

- 表达式语言（ADR-0012，wirefilter 风格）：TS 端解析、类型检查、编译成 IR；节点端编译成 Lua。执行阶段：request-transform → redirect → config → waf-custom → ratelimit → cache → origin → response-transform。
- 规则类型：IP、CIDR 黑白名单（组织级 IP 名单可在多条规则里引用 `$name`；另有后台管理的平台级 IP 名单，对所有站点生效，对标补充）；自定义 WAF 规则（waf-custom 阶段：表达式 + 动作 拦截 / 记录 / 放行，对标补充）；配置规则（config 阶段：按表达式覆盖站点设置，例如某路径不缓存、强制 HTTPS、关闭压缩，对标补充）；国家、省份、ASN（GeoIP 数据源的选择与许可证记入「待决策」，默认用许可证允许再分发的数据源）；限速（按 IP 或按键、窗口、动作 429 或拦截）；重定向；URL 改写；请求头和响应头增删改。
- 名单和规则经 unix socket 热更新，不 reload。
- 控制台：网站详情页新增「规则」Tab，规则按阶段分组、可拖动排序；表达式编辑器有语法高亮和逐字符的错误提示；IP 名单页面。

**验收**：e2e 证明：名单中的 IP 返回 403；平台级名单对所有站点生效；自定义 WAF 规则按表达式拦截并在"记录"模式下只记日志；配置规则让指定路径不缓存；超过限速返回 429；重定向规则返回 301 和正确的 Location；响应头规则生效；更新名单后不 reload 即生效。表达式的解析、类型检查和编译有表驱动测试，TS 与 Lua 共用一组测试向量。

## 5. M5 DNS、统计、告警与开放 API

- 域名所有权校验（对标补充）：租户添加的顶级域先通过 TXT 记录校验再发布到节点，防止抢注和泛域名劫持；平台管理员可免校验。
- 发布分两路（对标补充，参考 ATC）：DNS 记录变更与节点配置 revision 分开发布，DNS 侧也有版本和回滚。
- 平台 DNS（后台）：接入 DNSPod、阿里云、华为云、Cloudflare（经 certd / libdns）；配置 CNAME 域和线路（节点组 → 线路）；每个网站自动生成 CNAME 目标并写入记录；节点健康检查失败时自动摘除记录、恢复后加回；定时的 DNS 记录修复任务；节点健康检查失败自动下线。
- 统计：分钟级请求数、流量、带宽、命中率、状态码分布、Top URL、Top IP（节点预聚合，Top-K 用近似算法）；lite 模式存 Postgres，ClickHouse 可选。控制台有网站级统计页，后台有平台级统计。请求数、流量、带宽、命中率、状态码和图表已在「数据展示重做」时完成（PROGRESS），本里程碑补 Top URL、Top IP 和下面两项。
- 统计的幂等与保留（收尾延后 D2）：节点给每批 `ReportStats` 带单调递增的批次序号（proto 新字段），控制台按（节点、序号）去重，重试不重复计数；pg-boss 定时任务生成小时 / 天汇总表并按保留期清理分钟明细（ADR-0009 决策 3），长时间范围的查询读汇总表。
- 告警：渠道（邮件、Webhook、钉钉、企业微信、Telegram）在后台配置；规则（节点离线、证书将到期、源站不可用、5xx 比例超阈值）；租户在控制台订阅自己网站的告警。
- 开放 API：所有控制台过程都出现在 `/api/v1` 的 OpenAPI 文档里；后台系统设置页显示 API 文档入口。

**验收**：e2e 使用一个模拟 DNS 服务商（本地假服务器）证明：未通过 TXT 校验的租户域名不下发到节点，校验通过后下发；创建网站后写入 CNAME 记录；停掉节点后记录被摘除、恢复后加回；Webhook 渠道收到节点离线告警；统计页显示请求数、命中率和状态码分布；同一批统计重复上报不改变计数，汇总任务运行后长时间范围的数值与分钟明细一致，超过保留期的分钟明细被清理（D2）。Playwright 覆盖 DNS 服务商配置、统计页和告警订阅。

## 6. M6 节点运维与基线

BOOTSTRAP §2 把节点自升级和访问日志采样上报定为节点职责，PROGRESS 的已知限制把它们归到 MVP，这里补齐；另加对标调研指出的开放 API 管理和性能、恢复基线。

**节点与 proto**

- 自升级：控制台下发类型化的升级任务（目标版本、下载地址、cosign 签名与校验和）；节点先验签和校验再原子替换并重启，失败自动回滚到上一版本并回报。按节点组灰度（先一组，确认健康后再全量）。proto 升级到 v0.4.0（或在 M2 的任务通道上扩展，按实际版本号递增）。
- 访问日志采样上报：节点按站点采样率上报访问日志（时间、客户端 IP、方法、Host、路径、状态码、字节、耗时、缓存状态），lite 模式存 Postgres 并按天分区、保留 7 天；ClickHouse 模式写原始日志表。

**控制台**

- 后台：节点版本一览、发起升级（选版本和节点组）、升级进度与结果。
- 网站详情页新增「日志」Tab：按时间、状态码、IP、路径过滤，导出 CSV。
- AccessKey 管理：列表显示最后使用时间，可吊销；创建时选只读或读写（只读 key 调用写过程返回 403）。
- 性能基线：`scripts/bench.sh` 用 oha（或 k6）对 e2e 节点测缓存命中的 QPS、p50/p99 延迟和节点内存，结果写入 PROGRESS；CI 不设硬门槛，只记录，回退超过 20% 在 PROGRESS 标出。
- 备份与恢复：`docs/deploy/backup.md`（pg_dump + 主密钥分开保存），e2e 演练一次"备份 → 新库恢复 → 节点照常在线"。
- 恢复后配置能继续下发（收尾延后 D3）：备份里的最大 revision 可能低于节点已应用的 revision，节点会把恢复后发布的 revision 当成"更旧"而忽略。二选一实现并记入 ADR-0011 更新记录：`NodeConfig` 增加配置 epoch（恢复时换新的 epoch，节点在 epoch 变化时接受较小的 revision），或恢复后控制台把每个集群的 revision 序号跳过节点上报的最大 `applied_revision`。

**验收**：e2e 证明：节点从 A 版本升级到 B 版本且签名错误的包被拒绝、失败时回滚；访问日志在日志 Tab 可查并能按状态码过滤；只读 AccessKey 调用写接口返回 403，吊销后 401；`scripts/bench.sh` 输出基线；备份恢复演练后节点在线、配置版本一致，且恢复前节点已应用的 revision 高于备份时，恢复后发布的新配置仍被节点应用（D3）。Playwright 覆盖发起升级、日志查询和 AccessKey 吊销。

## 7. 暂不做

v1 及以后的开源核心内容（WAF 托管规则、CC 防护、Tiered Cache、日志推送、四层转发、金丝雀发布等，见 ROADMAP）不在 MVP 范围。遇到需要为这些核心能力预留的数据结构，只预留字段，不实现功能。客户门户、套餐计费、财务与分销按 [ADR-0019](../adr/0019-open-core-and-commercial-products.md) 归入独立商业运营产品，不在核心预建商业账本或许可证字段；现有组织、成员与隔离继续属于 MVP。

## 8. `/goal` 提示词

用法与 Phase 0 相同：在 `~/Developer/edgeweir/` 开一个 Claude Code 会话，切到自动模式，粘贴对应里程碑的一段。评估模型只看对话记录，所以每条验收都要求贴出命令输出。

### M1

```text
/goal 按 docs/specs/mvp.md 完成 MVP 里程碑 M1（集群、租户与站点基础）。先读 docs/specs/mvp.md 第 0 节和第 1 节、CLAUDE.md、PROGRESS.md、docs/adr/0003 与 0007；mvp.md 是唯一需求来源。在 PROGRESS.md 新增「MVP M1」一节逐项勾选。以下全部满足才算完成，最后一轮把每条的验证命令和输出原样贴出来：
1. mvp.md 第 1 节的每个功能和 0.4 节归到 M1 的遗留项都已实现，ROADMAP.md 对应条目已勾选；edgeweir 与 edgeweir-node 的 git status 都干净，提交按 Conventional Commits 小步进行。
2. edgeweir：pnpm install 后 pnpm lint、pnpm typecheck、pnpm test、pnpm build 全部 exit 0；每个新过程都有 Vitest 用例，其中包含租户成员调用后台过程返回 403；apps/console/test/web 下的 i18n 与 ui-rules 测试通过。
3. 如果改了 proto 或节点：buf lint proto 通过，edgeweir-node 的 go vet ./...、go test ./...、make proto-check 全部 exit 0。
4. docker compose -f compose.e2e.yml up -d --build 后 bash scripts/e2e.sh 输出 E2E OK，其中 Playwright 覆盖 mvp.md 第 1 节「验收」列出的整条链路，且断言没有 pageerror。
5. 新页面符合 mvp.md 0.1 节：没有副标题和说明段落，没有骨架屏，appica 只经 src/web/components/appica 使用；功能归属符合 0.2 节的表。
约束：不 push，不创建远端仓库，不发布镜像或包；不允许跳过、删除或弱化测试；依赖版本和 API 以官方文档为准，和 mvp.md 冲突时更新对应 ADR 并记到 PROGRESS.md；需要我决定的事写进 PROGRESS.md「待决策」，选一个合理默认值继续，不要停下来等我。
或者 100 轮后停止，汇报未完成项。
```

### M2 – M6

把 M1 提示词里的以下部分替换后使用，其余不变：

| 里程碑 | 名称 | 第 1 条中的章节 | 第 3 条 |
| --- | --- | --- | --- |
| M2 | 源站与缓存 | 第 2 节 + 0.4 节归到 M2 的遗留项 | 必须满足（proto v0.2.0 已打 tag，节点仓库已重新生成） |
| M3 | HTTPS、证书与协议 | 第 3 节 + 0.4 节归到 M3 的遗留项 + 0.5 节的 D1 | 必须满足（proto v0.3.0），另加 helpers/certd 的 go vet、go test exit 0 |
| M4 | 访问控制与规则引擎 | 第 4 节 | 必须满足，另加 TS 与 Lua 共用测试向量的测试输出 |
| M5 | DNS、统计、告警与开放 API | 第 5 节 + 0.5 节的 D2 | 必须满足，另加 helpers/certd 的 go vet、go test exit 0 |
| M6 | 节点运维与基线 | 第 6 节 + 0.5 节的 D3 | 必须满足（proto 新 tag，节点仓库已重新生成），另加 `bash scripts/bench.sh` 的输出 |

同时把"先读 docs/specs/mvp.md 第 0 节和第 1 节"和"第 1 节「验收」"中的节号改成对应里程碑的节号，把「MVP M1」改成对应名称。
