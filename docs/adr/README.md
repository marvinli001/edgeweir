# 架构决策记录（ADR）

本目录记录 Edgeweir 的架构决策。每篇 ADR 说明一个决策的背景、结论、放弃的备选方案、后果和落地情况。Phase 0 的 18 篇 ADR 与 [BOOTSTRAP.md](../../BOOTSTRAP.md) §2 的决策逐条对应。

本目录是 ADR 的唯一来源；edgeweir-node 仓库的 `docs/adr` 是它的镜像（由该仓库的 `scripts/sync-adr.sh` 生成，只把指向控制面仓库文件的相对链接改写为 GitHub 链接）。修改 ADR 请在这里提交，再在节点仓库运行同步脚本。

ADR 编号在 edgeweir 与 edgeweir-node 两个仓库之间统一，"适用仓库"一列说明该决策约束哪个仓库。

## 索引

| 编号 | 标题 | 状态 | 适用仓库 |
| --- | --- | --- | --- |
| [ADR-0001](0001-monolithic-console-and-toolchain.md) | 单体全栈控制面与工具链 | 已接受 | edgeweir |
| [ADR-0002](0002-web-vite-react-spa-hono.md) | Web 前端：Vite + React 19 SPA，由 Hono 托管 | 已接受 | edgeweir |
| [ADR-0003](0003-ui-shadcn-preset.md) | UI：shadcn preset b2D0wqNxT，appica-ui 只作补充 | 已接受 | edgeweir |
| [ADR-0004](0004-i18n-paraglide.md) | 国际化：Paraglide JS 2 | 已接受 | edgeweir |
| [ADR-0005](0005-api-orpc-openapi.md) | API：oRPC 契约优先，同时服务 UI 与 OpenAPI | 已接受 | edgeweir |
| [ADR-0006](0006-data-postgresql-drizzle-pgboss.md) | 数据层：PostgreSQL 18 + Drizzle + pg-boss | 已接受 | edgeweir |
| [ADR-0007](0007-auth-better-auth-multitenancy.md) | 认证与多租户：better-auth | 已接受 | edgeweir |
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

## 状态说明

| 状态 | 含义 |
| --- | --- |
| 提议 | 在 PR 中讨论，尚未生效 |
| 已接受 | 生效，代码必须遵守 |
| 已废弃 | 不再适用，且没有替代决策 |
| 已被 ADR-NNNN 取代 | 由新的 ADR 取代，正文保留作历史记录 |

## 什么时候需要写 ADR

- 引入新的外部依赖：数据库、运行时组件、队列、关键库。
- 改变进程、端口、镜像或部署形态。
- 改变节点通道协议、proto 包版本或 NodeConfig IR 的语义。
- 影响 [ADR-0018](0018-trust-and-security-baseline.md) 规定的信任与安全基线。

## 新增流程

1. 复制 [template.md](template.md) 为 `NNNN-slug.md`：`NNNN` 取两个仓库中现有最大编号加一，`slug` 用英文小写加连字符。
2. 状态写"提议"，随 PR 提交，并在上面的索引表中加一行。
3. 评审通过后把状态改为"已接受"再合入。
4. 已接受的 ADR 不改写结论。决策变化时写一篇新 ADR，把旧 ADR 的状态改为"已被 ADR-NNNN 取代"。
5. 版本号、落地情况等事实性内容可以直接更新，并在该 ADR 的"更新记录"里注明日期和内容。
