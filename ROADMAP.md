# 路线图

本文件是 Edgeweir 的功能全集与阶段划分，内容来自 [BOOTSTRAP.md](BOOTSTRAP.md) §3（Phase 0）和 §4（MVP、v1、v2），覆盖 edgeweir（控制面）和 edgeweir-node（节点）两个仓库。每个阶段内按领域分组；勾选表示已完成并合入 master。设计依据见 [docs/adr/](docs/adr/README.md)。

## Phase 0（已完成于本仓库初始化）

目标：骨架加端到端最小闭环。

### 仓库基础

- [ ] 两个仓库：LICENSE（AGPL-3.0）、中英双语 README（含品牌故事）、ARCHITECTURE.md、docs/adr/、ROADMAP.md、SECURITY.md、CONTRIBUTING.md、CLAUDE.md、.editorconfig
- [ ] edgeweir 的 GitHub Actions：lint、typecheck、test、构建镜像
- [ ] edgeweir-node 的 GitHub Actions：go test、goreleaser snapshot

### 控制面骨架

- [ ] monorepo：`apps/console`（Hono 服务端在 `src/server`，React 在 `src/web`）、`packages/db`、`packages/contract`、`packages/config-compiler`、`proto/`；保持一个应用包、一个进程
- [ ] 数据模型 v0：organization 与 user（better-auth）、cluster、node_group、node、node_ip、enrollment_token、site、site_domain、origin_pool、origin、cache_rule、config_revision、node_config_status、audit_log
- [ ] 后台页面（zh-CN / en）：登录、首次初始化向导（创建管理员）、概览、集群与节点（生成一次性安装命令，显示节点在线状态和已应用的 revision）、网站（新增站点：域名 + 源站 + 简单缓存规则）、设置
- [ ] 每个页面都有空状态、加载态和错误态
- [ ] proto v0：`NodeService` 包含 `Enroll`、`WatchConfig`（服务端流，推送 revision 通知）、`GetConfig`（按 revision 取快照或 diff）、`ReportStatus`、`ReportStats`（另含 `RenewCertificate`）
- [ ] `NodeConfig` IR 覆盖 listeners、sites、domains、origins、cache rules 和 TLS 证书引用

### 节点骨架（edgeweir-node）

- [ ] Go agent 走通：注册 → mTLS → watch → 快照落盘 → 渲染最小 nginx.conf → 经 unix socket 把站点表推给 Lua
- [ ] Lua 按 Host 路由到上游并开启 proxy_cache，响应带 `X-Cache` 头
- [ ] agent 回报已应用的 revision

### 端到端验证

- [ ] `docker compose -f compose.e2e.yml up` 拉起 postgres、console、node（OpenResty 容器）和一个 whoami 源站
- [ ] 通过 API 创建站点后，`curl -H "Host: demo.test" http://<node>` 第一次返回 `MISS`、第二次返回 `HIT`
- [ ] 控制台能看到节点在线以及它的 revision
- [ ] 以上流程写成测试并放进 CI

### 部署

- [ ] 多阶段 Dockerfile：非 root 运行、镜像尽量小、`ROLE=app|worker|all`（默认 `all`）
- [ ] `compose.yml`：console + postgres:18；`--profile analytics` 加 ClickHouse，`--profile cache` 加 Valkey
- [ ] `compose.baota.yml` + `docs/deploy/baota.md`：宝塔 Docker 编排导入、反代站点到 `:3000`；节点端口 `:8443` 直接暴露或用 stream 透传，TLS 不能由宝塔 nginx 终结
- [ ] `docs/deploy/docker.md`

## MVP

### 集群与站点

- [ ] 多集群
- [ ] 节点组
- [ ] 区域
- [ ] 站点支持 HTTP 和 HTTPS
- [ ] 站点支持多域名（含泛域名）

### 源站

- [ ] 源站池：权重
- [ ] 源站池：备用源站
- [ ] 被动健康检查
- [ ] 回源 Host 和 SNI
- [ ] 对象存储源站鉴权

### 缓存

- [ ] 缓存规则：按后缀、路径、前缀、状态码、大小匹配
- [ ] 自定义缓存键
- [ ] 遵循或覆盖源站缓存头
- [ ] stale（过期内容兜底）
- [ ] Range 和 slice
- [ ] 刷新：URL、前缀、全量
- [ ] 预热

### 协议与证书

- [ ] ACME 自动证书
- [ ] 上传证书
- [ ] HSTS
- [ ] HTTP/2
- [ ] HTTP/3
- [ ] Gzip、Brotli、Zstd

### 访问控制与规则

- [ ] IP、CIDR 黑白名单
- [ ] 国家、省份、ASN 黑白名单
- [ ] 限速
- [ ] 重定向规则
- [ ] 改写规则
- [ ] 请求头和响应头规则

### DNS

- [ ] 接入第三方 DNS：DNSPod、阿里云、华为云、Cloudflare
- [ ] 自动下发 CNAME
- [ ] 健康检查不通过时自动摘除记录
- [ ] DNS 记录修复任务
- [ ] 节点健康检查不通过时自动下线

### 运维

- [ ] 分钟级统计：请求数、流量、带宽、命中率、状态码
- [ ] 分钟级统计：Top URL、Top IP
- [ ] 告警渠道：邮件、Webhook、钉钉、企业微信、Telegram
- [ ] 审计日志
- [ ] 开放 API

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

### 缓存与调度

- [ ] Tiered Cache / L2 回源
- [ ] Topologies（可复用的缓存层级拓扑）
- [ ] 组内一致性哈希
- [ ] 按 Cache-Tag 清缓存
- [ ] 智能调度规则
- [ ] 区域探针
- [ ] 节点租期

### 日志

- [ ] 原始日志写入 ClickHouse
- [ ] Logpush：S3、HTTP、Kafka

### 协议与优化

- [ ] TCP/UDP 四层转发（PROXY protocol）
- [ ] 图片 WebP/AVIF 转换和缩放（imgproxy）
- [ ] 103 Early Hints
- [ ] 注入 Speculation-Rules
- [ ] 自定义错误页

### 发布

- [ ] 配置金丝雀发布
- [ ] 自动回滚

### 租户

- [ ] 租户门户
- [ ] 套餐和配额
- [ ] 流量包
- [ ] 余额
- [ ] 95 计费
- [ ] 支付接口
- [ ] 实名认证
- [ ] 工单

## v2

### DNS 与三四层防护

- [ ] 自建权威 DNS/GTM（评估 PowerDNS 和 CoreDNS 方案）
- [ ] XDP/eBPF 三四层防护

### 缓存

- [ ] 共享压缩字典
- [ ] Cache Reserve（S3/MinIO 持久层）

### 边缘计算与引擎

- [ ] 边缘计算：表达式 DSL 或 Wasm 沙箱，租户脚本需要审批
- [ ] Pingora 引擎（等它的 HTTP/3 成熟之后）

### 产品模块

- [ ] 高防 IP 售卖模块
- [ ] Tunnels 内网穿透
