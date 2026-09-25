# ADR-0011: 配置模型：与引擎无关的 NodeConfig IR

- 状态：已接受
- 日期：2026-09-25
- 适用仓库：两者

## 背景

- GoEdge 每次同步都拉全量配置，站点多时浪费带宽和 CPU。
- Apache Traffic Control 的 Profile/Parameter 是弱类型键值，没有校验，配置错误要到节点上才暴露。
- 很多面板直接在控制面生成 nginx.conf，控制面与引擎强耦合，每次变更都要 reload。
- ATC 的两阶段发布（路由快照与节点配置分开）和节点端"拉取、比较、备份、区分 reload 与 restart"的流程值得借鉴。
- 运维需要回答"这个节点现在跑的是哪一版配置"，并能一键回滚、做金丝雀发布。

## 决策

### IR

1. `packages/config-compiler` 把数据库中的站点、域名、源站池、缓存规则、证书引用编译成 `NodeConfig`（[`proto/edgeweir/node/v1/config.proto`](../../proto/edgeweir/node/v1/config.proto)）。
2. IR 描述意图（监听端口、域名、源站池、缓存规则），不包含 nginx 指令，由节点负责渲染到具体引擎。
3. IR 不内联任何密钥。证书只以 id、域名列表和指纹引用（`CertificateRef`），私钥通过单独的通道获取。
4. **结构性配置与可热更新配置分开**：`listeners`、`cache_zones` 是结构性配置，变更时节点要重新渲染 nginx.conf 并 reload；`sites`、`certificates` 可以热更新（[ADR-0014](0014-node-agent-responsibilities.md)）。

### revision 与内容哈希

5. **revision**：每次发布在集群内生成单调递增的 revision（发布事务内锁定集群行并递增计数），与编译结果一起写入 `config_revision`。
6. **content_hash**：把规范化后的 `NodeConfig` 的 `revision` 和 `content_hash` 两个字段清空，取其确定性二进制编码的 SHA-256，以小写十六进制表示。
7. **规范化规则**（同时写在 config.proto 的注释中）：`listeners` 按 port、`cache_zones` 按 name、`sites` 按 id、`certificates` 按 id 排序；站点内 `domains` 按 name、`origins` 按 id、`cache_rules` 按 (priority, id) 排序。
8. **跨语言一致性**：protobuf 的"确定性编码"只保证同一个实现内结果稳定，不保证不同语言的实现输出相同字节。为了让 protobuf-es（控制面）和 protobuf-go（节点）对同一个 IR 输出相同字节，IR 遵守以下约束：
   - 不使用 `map` 字段。不同实现对 map 条目的编码顺序不同；需要键值结构时，用按 key 排序的 `repeated` message。
   - 字段按字段号升序声明，避免实现之间在字段输出顺序上的差异。
   - 哈希前清除未知字段。
   - TypeScript 与 Go 两端的测试共用同一组 golden 用例（输入 IR，期望哈希）。任何一端改变编码行为，测试都会失败。
9. 编译结果的内容哈希与最新 revision 相同时，不生成新 revision。

### 下发与回执

10. `WatchConfig` 只推送"最新 revision + 内容哈希"的通知，不推送配置本身（[ADR-0008](0008-node-channel-connect-rpc-mtls.md)）。
11. 节点调用 `GetConfig(revision, base_revision)`。控制面仍保留 `base_revision` 时返回 diff，否则返回完整快照。
12. **diff 语义**（`NodeConfigDiff`）：
    - `sites` 按 id upsert（`upserted_sites`）或删除（`removed_site_ids`）。
    - `listeners`、`cache_zones`、`certificates` 体积小，总是全量下发。
    - 节点应用 diff 后重新计算内容哈希。与 diff 中的 `content_hash` 不一致时丢弃结果，改拉完整快照。
