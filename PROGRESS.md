# Edgeweir 进度

规格来源：Phase 0 为 [BOOTSTRAP.md](BOOTSTRAP.md)，MVP 为 [docs/specs/mvp.md](docs/specs/mvp.md)（各自是唯一需求来源）。本文件逐项勾选交付物。

## 待决策

> 需要维护者拍板的事项。每条都已选了默认值并继续推进；如需改动，告诉我即可。

1. **BOOTSTRAP.md 来源**：会话开始时工作区根目录没有 `BOOTSTRAP.md`。在本机
   `~/Library/Application Support/Claude/scratch-workspaces/.../edgeweir-bootstrap-prompt.md`
   找到内容完全对应的规格（2026-09-25 13:32 修改），已原样复制为 `BOOTSTRAP.md`。
   **默认**：以该文件为准。
2. **工作区布局**：`edgeweir/`（本仓库，也是工作区根目录）与 `edgeweir-node/` 是同级目录。
   `BOOTSTRAP.md`、`PROGRESS.md` 放在 `edgeweir` 仓库根目录并提交，这样 `git status` 保持干净。
   **默认**：保持同级布局；compose.e2e.yml 通过 `EDGEWEIR_NODE_CONTEXT`（默认 `../edgeweir-node`）引用节点仓库。
3. **本机全局 pnpm 升级**：本机原有 pnpm 9.12.0，官方最新为 12.6.0。已执行
   `npm i -g pnpm@12.6.0`，并在 `package.json#packageManager` 锁定 `pnpm@12.6.0`。
4. **本机安装开发工具**：buf 1.73.0、goreleaser 2.18.2、syft 1.52.0、cosign 3.1.3 通过 Homebrew 安装
   （仅本机开发/验证用，不发布任何东西）。
5. **文档语言**：README 中英双语（两个文件）；ADR、ARCHITECTURE、ROADMAP、CONTRIBUTING 以中文为主；
   SECURITY 中文 + 英文摘要；CLAUDE.md 英文。**默认**如此，若希望全部英文再调整。
6. **集群归属**：BOOTSTRAP 未说明集群/节点属于平台还是租户。**默认**：集群、节点、revision、审计日志
   只有平台管理员可见和管理；网站属于组织（租户），租户成员只能看到本组织网站（ADR-0007）。
   **2026-09-25 已确认**：所有人的主视图是控制台，平台管理员另有顶栏 [控制台 | 后台] 切换进入 `/admin`（ADR-0007 更新记录）。
7. **初始化窗口风险**：初始化向导完成前，任何能访问控制台的人都能创建管理员。**默认**：文档中提示
   "先完成向导再对公网开放 3000"；后续可增加一次性 setup token（写入 ROADMAP 风险项）。
   **MVP M1 已解决**：初始化必须输入启动日志里的一次性 setup token（见下方 MVP M1）。
8. **开放 API 与 UI 的凭据分离**：`/api/v1` 只接受 `x-api-key`，`/rpc` 只接受会话 cookie（且要求 CSRF 头）。
   **默认**采用（更安全），见 ADR-0005 更新记录。
9. **e2e 端口**：本机 8443、5432 被 SSH 隧道占用。compose.e2e.yml 不向宿主机发布 8443（节点在容器网络内
   访问 `https://console:8443`），控制台映射到 `localhost:13000`，节点 HTTP 映射到 `localhost:18080`
   （均可用 `E2E_CONSOLE_PORT` / `E2E_NODE_PORT` 覆盖）。
10. **appica-ui 1.2.0 发布不满 1 天**：pnpm 的最小发布时间检查把 `@appica/ui-react@1.2.0` 自动加入
    `minimumReleaseAgeExclude`（与已有的 better-auth、turbo、vite 例外做法一致）。**默认**：保留 1.2.0；若要严格执行
    发布时间门槛，可改用 1.1.0（2026-08-11 发布），需要重新核对用到的组件。

MVP M1 新增（2026-09-25）：

11. **默认分支**：M1 开始时另一个会话正在工作区提交（Phase 0 界面规范调整），并把 `main` 改名为 `master`。
    M1 在独立 worktree 的 `mvp-m1` 分支开发，完成后快进合入 `master`。**默认**：沿用 `master`。
12. **邀请的交付方式**：M1 没有 SMTP（邮件在 M5 接入），邀请以链接交付（`/invite/<id>`，7 天有效），由邀请人复制发送。
    **默认**：链接；M5 接入 SMTP 后再加邮件发送。
13. **平台管理员与组织 2FA 策略**：组织的"要求两步验证"只约束租户成员，平台管理员不受约束，避免策略把平台管理员挡在控制台外。
    **默认**：豁免；如需平台管理员也受约束，改一行判断即可。
14. **节点跨集群移动**：规格要求节点在节点组之间移动；节点组属于集群，移动限于同一集群（跨集群返回 `NODE_GROUP_CLUSTER_MISMATCH`）。
    **默认**：跨集群用"删除节点 + 新 token 重新注册"。
15. **停用节点的数据面**：停用只拒绝控制面通道（不再接收新配置、心跳失败），节点继续用 last-known-good 配置服务；从 DNS 摘除属于 M5。
    **默认**如此。
16. **列表接口的不兼容变更**：`sites.list`、`auditLogs.list` 改为分页的 `{ items, total }`（1.0 之前，ADR-0005 更新记录）。
    **默认**：不保留旧的数组形式。**2026-09-25 已确认**。
17. **setup token 的交付**：打印在控制台日志（JSON 的 `setupToken` 字段），多实例、重启打印同一个 token；不提供环境变量预置。
    **默认**如此；需要全自动部署时可再加 `EDGEWEIR_SETUP_TOKEN`。
18. **租户选择集群**：租户成员新建网站不能指定集群（`CLUSTER_SELECTION_FORBIDDEN`），落在组织默认集群；平台管理员可指定。
    **默认**如此。
19. **TOTP 二维码依赖**：用 uqr 0.1.3（MIT、无依赖）生成二维码矩阵，自己画 SVG。**默认**采用。

对标调研补充（2026-09-25，详见 [docs/research/benchmark.md](docs/research/benchmark.md)）：

20. **License**：设计会话按默认选了 AGPL-3.0（防止闭源倒卖），备选 Apache-2.0（更利于企业采用），维护者没有明确回答过。
    **默认**：保持 AGPL-3.0。
21. **按集群的长期注册 token**：国内面板常见（批量上节点方便），与"注册 token 一次性、只存哈希"的原则冲突。
    **默认**：不做；批量上节点用"一次生成多条一次性命令"替代。
22. **批量 SSH 安装节点**：与"绝不存 SSH 凭据"冲突。**默认**：不做。
23. **DNSLA、51dns 等服务商**：先确认是否有可用的 libdns 实现，没有则放到 v1 用自定义 webhook 协议接入。**默认**：MVP 只做 mvp.md 列出的四家。
24. **调研原始资料**：goedge.rip 文档抓取等第三方内容只保存在本机 `~/Developer/edgeweir-research/`，不进仓库。
25. **品牌**：`edgeweir.com`、`edgeweir.dev` 域名和 GitHub org 需要维护者自己注册；README 已加读音说明（EDGE-weer）。

数据展示重做新增（2026-09-25，见文末「数据展示重做」）：

26. **星标与最近访问的存放**：星标存服务端（`site_star` 表，按用户，跨设备一致）；最近访问只存当前浏览器的 localStorage（按用户，最多 5 条，存储不可用时为空）。
    **默认**如此；需要跨设备同步最近访问时再入库。
27. **统计时间范围**：过去 1 小时 / 6 小时 / 24 小时 / 7 天 / 30 天，默认 24 小时；每点宽度 1 分钟 / 5 分钟 / 10 分钟 / 1 小时 / 6 小时（60–168 个点）。窗口以当前（未满）的时间桶结尾，涨跌与紧挨着的上一等长时段比较，显示相对变化。
    **默认**如此。
28. **`overview.get` 去掉 `traffic` 字段**：首页图表改用 `analytics.traffic`，概览接口不再每 10 秒查一遍流量（1.0 之前的不兼容变更，ADR-0005 更新记录）。
    **默认**：不保留旧字段。

落地页（2026-09-25）：

29. **落地页与控制台的路径**：落地页开启后占用 `/`，控制台概览移到 `/overview`；模板为「关闭」（默认）时 `/` 直接进控制台（未登录去 `/login`）。
    **默认**如此；想让落地页用独立域名可以后续按 Host 区分。
30. **注册按钮**：自助注册按 ADR-0007 仍关闭，落地页的「注册」跳转到后台配置的注册链接（如申请表单），未配置时只显示「登录」。
    **默认**如此；v1 开放自助注册后改为站内注册页。

MVP M2 新增（2026-09-25）：

31. **缓存键按站点设置**：mvp.md 把「自定义缓存键」列在缓存规则下；实现为按站点的一套策略，对所有规则生效。原因是 URL 刷新要能覆盖同一 URL 的全部变体（查询形式、设备、请求头、Cookie、分片），按规则各自一套键时刷新无法确定目标。
    **默认**：按站点；需要按规则区分时在 M4 的配置规则（按表达式覆盖站点设置）里做。
32. **刷新不删缓存文件**：URL、目录、全站刷新都记录刷新标记（时间戳进入 cache key），下一次请求是真正的 `MISS`；旧对象不再被读取，磁盘空间按缓存区 `inactive`（默认 7 天）和 `max_size` 回收，与原来的代际号全量清除一致（ADR-0014 更新记录）。
    **默认**如此；若需要"刷新后立即释放磁盘"，v1 再加节点侧的按前缀扫描删除。
33. **离线节点的刷新任务**：任务对节点保留 7 天，节点恢复连接后执行；7 天内未执行的记为失败（`expired`），任务列表可见，需要时再提交一次。
    **默认**如此。
