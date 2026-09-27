# 路线图

产品范围按 2026-09-26 的 [ADR-0019](docs/adr/0019-open-core-and-commercial-products.md) 划分：本文件跟踪 AGPL-3.0-only 开源核心；客户门户、套餐计费、财务和分销另属商业运营产品。BOOTSTRAP 中这些功能的旧归属已被取代，已实现的组织、成员和隔离能力保留。

本文件是 Edgeweir 开源核心的功能范围与阶段划分，历史需求来自 BOOTSTRAP §3（Phase 0）和 §4（MVP、v1、v2），对标调研补充的条目，以及 2026-09-25 收尾审计的延后项（标为「收尾延后」），按 ADR-0019 的商业边界整理后覆盖 edgeweir（控制面）和 edgeweir-node（节点）两个仓库。每个阶段内按领域分组；勾选表示已完成并合入 master。设计依据见 [docs/adr/](docs/adr/README.md)。

## Phase 0（已完成于本仓库初始化）

目标：骨架加端到端最小闭环。

### 仓库基础

- [x] 两个仓库：LICENSE（AGPL-3.0）、中英双语 README（含品牌故事）、ARCHITECTURE.md、docs/adr/、ROADMAP.md、SECURITY.md、CONTRIBUTING.md、.editorconfig
- [x] edgeweir 的 GitHub Actions：lint、typecheck、test、构建镜像
- [x] edgeweir-node 的 GitHub Actions：go test、goreleaser snapshot

### 控制面骨架

- [x] monorepo：`apps/console`（Hono 服务端在 `src/server`，React 在 `src/web`）、`packages/db`、`packages/contract`、`packages/config-compiler`、`proto/`；保持一个应用包、一个进程
- [x] 数据模型 v0：organization 与 user（better-auth）、cluster、node_group、node、node_ip、enrollment_token、site、site_domain、origin_pool、origin、cache_rule、config_revision、node_config_status、audit_log
- [x] 后台页面（zh-CN / en）：登录、首次初始化向导（创建管理员）、概览、集群与节点（生成一次性安装命令，显示节点在线状态和已应用的 revision）、网站（新增站点：域名 + 源站 + 简单缓存规则）、设置
- [x] 每个页面都有空状态、加载态和错误态
- [x] proto v0：`NodeService` 包含 `Enroll`、`WatchConfig`（服务端流，推送 revision 通知）、`GetConfig`（按 revision 取快照或 diff）、`ReportStatus`、`ReportStats`（另含 `RenewCertificate`）
- [x] `NodeConfig` IR 覆盖 listeners、sites、domains、origins、cache rules 和 TLS 证书引用

### 节点骨架（edgeweir-node）

- [x] Go agent 走通：注册 → mTLS → watch → 快照落盘 → 渲染最小 nginx.conf → 经 unix socket 把站点表推给 Lua
- [x] Lua 按 Host 路由到上游并开启 proxy_cache，响应带 `X-Cache` 头
- [x] agent 回报已应用的 revision

### 端到端验证

- [x] `docker compose -f compose.e2e.yml up` 拉起 postgres、console、node（OpenResty 容器）和一个 whoami 源站
- [x] 通过 API 创建站点后，`curl -H "Host: demo.test" http://<node>` 第一次返回 `MISS`、第二次返回 `HIT`
- [x] 控制台能看到节点在线以及它的 revision
- [x] 以上流程写成测试并放进 CI

### 部署

- [x] 多阶段 Dockerfile：非 root 运行、镜像尽量小、`ROLE=app|worker|all`（默认 `all`）
- [x] `compose.yml`：console + postgres:18；`--profile analytics` 加 ClickHouse，`--profile cache` 加 Valkey（ClickHouse 可选写入日志和分钟统计，Valkey 仍预留）
- [x] `compose.baota.yml` + `docs/deploy/baota.md`：宝塔 Docker 编排导入、反代站点到 `:3000`；节点端口 `:8443` 直接暴露或用 stream 透传，TLS 不能由宝塔 nginx 终结
- [x] `docs/deploy/docker.md`

## MVP

### 集群与站点

- [x] 多集群
- [x] 节点组
- [x] 区域
- [x] 站点支持 HTTP 和 HTTPS
- [x] 站点支持多域名（含泛域名）

