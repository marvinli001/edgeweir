# ADR-0007: 认证与多租户：better-auth

- 状态：已接受
- 日期：2026-09-25
- 适用仓库：edgeweir

## 背景

多租户第一天就要有：平台管理员运营整个平台，租户（组织）管理自己的站点，组织内有权限不同的成员。还需要 2FA、passkey，以及开放 API 用的 AccessKey（[ADR-0005](0005-api-orpc-openapi.md)）。自托管场景不能依赖外部身份服务，也不能有任何 phone-home（[ADR-0018](0018-trust-and-security-baseline.md)）。

## 决策

1. **better-auth 1.7** 作为认证库，嵌入控制台进程，数据通过 Drizzle 适配器存在同一个 PostgreSQL 中。启用的插件：

   | 插件 | 用途 |
   | --- | --- |
   | organization | 组织（租户）、成员、邀请、组织内角色 |
   | admin | 平台级角色、用户管理、封禁 |
   | twoFactor | TOTP 与备用码 |
   | passkey（`@better-auth/passkey`） | WebAuthn 登录 |
   | apiKey（`@better-auth/api-key`） | 开放 API 的 AccessKey，请求头 `x-api-key` |

2. **三层 RBAC：**
   - **平台管理员**：admin 插件中角色为 `admin` 的用户。管理集群、节点和全局设置，可以查看和管理所有组织。
   - **组织角色**：`owner`、`admin`、`member`（organization 插件的默认角色）。组织内权限用 better-auth 的 access control 声明，例如 `site:create`、`site:update`、`cache:purge`、`apiKey:create`；角色到权限的映射写在代码里，随代码评审。
   - **检查位置**：每个 oRPC 过程声明所需权限，由中间件统一检查（[ADR-0005](0005-api-orpc-openapi.md)）。
3. **租户隔离**：租户资源的表带 `organization_id`，数据访问层对租户资源的查询一律按调用者当前组织过滤。跨组织访问只出现在显式标注为平台管理员专用的过程中。
4. **首次初始化向导**：数据库里没有任何用户时，UI 进入 `/setup`，创建平台管理员账号和默认组织（该管理员为 owner）。创建在一个事务内完成，并写审计日志。初始化完成后，该接口永久失效。
5. **默认关闭自助注册**：用户由平台管理员创建，或通过组织邀请加入。v1 的租户门户上线后，由平台管理员决定是否开放注册。
6. **会话**：httpOnly cookie，通过 HTTPS 访问时带 `Secure`；签名密钥来自环境变量 `BETTER_AUTH_SECRET`。密码哈希使用 better-auth 默认的 scrypt。

## 备选方案与取舍

- **Auth.js（NextAuth）**：组织、RBAC、API key 都要自己实现，生态围绕 Next.js。
- **Lucia**：已于 2025 年停止作为库维护，转为教程资料。
- **Keycloak、Zitadel、Authentik 等独立身份服务**：多一个服务要部署（Keycloak 还是 JVM 应用），违反单镜像原则（[ADR-0001](0001-monolithic-console-and-toolchain.md)）。需要企业 SSO 时，better-auth 可以作为 OIDC/SAML 客户端对接这些服务，而不是要求用户必须部署它们。
- **Clerk、Auth0 等 SaaS**：用户数据出网，违反自托管和无 phone-home 原则。
- **自研认证**：密码学和会话管理一旦出错，代价太大。

## 后果

### 正面

- 认证、组织、2FA、passkey、API key 在一个库里解决，数据留在用户自己的 PostgreSQL。
- 权限声明集中在代码里，可评审、可测试。

### 负面

- 依赖 better-auth 的表结构和发布节奏，升级大版本时要跟进迁移。
- 插件组合的语义要自己定义清楚，例如 API key 归属于用户还是组织、key 的权限上限。Phase 0 的约定：key 绑定创建者和所属组织，权限不超过创建者在该组织内的角色。
- **初始化窗口风险**：初始化完成之前，任何能访问 `:3000` 的人都能创建平台管理员。部署文档要求完成初始化前不要把控制台暴露到公网。后续可以增加一次性 setup token（启动时写入容器日志，初始化时必须输入）。

## Phase 0 落地情况

Phase 0 范围：

- better-auth 及上述插件的配置和数据表。
- 登录、首次初始化向导（创建平台管理员和默认组织）。
- 平台管理员与组织角色的权限检查。
- `/api/v1` 的 `x-api-key` 认证。

后续：

- 2FA 与 passkey 的完整设置界面，组织可强制成员启用 2FA。
- 成员邀请界面。
- setup token。
- 企业 SSO（OIDC/SAML）。
- 租户门户与自助注册开关（v1）。

## 版本核实

核实日期：2026-09-25。来源：npm registry。

| 组件 | 版本 | 来源 |
| --- | --- | --- |
| better-auth | 1.7.6 | npm registry |
| @better-auth/passkey | 1.7.6 | npm registry |
| @better-auth/api-key | 1.7.6 | npm registry |

> 更新记录：
> - 2026-09-25：better-auth 1.7.6；schema 由官方 CLI（现为 `auth` 包，`pnpm dlx auth@1.7.6 generate`）生成。better-auth 自带的遥测默认关闭，但可被 `BETTER_AUTH_TELEMETRY` 环境变量打开；控制台在代码里显式 `telemetry: { enabled: false }` 并在启动时删除该变量。AccessKey 使用 api-key 插件，前缀 `ewk_`，`enableSessionForAPIKeys` 让 AccessKey 以其所有者身份走同一套 RBAC，限速 600 次/分钟。
