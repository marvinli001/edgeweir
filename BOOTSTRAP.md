# 任务：初始化 Edgeweir —— 开源自托管 CDN / WAF / 边缘调度平台

工作区 `edgeweir/` 下有两个独立 git 仓库（不存在就创建）：
- `edgeweir/`：控制面（TypeScript，前后端不分离，单镜像部署）
- `edgeweir-node/`：边缘节点（Go agent + OpenResty，一键安装）

命名与标识（统一小写、无连字符的主名）：
- GitHub org：`edgeweir`；仓库：`edgeweir/edgeweir`、`edgeweir/edgeweir-node`
- 域名：`edgeweir.dev`（文档），`edgeweir.com`（官网）
- 镜像：`ghcr.io/edgeweir/edgeweir`、`ghcr.io/edgeweir/edgeweir-node`（Docker Hub 同名 `edgeweir/*`）
- npm 内部包 scope：`@edgeweir/*`；Go module：`github.com/edgeweir/edgeweir-node`
- 二进制：`edgeweir-node`（节点 agent）、`edgeweir-certd`（控制面 ACME/DNS helper）
- 命名寓意：weir = 堰。都江堰的飞沙堰在边缘拦沙放水：放行正常流量、筛掉攻击、调度分流，写进 README 的品牌故事。
- LICENSE：AGPL-3.0（两个仓库一致）

## 0. 定位与原则
- 对标 GoEdge / FlexCDN（自建 CDN + WAF + DNS 调度 + 多租户分销），成熟度与站点优化能力对标 Cloudflare。
- 吸收主流系统的优点，同时做到更现代、更高性能、更可靠、更可信。GoEdge 出过官方二进制投毒，所以"可验证的信任"是第一卖点。
- 能用成熟轮子就用；自研只做编排层和产品层。
- 下面的版本号是 2026-09 的调研快照。安装任何依赖前，先用 context7 或官方文档核实当前版本和 API，不要凭记忆写。

## 1. 调研结论（设计依据，不需要重新调研）
### 要吸收的
- GoEdge：功能面最全（站点、集群、节点、缓存、WAF、IP 名单、证书、DNS、用户、计费、工单、审计）。API 节点是唯一访问数据库的组件，可以水平扩展。配置同步采用"流式推送提示 + 轮询兜底"。"路由规则"可以按路径覆盖几乎所有站点设置。节点任务是类型化的（configChanged、ipItemChanged、scriptsChanged…）。
- FlexCDN：L2 回源聚合节点；组内缓存共享；智能调度规则（节点指标条件 → 动作：下线 / 切备用节点 / 切备用 IP → 持续时间 → 自动恢复）；分布式区域探针；节点租期到期自动摘除；访问日志直推自定义 sink；租户脚本需管理员审批；95 带宽计费、阶梯价、流量包。
- CDNFly v6：OpenResty + Go agent 的节点形态；分级 CC 防护（限速 → 302/cookie → JS → 验证码 → 滑块，按 QPS 和错误率自动升级，用 ipset/nftables 在内核封禁，JA4 指纹）；"线路组 + 备用线路组"决定 CNAME 解析到哪些节点；DNS 记录"修复"任务。
- LeCDN：URL 级 CC 自动防护（只对被攻击的 URL 上验证）；多级备用 IP 故障切换；四层转发重载不断连接。99CDN：组内一致性哈希分片。
- Apache Traffic Control（已退役，只取思想）：Topologies（可复用的缓存层级拓扑图）；两阶段发布（路由快照与节点配置分开）；节点端 pull → diff → 备份 → 区分 reload 和 restart。
- Cloudflare：把规则拆成 Cache / Configuration / Redirect / Origin / Transform / Compression Rules，共用一门表达式语言（参考 wirefilter 语法）；Tiered Cache；按 Cache-Tag 或前缀清缓存；stale-while-revalidate；103 Early Hints；HTTP/3 + 0-RTT；Brotli/Zstd；Speculation-Rules；Under Attack（PoW 挑战，参考 Anubis / ALTCHA）；Logpush。不要复刻 Cloudflare 已废弃的 Auto Minify、Mirage、Rocket Loader，也不要做 Page Rules 那种单体规则模型。
- 竞品 OpenFlare（github.com/Rain-kl/OpenFlare，Go + OpenResty，带 Tunnels 和 Pages）：读它的 README 和设计文档，做出差异化。

