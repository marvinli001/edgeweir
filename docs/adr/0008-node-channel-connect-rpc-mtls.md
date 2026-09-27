# ADR-0008: 节点通道：Connect-RPC、内部 CA 与 mTLS

- 状态：已接受
- 日期：2026-09-25
- 适用仓库：两者

## 背景

节点与控制面之间传输配置通知、配置内容、心跳、回执和统计。要求：

- 控制面（TypeScript）和节点（Go）共享同一份强类型契约，两边都能生成代码。
- 支持服务端流，控制面能主动通知节点有新配置。
- 双向强身份：只有合法节点能拉取配置；节点能确认自己连接的是真正的控制面。
- 端口可以暴露在公网，但要避免 CDNFly 那种"主控通信端口固定且暴露"的问题：暴露的端口上，除了凭一次性 token 注册之外什么都做不了。
- 首次接入不依赖 SSH 凭据（[ADR-0016](0016-one-line-install.md)）。

## 决策

### 协议与契约

1. **Connect-RPC。** 控制面用 connect-es v2（`@connectrpc/connect-node`）实现服务端，节点用 connect-go 实现客户端。服务定义见 [`proto/edgeweir/node/v1/node.proto`](../../proto/edgeweir/node/v1/node.proto) 中的 `NodeService`：

   | RPC | 类型 | 认证 | 用途 |
   | --- | --- | --- | --- |
   | `Enroll` | unary | 一次性 token | 用 token 和 CSR 换取节点证书 |
   | `RenewCertificate` | unary | mTLS | 用新 CSR 换取新证书 |
   | `WatchConfig` | 服务端流 | mTLS | 推送最新 revision 通知与 keepalive |
   | `GetConfig` | unary | mTLS | 按 revision 获取快照或 diff |
   | `ReportStatus` | unary | mTLS | 心跳与应用回执 |
   | `ReportStats` | unary | mTLS | 上报分钟级预聚合统计 |

2. **buf 管理的 proto 是两个仓库之间唯一的契约来源。**
   - `proto/` 目录由 buf 管理：`buf lint` 使用 STANDARD 和 COMMENTS 规则，`buf breaking` 使用 FILE 规则。
   - 控制面用 `protoc-gen-es` 生成 TypeScript 到 `packages/proto`（`pnpm proto:gen`）。
   - edgeweir-node 用 buf 从本仓库的 git tag（格式 `proto/vX.Y.Z`，例如 `proto/v0.1.0`）生成 Go 代码，输入形如 `https://github.com/edgeweir/edgeweir.git#tag=proto/v0.1.0,subdir=proto`。
   - 同一个 proto 包（`edgeweir.node.v1`）内只做向后兼容的变更。需要破坏性变更时新建 `edgeweir.node.v2` 包，两个版本并存一段时间。
   - 升级顺序：先升级控制面，再升级节点。控制面必须兼容上一个 proto 版本的节点。

### 端口与 TLS

3. **节点通道单独监听**，默认 `:8443`，端口可配置。控制台进程用 Node 的 `http2.createSecureServer` 自己终结 TLS，并开启 `requestCert` 请求客户端证书。
4. **不能放在宝塔、nginx 等反向代理后面终结 TLS。** 代理终结 TLS 后，客户端证书无法以可验证的方式到达应用，mTLS 就失效了。如果必须经过 nginx，只能用 `stream` 模块做四层透传，TLS 仍由控制台终结。
5. **Web 控制台 `:3000` 是普通 HTTP**，可以放在反向代理后面，由代理终结 TLS。

### 内部 CA

6. 首次启动时生成 **ECDSA P-256** 的 CA 私钥和自签 CA 证书。CA 私钥用主密钥 `EDGEWEIR_MASTER_KEY` 信封加密后存入数据库（[ADR-0018](0018-trust-and-security-baseline.md)），多个控制台实例共享同一个 CA。CA 证书有效期为多年。
7. `:8443` 的服务端证书也由这个 CA 签发，SAN 包含节点用来连接控制面的域名或 IP（由配置提供）。

### 注册流程（Enroll）

8. **生成安装命令**：管理员在控制台为某个集群生成安装命令。控制台创建一条 `enrollment_token` 记录：
   - 数据库只存 token 的 SHA-256 哈希，明文 token 只在生成时显示一次。
   - token 带过期时间，只能使用一次。
