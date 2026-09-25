# ADR-0005: API：oRPC 契约优先，同时服务 UI 与 OpenAPI

- 状态：已接受
- 日期：2026-09-25
- 适用仓库：edgeweir

## 背景

控制台 UI 需要类型安全的 API 调用，并与 TanStack Query 集成。同时要对外开放 API，给脚本、将来的官方 SDK 和 Terraform provider 使用，这需要一份标准的 OpenAPI 文档。如果 UI 的 API 和对外 API 分开实现，就会出现两套实现、两套权限检查，以及迟早出现的不一致。

## 决策

1. **契约优先。** `packages/contract` 用 `@orpc/contract` 定义每个过程的输入和输出（zod 4 schema）、HTTP 方法与路径、可能返回的错误。契约不依赖服务端实现，UI 和服务端都导入它。
2. **服务端按契约实现。** `apps/console/src/server` 用 `@orpc/server` 的 `implement` 实现契约，实现与契约不符时类型检查失败。
3. **同一份实现挂到两个入口：**

   | 入口 | 协议 | 使用者 | 认证方式 |
   | --- | --- | --- | --- |
   | `/rpc` | oRPC RPC 协议 | 控制台 UI（`@orpc/client` + `@orpc/tanstack-query`） | better-auth 会话 cookie |
   | `/api/v1` | OpenAPI（REST + JSON） | 外部脚本、SDK、Terraform provider | AccessKey，请求头 `x-api-key` |

4. **AccessKey 就是 better-auth api-key 插件签发的 key**（[ADR-0007](0007-auth-better-auth-multitenancy.md)）。key 只在创建时显示一次，数据库只存哈希。`/api/v1` 只接受 `x-api-key`，不把浏览器会话 cookie 当作凭据，从根本上避开跨站请求伪造。`/rpc` 只接受会话 cookie。
5. **授权只有一份。** 两个入口共用同一条 oRPC 中间件链：解析调用者（用户与当前组织，或 key 所属的用户与组织），按过程声明的权限检查角色（[ADR-0007](0007-auth-better-auth-multitenancy.md)），对写操作记审计日志（[ADR-0018](0018-trust-and-security-baseline.md)）。
6. **OpenAPI 文档由契约生成**（`@orpc/openapi` 加 `@orpc/zod` 的 JSON Schema 转换器，输出 OpenAPI 3.1），不手写，不单独维护。
7. **版本策略。** `/api/v1` 内只做向后兼容的变更：新增接口、新增可选字段。破坏性变更进入 `/api/v2`，旧版本保留一个过渡期。

## 备选方案与取舍

- **tRPC**：UI 端的开发体验相近，但没有一等的 OpenAPI 输出（社区的 trpc-openapi 已不再维护），对外 API 要另写一套。
- **先写 REST/OpenAPI（例如 `@hono/zod-openapi`），再为 UI 生成客户端**：多一步代码生成，UI 端的类型和 TanStack Query 集成不如 oRPC 直接。
- **GraphQL**：对外 API 的授权、缓存和查询复杂度控制都更难；Terraform provider 等生态以 REST 为主。
- **UI 也走 Connect-RPC，与节点通道统一**：表单校验要在 protobuf 类型和 zod 之间来回转换；Connect 没有原生的 OpenAPI 输出。节点通道选 protobuf 是为了 Go 代码生成和确定性二进制编码（[ADR-0008](0008-node-channel-connect-rpc-mtls.md)、[ADR-0011](0011-config-model-nodeconfig-ir.md)），这两个理由对 UI API 不成立。

## 后果

### 正面

- 契约只有一份，UI 使用的 API 与对外 API 始终一致。
- OpenAPI 文档不会过期；SDK 和 Terraform provider 可以从文档生成。
- 权限检查和审计只实现一次。

### 负面

- 契约里同时写了 HTTP 方法和路径，设计过程时要兼顾 RPC 调用和 REST 风格。
- `/api/v1` 一旦发布就要长期维护兼容性。
- oRPC 1.x 相对年轻，升级时要关注破坏性变更。

## Phase 0 落地情况

Phase 0 范围：

- 集群、节点、安装命令、站点、设置相关的过程。
- `/rpc` 与 `/api/v1` 双入口；`/api/v1` 的 `x-api-key` 认证。
- 由契约生成 OpenAPI 文档。

后续：

- key 的细粒度权限（限定资源和操作）、过期与轮换策略。
- API 限流。
- 官方 SDK、Terraform provider。
- CI 比对生成的 OpenAPI 文档，检测 `/api/v1` 的破坏性变更。

## 版本核实

核实日期：2026-09-25。来源：npm registry。

| 组件 | 版本 | 来源 |
| --- | --- | --- |
| @orpc/*（contract、server、client、openapi、zod、tanstack-query） | 1.15.4 | npm registry |
| zod | 4.6.5 | npm registry |
| better-auth | 1.7.6 | npm registry |
| @better-auth/api-key | 1.7.6 | npm registry |
| @tanstack/react-query | 5.103.x | npm registry |

> 更新记录：
> - 2026-09-25：npm `latest` 为 oRPC 1.15.4，2.0 仍是 beta（2.0.0-beta.40，路由改为 `.meta(openapi())`）。采用 1.15 稳定版的 `.route({ method, path })`，zod 4 转换器从 `@orpc/zod/zod4` 引入；2.0 GA 后另行评估迁移。`/rpc` 额外启用 oRPC 的 SimpleCsrfProtection（`x-csrf-token` 头）；`/rpc` 丢弃 `x-api-key`，`/api/v1` 丢弃 cookie，两个入口各自只认一种凭据。
