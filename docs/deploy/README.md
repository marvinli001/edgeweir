# 部署概览

控制台的组件、镜像 tag、运行要求、支持的平台、节点通道接入方式与进程角色。

## 组件

| 组件 | 说明 | 必需 |
| --- | --- | --- |
| 控制台镜像 `ghcr.io/marvinli001/edgeweir` | linux/amd64、linux/arm64。一个 Node.js 进程：Web UI 与 API（`:3000`）、节点通道（`:8443`）、pg-boss worker；内含 `edgeweir-certd`（ACME 与 DNS 记录）。 | 是 |
| PostgreSQL 18 | 唯一外部依赖。保存全部状态、pg-boss 队列、认证限速计数；LISTEN/NOTIFY 在实例间广播配置变更。 | 是 |
| ClickHouse | 原始访问日志与分钟级统计，`EDGEWEIR_ANALYTICS=clickhouse` 时启用，见 [访问日志与 AccessKey](../guide/access-logs.md)。 | 否 |
| 边缘节点 | [edgeweir-node](https://github.com/marvinli001/edgeweir-node)，部署在独立主机，见 [接入节点](nodes.md)。 | — |

## 镜像 tag

| tag | 来源 | 用途 |
| --- | --- | --- |
| `<YYYYMMDD>-<commit>` | master 上 CI 通过的每个提交，由 `release.yml` 构建发布；`<commit>` 为 7 位提交号 | 生产环境固定此 tag |
| `stable` | 维护者手动运行 `promote.yml`，指向一个已发布日期 tag 的 digest；不重新构建 | 各编排文件与平台模板的默认值 |
| `latest` | master 最新提交的日期 tag | 评估环境 |

每个镜像包含 linux/amd64 与 linux/arm64，带 cosign keyless 签名、SBOM 与构建来源证明。固定版本、签名校验与升级见 [版本与升级](upgrade.md)，回退见 [降级](downgrade.md)。

## 运行要求

| 项目 | 要求 | 约束 |
| --- | --- | --- |
| 进程 | 常驻运行 | 缩容到零或按请求冻结会停止 worker 与节点长连接，见 [进程角色](#进程角色)。 |
| PostgreSQL | 18；控制台所用账号拥有目标库的 `CREATE` 权限（schema `drizzle`、`pgboss`）与 schema `public` 的 `CREATE` 权限 | 更低版本未经验证。迁移在启动时执行。 |
| 3000/TCP | HTTP：Web UI、`/rpc`、`/api/v1`、`/healthz`、`/install.sh`、`/downloads/*`；节点通道的 WebSocket 入口 `/node-channel`（默认关闭） | 可由反向代理终结 TLS，见 [端口与反向代理](networking.md)。 |
| 8443/TCP | 节点通道（节点与区域探针）：TLS 由控制台终结，注册后强制 mTLS | 公网可达，只能直连或四层透传；或节点经 3000 上的 [WebSocket 入口](networking.md#节点通道的-websocket-入口) 连接，8443 不对外。 |
| 主密钥 | `EDGEWEIR_MASTER_KEY`：base64，解码后不少于 32 字节；`openssl rand -base64 32` 生成 | 与数据库备份分开保存；丢失后已加密数据不可解密，更换按[轮换主密钥](docker.md#轮换主密钥)进行。 |
| 会话密钥 | `BETTER_AUTH_SECRET`：未设置时由主密钥派生 | 已设置的部署须保留原值，移除后控制台拒绝启动。 |
| 架构 | linux/amd64、linux/arm64 | — |
| 资源 | 未规定最低规格 | `compose.yml` 为 ClickHouse 设置 `nofile` 262144。 |

## 支持的平台

| 平台 | 方式 | 节点通道接入 | 文档 |
| --- | --- | --- | --- |
| Docker Compose | `compose.yml`：控制台与内置 PostgreSQL 18；可选 ClickHouse（`analytics` profile） | 8443 直连；nginx `stream` 四层透传；WebSocket 入口 | [Docker Compose](docker.md) |
| docker run | 专用 Docker 网络上的控制台与 PostgreSQL 容器 | 8443 直连；nginx `stream` 四层透传；WebSocket 入口 | [Docker Compose：不用 Compose：单独的容器](docker.md#不用-compose单独的容器) |
| 宝塔 / aaPanel，或任意 Docker 主机 | `deploy.sh` 与 `compose.baota.yml`（内置 PostgreSQL，Docker 网桥）或 `compose.baota-host.yml`（本机或云 PostgreSQL，host 网络） | 8443 直连；面板 nginx `stream` 四层透传 | [宝塔面板 / aaPanel](baota.md)、[deploy.sh 参考](deploy-script.md) |
| Railway | 控制台镜像与 Railway PostgreSQL 18；网页控制台，可选 Railway CLI | 四层透传：Railway TCP Proxy → 容器 8443 | [Railway](railway.md) |
| Fly.io | 控制台镜像与外部 PostgreSQL 18；`fly.toml` 与 flyctl 部署，Dashboard 管理 secret、证书与日志 | 四层透传：Fly Proxy 在独享 IPv4 / IPv6 的 8443 按 TCP 转发 | [Fly.io](fly.md) |
| bunny.net Magic Containers | 控制台镜像与外部 PostgreSQL 18；CDN 端点承载 Web；Dashboard，可选 bunny CLI | 四层透传：Anycast IPv4 的 8443 → 容器 8443 | [bunny.net Magic Containers](bunny.md) |
| Render | `render.yaml` Blueprint 一键创建控制台与 Render Postgres 18，或 Dashboard 手动创建 | WebSocket 入口 | [Render](render.md) |
| Zeabur | `zeabur.yaml` 模板（`5MQJR2`）一键创建控制台与 PostgreSQL 18，或 Dashboard 手动创建；运行在 Zeabur Server | WebSocket 入口（默认）；四层透传：TCP 端口转发 → 容器 8443 | [Zeabur](zeabur.md) |

### 节点通道接入方式

| 方式 | 节点通道地址 | 条件 |
| --- | --- | --- |
| 8443 直连 | `https://<主机>:8443` | 8443/TCP 公网可达，防火墙与安全组放行 |
| 四层透传 | `https://<代理主机>:<端口>` | 代理按 TCP 转发，不终结 TLS：nginx `stream`、平台 TCP 代理；见 [节点通道四层透传](networking.md#节点通道四层透传) |
| WebSocket 入口 | `wss://<EDGEWEIR_PUBLIC_URL 的主机[:端口]>` | Web 端口的 HTTP 入口转发 WebSocket 升级；edgeweir-node 0.2.0 及以上；见 [节点通道的 WebSocket 入口](networking.md#节点通道的-websocket-入口) |

三种方式中节点通道的 TLS 均由控制台终结，注册后强制 mTLS。地址在 **系统设置** 的「节点通道」中修改，见 [节点通道地址与证书](networking.md#节点通道地址与证书)。

### 平台条件

未列出的平台须同时满足下表条件。

| 条件 | 说明 | 不满足时 |
| --- | --- | --- |
| 常驻进程 | 进程持续运行，不因无流量缩容到零 | worker 的证书续期与定时任务、LISTEN/NOTIFY 事件总线、节点 `WatchConfig` 长连接中断。 |
| 公网 TCP 端口或 WebSocket | 节点通道端口以原始 TCP 暴露，平台不终结 TLS；或平台的 HTTP 入口转发 WebSocket，节点经 [WebSocket 入口](networking.md#节点通道的-websocket-入口) 连接 | 节点注册失败（`CA pin mismatch`），mTLS 无法建立。 |
| PostgreSQL 18 | 控制台可达，满足上文权限 | 控制台等待 60 秒后退出。 |
| 持久密钥 | `EDGEWEIR_MASTER_KEY`（及已设置的 `BETTER_AUTH_SECRET`）在重启与重新部署间不变 | 已加密数据不可解密；控制台拒绝启动。 |
| 可信代理地址 | 3000 直接接收客户端连接，或平台代理的来源地址固定，可写入 `EDGEWEIR_TRUSTED_PROXIES` | 审计日志与登录限速只能取到代理地址。 |

## 进程角色

同一镜像由 `ROLE` 选择运行内容。

| `ROLE` | 运行内容 | 监听 | 容器健康检查 |
| --- | --- | --- | --- |
| `all`（默认） | `app` 与 `worker` 的全部内容 | 3000、8443 | `GET /healthz` |
| `app` | Web UI、`/rpc`、`/api/v1`、节点通道、setup token 输出、LISTEN/NOTIFY 订阅 | 3000、8443 | `GET /healthz` |
| `worker` | pg-boss 队列与定时任务 | 无 | 仅检查进程存活 |

每个角色启动时都执行数据库迁移。

worker 定时任务：

| 周期 | 任务 |
| --- | --- |
| 每 10 秒 | 探针判定的地址可达性与智能调度规则求值（同一时间只有一个进程） |
| 每分钟 | 告警检查；自动缓解求值；配置金丝雀推进；DNS 同步；流量统计、用量保护、访问日志汇总与节点升级超时处理；证书签发与续期 |
| 每 10 分钟 | 删除过期封禁；删除超出保留期或条数上限的节点日志 |
| 每 30 分钟 | 删除过期或使用超过 7 天的注册 token |
| 每小时 | 轮换挑战密钥（满 1 天）与 TLS 会话票据密钥（满 12 小时）；到期前 30 天更换回源客户端证书；清理旧配置版本、安全事件、幂等键；过期未送达的刷新预热任务 |
| 启动时 | 升级改变了配置的编译结果时，为每个集群重新发布一次配置（原因「升级后重新编译配置」）；标记节点无法加载的证书；关联 ACME 账户 |

### 扩展

- 多个 `app` 实例与一个或多个 `worker` 实例共享同一 PostgreSQL。
- 迁移由 PostgreSQL advisory lock 串行执行，多实例同时启动安全。
- 认证接口限速计数保存在 PostgreSQL，所有实例共享，重启不清零。
- 节点通道 CA 保存在数据库，每个 `app` 实例用同一 CA 签发服务端证书；8443 可由四层负载均衡分发到多个 `app` 实例。
- 所有实例使用同一镜像 tag，并同时升级，见 [升级](upgrade.md)。

## 部署文档

| 文档 | 内容 |
| --- | --- |
| [Docker Compose](docker.md) | Compose 与 `docker run` 部署 |
| [宝塔面板 / aaPanel](baota.md) | 面板部署、nginx 站点、stream 透传 |
| [deploy.sh 参考](deploy-script.md) | 安装与升级脚本 |
| [Railway](railway.md) | 网页控制台部署与命令行等效操作 |
| [Fly.io](fly.md) | flyctl 部署与 Dashboard 操作 |
| [bunny.net Magic Containers](bunny.md) | Dashboard 部署与 bunny CLI 等效操作 |
| [Render](render.md) | Deploy to Render 一键创建、Dashboard 手动创建与 Render CLI |
| [Zeabur](zeabur.md) | 模板一键创建、Dashboard 手动创建与 Zeabur CLI |
| [端口、反向代理与可信代理](networking.md) | 3000 与 8443、nginx 示例、节点通道的 WebSocket 入口、`EDGEWEIR_TRUSTED_PROXIES` |
| [接入节点](nodes.md) | 安装命令、`install.sh` 校验、区域探针、下载镜像 |
| [版本与升级](upgrade.md) | 版本与渠道、固定版本、签名校验、升级步骤、节点兼容 |
| [降级](downgrade.md) | 回退到较早版本 |
| [备份与恢复](backup.md) | 数据库与主密钥备份、恢复验收 |
| [环境变量](../reference/environment.md) | 全部变量与默认值 |
