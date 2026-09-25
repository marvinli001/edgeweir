# 路线图

本文件是 Edgeweir 的功能全集与阶段划分，内容来自 [BOOTSTRAP.md](BOOTSTRAP.md) §3（Phase 0）和 §4（MVP、v1、v2），以及对标调研补充的条目（[docs/research/benchmark.md](docs/research/benchmark.md)），覆盖 edgeweir（控制面）和 edgeweir-node（节点）两个仓库。每个阶段内按领域分组；勾选表示已完成并合入 master。设计依据见 [docs/adr/](docs/adr/README.md)。

## Phase 0（已完成于本仓库初始化）

目标：骨架加端到端最小闭环。

### 仓库基础

- [x] 两个仓库：LICENSE（AGPL-3.0）、中英双语 README（含品牌故事）、ARCHITECTURE.md、docs/adr/、ROADMAP.md、SECURITY.md、CONTRIBUTING.md、CLAUDE.md、.editorconfig
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
- [x] `compose.yml`：console + postgres:18；`--profile analytics` 加 ClickHouse，`--profile cache` 加 Valkey
- [x] `compose.baota.yml` + `docs/deploy/baota.md`：宝塔 Docker 编排导入、反代站点到 `:3000`；节点端口 `:8443` 直接暴露或用 stream 透传，TLS 不能由宝塔 nginx 终结
- [x] `docs/deploy/docker.md`

## MVP

### 集群与站点

- [x] 多集群
- [x] 节点组
- [x] 区域
- [ ] 站点支持 HTTP 和 HTTPS
- [x] 站点支持多域名（含泛域名）

### 租户与账户

- [x] 组织（租户）、默认集群、成员与角色、邀请
- [x] 平台用户管理：创建、平台管理员、停用
- [x] 账户安全：修改密码、TOTP、passkey；组织可要求两步验证
- [x] 一次性 setup token 保护首次初始化

### 源站

- [x] 源站池：权重
- [x] 源站池：备用源站
- [x] 负载均衡：加权随机、平滑加权轮询、一致性哈希
- [x] 被动健康检查
- [x] 回源 Host 和 SNI
- [x] 回源 HTTPS 证书校验（默认开启，可按站点关闭）
- [x] 对象存储源站鉴权
- [x] 回源连接池与超时、WebSocket 透传

### 缓存

- [x] 缓存规则：按后缀、路径、前缀、状态码、大小匹配
- [x] 自定义缓存键
- [x] 遵循或覆盖源站缓存头
- [x] stale（过期内容兜底）
- [x] Range 和 slice
- [x] 刷新：URL、前缀、全量
- [x] 预热

### 协议与证书

- [ ] ACME 自动证书
- [ ] 上传证书
- [ ] HSTS
- [ ] HTTP/2
- [ ] HTTP/3
- [ ] Gzip、Brotli、Zstd
- [ ] 最低 TLS 版本、OCSP stapling、ZeroSSL

### 访问控制与规则

- [ ] IP、CIDR 黑白名单
- [ ] 国家、省份、ASN 黑白名单
- [ ] 限速
- [ ] 重定向规则
- [ ] 改写规则
- [ ] 请求头和响应头规则
- [ ] 平台级 IP 名单、自定义 WAF 规则、配置规则

### DNS

- [ ] 接入第三方 DNS：DNSPod、阿里云、华为云、Cloudflare
- [ ] 自动下发 CNAME
- [ ] 健康检查不通过时自动摘除记录
- [ ] DNS 记录修复任务
- [ ] 节点健康检查不通过时自动下线
- [ ] 域名所有权校验（TXT）
- [ ] DNS 与节点配置分开发布

### 运维

- [x] 分钟级统计：请求数、流量、带宽、命中率、状态码（lite 模式；小时/天汇总与清理待做）
- [ ] 分钟级统计：Top URL、Top IP
- [ ] 告警渠道：邮件、Webhook、钉钉、企业微信、Telegram
- [x] 审计日志
- [ ] 开放 API
- [ ] 节点自升级（验签、按节点组灰度、失败回滚）
- [ ] 访问日志采样上报与检索
- [ ] AccessKey 吊销与只读范围
- [ ] 性能基线（bench）与备份恢复演练

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

### 日志

- [ ] 原始日志写入 ClickHouse
- [ ] Logpush：S3、HTTP、Kafka
- [ ] 访问日志检索与导出、攻击大盘、回源质量
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

### 租户

- [ ] 租户门户
- [ ] 套餐和配额
- [ ] 流量包
- [ ] 余额
- [ ] 95 计费
- [ ] 支付接口
- [ ] 实名认证
- [ ] 工单
- [ ] 优惠券、邀请码、白标、自助注册、欠费停用
- [ ] 短信与微信支付

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

- [ ] 高防 IP 售卖模块
- [ ] Tunnels 内网穿透