### 租户与账户

- [x] 组织（租户）、默认集群、成员与角色、邀请
- [x] 平台用户管理：创建、平台管理员、停用
- [x] 账户安全：修改密码、TOTP、passkey；组织可要求两步验证
- [x] 一次性 setup token 保护首次初始化
- [x] 认证加固（收尾）：`/api/auth/*` 只放行界面用到的端点，API key 只在 `/api/v1` 生效；客户端 IP 只信任 `EDGEWEIR_TRUSTED_PROXIES` 的转发头；登录限速计数存数据库；登录、改密码、两步验证、passkey、API key 变更写审计

### 源站

- [x] 源站池：权重
- [x] 源站池：备用源站
- [x] 负载均衡：加权随机、平滑加权轮询、一致性哈希
- [x] 被动健康检查
- [x] 回源 Host 和 SNI
- [x] 回源 HTTPS 证书校验（默认开启，可按站点关闭）
- [x] 对象存储源站鉴权
- [x] 回源连接池与超时、WebSocket 透传
- [x] 源站地址限制：拒绝回环、私网、链路本地等特殊用途地址，平台允许清单放行；回环检测（`CDN-Loop`）（收尾）

### 缓存

- [x] 缓存规则：按后缀、路径、前缀、状态码、大小匹配
- [x] 自定义缓存键
- [x] 遵循或覆盖源站缓存头
- [x] stale（过期内容兜底）
- [x] Range 和 slice
- [x] 刷新：URL、前缀、全量
- [x] 预热
- [x] 带 `Authorization` 的请求默认不缓存，规则可显式放行（收尾）
- [x] 刷新预热按组织限频；节点端清缓存标记有上限，溢出时合并为站点级标记；离线超过 7 天或停用期间错过的刷新补发整站刷新（收尾）

### 协议与证书

- [x] ACME 自动证书
- [x] 上传证书
- [x] HSTS
- [x] HTTP/2
- [x] HTTP/3
- [x] Gzip（类型和最小长度）
- [ ] Brotli、Zstd（官方引擎无模块，界面保持不可用）
- [x] 最低 TLS 版本、OCSP stapling、ZeroSSL
- [x] 最低 agent 能力门槛：不满足的节点拿不到需要新语义的配置，节点拒绝未知枚举值（proto v0.3.0，随 M3；收尾延后 D1）

### 访问控制与规则

- [x] IP、CIDR 黑白名单
- [x] 国家、省份、ASN 黑白名单
- [x] 限速
- [x] 重定向规则
- [x] 改写规则
- [x] 请求头和响应头规则
- [x] 平台级 IP 名单、自定义 WAF 规则、配置规则

### DNS

- [x] 接入第三方 DNS：DNSPod、阿里云、华为云、Cloudflare
- [x] 自动下发 CNAME
- [x] 健康检查不通过时自动摘除记录
- [x] DNS 记录修复任务
- [x] 节点健康检查不通过时自动下线
- [x] 域名所有权校验（TXT）
- [x] DNS 与节点配置分开发布

### 运维

- [x] 分钟级统计：请求数、流量、带宽、命中率、状态码（lite 模式）
- [x] 统计上报幂等（批次序号）、小时 / 天汇总与分钟明细保留期（M5，收尾延后 D2）
- [x] 分钟级统计：Top URL、Top IP
- [x] 告警渠道：邮件、Webhook、钉钉、企业微信、Telegram
- [x] 审计日志
- [x] 开放 API
- [x] 节点自升级（验签、按节点组灰度、失败回滚；监督进程和引擎通过系统包 / 镜像维护）
- [x] 访问日志采样上报与检索（默认关闭、PostgreSQL 日分区 / 可选 ClickHouse、CSV）
- [x] AccessKey 吊销与只读范围
- [x] 性能基线（bench）与备份恢复演练（恢复后节点继续接受新 revision：配置 epoch 或跳过节点已应用的最大 revision，收尾延后 D3）

## 首次正式发布前

