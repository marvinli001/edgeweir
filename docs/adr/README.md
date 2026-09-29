# 架构决策记录（ADR）

Edgeweir 的架构决策记录。每篇 ADR 包含背景、决策、备选方案、后果与落地情况；Phase 0 的 18 篇 ADR 与 BOOTSTRAP §2 的决策逐条对应。

- 本目录为 ADR 唯一来源。edgeweir-node 仓库的 `docs/adr` 为其镜像，由该仓库的 `scripts/sync-adr.sh` 生成，仅将指向控制面仓库文件的相对链接改写为 GitHub 链接。
- ADR 在本仓库修改，再于 edgeweir-node 执行同步脚本。
- ADR 编号在两个仓库间统一；「适用仓库」列标明决策约束的仓库。

## 索引

| 编号 | 标题 | 状态 | 适用仓库 |
| --- | --- | --- | --- |
| [ADR-0001](0001-monolithic-console-and-toolchain.md) | 单体全栈控制面与工具链 | 已接受 | edgeweir |
| [ADR-0002](0002-web-vite-react-spa-hono.md) | Web 前端：Vite + React 19 SPA，由 Hono 托管 | 已接受 | edgeweir |
| [ADR-0003](0003-ui-shadcn-preset.md) | UI：shadcn preset b2D0wqNxT，appica-ui 只作补充 | 已接受 | edgeweir |
| [ADR-0004](0004-i18n-paraglide.md) | 国际化：Paraglide JS 2 | 已接受 | edgeweir |
| [ADR-0005](0005-api-orpc-openapi.md) | API：oRPC 契约优先，同时服务 UI 与 OpenAPI | 已接受 | edgeweir |
| [ADR-0006](0006-data-postgresql-drizzle-pgboss.md) | 数据层：PostgreSQL 18 + Drizzle + pg-boss | 已接受 | edgeweir |
| [ADR-0007](0007-auth-better-auth-multitenancy.md) | 认证与多租户：better-auth | 已接受（租户门户与自助注册归属已被 ADR-0019 取代） | edgeweir |
| [ADR-0008](0008-node-channel-connect-rpc-mtls.md) | 节点通道：Connect-RPC、内部 CA 与 mTLS | 已接受 | 两者 |
| [ADR-0009](0009-analytics-clickhouse-and-lite.md) | 分析与日志：ClickHouse 可选，lite 模式存 Postgres | 已接受 | 两者 |
| [ADR-0010](0010-certd-lego-libdns.md) | 证书与 DNS helper：edgeweir-certd（lego + libdns） | 已接受 | edgeweir |
| [ADR-0011](0011-config-model-nodeconfig-ir.md) | 配置模型：与引擎无关的 NodeConfig IR | 已接受 | 两者 |
| [ADR-0012](0012-rule-engine-expression-language.md) | 规则引擎：wirefilter 风格表达式语言 | 已接受 | 两者 |
| [ADR-0013](0013-node-go-agent-openresty.md) | 节点形态：Go agent + OpenResty | 已接受 | edgeweir-node |
| [ADR-0014](0014-node-agent-responsibilities.md) | 节点 agent 的职责与机制 | 已接受 | edgeweir-node |
| [ADR-0015](0015-openresty-build-and-cache.md) | OpenResty 构建与缓存设计 | 已接受 | edgeweir-node |
| [ADR-0016](0016-one-line-install.md) | 节点一键安装 | 已接受 | 两者 |
| [ADR-0017](0017-release-supply-chain.md) | 发布与供应链 | 已接受 | 两者 |
| [ADR-0018](0018-trust-and-security-baseline.md) | 信任与安全基线 | 已接受 | 两者 |
| [ADR-0019](0019-open-core-and-commercial-products.md) | 开源核心、租户与独立商业产品边界 | 已接受 | 两者 |

## 状态

| 状态 | 含义 |
| --- | --- |
| 提议 | 在 PR 中讨论，尚未生效 |
| 已接受 | 生效，代码必须遵守 |
| 已废弃 | 不再适用，且没有替代决策 |
| 已被 ADR-NNNN 取代 | 由新的 ADR 取代，正文保留作历史记录 |

## 适用范围

下列变更须编写 ADR：

- 引入新的外部依赖：数据库、运行时组件、队列、关键库。
- 变更进程、端口、镜像或部署形态。
- 变更节点通道协议、proto 包版本或 NodeConfig IR 语义。
- 影响 [ADR-0018](0018-trust-and-security-baseline.md) 规定的信任与安全基线。

## 流程

1. 复制 [template.md](template.md) 为 `NNNN-slug.md`：`NNNN` 取两个仓库现有最大编号加一，`slug` 使用小写英文与连字符。
2. 状态设为「提议」，随 PR 提交，并在索引表中新增一行。
3. 评审通过后将状态改为「已接受」，再合入。
4. 已接受的 ADR 不改写结论。决策变更时新建 ADR，并将原 ADR 状态改为「已被 ADR-NNNN 取代」。
5. 版本号、落地情况等事实性内容可直接更新，并在该 ADR 的「更新记录」中注明日期与内容。
