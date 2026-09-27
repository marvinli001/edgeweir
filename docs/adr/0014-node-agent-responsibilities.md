# ADR-0014: 节点 agent 的职责与机制

- 状态：已接受
- 日期：2026-09-25
- 适用仓库：edgeweir-node

## 背景

[ADR-0013](0013-node-go-agent-openresty.md) 确定了 Go agent 加 OpenResty 的节点形态。本 ADR 规定 agent 的职责边界，以及每项职责的实现机制。设计依据来自调研：

- GoEdge 的配置同步采用"流式推送提示 + 轮询兜底"。
- Apache Traffic Control 的节点端流程是"拉取、比较、备份，再区分 reload 与 restart"。
- GoEdge 控制面保存节点 SSH root 凭据，2025 年的 RingH23 攻击借此横向投毒边缘节点。agent 的设计要保证控制面失陷时，攻击者也不能借 agent 在节点上执行任意代码。

## 决策

### 注册

1. 一次性 token → 本地生成 ECDSA P-256 私钥和 CSR → 控制面内部 CA 签发节点证书 → 之后全程 mTLS，证书自动轮换。细节见 [ADR-0008](0008-node-channel-connect-rpc-mtls.md)。
2. 私钥和证书存放在 agent 的数据目录，文件权限 0600。

### 同步

3. **主通道**：`WatchConfig` 服务端流。收到比本地新的 revision 通知后调用 `GetConfig`。
4. **兜底**：流不可用时按固定间隔轮询 `GetConfig`，间隔带随机抖动，避免大量节点同时请求；流恢复后停止轮询。
5. **last-known-good**：只在应用成功后写入，先写临时文件再原子重命名。agent 启动时先用 last-known-good 恢复数据面，再连接控制面。
6. **控制面宕机时节点照常服务**，按 last-known-good 继续工作；控制面恢复后自动追上最新 revision。

### 重载

7. 只有结构性变更（`listeners`、`cache_zones`，以及将来的全局参数）才重新渲染 nginx.conf。
8. 流程：渲染到临时文件 → `nginx -t` 校验 → 原子替换 → 向 nginx master 发送 HUP 平滑重载。校验失败时保留旧配置，通过 `ReportStatus` 回报 `FAILED` 和 `nginx -t` 的输出。
9. 站点、证书、IP 名单等变更不触发 reload。

### 热更新

10. **通道**：站点、路由、上游、证书、IP 名单通过本地 unix socket 推给 OpenResty。nginx 在 unix socket 上开一个只供本机访问的控制 server，由 Lua 处理 agent 的写入请求。
11. **MVP 存储：`lua_shared_dict`**（所有 worker 共享）。nginx 完全重启后 shared dict 会清空，agent 检测到后重新灌入全部数据。
12. **worker 内缓存**：每个 worker 用 lua-resty-lrucache 缓存反序列化后的对象，并记录数据版本号。处理请求时比较 shared dict 中的版本号，变化了就失效重建。
13. **之后**：有了自定义构建（[ADR-0015](0015-openresty-build-and-cache.md)）后评估 lua-resty-lmdb。数据持久化在磁盘，nginx 重启不丢失，容量也不受 shared dict 大小限制。

### 清缓存与预热

14. 清缓存支持 URL、前缀、tag、全量四种。
15. **全量**：每个站点有代际号（IR 字段 `Site.cache_generation`），cache key 中包含代际号。代际号加一后旧对象全部不再命中，之后由 nginx cache manager 按 `inactive` 和 `max_size` 回收，不需要遍历磁盘。
16. **URL**：agent 按与 nginx 相同的规则计算 cache key 的 MD5 和缓存文件路径，直接删除对应文件。
17. **前缀与 tag**：需要额外维护 cache key 与前缀、tag 的对应关系，分别在 MVP（前缀）和 v1（Cache-Tag）实现时单独设计。
18. **预热**：agent 以受控的并发向本机数据面请求指定 URL，让对象进入缓存。

### 运维

19. **健康检查**：agent 定期探测本机数据面，结果放进 `ReportStatus.data_plane_healthy`。
20. **指标**：按（分钟，站点）预聚合后通过 `ReportStats` 上报（[ADR-0009](0009-analytics-clickhouse-and-lite.md)）。
21. **访问日志**：按站点配置的采样率采样后上报（analytics 模式）。
22. **自升级**：下载新版本 → 校验 cosign 签名和 sha256（[ADR-0017](0017-release-supply-chain.md)）→ 原子替换二进制 → 由 systemd 重启 agent。新版本启动失败时回退到旧二进制。升级 agent 不影响正在运行的 OpenResty。

### agent 不做的事