34. **S3 源站的边界**：只转发 GET / HEAD（其他方法 405），不转发访问者的查询字符串；节点把 S3 密钥以 0600 保存在状态目录，使控制台不可达时重启仍能回源（与节点私钥同等保护）。
    **默认**如此。
35. **回源证书校验的粒度**：校验开关按站点（源站池）而不是按单个源站，因为 nginx 的 `proxy_ssl_verify` 是静态指令，按站点分到两个源站层；一次请求内的重试不在 HTTP 与 HTTPS 源站之间切换；不校验证书的 HTTPS 连接不进入连接池。节点找不到系统 CA bundle 时，需要校验的 HTTPS 源站直接失败（`--trusted-ca` 可指定）。
    **默认**如此。
36. **stale 默认关闭**：Phase 0 的节点静态配置了 `proxy_cache_use_stale error timeout updating http_5xx`（出错时无限期返回旧内容）；M2 改为按规则设置 stale-while-revalidate / stale-if-error，默认 0（关闭）；「遵循源站缓存头」的规则同时遵循源站自己的 stale 扩展。
    **默认**：关闭；如果希望新规则默认带 stale-if-error（例如 1 天），改 contract 的默认值即可。
37. **一致性哈希的键**：固定为请求 URI（路径 + 查询），不提供按客户端 IP 等其他键。**默认**如此，会话保持在 ROADMAP v1。
38. **预热**：不跟随跳转（3xx 按原样缓存并算成功）；HTTPS URL 的预热要等 M3 的 HTTPS 监听，目前在结果中记为失败。前缀和全站预热不在 MVP（node ROADMAP 已拆出）。
39. **源站 id 的稳定性**：保存源站池时，协议、地址、端口相同的源站保留原 id（节点上报的健康状态随 id），其余新建或删除。**默认**如此。
40. **界面单位**：超时以秒输入（存毫秒），响应大小以 KB 输入（1 KB = 1024 字节）；大小留空表示不限，stale 留空表示关闭。拖动排序用 @dnd-kit（shadcn dashboard 区块同款），支持指针、触摸和键盘。
41. **e2e 的 S3 服务**：用 Versity S3 Gateway `v1.8.0`（Apache-2.0，镜像约 29 MB，posix 后端）验证真实的 SigV4 校验。**默认**如此。
42. **e2e 环境隔离**：M2 验证期间另一个会话占用了默认的 `edgeweir-e2e` compose 项目（端口 13000/18080）。compose.e2e.yml 的镜像标签改为可覆盖（`E2E_TAG`），M2 的验证在独立项目中运行：
    `COMPOSE_PROJECT_NAME=edgeweir-m2 E2E_CONSOLE_PORT=13100 E2E_NODE_PORT=18180 E2E_TAG=m2`（命令本身不变）。**默认**：默认值不变，单独运行时与以前完全一样。
43. **mvp-m2 的合并方式**：M2 完成时主工作区有另一个会话未提交的落地页改动，当时没有快进。2026-09-25 收尾时，落地页与主题改动先按功能提交，`master` 已经前进（数据展示重做、落地页），不能再快进，也不 rebase（`proto/v0.2.0` 必须从 `master` 可达）。
    **已执行**：按审计 I2 用 `git merge --no-ff mvp-m2` 合入 `master`，M2 迁移重新生成为 `0003_m2`（见「收尾（2026-09-25 审计）」）。
收尾新增（2026-09-25 审计，见文末「收尾（2026-09-25 审计）」）：

44. **工作区里的两个未跟踪文件**：`edgeweir-bootstrap-prompt.md` 与 `BOOTSTRAP.md` 逐字节相同，已移到 `~/Developer/edgeweir-research/`；`.claude/launch.json`（桌面应用的开发服务器配置）提交，`.claude/` 下其他本地设置加入 `.gitignore`。
45. **旧数据卷要重建**：迁移重新编号（`0003_m2`，另有收尾新增的 `0004_wrapup_auth`、`0005_wrapup_console`）。1.0 之前没有生产数据，开发库与 e2e 卷用 `docker compose … down -v` 重建；按旧编号迁移过的库不能原地升级。
46. **proto v0.2.1 / v0.2.2**：收尾只加字段（`buf breaking` 对 v0.2.0 通过），tag 只打在本地。v0.2.2 只改注释（列出节点实际上报的错误码）。`NodeTask.created_at` 的注释（"清缓存用它作标记时间"）已过时（节点自己分配时间，N-M3），留到下一次 proto 改动（M3 的 v0.3.0）一起改。
47. **`/api/auth` 白名单放在 Hono 层**：只放行界面用到的路径和方法，其余 404；organization、admin 插件仍注册，只供服务端 `auth.api.*` 调用（没有用 better-auth 的 `disabledPaths`）。
48. **认证事件的审计**：新增 `auth.sign_in` / `auth.sign_in_failed`（失败时记录提交的邮箱，不记密码，数量受限速约束）。better-auth 自己提交的改动（改密码、TOTP、passkey、API key）在它提交后立即写审计，不在同一事务，写失败只记日志；Edgeweir 自己的写操作与审计同一事务。
49. **账户创建的补偿**：better-auth 建好账户后，Edgeweir 的后续事务（成员关系 + 审计）失败时删除该账户，而不是单一事务（`runWithAdapter` 是内部 API，未采用）。
50. **信封 v2**：附加数据含用途与记录 id；读路径拒绝 v1，启动时一次性把 v1 重新封装为 v2。多实例部署需要同时升级。
51. **主密钥格式**：不把 hex 当作另一种编码解释。`openssl rand -hex 32` 的输出按 base64 解码为 48 字节，本来就可用；改成 hex 解释会让已用它部署的实例换掉密钥。
52. **登录限速**：沿用 better-auth 默认（只在 `NODE_ENV=production` 时开启，镜像默认如此），计数存数据库，多实例、重启后共享。
53. **install.sh 的不兼容变化**：命令行 `--token` 被拒绝（token 只经 `EDGEWEIR_TOKEN` 或 `--token-file`），以前复制的旧命令要重新从控制台复制；`--server` 必须是 https；另有 `--format`、`--mirror` / `--mirror-only`、`--no-start`；cosign 缺失时下载 v3.1.3 并校验固定的 SHA-256。
54. **install.sh 的 e2e 用 `--no-start`**：本机 Docker 容器里没有 systemd，e2e 在容器里用 goreleaser snapshot 的 .deb 完成安装、建用户、注册，但不启动 systemd 服务。**默认**如此；有 systemd 容器环境时再补一次完整启动。
55. **源站地址策略**：默认拒绝特殊用途地址段，**包括私网**（10/8、172.16/12、192.168/16、100.64/10 等，完整列表见 `packages/contract/src/addresses.ts` 与节点 ARCHITECTURE）。源站在内网的自建部署需要平台管理员在后台「系统设置」加入源站地址允许清单（下发到所有集群）。`localhost` 即使在允许清单内也拒绝；`127.1`、`2130706433` 这类数字主机名视为无效地址；已存在的源站只在编辑时重新校验，节点运行时照样拒绝（返回 502，站点不下线）；允许清单规范化后最多 256 条；配置回滚沿用当前的允许清单。
56. **清缓存频率限制**：每个组织每分钟 10 个任务、每小时 2000 个目标（代码常量，不可配置）；平台管理员不受限；预热也计数，全站刷新按站点计 1；控制台自动补发的全站刷新不计数。
57. **停用和离线节点的刷新任务**：停用节点的任务行显示为「已跳过」；重新启用或离线超过 7 天后重连时，控制台按组织给该节点补发一次全站刷新（宁可多刷），不补预热。
58. **节点错误码**：旧节点只报文本时，只把明确的几种（`HTTP 503`、`dns <host>:` 等）映射为错误码，含糊的（`timeout or HTTP 504`）照原文显示。`task_unsupported` 的 `type` 是未知字段号 `field_<n>` 或 `unknown`；无效目标的刷新任务也报 `purge_failed`。
59. **刷新标记的上限与降级**：每站点最多 1000 个标记，超出合并为一个站点级标记；数据面存储写满（507）后只保留站点级标记；其他失败先装站点级兜底，一分钟后重试完整集合；`purge.json` 不可读时每个站点刷新一次。缓存键：含百分号转义的 URL 升级后缓存键变化一次（升级后的第一次请求是 `MISS`）。
60. **预热**：优先用第一个普通监听；全部监听都要求 PROXY protocol 时用本地 unix socket 监听；时间预算默认 4 分钟（`--prefetch-budget`），同一批任务共享，保证在控制台 5 分钟重新下发之前结束。
61. **带 Authorization 的请求**：生效规则没有勾选「缓存带 Authorization 的请求」时按不缓存处理（即使源站返回 `public`）。**默认**关闭。
62. **节点配置与 reload**：站点、源站、规则 id 不符合 `[A-Za-z0-9_-]`（或超过 128 字符）时拒绝整份配置，id 为空的源站或规则丢弃并告警；reload 后校验新配置标识，失败时恢复旧文件并按永久失败处理（5 分钟后或有新版本时重试）；watch 流正常时节点仍保留带 ±20% 抖动的兜底轮询（与 ADR-0014 第 4 条不同，已写更新记录）。
63. **回源 HTTPS 的证书名称**：nginx 1.29.7 起 upstream 默认开启 keepalive，只按地址复用连接，按一个名称校验过的连接会被复用给另一个名称的请求而跳过校验。节点在 `edgeweir_balancer` upstream 上关闭 keepalive，连接池改由 `balancer.enable_keepalive`（按地址 + 端口 + SNI）负责，每次尝试设置 `proxy_ssl_name`。按 IP 配置的 HTTPS 源站需要设置证书覆盖的回源 Host 或 SNI。
64. **界面**：Rubik 字体保留（fontsource 自托管，SIL OFL 1.1，ADR-0003 更新记录）；`/` 的第一帧总是浅色（落地页关闭时，深色用户直接打开 `/` 会看到一帧浅色再跳到 `/overview`）；`AlertDescription` 是提示正文，不算说明段落，单行安全提示统一用 `SafetyNote`；颜色规则里命名颜色（如 `white`）与 Tailwind 调色板类视为 token；`chart.tsx` 的 recharts 默认色选择器移到 `index.css`，与上游 shadcn 不同。
65. **ADR 的偏差用更新记录说明**：ADR-0014 的"刷新不删文件"和"保留兜底轮询"、ADR-0003 决策 7–9 都以更新记录说明，不另写替代 ADR。**默认**如此；若希望偏差较大的决策写新 ADR 取代旧的，再补。
66. **RPM 包**：goreleaser 生成的 .rpm 内容已与 .deb 逐项核对，但本机没有 RPM 系发行版镜像，未实际安装。
67. **BOOTSTRAP.md 不改**：它是 Phase 0 的需求来源，按原样保留；其中的 `--token` 安装命令已过时，以 README 与控制台显示的命令为准。
68. **install.sh e2e 如何证明 unit 可用**：没有 systemd，e2e 读取已安装 unit 的 `User=`、`Environment=`、`ExecStart=`，手动建 `/run/edgeweir-node` 后按同样方式启动，证明节点以 `edgeweir` 用户运行并在线；systemd 的沙箱选项没有被执行到。
69. **snapshot 包没有签名**：e2e 用 `--allow-unsigned`（仍校验 SHA-256），cosign 校验只在正式发布的包上发生；本机节点仓库没有 remote，snapshot 版本号是 `0.0.1-snapshot+none`。
70. **e2e 的主机要求**：除 Docker 外还需要 goreleaser v2、syft、Go 1.27.1，以及访问 deb.debian.org 和 openresty.org 的网络；compose 网段固定（`E2E_SUBNET` 默认 `172.28.213.0/24` 放进源站允许清单，`E2E_ISOLATED_SUBNET` 默认 `172.28.214.0/24` 保持拒绝），并行运行时各自换网段、端口和 `COMPOSE_PROJECT_NAME`。


