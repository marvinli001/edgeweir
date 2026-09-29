# 开发与贡献

开发环境、检查命令、代码约定与变更流程。

## 基本要求

- 较大的改动先开 issue。
- 以下改动先写 ADR（见 [ADR 流程](#adr-流程)）：新依赖、进程或部署形态、节点通道协议、`NodeConfig` IR 语义、安全基线。
- 安全漏洞按 [SECURITY.md](SECURITY.md) 私下报告，不开公开 issue。
- 违反下表原则的 PR 不合入（[ADR-0018](docs/adr/0018-trust-and-security-baseline.md)、[ADR-0019](docs/adr/0019-open-core-and-commercial-products.md)）。

| 原则 | 要求 |
| --- | --- |
| 回连与授权 | 无 phone-home，无许可证校验代码 |
| 遥测 | 默认关闭；第三方依赖的遥测强制关闭 |
| 敏感数据 | 私钥、DNS API 凭据等经 `EDGEWEIR_MASTER_KEY` 信封加密后入库；不保存 SSH 凭据 |
| 节点身份 | 节点通道自行终结 TLS；注册 token 单次有效，仅存 SHA-256；注册后节点 RPC 一律 mTLS |
| API 凭据 | `/api/v1` 只接受 `x-api-key`；`/rpc` 只接受会话 Cookie 与 CSRF 请求头 |
| 审计 | 管理操作写审计日志 |
| 产品边界 | 客户门户、套餐计费、财务与分销不以许可证开关的形式进入核心代码（[LICENSING.md](LICENSING.md)） |
| 测试 | 不以跳过、删除或弱化测试的方式让检查通过 |
| 依赖 | 使用前按官方文档核实依赖的 API 与版本 |

## 开发环境

| 工具 | 版本 | 用途 |
| --- | --- | --- |
| Node.js | 24.11 及以上（`.nvmrc`：`24`） | 全部开发命令 |
| pnpm | 12（`packageManager`：`pnpm@12.6.0`） | workspace 与脚本；`corepack enable` 或 `npm i -g pnpm@12` |
| Docker、Compose v2 | — | 本地 PostgreSQL（`compose.dev.yml`）、端到端测试 |
| Go | 1.27.1 | `helpers/certd`、`pnpm e2e` |
| buf | 1.73.0 | 随开发依赖安装（`@bufbuild/buf`），由 `pnpm lint` 与 `pnpm proto:*` 调用 |

端到端测试另需：curl、jq、goreleaser v2、syft、cosign v3.1.3，与本仓库同级的 [edgeweir-node](https://github.com/marvinli001/edgeweir-node) 检出（或 `EDGEWEIR_NODE_CONTEXT`），以及对 deb.debian.org、openresty.org 的网络访问。Playwright 步骤需要 Chromium：

```bash
pnpm --filter @edgeweir/console exec playwright install chromium
```

## 本地运行

1. 安装依赖。

   ```bash
   pnpm install
   ```

2. 启动本地 PostgreSQL 18。监听 `127.0.0.1:5432`（`DEV_POSTGRES_PORT` 可改），用户、密码、数据库均为 `edgeweir`。

   ```bash
   docker compose -f compose.dev.yml up -d
   ```

3. 创建 `.env`，把 `openssl rand` 的输出原样写入 `EDGEWEIR_MASTER_KEY`。`.env.example` 中的 `DATABASE_URL` 与 `compose.dev.yml` 一致。

   ```bash
   cp .env.example .env
   openssl rand -base64 32
   ```

4. 启动控制台。

   ```bash
   pnpm dev
   ```

   单个进程：`:3000` 提供 UI 与 API（前端走 Vite HMR），`:8443` 提供节点通道。服务端改动重启整个进程。初始化完成前，启动日志打印 setup token（`setupToken` 字段）。

5. 验证。

   ```bash
   curl -s http://localhost:3000/healthz
   ```

   预期输出 `{"status":"ok","version":"dev"}`。打开 <http://localhost:3000/setup>，输入 setup token 完成初始化向导。

## 命令

| 命令 | 作用 | 运行时机 |
| --- | --- | --- |
| `pnpm lint` | Biome 检查与格式校验、`buf lint proto` | 每次提交前 |
| `pnpm format` | Biome 自动修复（`biome check --write .`） | `pnpm lint` 报格式问题时 |
| `pnpm typecheck` | 生成 Paraglide 消息与路由树，全 workspace TypeScript 类型检查 | 每次提交前 |
| `pnpm test` | Vitest 单元与集成测试；PostgreSQL 由进程内 PGlite 提供，不需要 Docker | 每次提交前 |
| `pnpm build` | 生产构建：Vite 前端与单文件服务端 | 改动构建配置或依赖时 |
| `pnpm proto:lint` | `buf lint proto` | 改动 `proto/` 时 |
| `pnpm proto:gen` | 由 `proto/` 生成 TypeScript 至 `packages/proto` | 改动 `proto/` 时 |
| `pnpm db:generate` | 由 `packages/db/src/schema` 的变更生成 SQL 迁移（drizzle-kit） | 改动 schema 时 |
| `pnpm e2e` | 端到端测试（`scripts/e2e.sh`），见[端到端测试](#端到端测试) | 改动节点通道、配置编译、安装脚本或页面流程时 |

CI 在 PR 与 `master` 推送时运行：`pnpm lint`、`pnpm proto:gen` 后 `packages/proto` 无差异、`pnpm typecheck`、`pnpm test`、`pnpm build`、`helpers/certd` 的 `go vet` 与 `go test -race`、镜像构建、端到端测试。

## 测试

| 层级 | 工具 | 位置 |
| --- | --- | --- |
| 单元与集成 | Vitest（PGlite） | `apps/console/test/server`、`apps/console/test/web`、`packages/*/test` |
| certd | `go test -race ./...` | `helpers/certd` |
| 页面流程 | Playwright | `apps/console/e2e`，由 `scripts/e2e.sh` 驱动 |
| 端到端 | `scripts/e2e.sh` 与 `scripts/e2e-*.mjs` | `compose.e2e.yml` |

单个 Vitest 文件在 `apps/console` 下运行：

```bash
pnpm exec vitest run test/server/docs.test.ts
```

以下约定由测试强制执行：

| 约定 | 测试 |
| --- | --- |
| 消息 key 与占位符一致；错误码、原因码、节点错误码均有消息；组件内无硬编码文案 | `apps/console/test/web/i18n.test.ts` |
| 无骨架屏、无 `*Description` 组件、无颜色字面量、无外部站点链接、appica-ui 导入范围 | `apps/console/test/web/ui-rules.test.ts` |
| shadcn preset `b2D0wqNxT`、全局只有一个 ThemeProvider | `apps/console/test/web/ui-preset.test.ts` |
| 每个契约过程归入控制台清单或后台 403 表 | `apps/console/test/server/admin.test.ts` |
| `.env.example` 列出控制台读取与 compose 插值的全部变量 | `apps/console/test/server/env-example.test.ts` |
| 第三方镜像按 digest、Actions 按 commit SHA 固定 | `apps/console/test/server/supply-chain-pins.test.ts` |
| `deploy.sh` 内嵌的 compose 模板与仓库文件逐字一致 | `apps/console/test/server/deploy-script.test.ts` |
| 文档相对链接可解析；ADR 索引完整；`ARCHITECTURE.md` 数据模型列出全部迁移与表 | `apps/console/test/server/docs.test.ts` |
| 迁移编号连续、时间戳递增、每条迁移一个 SQL 文件与一个快照 | `packages/db/test/migrations.test.ts` |

新增的 API 过程都要有 Vitest 用例。

## 端到端测试

1. 构建并启动测试环境（postgres、console、node 与测试源站）。

   ```bash
   docker compose -f compose.e2e.yml up -d --build
   ```

2. 运行测试。`--up` 先启动环境；`--down` 结束后删除环境与卷；`--skip-ui` 跳过 Playwright。

   ```bash
   pnpm e2e
   ```

3. 验证：输出以 `E2E OK` 结束。

并行运行第二套环境所需的变量（`COMPOSE_PROJECT_NAME`、`E2E_CONSOLE_PORT`、`E2E_NODE_PORT`、`E2E_TAG`、`E2E_SUBNET`、`E2E_ISOLATED_SUBNET`、`E2E_INSTALL_IMAGE`、`EDGEWEIR_NODE_CONTEXT`）见 [README 端到端测试](README.md#端到端测试)。

## 提交规范

使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/)。

```text
<type>(<scope>): <subject>

<body>

<footer>
```

| type | 用途 |
| --- | --- |
| `feat` | 新功能 |
| `fix` | 缺陷修复 |
| `docs` | 仅文档 |
| `style` | 不影响逻辑的格式调整 |
| `refactor` | 既非新功能也非修复的重构 |
| `perf` | 性能优化 |
| `test` | 新增或修改测试 |
| `build` | 构建系统、依赖、Dockerfile |
| `ci` | CI 配置 |
| `chore` | 其他杂项 |
| `revert` | 回退之前的提交 |

scope：`console`、`web`、`api`、`db`、`contract`、`compiler`、`proto`、`node-channel`、`certd`、`deploy`、`e2e`、`doc`。跨多个模块时省略 scope。

示例：

```text
feat(deploy): add deploy.sh to install and upgrade 宝塔 / aaPanel compose deployments
fix(certd): renew without ARI replaces when the CA rejects the new order
feat(console)!: drop the public landing page from the open core
```

| 规则 | 要求 |
| --- | --- |
| 粒度 | 一个提交只做一件事，单独通过检查 |
| subject | 中文或英文；不超过 72 个字符；结尾不加句号 |
| 破坏性变更 | type 或 scope 后加 `!`，footer 写 `BREAKING CHANGE:` 说明影响与迁移方法 |
| DCO | 推荐 `git commit -s` 添加 `Signed-off-by`，表示同意 [Developer Certificate of Origin](https://developercertificate.org/) |

## 代码约定

| 范围 | 约定 |
| --- | --- |
| TypeScript lint 与格式 | Biome（配置在仓库根目录）；不引入 ESLint 或 Prettier |
| TypeScript 类型 | `strict`；避免 `any`；系统边界（API 输入、环境变量、外部数据）用 zod 校验 |
| Go（`helpers/certd`） | `gofmt`；通过 `go vet` |

## 界面规则

依据 [ADR-0003](docs/adr/0003-ui-shadcn-preset.md)。

| 范围 | 规则 |
| --- | --- |
| 组件 | shadcn 组件位于 `components/ui`，使用 Base UI 的 `render` prop，不用 `asChild`；全局只有一个 ThemeProvider |
| 状态 | 每个页面都有加载、空、错误状态 |
| 文案 | 面向用户、简短；无页面副标题；对话框与卡片无说明段落；空状态只有标题与操作；只保留一行安全提示（如“仅显示一次”），用 `SafetyNote` |
| 加载 | 不用骨架屏与 `animate-pulse`；`TopProgress`（2px 顶部进度条）覆盖路由加载、请求与提交；首次加载显示 `LoadingState`；提交按钮显示 `Spinner` 并禁用；轮询查询设置 `meta: { background: true }` |
| 颜色 | TS/TSX 中不写颜色字面量，颜色来自 CSS token |
| 外部链接 | 不链接其他站点，`ui-rules.test.ts` 的允许清单除外 |
| appica-ui | 只经 `src/web/components/appica/` 与 `appica-bridge.css`（作用域 token，每个组件一条 `@source`）使用 |
| 动效 | 入场用 `animate-enter` 加递增的 `animationDelay`；遵循减少动态效果设置 |
| 页面范围 | 开源核心不含营销页面（ADR-0019） |

## 国际化

依据 [ADR-0004](docs/adr/0004-i18n-paraglide.md)。

- 所有 UI 字符串经 Paraglide 消息函数输出。消息文件为 `apps/console/messages/zh-CN.json`（默认语言）与 `apps/console/messages/en.json`。
- key 用 snake_case，以页面或功能开头，如 `nav_sites`、`cert_brotli_unavailable`。
- 两种语言同时增改：key 集合一致，占位符一致，值不为空。
- `src/web/routes` 与 `src/web/components` 中不写中文字面量，也不写英文 UI 文案，包括 `aria-*`、`title`、`alt`、`placeholder`。
- 服务端不拼接面向用户的句子：API 返回错误码，UI 按当前语言翻译；未知错误码回退到服务端的英文 `message`。

## 错误码

1. 在 `packages/contract/src/errors.ts` 的 `errorDefs` 中新增错误码，写明 HTTP 状态与 `params`。
2. 服务端调用 `fail(CODE, message, data)`（`apps/console/src/server/lib/errors.ts`）：`message` 是英文后备文本，`data` 提供 `params` 中的字段。
3. 在两个消息文件中新增对应消息，占位符与 `params` 一致。

| 代码表 | 位置 | 消息 key |
| --- | --- | --- |
| API 错误码 `errorDefs` | `packages/contract/src/errors.ts` | `error_<小写 code>` |
| 配置版本原因 `revisionReasonDefs` | `packages/contract/src/errors.ts` | `revision_reason_<code>` |
| 节点错误码 `nodeErrorDefs` | `packages/contract/src/node-errors.ts` | `node_error_<code>` |
| 节点任务结果 `taskErrorDefs` | `packages/contract/src/node-errors.ts` | `task_error_<code>` |
| 预热失败原因 `prefetchFailureReasonDefs` | `packages/contract/src/node-errors.ts` | `task_error_reason_<code>` |

## API 与服务端约定

| 约定 | 位置 |
| --- | --- |
| API 改动从 oRPC 契约开始；同一过程同时服务 `/rpc`（UI）与 `/api/v1`（OpenAPI） | `packages/contract` |
| 后台过程用 `admin` 守卫；租户过程用 `tenant`（组织要求两步验证时，未启用者被拒绝）；成员管理用 `orgManager` | `apps/console/src/server/rpc/base.ts` |
| 新过程加入控制台清单 `CONSOLE_PROCEDURES` 或租户成员 403 表 | `apps/console/test/server/admin.test.ts` |
| 管理操作在同一事务内调用 `recordAudit` 写 `audit_log` | `apps/console/src/server/services/audit.ts` |
| better-auth 自身端点的审计由 hooks 写入 | `apps/console/src/server/lib/auth-audit.ts` |
| better-auth HTTP 端点按白名单放行（`AUTH_HTTP_ROUTES`），`/api/auth` 下其余路径返回 404；organization 与 admin 插件只在服务端经 `auth.api.*` 调用 | `apps/console/src/server/lib/auth.ts` |
| 客户端 IP 只取自 `resolveClientIp`：TCP 对端地址；转发头仅在对端属于 `EDGEWEIR_TRUSTED_PROXIES` 时采用 | `apps/console/src/server/lib/client-ip.ts` |
| 信封密文与所属记录绑定：`masterKey.seal(value, { purpose: "<table>.<column>", recordId })` | `apps/console/src/server/lib/envelope.ts` |
| 源站地址的特殊用途地址段列表（节点保持同一列表） | `packages/contract/src/addresses.ts` |

## proto 变更

`proto/` 是控制台与 edgeweir-node 之间唯一的契约（[ADR-0008](docs/adr/0008-node-channel-connect-rpc-mtls.md)）。

1. 修改 `proto/` 下的 `.proto` 文件。`edgeweir.node.v1` 包内只做向后兼容的新增；破坏性变更新建 `v2` 包。`NodeConfig` 遵守 [ADR-0011](docs/adr/0011-config-model-nodeconfig-ir.md) 的规范化约束：不用 `map` 字段，字段按字段号升序声明。
2. 运行 lint。

   ```bash
   pnpm proto:lint
   ```

3. 与上一个 proto tag 比较，确认没有破坏性变更。

   ```bash
   pnpm exec buf breaking proto --against '.git#tag=proto/vX.Y.Z,subdir=proto'
   ```

4. 生成 TypeScript，把 `proto/` 改动与 `packages/proto` 的生成代码放在同一个提交里。CI 检查生成代码与 `proto/` 一致。

   ```bash
   pnpm proto:gen
   ```

5. 合入 `master` 后，维护者打 tag `proto/vX.Y.Z`：新增字段或 RPC 升 minor，只改注释升 patch。
6. 在 edgeweir-node 中把 `Makefile` 的 `PROTO_TAG` 改为新 tag，重新生成 Go 代码并适配，提交 `internal/gen/`。

   ```bash
   make proto
   ```

7. 发布顺序：先升级控制台，再升级节点。控制台必须兼容上一个 proto 版本的节点。

## 数据库 schema 变更

1. 修改 `packages/db/src/schema`。
2. 生成迁移。

   ```bash
   pnpm db:generate
   ```

3. 把 `packages/db/migrations` 中新增的 SQL 文件与 `meta/` 快照和 schema 改动放在同一个提交里。
4. 在 `ARCHITECTURE.md` 的数据模型一节列出新迁移文件名与新表名。
5. 验证。

   ```bash
   pnpm test
   ```

控制台启动时执行数据库迁移。

## 环境变量

1. 在 `apps/console/src/server/lib/env.ts` 的 schema 中声明变量（zod 校验与默认值）。
2. 在 `.env.example` 中加入变量，注释写明用途与默认值。compose 文件插值的变量同样要出现在 `.env.example`。
3. 在[环境变量](docs/reference/environment.md)参考页的中英文版本中加入变量说明。
4. 验证。

   ```bash
   pnpm test
   ```

运营配置优先放在 **后台 → 系统设置**，环境变量只保留初始化之前或基础设施层面需要的值。同一配置同时存在系统设置与环境变量时，生效顺序为：后台保存值、环境变量、默认值。

## 更新固定的镜像与 Actions

第三方输入按不可变引用固定（[ADR-0017](docs/adr/0017-release-supply-chain.md)），`pnpm test` 拒绝未固定的写法；edgeweir-node 用 `make pin-check` 做同样的检查。本仓库与 edgeweir-node 构建的镜像按 tag 引用。

| 输入 | 写法 | 位置 |
| --- | --- | --- |
| 第三方镜像 | `tag@sha256:<多架构 index digest>` | `Dockerfile`（`# syntax=` 行与 `ARG *_IMAGE`）、`compose*.yml`、`scripts/e2e.sh`（`E2E_INSTALL_IMAGE` 默认值）、`deploy.sh`（`PG_IMAGE` 与内嵌模板） |
| GitHub Actions | `owner/action@<40 位 commit SHA> # vX.Y.Z` | `.github/workflows/*.yml` |

1. 查镜像 digest：输出中的 `Digest` 是多架构 index digest，不用单一平台的 digest。

   ```bash
   docker buildx imagetools inspect <镜像>:<tag>
   ```

2. 查 Action 版本对应的提交：附注 tag 取带 `^{}` 那一行的 SHA。

   ```bash
   git ls-remote --tags https://github.com/<owner>/<action>
   ```

3. tag 与 digest（或 SHA 与版本注释）一起修改。
4. 修改 `compose.baota.yml` 或 `compose.baota-host.yml` 后，把全文同步进 `deploy.sh` 的内嵌模板；`deploy.sh` 的 `PG_IMAGE` 与 `compose.baota.yml` 的 PostgreSQL 镜像保持一致。
5. 验证。

   ```bash
   pnpm test
   bash deploy.sh template bundled | diff - compose.baota.yml
   bash deploy.sh template host | diff - compose.baota-host.yml
   ```

基础镜像更新后，在 Actions 中手动运行 Release，重建 `master` 最新提交。

## 发布

| 制品 | 触发 | 版本 |
| --- | --- | --- |
| 控制台镜像 `ghcr.io/marvinli001/edgeweir` | `master` 上的提交通过 CI 后由 Release 工作流发布；手动运行 Release 只重建 `master` 最新提交 | `<YYYYMMDD>-<提交前 7 位>`（UTC 提交日期，`scripts/image-version.sh`）；该提交仍是 `master` 最新提交时同时移动 `latest` |
| 节点 | edgeweir-node 的 `v*` tag | `vX.Y.Z` |
| proto | 维护者在 `master` 上打 tag | `proto/vX.Y.Z` |

版本固定、升级与回滚见[版本、升级与回滚](docs/deploy/upgrade.md)；发布物的签名与校验见 [SECURITY.md](SECURITY.md)。

## ADR 流程

1. 复制 [docs/adr/template.md](docs/adr/template.md) 为 `docs/adr/NNNN-slug.md`。`NNNN` 取现有最大编号加一（两个仓库共用编号），`slug` 用英文小写与连字符。
2. 状态写“提议”，与相关代码放在同一个 PR，并在 [docs/adr/README.md](docs/adr/README.md) 的索引表加一行。
3. 评审通过后把状态改为“已接受”，再合入。
4. 推翻已接受的决策时写新 ADR，旧 ADR 的状态改为“已被 ADR-NNNN 取代”。已接受 ADR 的正文不改写；落地情况、版本号等事实变化在末尾追加带日期的更新记录。
5. ADR 只在本仓库修改。edgeweir-node 的 `docs/adr` 是镜像，在节点仓库运行 `scripts/sync-adr.sh` 同步，`scripts/sync-adr.sh --check` 检查一致性。

## 文档

- 发布的文档是纯 GitHub Markdown：`name.md`（简体中文，默认）与 `name.en.md`（英文，章节与 `name.md` 相同）。ADR 只有中文。
- 文档站点位于 `doc/`（Fumadocs，Next.js 静态导出），是独立的 pnpm workspace（`doc/pnpm-workspace.yaml`、`doc/pnpm-lock.yaml`）。`.github/workflows/docs.yml` 在 PR 中构建站点，在 `master` 推送后发布到 GitHub Pages：<https://marvinli001.github.io/edgeweir/>。
- `doc/scripts/sync-content.mjs` 保存页面表（`SECTIONS`）并转换 Markdown。新页面须加入页面表。

| Markdown | 站点 |
| --- | --- |
| H1 | 页面标题 |
| 紧跟 H1 的单行段落 | 页面描述 |
| GitHub alert（`> [!NOTE]` 等） | Callout |
| 指向已发布页面的相对链接 | 站点 URL |
| 指向仓库其他文件的相对链接 | GitHub URL |
| 失效的相对链接、原始 HTML | CI 构建失败 |

| 命令 | 作用 |
| --- | --- |
| `pnpm --dir doc install` | 安装站点依赖 |
| `pnpm --dir doc dev` | 本地站点，监听 `:3000` |
| `DOCS_BASE_PATH=/edgeweir pnpm --dir doc build` | 静态导出至 `doc/out` |
| `DOCS_BASE_PATH=/edgeweir pnpm --dir doc preview` | 在 `:4100` 的 `/edgeweir` 路径下提供 `doc/out` |

## Pull Request 检查清单

- [ ] 一个 PR 一个主题；描述写明动机、改动内容与验证方式，关联 issue 或 ADR。
- [ ] `pnpm lint`、`pnpm typecheck`、`pnpm test` 通过；按[命令](#命令)表的时机运行 `pnpm build`、`pnpm e2e`。
- [ ] 提交符合[提交规范](#提交规范)。
- [ ] UI 文案 zh-CN 与 en 同时更新；新错误码有对应消息。
- [ ] schema 改动附带迁移 SQL、快照与 `ARCHITECTURE.md` 数据模型更新。
- [ ] 新环境变量写入 `env.ts`、`.env.example` 与环境变量参考页。
- [ ] 管理操作写审计日志。
- [ ] UI 改动附截图。
- [ ] 行为变化同步更新中英文文档（README、部署文档、ADR 落地情况）。
- [ ] 没有跳过、删除或弱化测试。

## 许可证

Edgeweir 以 [AGPL-3.0-only](LICENSE) 发布。提交贡献即表示同意以 AGPL-3.0-only 授权该贡献，并确认有权这样授权。

开源核心允许合规商用；组织、成员、权限与隔离保留在开源核心，对外客户门户、套餐计费、财务与分销属于独立商业运营产品（[LICENSING.md](LICENSING.md)、[ADR-0019](docs/adr/0019-open-core-and-commercial-products.md)）。向核心贡献不自动授予项目方闭源再许可的权利；双许可或插件链接例外须另行核实代码权利与贡献授权。
