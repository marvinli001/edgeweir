# bunny.net Magic Containers

在 bunny.net Magic Containers 上用控制台镜像部署控制台，PostgreSQL 18 使用外部实例：Dashboard 步骤与 bunny CLI 等效操作。

## 要求

| 项目 | 要求 |
| --- | --- |
| bunny.net | 已验证付款卡的账户。试用账户限 1 个应用，每个实例 1 CPU、4 GiB 内存 |
| bunny CLI | 可选：`npm install -g @bunny.net/cli`（0.18），已执行 `bunny login`；用法与限制见 [操作方式](#操作方式) |
| 控制台镜像 | `ghcr.io/marvinli001/edgeweir:<YYYYMMDD>-<commit>`，公开拉取；Magic Containers 只运行 linux/amd64，镜像包含该架构。tag 规则见 [版本、升级与回滚](upgrade.md) |
| PostgreSQL | PostgreSQL 18，容器可达。按来源地址放行时，放行 `https://api.bunny.net/mc/nodes/plain` 列出的地址，该列表会变化。bunny Database 是 libSQL，不能替代 PostgreSQL |
| 公网地址 | 一个 Anycast IPv4（每月 2 美元）；Anycast 不提供 IPv6 |
| 主密钥 | `openssl rand -base64 32` 生成；保存在 bunny.net 之外，与数据库备份分开 |
| 常驻运行 | 最小实例数 1，平台不会缩容到零 |
| 本机命令 | `openssl`、`curl` |

## 拓扑

| Magic Containers 资源 | 目标 | 承载 |
| --- | --- | --- |
| 应用 `edgeweir-console`，容器 `edgeweir`，1 个区域、1 个实例 | — | `ROLE=all`（镜像默认）：Web UI、API、节点通道、pg-boss worker |
| CDN 端点：主机名 `mc-<id>.bunny.run`，背后是 pull zone `mc-<id>`（系统主机名 `mc-<id>.b-cdn.net`） | 容器端口 3000 | HTTPS，bunny.net 边缘终结 TLS：浏览器、`/api/v1`、`/install.sh`、`/healthz` |
| Anycast 端点：Anycast IPv4 的 8443/TCP | 容器端口 8443 | 节点通道；按 TCP 转发并保留客户端源地址，TLS 与 mTLS 由控制台终结 |
| 外部 PostgreSQL 18 | 环境变量 `DATABASE_URL` | 数据库 |

端口与节点通道证书的通用规则见 [端口、反向代理与可信代理](networking.md)。

## 操作方式

应用在 Dashboard 或用 bunny CLI 创建。CLI 0.18 的 `bunny apps` 为实验性命令：不下发健康检查；每次 `bunny apps deploy` 按 `bunny.jsonc` 重写容器，删除健康检查与文件中没有的端点。健康检查与升级在 Dashboard 完成，或用 `bunny api` 调用 API。

| 步骤 | Dashboard | bunny CLI |
| --- | --- | --- |
| [1. 生成主密钥](#1-生成主密钥) | — | 本机 `openssl` |
| [2. 创建应用](#2-创建应用) | **Magic Containers → + Add App** | `bunny apps deploy` |
| [3. 设置变量](#3-设置变量) | **Container Settings → Edit → Environment Variables** | `bunny apps env push` |
| [4. 健康检查](#4-健康检查) | **Container Settings → Edit → Monitoring** | `bunny api PATCH` |
| [5. Pull zone 设置](#5-pull-zone-设置) | **CDN → Pull Zones →** `mc-<id>` | `bunny api POST` |
| [6. 初始化](#6-初始化) | **Logging → Logs → Application** | — |
| [自定义域名](#自定义域名) | Pull zone 的 **Hostnames** | — |
| [升级](#升级) | **Container Settings → Edit** | `bunny api PATCH` |

## 1. 生成主密钥

```bash
umask 077
openssl rand -base64 32 > edgeweir-master-key
```

输出原样使用。`edgeweir-master-key` 离线保存，与数据库备份分开，见 [备份与恢复](backup.md)。

## 2. 创建应用

1. Dashboard → **Magic Containers → + Add App**。
2. 镜像：搜索 `marvinli001/edgeweir`（GitHub），选择目标 tag，不使用 `latest`。容器名改为 `edgeweir`。
3. **Endpoints**：删除页面按镜像 `EXPOSE` 预填的端点，再添加：

   | 类型 | 容器端口 | 对外端口 | 其他 |
   | --- | --- | --- | --- |
   | **+ CDN** | 3000 | — | **SSL for origin** 关闭 |
   | **+ Anycast IP** | 8443 | 8443 | — |

   不要为 3000 添加 Anycast 端点：HTTP 会绕过 CDN 直接暴露在公网。
4. **Environment variables → Raw editor**：

   ```ini
   DATABASE_URL=postgres://edgeweir:<密码>@<主机>:5432/edgeweir
   EDGEWEIR_MASTER_KEY=<edgeweir-master-key 的内容>
   ```

5. **Region** 选 PostgreSQL 附近、支持 Anycast 的一个区域；**App name** 填 `edgeweir-console`；点击 **Deploy**。
6. 应用 **Regions and Scaling**：最小与最大实例数均为 1，不添加区域。

此时控制台缺少 `EDGEWEIR_PUBLIC_URL`，启动失败并被平台反复重启，第 3 步后恢复。

bunny CLI：在空目录中创建 `bunny.jsonc`，按实际修改 `regions` 与镜像 tag：

```jsonc title="bunny.jsonc"
{
  "$schema": "https://raw.githubusercontent.com/BunnyWay/cli/main/packages/config/generated/schema.json",
  "version": "2026-05-11",
  "app": {
    "name": "edgeweir-console",
    "regions": ["DE"],
    "scaling": { "min": 1, "max": 1 },
    "containers": {
      "edgeweir": {
        "image": "ghcr.io/marvinli001/edgeweir:20260929-a1b2c3d",
        "endpoints": [
          { "type": "cdn", "ssl": false, "ports": [{ "public": 443, "container": 3000 }] },
          { "type": "anycast", "ports": [{ "public": 8443, "container": 8443 }] }
        ]
      }
    }
  }
}
```

| 配置 | 作用 |
| --- | --- |
| `regions` | 区域 ID，`bunny apps regions list` 列出；数组形式同时设为必需区域与允许区域，不扩展到其他区域 |
| `scaling` | 每个区域最小、最大实例数 |
| `"ssl": false` | CDN 以 HTTP 连接容器的 3000。默认 `true` 时以 HTTPS 连接，控制台不响应 |
| 无 `env` | 容器声明 `env` 时，每次 `bunny apps deploy` 用它替换全部变量；变量用第 3 步的 `bunny apps env push` 设置 |

在该目录执行：

```bash
bunny apps deploy
```

首次执行创建应用、写入 `.bunny/app.json`（应用 ID）并部署。CLI 询问 `ghcr.io` 的凭据时选择公开镜像。

## 3. 设置变量

1. 读取端点地址：Dashboard 应用 **Endpoints**，或：

   ```bash
   bunny apps endpoints list
   ```

   CDN 端点为 `mc-<id>.bunny.run`；Anycast 端点为 `<Anycast IP>:8443`。
2. 应用 **Container Settings → Edit → Environment Variables**，补全后点击 **Update Container**，再 **Save Changes**：

   ```ini
   DATABASE_URL=postgres://edgeweir:<密码>@<主机>:5432/edgeweir
   EDGEWEIR_MASTER_KEY=<edgeweir-master-key 的内容>
   EDGEWEIR_PUBLIC_URL=https://mc-<id>.bunny.run
   EDGEWEIR_NODE_API_URL=https://<Anycast IP>:8443
   ```

bunny CLI：将上面四行写入 `.env.bunny`（`umask 077`），然后：

```bash
bunny apps env push .env.bunny --container edgeweir
```

变量修改触发滚动更新。Magic Containers 没有 secret 存储：变量值以明文显示在 Dashboard、API 与 `bunny apps env pull` 中。各变量见 [变量](#变量)。

## 4. 健康检查

应用 **Container Settings → Edit → Monitoring**，勾选三项，类型 **HTTP GET**，路径 `/healthz`，端口 `3000`，点击 **Update Container**。

| 检查 | 作用 | 建议参数 |
| --- | --- | --- |
| Startup | 通过前不转发请求 | 间隔 5 秒、失败阈值 30：首次启动执行迁移，PostgreSQL 不可达时控制台最多等待 60 秒 |
| Readiness | 失败时停止转发请求 | 间隔 10 秒、失败阈值 3 |
| Liveness | 失败时重启容器 | 间隔 15 秒、失败阈值 4 |

bunny CLI：创建 `probes.json`：

```json title="probes.json"
{
  "probes": {
    "startup": { "initialDelaySeconds": 5, "periodSeconds": 5, "timeoutSeconds": 3, "failureThreshold": 30, "httpGet": { "request": { "path": "/healthz", "portNumber": 3000 } } },
    "readiness": { "periodSeconds": 10, "timeoutSeconds": 3, "failureThreshold": 3, "httpGet": { "request": { "path": "/healthz", "portNumber": 3000 } } },
    "liveness": { "periodSeconds": 15, "timeoutSeconds": 5, "failureThreshold": 4, "httpGet": { "request": { "path": "/healthz", "portNumber": 3000 } } }
  }
}
```

查询容器 ID（`containerTemplates[].id`，应用 ID 在 `.bunny/app.json`），再写入：

```bash
bunny api GET /mc/apps/<应用 ID>
bunny api PATCH /mc/apps/<应用 ID>/containers/<容器 ID> --body "$(cat probes.json)"
```

`bunny apps deploy` 会删除健康检查，执行后重新写入。

## 5. Pull zone 设置

CDN 端点创建 pull zone `mc-<id>`。控制台对 `/assets/*` 以外的响应发送 `Cache-Control: no-store`；以下设置保持控制台的响应不进入缓存，并让会话 Cookie 到达浏览器。

| 设置 | 位置 | 值 |
| --- | --- | --- |
| Smart Cache | **Caching** | 开启（默认）：HTML 与 JSON 不缓存 |
| Cache expiration time | **Caching** | Respect origin Cache-Control（默认） |
| Disable Cookies | **Caching** | 关闭（默认）：开启后 `Set-Cookie` 被移除，无法登录 |
| Force SSL | **General → Hostnames**，每个主机名 | 开启：HTTP 请求重定向到 HTTPS |
| Edge Rules | **Edge Rules** | 不为控制台路径添加 **Override Cache Time** |

bunny CLI（`<pull zone ID>` 为 `bunny api GET /mc/apps/<应用 ID>/endpoints` 中 CDN 端点的 `pullZoneId`）：

```bash
bunny api POST /pullzone/<pull zone ID>/setForceSSL --body '{"Hostname":"mc-<id>.bunny.run","ForceSSL":true}'
bunny api POST /pullzone/<pull zone ID>/setForceSSL --body '{"Hostname":"mc-<id>.b-cdn.net","ForceSSL":true}'
```

## 6. 初始化

未初始化的控制台每次启动都在日志中输出同一个 setup token。

1. 应用 **Logging → Logs → Application**，搜索 `first-run setup`。日志保留 5 天，可能含有更换数据库之前的 setup token：取最新一行。
2. 该行 `setupToken` 字段为 setup token，`url` 字段为初始化向导地址（`<EDGEWEIR_PUBLIC_URL>/setup`）。
3. 打开向导，填入 setup token，见 [快速上手](../guide/first-site.md#1-完成初始化向导)。

没有该行时重启应用（应用 **Restart**，或 `bunny apps restart`）后重新搜索。

## 变量

| 变量 | 值 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL 18 连接串 | 必填。 |
| `EDGEWEIR_MASTER_KEY` | `openssl rand -base64 32` 的输出 | 必填。 |
| `EDGEWEIR_PUBLIC_URL` | `https://mc-<id>.bunny.run` | 必填。使用自定义域名时改为该域名。 |
| `EDGEWEIR_NODE_API_URL` | `https://<Anycast IP>:8443` | 必填：默认值 `https://<公开域名>:8443` 指向 CDN，不可达。主机名或 IP 自动写入节点通道证书。 |
| `EDGEWEIR_NODE_API_HOSTNAMES` | 空 | 节点通道证书的额外名称，逗号分隔。 |
| `EDGEWEIR_TRUSTED_PROXIES` | 空，或 bunny.net 边缘服务器地址 | 见 [限制](#限制)。 |
| `EDGEWEIR_VERSION` | 不设置 | 镜像内置的运行版本；版本由镜像 tag 决定。 |
| `BETTER_AUTH_SECRET` | 不设置 | 从已设置它的部署迁移时保留原值。 |

`EDGEWEIR_TRUSTED_PROXIES` 的值由 bunny.net 的两个边缘服务器列表生成：

```bash
( curl -fsS https://api.bunny.net/system/edgeserverlist/plain; echo
  curl -fsS https://api.bunny.net/system/edgeserverlist/ipv6/plain ) | grep -v '^$' | paste -sd, -
```

`ROLE`、`HOST`、`PORT`、`NODE_API_PORT` 使用镜像默认值 `all`、`0.0.0.0`、`3000`、`8443`，与端点的容器端口一致。全部变量见 [环境变量](../reference/environment.md)。

## 验证

| 检查 | Dashboard 或命令 | 预期 |
| --- | --- | --- |
| 应用 | 应用 **Overview**；`bunny apps show` | 状态 Active，1 个实例 |
| Web 与 API | `curl -fsS https://mc-<id>.bunny.run/healthz` | `{"status":"ok","version":"20260929-a1b2c3d"}` |
| 缓存 | `curl -sI https://mc-<id>.bunny.run/api/v1/system/status` 执行两次 | 两次均为 `cdn-cache: MISS` |
| HTTPS | `curl -sI http://mc-<id>.bunny.run/healthz` | `301`，`Location` 为 HTTPS 地址 |
| 节点通道 TLS | 下方 `openssl` 命令 | 签发者为 `Edgeweir Node Channel CA`，SAN 含 Anycast IP |
| 节点通道地址 | **系统设置** 的「节点通道」 | `https://<Anycast IP>:8443` |
| 节点注册 | **集群与节点** → **添加节点**（对话框打开即显示安装命令） | `--server` 为 `https://<Anycast IP>:8443`；在节点上执行见 [接入节点](nodes.md) |

```bash
openssl s_client -connect <Anycast IP>:8443 </dev/null 2>/dev/null \
  | openssl x509 -noout -text | grep -E 'Issuer:|Subject:|DNS:'
```

预期：

```text
        Issuer: CN=Edgeweir Node Channel CA, O=Edgeweir
        Subject: CN=edgeweir-node-api, O=Edgeweir
                DNS:localhost, IP Address:127.0.0.1, IP Address:0:0:0:0:0:0:0:1, DNS:<容器主机名>, IP Address:<Anycast IP>
```

出现其他签发者表示 TLS 被中间设备终结。

## 自定义域名

在注册节点之前完成。

1. Web 控制台：pull zone `mc-<id>` → **General → Hostnames**，添加 `console.example.com`；在 DNS 中按界面给出的值添加 `CNAME`（`mc-<id>.b-cdn.net`）；点击 **Verify & Activate SSL**，再开启该主机名的 **Force SSL**。
2. 节点通道：pull zone 不转发 TCP。在 DNS 中添加 `nodes.example.com` 的 `A` 记录，指向 Anycast IP。
3. 修改变量（触发滚动更新）：

   ```ini
   EDGEWEIR_PUBLIC_URL=https://console.example.com
   EDGEWEIR_NODE_API_URL=https://nodes.example.com:8443
   ```

4. 验证：以新域名执行 [验证](#验证) 中的 `curl` 命令，以 `nodes.example.com:8443` 与 `-servername nodes.example.com` 执行 `openssl` 命令，SAN 含 `DNS:nodes.example.com`。

已注册节点更换节点通道地址见 [节点通道地址与证书](networking.md#节点通道地址与证书)。

## 升级

1. 备份数据库，见 [备份与恢复](backup.md)。
2. 应用 **Container Settings → Edit**，在镜像下拉框选择新 tag，点击 **Update Container**，再 **Save Changes** 并确认。
3. 验证：

   ```bash
   curl -fsS https://mc-<id>.bunny.run/healthz
   ```

   预期：`version` 为新 tag。

bunny CLI（第 2 步）：只修改镜像 tag，变量、端点与健康检查保持不变：

```bash
bunny api PATCH /mc/apps/<应用 ID>/containers/<容器 ID> --body '{"imageTag":"<新 tag>"}'
```

`bunny apps deploy <镜像>` 会删除健康检查，不用于升级。迁移、签名校验与回滚见 [版本、升级与回滚](upgrade.md)。

## 限制

| 项目 | 行为 | 影响 |
| --- | --- | --- |
| 客户端 IP | CDN 端点到容器的 TCP 对端是 bunny.net 边缘服务器，地址见公开列表 `https://api.bunny.net/system/edgeserverlist/plain` 与 `https://api.bunny.net/system/edgeserverlist/ipv6/plain`（900 余条，会变化）；边缘以单值 `X-Forwarded-For` 与 `X-Real-IP` 传递访客地址，并丢弃访客发送的同名头 | `EDGEWEIR_TRUSTED_PROXIES` 留空时，审计日志 IP 与登录限速按边缘地址计算，见 [可信代理与客户端 IP](networking.md#可信代理与客户端-ip)。写入两个列表（逗号连接，约 17 KB）后取访客地址；列表变化后需更新变量，新边缘的请求在更新前按边缘地址计算 |
| Anycast | 只有 IPv4 | 无 IPv4 的节点无法连接节点通道 |
| 变量 | 明文显示在 Dashboard、API 与 CLI 中 | 主密钥在 bunny.net 之外另存 |
| CLI 0.18 | `bunny apps deploy` 按 `bunny.jsonc` 重写容器：删除健康检查与文件中没有的端点；`env` 块替换全部变量 | 健康检查与升级用 Dashboard 或 `bunny api` |
| 滚动更新 | 变量、镜像或健康检查修改后先启动新实例，健康检查通过后停止旧实例；停止前发送 SIGTERM，宽限 30 秒 | 新旧版本短暂同时运行；旧实例上的节点通道连接断开后重连 |
| 区域 | 应用可运行在多个区域，Anycast 将节点引到最近的区域 | 每个区域都连接同一 PostgreSQL；多实例条件见 [部署概览](README.md#扩展) |
| 出站端口 | 25、465、587、2525 默认封锁 | 告警通知的 SMTP 渠道无法发送；经 bunny.net 工单开放端口 |
| 计费 | 最小实例数 1，Anycast IP 按月计费 | 应用停止（Undeploy）后 Anycast IP 仍计费 |
| `/downloads/*` | 容器无下载镜像目录，`EDGEWEIR_DOWNLOADS_DIR` 未设置 | 返回 404；`install.sh` 从 GitHub 下载，见 [接入节点](nodes.md#下载镜像) |