## 版本核实记录（2026-09-25，来源：npm registry / proxy.golang.org / Docker Hub / nodejs.org / GitHub Releases）

| 组件 | BOOTSTRAP 快照 | 核实后使用 | 备注 |
| --- | --- | --- | --- |
| Node.js | 24 LTS | 24.21.0 (Krypton)，镜像 `node:24.21.0-alpine` | 本机为 25.6.1，仅开发使用 |
| pnpm | — | 12.6.0 | |
| TypeScript | strict | **7.0.2**（npm latest，Go 原生 tsc） | shadcn 模板锁 `~6`，已替换；ADR-0001 更新记录 |
| Vite / Vitest | — | 8.3.1 / 5.0.1 | |
| React | 19 | 19.3.0 | |
| TanStack Router / Query / Table | — | 1.170.39 / 5.103.2 / **9.2.4** | Table v9 API（`useTable` + `tableFeatures`） |
| Hono / @hono/node-server | — | 4.13.9 / 2.1.1 | |
| oRPC | — | **1.15.4**（2.0 为 beta） | ADR-0005 更新记录 |
| zod | — | 4.6.5 | |
| Drizzle ORM / kit | — | **0.45.3**（1.0 为 beta）/ 0.31.11 | ADR-0006 更新记录 |
| pg-boss | — | 12.34.0 | |
| better-auth | — | 1.7.6（CLI 包名为 `auth`） | 遥测显式关闭，ADR-0007 |
| Connect-ES / protobuf-es | v2 | 2.2.0 / 2.15.0 | |
| buf | — | 1.73.0 | |
| Paraglide JS | — | 2.25.4 | 插件本地加载，ADR-0004 |
| shadcn CLI | latest | 4.21.0 | preset b2D0wqNxT = base-luma |
| Biome | — | 2.5.14 | |
| Playwright | — | 1.63.0 | |
| PostgreSQL | 18 | `postgres:18.6-alpine` | |
| Go | — | 1.27.1，镜像 `golang:1.27.1-alpine` | |
| connect-go / protobuf-go | — | v1.21.0 / v1.36.12 | |
| OpenResty | 官方包/镜像 | `openresty/openresty:1.31.1.1-bookworm` | |
| goreleaser / syft / cosign | — | 2.18.2 / 1.52.0 / 3.1.3 | |
| ClickHouse / Valkey | 可选 | 26.9-alpine / 9.2-alpine | compose profiles |
| GitHub Actions | — | checkout v7、setup-node v7、pnpm/action-setup v6、setup-go v7、build-push v7、cosign-installer v4、attest-build-provenance v4 | |
| lua-nginx-module / lua-resty-core | （随 OpenResty） | 0.10.31 / 0.1.34（OpenResty 1.31.1.1 镜像内核实） | `ngx.balancer` 的 `set_current_peer(host, port, sni)`、`enable_keepalive`、`recreate_request`；自带 `resty.openssl.hmac`、`resty.dns.resolver`（MVP M2） |
| @dnd-kit/core / sortable / utilities | — | 6.3.1 / 10.0.0 / 3.2.2 | 缓存规则拖动排序（MVP M2） |
| Versity S3 Gateway | — | `versity/versitygw:v1.8.0` | 仅 e2e（MVP M2） |

## Phase 0 交付清单（BOOTSTRAP §3）

### 1. 仓库基础
- [x] edgeweir：git init、LICENSE (AGPL-3.0)、README.md / README.zh-CN.md（含品牌故事）
- [x] edgeweir：ARCHITECTURE.md、docs/adr/（§2 每条决策一篇，0001–0018）、ROADMAP.md、SECURITY.md、CONTRIBUTING.md、CLAUDE.md、.editorconfig
- [x] edgeweir：GitHub Actions（ci.yml：lint、proto 生成一致性、typecheck、test、build、镜像构建、e2e；release.yml：镜像签名 + provenance）
- [x] edgeweir-node：同上全套文档（LICENSE、中英 README、ARCHITECTURE、ROADMAP、SECURITY、CONTRIBUTING、CLAUDE.md、.editorconfig；docs/adr 镜像自本仓库，18 篇）
- [x] edgeweir-node：GitHub Actions（ci.yml：vet、test -race、proto 一致性、goreleaser check + snapshot、docker build、Lua 测试；release.yml：goreleaser + cosign keyless + SLSA provenance）

### 2. 控制面骨架
- [x] monorepo：apps/console（src/server + src/web）、packages/db、packages/contract、packages/config-compiler、packages/proto、proto/
- [x] shadcn preset b2D0wqNxT 初始化（Vite 模板），Biome 替换 ESLint/Prettier；测试验证 preset 可反推
- [x] i18n：zh-CN（默认）/ en（Paraglide，键与占位符一致性测试）
- [x] 数据模型 v0（better-auth + cluster/node_group/node/node_ip/enrollment_token/site/site_domain/origin_pool/origin/cache_rule/config_revision/node_config_status/audit_log，另有 node_minute_stats、pki_authority）
- [x] oRPC 契约 + OpenAPI `/api/v1`（AccessKey = x-api-key）
- [x] 页面：登录、初始化向导、概览、集群与节点、网站、设置（空/加载/错误态）
- [x] proto v0：NodeService（Enroll/WatchConfig/GetConfig/ReportStatus/ReportStats + RenewCertificate）+ NodeConfig IR，tag `proto/v0.1.0`
- [x] 节点通道：Connect-RPC :8443，应用自终结 TLS，注册后强制 mTLS（集成测试覆盖）
- [x] 配置编译 + revision + 内容哈希 + diff + LISTEN/NOTIFY + 回滚
- [x] pg-boss worker，ROLE=app|worker|all
- [x] helpers/certd（Go 骨架 + 测试，多阶段构建进镜像）

### 3. 节点骨架（edgeweir-node）
- [x] Go agent：enroll（先校验 CA 指纹）→ mTLS → watch + 轮询 → 快照/diff 校验哈希并落盘（LKG + 备份）→ 渲染 nginx.conf（仅结构性变更 reload）→ unix socket 推站点表
- [x] Lua：按 Host 路由（精确 + 泛域名）+ 双层 proxy_cache（TTL 可热更新）+ X-Cache 头；未知 Host 404
- [x] agent 回报已应用 revision（ReportStatus 心跳 + 回执）、证书轮换、ReportStats 分钟统计
- [x] goreleaser 配置（deb/rpm/tar.gz，amd64/arm64，SBOM；cosign keyless 仅正式发布，snapshot 跳过）

### 4. 端到端
- [x] compose.e2e.yml（postgres + console + node + whoami）
- [x] e2e 脚本 scripts/e2e.sh（注册 + CA 指纹校验 + token 单次使用 + mTLS、创建 demo.test、MISS→HIT、控制台显示在线 + revision）
- [x] Playwright 冒烟（登录 → 集群节点 → 网站 → 切换英文）
- [x] 全流程实跑通过（`docker compose -f compose.e2e.yml up -d --build` + `bash scripts/e2e.sh`，含 Playwright）

### 5. 部署
- [x] 多阶段 Dockerfile（非 root、tini、单文件服务端、ROLE）
- [x] compose.yml（+ analytics / cache profile）、compose.dev.yml（本地开发数据库）
- [x] compose.baota.yml + docs/deploy/baota.md
- [x] docs/deploy/docker.md

## 与 BOOTSTRAP 的偏差 / ADR 更新

- TypeScript 用 7.0.2 而非模板的 6.x（ADR-0001）。
- oRPC 用 1.15 稳定版而非 2.0 beta（ADR-0005）；Drizzle 用 0.45 稳定版而非 1.0 beta（ADR-0006）。
- proto v0 增加 `RenewCertificate` RPC 以实现证书自动轮换（ADR-0008）。
- shadcn sonner 组件的 next-themes 依赖被移除，以满足"全局只保留一个 ThemeProvider"（ADR-0003）。
- Phase 0 未用到 shadcn 缺失的组件，appica-ui 与 appica-bridge.css 推迟到首次需要时（ADR-0003）。
- 开发模式的"单进程"用 Vite middleware 模式实现（等价于 @hono/vite-dev-server），因为节点通道 :8443 也必须在同一进程内（ADR-0002）。

