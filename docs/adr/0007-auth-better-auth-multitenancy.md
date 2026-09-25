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
