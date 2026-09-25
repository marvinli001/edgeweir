# Edgeweir Phase 0 进度

规格来源：[BOOTSTRAP.md](BOOTSTRAP.md)（唯一需求来源）。本文件逐项勾选 Phase 0 交付物。

## 待决策

> 需要维护者拍板的事项。每条都已选了默认值并继续推进；如需改动，告诉我即可。

1. **BOOTSTRAP.md 来源**：会话开始时工作区根目录没有 `BOOTSTRAP.md`。在本机
   `~/Library/Application Support/Claude/scratch-workspaces/.../edgeweir-bootstrap-prompt.md`
   找到内容完全对应的规格（2026-09-25 13:32 修改），已原样复制为 `BOOTSTRAP.md`。
   **默认**：以该文件为准。
2. **工作区布局**：`edgeweir/`（本仓库，也是工作区根目录）与 `edgeweir-node/` 是同级目录
   （`~/Developer/edgeweir`、`~/Developer/edgeweir-node`）。`BOOTSTRAP.md`、`PROGRESS.md` 放在
   `edgeweir` 仓库根目录并提交，这样 `git status` 保持干净。**默认**：保持同级布局；
   compose.e2e.yml 通过 `EDGEWEIR_NODE_CONTEXT`（默认 `../edgeweir-node`）引用节点仓库。
3. **本机全局 pnpm 升级**：本机原有 pnpm 9.12.0，官方最新为 12.6.0。已执行
   `npm i -g pnpm@12.6.0`，并在 `package.json#packageManager` 锁定 `pnpm@12.6.0`。
4. **本机安装 buf / goreleaser**：两者原本未安装，已通过 Homebrew 安装 buf 1.73.0、
   goreleaser 2.18.2（仅本机开发工具，不发布任何东西）。

## 版本核实记录（2026-09-25，来源：npm registry / proxy.golang.org / Docker Hub / nodejs.org）

| 组件 | BOOTSTRAP 快照 | 核实后使用 | 备注 |
| --- | --- | --- | --- |
| Node.js | 24 LTS | 24.21.0 (Krypton)，镜像 `node:24.21.0-alpine` | 本机为 25.6.1，仅开发使用 |
| pnpm | — | 12.6.0 | |
| Go | — | 1.27.1，镜像 `golang:1.27.1-alpine` | |
| PostgreSQL | 18 | `postgres:18.6-alpine` | |
| OpenResty | 官方包/镜像 | `openresty/openresty:1.31.1.1-bookworm` | |

## Phase 0 交付清单（BOOTSTRAP §3）

### 1. 仓库基础
- [ ] edgeweir：git init、LICENSE (AGPL-3.0)、README.md / README.zh-CN.md（含品牌故事）
- [ ] edgeweir：ARCHITECTURE.md、docs/adr/（§2 每条决策一篇）、ROADMAP.md、SECURITY.md、CONTRIBUTING.md、CLAUDE.md、.editorconfig
- [ ] edgeweir：GitHub Actions（lint、typecheck、test、build 镜像、e2e）
- [ ] edgeweir-node：同上全套文档
- [ ] edgeweir-node：GitHub Actions（go test、goreleaser snapshot）

### 2. 控制面骨架
- [ ] monorepo：apps/console（src/server + src/web）、packages/db、packages/contract、packages/config-compiler、proto/
- [ ] shadcn preset b2D0wqNxT 初始化（Vite 模板），Biome 替换 ESLint
- [ ] i18n：zh-CN（默认）/ en
- [ ] 数据模型 v0（better-auth + cluster/node_group/node/node_ip/enrollment_token/site/site_domain/origin_pool/origin/cache_rule/config_revision/node_config_status/audit_log）
- [ ] oRPC 契约 + OpenAPI `/api/v1`（AccessKey）
- [ ] 页面：登录、初始化向导、概览、集群与节点、网站、设置（空/加载/错误态）
- [ ] proto v0：NodeService（Enroll/WatchConfig/GetConfig/ReportStatus/ReportStats）+ NodeConfig IR
- [ ] 节点通道：Connect-RPC :8443，应用自终结 TLS，注册后强制 mTLS
- [ ] 配置编译 + revision + LISTEN/NOTIFY
- [ ] pg-boss worker，ROLE=app|worker|all
- [ ] helpers/certd（Go 骨架，多阶段构建进镜像）

### 3. 节点骨架
- [ ] Go agent：enroll → mTLS → watch → 快照落盘 → 渲染 nginx.conf → unix socket 推站点表
- [ ] Lua：按 Host 路由 + proxy_cache + X-Cache 头
- [ ] agent 回报已应用 revision
- [ ] goreleaser 配置（deb/rpm/tar.gz，amd64/arm64，cosign、SBOM）

### 4. 端到端
- [ ] compose.e2e.yml（postgres + console + node + whoami）
- [ ] e2e 脚本：注册 + mTLS、创建 demo.test、MISS→HIT、控制台显示在线 + revision
- [ ] Playwright 冒烟（登录 → 集群节点 → 网站）

### 5. 部署
- [ ] 多阶段 Dockerfile（非 root、ROLE）
- [ ] compose.yml（+ analytics / cache profile）
- [ ] compose.baota.yml + docs/deploy/baota.md
- [ ] docs/deploy/docker.md

## 与 BOOTSTRAP 的偏差 / ADR 更新

（随进度补充）

## 验证记录

（最终轮贴出每条验收命令与输出）