### 要避免的
- GoEdge：控制面存节点 SSH root 凭据（2025 年 RingH23 攻击就是借此横向投毒所有边缘节点）；每次都拉全量配置；访问日志按天写 MySQL 再手工分库；闭源 Plus 版 + 联网授权；发布的二进制与源码不一致。
- CDNFly：Elasticsearch 要占 8–16GB 内存；主控通信端口固定且暴露。
- ATC：组件太多（Java、InfluxDB、ATS），运维负担重；Profile/Parameter 是弱类型，没有校验。

## 2. 已定的架构决策（每条写一篇 ADR 放 docs/adr/）
### 控制面 `edgeweir`
- 单体全栈：一个应用包、一个 Node 进程、一个镜像，同时提供 UI、API 和节点通道。技术栈：Node.js 24 LTS、pnpm + Turborepo、TypeScript strict、Biome（替换模板自带的 ESLint）、Vitest、Playwright。
- Web：Vite + React 19 SPA（TanStack Router 文件路由 + TanStack Query + TanStack Table）。生产环境由 Hono 直接托管静态资源；开发环境用 `@hono/vite-dev-server` 或等价方案做到单进程启动。不用 Next.js：这里不需要 SSR，也不想引入 RSC 的攻击面，而且它对长连接和后台 worker 不友好。
- UI：用 `pnpm dlx shadcn@latest init --preset b2D0wqNxT -t vite` 初始化（Luma 风格、Geist 字体、Hugeicons 图标、blue 主题，base 保持默认的 Base UI）。
  - 所有设计 token 以 shadcn 为准。
  - appica-ui（`@appica/ui-react`，同样基于 Base UI）不是 shadcn registry，它的 `--background`、`--primary`、`--secondary`、`--radius` 等变量与 shadcn 同名但含义不同。只在 shadcn 没有的组件上用它（color picker、rating、sparkline 等），通过一个 `appica-bridge.css` 把它的变量映射到 shadcn 变量，不要全局覆盖。
  - 全局只保留一个 ThemeProvider。
  - 后台外壳用 shadcn 的 sidebar、dashboard、chart、command、login 区块。
- i18n：默认 zh-CN，另加 en，从第一天接入（Paraglide JS 或同等的类型安全方案）。
- API：oRPC（契约优先 + zod）。同一份契约既给 UI 用（接 TanStack Query），也对外暴露 OpenAPI（`/api/v1`，AccessKey 认证，为以后的 SDK 和 Terraform provider 做准备）。
- 数据：PostgreSQL 18 + Drizzle（迁移是纯 SQL，容器启动时自动执行）。多实例之间用 LISTEN/NOTIFY 广播配置变更。任务队列和定时任务用 pg-boss，不强依赖 Redis；Valkey 作为可选组件。
- 认证：better-auth（organization、admin、2FA、passkey、api-key 插件）。多租户第一天就有：平台管理员 / 租户（组织）/ 成员 RBAC。
- 节点通道：Connect-RPC（connect-es v2）。protobuf 用 buf 管理，放在 `edgeweir/proto/`，是两个仓库之间唯一的契约来源；`edgeweir-node` 用 buf 从 git tag 生成 Go 代码。节点通道单独监听一个端口（默认 :8443），TLS 由应用自己终结，节点注册之后强制 mTLS。Web 控制台端口（默认 :3000）可以放在宝塔 nginx 后面。
- 分析和日志：ClickHouse（原始日志用 MergeTree，聚合用物化视图），作为 compose 的可选 profile。另有 lite 模式：只把节点预聚合好的分钟级统计存进 Postgres。节点侧先预聚合再上报，原始日志支持采样。
- 证书和 DNS：用 Go 的 lego（ACME，支持 ARI 和 DNS-01）加 libdns（DNSPod、阿里云、华为、Cloudflare 等的记录管理）做一个 Go helper `edgeweir-certd`，放在 `edgeweir/helpers/certd`，多阶段构建进同一个镜像，由 pg-boss 任务调用。TS 生态里没有同等成熟的库。
- 配置模型：控制面把站点和规则编译成与引擎无关的 NodeConfig IR（protobuf）。每次发布生成单调递增的 revision 和内容哈希；节点按 revision 拉取快照或增量 diff，应用后回执。支持金丝雀节点组和一键回滚。IR 与 OpenResty 解耦，将来可以加 Pingora 引擎。
- 规则引擎：一门表达式语言，wirefilter 风格，例如 `http.host eq "a.com" and ip.src in $blocklist`。TS 端负责解析、类型检查并编译成 IR，节点端再编译成 Lua。执行阶段依次为：request-transform → redirect → config → waf-custom → ratelimit → cache → origin → response-transform。

