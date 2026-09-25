# MVP 规格

来源：[BOOTSTRAP.md](../../BOOTSTRAP.md) §4、[ROADMAP.md](../../ROADMAP.md) 的 MVP 部分、[PROGRESS.md](../../PROGRESS.md) 的已知限制，以及 2026-09-25 确定的界面规范（[ADR-0003](../adr/0003-ui-shadcn-preset.md) 决策 7–9、[ADR-0007](../adr/0007-auth-better-auth-multitenancy.md) 更新记录）。

MVP 分成 5 个里程碑，每个里程碑对应一个 `/goal` 会话（第 7 节）。按 M1 → M5 的顺序做，后一个里程碑依赖前一个的页面和数据模型。每个会话结束时更新 PROGRESS.md 和 ROADMAP.md 的勾选。

## 0. 所有里程碑都要遵守

### 0.1 界面

- **文案**：面向用户，简短明确。页面不加副标题；对话框、卡片、表单不加说明段落；字段提示优先用 placeholder；空状态只有标题和操作按钮。只保留与安全相关的一句话（例如"仅显示一次"）。原理和注意事项写进 `docs/`，不写进界面。
- **加载**：不用骨架屏。路由、请求、提交由顶部进度条（`TopProgress`）表示；首次加载用 `LoadingState`（居中 appica Loader）；刷新保留旧数据；提交按钮内显示 `Spinner` 并禁用，直到整个动作完成（包括随后的跳转）。轮询查询加 `meta: { background: true }`。
- **视觉与动效**：新页面沿用现有做法：卡片分层阴影；统计卡片用 `SectionCards`（Sparkline、Meter、数值动画）；状态用 BorderBeam 表达（颜色随状态变化）；列表和卡片用 `animate-enter` 依次入场；遵循 `prefers-reduced-motion`。
- **组件**：shadcn 已有的用 shadcn；shadcn 没有的（颜色选择、评分、倒计时、仪表、迷你图、数字输入、OTP 输入、时间与日期输入、轮播等）用 appica-ui，只能经 `src/web/components/appica/` 封装后使用，新组件要在 `appica-bridge.css` 加对应的 `@source` 和 token 映射。
- **状态**：每个页面都有加载态、空状态和错误态；深浅色都要检查；375px 宽度下可用。
- **i18n**：所有字符串走 Paraglide（zh-CN、en）。服务端返回的错误和配置版本原因也要能本地化（见 0.4）。

### 0.2 控制台与后台

所有用户（包括平台管理员）的主视图是控制台；平台管理员拥有控制台的全部功能，另外通过顶栏的 [控制台 | 后台] 切换进入 `/admin/*`。后台只放系统级配置。新功能按下表归属：

| 控制台（`/`） | 后台（`/admin`） |
| --- | --- |
| 概览、网站（详情页含域名、源站、缓存、HTTPS、规则、统计等 Tab）、证书、刷新预热、统计、IP 名单、告警订阅、AccessKey、组织成员、账户安全、偏好设置 | 平台概览、集群 / 节点组 / 区域 / 节点、配置版本、组织与用户、平台 DNS（服务商、CNAME 域、线路）、告警渠道、审计日志、系统设置（SMTP、GeoIP 数据、setup token 等） |

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
- 缓存规则：按后缀、路径、前缀、状态码、响应大小匹配；自定义缓存键（查询参数全部 / 忽略 / 白名单、指定请求头）；遵循或覆盖源站缓存头；stale-while-revalidate、stale-if-error；Range 请求走 slice。
- 刷新和预热：URL、前缀、全站刷新；URL 预热。通过类型化的节点任务下发（参考 GoEdge 的类型化任务），节点回报执行结果。proto 升级到 v0.2.0。

**控制台**

- 网站详情页：源站 Tab（源站池编辑、健康状态）、缓存 Tab（规则列表可拖动排序）。
- 刷新预热页面：提交 URL / 前缀 / 预热任务，显示每个任务在各节点的执行进度和结果。

**验收**：e2e 证明：URL 刷新后下一次请求是 `MISS`；前缀刷新只影响该前缀；主源停掉后请求落到备用源，恢复后回到主源；带 `Range` 的请求命中 slice 缓存；忽略查询参数的缓存键让 `?a=1` 与 `?a=2` 命中同一缓存。Playwright 覆盖刷新任务提交和结果展示。

## 3. M3 HTTPS、证书与协议

**控制面**

- `edgeweir-certd`：lego 签发 ACME 证书，支持 HTTP-01（挑战文件经节点下发）和 DNS-01（libdns，DNS 凭据由组织在控制台配置，信封加密）；支持 ARI 续期；pg-boss 定时续期。
- 上传证书：校验证书链、私钥匹配和域名覆盖，私钥信封加密。
- 证书经 mTLS 通道下发到节点（proto v0.3.0），节点以 0600 权限落盘或只放内存。

**节点**

