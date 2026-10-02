# 端口、反向代理与可信代理

控制台端口、反向代理、节点通道透传与客户端 IP 的配置。

## 端口

| 端口 | 协议 | 内容 | 暴露方式 | 约束 |
| --- | --- | --- | --- | --- |
| 3000/TCP | HTTP | Web UI、`/rpc`、`/api/v1`、`/healthz`、`/install.sh`、`/downloads/*` | 反向代理（可终结 TLS），或直接暴露 | 节点安装时从 `EDGEWEIR_PUBLIC_URL` 下载 `/install.sh` 与 `/downloads/*`，节点主机须能访问该地址。 |
| 8443/TCP | TLS 1.2 及以上，HTTP/2 或 HTTP/1.1，Connect-RPC | 节点通道（节点与区域探针） | 直接暴露，或四层透传 | 8443 必须四层透传；代理终结 TLS 会使节点与探针的 CA 校验与 mTLS 失败。 |
| 5432/TCP | PostgreSQL | 内置数据库 | 不发布 | 仅 Compose 网络内可达。 |
| 8123/TCP | HTTP | ClickHouse（`analytics` profile） | 不发布 | 仅 Compose 网络内可达。 |

## 监听与发布变量

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 进程的 Web 监听地址。 |
| `PORT` | `3000` | 进程的 Web 监听端口。 |
| `NODE_API_HOST` | 空，取 `HOST` | 进程的节点通道监听地址。 |
| `NODE_API_PORT` | `8443` | 进程的节点通道监听端口。 |
| `EDGEWEIR_HTTP_PORT` | `127.0.0.1:3000`（`compose.yml`） | Compose 发布的 Web 端口，可带绑定地址。 |
| `EDGEWEIR_NODE_API_PORT` | `8443` | Compose 发布的节点通道端口，可带绑定地址。 |

各编排文件的取值：

| 编排 | 进程监听 | 宿主机端口 |
| --- | --- | --- |
| `compose.yml` | 镜像默认值 `0.0.0.0:3000`、`0.0.0.0:8443` | 端口映射 `${EDGEWEIR_HTTP_PORT}:3000`（默认 `127.0.0.1:3000`）、`${EDGEWEIR_NODE_API_PORT}:8443`（默认所有接口） |
| `compose.baota.yml` | 镜像默认值 | 端口映射 `127.0.0.1:${EDGEWEIR_HTTP_PORT}:3000`（`EDGEWEIR_HTTP_PORT` 只能是数字）、`${EDGEWEIR_NODE_API_PORT}:8443` |
| `compose.baota-host.yml`（host 网络） | `HOST=127.0.0.1`、`PORT=${EDGEWEIR_HTTP_PORT}`、`NODE_API_HOST=0.0.0.0`、`NODE_API_PORT=${EDGEWEIR_NODE_API_PORT}` | 无端口映射；两个端口变量只能是数字 |

`compose.yml` 的 Web 端口默认只在本机可达，由宿主机反向代理对外：Docker 发布的端口绕过 ufw、firewalld 等主机防火墙。不经代理直接访问时设置 `EDGEWEIR_HTTP_PORT=3000`。

## 节点通道地址与证书

| 变量 | 默认值 | 作用 |
| --- | --- | --- |
| `EDGEWEIR_NODE_API_URL` | `https://<EDGEWEIR_PUBLIC_URL 的主机名>:<NODE_API_PORT>` | 节点连接节点通道的地址；安装命令中的 `--server`；**系统设置** 中的「节点通道」。 |
| `EDGEWEIR_NODE_API_HOSTNAMES` | 空 | 节点通道证书的额外名称，逗号分隔的 DNS 名或 IP。 |

- 节点通道的服务端证书由内部 CA 在每次启动时签发，名称包括：`localhost`、`127.0.0.1`、`::1`、容器主机名、`EDGEWEIR_NODE_API_URL` 的主机名、`EDGEWEIR_NODE_API_HOSTNAMES` 的全部条目。修改后重启生效。
- CA 指纹（SHA-256）出现在启动日志 `node channel listening` 的 `caSha256`、**系统设置** 的「CA 指纹」、安装命令的 `--ca-sha256`。

| 场景 | 设置 |
| --- | --- |
| 宿主机发布端口不是 8443，例如 `EDGEWEIR_NODE_API_PORT=9443` | 显式设置 `EDGEWEIR_NODE_API_URL=https://<主机名>:9443`：默认值使用进程监听端口 `NODE_API_PORT`，不是发布端口。 |
| 节点经其他名称或 IP 连接（内网地址、负载均衡名称） | 将该名称加入 `EDGEWEIR_NODE_API_HOSTNAMES`。 |
| 更换 `EDGEWEIR_NODE_API_URL` 的主机名 | 将旧主机名保留在 `EDGEWEIR_NODE_API_HOSTNAMES`：已注册节点使用注册时记录的 `server_url` 与 TLS 服务器名（`/var/lib/edgeweir-node/identity.json`）校验证书。 |

## 反向代理 Web 控制台