### 节点 `edgeweir-node`
- 形态：Go agent（二进制名 `edgeweir-node`，静态编译，systemd 管理）+ OpenResty（Lua）。数据面不用 TS/Bun。
- agent 职责：
  - 注册：一次性 token → 本地生成密钥和 CSR → 控制面内部 CA 签发节点证书 → 之后全程 mTLS，证书自动轮换。
  - 同步：WatchConfig 服务端流 + 轮询兜底；本地持久化 last-known-good 配置，控制面宕机时节点照常服务。
  - 重载：只有监听端口、缓存 zone 等结构性变更才重新渲染 nginx.conf → `nginx -t` → HUP。
  - 热更新：站点、路由、上游、证书、IP 名单通过本地 unix socket 推给 Lua。MVP 阶段存 lua_shared_dict（nginx 重启后由 agent 重新灌入），每个 worker 用 lua-resty-lrucache 加版本号做缓存和失效；等有了自定义构建再评估 lua-resty-lmdb。
  - 清缓存：支持 URL、前缀、tag、全量；全量清除通过 cache key 的代际号实现。另外支持预热。
  - 运维：健康检查、指标预聚合上报、访问日志采样上报、自升级（验签通过后再替换）。
- OpenResty：MVP 先用官方包或官方镜像，之后做自定义构建（http_v3、brotli、zstd、geoip2、lua-resty-lmdb，ModSecurity + CRS 作为可选动态模块）。缓存用 proxy_cache + slice + cache_lock + use_stale + background_update。
- 一键安装：`curl -fsSL https://<控制台>/install.sh | sudo bash -s -- --token <一次性token>`。install.sh 由控制台提供；二进制可以由控制台镜像转发（国内访问 GitHub 慢），但必须先校验 cosign 签名和 sha256 再执行。SSH 远程安装只作为可选的一次性操作，凭据用完即弃，默认不入库。
- 发布：goreleaser 产出 deb、rpm、tar.gz（amd64 和 arm64），cosign keyless 签名，附 SBOM 和 SLSA provenance，构建可复现（-trimpath、SOURCE_DATE_EPOCH）。

### 信任和安全基线（两个仓库都适用，写进 SECURITY.md）
- 没有任何 phone-home，没有授权校验代码；遥测默认关闭，必须显式开启。
- 私钥、DNS API 密钥、SSH 凭据等敏感数据用主密钥做信封加密后才入库；所有管理操作写审计日志。
- 发布物都签名并附校验说明；CI 构建产物与源码一一对应。

## 3. 本次会话要交付的（Phase 0：骨架 + 端到端最小闭环）
1. 仓库基础：两个仓库都写好 LICENSE、中英双语 README（含品牌故事）、ARCHITECTURE.md、docs/adr/、ROADMAP.md（把第 4 节整理进去）、SECURITY.md、CONTRIBUTING.md、CLAUDE.md（精简版：技术栈、常用命令、约定、不可违反的原则）、.editorconfig。CI 用 GitHub Actions：控制面跑 lint、typecheck、test、build 镜像；节点仓库跑 go test 和 goreleaser snapshot。
2. 控制面骨架：
   - monorepo 结构：`apps/console`（Hono server 在 `src/server`，React 在 `src/web`）、`packages/db`（Drizzle schema + migrations）、`packages/contract`（oRPC 契约 + zod）、`packages/config-compiler`（DB 模型 → NodeConfig IR）、`proto/`（buf）。目录可以按核实后的最佳实践微调，但必须保持"一个应用包、一个进程"。
   - 数据模型 v0：organization 和 user（better-auth）、cluster、node_group、node、node_ip、enrollment_token、site、site_domain、origin_pool、origin、cache_rule、config_revision、node_config_status、audit_log。
   - 后台页面（zh-CN / en）：登录；首次初始化向导（创建管理员）；概览；集群与节点（生成一次性安装命令，显示节点在线状态和已应用的 revision）；网站（新增站点：域名 + 源站 + 简单缓存规则）；设置。每个页面都要有空状态、加载态和错误态。
   - proto v0：`NodeService` 包含 `Enroll`、`WatchConfig`（server-streaming，推送 revision 通知）、`GetConfig`（按 revision 取快照或 diff）、`ReportStatus`、`ReportStats`。`NodeConfig` IR 覆盖 listeners、sites、domains、origins、cache rules 和 TLS 证书引用。
