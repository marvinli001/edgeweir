# Edgeweir Phase 0 进度

规格来源：[BOOTSTRAP.md](BOOTSTRAP.md)（唯一需求来源）。本文件逐项勾选 Phase 0 交付物。

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
7. **初始化窗口风险**：初始化向导完成前，任何能访问控制台的人都能创建管理员。**默认**：文档中提示
   "先完成向导再对公网开放 3000"；后续可增加一次性 setup token（写入 ROADMAP 风险项）。
8. **开放 API 与 UI 的凭据分离**：`/api/v1` 只接受 `x-api-key`，`/rpc` 只接受会话 cookie（且要求 CSRF 头）。
   **默认**采用（更安全），见 ADR-0005 更新记录。
9. **e2e 端口**：本机 8443、5432 被 SSH 隧道占用。compose.e2e.yml 不向宿主机发布 8443（节点在容器网络内
   访问 `https://console:8443`），控制台映射到 `localhost:13000`，节点 HTTP 映射到 `localhost:18080`
   （均可用 `E2E_CONSOLE_PORT` / `E2E_NODE_PORT` 覆盖）。

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
- [ ] edgeweir-node：同上全套文档（进行中，ADR 由本仓库镜像过去）
- [ ] edgeweir-node：GitHub Actions（go test、goreleaser snapshot）

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
- [ ] Go agent：enroll → mTLS → watch → 快照落盘 → 渲染最小 nginx.conf → unix socket 推站点表
- [ ] Lua：按 Host 路由 + proxy_cache + X-Cache 头
- [ ] agent 回报已应用 revision
- [ ] goreleaser 配置（deb/rpm/tar.gz，amd64/arm64，cosign、SBOM）

### 4. 端到端
- [x] compose.e2e.yml（postgres + console + node + whoami）
- [x] e2e 脚本 scripts/e2e.sh（注册 + CA 指纹校验 + token 单次使用 + mTLS、创建 demo.test、MISS→HIT、控制台显示在线 + revision）
- [x] Playwright 冒烟（登录 → 集群节点 → 网站 → 切换英文）
- [ ] 全流程实跑通过（等待节点仓库完成）

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

## 验证记录

（最终轮贴出每条验收命令与输出）
