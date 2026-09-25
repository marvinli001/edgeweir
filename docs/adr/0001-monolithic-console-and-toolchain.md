# ADR-0001: 单体全栈控制面与工具链

- 状态：已接受
- 日期：2026-09-25
- 适用仓库：edgeweir

## 背景

控制面要同时提供三样东西：管理后台 UI、管理 API（包括对外开放的 API）、边缘节点的配置通道。主要用户是个人站长和中小 CDN 运营者，常见部署环境是一台装了宝塔面板的 Linux 服务器，用 Docker 编排运行服务。

参考系统在这方面的问题：

- GoEdge 把控制面拆成 EdgeAdmin（管理界面）、EdgeAPI（API 节点，唯一访问数据库的组件）、EdgeUser（用户界面）等多个程序。安装和升级时要保证多个组件版本一致，排障要在多个进程之间来回定位。
- Apache Traffic Control 由 Traffic Ops、Traffic Router、Traffic Monitor、Traffic Portal、Traffic Stats 等组件组成，涉及 Java、InfluxDB、ATS，运维负担重。

同时，GoEdge 的 API 节点可以水平扩展，这一点值得保留：控制面需要在节点和租户增多时加实例。

## 决策

1. **一个应用包、一个进程、一个镜像。** `apps/console` 构建出一个 Node 进程，打包成一个镜像 `ghcr.io/edgeweir/edgeweir`。同一进程内：
   - `:3000`（HTTP）：SPA 静态资源、better-auth 路由、`/rpc`（UI 专用 API）、`/api/v1`（OpenAPI）、`/install.sh`。见 [ADR-0002](0002-web-vite-react-spa-hono.md)、[ADR-0005](0005-api-orpc-openapi.md)。
   - `:8443`（HTTPS，HTTP/2）：节点通道，应用自己终结 TLS。见 [ADR-0008](0008-node-channel-connect-rpc-mtls.md)。
   - pg-boss worker：后台任务和定时任务。见 [ADR-0006](0006-data-postgresql-drizzle-pgboss.md)。
2. **按角色扩展，不按服务拆分。** 同一个镜像用环境变量 `ROLE` 选择角色：

   | ROLE | 运行内容 |
   | --- | --- |
   | `app` | `:3000` 与 `:8443`，只向 pg-boss 入队，不消费任务 |
   | `worker` | 只消费 pg-boss 任务 |
   | `all`（默认） | 以上全部 |

   多个实例共享同一个 PostgreSQL，实例之间用 LISTEN/NOTIFY 广播配置变更。小规模部署运行一个 `all` 实例即可，需要扩展时按角色增加副本。
3. **可复用的逻辑是库，不是服务。** `packages/db`、`packages/contract`、`packages/config-compiler`、`packages/proto` 都是 workspace 内的库，由 `apps/console` 导入。
4. **工具链：**
   - 运行时：Node.js 24 LTS（Krypton）。
   - 包管理与任务编排：pnpm workspace + Turborepo。Turborepo 负责 lint、typecheck、test、build 的依赖顺序和缓存。
   - 语言：TypeScript，开启 `strict`。
   - lint 与格式化：Biome，替换 Vite/shadcn 模板自带的 ESLint（以及 Prettier 配置，如果模板带了）。仓库中不保留 ESLint 和 Prettier 配置。
   - 单元与集成测试：Vitest。
   - 浏览器端到端测试：Playwright。

## 备选方案与取舍

