# 路线图

开源核心（edgeweir 控制台与 edgeweir-node 节点）的功能范围与交付状态。

## 状态

| 状态 | 含义 |
| --- | --- |
| 已完成 | 已实现并合入 `master` |
| 待办 | 属于当前阶段，尚未完成 |
| 受阻 | 依赖上游或外部条件，暂不实现 |
| 计划中 | 后续阶段，未开始 |
| 不在核心 | 归独立商业运营产品（[ADR-0019](docs/adr/0019-open-core-and-commercial-products.md)） |

说明列中的“收尾”指 2026-09-25 收尾审计新增的条目，“D1”至“D6”是该审计的延后项编号。设计依据见 [ADR 索引](docs/adr/README.md)。

## 阶段

| 阶段 | 需求来源 | 状态 |
| --- | --- | --- |
| Phase 0 | BOOTSTRAP §3 | 已完成 |
| MVP（M1–M6） | BOOTSTRAP §4、MVP 规格 | 已完成；Brotli / Zstd 受阻 |
| 首次正式发布前 | 收尾审计延后项、[ADR-0017](docs/adr/0017-release-supply-chain.md) | 待办 2 项 |
| v1 | BOOTSTRAP §4、对标调研 | 计划中；2 项随 MVP M6 提前完成 |
| v2 | BOOTSTRAP §4、对标调研 | 计划中 |

## Phase 0

### 仓库与 CI

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 仓库文档：LICENSE（AGPL-3.0）、中英 README、ARCHITECTURE、ADR、ROADMAP、SECURITY、CONTRIBUTING、`.editorconfig` | 已完成 | 两个仓库 |
| edgeweir CI：lint、typecheck、test、镜像构建 | 已完成 | — |
| edgeweir-node CI：go test、goreleaser snapshot | 已完成 | — |

### 控制台骨架

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| monorepo：`apps/console`（Hono 服务端 `src/server`、React `src/web`）、`packages/db`、`packages/contract`、`packages/config-compiler`、`proto/` | 已完成 | 一个应用包、一个进程 |
| 数据模型 v0 | 已完成 | organization、user（better-auth）、cluster、node_group、node、node_ip、enrollment_token、site、site_domain、origin_pool、origin、cache_rule、config_revision、node_config_status、audit_log |
| 页面（zh-CN / en）：登录、初始化向导、概览、集群与节点、网站、设置 | 已完成 | 每个页面有空、加载、错误状态 |
| proto v0 `NodeService` | 已完成 | `Enroll`、`WatchConfig`、`GetConfig`、`ReportStatus`、`ReportStats`、`RenewCertificate` |
| `NodeConfig` IR | 已完成 | listeners、sites、domains、origins、cache rules、TLS 证书引用 |

### 节点骨架

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| agent 链路：注册、mTLS、watch、快照落盘、渲染 nginx.conf、经 unix socket 把站点表推给 Lua | 已完成 | — |
| Lua 按 Host 路由到上游并启用 proxy_cache，响应带 `X-Cache` 头 | 已完成 | — |
| agent 回报已应用的 revision | 已完成 | — |

### 端到端验证

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| `compose.e2e.yml`：postgres、console、node（OpenResty）、whoami 源站 | 已完成 | — |
| 经 API 创建站点后，`curl -H "Host: demo.test" http://<node>` 先返回 `MISS`，再返回 `HIT` | 已完成 | — |
| 控制台显示节点在线与已应用的 revision | 已完成 | — |
| 以上流程纳入 CI | 已完成 | — |

### 部署

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 多阶段 Dockerfile | 已完成 | 非 root；`ROLE` 取 `app`、`worker` 或 `all`，默认 `all` |
| `compose.yml` | 已完成 | console 与 PostgreSQL 18；profile `analytics` 加 ClickHouse，profile `cache` 加 Valkey（控制台目前未使用 Valkey） |
| `compose.baota.yml` 与[宝塔部署文档](docs/deploy/baota.md) | 已完成 | 反代到 `:3000`；`:8443` 直接暴露或 stream 透传，TLS 不能由宝塔 nginx 终结 |
| [Docker Compose 部署文档](docs/deploy/docker.md) | 已完成 | — |