3. 节点骨架（`edgeweir-node`）：Go agent 走通 注册 → mTLS → watch → 快照落盘 → 渲染最小 nginx.conf → 经 unix socket 把站点表推给 Lua。Lua 按 Host 路由到上游并开启 proxy_cache，响应带 `X-Cache` 头；agent 回报已应用的 revision。
4. 端到端验证：`docker compose -f compose.e2e.yml up` 拉起 postgres、console、node（OpenResty 容器）和一个 whoami 源站。通过 API 创建站点后，`curl -H "Host: demo.test" http://<node>` 第一次返回 MISS、第二次返回 HIT；控制台能看到节点在线以及它的 revision。把这个流程写成测试并放进 CI。
5. 部署：
   - 多阶段 Dockerfile：非 root 运行、镜像尽量小、用 `ROLE=app|worker|all` 选择角色（默认 all）。
   - `compose.yml`：console + postgres:18；`--profile analytics` 加 ClickHouse，`--profile cache` 加 Valkey。
   - `compose.baota.yml` + `docs/deploy/baota.md`：说明如何在宝塔的 Docker 编排里导入、如何反代站点到 :3000；节点端口 :8443 要么直接暴露，要么用 stream 透传，TLS 不能由宝塔 nginx 终结。
   - `docs/deploy/docker.md`。

每完成一步就小步提交（Conventional Commits）。如果调研结论与实际文档或版本冲突，以官方文档为准，更新对应的 ADR，并告诉我。

## 4. ROADMAP（功能全集，Phase 0 之后分阶段实现）
- MVP：
  - 集群与站点：多集群、节点组、区域；站点支持 HTTP/HTTPS 和多域名（含泛域名）。
  - 源站：源站池（权重、备用、被动健康检查、回源 Host 和 SNI、对象存储源站鉴权）。
  - 缓存：缓存规则（按后缀、路径、前缀、状态码、大小；自定义缓存键；遵循或覆盖源站头；stale；Range 和 slice）；刷新和预热（URL、前缀、全量）。
  - 协议与证书：ACME 自动证书、上传证书、HSTS、HTTP/2 和 HTTP/3；Gzip、Brotli、Zstd。
  - 访问控制与规则：IP、CIDR、国家、省份、ASN 黑白名单；限速；重定向、改写、请求和响应头规则。
  - DNS：接入第三方 DNS（DNSPod、阿里云、华为、Cloudflare），自动下发 CNAME，健康检查不通过自动摘除，并有记录修复任务；节点健康检查自动下线。
  - 运维：分钟级统计（请求数、流量、带宽、命中率、状态码、Top URL 和 IP）；告警（邮件、Webhook、钉钉、企业微信、Telegram）；审计日志；开放 API。
- v1：
  - 安全：OWASP CRS 托管规则（先观察再拦截）；分级 CC 防护 + 5 秒盾 / PoW 挑战 + JA4 + nftables/ipset 联动；URL 鉴权（A–D 签名）、防盗链、UA 名单。
  - 缓存与调度：Tiered Cache / L2 + Topologies + 组内一致性哈希；按 Cache-Tag 清缓存；智能调度规则 + 区域探针 + 节点租期。
  - 日志：原始日志写入 ClickHouse，支持 Logpush（S3、HTTP、Kafka）。
  - 协议与优化：TCP/UDP 四层转发（PROXY protocol）；图片 WebP/AVIF 转换和缩放（imgproxy）；103 Early Hints；注入 Speculation-Rules；自定义错误页。
  - 发布：配置金丝雀发布 + 自动回滚。
  - 租户：租户门户、套餐和配额、流量包、余额、95 计费、支付接口、实名认证、工单。
- v2：
  - 自建权威 DNS/GTM（评估 PowerDNS 和 CoreDNS 方案）；XDP/eBPF 三四层防护。
  - 共享压缩字典；Cache Reserve（S3/MinIO 持久层）。
  - 边缘计算（表达式 DSL 或 Wasm 沙箱，租户脚本需审批）；Pingora 引擎（等它的 HTTP/3 成熟之后）。
  - 高防 IP 售卖模块；Tunnels 内网穿透。