9. **CA 指纹固定**：安装命令携带 token 和 CA 证书的 SHA-256 指纹（`--ca-sha256`，对 DER 编码的 CA 证书计算，小写十六进制），思路与 kubeadm 的 `--discovery-token-ca-cert-hash` 相同。
10. **先验证，后发 token**：节点连接 `:8443`，先确认服务端证书链由指纹匹配的 CA 签发。不匹配立即中止，token 不会发出。即使首次连接被中间人劫持，token 也不会泄露。
11. **私钥不出节点**：节点本地生成 ECDSA P-256 私钥和 CSR，调用 `Enroll(token, csr_pem, info)`。
12. **签发**：控制面在一个事务内完成以下步骤：按哈希查找 token，校验未使用且未过期，标记为已使用，创建 `node` 记录，签发客户端证书。证书主题由控制面决定，**CN = 新建的 node id**（节点注册前不知道自己的 id），CSR 只提供公钥，签名须能通过校验。证书有效期 **30 天**，扩展用途仅限 clientAuth。
13. 节点保存私钥和证书（文件权限 0600），此后所有调用都走 mTLS。

### 认证规则

14. **除 `Enroll` 外，所有 RPC 强制 mTLS。** TLS 层允许不带证书的连接（否则 `Enroll` 无法调用），由服务端拦截器按方法检查：
    - 客户端证书由内部 CA 签发，且在有效期内；
    - CN 对应的节点在数据库中存在，且未被禁用或删除。
15. **吊销通过数据库状态实现**：删除或禁用节点后，它的下一次调用立即被拒绝，不依赖 CRL 或 OCSP。

### 证书轮换

16. 证书有效期 30 天，通过 `RenewCertificate` 自动轮换：剩余有效期低于阈值时，或 `ReportStatusResponse.renew_certificate` 为 true 时，节点本地生成新密钥和 CSR，通过现有 mTLS 连接调用 `RenewCertificate`。控制面忽略 CSR 中的主题，按调用者证书的 node id 签发新证书。
17. 节点离线超过证书有效期后，需要用新 token 重新注册。

### 配置通知

18. `WatchConfig` 的第一条消息总是当前最新的 revision，之后在新 revision 发布时推送（多实例之间经 LISTEN/NOTIFY 转发，见 [ADR-0006](0006-data-postgresql-drizzle-pgboss.md)），并定期发送 keepalive。流不可用时，节点用 `GetConfig` 轮询兜底（[ADR-0014](0014-node-agent-responsibilities.md)）。

## 备选方案与取舍

- **gRPC（grpc-js、grpc-go）**：可行。Connect 的服务端同时支持 Connect、gRPC、gRPC-Web 三种协议，可以用 curl 调试；在 Node 上以普通 HTTP handler 的形式挂载，不需要单独的 gRPC 服务器实现；connect-go 与 grpc-go 互通。
- **复用 oRPC 或 JSON over HTTPS**：Go 端没有代码生成，类型要手写两遍；配置内容哈希需要确定性的二进制编码（[ADR-0011](0011-config-model-nodeconfig-ir.md)），protobuf 更合适。
- **WebSocket 自定义协议**：没有 schema，重连、流控、错误码都要自己设计。
- **MQTT、NATS 等消息中间件**：多一个组件要部署和保护。
- **放在反向代理后面，由代理终结 TLS，再用请求头转发客户端证书**：请求头可以伪造，安全性完全取决于代理配置是否正确，宝塔等面板的默认配置无法保证这一点。
- **用公共 CA（ACME）签发节点通道证书**：节点经常通过 IP 连接控制面，内部 CA 加指纹固定更简单，也不依赖外部 CA 的可用性。
- **TOFU（首次连接时信任服务端证书）**：首次连接可以被中间人攻击。指纹固定消除了这个窗口。
- **长期有效的节点证书加 CRL**：吊销信息的分发和缓存很复杂。短有效期加数据库状态检查更简单，也更及时。

## 后果

### 正面

- 暴露在公网的 `:8443` 上，没有有效 token 或有效证书就调用不了任何东西。
- 节点私钥从不离开节点，控制面数据库泄露也拿不到节点身份。
- 契约由 buf 管理，lint 和 breaking 检查可以放进 CI。

