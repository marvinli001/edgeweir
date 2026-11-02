# MCP

控制台在 `<控制台地址>/mcp` 提供 MCP 服务（Streamable HTTP），AI 客户端经 OAuth 授权后调用控制台的过程。默认关闭。

## 开启

1. 控制台地址（`EDGEWEIR_PUBLIC_URL`）须为 HTTPS，且客户端能访问；Claude.ai 等云端客户端要求公网可达。
2. 打开**系统** → **常规** → **MCP 服务**，开启**允许 MCP 客户端**并**保存**。
3. 复制**服务地址**，添加到客户端。

关闭后 `/mcp`、OAuth 端点与元数据都返回 404，已有授权保留，重新开启后恢复。

## 添加到客户端

| 客户端 | 操作 |
| --- | --- |
| Claude Code | `claude mcp add --transport http edgeweir https://console.example.com/mcp`，然后在 Claude Code 中运行 `/mcp` 选择 `edgeweir` 登录 |
| Claude.ai | **设置** → **连接器** → **添加自定义连接器**，填写服务地址，然后**连接** |
| Cursor | 在 `~/.cursor/mcp.json` 写入 `{"mcpServers": {"edgeweir": {"url": "https://console.example.com/mcp"}}}`，在 MCP 设置中点击登录 |
| Codex | `codex mcp add edgeweir --url https://console.example.com/mcp`，然后 `codex mcp login edgeweir` |

客户端打开浏览器：未登录控制台时先登录（登录白名单、两步验证照常适用），再在授权页选择**只读**或**读写**并**允许**。

## 授权页

| 项目 | 说明 |
| --- | --- |
| 客户端 | 客户端元数据文档所在的主机（client_id 为 URL 时），或**已注册客户端**（动态注册） |
| 返回至 | 授权码发往的主机。为本机（`localhost`、`127.0.0.1`、`[::1]`）时显示提示：只在你刚刚启动该客户端时允许 |
| 访问权限 | 默认**只读**；选择**读写**才授予修改权限。演示账号只能授予只读 |

## 权限范围

| scope | 允许 |
| --- | --- |
| `edgeweir:read` | `GET` 过程与只读 AccessKey 可调用的过程（例如 `rules.validate`） |
| `edgeweir:write` | 所有可用过程，包括修改 |
| `offline_access` | 发放刷新令牌，客户端无需再次授权即可续期 |

缺少 `edgeweir:write` 时调用修改，`/mcp` 返回 403 `insufficient_scope`，客户端可重新请求授权。

MCP 客户端不能调用：AccessKey、服务账号、扩展发布者密钥、MCP 设置、登录白名单、演示账号、初始化，以及只返回一次凭据的过程（`MCP_PROCEDURE_FORBIDDEN`）。

## 工具

| 工具 | 作用 |
| --- | --- |
| `search_operations` | 按关键词或分组查找过程；不带参数时列出分组 |
| `describe_operation` | 过程输入与输出的 JSON Schema |
| `call_operation` | 调用过程 |
| `get_overview` | 概览 |
| `list_sites` | 网站列表 |
| `purge_cache` | 刷新缓存 |
| `query_access_logs` | 访问日志（须给出 `from`、`to`） |
| `get_site_stats` | 流量统计 |
| `list_alerts` | 告警事件 |

工具调用在控制台进程内执行过程：校验、乐观并发与审计日志与 API 相同。审计日志的操作者为 **MCP 客户端**及其名称。单个结果超过 50000 字符时截断，缩小查询或分页。

## 已连接应用

**安全** → **已连接应用** 列出授权过的客户端、权限与最近使用时间。**撤销**删除授权与全部令牌，客户端的下一次请求返回 401。

## 限制

| 项目 | 值 |
| --- | --- |
| 访问令牌 | 不透明令牌（`ewo_` 前缀），数据库只存 SHA-256，只能用于 `/mcp`；`/mcp` 忽略 Cookie 与 `x-api-key` |
| 速率 | 每个授权每分钟 600 次请求，超出返回 429 与 `Retry-After` |
| 动态注册 | `/api/auth/oauth2/register` 每个 IP 每分钟 10 次；30 天内无人授权的客户端每小时清理 |
| 客户端元数据文档 | 经控制台的出站防护获取（拒绝内网地址与重定向），最大 5 KiB |
| PKCE | 必须使用 `S256` |
| DPoP | 不支持；DPoP 绑定的令牌被拒绝 |

## 发现端点

| 路径 | 内容 |
| --- | --- |
| `/.well-known/oauth-protected-resource/mcp` | 受保护资源元数据（RFC 9728） |
| `/.well-known/oauth-authorization-server/api/auth` | 授权服务器元数据（RFC 8414），签发者为 `<控制台地址>/api/auth` |

未带令牌的 `/mcp` 请求返回 401，`WWW-Authenticate` 中的 `resource_metadata` 指向受保护资源元数据。
