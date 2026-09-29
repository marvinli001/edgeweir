# API 与端点

控制台 HTTP 端点、公开 API 的认证与错误格式，以及节点通道概要。

## 端点

以下路径位于 Web 端口（`PORT`，默认 `3000`），仅 `ROLE=app`、`all` 提供。

| 路径 | 认证 | 用途 |
| --- | --- | --- |
| `/api/v1/*` | `x-api-key` | 公开 API（OpenAPI）；请求中的 Cookie 被剥离 |
| `/api/v1/openapi.json` | 无 | OpenAPI 文档 |
| `/rpc/*` | 会话 Cookie + `x-csrf-token: orpc` | Web UI 专用（oRPC）；请求中的 `x-api-key` 被剥离 |
| `/api/auth/*` | 按端点 | better-auth 白名单端点，其余返回 404 |
| `/healthz` | 无 | 健康检查 |
| `/install.sh` | 无 | 节点安装脚本 |
| `/downloads/*` | 无 | 发布文件镜像；未设置 `EDGEWEIR_DOWNLOADS_DIR` 时返回 404 |
| 其他路径 | 无 | Web UI |

`/api/*`、`/rpc/*`、`/downloads/*`、`/install.sh`、`/healthz` 下未匹配的请求返回 404 与 `{"error":"not found"}`，不回退到 Web UI。

## 公开 API

`/api/v1` 与 `/rpc` 由 `packages/contract` 中的同一份 oRPC 契约生成。OpenAPI 文档位于 `/api/v1/openapi.json`，其 `servers` 为 `<EDGEWEIR_PUBLIC_URL>/api/v1`；**后台 → 系统设置** 的「OpenAPI」链接到该文档。

```bash
curl -fsS https://cdn-admin.example.com/api/v1/openapi.json
```

### 认证

- 请求头 `x-api-key: <AccessKey>`；AccessKey 以 `ewk_` 开头。
- AccessKey 以创建者身份调用，适用创建者的角色与组织范围。平台管理员的密钥可调用后台过程。
- 所属组织要求两步验证而创建者未启用时，租户过程返回 403 `TWO_FACTOR_REQUIRED`。
- 密钥无效、已吊销或缺失：401。创建者账户被禁用后，其 AccessKey 请求被拒绝。
- 每个 AccessKey 每 60 秒最多 600 次请求。
- 无需密钥的过程（OpenAPI 中 `security: []`）：`GET /system/status`、`POST /system/setup`、`GET /invitations/{id}`、`POST /invitations/{id}/accept`。

### AccessKey

在 **设置 → AccessKey** 中管理。每个用户只能查看和吊销自己的密钥。

| 操作 | 位置 | 说明 |
| --- | --- | --- |
| 创建 | 填写「名称」（最长 64 字符），选择「权限范围」，点击「创建」 | 默认「读写」。密钥只显示一次。只能在已登录的控制台会话中创建；经 `/api/v1` 创建返回 403 `ACCESS_KEY_SESSION_REQUIRED`。 |
| 查看 | 密钥列表；`GET /api/v1/access-keys` | 前缀、权限范围、状态、最后使用时间 |
| 吊销 | 「吊销密钥」；`DELETE /api/v1/access-keys/{id}` | 吊销后使用该密钥的请求返回 401；列表中保留并标记「已吊销」 |

| 权限范围 | 可调用的过程 |
| --- | --- |
| 只读 | `GET` 过程，以及 `POST /rules/validate`；其他方法返回 403 `ACCESS_KEY_READ_ONLY` |
| 读写 | 创建者有权调用的全部过程 |

未设置权限范围的旧密钥按读写处理。创建与吊销写入审计日志（`api_key.create`、`api_key.revoke`）；经 AccessKey 执行的操作在审计日志中的操作者类型为 `api_key`。

### 示例

列出网站（过程 `sites.list`，`GET /api/v1/sites`）：

```bash
curl -fsS -H "x-api-key: $EDGEWEIR_API_KEY" \
  "https://cdn-admin.example.com/api/v1/sites?page=1&pageSize=20"
```

| 查询参数 | 说明 |
| --- | --- |
| `search` | 匹配网站名称或任一域名，最长 100 字符 |
| `clusterId` | 集群 UUID；仅平台管理员 |
| `page` | 页码，默认 `1` |
| `pageSize` | 每页条数，1–100，默认 `20` |

响应：`{"items":[…],"total":<总数>}`。

### 错误格式

```json
{
  "defined": false,
  "code": "ACCESS_KEY_READ_ONLY",
  "status": 403,
  "message": "access key is read only",
  "data": {}
}
```