## 已知限制（Phase 0 范围之外，已写入 ROADMAP / ADR 更新记录）

- proto v0.1.0 没有下发证书材料的接口，节点暂不启用 HTTPS 监听（归 M3）；~~回源 HTTPS 暂不校验证书。~~ MVP M2 已默认校验，可按站点关闭。
- ~~清缓存只支持全站（cache generation），URL/前缀/tag 清除和预热~~（MVP M2 已实现 URL、前缀、全站刷新与 URL 预热；tag 清除在 v1）；节点自升级、访问日志采样上报属于 MVP M6。
- ~~负载均衡的 round_robin / consistent_hash 在节点侧暂按加权随机处理，无被动健康检查。~~ MVP M2 已实现平滑加权轮询、一致性哈希和被动健康检查。
- 节点仓库 CI 的 proto 一致性检查从 `github.com/edgeweir/edgeweir` 拉 tag，仓库公开前会失败（本地用 `make proto-check` 从同级仓库校验）。
- ~~修订记录里的"原因"文本（如 `site demo created`）目前是服务端生成的英文，未本地化。~~ MVP M1 已改为 `reason_code` + 参数，界面按语言渲染。

## 验证记录（2026-09-25，全部在本机实跑）

| # | 验收项 | 命令 | 结果 |
| --- | --- | --- | --- |
| 1 | 两个独立仓库、干净、Conventional Commits、文档齐全 | `git status`、`git log`、文件检查 | 两仓库 `## main` 无改动；提交全部符合 Conventional Commits 且带 Co-Authored-By；8 个文档 + 18 篇 ADR 均存在 |
| 2 | pnpm install / lint / typecheck / test / build | `pnpm install && pnpm lint && pnpm typecheck --force && pnpm test --force && pnpm build --force` | 全部 exit 0；测试 36 个（contract 6、db 2、compiler 10、console 18） |
| 2 | shadcn preset | `cat apps/console/components.json`、`shadcn preset resolve --json` | style `base-luma`、hugeicons；反推 code `b2D0wqNxT` |
| 2 | i18n | Paraglide `baseLocale: zh-CN`，`locales: [zh-CN, en]`；Playwright 中切换到英文 | 通过 |
| 3 | go vet / go test / goreleaser | `go vet ./...`、`go test ./...`、`goreleaser release --snapshot --clean` | 全部 exit 0；dist 含 amd64/arm64 的 tar.gz、deb、rpm、SBOM、checksums |
| 4 | buf lint + 生成代码来源 | `buf lint proto`、`pnpm proto:gen && git diff --exit-code packages/proto`、`make proto-check`（从 `../edgeweir/.git#tag=proto/v0.1.0,subdir=proto`） | 全部 exit 0；TS 与 Go 的内容哈希测试向量一致 |
| 5 | 端到端 | `docker compose -f compose.e2e.yml up -d --build`、`bash scripts/e2e.sh` | 一次性 token 注册 → mTLS；错误 CA 指纹被拒；token 复用被拒；无客户端证书 401；创建 demo.test 后节点应用 revision #2（哈希一致）；`X-Cache: MISS` → `HIT`；API 显示节点在线与 revision；Playwright 冒烟通过 |
| 6 | 部署 | `docker build .`、`docker compose -f compose.yml config -q`、`docker compose -f compose.baota.yml config -q` | 全部 exit 0；镜像约 265MB；docs/deploy/docker.md、baota.md 存在 |

完整命令输出见最终汇报。

## Phase 0 之后：界面规范调整（2026-09-25）

维护者确定的界面规范，已落地到现有页面，作为 MVP 的样板（详见 ADR-0003 决策 7–9、ADR-0007 更新记录）：

- [x] 文案精简：去掉所有页面副标题、对话框和卡片说明段落、空状态描述；消息从 178 条减到 164 条，zh-CN / en 同步。
- [x] 加载：不用骨架屏。顶部 2px 进度条（路由、请求、提交）+ 首次加载居中 appica Loader + 按钮内 spinner；轮询不触发进度条。
- [x] appica-ui 1.2.0 接入：`appica-bridge.css`（逐组件 `@source`、作用域 token 映射）+ `src/web/components/appica/` 封装；用于 Loader、Sparkline、Meter、Countdown、BorderBeam、GradientGlow、BackgroundPattern、TextAnimate。
- [x] 动效：页面、统计卡片、表格行依次入场；概览统计区光晕；节点在线状态卡片 BorderBeam（全部在线为绿色，有离线为红色）；在线节点徽标脉冲；登录与初始化页点阵背景 + 光标聚光；注册命令倒计时。
- [x] 控制台 / 后台拆分：控制台（概览、网站、设置）人人可用；平台管理员经顶栏切换进入后台（平台概览、集群与节点、审计日志、系统设置）。`/admin` 对非管理员重定向；`settings.get` 改为仅管理员。
- [x] 测试：`test/web/ui-rules.test.ts`（禁止骨架屏、appica 导入范围、不导入 appica 全局样式、`@source` 与导入一致）；服务端新增租户成员调用 `settings`、`clusters`、`auditLogs` 返回 403 的用例；Playwright 冒烟改为走控制台 → 后台 → 控制台。
- [x] 验证：`pnpm lint`、`pnpm typecheck`、`pnpm test`（console 23 个用例）、`pnpm build` 通过；`docker compose -f compose.e2e.yml up -d --build` + `bash scripts/e2e.sh` 输出 E2E OK；浅色与深色下人工检查了登录、概览、平台概览、集群与节点、注册对话框、审计日志、网站、新建网站。

## 下一步：MVP

规格与每个里程碑的 `/goal` 提示词见 [docs/specs/mvp.md](docs/specs/mvp.md)。MVP 分为 6 个里程碑（M1 集群、租户与站点基础 → M2 源站与缓存 → M3 HTTPS、证书与协议 → M4 访问控制与规则引擎 → M5 DNS、统计、告警与开放 API → M6 节点运维与基线），Phase 0 的已知限制已分配到对应里程碑。

## MVP M1：集群、租户与站点基础

规格：[docs/specs/mvp.md](docs/specs/mvp.md) 第 0 节与第 1 节。数据模型见迁移 `packages/db/migrations/0001_m1.sql`，决策见 ADR-0003、0005、0007、0008、0011 的 M1 更新记录。

### 后台（`/admin`，过程一律 `admin` 守卫）

- [x] 集群：创建、改名、删除（有节点或网站时拒绝，`CLUSTER_NOT_EMPTY`）
- [x] 节点组：属于集群，可设置区域；删除时节点回到默认组；节点可在同一集群的节点组之间移动
- [x] 区域：平台级字典（名称、代码），节点组引用
- [x] 节点：改名、停用、启用、删除（吊销证书序列号，再连接被拒绝）；停用或删除时已打开的 watch 流结束
- [x] 组织与用户：创建组织（默认集群、2FA 要求）；创建用户或发送邀请（链接）；设置或取消平台管理员；停用用户（删除会话，AccessKey 同时失效）；把用户加入组织并指定角色；租户新建的网站落在组织默认集群
- [x] 审计日志：显示操作者名称和对象名称；按操作、对象类型、时间范围筛选；分页
- [x] setup token：启动时打印到日志，初始化必须输入（0.4）

### 控制台

- [x] 组织切换：属于多个组织时在侧边栏顶部切换，只有一个组织时不显示
- [x] 组织成员（组织 owner / admin 可见）：邀请（链接）、改角色、移除；只有 owner 能管理 owner，至少保留一个 owner
- [x] 账户安全：修改密码、TOTP 两步验证（二维码 + appica OTP 输入 + 备用码）、passkey；登录时的验证码 / 备用码 / passkey 步骤；组织可要求成员启用两步验证
- [x] 网站详情页 `/sites/$id`：概览、域名、源站、缓存 Tab；可编辑名称、域名（含泛域名）、源站、缓存规则；每次保存生成新配置版本并提示版本号
- [x] 网站列表：按名称或域名搜索、按集群筛选（平台管理员）、分页

### 0.4 归到 M1 的遗留项

- [x] 初始化窗口风险：一次性 setup token（日志打印、信封加密入库、只比对哈希、用后作废）
- [x] 配置版本原因：存 `reason_code` + 参数，界面按 i18n 渲染（旧 revision 回退到英文原文）
- [x] 服务端错误：稳定错误码 + 参数，界面按错误码本地化，未知错误码回退到服务端文本；测试保证每个错误码两种语言都有消息
- [x] 审计日志只显示 ID：记录并显示操作者和对象名称，支持按操作、对象类型、时间筛选

### 工程约束（mvp.md 0.1–0.3）

- [x] API 先改 `packages/contract`，同一过程服务 `/rpc` 与 `/api/v1`；每个新过程都有 Vitest 用例（`test/server/{admin,console,setup,node-channel}.test.ts`），其中表驱动用例覆盖租户成员调用全部 37 个后台过程返回 403
- [x] 管理操作写审计日志（含名称）；setup token 用主密钥信封加密入库
- [x] 界面：无副标题、无说明段落、无骨架屏；每个新页面有加载、空、错误态；appica 只经 `src/web/components/appica/` 使用（OTPField）；深浅色与 375px 用 Playwright 截图检查
- [x] 功能归属符合 0.2：控制台（概览、网站、组织成员、账户安全、设置）；后台（平台概览、集群与节点、区域、组织与用户、审计日志、系统设置）
- [x] e2e：`scripts/e2e.sh` 与 Playwright 覆盖第 1 节「验收」整条链路，断言没有 `pageerror`
- [x] 未改 proto；edgeweir-node 无需改代码（被拒绝时继续按 last-known-good 服务的行为已存在）