## MVP

### 集群与站点

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 多集群 | 已完成 | — |
| 节点组 | 已完成 | — |
| 区域 | 已完成 | — |
| 站点支持 HTTP 与 HTTPS | 已完成 | — |
| 站点多域名（含泛域名） | 已完成 | — |

### 租户与账户

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 组织（租户）、默认集群、成员与角色、邀请 | 已完成 | — |
| 平台用户管理：创建、平台管理员、停用 | 已完成 | — |
| 账户安全：修改密码、TOTP、passkey；组织可要求两步验证 | 已完成 | — |
| 一次性 setup token 保护首次初始化 | 已完成 | — |
| 认证加固 | 已完成 | 收尾：`/api/auth/*` 只放行界面用到的端点；API key 只在 `/api/v1` 生效；客户端 IP 只信任 `EDGEWEIR_TRUSTED_PROXIES` 的转发头；登录限速计数存数据库；登录、改密码、两步验证、passkey、API key 变更写审计 |

### 源站

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 源站池：权重、备用源站 | 已完成 | — |
| 负载均衡：加权随机、平滑加权轮询、一致性哈希 | 已完成 | — |
| 被动健康检查 | 已完成 | — |
| 回源 Host 与 SNI | 已完成 | — |
| 回源 HTTPS 证书校验 | 已完成 | 默认开启，可按站点关闭 |
| 对象存储源站鉴权 | 已完成 | — |
| 回源连接池与超时、WebSocket 透传 | 已完成 | — |
| 源站地址限制：拒绝回环、私网、链路本地等特殊用途地址，平台允许清单放行；回环检测（`CDN-Loop`） | 已完成 | 收尾 |

