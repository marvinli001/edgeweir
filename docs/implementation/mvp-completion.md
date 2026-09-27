# MVP 完成与复核记录

本轮范围于 2026-09-26 确认为：完成公开仓库和云端开发准备，审查并修复 M1/M2，继续完成 `docs/specs/mvp.md` 的 M3–M6。v1/v2 保留为后续路线图。MVP 功能、本轮源码复核及本地修复验收已完成。完整远端流水线见[控制面 CI](https://github.com/marvinli001/edgeweir/actions/workflows/ci.yml)与[节点 CI](https://github.com/marvinli001/edgeweir-node/actions/workflows/ci.yml)，以对应提交的运行结果为准。

## 功能与验收入口

| 范围 | 已实现 | 实际验收 |
| --- | --- | --- |
| M1/M2 | 多租户、节点、源站、缓存、刷新预热及基础审计修复 | 完整 `scripts/e2e.sh`；平台后台 403、组织隔离、源站地址限制、S3、Range、WebSocket 与安装流程 |
| M3 | 上传/ACME、HTTP-01/DNS-01、ARI、HTTPS、HSTS、HTTP/2/3、能力协商 | `scripts/e2e-m3.mjs` 的真实 Pebble/OpenResty；Playwright M3；密钥与证书轮换、失败保留 LKG |
| M4 | 类型化表达式、阶段规则、WAF、限速、名单、改写、本地 GeoIP | `scripts/e2e-m4.mjs`；19 个 TS/Lua 共用表达式向量；排序与编辑器浏览器流程 |
| M5 | TXT 域名证明、独立 DNS 版本、健康摘除/恢复、统计去重/汇总、Top URL/IP、告警和 API | `scripts/e2e-m5.mjs`；真实本地 DNS 查询、DNS 提供商模拟接口、Webhook、TLS SMTP、浏览器流程 |
| M6 | 采样日志、CSV、ClickHouse、AccessKey、签名试运行升级与回滚、备份恢复、性能基线 | `scripts/e2e-m6-logs.mjs`、`scripts/e2e-m6-upgrades.mjs`、`scripts/e2e-restore.mjs`；真实 ClickHouse；两台 Linux 节点；Playwright M6 |

日志采样默认关闭，查询参数、请求头与正文不进入采样日志。节点磁盘队列有数量和容量限制，日志不是零丢失的审计账本。分钟/小时/天流量汇总保留 7/90/365 天，原始日志保留 7 天。控制台图表和告警继续使用 PostgreSQL 的精确汇总；ClickHouse 可选保存原始日志和分钟快照，切换模式不迁移历史数据。

升级先验证固定发行身份或本地运维预置公钥，再核对签名清单与归档哈希。真实 cosign 夹具验证了 A → B、错误密钥签名拒绝和已签名坏程序启动失败后的回滚；浏览器验证了先一组试运行、健康观察后明确推进。固定监督进程、cosign 与 OpenResty 仍通过完整镜像或系统包更新。详情见[节点升级记录](m6-upgrades.md)。

## 审计修复

- 初始化竞争使用同一连接上的非阻塞锁，避免耗尽连接池；组织管理员看不到 owner 邀请凭据；旧整站刷新接口与任务接口共享租户配额。
- 未知协议枚举或能力拒绝整份配置；激活失败恢复前一数据面配置；LKG 落盘失败不报告成功，并对同一版本退避。
- 域名未验证时不发布路由；平台名单与日志采样隐私策略不随站点历史版本回滚；只读 AccessKey 的检查位于所有 API 过程之前。
- 恢复跳号使用控制台签发、绑定节点/集群/版本/哈希的认证回执，忽略未认证的高版本号。真实演练为备份 112 → 节点 113 → 新库恢复后的发布 114。
- 监督进程识别完整包/镜像内的基础程序和 Lua 变更，避免旧状态卷持续覆盖新安装版本；独占锁在恢复事务之前取得，升级结果保留到确认成功落盘。
- 最终收尾修正了不存在的 cosign Action 主版本标签、节点发布仓库配置，以及预热错误选中 TLS 监听的问题。预热回归先复现失败，再验证普通 HTTP / Unix socket 两条路径。

- 最终源码复核检查了控制面 157/157、节点 84/84 个变更源文件，记录 4 个中风险、1 个低风险问题。补齐了登录会话才能创建密钥、计数累加与汇总上限、通知总时限、租户新增能力准入，以及固定逐站点限速内存分区。没有执行攻击链复现实验；这些结论来自源码、契约与权限路径，修复使用普通回归和集成测试验收。
- 同时修复网站切换后保留旧日志筛选状态、HTTP/3 自定义端口通告，补齐宝塔模板的可选配置项，并将节点的漏洞报告渠道改为已启用的 GitHub 私密安全公告。

上述条目是可复核的具体修复，不是“没有漏洞”的结论。新 M3–M6 改动的独立安全复核固定在控制面 `7391f40`、节点 `3e3a155`；之后的修复单独记录提交和测试。

## 本地验证

使用独立 Compose 项目 `edgeweir-mvp-audit`，保留原有开发容器和数据库。控制台 243 个测试、workspace 共 341 个测试、类型检查、构建、lint，节点 Go vet/race、Lua、协议生成一致性均已通过。网页覆盖桌面与 375px 深色模式，并断言没有 pageerror。协议已发布为 `proto/v0.7.0`，节点 CI 从公开 GitHub tag 验证生成代码。

性能测试采用 macOS arm64 / Colima、oha 1.16.0、30 万个预热缓存请求、并发 32、100% HTTP 200。初始基线 35,212.91 QPS；修复后为 38,145.38 QPS，p50 0.764 ms，p99 2.169 ms，节点进程 VmRSS 合计 118.57 MiB，容器内存 117.6 MiB。

与初始记录相比，吞吐增加 8.33%，p99 降低 8.52%；RSS 合计增加 57.97%，**超过 20% 的内存增长已标记**，不能把吞吐结果概括成所有指标都改善。当前栈包含监督进程、自升级版本和第二台节点；RSS 合计包含共享/映射页。运行时检查未发现旧 agent/worker 残留，cgroup 同时存在匿名内存及发行文件缓存。这是可复现的本机样本，不是生产容量保证。脚本分别比较吞吐、p50、p99 和 RSS，保留各项变化与 `regressions`；CI 不设置硬性能门槛。

复现命令：

```sh
OHA_BIN=.e2e/tools/oha BENCH_REQUESTS=300000 \
  BENCH_BASELINE=.e2e/bench-final.summary.json \
  BENCH_OUTPUT=.e2e/bench-audit-final.json bash scripts/bench.sh
```

`.e2e/` 中的截图、性能结果和恢复状态仅作本地验收证据；测试凭据与临时签名私钥不提交到公开仓库。

## 发布与边界

- 两个仓库公开，私密漏洞报告入口已启用。实际仓库与发行命名空间为 `marvinli001`。
- Claude SessionStart 脚本已在干净 Node 22 容器验证安装、lint 和 workspace 类型检查，本地分支无操作。实际 Anthropic 云端会话尚未触发。
- 尚未发布正式二进制发行版，也未部署生产。GitHub OIDC 发布物、真实 DNS/ZeroSSL 和外部通知账户需要各自验收；本轮没有发送真实外部通知。
- 官方 OpenResty 镜像具备 HTTP/3；Brotli/Zstd 缺少模块，依规格保持开关不可用。Valkey profile 仍预留。
- 完整镜像与 Actions 固定、首次正式发布的签名/provenance 演练属于 `ROADMAP.md` 的发行前事项，不冒充已完成。