- HTTPS 监听，按 SNI 选择证书（`ssl_certificate_by_lua`），证书热更新不 reload。
- HTTP 跳转 HTTPS、HSTS、HTTP/2。
- HTTP/3、Brotli、Zstd：先核实官方 OpenResty 包是否包含对应模块；缺少的按 ADR-0015 做自定义构建，工作量过大时记入「待决策」并在界面上把该开关标为不可用。
- Gzip 按类型和最小长度配置。

**控制台**

- 证书页面：列表、到期倒计时、自动续期状态、手动续期；网站详情页新增 HTTPS Tab（证书选择、强制 HTTPS、HSTS、HTTP/2、HTTP/3、压缩）。

**验收**：compose.e2e.yml 加入 Pebble（ACME 测试服务器）；e2e 证明：为 `demo.test` 签发证书后，`curl --resolve` 走 HTTPS 成功且证书由 Pebble 签发；HTTP 请求被 301 到 HTTPS；响应带 HSTS；ALPN 协商为 h2；证书续期后节点无需 reload 就生效。Playwright 覆盖申请证书和开启强制 HTTPS。

## 4. M4 访问控制与规则引擎

- 表达式语言（ADR-0012，wirefilter 风格）：TS 端解析、类型检查、编译成 IR；节点端编译成 Lua。执行阶段：request-transform → redirect → config → waf-custom → ratelimit → cache → origin → response-transform。
- 规则类型：IP、CIDR 黑白名单（组织级 IP 名单可在多条规则里引用 `$name`）；国家、省份、ASN（GeoIP 数据源的选择与许可证记入「待决策」，默认用许可证允许再分发的数据源）；限速（按 IP 或按键、窗口、动作 429 或拦截）；重定向；URL 改写；请求头和响应头增删改。
- 名单和规则经 unix socket 热更新，不 reload。
- 控制台：网站详情页新增「规则」Tab，规则按阶段分组、可拖动排序；表达式编辑器有语法高亮和逐字符的错误提示；IP 名单页面。

**验收**：e2e 证明：名单中的 IP 返回 403；超过限速返回 429；重定向规则返回 301 和正确的 Location；响应头规则生效；更新名单后不 reload 即生效。表达式的解析、类型检查和编译有表驱动测试，TS 与 Lua 共用一组测试向量。

## 5. M5 DNS、统计、告警与开放 API

- 平台 DNS（后台）：接入 DNSPod、阿里云、华为云、Cloudflare（经 certd / libdns）；配置 CNAME 域和线路（节点组 → 线路）；每个网站自动生成 CNAME 目标并写入记录；节点健康检查失败时自动摘除记录、恢复后加回；定时的 DNS 记录修复任务；节点健康检查失败自动下线。
- 统计：分钟级请求数、流量、带宽、命中率、状态码分布、Top URL、Top IP（节点预聚合，Top-K 用近似算法）；lite 模式存 Postgres，ClickHouse 可选。控制台有网站级统计页，后台有平台级统计。
- 告警：渠道（邮件、Webhook、钉钉、企业微信、Telegram）在后台配置；规则（节点离线、证书将到期、源站不可用、5xx 比例超阈值）；租户在控制台订阅自己网站的告警。
- 开放 API：所有控制台过程都出现在 `/api/v1` 的 OpenAPI 文档里；后台系统设置页显示 API 文档入口。

**验收**：e2e 使用一个模拟 DNS 服务商（本地假服务器）证明：创建网站后写入 CNAME 记录；停掉节点后记录被摘除、恢复后加回；Webhook 渠道收到节点离线告警；统计页显示请求数、命中率和状态码分布。Playwright 覆盖 DNS 服务商配置、统计页和告警订阅。

## 6. 暂不做

v1 及以后的内容（WAF 托管规则、CC 防护、Tiered Cache、日志推送、四层转发、金丝雀发布、计费等）不在 MVP 范围。遇到需要为它们预留的数据结构，只预留字段，不实现功能。

## 7. `/goal` 提示词

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

### M2 – M5

把 M1 提示词里的以下部分替换后使用，其余不变：

| 里程碑 | 名称 | 第 1 条中的章节 | 第 3 条 |
| --- | --- | --- | --- |
| M2 | 源站与缓存 | 第 2 节 + 0.4 节归到 M2 的遗留项 | 必须满足（proto v0.2.0 已打 tag，节点仓库已重新生成） |
| M3 | HTTPS、证书与协议 | 第 3 节 + 0.4 节归到 M3 的遗留项 | 必须满足（proto v0.3.0），另加 helpers/certd 的 go vet、go test exit 0 |
| M4 | 访问控制与规则引擎 | 第 4 节 | 必须满足，另加 TS 与 Lua 共用测试向量的测试输出 |
| M5 | DNS、统计、告警与开放 API | 第 5 节 | 必须满足，另加 helpers/certd 的 go vet、go test exit 0 |

同时把"先读 docs/specs/mvp.md 第 0 节和第 1 节"和"第 1 节「验收」"中的节号改成对应里程碑的节号，把「MVP M1」改成对应名称。