| 字段 | 说明 |
| --- | --- |
| `code` | 稳定错误代码。代码与 HTTP 状态的完整列表：[`packages/contract/src/errors.ts`](https://github.com/marvinli001/edgeweir/blob/master/packages/contract/src/errors.ts) |
| `status` | HTTP 状态码 |
| `message` | 英文说明，供不识别代码的客户端使用 |
| `data` | 消息参数 |

认证与输入校验失败使用 oRPC 通用代码：`UNAUTHORIZED`（401）、`FORBIDDEN`（403）、`BAD_REQUEST`（400）。

## Web UI 接口

`/rpc/*` 使用 oRPC RPC 协议，供 Web UI 调用，路径为过程路径，例如 `POST /rpc/sites/list`。

| 要求 | 说明 |
| --- | --- |
| 会话 Cookie | 由 `/api/auth` 的登录端点签发 |
| `x-csrf-token: orpc` | 缺少时返回 403 |
| `x-api-key` | 被剥离，不能代替会话 Cookie |

第三方集成使用 `/api/v1`。

## 认证端点

`/api/auth/*` 由 better-auth 处理，只放行下表中的路径与方法。匹配为精确匹配（不接受前缀、编码变体或结尾斜杠），其余请求返回 404。请求中的 `x-api-key` 被剥离；客户端 IP 按 `EDGEWEIR_TRUSTED_PROXIES` 解析后传入。控制台不开放注册；账户在初始化向导、平台管理员创建用户或接受邀请时创建。`NODE_ENV=production` 时启用限速，计数存于 PostgreSQL。

| 路径 | 方法 |
| --- | --- |
| `/api/auth/get-session` | `GET` |
| `/api/auth/sign-in/email` | `POST` |
| `/api/auth/sign-out` | `POST` |
| `/api/auth/change-password` | `POST` |
| `/api/auth/two-factor/enable` | `POST` |
| `/api/auth/two-factor/disable` | `POST` |
| `/api/auth/two-factor/verify-totp` | `POST` |
| `/api/auth/two-factor/verify-backup-code` | `POST` |
| `/api/auth/passkey/generate-register-options` | `GET` |
| `/api/auth/passkey/verify-registration` | `POST` |
| `/api/auth/passkey/generate-authenticate-options` | `GET` |
| `/api/auth/passkey/verify-authentication` | `POST` |
| `/api/auth/passkey/list-user-passkeys` | `GET` |
| `/api/auth/passkey/delete-passkey` | `POST` |
| `/api/auth/api-key/create` | `POST` |
| `/api/auth/api-key/list` | `GET` |
| `/api/auth/api-key/delete` | `POST` |

## 健康检查

`GET /healthz` 返回 200：

```json
{ "status": "ok", "version": "20260929-a1b2c3d" }
```

| 字段 | 说明 |
| --- | --- |
| `status` | 固定为 `ok` |
| `version` | 运行版本（`EDGEWEIR_VERSION`）；源码运行为 `dev` |

HTTP 服务监听即返回，不检查数据库。容器健康检查见[命令行](cli.md#容器)。

## 安装脚本与发布镜像

`GET /install.sh` 返回节点安装脚本（`text/x-shellscript`，`cache-control: no-store`），脚本中的控制台地址替换为 `EDGEWEIR_PUBLIC_URL`。选项见[命令行](cli.md#节点安装脚本)。

`GET`、`HEAD` `/downloads/*` 从 `EDGEWEIR_DOWNLOADS_DIR` 提供文件，URL 路径与目录中的相对路径相同：

| 路径 | 内容 | `cache-control` |
| --- | --- | --- |
| `/downloads/<项目>/latest` | 最新版本号，文本 | `no-cache` |
| `/downloads/<项目>/v<语义化版本>/<文件>` | 发布文件 | `public, max-age=86400, immutable` |

`<项目>` 为 `edgeweir-node` 或 `cosign`。其他路径、不存在的文件、指向目录外的符号链接返回 404。目录准备见[接入节点](../deploy/nodes.md)。

## 节点通道

| 项 | 值 |
| --- | --- |
| 协议 | Connect-RPC，HTTPS（HTTP/2，兼容 HTTP/1.1），TLS 1.2 及以上 |
| 监听 | `NODE_API_HOST:NODE_API_PORT`，默认 `8443` |
| 服务 | `edgeweir.node.v1.NodeService`，定义见 [`proto/edgeweir/node/v1/node.proto`](https://github.com/marvinli001/edgeweir/blob/master/proto/edgeweir/node/v1/node.proto) |
| 服务器证书 | 控制台内部 CA 在每次启动时签发，名称见[环境变量](environment.md#访问地址与网络) |
| 认证 | `Enroll`：一次性注册 token，节点预先固定内部 CA 的 SHA-256 指纹。其他 RPC：内部 CA 签发的客户端证书（mTLS），证书 CN 为节点 ID |
| 其他路径 | 404 |

> [!WARNING]
> 节点通道必须直连或四层透传；终结 TLS 的代理会使节点 mTLS 失败。见[端口、反向代理与可信代理](../deploy/networking.md)。