23. agent 只执行类型化的操作：应用配置、清缓存、预热、证书轮换、升级。它不提供执行任意命令或脚本的接口。
24. 自升级只接受通过签名校验的官方发布物。控制面失陷时，攻击者可以下发恶意配置，但不能让节点运行未签名的程序。

## 备选方案与取舍

- **只靠轮询**：生效延迟取决于轮询间隔；节点多时轮询请求量大。
- **只靠推送**：长连接断开期间的变更会丢失。
- **每次变更都 reload nginx**：reload 会启动新 worker，旧 worker 要等长连接结束才退出；变更频繁时旧 worker 堆积，内存上涨，缓存锁等进程内状态也会丢失。
- **把热数据写成 Lua 文件再 reload**：问题同上。
- **用 ngx_cache_purge 模块清缓存**：需要自定义构建。按文件路径删除在官方包上就能实现。
- **命令式 agent（控制面下发 shell 命令，或控制面持有 SSH 凭据）**：控制面一旦失陷，就等于所有节点失陷，这正是 GoEdge 事件的教训。

## 后果

### 正面

- 控制面宕机不影响边缘流量。
- reload 次数降到最低。
- 全量清缓存是常数时间操作。
- 控制面失陷的影响被限制在配置层面，不会变成节点上的远程代码执行。

### 负面

- shared dict 的大小在 nginx.conf 中静态指定，扩容属于结构性变更，需要 reload。
- nginx 重启后到 agent 重新灌入数据之间有短暂窗口，此时站点表为空。缓解：由 agent 负责启动 nginx 并立即灌入；或者让 Lua 在 init 阶段从 agent 写出的本地快照文件加载。
- URL 清除依赖 agent 与 nginx 的 cache key 计算规则保持一致，改 cache key 格式时两边要同步修改并测试。

## Phase 0 落地情况

Phase 0 范围：

- 注册、mTLS、`WatchConfig` 加轮询兜底。
- 快照落盘（last-known-good）。
- 渲染最小 nginx.conf，经 unix socket 推送站点表。
- 回报已应用的 revision。

后续：

- 证书、IP 名单热更新。
- 清缓存与预热。
- 指标和访问日志上报。
- 自升级。
- 证书自动轮换的节点侧完整实现与测试。
- 评估 lua-resty-lmdb。

## 版本核实

核实日期：2026-09-25。来源：proxy.golang.org、Docker Hub。

| 组件 | 版本 | 来源 |
| --- | --- | --- |
| Go | 1.27.1 | proxy.golang.org（golang.org/toolchain） |
| OpenResty | 1.31.1.1，镜像 `openresty/openresty:1.31.1.1-bookworm` | Docker Hub |
| connectrpc.com/connect | v1.21.0 | proxy.golang.org |
| google.golang.org/protobuf | v1.36.12 | proxy.golang.org |