- **控制面拆成多个服务**（GoEdge 式 Admin/API/User 分离，或前后端分开部署）：每多一个进程就多一套配置、端口、版本对齐和故障排查路径。我们的扩展需求用 `ROLE` 加多副本就能满足。
- **用 Go 写控制面**：节点已经用 Go，但控制面 UI 必然是 TypeScript。后端也用 TypeScript，UI、API 契约和表单校验就能共用同一套 zod 类型（[ADR-0005](0005-api-orpc-openapi.md)）。Go 只用在确实依赖 Go 生态的地方（`edgeweir-certd`，[ADR-0010](0010-certd-lego-libdns.md)）。
- **Bun 或 Deno**：Node 24 LTS 的支持周期明确（维护到 2028-04）；节点通道依赖 `node:http2` 与 `node:tls` 的客户端证书能力（`requestCert`），Node 上最成熟；better-auth、pg-boss、Drizzle 都以 Node 为主要测试目标。
- **npm 或 Yarn**：pnpm 的严格 `node_modules` 布局会暴露未声明的依赖，workspace 协议和安装速度也更好。
- **Nx**：功能更多也更重。我们只需要任务编排和缓存，Turborepo 足够。
- **ESLint + Prettier**：两套工具、两份配置、较长的插件依赖链，速度慢。Biome 是一个二进制，同时做 lint 和格式化，并内置 React hooks 相关规则（`useExhaustiveDependencies`、`useHookAtTopLevel`）。代价是用不了部分 ESLint 插件（例如 `@tanstack/eslint-plugin-query`），这部分约束靠类型检查和代码评审补上。
- **Jest**：ESM 和 TypeScript 需要额外的转换配置。Vitest 直接复用 Vite 的转换管线。
- **Cypress**：Playwright 原生支持多浏览器和并行执行，不需要付费服务。

## 后果

### 正面

- 部署只需要一个镜像加 PostgreSQL，适合宝塔 Docker 编排和单机部署。
- UI、API、节点通道共享类型和校验代码。改契约时，类型检查会立刻暴露两端的不一致。
- 不存在组件之间的版本错配：一个镜像就是一个版本。

### 负面

- HTTP 请求、节点通道和后台任务共享一个事件循环。耗 CPU 的工作（大集群的配置编译、统计汇总）会拖慢请求。缓解：这类工作做成 pg-boss 任务，由 `worker` 角色执行；必要时再用 `worker_threads`。
- 进程崩溃会同时影响 UI 和节点通道。节点侧有 last-known-good 配置（[ADR-0014](0014-node-agent-responsibilities.md)），控制面短时不可用不影响边缘流量。
- 放弃了 ESLint 生态中部分插件提供的规则。

## Phase 0 落地情况

Phase 0 范围：

- monorepo：`apps/console`（`src/server`、`src/web`）、`packages/db`、`packages/contract`、`packages/config-compiler`、`packages/proto`（生成的 TS）、`proto/`、`helpers/certd`。
- 根目录命令：`pnpm dev`、`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm build`、`pnpm e2e`、`pnpm proto:lint`、`pnpm proto:gen`。
- 多阶段 Dockerfile：非 root 运行，支持 `ROLE=app|worker|all`（默认 `all`）。
- GitHub Actions：lint、typecheck、test、构建镜像、端到端测试。
- Playwright 冒烟测试：登录、集群与节点、网站。

后续：

- 多副本部署文档和压测数据。
- 视负载把配置编译移到 `worker_threads`。

## 版本核实

核实日期：2026-09-25。来源：nodejs.org、Docker Hub、npm registry。

| 组件 | 版本 | 来源 |
| --- | --- | --- |
| Node.js | 24.21.0 LTS "Krypton"，镜像 `node:24.21.0-alpine` | nodejs.org、Docker Hub |
| pnpm | 12.6.0 | npm registry |
| turbo | 2.11.4 | npm registry |
| TypeScript | 7.0.2 | npm registry：`latest` 为 7.0.2（Go 原生编译器），见更新记录 |
| @biomejs/biome | 2.5.14 | npm registry |
| vitest | 5.0.1 | npm registry |
| @playwright/test | 1.63.0 | npm registry |

> 更新记录：
> - 2026-09-25：采用 TypeScript 7.0.2（npm `latest`，Go 原生编译器 `tsc`）。全部 workspace 包和 console 的 web/server/tooling 三套 tsconfig 均用 7.0.2 类型检查通过；shadcn Vite 模板锁定的 `typescript ~6` 已替换。pnpm 锁定 `packageManager: pnpm@12.6.0`。Biome 2.5 对 shadcn CLI 生成的 `components/ui/**` 用 overrides 关闭少量上游代码不满足的规则（a11y、hooks 依赖等），业务代码不受影响。
