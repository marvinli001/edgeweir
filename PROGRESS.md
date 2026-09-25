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
10. **appica-ui 1.2.0 发布不满 1 天**：pnpm 的最小发布时间检查把 `@appica/ui-react@1.2.0` 自动加入
    `minimumReleaseAgeExclude`（与已有的 better-auth、turbo、vite 例外做法一致）。**默认**：保留 1.2.0；若要严格执行
    发布时间门槛，可改用 1.1.0（2026-08-11 发布），需要重新核对用到的组件。
7. **初始化窗口风险**：初始化向导完成前，任何能访问控制台的人都能创建管理员。**默认**：文档中提示
   "先完成向导再对公网开放 3000"；后续可增加一次性 setup token（写入 ROADMAP 风险项）。
   **MVP M1 已解决**：初始化必须输入启动日志里的一次性 setup token（见下方 MVP M1）。
8. **开放 API 与 UI 的凭据分离**：`/api/v1` 只接受 `x-api-key`，`/rpc` 只接受会话 cookie（且要求 CSRF 头）。
   **默认**采用（更安全），见 ADR-0005 更新记录。
9. **e2e 端口**：本机 8443、5432 被 SSH 隧道占用。compose.e2e.yml 不向宿主机发布 8443（节点在容器网络内
   访问 `https://console:8443`），控制台映射到 `localhost:13000`，节点 HTTP 映射到 `localhost:18080`
   （均可用 `E2E_CONSOLE_PORT` / `E2E_NODE_PORT` 覆盖）。

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
    **默认**：不保留旧的数组形式。
17. **setup token 的交付**：打印在控制台日志（JSON 的 `setupToken` 字段），多实例、重启打印同一个 token；不提供环境变量预置。
    **默认**如此；需要全自动部署时可再加 `EDGEWEIR_SETUP_TOKEN`。
18. **租户选择集群**：租户成员新建网站不能指定集群（`CLUSTER_SELECTION_FORBIDDEN`），落在组织默认集群；平台管理员可指定。
    **默认**如此。
19. **TOTP 二维码依赖**：用 uqr 0.1.3（MIT、无依赖）生成二维码矩阵，自己画 SVG。**默认**采用。

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

- proto v0.1.0 没有下发证书材料的接口，节点暂不启用 HTTPS 监听；回源 HTTPS 暂不校验证书。
- 清缓存只支持全站（cache generation），URL/前缀/tag 清除和预热、节点自升级、访问日志采样上报属于 MVP。
- 负载均衡的 round_robin / consistent_hash 在节点侧暂按加权随机处理，无被动健康检查。
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

规格与每个里程碑的 `/goal` 提示词见 [docs/specs/mvp.md](docs/specs/mvp.md)。MVP 分为 5 个里程碑（M1 集群、租户与站点基础 → M2 源站与缓存 → M3 HTTPS、证书与协议 → M4 访问控制与规则引擎 → M5 DNS、统计、告警与开放 API），Phase 0 的已知限制已分配到对应里程碑。

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