> 更新记录：
> - 2026-09-25：Phase 0 已实现：注册（先校验 CA 指纹再发送 token）、WatchConfig + 30 秒 GetConfig 轮询 + 45 秒无消息即重连、快照/diff 均校验内容哈希（diff 异常回退快照）、last-known-good 落盘并保留备份、结构性变更才重渲染 nginx.conf（`nginx -t` 后 HUP）、其余经 unix socket 热更新 Lua 站点表、剩余有效期不足 1/3 时轮换证书、按站点按分钟 ReportStats。Lua 控制接口仅监听 unix socket：`GET /v1/health`、`GET /v1/status`、`PUT /v1/sites`、`POST /v1/stats/drain`。尚未实现：按 URL/前缀/tag 清缓存与预热（Phase 0 只有以 cache generation 实现的全站清除）、自升级、访问日志采样上报。
> - 2026-09-25（MVP M2）：清缓存与预热按类型化任务实现（`PullTasks` / `ReportTaskResult`，见 ADR-0008 更新记录），逐节点回报结果。**与第 16、17 条不同，刷新不删除缓存文件**：URL、前缀、全站刷新都记录一个带时间戳（任务创建时间，毫秒）的刷新标记，Lua 生成 cache key 时附加与请求匹配的最大时间戳，下一次请求因此在新 key 上 `MISS`；旧对象不再被查找，由 cache manager 按 `inactive` / `max_size` 回收，与代际号全量清除相同。原因：缓存键可以按查询参数、请求头、Cookie、设备类型和 slice 分片变化，按文件删除无法枚举同一 URL 的所有变体，前缀刷新也不需要额外的文件索引。标记在节点持久化（`purge.json`），保留到最长 `inactive` 之后一小时；nginx 重启后先灌入标记再推站点表。预热由 agent 经本机边缘监听请求 URL（并发 4、每个 60 秒），结果与普通请求一样进入缓存；HTTPS URL 的预热要等 M3 的 HTTPS 监听。源站凭据（S3 密钥）经 `GetOriginCredentials` 获取，以 0600 保存在状态目录，使控制面不可达时重启仍能服务 S3 源站。agent 每次心跳附带数据面的被动健康状态（`GET /v1/origins/health`）。Lua 控制接口增加 `PUT` / `POST /v1/purge` 与 `GET /v1/origins/health`。
> - 2026-09-25（收尾）：
>   - **清缓存标记有上限。** 每个站点的 URL 与前缀标记超过 `--purge-markers-per-site`（默认 1000）时合并为一个站点级标记（时间取其中最大的），宁可多刷也不无限增长；标记存储大小可配置（`--purge-dict-mb`，默认 32，即 `lua_shared_dict edgeweir_purge`）。标记集合用"代数-序号"标识、每次变化递增，不再每 5 秒排序并哈希全部标记；过期标记最多每分钟清理一次；Lua 端维护条目计数，`GET /v1/status` 不再遍历字典。
>   - **标记装不下时降级，站点不下线。** 整套标记放不进存储时，Lua 把放不下的站点换成站点级标记并回报；整套都装不上时，agent 为每个有标记的站点装一个站点级标记，一分钟后再试整套（标记变了就立即替换）；`purge.json` 读不出来时每个站点刷新一次。`reconcileDataPlane` 在清缓存同步失败时仍推送站点表：此前 nginx 重启后清缓存同步失败会让所有站点 404，直到下一个 revision。
>   - **清缓存时间点由节点分配。** 节点第一次应用某个清缓存任务时分配时间点 `max(now, last + 1)`（毫秒），按任务 id 记在 `purge.json`（格式版本 2）里，同一任务再次交出时沿用；不再使用控制台的 `created_at`，事务乱序提交或多个控制台实例时钟不一致时清除也不会静默失效。
>   - **清缓存优先于预热。** 一批任务中清缓存先执行；预热共用一个从拉取时算起的时间预算（`--prefetch-budget`，默认 4 分钟，短于控制台重新交出任务前的 5 分钟），超时未完成的 URL 记为失败（`prefetch_timeout`）。预热请求走第一个不要求 PROXY protocol 的监听，全部要求时走本机 unix socket 上的边缘监听（`--edge-socket`）。
>   - **兜底轮询一直运行（与第 4 条不同）。** `GetConfig` 和 `PullTasks` 的兜底轮询不因流恢复而停止，每次间隔在配置值（默认 30 秒）的 0.8–1.2 倍之间随机取；节点已是最新时轮询只得到空 diff，开销很小，而流看起来正常但漏掉通知时也能追上。
>   - **reload 之后核实生效（第 8 条的补充）。** 每个渲染出的 nginx.conf 带一个配置 id（不含 id 时渲染结果的哈希），`init_by_lua` 记下它，`GET /v1/status` 上报；发出 HUP 后 agent 最多等 15 秒，直到有 worker 报告新的 id。等不到时该 revision 回报 `FAILED`，放回上一个 nginx.conf（这样重启时运行的就是正在运行的配置），last-known-good 继续服务。

> 更新记录（2026-09-27，MVP M3）：M3 增加 SNI 动态证书、HTTP/2、HTTP/3、HSTS、TLS 档位与 Gzip。证书材料仅保存在私有状态目录的 0600 文件中。证书内容变化不 reload；监听、SNI 名称和静态 TLS/压缩选项改变时验证后 reload。表推送失败会恢复原配置；持久化失败不能回报 APPLIED。OCSP 请求有地址、大小、时间与签名/有效期限制。

## 2026-09-27 M5 更新

- 统计批次在节点以 0600 持久化后上报，同一序号与载荷重试；重启和序号文件丢失时读取控制面游标，避免重复使用已接受序号。
- Top URL/IP 用每 worker 有界 Space-Saving 候选和独立共享内存汇总；不上传查询参数、Cookie 或请求头。结果明确为近似值。
- 完成分钟数据只经控制 socket 上报；队列有桶数和磁盘大小上限，溢出有日志，不宣称计费级无损统计。

> - 2026-09-27（MVP M6）：类型化 UpgradeTask 仅携带版本、归档、SHA-256、已签名清单与 bundle 地址。节点本机固定来源与签名信任锚，控制台不能传公钥或任意命令。稳定监督进程在私有目录切换二进制与 Lua，验证 mTLS / 配置 / 健康后才确认成功；失败及试运行中重启恢复前一程序和 LKG，结果持久到确认。按节点组试运行，连续健康回执 30 秒后显式推进。基础镜像 / 软件包指纹变化优先使用新基础安装，避免旧自升级程序掩盖系统更新。