13. **回执**：节点应用后调用 `ReportStatus`，上报 `applied_revision`、`applied_content_hash`、状态（`APPLYING`、`APPLIED`、`FAILED`）和失败原因（例如 `nginx -t` 的输出）。控制面写入 `node_config_status`，UI 显示每个节点已应用的 revision。
14. **last-known-good**：节点只在应用成功后把配置持久化为 last-known-good。启动时先用它恢复服务，再连接控制面。新 revision 应用失败时继续使用 last-known-good，并回报 `FAILED`。

### 金丝雀与回滚

15. **金丝雀**：一次发布可以先只对指定的节点组生效（节点组的目标 revision 独立于集群最新 revision），观察回执和指标后再推广到整个集群。
16. **回滚 = 以旧 revision 的内容发布一个新 revision。** revision 始终单调递增，节点永远不需要处理"版本号变小"的情况；回滚后的内容哈希与旧 revision 相同，便于核对。

### 引擎解耦

17. IR 与 OpenResty 无关。将来增加 Pingora 引擎时，只需在节点侧增加一个渲染器；`NodeInfo.engine` 字段标明节点使用的引擎。

## 备选方案与取舍

- **每次推送全量配置（GoEdge）**：站点多时浪费带宽和 CPU，节点每次都要全量比较。
- **控制面直接生成 nginx.conf**：与引擎强耦合，做不了热更新，每次变更都要 reload。
- **JSON 格式的 IR**：没有 Go 和 TypeScript 的代码生成与编译期类型检查，确定性编码规则要完全自己定义。
- **弱类型键值参数（ATC 的 Profile/Parameter）**：错误要到节点上才暴露。
- **以类型化事件为主要同步机制（GoEdge 的 configChanged、ipItemChanged 等任务）**：事件一旦丢失或乱序，节点状态就会漂移；revision 加快照/diff 是幂等的。类型化任务仍然适合清缓存、预热这类一次性操作，后续作为单独的 RPC 设计。
- **回滚时让节点退回旧的 revision 号**：revision 不再单调，节点和 UI 判断"是否最新"都会变复杂。

## 后果

### 正面

- 节点状态可以用 (revision, content_hash) 精确描述，控制面和节点对"跑的是哪一版"没有歧义。
- 同步是幂等的，增量下发节省带宽。
- 引擎可以替换。

### 负面

- 两端必须维护一致的规范化和编码规则，靠 golden 测试兜底。
- 控制面要保留一定数量的历史 revision 才能生成 diff，保留策略需要可配置。
- proto v0 还没有下发证书私钥的 RPC，HTTPS 站点上线前必须补上。

## Phase 0 落地情况

Phase 0 范围：

- config.proto 中的 `NodeConfig` 与 `NodeConfigDiff`。
- config-compiler（数据库模型到 IR）、revision 与 content_hash、发布时 NOTIFY。
- `WatchConfig` 通知与 `GetConfig`（快照与 diff）。
- `ReportStatus` 回执写入 `node_config_status`，控制台显示节点已应用的 revision。
- 节点落盘 last-known-good。

后续：

- 一键回滚。
- 金丝雀节点组与自动回滚（ROADMAP v1）。
- 证书私钥下发 RPC。
- revision 保留策略。
- IR 扩展：规则引擎（[ADR-0012](0012-rule-engine-expression-language.md)）、WAF、IP 名单。

## 版本核实

核实日期：2026-09-25。来源：npm registry、proxy.golang.org。

| 组件 | 版本 | 来源 |
| --- | --- | --- |
| @bufbuild/protobuf | 2.15.0 | npm registry |
| google.golang.org/protobuf | v1.36.12 | proxy.golang.org |
| buf | 1.73.0 | proxy.golang.org（github.com/bufbuild/buf） |

> 更新记录：
> - 2026-09-25（MVP M1）：revision 的原因改为 `reason_code` + `reason_params`（`cluster_created`、`site_created`、`site_updated`、`site_deleted`、`site_purged`、`rollback`），界面按语言渲染；`reason` 列仍写英文文本给 API 读者，旧 revision 没有原因码时界面显示原文。网站编辑（名称、域名、源站、缓存规则）每次保存都发布新 revision，内容哈希不变时返回当前 revision。
