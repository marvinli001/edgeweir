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
> - 2026-09-25：界面按角色分为**控制台**与**后台**。所有用户（包括平台管理员）的主视图都是控制台（概览、网站、设置），平台管理员拥有控制台的全部功能；此外顶栏多一个 [控制台 | 后台] 分段切换，进入 `/admin/*`（平台概览、集群与节点、审计日志、系统设置；以后还有组织与用户、套餐、DNS 服务商等系统级配置）。`/admin` 路由在前端对非管理员重定向到 `/`，对应的 oRPC 过程在服务端使用 `admin` 守卫。`settings.get`（节点通道地址、CA 指纹、遥测、统计模式）随之改为仅平台管理员可调用，测试覆盖租户成员调用 `settings`、`clusters`、`auditLogs` 返回 403。
> - 2026-09-25（MVP M1）：
>   - **setup token**：未初始化时控制台生成 `ews_` 开头的随机 token，用主密钥信封加密后存入 `system_setting`（另存 SHA-256 用于比对），每次启动打印到日志（多实例、重启打印同一个 token；主密钥更换后重新生成）。`system.setup` 必须带正确的 token，否则返回 `SETUP_TOKEN_INVALID` 并写审计日志；初始化成功后 token 作废，系统设置页显示使用时间。上文"初始化窗口风险"由此关闭。
>   - **组织设置**：默认集群和"要求成员启用两步验证"存在自有表 `organization_settings`，不改 better-auth 生成的 `organization` 表。租户新建网站落在组织的默认集群（未设置时是最早的集群）；只有平台管理员能指定集群（否则 `CLUSTER_SELECTION_FORBIDDEN`）。
>   - **成员与邀请**：成员管理、邀请、改角色、移除由控制台自己的 oRPC 过程完成（直接读写 better-auth 的 `member`、`invitation` 表），规则是：组织 owner/admin 可管理成员，只有 owner（或平台管理员）能授予、修改、移除 owner，组织至少保留一个 owner。邀请以链接形式交付（`/invite/<id>`，7 天有效，同一地址的新邀请替换旧邀请）；邀请 id 就是链接里的凭据。已有账号必须以受邀邮箱登录后接受，新用户在接受时设置姓名和密码。SMTP 在 M5 接入前不发邮件。
>   - **当前组织**：`account.setActiveOrganization` 校验成员关系后写入 session 的 `activeOrganizationId`；中间件每次请求都重新核对成员关系，失效时回退到最早加入的组织。侧边栏在用户属于多个组织时显示切换。
>   - **两步验证策略**：组织要求 2FA 而成员未启用时，租户过程返回 `TWO_FACTOR_REQUIRED`，界面把成员留在账户安全页，直到启用 TOTP。平台管理员不受组织策略约束。TOTP 与 passkey 使用 better-auth 的 twoFactor / passkey 插件和对应的客户端插件；登录时有 2FA 的账号进入验证码（或备用码）步骤。
>   - **账号停用**：后台停用账号时设置 better-auth 的 `banned` 并删除该用户所有会话；中间件对 `banned` 的用户（包括其 AccessKey）一律返回 `USER_DISABLED`。平台管理员不能停用自己或取消自己的管理员角色（`CANNOT_MODIFY_SELF`）。
>   - better-auth 默认的登录限速（每个客户端 10 秒 3 次）保持不变；界面对 429 显示本地化提示。
> - 2026-09-25（收尾）：
>   - **`/api/auth/*` 白名单。** Hono 把请求交给 better-auth 之前，按方法和规范化后的路径精确匹配 `AUTH_HTTP_ROUTES`（`apps/console/src/server/lib/auth.ts`），只放行控制台前端用到的端点：`get-session`、`sign-in/email`、`sign-out`、`change-password`、`two-factor/{enable,disable,verify-totp,verify-backup-code}`、`passkey/{generate-register-options,verify-registration,generate-authenticate-options,verify-authentication,list-user-passkeys,delete-passkey}`、`api-key/{create,list,delete}`；其余路径（包括 organization、admin 插件的全部 HTTP 端点）返回 404。这两个插件只在服务端经 `auth.api.*` 调用，组织、成员和用户管理只走 Edgeweir 自己的过程（权限检查、审计、配置版本）。
>   - **`x-api-key` 在 `/api/auth/*` 上被剥掉。** `enableSessionForAPIKeys` 仍然开启，`/api/v1` 继续以 key 所有者的身份走同一套 RBAC；但 key 不能在 better-auth 自己的端点上变成会话（例如用 key 调 `api-key/create` 签发新 key）。
>   - **客户端 IP 与可信代理。** 新增环境变量 `EDGEWEIR_TRUSTED_PROXIES`（逗号分隔的 IP 或 CIDR，默认空）。客户端 IP 取 TCP 对端地址；只有对端在清单里时才采用 `X-Forwarded-For`（从右往左跳过可信的跳）或 `X-Real-IP`。控制台把解析出的地址写进自己的 `x-edgeweir-client-ip` 头交给 better-auth（`advanced.ipAddress.ipAddressHeaders` 只读这个头，客户端带来的同名头先被删掉），服务端的 `auth.api.*` 调用和审计日志用同一个地址。
>   - **限速计数存数据库。** better-auth 的 `rateLimit.storage` 设为 `"database"`（表 `rate_limit`，迁移 `0004_wrapup_auth`），多个实例共享，重启不清零；限速规则本身不变。
>   - **账号事件写审计。** 经 better-auth 端点完成的变更由钩子写审计：插件 `edgeweir-audit`（排在其他插件之后）的 after 钩子写 `auth.sign_in`（带登录方式 password、totp、backup_code 或 passkey；密码正确但还要第二步验证时不写）、`auth.sign_in_failed`（带错误码和邮箱）、`account.password_change`、`account.passkey_add`、`account.passkey_delete`、`api_key.create`（只记 id、名称、前缀和过期时间，不记 key）、`api_key.delete`；`databaseHooks.user.update.after` 写 `account.two_factor_enable`、`account.two_factor_disable`。better-auth 先提交自己的变更再调用钩子，所以这些审计不与变更同事务，写入失败只记日志。控制台自己经 `auth.api.createUser` 建账号的三个地方（初始化、后台创建用户、新用户接受邀请）在紧接着的一个事务里完成其余变更和审计，失败时删除刚建的账号。

> - 2026-09-27（MVP M6）：AccessKey 增加只读/读写范围、最后使用时间及吊销。全局 oRPC 中间件在包括可选登录在内的过程之前校验范围，只读拒绝写入过程；better-auth HTTP 路由不接受 x-api-key，防止借管理密钥接口提权。旧版 null permissions 保持读写兼容，非空但不合法的 permissions 按只读处理。

> - 2026-09-27（MVP 审查）：创建 AccessKey 必须由已登录控制台的用户会话发起，服务层拒绝 api_key actor。读写与旧版 API key 仍可执行原有授权业务操作及吊销，但不能签发新的独立凭据；公开接口说明和浏览器流程同步更新。
