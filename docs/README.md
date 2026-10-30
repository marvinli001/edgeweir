# Edgeweir 开源版

单一运营者的自托管 CDN、WAF 与边缘调度控制平面：控制台、API 与边缘节点。

| 组件 | 交付 | 职责 |
| --- | --- | --- |
| 控制台 | 镜像 `ghcr.io/marvinli001/edgeweir`（linux/amd64、linux/arm64） | Web UI 与 `/api/v1`（:3000）、节点通道（:8443）、pg-boss worker、`edgeweir-certd` |
| PostgreSQL 18 | 外部依赖 | 全部状态、任务队列、配置变更广播 |
| ClickHouse | 可选 | 原始访问日志与分钟级统计 |
| 边缘节点 | [edgeweir-node](https://github.com/marvinli001/edgeweir-node)：deb、rpm、二进制包、容器镜像 | Go Agent 经 mTLS 同步配置；OpenResty 代理、缓存、回源与防护 |

## 文档

| 分组 | 页面 |
| --- | --- |
| 入门 | [核心概念](guide/concepts.md) · [快速上手](guide/first-site.md) |
| 部署 | [部署概览](deploy/README.md) · [Docker Compose](deploy/docker.md) · [宝塔面板 / aaPanel](deploy/baota.md) · [deploy.sh 参考](deploy/deploy-script.md) · [Railway](deploy/railway.md) · [Fly.io](deploy/fly.md) · [bunny.net Magic Containers](deploy/bunny.md) · [Render](deploy/render.md) · [Zeabur](deploy/zeabur.md) · [端口、反向代理与可信代理](deploy/networking.md) |
| 站点 | [概览](guide/overview.md) · [网站管理](guide/site-management.md) · [域名与未知域名](guide/domains.md) · [源站与缓存](guide/origins-and-cache.md) · [图片格式转换](guide/image-convert.md) · [面向代理的 Markdown](guide/markdown-agents.md) · [HTTPS 与证书](guide/https.md) · [错误页](guide/error-pages.md) · [L4 转发](guide/l4.md) · [用量保护](guide/usage-protection.md) · [统计与访问日志](guide/access-logs.md) |
| 访问控制 | [规则、IP 名单与 GeoIP](guide/rules.md) · [访问控制](guide/access-control.md) · [封禁](guide/bans.md) · [挑战与 CC 防护](guide/challenges.md) · [OWASP CRS 托管规则](guide/waf.md) · [攻击与自动缓解](guide/attack-dashboard.md) |
| 基础设施 | [集群与节点](guide/clusters.md) · [区域探针与智能调度](guide/scheduling.md) · [DNS 调度](guide/dns.md) |
| 系统 | [账户与登录](guide/account.md) · [告警](guide/alerts.md) · [系统设置与审计](guide/system.md) |
| 节点 | [节点概览](node/README.md) · [接入节点](deploy/nodes.md) · [节点配置](node/configuration.md) · [节点升级](guide/node-upgrades.md) · [节点日志](guide/node-logs.md) · [节点运维](node/operations.md) · [节点排障](node/troubleshooting.md) |
| 运维 | [版本与升级](deploy/upgrade.md) · [降级](deploy/downgrade.md) · [备份与恢复](deploy/backup.md) · [维护](deploy/maintenance.md) · [故障排查](deploy/troubleshooting.md) |
| 参考 | [API 概览](reference/api.md) · [API：网站](reference/api/sites.md) · [API：访问控制](reference/api/security.md) · [API：证书](reference/api/certificates.md) · [API：集群与节点](reference/api/clusters.md) · [API：DNS 与调度](reference/api/dns.md) · [API：概览、统计与告警](reference/api/monitoring.md) · [API：系统与账户](reference/api/system.md) · [环境变量](reference/environment.md) · [命令行](reference/cli.md) · [错误码](reference/errors.md) |
| 项目 | [架构](../ARCHITECTURE.md) · [安全策略](../SECURITY.md) · [开发与贡献](../CONTRIBUTING.md) · [许可证](../LICENSING.md) |
