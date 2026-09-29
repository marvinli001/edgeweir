# Fly.io

在 Fly.io 上用控制台镜像部署控制台，PostgreSQL 18 使用外部实例。

## 要求

| 项目 | 要求 |
| --- | --- |
| Fly.io | 可创建应用的组织；`fly` CLI，已执行 `fly auth login` |
| 控制台镜像 | `ghcr.io/marvinli001/edgeweir:<YYYYMMDD>-<commit>`，公开拉取；tag 规则见 [版本、升级与回滚](upgrade.md) |
| PostgreSQL | PostgreSQL 18，Machine 可达。Fly Managed Postgres 只提供 16 与 17，不满足要求 |
| 公网地址 | 独享 IPv4 与独享 IPv6 |
| 主密钥 | `openssl rand -base64 32` 生成；保存在 Fly.io 之外，与数据库备份分开 |
| 常驻运行 | `auto_stop_machines = "off"` |
| 本机命令 | `openssl`、`curl` |

## 拓扑

| Fly.io 资源 | 目标 | 承载 |
| --- | --- | --- |
| 应用 `edgeweir-console`，1 台 Machine | — | `ROLE=all`（镜像默认）：Web UI、API、节点通道、pg-boss worker |
| `[http_service]`：80（HTTP，重定向到 HTTPS）、443（Fly Proxy 终结 TLS） | 容器端口 3000 | 浏览器、`/api/v1`、`/install.sh`、`/healthz` |
| `[[services]]`：8443/TCP，无 handler | 容器端口 8443 | 节点通道；Fly Proxy 原样转发 TCP，TLS 与 mTLS 由控制台终结 |
| 独享 IPv4、独享 IPv6，主机名 `edgeweir-console.fly.dev` | 以上全部端口 | 共享 IPv4 不转发 8443 |
| 外部 PostgreSQL 18 | secret `DATABASE_URL` | 数据库 |

端口与节点通道证书的通用规则见 [端口、反向代理与可信代理](networking.md)。

## 1. 创建应用

```bash
fly apps create edgeweir-console --org <组织>
```

应用名全局唯一，并决定默认主机名 `<应用名>.fly.dev`。

## 2. 编写 fly.toml

在空目录中创建 `fly.toml`。按实际修改 `app`、`primary_region`、镜像 tag 与 URL 中的应用名。

```toml title="fly.toml"
app = "edgeweir-console"
primary_region = "nrt"

[build]
  image = "ghcr.io/marvinli001/edgeweir:20260929-a1b2c3d"

[env]
  EDGEWEIR_PUBLIC_URL = "https://edgeweir-console.fly.dev"
  EDGEWEIR_NODE_API_URL = "https://edgeweir-console.fly.dev:8443"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1

  [[http_service.checks]]
    grace_period = "30s"
    interval = "15s"
    timeout = "5s"
    method = "GET"
    path = "/healthz"

[[services]]
  internal_port = 8443
  protocol = "tcp"
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1

  [[services.ports]]
    port = 8443

  [[services.tcp_checks]]
    grace_period = "30s"
    interval = "15s"
    timeout = "2s"

[[vm]]
  size = "shared-cpu-1x"
  memory = "1gb"
```

| 配置 | 作用 |
| --- | --- |
| `[build] image` | 部署该镜像，不构建 |
| `[http_service]`：`internal_port = 3000`、`force_https = true` | 80 重定向到 HTTPS；443 由 Fly Proxy 终结 TLS 后转发到 3000 |
| `auto_stop_machines = "off"`、`min_machines_running = 1` | Fly Proxy 不停止空闲 Machine |
| `[[http_service.checks]]` | 经私有网络直连 Machine，`GET /healthz` 须返回 2xx |
| `[[services]]`：`internal_port = 8443`；`[[services.ports]]`：`port = 8443`，无 `handlers` | Fly Proxy 原样转发 TCP |
| `[[services.tcp_checks]]` | 检查 8443 可连接 |
| `[[vm]]` | 控制台未规定最低规格；示例为 `shared-cpu-1x`、1 GB |