### 验证记录（2026-09-25，本机实跑，`master` 工作区）

| # | 验收项 | 命令 | 结果 |
| --- | --- | --- | --- |
| 1 | 功能与遗留项 | 本节清单；`git status`、`git log` | 全部勾选；ROADMAP 勾选多集群、节点组、区域、多域名（含泛域名）、审计日志，新增「租户与账户」并勾选；两个仓库 `git status` 干净，提交为 Conventional Commits |
| 2 | 控制面 | `pnpm install && pnpm lint && pnpm typecheck --force && pnpm test --force && pnpm build --force` | 全部 exit 0；测试 66 个（console 42、contract 11、compiler 10、db 3），含 37 个后台过程对租户成员返回 403 的表驱动用例；`test/web` 的 i18n（5）与 ui-rules（4）通过 |
| 3 | proto / 节点 | `buf lint proto`；edgeweir-node `go vet ./...`、`go test ./...`、`make proto-check` | 未改 proto 与节点代码（仅同步 ADR 镜像），全部 exit 0 |
| 4 | 端到端 | `docker compose -f compose.e2e.yml up -d --build`、`bash scripts/e2e.sh` | 输出 `E2E OK`：日志中的 setup token → 错误 token 被拒（API + Playwright 本地化提示）→ Playwright 初始化 → Phase 0 链路 → Playwright 冒烟 → Playwright M1 全链路（第二个组织与成员、成员只见控制台且 `/admin` 被重定向、成员新建并改域名和源站、管理员建区域/集群/节点组并移动 e2e 节点且在线、版本一致、审计日志显示名称并按操作筛选、英文下版本原因和错误提示为英文，无 `pageerror`）→ 节点按编辑后的域名和源站服务 → 停用被拒、启用恢复、删除后吊销且继续按 last-known-good 服务 |
| 5 | 界面规范 | Playwright 截图（浅色/深色、1280/375）；`ui-rules.test.ts` | 无副标题与说明段落、无骨架屏、appica 只经 `components/appica`；375px 下页头操作换行 |

说明：Claude 桌面应用的内置浏览器会拦截 `GET /api/auth/*`（Chromium/Playwright 正常），因此界面检查用 Playwright 截图完成，不影响产品。

## 数据展示重做（参考 Cloudflare 仪表盘，2026-09-25）

维护者要求重做控制台与后台的数据展示和图表，控制台首页参考 Cloudflare 账户首页。决策见 ADR-0003、0005、0009 的更新记录和上面的待决策 26–28。M5「统计」的分钟级部分（请求数、流量、带宽、命中率、状态码）随之提前完成；Top URL、Top IP 需要改 proto，仍在 M5。

- [x] API：`analytics.traffic`（范围 + 可选网站；分桶序列补零、本期与上一期合计、带宽峰值、状态码按 2xx–5xx 汇总）、`analytics.topSites`、`analytics.topNodes`（仅管理员）；`sites.starred`、`sites.setStarred`；数据范围与网站一致（租户只看本组织，平台管理员看全部）
- [x] 数据：迁移 `0002_site_star.sql`；lite 统计直接按 `date_bin` 聚合分钟明细
- [x] 控制台首页：网站列（星标在前）、最近访问列；统计区（时间范围、刷新、请求总数与数据传输两张带数值轴的大图，缓存命中率、带宽峰值、4xx/5xx 占比四张小图，状态码分布，流量最高的网站）
- [x] 网站详情新增「统计」Tab；网站列表和详情页可加星标
- [x] 平台概览：集群、节点（异常在前）、最近发布三列 + 全平台统计（另有流量最高的节点）；集群页摘要改为数值条，节点状态改为状态点 + 文字
- [x] 指标详情浮窗（参考 Cloudflare 点开卡片的浮窗）：六张指标卡片和状态码卡片可点；按网站 / 节点（仅管理员）/ 状态码 / 缓存状态拆分的时间图 + 排行列表，维度多于一个时用 Tab 切换，浮窗内可换时间范围；API `analytics.breakdown`。顺带修正时间范围菜单选中后不关闭（Base UI 单选项默认不关，菜单的遮罩会挡住页面点击）
- [x] 视觉：扁平面板、1.5px 折线 + 10% 面积、十字线提示框、涨跌箭头（好坏按指标方向着色）；图表色板经 dataviz 校验（亮/暗两套）；换时间范围时保留旧图并变淡，不闪烁；移除 SectionCards、TrafficChart 以及 appica Sparkline、Meter 的封装
- [x] 测试：`test/server/analytics.test.ts`（分桶、补零、状态码分类、上一期、范围窗口、排名、租户范围、星标按用户与范围）；租户调用 `analytics.topNodes` 返回 403；Playwright `e2e/analytics.spec.ts`；`scripts/e2e.sh` 等待节点上报的分钟统计出现在 API 中

已知限制：

- lite 模式的小时/天汇总与分钟明细清理（ADR-0009 决策 3）尚未实现；「过去 30 天」直接读 60 天的分钟行（含上一期），数据量大时需要补汇总任务。
- 最近访问不跨设备（待决策 26）。

验证记录（2026-09-25，本机实跑，`feat/analytics-redesign` 工作树）：

| # | 验收项 | 命令 | 结果 |
| --- | --- | --- | --- |
| 1 | 控制面 | `pnpm lint && pnpm typecheck && pnpm test && pnpm build` | 全部 exit 0；测试 72 个（console 48，其中 analytics 6 个，含 `analytics.breakdown` 的网站 / 节点 / 状态码拆分、租户调用节点维度返回 403） |
| 2 | 端到端 | `bash scripts/e2e.sh --up --down`（独立 compose 项目与端口，未动主工作区的 e2e 栈） | 输出 `E2E OK`；节点上报的分钟统计经 `/api/v1/analytics/traffic` 读到 demo.test 的 3 个请求、1 次命中、3 个 2xx；Playwright 冒烟、M1、analytics 三个用例通过，无 `pageerror`；analytics 用例覆盖指标详情浮窗（节点 / 状态码 Tab、缓存状态、平台概览按网站和节点拆分） |
| 3 | 界面 | Playwright 截图（浅色/深色 1280、浅色 375），开发库灌入 8 个网站、4 个节点、约 9 万行分钟统计 | 控制台首页、网站统计 Tab、平台概览、集群与节点、网站列表均无 `pageerror`；375px 下列表与卡片单列/双列排布，无横向滚动 |
| 4 | 指标详情浮窗 | Playwright 截图（深色/浅色 1440、浅色 375），管理员与租户成员各一套 | 六张指标卡片和状态码卡片都能打开，点卡片标题区或图都可以；管理员有网站 / 节点 / 状态码 Tab，租户没有节点 Tab，只看一个网站的租户在数据传输、带宽上看到放大的趋势图；柱状图按本地整点分组，时间轴刻度落在整点和日期上；无 `pageerror` |

## MVP M2：源站与缓存

规格：[docs/specs/mvp.md](docs/specs/mvp.md) 第 0 节与第 2 节。proto 升级到 `proto/v0.2.0`（edgeweir-node 已从该 tag 重新生成），数据模型见迁移 `packages/db/migrations/0003_m2.sql`（收尾时由 `0002_m2` 重新编号，见「收尾」），决策见 ADR-0008、0011、0014、0015 的 MVP M2 更新记录，行为说明见 [docs/guide/origins-and-cache.md](docs/guide/origins-and-cache.md)。开发在独立 worktree 的 `mvp-m2` 分支进行（开始时另有会话在 `edgeweir-analytics` worktree 和主工作区工作）。

### 节点与 proto

- [x] 源站池：权重、备用源站（主源全部不可用时启用）；`balancer_by_lua` 选源，一次请求最多尝试 3 个源站
- [x] 被动健康检查：连接失败、超时、502/503/504、域名解析失败计为失败；连续失败次数达到阈值后在恢复时间内不再选中，成功一次才恢复健康；经 ReportStatus 上报，控制台源站 Tab 显示
- [x] round_robin（平滑加权轮询）与 consistent_hash（按请求 URI 的 ketama 环）真正实现（0.4 遗留项）
- [x] 回源 Host 与 SNI；回源 HTTPS 证书校验开关（默认校验，系统 CA 或 `--trusted-ca`）（0.4 遗留项）
- [x] 对象存储源站：S3 兼容 SigV4 签名回源（AWS 官方向量 + 独立 Node 实现交叉验证 + e2e 对真实 S3 网关）；密钥信封加密入库，经 mTLS 的 `GetOriginCredentials` 下发，不进配置
- [x] 缓存规则：后缀、精确路径、前缀、状态码、响应大小；遵循或覆盖源站缓存头；stale-while-revalidate、stale-if-error；Range 走 slice（按站点）
- [x] 自定义缓存键（对标补充）：查询参数全部 / 忽略 / 白名单、参数排序、指定请求头、指定 Cookie、移动与桌面、是否包含 Host
- [x] 回源连接（对标补充）：keep-alive 连接池（按地址 + 端口 + SNI）、连接 / 读取 / 发送超时；WebSocket 透传（按站点开关，默认开）
- [x] 刷新和预热：URL、前缀、全站刷新（0.4 遗留项"清缓存只支持全站"）与 URL 预热，经类型化节点任务（`PullTasks` / `ReportTaskResult`、`WATCH_EVENT_TASKS`）下发，逐节点回报结果；proto 升级到 v0.2.0 并打 tag

### 控制台

- [x] 网站详情页源站 Tab：源站池编辑（地址、端口、协议、权重、备用、回源 Host、SNI、S3 签名）、源站池设置（负载均衡、证书校验、被动健康检查、超时、长连接、WebSocket）、每个源站的健康状态
- [x] 网站详情页缓存 Tab：规则列表可拖动排序（指针、触摸、键盘），规则的全部条件；缓存键与分片设置
- [x] 刷新预热页面 `/purge`：提交 URL 刷新 / 目录刷新 / 全站刷新 / URL 预热，显示每个任务在各节点的执行进度和结果（进行中自动轮询）