```nginx title="nginx"
server {
  listen 443 ssl;
  server_name cdn-admin.example.com;
  # ssl_certificate     ...;
  # ssl_certificate_key ...;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

| 项目 | 要求 |
| --- | --- |
| `EDGEWEIR_PUBLIC_URL` | 代理对外的地址，例如 `https://cdn-admin.example.com`。登录校验请求来源；协议为 `https` 时会话 Cookie 带 `Secure`。 |
| `EDGEWEIR_TRUSTED_PROXIES` | 代理连接控制台时使用的来源地址，见 [可信代理与客户端 IP](#可信代理与客户端-ip)。 |
| 转发头 | 控制台只读取 `X-Forwarded-For` 与 `X-Real-IP`，且仅在 TCP 对端可信时读取。 |

## 节点通道四层透传

8443 需要经 nginx 统一入口时，使用 `stream` 四层透传。

1. 将节点通道改到本机端口 18443：

   | 部署 | 设置 |
   | --- | --- |
   | `compose.yml`、`compose.baota.yml` | `.env`：`EDGEWEIR_NODE_API_PORT=127.0.0.1:18443` |
   | 进程直接监听（`pnpm dev`、非容器运行） | `NODE_API_HOST=127.0.0.1`、`NODE_API_PORT=18443` |
   | `compose.baota-host.yml` | 见 [baota.md](baota.md)：该文件固定 `NODE_API_HOST: 0.0.0.0` |

   `EDGEWEIR_NODE_API_URL` 保持对外的 `:8443`。

   ```bash
   docker compose up -d
   ```

2. 在 nginx 主配置的 `http { }` 块之外加入：

   ```nginx title="nginx"
   stream {
     server {
       listen 8443;
       proxy_pass 127.0.0.1:18443;
       proxy_timeout 1h;   # 节点通道长连接（WatchConfig 流）
     }
   }
   ```

   不写 `ssl`、`proxy_ssl`、`proxy_protocol`：只转发 TCP。

3. 检查并重载 nginx：

   ```bash
   nginx -t && nginx -s reload
   ```

4. 验证：

   ```bash
   openssl s_client -connect cdn-admin.example.com:8443 -servername cdn-admin.example.com </dev/null 2>/dev/null \
     | openssl x509 -noout -issuer
   ```

   预期：签发者含 `Edgeweir Node Channel CA`。出现其他签发者表示 TLS 被中间设备终结。**系统设置** 中「节点通道」旁的自检做同样的检查，从控制台所在网络连接 `EDGEWEIR_NODE_API_URL`，见 [节点通道自检](nodes.md#节点通道自检)。

## 可信代理与客户端 IP

审计日志的 IP 与认证接口限速使用控制台解析出的客户端 IP。

| 条件 | 客户端 IP |
| --- | --- |
| `EDGEWEIR_TRUSTED_PROXIES` 为空（默认） | TCP 对端地址；忽略全部转发头。 |
| TCP 对端不在列表中 | TCP 对端地址；忽略全部转发头。 |
| TCP 对端在列表中，请求带 `X-Forwarded-For` | 从右向左遍历，跳过列表中的地址，取第一个不在列表中的地址。 |
| TCP 对端在列表中，无 `X-Forwarded-For` | `X-Real-IP`；缺失时为 TCP 对端地址。 |

- 格式：逗号分隔的 IP 或 CIDR，例如 `172.18.0.1` 或 `10.0.0.0/24`。IPv4 映射的 IPv6 地址（`::ffff:192.0.2.1`）按 IPv4 处理。
- 条目无法解析时控制台拒绝启动：`EDGEWEIR_TRUSTED_PROXIES: not an IP address or CIDR range: <条目>`。
- 认证接口限速计数保存在 PostgreSQL，多个实例共享，重启不清零。

| 部署 | 代理到控制台的来源地址 | `EDGEWEIR_TRUSTED_PROXIES` |
| --- | --- | --- |
| 无反向代理 | — | 空 |
| 宿主机 nginx → `compose.yml` / `compose.baota.yml` 发布的 `127.0.0.1:3000` | Docker 网络 `edgeweir_default` 的网关 | 该网关地址 |
| 宿主机 nginx → `compose.baota-host.yml`（host 网络） | `127.0.0.1` 或 `::1` | `127.0.0.1,::1`（该文件的默认值） |

查询网关地址：

```bash
docker network inspect edgeweir_default --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
```

> [!WARNING]
> 只写入代理实际使用的地址。列表中的地址可以为任意客户端声明 IP；信任整个私网网段或客户端可直接进入的网段会使限速与审计 IP 失效。

验证：经代理登录一次，查询最近的审计记录：

```bash
docker compose exec -T postgres psql -U edgeweir -d edgeweir \
  -c "select occurred_at, action, ip from audit_log order by id desc limit 5"
```

预期：`ip` 为浏览器的公网地址，而不是网关地址。

## 排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 审计记录的 `ip` 均为网关地址（如 `172.18.0.1`） | `EDGEWEIR_TRUSTED_PROXIES` 未设置，或与实际网关不一致（重建 Compose 网络后网关可能变化） | 查询网关，更新 `EDGEWEIR_TRUSTED_PROXIES`，执行 `docker compose up -d`。 |
| 启动失败：`EDGEWEIR_TRUSTED_PROXIES: not an IP address or CIDR range` | 条目不是 IP 或 CIDR | 修正条目。 |
| 3000 可从公网直接访问 | `EDGEWEIR_HTTP_PORT` 不带绑定地址（例如 `3000`），或使用的是旧版 `compose.yml`（在所有接口发布） | 设置 `EDGEWEIR_HTTP_PORT=127.0.0.1:3000`，或更新 `compose.yml`。 |
| 节点注册或连接失败 | — | 见 [接入节点排障](nodes.md#排障)。 |