### 负面

- `:8443` 不能交给宝塔 nginx 做 TLS 终结，部署文档必须讲清楚：直接暴露，或用 `stream` 透传。
- 经 `stream` 透传时，控制面看到的源地址是代理的地址。需要真实节点 IP 时，后续要支持 PROXY protocol。
- CA 轮换需要重新分发指纹，并给所有节点重签证书，需要单独设计。
- 节点离线超过 30 天就要重新注册。
- 两个仓库通过 git tag 共享 proto，节点仓库升级 proto 需要显式修改 tag。

## Phase 0 落地情况

Phase 0 范围：

- proto v0：`NodeService` 的六个 RPC 与 `NodeConfig` IR。
- 内部 CA、`Enroll`、`RenewCertificate`、除 `Enroll` 外强制 mTLS。
- 安装命令携带一次性 token 与 `--ca-sha256`。
- `WatchConfig` 推送与 keepalive。
- 端到端测试覆盖注册和 mTLS。

后续：

- 节点通道支持 PROXY protocol。
- CA 轮换流程。
- `Enroll` 失败次数按来源 IP 限流。
- proto 的 `buf breaking` 检查进入 CI（对比上一个 `proto/v*` tag）。

## 版本核实

核实日期：2026-09-25。来源：npm registry、proxy.golang.org、nodejs.org。

| 组件 | 版本 | 来源 |
| --- | --- | --- |
| @connectrpc/connect | 2.2.0 | npm registry |
| @connectrpc/connect-node | 2.2.0 | npm registry |
| @bufbuild/protobuf | 2.15.0 | npm registry |
| @bufbuild/protoc-gen-es | 2.15.0 | npm registry |
| buf | 1.73.0 | proxy.golang.org（github.com/bufbuild/buf） |
| connectrpc.com/connect | v1.21.0 | proxy.golang.org |
| google.golang.org/protobuf | v1.36.12 | proxy.golang.org |
| Go | 1.27.1 | proxy.golang.org（golang.org/toolchain） |
| Node.js | 24.21.0 LTS | nodejs.org |