### 工程约束（mvp.md 0.1–0.3）

- [x] API 先改 `packages/contract`：`sites.originHealth`、`cacheTasks.list/get/create`，`sites.create/update` 增加源站与缓存设置；每个新过程都有 Vitest 用例（`test/server/m2.test.ts`、`node-channel.test.ts`），租户隔离与租户成员调用后台过程返回 403；`admin.test.ts` 新增断言：契约里的每个过程都要么在控制台清单里，要么在 403 表里
- [x] 管理操作写审计日志（`cache.purge`、`cache.prefetch`、网站设置变更），审计中不含密钥
- [x] 界面：无副标题与说明段落（原理写在 docs/guide）、无骨架屏、appica 只经 `components/appica`；深浅色与 375px 用 Playwright 截图检查
- [x] 功能归属符合 0.2：刷新预热、网站源站 / 缓存 Tab 在控制台；未新增后台过程
- [x] e2e：`scripts/e2e.sh` 覆盖第 2 节「验收」全部场景（另加全站刷新、预热、S3、证书校验、stale-if-error、控制台显示源站故障），Playwright `e2e/m2.spec.ts` 覆盖刷新任务提交和结果展示，断言无 `pageerror`；M1 链路仍通过
- [x] proto 改动只加字段、枚举值和 RPC（`buf breaking` 对 v0.1.0 通过）；TS 与 Go 共用新的哈希向量 `content_hash_vector_m2.json`

### 验证记录（2026-09-25，本机实跑，`mvp-m2` worktree；edgeweir-node 在主工作区的 `master`）

| # | 验收项 | 命令 | 结果 |
| --- | --- | --- | --- |
| 1 | 功能、遗留项与仓库状态 | 本节清单；`git status`、`git log` | 全部勾选；两个仓库的 ROADMAP 已勾选源站与缓存条目；提交为 Conventional Commits 小步提交；`git status` 干净 |
| 2 | 控制面 | `pnpm install && pnpm lint && pnpm typecheck --force && pnpm test --force && pnpm build --force` | 全部 exit 0；测试 81 个（console 49、contract 17、compiler 12、db 3），含 M2 过程的用例、租户隔离与租户成员调用后台过程 403，以及"每个过程都已归类"的断言；`test/web` 的 i18n 与 ui-rules 通过 |
| 3 | proto / 节点 | `buf lint proto`；`buf breaking` 对 `proto/v0.1.0`；tag `proto/v0.2.0`；edgeweir-node `go vet ./...`、`go test ./...`、`make proto-check`、`make lua-test`、`bash test/e2e/run.sh` | 全部 exit 0；`make proto-check` 从 `proto/v0.2.0` 重新生成无差异；Lua 36 个用例（数据面 20、SigV4 16）；节点容器冒烟测试通过 |
| 4 | 端到端 | `docker compose -f compose.e2e.yml down -v && docker compose -f compose.e2e.yml up -d --build`、`bash scripts/e2e.sh`（环境变量见待决策 42） | 输出 `E2E OK`：M1 全链路（含 Playwright 冒烟与 M1）→ URL 刷新后 `MISS`、其他 URL 仍 `HIT` → 前缀刷新只影响前缀 → 预热后首个请求 `HIT`、全站刷新后 `MISS` → 忽略查询参数 `?a=1` 与 `?a=2` 同一缓存、参数排序 `?a=1&b=2` 与 `?b=2&a=1` 同一缓存 → Range 请求命中 slice 缓存且字节与源站一致 → whoami `/echo` 经节点收发 WebSocket、关闭 WebSocket 的站点返回 403 → 自签名 HTTPS 源站校验失败 502、关闭校验后 200 → S3 网关 SigV4 签名回源成功并缓存、POST 返回 405 → 主源停掉后 stale-if-error 返回 `STALE`、流量落到备用源、控制台显示主源不可用，恢复后回到主源 → Playwright M2（提交 URL 刷新和目录刷新并看到节点结果、源站健康徽标、设置卡片、键盘拖动排序，无 `pageerror`）→ 节点停用 / 启用 / 删除 |
| 5 | 界面规范 | Playwright 截图（浅色/深色、1280/375，断言无横向溢出与 `pageerror`）；`ui-rules.test.ts` | 源站 Tab、缓存 Tab、刷新预热页无副标题与说明段落、无骨架屏、appica 只经 `components/appica`；375px 下无横向滚动 |

说明：Claude 桌面应用的内置浏览器会拦截 `GET /api/auth/*`，界面检查继续用 Playwright 截图完成。

## 收尾（2026-09-25 审计）

需求来源：[docs/audits/2026-09-25-wrapup.md](docs/audits/2026-09-25-wrapup.md)（原件在 `~/Developer/edgeweir-research/`）。按审计编号逐项勾选；每项后面是证明修复的测试（Vitest 为 `文件 › describe › it`，Go 为测试函数，Lua 为 `test/lua/run.lua` 的用例名，e2e 为 `scripts/e2e.sh` 的步骤）。收尾期间新增的决策见上方待决策 44–70。

### 1. 集成

- [x] **I1** 落地页与主题的未提交改动按功能提交（主题 `90040b3`、落地页接口 `b1ae334`、落地页界面 `594cea0`、e2e `6549274`、文档 `57c08a4`），提交前 lint、typecheck、test 通过；`.claude/launch.json` 提交，`.claude/` 其余内容忽略（`c3d5fca`，待决策 44）。
- [x] **I2** `git merge --no-ff mvp-m2`（`aed149d`），未 rebase；`git merge-base --is-ancestor proto/v0.2.0 master` 退出 0。
- [x] **I3** 保留 `0002_site_star`，删除 `0002_m2`，用 `pnpm db:generate` 从合并后的 schema 重新生成 `0003_m2`（语句与原 `0002_m2` 完全相同）。测试：`packages/db/test/migrations.test.ts › migration journal › has unique tags and contiguous indexes that match the tag prefix`、`› has strictly increasing timestamps (drizzle skips migrations older than the last applied)`、`› has exactly one SQL file and one snapshot per entry`。旧数据卷需要重建（待决策 45）。
- [x] **I4** `admin.test.ts` 的控制台清单加入 `sites.starred`、`sites.setStarred`、`analytics.traffic`、`analytics.topSites`、`analytics.breakdown`、`landing.get`（`landing.update` 在 403 表），收尾新增的后台过程 `settings.originAllowList`、`settings.setOriginAllowList` 也在 403 表。测试：`test/server/admin.test.ts › admin area procedures › refuses every admin-area procedure to a tenant member with 403`（断言每个契约过程都已归类）。
- [x] **I5** 待决策统一重编号（数据展示 26–28、落地页 29–30、M2 31–43），第 43 条改写为实际的合并方式，第 10 条移回 9 与 11 之间；"MVP 分为 5 个里程碑"改为 6 个；ROADMAP 两边的勾选合并（M2 各项、分钟级统计）。
- [x] **I6** 节点仓库新增 `scripts/sync-adr.sh`（只把指向控制面文件的相对链接改写为 GitHub 链接，`--check` 检查一致），ADR README 说明镜像关系；收尾的 ADR 更新记录已同步，`scripts/sync-adr.sh --check` 通过。
- [x] **I7** 已删除两个仓库的 `mvp-m2`、控制面的 `feat/analytics-redesign`（数据展示会话在合并后已删）；`git worktree remove` 移除 `~/Developer/m2/edgeweir`、`~/Developer/m2/edgeweir-node`、`~/Developer/edgeweir-analytics`（`~/Developer/m2` 里的日志等文件保留）。

### 2. 必修：控制面

