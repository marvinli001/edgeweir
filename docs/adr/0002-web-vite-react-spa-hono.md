# ADR-0002: Web 前端：Vite + React 19 SPA，由 Hono 托管

- 状态：已接受
- 日期：2026-09-25
- 适用仓库：edgeweir

## 背景

管理后台的全部页面都在登录之后，不需要 SEO，也不需要服务端渲染首屏。控制台进程同时还要承载长期运行的资源：节点的 WatchConfig 服务端流（成百上千个节点同时在线）、PostgreSQL 的 LISTEN 连接、pg-boss worker（[ADR-0001](0001-monolithic-console-and-toolchain.md)）。前端方案必须能与这样一个常驻 Node 进程共存，并且在开发环境也保持"一个进程"。

## 决策

1. **前端是 Vite + React 19 的 SPA**，代码在 `apps/console/src/web`。
   - 路由：TanStack Router 文件路由，由 Vite 插件生成路由树。登录状态和"是否已完成初始化"在路由的 `beforeLoad` 中检查并重定向。
   - 服务端状态：TanStack Query，通过 oRPC 的 TanStack Query 集成调用 `/rpc`（[ADR-0005](0005-api-orpc-openapi.md)）。
   - 列表和表格：TanStack Table（headless），外观使用 shadcn 的 table 组件（[ADR-0003](0003-ui-shadcn-preset.md)）。
2. **服务端是 Hono**，运行在 `@hono/node-server` 上，代码在 `apps/console/src/server`。`:3000` 上的路由划分：

   | 路径 | 处理者 |
   | --- | --- |
   | `/api/auth/*` | better-auth（其默认 basePath） |
   | `/rpc/*` | oRPC RPC 协议，仅供控制台 UI |
   | `/api/v1/*` | oRPC OpenAPI 协议，对外开放 |
   | `/install.sh` | 节点安装脚本（[ADR-0016](0016-one-line-install.md)） |
   | 其余 GET 请求 | 静态资源；找不到文件时回退到 `index.html` |

3. **生产环境**：`vite build` 的产物随镜像发布，由 Hono 的 `serveStatic` 托管。文件名带内容哈希的资源设置长期缓存（`immutable`），`index.html` 不缓存。
4. **开发环境：单进程。** 控制台的启动入口创建 Node HTTP 服务，把 Vite 以 middleware 模式（`server.middlewareMode`）作为库嵌入：
   - API 路径（上表前四行）交给 Hono，其余请求交给 Vite 的中间件（模块转换、`index.html`、HMR）。HMR 的 WebSocket 挂在同一个 HTTP 服务上。
   - 节点通道 `:8443` 和 pg-boss worker 在同一个进程里启动，与生产一致。
   - 前端代码变更走 Vite HMR；服务端代码变更由进程级 watch 重启整个进程，节点会自动重连。
5. **与 `@hono/vite-dev-server` 的关系。** 两者效果等价，都是一个进程同时提供前端和 API。区别在于谁拥有进程：`@hono/vite-dev-server` 由 Vite 开发服务器持有 HTTP 服务，Hono 应用作为模块按需加载；模块重新加载时，应用内部启动的其他资源（`:8443` 监听、LISTEN 连接、worker）容易被重复创建或泄漏。middleware 模式下进程归控制台自己，开发和生产走同一个启动入口，差别只在静态资源由 Vite 还是 `serveStatic` 提供。

## 备选方案与取舍

- **Next.js：**
  - 不需要 SSR 或 RSC：后台页面都在登录之后，服务端渲染首屏的收益可以忽略。
  - 攻击面：RSC 引入了 Server Actions 和 Flight 协议反序列化等额外的服务端入口。2025 年的 CVE-2025-29927（middleware 鉴权绕过）和 CVE-2025-55182（RSC 反序列化导致的未授权远程代码执行）都出在这一层。纯 SPA 加显式 API 没有这层攻击面。
  - 运行模型：Next.js 面向请求/响应和 serverless 部署。长连接、另一个端口上的 HTTP/2 mTLS 服务、常驻 worker 都要靠 custom server 实现，而 custom server 会失去部分框架能力，也不是官方主推的路径。
  - 构建更慢，产物和镜像更大。
- **React Router v7 framework 模式、TanStack Start**：同样以 SSR 为中心，并各自带一套 server function 机制，与 oRPC 的职责重叠。
- **前后端分开部署**（nginx 托管 SPA，API 单独运行）：违反单镜像原则（[ADR-0001](0001-monolithic-console-and-toolchain.md)），还要处理跨域和 cookie 作用域。
- **React Router library 模式或 wouter**：TanStack Router 的路径参数和 search params 都是类型安全的，并与 TanStack Query 的预取配合。
- **Vue 或 Svelte**：shadcn（Base UI 版）和 appica-ui 都是 React 组件库（[ADR-0003](0003-ui-shadcn-preset.md)）。

## 后果

### 正面

- 前端产物是纯静态文件，没有服务端渲染代码路径，也没有内联的数据注入，便于配置严格的 CSP（`script-src 'self'`）。
- 开发和生产的启动路径一致，`:8443` 等长期资源的生命周期清楚。
- Router、Query、Table 三者的类型贯通。

### 负面

- 首屏要等 JS 包下载后才渲染。用路由级代码分割控制包体积。
- 开发入口中 Vite middleware 与 Hono 的路径分流要自己维护，比直接用插件多几十行代码。
- 开发时服务端代码一改，整个进程重启，节点通道连接会断开重连。

## Phase 0 落地情况

Phase 0 范围：

- 页面：登录、首次初始化向导、概览、集群与节点、网站、设置。每个页面都有空状态、加载态和错误态。
- 生产环境静态托管与 `index.html` 回退。
- 开发环境单进程：Vite middleware + Hono + `:8443` 节点通道。

后续：

- 路由级代码分割与包体积预算检查（CI）。
- CSP 及其他安全响应头的完整配置。

## 版本核实

核实日期：2026-09-25。来源：npm registry。

| 组件 | 版本 | 来源 |
| --- | --- | --- |
| vite | 8.3.1 | npm registry |
| react | 19.3.0 | npm registry |
| @tanstack/react-router | 1.170.x | npm registry |
| @tanstack/react-query | 5.103.x | npm registry |
| @tanstack/react-table | 9.2.x | npm registry |
| hono | 4.13.9 | npm registry |
| @hono/node-server | 2.1.1 | npm registry |

> 更新记录：
> - 2026-09-25：Vite 8.3（Rolldown）。开发模式由 `tsx watch src/server/dev.ts` 启动一个进程：Hono（API、better-auth、/install.sh）+ 节点通道 :8443 + Vite middleware 模式（HMR 复用同一 HTTP 端口）。生产由 esbuild 把服务端及全部依赖打成单个 ESM 文件，镜像运行时不需要 node_modules；@hono/node-server 2.1 的 `serve`、`getRequestListener`、`serveStatic` API 与 1.x 一致。
