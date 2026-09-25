# 对标调研摘要

2026-09-24 设计会话调研了国内外 CDN 面板和开源项目，结论的主干已经写进 [BOOTSTRAP.md](../../BOOTSTRAP.md) §1。本文补记当时没写进仓库的部分，并说明每一项落在哪个阶段。原始资料（goedge.rip 文档抓取、源码摘录）是第三方内容，只保存在维护者本机，不进仓库。

## 对标对象

| 项目 | 数据面 | 自建 DNS/GTM | WAF | CC 防护 | 四层 | 分层缓存 | 边缘计算 | 授权与价格 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| FlexCDN | 自研 Go | 有，按指标调度 | 规则型，可按用户 | 5 秒盾、302 跳转、TLS 指纹 | 有，支持 TOA | L2 + 组内索引节点 | 自研脚本 | 商业授权 |
| GoEdge | 自研 Go | 商业版 | 规则型 | 有 | 有 | L2 | JS | 商业授权 |
| CDNFly v6 | OpenResty + C WAF | 仅接第三方 | 语义引擎，CVE 规则订阅 | 多级挑战、JA4、自动升级 | 有 | L2 | — | 商业授权 |
| LeCDN | OpenResty + 自研四层 | 多级备用 IP | 规则型 | URL 级验证码 | 有，重载不断连 | 规划中 | — | 商业授权 |
| Apache Traffic Control | ATS | Traffic Router | — | — | — | Topologies | — | Apache-2.0，已退役 |
| Cloudflare | — | 有 | 托管规则 + 表达式 | Bot 管理 | Spectrum | Tiered Cache | Workers | SaaS |

Edgeweir 的定位：开源（AGPL-3.0）、自托管、无授权校验，数据面用 OpenResty，控制面单镜像部署；在可验证的信任（签名发布、mTLS、不存 SSH 凭据）和现代化工具链上做出差异。

## 调研发现的缺口与去向

### 已补进 MVP（[mvp.md](../specs/mvp.md) 中标「对标补充」）

| 缺口 | 来源 | 里程碑 |
| --- | --- | --- |
| 缓存键按 Cookie、设备类型、Host 区分，查询参数排序 | Cloudflare 缓存规则 | M2 |
| 回源连接池与超时、WebSocket 透传 | Cloudflare、GoEdge 站点设置 | M2 |
| 证书寿命变短（64 / 45 / 6 天）、ZeroSSL | Let's Encrypt 公告、国内面板 | M3 |
| 最低 TLS 版本、OCSP stapling、密码套件档位 | GoEdge TLS 设置 | M3 |
| 平台级 IP 名单、自定义 WAF 规则、配置规则 | GoEdge、Cloudflare | M4 |
| 域名所有权校验（防抢注和泛域名劫持） | CDNFly 规划 | M5 |
| DNS 与节点配置分开发布 | ATC 两阶段发布 | M5 |
| 节点自升级、访问日志采样 | BOOTSTRAP §2 节点职责 | M6 |
| AccessKey 吊销与只读范围、性能基线、备份恢复 | 调研的非功能对比 | M6 |

### 留在 v1 / v2（已写入 [ROADMAP.md](../../ROADMAP.md)）

- 站点功能：CORS、HLS 加密、访客 IP 来源、按站点请求和流量限制、网站分组、域名正则和 IDN 匹配、批量重定向、规则版本与回滚。
- 协议与证书：0-RTT、回源与访客双向 mTLS、Origin CA、证书透明度监控、ECH。
- 缓存与调度：组内缓存索引节点、源站主动健康检查、会话保持、按延迟选父节点。
- 安全：IP 灰名单、nftables 连接数与新建速率限制、管理后台登录 IP 白名单、域名黑名单与内容关键词监控、七层 DDoS 自动缓解、Bot 评分。
- 可观测：访问日志检索与导出（ClickHouse）、攻击大盘、回源质量、RUM、短信告警渠道。
- 运营：优惠券、邀请码、短信、微信支付、白标、自助注册、欠费停用。
- 节点：CLI 诊断（连接、pprof、本地日志）、时钟偏差告警、节点日志页。

### 需要维护者决定（写在 PROGRESS「待决策」）

- 按集群的长期注册 token（国内面板常见）与"一次性 token"原则冲突。
- 批量 SSH 安装节点与"绝不存 SSH 凭据"原则冲突。
- DNSLA、51dns 等服务商是否有可用的 libdns 实现。
- License 维持 AGPL-3.0 还是改 Apache-2.0。

## 非功能参考值

竞品公开的数据只作参考，不作承诺：单节点缓存吞吐可达十几 Gbps、亿级缓存对象；挑战页单机十万级 QPS；日志单节点每秒十万行以上；面板支持百万级站点。M6 的 `scripts/bench.sh` 先建立 Edgeweir 自己的基线，再据此定目标。