## 3. 设置 secrets

```bash
umask 077
openssl rand -base64 32 > edgeweir-master-key
fly secrets set --stage \
  EDGEWEIR_MASTER_KEY="$(cat edgeweir-master-key)" \
  DATABASE_URL='postgres://edgeweir:<密码>@<主机>:5432/edgeweir'
```

主密钥输出原样使用。Fly.io 不提供 secret 明文读取；`edgeweir-master-key` 离线保存，与数据库备份分开，见 [备份与恢复](backup.md)。

## 4. 部署

```bash
fly deploy --ha=false
```

`--ha=false` 只创建 1 台 Machine。首次部署为应用分配独享 IPv6 与共享 IPv4。

## 5. 分配独享 IPv4

```bash
fly ips allocate-v4 --yes
fly ips list
fly ips release <共享 IPv4>
```

分配独享 IPv4 后释放共享 IPv4，`edgeweir-console.fly.dev` 解析到独享地址。

## 6. 初始化

未初始化的控制台每次启动都在日志中输出同一个 setup token：

```bash
fly logs --no-tail | grep setupToken
```

日志缓冲区中没有该行时，执行 `fly apps restart edgeweir-console` 后重新读取。打开该行 `url` 字段的地址（`<EDGEWEIR_PUBLIC_URL>/setup`），在初始化向导中填入 setup token，见 [快速上手](../guide/first-site.md#1-完成初始化向导)。

## 变量

| 变量 | 位置 | 值 | 说明 |
| --- | --- | --- | --- |
| `DATABASE_URL` | secret | PostgreSQL 18 连接串 | 必填。 |
| `EDGEWEIR_MASTER_KEY` | secret | `openssl rand -base64 32` 的输出 | 必填。 |
| `EDGEWEIR_PUBLIC_URL` | `[env]` | `https://edgeweir-console.fly.dev` | 使用自定义域名时改为该域名。 |
| `EDGEWEIR_NODE_API_URL` | `[env]` | `https://edgeweir-console.fly.dev:8443` | 主机名须解析到独享 IPv4 与 IPv6；自动写入节点通道证书。 |
| `EDGEWEIR_NODE_API_HOSTNAMES` | `[env]` | 空 | 节点通道证书的额外名称，逗号分隔。 |
| `EDGEWEIR_TRUSTED_PROXIES` | — | 空 | 见 [限制](#限制)。 |
| `EDGEWEIR_VERSION` | — | 不设置 | 镜像内置的运行版本；版本由 `[build] image` 的 tag 决定。 |
| `BETTER_AUTH_SECRET` | secret | 不设置 | 从已设置它的部署迁移时保留原值。 |

同名变量 secret 优先于 `[env]`。`ROLE`、`HOST`、`PORT`、`NODE_API_PORT` 使用镜像默认值 `all`、`0.0.0.0`、`3000`、`8443`，与 `internal_port` 一致。全部变量见 [环境变量](../reference/environment.md)。

## 验证

| 检查 | 命令或位置 | 预期 |
| --- | --- | --- |
| Machine | `fly status` | 1 台 Machine，状态 `started`，检查全部通过 |
| 公网地址 | `fly ips list` | 独享 IPv4 与 IPv6，无共享 IPv4 |
| Web 与 API | `curl -fsS https://edgeweir-console.fly.dev/healthz` | `{"status":"ok","version":"20260929-a1b2c3d"}` |
| 节点通道 TLS | 下方 `openssl` 命令 | 签发者为 `Edgeweir Node Channel CA`，SAN 含 `edgeweir-console.fly.dev` |
| 节点通道地址 | **后台 → 系统设置** 的「节点通道」 | `https://edgeweir-console.fly.dev:8443` |
| 节点注册 | **后台 → 集群与节点** → **添加节点** → **生成安装命令** | `--server` 为 `https://edgeweir-console.fly.dev:8443`；在节点上执行见 [接入节点](nodes.md) |

```bash
openssl s_client -connect edgeweir-console.fly.dev:8443 -servername edgeweir-console.fly.dev </dev/null 2>/dev/null \
  | openssl x509 -noout -text | grep -E 'Issuer:|Subject:|DNS:'
```

预期：

```text
        Issuer: CN=Edgeweir Node Channel CA, O=Edgeweir
        Subject: CN=edgeweir-node-api, O=Edgeweir
                DNS:localhost, IP Address:127.0.0.1, IP Address:0:0:0:0:0:0:0:1, DNS:<Machine 主机名>, DNS:edgeweir-console.fly.dev
```

出现其他签发者表示 TLS 被中间设备终结。

## 自定义域名

在注册节点之前完成。

1. 添加证书：

   ```bash
   fly certs add console.example.com
   ```

2. 按输出在 DNS 中添加 `A`（独享 IPv4）与 `AAAA` 记录。
3. 修改 `fly.toml` 的 `[env]`：

   ```toml title="fly.toml"
   [env]
     EDGEWEIR_PUBLIC_URL = "https://console.example.com"
     EDGEWEIR_NODE_API_URL = "https://console.example.com:8443"
   ```

4. 部署：

   ```bash
   fly deploy
   ```

5. 验证：以 `console.example.com` 执行 [验证](#验证) 中的 `curl` 与 `openssl` 命令。

已注册节点更换节点通道地址见 [节点通道地址与证书](networking.md#节点通道地址与证书)。

## 升级

1. 备份数据库，见 [备份与恢复](backup.md)。
2. 将 `fly.toml` 中 `[build] image` 改为新 tag。
3. 部署：

   ```bash
   fly deploy
   ```

4. 验证：

   ```bash
   curl -fsS https://edgeweir-console.fly.dev/healthz
   ```

   预期：`version` 为新 tag。

迁移、签名校验与回滚见 [版本、升级与回滚](upgrade.md)。

## 限制

| 项目 | 行为 | 影响 |
| --- | --- | --- |
| 客户端 IP | Fly Proxy 以 `Fly-Client-IP` 与 `X-Forwarded-For` 传递客户端地址；Fly Proxy 连接 Machine 的来源地址范围未公布；控制台不读取 `Fly-Client-IP` | `EDGEWEIR_TRUSTED_PROXIES` 留空；审计日志 IP 与登录限速按 Fly Proxy 地址计算，见 [可信代理与客户端 IP](networking.md#可信代理与客户端-ip) |
| 共享 IPv4 | 只转发 80、443 与使用 `tls` handler 的端口 | 节点经 IPv4 连接 8443 需要独享 IPv4 |
| 未分配独享 IPv4 | 8443 只经独享 IPv6 可达 | 无 IPv6 的节点无法连接 |
| 部署策略 | 默认 `rolling`：逐台停止旧 Machine 并替换 | 单 Machine 部署期间 Web 控制台与节点通道中断；多实例条件见 [部署概览](README.md#扩展) |
| 自动停止 | `auto_stop_machines` 为 `stop` 或 `suspend` 时 Fly Proxy 停止空闲 Machine | 必须为 `off`：停止后 worker 定时任务与节点通道中断 |
| Machine 规格 | `fly scale vm`、`fly scale memory` 的修改在下次 `fly deploy` 时按 `[[vm]]` 重置 | 规格在 `fly.toml` 中修改 |
| secret | 不可读回明文 | 主密钥在 Fly.io 之外保存 |
| `/downloads/*` | 容器无下载镜像目录，`EDGEWEIR_DOWNLOADS_DIR` 未设置 | 返回 404；`install.sh` 从 GitHub 下载，见 [接入节点](nodes.md#下载镜像) |