> 更新记录：
> - 2026-09-25：proto v0（tag `proto/v0.1.0`）在 BOOTSTRAP 列出的 5 个 RPC 之外增加了 `RenewCertificate`，用于证书自动轮换。控制台记录每个节点当前证书的序列号，轮换后旧证书立即失效；`ReportStatus` 在剩余有效期不足 1/3 时返回 `renew_certificate`。服务端用 `node:http2` 的 `createSecureServer({ requestCert: true, rejectUnauthorized: false })`，在 Connect 的 `contextValues` 中读取已验证的对端证书。
> - 2026-09-25（MVP M1）：节点可以停用、启用和删除。停用的节点每次 RPC 都返回 `permission_denied`，已打开的 WatchConfig 流在下一次唤醒（最多 15 秒的 keepalive）时结束；agent 按原有逻辑继续用 last-known-good 配置服务。删除节点时把证书序列号写入 `node_certificate_revocation`，通道在查节点之前先拒绝已吊销的序列号（`unauthenticated`，"certificate has been revoked"），节点只能用新的注册 token 重新注册。节点组只在控制面使用，不进入 proto，节点在同一集群的节点组之间移动不影响配置版本。
> - 2026-09-25（MVP M2，proto `v0.2.0`）：`NodeService` 增加三个 RPC，全部要求 mTLS。`GetOriginCredentials(ids)` 只返回节点所在集群的站点引用的源站凭据（S3 密钥），密钥在库中信封加密，只经本通道下发，不进入 `NodeConfig`。`PullTasks` / `ReportTaskResult` 是类型化节点任务（刷新、预热）的通道：控制台在任务创建时 `pg_notify(edgeweir_tasks)`，WatchConfig 流对相关集群的节点发出新增的 `WATCH_EVENT_TASKS`，`ReportStatusResponse.tasks_pending` 作为漏掉通知时的兜底，节点另有 30 秒轮询；任务交出后 5 分钟没有结果会再次交出（任务幂等），7 天仍未完成的交付记为失败。`ReportStatusRequest` 增加 `origin_health`（节点上最近失败过的源站），控制台按节点整体替换。所有改动都是新增字段、枚举值和 RPC，`buf breaking` 对 `v0.1.0` 通过；旧 agent 忽略未知事件和字段。
> - 2026-09-25（收尾，proto `v0.2.1`、`v0.2.2`）：
>   - `v0.2.1` 只加字段：`NodeConfig.origin_allowed_cidrs`（8）与 `NodeConfigDiff.origin_allowed_cidrs`（10，diff 总是带目标版本的完整清单）；`CacheRule.cache_authorized`（9）；`OriginHealth.last_error_code`（8）与 `last_error_params`（9）；`ReportTaskResultRequest.error_code`（7）与 `error_params`（8）。`buf breaking` 对 `v0.2.0` 通过，旧 agent 忽略这些字段、行为与 `v0.2.0` 相同。`v0.2.2` 只改注释，列出节点实际上报的错误码。两个 `map<string, string>` 参数字段在 `node.proto` 的 RPC 消息里，不在 `NodeConfig` 中，[ADR-0011](0011-config-model-nodeconfig-ir.md) 决策第 8 条"IR 不用 map"不受影响。
>   - 错误码：源站健康 `connect_failed`、`timeout`、`upstream_status {status}`、`dns_failed {host}`、`address_forbidden {address}`、`tls_failed`；任务结果 `prefetch_failed {failed, total, url, reason, status}`、`prefetch_timeout {done, total}`、`task_unsupported {type}`、`purge_failed`。文本字段（`last_error`、`message`）照常填写；控制台把码和参数存进 `origin_health`、`cache_task_node`（迁移 `0005_wrapup_console`），界面按码本地化，不认识的码回退到节点原文。控制台自己记录的任务结果也用码：`task_expired`（7 天内未执行）、`node_disabled`（节点停用，交付记为 `skipped`）。
>   - 任务只交给启用的节点：创建任务时停用的节点记为 `skipped`，停用节点时它未完成的交付同样记为 `skipped`，不计入任务进度。
>   - 错过的清缓存用整站刷新补上（N-M4）：节点拉取任务时，控制台先找出它错过的清缓存（7 天内未执行而过期，或因停用被跳过，且还没补过），对涉及的每个仍在该集群的网站生成一次整站刷新（每个组织一个任务，只发给这个节点，`source = recovery`，写系统审计，不计入组织的频率限制），并把原交付标记 `recovered_at`，只补一次。有待补的刷新时 `ReportStatusResponse.tasks_pending` 为 true。
>   - 清缓存时间点由节点分配（N-M3，[ADR-0014](0014-node-agent-responsibilities.md) 收尾记录），`NodeTask.created_at` 不再用作清缓存时间点；`node.proto` 里"purge tasks use it as the purge epoch"的注释是旧说法，下次改 proto 时更正。
>   - `ReportStats` 每次上报只用一条 SQL：同一分钟、同一网站的桶先合并，整批作为一个 JSON 参数传入，不属于该节点集群的网站被 join 过滤，已有行累加；每次最多接受 5000 个桶。重试时的重复计数没有解决（归 M5，见 [mvp.md](../../docs/specs/mvp.md) 第 5 节）。

> 更新记录（2026-09-27，MVP M3）：proto `v0.3.0` 新增 `NodeInfo.supported_features`、`NodeConfig.required_features` 和证书材料 RPC。控制面拒绝给缺少能力的节点下发该版本；节点拒绝未知能力与枚举，继续使用 last-known-good。`GetCertificates` 只下发集群当前目标配置引用的 ID/指纹，不通过历史引用授予新私钥访问权。

## 2026-09-27 M5 更新

- proto/v0.5.0 新增独立 `ReportStatsV2` 消息、单调批次序号及 Top URL/IP。空 V2 批次读取永久游标，统计与游标同事务提交；旧未编号批次被拒绝。
- 新节点在旧控制面上得到未实现 V2 的响应，保持未发送数据在有界队列中，不回退到可能重复计数的旧 RPC。

> - 2026-09-27（MVP M6）：proto/v0.7.0 增加 UpgradeTask 和配置版本回执。签名升级仅向具备 self-upgrade-v1 的节点派发，普通配置仍按 required_features 协商。回执只在 mTLS 节点通道传递，不授权任何其他 API；恢复旧数据库时，用回执证明领先版本确由原控制台签发。