- [x] 容器基础镜像按 digest、GitHub Actions 按完整 commit SHA 固定，两个仓库都要做（收尾延后 D5，[ADR-0017](docs/adr/0017-release-supply-chain.md) 收尾与 2026-09-27 记录；控制台测试与节点 `make pin-check` 防回退）
- [ ] 两个仓库的 release 工作流（签名、provenance、推送镜像）按 [SECURITY.md](SECURITY.md) 演练一遍校验命令
- [x] 公开仓库的节点 CI 从 GitHub 拉取 proto/v0.7.0，并检查生成代码一致性（收尾延后 D6）

## v1

### 安全

- [ ] OWASP CRS 托管规则（先观察，再拦截）
- [ ] 分级 CC 防护
- [ ] 5 秒盾 / PoW 挑战
- [ ] JA4 指纹
- [ ] nftables/ipset 联动封禁
- [ ] URL 鉴权（A、B、C、D 四种签名方式）
- [ ] 防盗链
- [ ] UA 名单
- [ ] IP 灰名单、nftables 连接数与新建速率限制
- [ ] 管理后台登录 IP 白名单
- [ ] 域名黑名单与内容关键词监控

### 缓存与调度

- [ ] Tiered Cache / L2 回源
- [ ] Topologies（可复用的缓存层级拓扑）
- [ ] 组内一致性哈希
- [ ] 按 Cache-Tag 清缓存
- [ ] 智能调度规则
- [ ] 区域探针
- [ ] 节点租期
- [ ] 组内缓存索引节点
- [ ] 源站主动健康检查、会话保持
- [ ] 预热：前缀和全站预热；按缓存键变体（例如移动端）预热，目前只预热桌面变体（收尾延后 D4）

### 日志

- [x] 原始日志写入 ClickHouse（提前纳入 MVP M6）
- [ ] Logpush：S3、HTTP、Kafka
- [x] 访问日志检索与 CSV 导出（已提前在 M6 完成）
- [ ] 攻击大盘、回源质量
- [ ] 短信告警渠道

### 协议与优化

- [ ] TCP/UDP 四层转发（PROXY protocol）
- [ ] 图片 WebP/AVIF 转换和缩放（imgproxy）
- [ ] 103 Early Hints
- [ ] 注入 Speculation-Rules
- [ ] 自定义错误页
- [ ] CORS、HLS 加密、访客 IP 来源、按站点请求与流量限制
- [ ] 域名正则与 IDN 匹配、网站分组、批量重定向
- [ ] 0-RTT、回源与访客双向 mTLS、Origin CA

### 发布

- [ ] 配置金丝雀发布
- [ ] 自动回滚
- [ ] 规则版本与回滚
- [ ] 节点 CLI 诊断、时钟偏差告警、节点日志页

### 组织与资源接口（开源核心）

组织、成员、邀请、角色、租户隔离及现有控制台 / 后台已在 MVP 中提供，继续开源。用量统计、资源保护和管理 API 留在核心；商业套餐、订阅状态和账本不进入核心数据模型。

原本列在本节的客户门户、自助注册购买、套餐与商业配额、流量包、余额、95 计费、支付、实名认证、工单、优惠券、白标、欠费流程和短信 / 微信支付移入独立商业运营产品，不再作为开源 v1 的交付项。归属见 [ADR-0019](docs/adr/0019-open-core-and-commercial-products.md)，商业产品另行排期。

## v2

### DNS 与三四层防护

- [ ] 自建权威 DNS/GTM（评估 PowerDNS 和 CoreDNS 方案）
- [ ] XDP/eBPF 三四层防护
- [ ] 七层 DDoS 自动缓解、Bot 评分
- [ ] 证书透明度监控、ECH

### 缓存

- [ ] 共享压缩字典
- [ ] Cache Reserve（S3/MinIO 持久层）

### 边缘计算与引擎

- [ ] 边缘计算：表达式 DSL 或 Wasm 沙箱，租户脚本需要审批
- [ ] Pingora 引擎（等它的 HTTP/3 成熟之后）
- [ ] 按探测延迟选父节点的智能路由、边缘 HTML 改写
- [ ] RUM 真实用户监控、安全事件浏览器

### 产品模块

- [ ] Tunnels 内网穿透

高防 IP 的售卖、订单与结算归独立商业运营产品；节点防护与调度能力仍按开源路线图推进。