- [x] **CP-C1** `/api/auth/*` 前加方法 + 路径白名单（`lib/auth.ts` 的 `AUTH_HTTP_ROUTES`），其余 404；`/api/auth/*` 上删除 `x-api-key`（待决策 47）。Vitest：`test/server/auth-routes.test.ts › /api/auth allow list › does not let an organization owner delete the organization through better-auth`、`› refuses the admin plugin endpoints, even to a platform administrator`、`› never turns an x-api-key into a session on /api/auth`、`› answers 404 for every path and method outside the list`、`› keeps the flows the web console uses working`、`› leaves server-side auth.api calls working`。e2e：步骤「CP-C1: better-auth's organization and admin endpoints are closed, even for an owner and platform admin」（5 个 `organization/*`、6 个 `admin/*` 端点对 owner 与平台管理员返回 404，组织、角色、密码不变）与「CP-C1: an x-api-key alone never becomes a better-auth session」（只带 `x-api-key` 时 `get-session` 为 null、`api-key/create` 401、`/rpc` 401）。
- [x] **CP-H3** 回滚在同一事务写 `cluster.rollback` 审计。Vitest：`test/server/rollback.test.ts › configuration rollback › publishes the old content as a new revision and audits it`、`› writes nothing for unknown revisions or clusters`、`› keeps no revision when its audit entry cannot be written (same transaction)`。
- [x] **CP-H4** better-auth 的改密码、TOTP 开关、passkey 增删、API key 增删和登录（成功 / 失败）都写审计（`lib/auth-audit.ts`，待决策 48）。Vitest：`test/server/auth-audit.test.ts › audit entries for better-auth account events › records a password change`、`› records enabling TOTP, the second-factor sign-in, and disabling it`、`› records adding a passkey, signing in with it and deleting it`、`› records API key creation and deletion without the key`、`› records successful and failed password sign-ins with the client address`。
- [x] **CP-H5** `EDGEWEIR_TRUSTED_PROXIES`：只有来自可信对端的 `X-Forwarded-For` / `X-Real-IP` 才采用（审计 IP 与 better-auth 限速键同一个值）；登录限速存数据库（迁移 `0004_wrapup_auth`，待决策 52）。Vitest：`test/server/client-ip.test.ts › client IP resolution › ignores forwarding headers from an untrusted peer`、`› client IP on audit entries and sessions › ignores X-Forwarded-For from an untrusted peer`、`› honors X-Forwarded-For from a trusted proxy`、`› better-auth rate limiting › keeps the counters in the database, shared across instances and restarts`。
- [x] **CP-H6** 文档里的主密钥命令改为 `openssl rand -base64 32` 原样使用，`.env.example`、compose 注释一起改（待决策 51）。Vitest：`test/server/master-key-docs.test.ts › documented secret generation commands › only produce master keys that envelope.ts accepts (200 runs each)`、`› produce database passwords that fit into DATABASE_URL unescaped`。
- [x] **CP-H7** mvp.md 0.1「营销页例外」与 0.2（控制台首页 `/overview`），ADR-0003 更新记录；模板改为中性名称，去掉竞品名称与"仿照"注释；落地页挂载时固定浅色，`theme-init.js` 对 `/` 不加 `.dark`；Rubik 自托管并记入 ADR（待决策 64）。测试：`test/web/ui-rules.test.ts › keeps the landing templates neutral: no other vendor's name in their code or copy`；Playwright `e2e/landing.spec.ts › landing page template and login-aware header`（375px 无横向溢出、深色系统与已存深色选择下仍为浅色、离开后恢复深色、无第三方请求、无 `pageerror`）。
- [x] **CP-H8** 统一为"绝不存 SSH 凭据"：SECURITY.md 改正，ADR-0016（决策 5）、ADR-0018 追加更新记录，原文不动。
- [x] **CP-M1** 信封 v2 的附加数据绑定用途与记录 id（源站凭据、CA 私钥、setup token），启动时把 v1 一次性重新封装（待决策 50）。Vitest：`test/server/crypto.test.ts › MasterKey envelopes › binds the record id: a ciphertext swapped into another row does not open`、`› opens legacy (v1) envelopes only through the upgrade path`；`test/server/envelope-upgrade.test.ts › legacy envelope upgrade › re-seals every legacy envelope bound to its record id, once`、`› refuses a ciphertext swapped between rows after the upgrade`。
- [x] **CP-M2** e2e：步骤「M2 / CP-M2: Range requests are served from the slice cache; the origin only sees 1 MiB slices」（断言源站日志里只有 `bytes=0-1048575`、`bytes=1048576-2097151`）；步骤「M2 / N-H4: HTTPS origins are verified against their name with the trusted CA, unless verification is off」（受信 CA + 名称匹配 200、受信 CA + 名称不符 502 且控制台显示 `tls_failed`、自签名 502、关闭校验 200，并断言节点错误日志）；源站证书校验的日志检查去掉了 `|| true`。
- [x] **CP-M3** 节点：重试只在主源之间，主源全部不可用才用备用（Lua `lb.order uses backups only when every primary is down`）；控制面：任务只下发给启用的节点，停用时进行中的任务行标为已跳过（`test/server/cache-tasks.test.ts › cache task delivery › disabled nodes (CP-M3) › dispatches only to enabled nodes and lists disabled ones as skipped`、`› skips a node's pending and running deliveries when it is disabled`）；升级说明见下方「升级说明」与 [docs/guide/origins-and-cache.md](docs/guide/origins-and-cache.md)。
- [x] **CP-M5** users、enrollment、members、landing、setup、邀请接受、证书续期的审计移进业务事务。Vitest：`test/server/audit-transactions.test.ts › audit entries share the business transaction`（6 个用例，例如 `› stores no enrollment token without its audit entry`、`› leaves the landing page settings unchanged`）。
- [x] **CP-M6** Vitest：`test/server/tenancy.test.ts › overview, whole-site purge and tenant isolation › overview.get counts the platform for administrators and only the organization's sites for tenants`、`› sites.purgeAll bumps the cache generation, publishes a revision and audits it`、`› refuses to delete or purge another organization's site and changes nothing`、`› refuses cache tasks on another organization's site and never creates a partial task`；回滚见 CP-H3。
- [x] **CP-M7** spinner、dialog / sheet 的关闭、sidebar、面包屑、命令面板的无障碍标签全部走 Paraglide（`7195c8d`），由 CP-M8 的英文字面量检查覆盖。
- [x] **CP-M8** `test/web/i18n.test.ts › keeps English UI text out of components (JSX text, labels and accessibility attributes)`；`test/web/ui-rules.test.ts › never uses skeleton placeholders or pulsing blocks…`、`› uses no description slots…`、`› spells out no colors in TS/TSX…`、`› links nothing on other sites except a short allow list…`；检查发现的违规已全部修正（约 200 处颜色移入 CSS token、说明槽位改为 `SafetyNote`）。
- [x] **CP-M9** 节点上报错误码 + 参数（proto v0.2.1），控制面存储并本地化，未知码回退原文（待决策 58）。测试：`test/server/node-channel.test.ts › stores the error codes nodes report and returns them with the text (CP-M9)`；`test/web/i18n.test.ts › localizes every node error code and task outcome code with the same parameters`；`test/web/node-errors.test.ts › node error texts`；节点 Lua `origin.classify…`、`health reports error codes…`，Go `TestAgentPrefetchFailureCodes`、`TestAgentReportsUnsupportedTasks`。
- [x] **CP-M10a** `ReportStats` 一次请求一条 upsert 语句（批内先合并重复键）。Vitest：`test/server/stats.test.ts › node minute stats ingestion (ReportStats) › stores a full report of 5000 buckets with a single statement`、`› sums buckets of the same minute and site inside one report`、`› adds counters across reports and merges status codes key by key`。
- [x] **CP-M11** README、ARCHITECTURE 不再把 certd、ClickHouse 写成可用；数据模型、迁移列表与开发说明与代码一致；ADR-0002、ADR-0003 的原地修改改回原文并写更新记录（ADR-0014 经逐提交比对只有追加，偏差见待决策 65）；各 ADR 追加收尾更新记录。
- [x] **CP-L** 迁移锁在同一连接上加 / 解（`packages/db/test/migrate.test.ts › runMigrations › locks, migrates and unlocks on one dedicated connection`、`› unlocks and discards the connection when a migration fails`）；公开过程在 OpenAPI 里 `security: []`（`test/server/openapi.test.ts › OpenAPI security requirements › requires the API key by default and not for public procedures`）；接受邀请返回 `INVITATION_ACCOUNT_REQUIRED`（`test/server/console.test.ts › console procedures › asks a new invitee for a name and password with a stable error code`）；主题 provider 的 localStorage 全部 try/catch（`test/web/theme.test.ts › theme storage (ThemeProvider)`、`› theme-init.js (first paint)`）；`/` 加载时显示 `LoadingState`、失败显示错误态（Playwright landing 用例）；`.env.example` 补齐（`test/server/env-example.test.ts › documents every variable the console reads`、`› documents the variables compose files interpolate`）。

### 2. 必修：节点与一键安装