### 缓存

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 缓存规则：按后缀、路径、前缀、状态码、大小匹配 | 已完成 | — |
| 自定义缓存键 | 已完成 | — |
| 遵循或覆盖源站缓存头 | 已完成 | — |
| stale（过期内容兜底） | 已完成 | — |
| Range 与 slice | 已完成 | — |
| 刷新：URL、前缀、全站 | 已完成 | — |
| 预热 | 已完成 | URL 预热；前缀、全站与按变体预热见 [v1](#缓存与调度) |
| 带 `Authorization` 的请求默认不缓存，规则可显式放行 | 已完成 | 收尾 |
| 刷新预热按组织限频；节点清缓存标记有上限，溢出时合并为站点级标记；离线超过 7 天或停用期间错过的刷新补发整站刷新 | 已完成 | 收尾 |

### 协议与证书

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| ACME 自动证书 | 已完成 | HTTP-01、DNS-01 |
| 上传证书 | 已完成 | — |
| HSTS | 已完成 | — |
| HTTP/2 | 已完成 | — |
| HTTP/3 | 已完成 | — |
| Gzip（类型与最小长度） | 已完成 | — |
| Brotli、Zstd | 受阻 | 官方 OpenResty 引擎不含模块，界面中保持不可用 |
| 最低 TLS 版本、OCSP stapling、ZeroSSL | 已完成 | ZeroSSL EAB 未经真实账户验收 |
| 最低 agent 能力门槛：不满足的节点拿不到需要新语义的配置，节点拒绝未知枚举值 | 已完成 | proto v0.3.0（M3）；收尾延后 D1 |

### 访问控制与规则

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| IP、CIDR 黑白名单 | 已完成 | — |
| 国家、省份、ASN 黑白名单 | 已完成 | 本地 MMDB |
| 限速 | 已完成 | 单节点固定窗口 |
| 重定向规则 | 已完成 | — |
| 改写规则 | 已完成 | — |
| 请求头与响应头规则 | 已完成 | — |
| 平台级 IP 名单、自定义 WAF 规则、配置规则 | 已完成 | — |

### DNS

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 第三方 DNS：DNSPod、阿里云、华为云、Cloudflare | 已完成 | 未经真实服务商账户验收 |
| 自动下发 CNAME | 已完成 | — |
| 健康检查不通过时自动摘除记录 | 已完成 | — |
| DNS 记录修复任务 | 已完成 | — |
| 节点健康检查不通过时自动下线 | 已完成 | — |
| 域名所有权校验（TXT） | 已完成 | — |
| DNS 与节点配置分开发布 | 已完成 | — |

### 运维

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 分钟级统计：请求数、流量、带宽、命中率、状态码 | 已完成 | lite 模式 |
| 统计上报幂等（批次序号）、小时 / 天汇总、明细保留期 | 已完成 | 分钟 / 小时 / 天分别保留 7 / 90 / 365 天；M5，收尾延后 D2 |
| Top URL、Top IP | 已完成 | 节点端估算值 |
| 告警渠道：邮件、Webhook、钉钉、企业微信、Telegram | 已完成 | 钉钉、企业微信、Telegram 未经真实账户验收 |
| 审计日志 | 已完成 | — |
| 开放 API | 已完成 | — |
| 节点自升级：验签、按节点组灰度、失败回滚 | 已完成 | 监督进程与引擎通过系统包或镜像更新 |
| 访问日志采样上报与检索 | 已完成 | 默认关闭；PostgreSQL 日分区或可选 ClickHouse；保留 7 天；CSV 导出 |
| AccessKey 吊销与只读范围 | 已完成 | — |
| 性能基线（bench） | 已完成 | — |
| 备份恢复演练 | 已完成 | 恢复后节点继续接受新 revision（控制台签发的配置回执）；收尾延后 D3 |
| 系统设置：SMTP、节点发布源、所有权校验 DNS、源站地址允许清单、GeoIP | 已完成 | 后台保存值优先于环境变量 |

### 部署

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 控制台镜像滚动发布：`<YYYYMMDD>-<commit>` tag，cosign keyless 签名 | 已完成 | [ADR-0017](docs/adr/0017-release-supply-chain.md) 2026-09-29 更新记录 |
| `deploy.sh`：宝塔 / aaPanel Compose 部署的安装与升级 | 已完成 | — |
| 节点通道独立监听（`NODE_API_HOST`、`NODE_API_PORT`） | 已完成 | — |
| `BETTER_AUTH_SECRET` 可选，未设置时由主密钥派生 | 已完成 | — |

## 首次正式发布前

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 两个仓库的容器基础镜像按 digest、GitHub Actions 按完整 commit SHA 固定 | 已完成 | 收尾延后 D5；ADR-0017 2026-09-27 更新记录；控制台测试与节点 `make pin-check` 防回退 |
| 两个仓库的 release 工作流（签名、provenance、推送镜像）按 [SECURITY.md](SECURITY.md) 演练一遍校验命令 | 待办 | 控制台镜像改为 `master` 滚动发布（ADR-0017 2026-09-29 更新记录），首次推送后演练 |
| 经 GitHub OIDC 签名的正式二进制发布 | 待办 | 尚未发布 |
| 公开仓库的节点 CI 从 GitHub 拉取 `proto/v0.7.0` 并检查生成代码一致性 | 已完成 | 收尾延后 D6 |

## v1

### 安全

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| OWASP CRS 托管规则 | 计划中 | 先观察，再拦截 |
| 分级 CC 防护 | 计划中 | — |
| 5 秒盾 / PoW 挑战 | 计划中 | — |
| JA4 指纹 | 计划中 | — |
| nftables / ipset 联动封禁 | 计划中 | — |
| URL 鉴权（A、B、C、D 四种签名方式） | 计划中 | — |
| 防盗链 | 计划中 | — |
| UA 名单 | 计划中 | — |
| IP 灰名单、nftables 连接数与新建速率限制 | 计划中 | — |
| 管理后台登录 IP 白名单 | 计划中 | — |
| 域名黑名单与内容关键词监控 | 计划中 | — |

### 缓存与调度

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| Tiered Cache / L2 回源 | 计划中 | — |
| Topologies（可复用的缓存层级拓扑） | 计划中 | — |
| 组内一致性哈希 | 计划中 | — |
| 按 Cache-Tag 清缓存 | 计划中 | — |
| 智能调度规则 | 计划中 | — |
| 区域探针 | 计划中 | — |
| 节点租期 | 计划中 | — |
| 组内缓存索引节点 | 计划中 | — |
| 源站主动健康检查、会话保持 | 计划中 | — |
| 预热：前缀与全站预热、按缓存键变体（例如移动端）预热 | 计划中 | 目前只预热桌面变体；收尾延后 D4 |

### 日志

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 原始日志写入 ClickHouse | 已完成 | 随 MVP M6 提前完成 |
| 访问日志检索与 CSV 导出 | 已完成 | 随 MVP M6 提前完成 |
| Logpush：S3、HTTP、Kafka | 计划中 | — |
| 攻击大盘、回源质量 | 计划中 | — |
| 短信告警渠道 | 计划中 | — |

### 协议与优化

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| TCP/UDP 四层转发（PROXY protocol） | 计划中 | — |
| 图片 WebP / AVIF 转换与缩放（imgproxy） | 计划中 | — |
| 103 Early Hints | 计划中 | — |
| 注入 Speculation-Rules | 计划中 | — |
| 自定义错误页 | 计划中 | — |
| CORS、HLS 加密、访客 IP 来源、按站点请求与流量限制 | 计划中 | — |
| 域名正则与 IDN 匹配、网站分组、批量重定向 | 计划中 | — |
| 0-RTT、回源与访客双向 mTLS、Origin CA | 计划中 | — |

### 发布

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 配置金丝雀发布 | 计划中 | — |
| 自动回滚 | 计划中 | — |
| 规则版本与回滚 | 计划中 | — |
| 节点 CLI 诊断、时钟偏差告警、节点日志页 | 计划中 | — |

## v2

### DNS 与三四层防护

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 自建权威 DNS / GTM | 计划中 | 评估 PowerDNS 与 CoreDNS |
| XDP / eBPF 三四层防护 | 计划中 | — |
| 七层 DDoS 自动缓解、Bot 评分 | 计划中 | — |
| 证书透明度监控、ECH | 计划中 | — |

### 缓存

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 共享压缩字典 | 计划中 | — |
| Cache Reserve（S3 / MinIO 持久层） | 计划中 | — |

### 边缘计算与引擎

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 边缘计算：表达式 DSL 或 Wasm 沙箱 | 计划中 | 租户脚本需要审批 |
| Pingora 引擎 | 计划中 | 待 Pingora 的 HTTP/3 成熟 |
| 按探测延迟选父节点的智能路由、边缘 HTML 改写 | 计划中 | — |
| RUM 真实用户监控、安全事件浏览器 | 计划中 | — |

### 产品模块

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| Tunnels 内网穿透 | 计划中 | — |

## 不在开源核心的范围

组织、成员、邀请、角色、租户隔离及现有控制台与后台属于开源核心。用量统计、资源保护和管理 API 留在核心；商业套餐、订阅状态和账本不进入核心数据模型。BOOTSTRAP 中下列条目的旧归属已被 ADR-0019 取代，商业产品另行排期。许可证与边界见 [LICENSING.md](LICENSING.md)。

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| 客户门户、自助注册购买 | 不在核心 | 原列于 v1 |
| 套餐与商业配额、流量包、余额、95 计费、支付 | 不在核心 | 原列于 v1 |
| 实名认证、工单、优惠券、白标、欠费流程、短信 / 微信支付 | 不在核心 | 原列于 v1 |
| 高防 IP 的售卖、订单与结算 | 不在核心 | 节点防护与调度能力仍按本路线图推进 |
| 公开营销落地页 | 不在核心 | ADR-0019 2026-09-29 更新记录；登录页与邀请加入仍属开源核心 |