- [x] **N-H1** 控制台 `/downloads/*` 从 `EDGEWEIR_DOWNLOADS_DIR` 提供镜像文件，其余 404，`/downloads`、`/api`、`/rpc`、`/install.sh`、`/healthz` 不走 SPA 兜底；install.sh 重写（`main` 函数、semver 校验、优先 .deb/.rpm、tar.gz 路径修正并建用户、cosign 缺失时下载 v3.1.3 并校验 SHA-256、签名身份精确匹配版本 tag、token 只经 `EDGEWEIR_TOKEN` 或 `--token-file`、`--no-start`）；节点 `enroll` 读取 `EDGEWEIR_TOKEN` / `--token-file`（待决策 53、54）。测试：`test/server/downloads.test.ts › /downloads release mirror › answers 404 for files that are not mirrored and for traversal attempts`、`› never falls back to the SPA shell for server paths`；`test/server/install-script.test.ts › install.sh › is only function definitions until \`main\` on the last line`、`› verifies the signature against exactly the tag being installed, before installing`、`› pins cosign v3.1.3 by SHA-256 and passes the token to enroll through the environment`、`› refuses --token on the command line`、`› executes nothing when the download is cut short`；节点 `TestEnrollTokenSources`、`TestEnrollReadsTokenFromEnvAndFile`；e2e：步骤「N-H1」：控制台 `/downloads` 镜像 goreleaser snapshot（未镜像的版本和文件 404），`debian` 容器里 `curl …/install.sh | bash -s -- … --allow-unsigned --no-start --mirror …` 安装 .deb 与 OpenResty、创建 `edgeweir` 系统用户、文件与权限符合包定义、注册成功（证书指纹与控制台一致），再按 unit 的 `User=`/`ExecStart=` 启动后节点在线（待决策 54、68）。
- [x] **N-H2** 节点拒绝特殊用途地址（配置字面量与每个 DNS 应答），平台允许清单经 `NodeConfig.origin_allowed_cidrs` 下发；控制面同样校验；边缘加 `CDN-Loop`（RFC 8586），带本节点标识的请求返回 508（待决策 55）。测试：节点 `TestAddressPolicyForbiddenRanges`、`TestAddressPolicyAllowList`、`TestBuildRefusesSpecialPurposeOrigins`、`TestCDNID`，Lua `dns drops special-purpose answers`、`router CDN-Loop detection and header value`；控制面 `test/server/origin-allow-list.test.ts › refuses loopback, metadata, private, IPv6 loopback, mapped and localhost origins`、`› allows listed ranges and compiles the list into every cluster with a new revision`、`packages/contract/test/addresses.test.ts`；e2e：控制台对 `127.0.0.1`、`169.254.169.254`、`10.0.0.10` 的创建和更新都返回 `ORIGIN_ADDRESS_FORBIDDEN` 且不发布；解析到未放行网段（`172.28.214.0/24`）的主机名源站由节点返回 502，控制台源站健康显示 `address_forbidden`；Playwright M1 检查本地化提示；源站指向节点自己时返回 508，`CDN-Loop` 按 RFC 8586 追加本节点标识，带本节点标识的请求 508。
- [x] **N-H3** 每站点标记上限后合并为站点级标记；存储大小可配置（`--purge-dict-mb`）；增量计数与集合标识；装载失败退化为站点级标记；站点表推送不依赖清缓存同步；控制台按组织限制清缓存频率（待决策 56、59）。测试：`TestAgentServesSitesWhenPurgeSyncFails`、`TestAgentFallsBackToSiteLevelMarkers`、`TestAgentPurgeMarkersPerSiteCap`、`TestPurgeStateCollapsesSitesOverTheCap`、`TestPurgeStateIDIsIncremental`、`TestRenderPurgeDictSize`，Lua `purge status comes from counters…`、`purge replace collapses a site that does not fit…`；`test/server/cache-tasks.test.ts › per-organization rate limit (N-H3) › refuses more than the tasks per minute with CACHE_TASK_RATE_LIMITED and a retry time`、`› refuses more than the URLs per hour, counting every target`。
- [x] **N-H4** 按源站的 SNI / Host 校验证书名称（`proxy_ssl_name $edgeweir_ssl_name`），并关闭 upstream 块的 keepalive（待决策 63）。测试：`TestRenderOriginTLSName`；e2e：步骤「M2 / N-H4: HTTPS origins are verified against their name with the trusted CA, unless verification is off」（受信 CA + 名称匹配 200、受信 CA + 名称不符 502 且控制台显示 `tls_failed`、自签名 502、关闭校验 200，并断言节点错误日志）。
- [x] **N-M1** 缓存键读取全部请求头，与剥离头部用同一张表；每段转义。Lua `cachekey parts are escaped so no value can imitate another part`。
- [x] **N-M2** 缓存键与清缓存用同一规范化路径。Lua `cachekey.normalize_path matches nginx's $uri`、`purge markers match encoded variants of their paths`。
- [x] **N-M3** 节点首次应用时自己分配标记时间 `max(now, last+1)`，按任务 id 持久化。`TestPurgeTaskEpochAssignedByNode`、`TestAgentPurgeEpochPerTask`。
- [x] **N-M4** 节点重连时控制台把过期未执行的清缓存标为 `task_expired`，按组织给该节点补发一次全站刷新（待决策 57）。`test/server/cache-tasks.test.ts › purges a node missed (N-M4) › makes up purges that expired while the node was offline, once, with a whole-site purge`；`test/server/node-channel.test.ts › hands a node back after more than 7 days a whole-site purge for expired purges (N-M4)`。
- [x] **N-M6** Host 未命中用独立的小缓存（1024 条）。Lua `store: a Host flood cannot evict decoded sites or their balancing state`。
- [x] **N-M7** 清缓存先于预热；预热有时间预算（`--prefetch-budget`，待决策 60）。`TestAgentRunsPurgesBeforePrefetches`、`TestAgentPrefetchTimeBudget`。
- [x] **N-M9** 带 `Authorization` 的请求默认不查也不存缓存，规则勾选 `cacheAuthorized`（proto `cache_authorized`）才缓存（待决策 61）。Lua `requests with Authorization bypass the cache unless the rule allows them`；`TestBuildCacheAuthorized`；`packages/contract/test/schemas.test.ts › does not cache requests with Authorization unless a rule allows it`、`packages/config-compiler/test/compiler.test.ts › compiles cacheAuthorized per rule, off unless a rule asks for it`。
- [x] **N-M11** 节点 ARCHITECTURE、SECURITY、README、ROADMAP、CLAUDE.md 与代码对齐（proto v0.2.2、负载均衡、stale、内部头、WebSocket、清缓存与健康检查的端点和存储、任务循环、`credentials.json`、`purge.json`、新参数）。
- [x] **N-L** `go.mod` 固定 `go 1.27.1`（certd 同样）；SIGHUP 后校验 reload（`TestAgentReportsFailedReload`、`TestRenderConfID`）；轮询加 ±20% 抖动（`TestJitteredPollInterval`）；PROXY protocol 监听以 PROXY 头的客户端地址作为 `$remote_addr`（`TestRenderProxyProtocolRealIP`），预热不用 PROXY protocol 监听（`TestAgentPrefetchAvoidsProxyProtocolListeners`）；id 校验（`TestBuildRejectsUnsafeIDs`）；S3 回源删除客户端 `x-amz-*` 头（Lua `origin.amz_headers finds the client's x-amz-* headers…`，e2e：S3 步骤带伪造的 `x-amz-*` 头仍签名成功，源站只看到节点自己的 `X-Amz-Date` / `X-Amz-Content-Sha256`）；新增测试：未知任务类型 `TestAgentReportsUnsupportedTasks`、旧 revision `TestAgentIgnoresOlderRevisions`、`TestAgentDoesNotRetryRejectedRevision`，`controlplane` 包 `TestParseServerURL`、`TestIsAuthError`、`TestNewPinnedClientValidatesURL`、`TestChannelMTLSAndReload`，`hostinfo` 包 `TestCollect`、`TestIPAddresses`、`TestHostnameAndProbes`；共享字典名保留：`TestBuildSkipsCacheZonesNamedLikeSharedDicts`、`TestRenderedSharedDictsAreReservedZoneNames`（`configir.SharedDicts` 一处定义，缓存区不能与共享字典同名）。

### 3. 延后（已写进对应里程碑）

- [x] **D1** 最低 agent 版本门槛 → [mvp.md](docs/specs/mvp.md) 第 3 节 M3「兼容性」与 M3 验收、第 8 节 M3 行、0.5 节；ROADMAP MVP「协议与证书」。
- [x] **D2** `ReportStats` 重试去重、小时 / 天汇总与保留 → mvp.md 第 5 节 M5「统计」与验收、0.5 节；ROADMAP MVP「运维」。
- [x] **D3** 备份恢复后的 revision 序号 → mvp.md 第 6 节 M6「备份与恢复」与验收、0.5 节；ROADMAP「运维」。
- [x] **D4** 预热的移动变体、前缀与全站预热 → ROADMAP v1「缓存与调度」（节点 ROADMAP 同）。
- [x] **D5** 镜像与 GitHub Actions 按 digest / SHA 固定 → ROADMAP「首次正式发布前」，ADR-0017 收尾更新记录。
- [x] **D6** 节点 CI 的 proto 一致性检查依赖公开仓库 → mvp.md 0.4 最后一行（保留）、ROADMAP「首次正式发布前」。

### 升级说明（M2 与收尾）

- 回源 HTTPS 从 M2 起默认校验证书（系统 CA 或节点的 `--trusted-ca`），校验名称是源站的回源 Host / SNI。自签名证书的源站要么换成受信证书，要么在源站 Tab 关闭校验；按 IP 配置的 HTTPS 源站要设置证书覆盖的回源 Host 或 SNI。
- 特殊用途地址（环回、链路本地、私网、CGNAT 等）的源站默认被拒：编辑时控制台报 `ORIGIN_ADDRESS_FORBIDDEN`，节点运行时返回 502。源站在内网的部署先在后台「系统设置」加入源站地址允许清单。
- 旧的一行安装命令（`--token`）不再可用，从控制台重新复制；反向代理后面部署控制台时设置 `EDGEWEIR_TRUSTED_PROXIES`，否则审计 IP 和登录限速按代理地址计算。
- 迁移重新编号，1.0 之前的开发 / e2e 数据卷需要重建（待决策 45）；多实例控制台要同时升级（信封 v2，待决策 50）。
- 含百分号转义的 URL 升级后缓存键变化一次；带 `Authorization` 的请求默认不再缓存。

### 验证记录（2026-09-26，本机实跑，`master`）

| # | 验收项 | 命令 | 结果 |
| --- | --- | --- | --- |
| 1 | 集成 | `git merge-base --is-ancestor proto/v0.2.0 master`；`git worktree list`、`git branch -a`（两个仓库）；节点 `scripts/sync-adr.sh --check` | 退出 0；两个仓库都只剩 `master` 与主工作区，`mvp-m2`、`feat/analytics-redesign` 已删；ADR 镜像一致 |
| 2 | 控制面 | `pnpm install && pnpm lint && pnpm typecheck --force && pnpm test --force && pnpm build --force` | 全部 exit 0；测试 218 个（console 165、contract 29、compiler 16、db 8） |
| 3 | proto / certd | `pnpm proto:gen && git diff --exit-code -- packages/proto`；`helpers/certd` 的 `go vet ./...`、`go test ./...` | 全部 exit 0；proto tag `proto/v0.2.1`（新字段）、`proto/v0.2.2`（只改注释），`buf breaking` 对 v0.2.0 通过 |
| 4 | 节点 | `go vet ./...`、`go test -race ./...`、`make proto-check`、`make lua-test`、`goreleaser check` | 全部 exit 0；Lua 36 + 16 个用例；`make proto-check` 从 `proto/v0.2.2` 生成无差异 |
| 5 | 端到端 | `COMPOSE_PROJECT_NAME=edgeweir-wrapup E2E_CONSOLE_PORT=13200 E2E_NODE_PORT=18280 E2E_TAG=wrapup`：`docker compose -f compose.e2e.yml down -v && docker compose -f compose.e2e.yml up -d --build && bash scripts/e2e.sh` | 输出 `E2E OK`，50 个 PASS、0 个 FAIL；Playwright setup、smoke（2）、M1、landing、analytics、M2 全部通过，无 `pageerror`；收尾新增的 7 类用例见上方各项的 e2e 步骤；结束后只清理了 `edgeweir-wrapup` 项目 |
| 6 | 仓库与文档 | `git status`（两个仓库）；README、ARCHITECTURE、SECURITY、ROADMAP、CLAUDE.md 对照代码 | 两个仓库干净；文档由收尾各环节对照代码更新（见 CP-M11、N-M11） |
