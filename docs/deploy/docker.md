# 用 Docker Compose 部署 Edgeweir 控制台

控制台是**一个镜像、一个进程**：同时提供 Web 控制台和 API（`:3000`）、节点通道（`:8443`）和后台任务。唯一的外部依赖是 PostgreSQL 18。

> 宝塔面板用户请看 [baota.md](baota.md)。

## 1. 准备

- Linux 服务器，Docker Engine 24+，Docker Compose v2（`docker compose version`）。
- 放行端口：
  - `3000/TCP`：Web 控制台与 API。可以放在反向代理后面（在代理上配置 HTTPS）。
  - `8443/TCP`：节点通道。**必须直连或四层透传**：TLS 由控制台自己终结，节点用客户端证书做双向认证，反向代理终结 TLS 会让双向认证失效。

## 2. 获取编排文件并生成密钥

```bash
mkdir -p /opt/edgeweir && cd /opt/edgeweir
curl -fsSLO https://raw.githubusercontent.com/edgeweir/edgeweir/master/compose.yml
curl -fsSL -o .env https://raw.githubusercontent.com/edgeweir/edgeweir/master/.env.example
```

编辑 `.env`，至少填写：

| 变量 | 说明 |
| --- | --- |
| `EDGEWEIR_MASTER_KEY` | 主密钥，用于信封加密入库的私钥和 DNS API 密钥。`openssl rand -base64 32` 生成，**务必离线备份**，丢失后已加密的数据无法恢复。 |
| `BETTER_AUTH_SECRET` | 会话签名密钥，`openssl rand -base64 32` 生成。 |
| `POSTGRES_PASSWORD` | 内置 PostgreSQL 的密码（数据库端口不对外暴露）。 |
| `EDGEWEIR_PUBLIC_URL` | 浏览器访问控制台的地址，例如 `https://cdn-admin.example.com`。 |
| `EDGEWEIR_NODE_API_URL` | 节点连接节点通道的地址，例如 `https://cdn-admin.example.com:8443`。留空时取 `EDGEWEIR_PUBLIC_URL` 的主机名加 `:8443`。 |

一次性生成三个密钥：

```bash
for k in EDGEWEIR_MASTER_KEY BETTER_AUTH_SECRET POSTGRES_PASSWORD; do
  sed -i "s|^$k=.*|$k=$(openssl rand -base64 32 | tr -d '/+=')|" .env
done
```

控制台缺少 `EDGEWEIR_MASTER_KEY` 或 `BETTER_AUTH_SECRET` 时会拒绝启动，并在日志里写明原因。

## 3. 启动

```bash
docker compose up -d
docker compose logs -f console
```

首次启动会自动执行数据库迁移、生成节点通道的内部 CA（私钥用主密钥加密后入库），然后监听 `:3000` 和 `:8443`。浏览器打开 `EDGEWEIR_PUBLIC_URL`，按初始化向导创建平台管理员和第一个组织；默认集群会自动创建。

可选组件：

```bash
docker compose --profile analytics up -d   # ClickHouse：原始日志与聚合（后续版本启用）
docker compose --profile cache up -d       # Valkey：可选缓存
```

## 4. 添加节点

控制台「集群与节点 → 添加节点」会生成一条一次性安装命令，在节点服务器上以 root 执行：

```bash
curl -fsSL https://cdn-admin.example.com/install.sh | sudo bash -s -- \
  --server https://cdn-admin.example.com:8443 --token <一次性 token> --ca-sha256 <CA 指纹>
```

安装脚本先校验 cosign 签名和 SHA-256，再安装 OpenResty 和 `edgeweir-node`；节点在本机生成私钥，用 token 换取证书，之后全程 mTLS。控制台不保存任何 SSH 凭据。

## 5. 反向代理示例

Web 控制台（HTTP 层，可以终结 TLS）：

```nginx
server {
  listen 443 ssl;
  server_name cdn-admin.example.com;
  # ssl_certificate ...;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

节点通道（只能四层透传，不能终结 TLS）：

```nginx
stream {
  server {
    listen 8443;
    proxy_pass 127.0.0.1:18443;   # .env 里设置 EDGEWEIR_NODE_API_PORT=127.0.0.1:18443
  }
}
```

## 6. 扩展与角色

同一个镜像用 `ROLE` 选择角色：`all`（默认）、`app`（Web/API/节点通道）、`worker`（pg-boss 后台任务）。流量大时可以运行多个 `app` 副本和一个或多个 `worker`，它们共享 PostgreSQL，通过 LISTEN/NOTIFY 广播配置变更。

## 7. 升级、备份与验证

- 升级：`docker compose pull && docker compose up -d`。迁移在启动时自动执行（带锁，多实例安全）。
- 备份：`docker compose exec postgres pg_dump -U edgeweir edgeweir > edgeweir.sql`，同时备份 `.env` 里的 `EDGEWEIR_MASTER_KEY`。
- 校验镜像签名：

```bash
cosign verify ghcr.io/edgeweir/edgeweir:<版本> \
  --certificate-identity-regexp '^https://github\.com/edgeweir/edgeweir/\.github/workflows/release\.yml@refs/tags/v.*$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## 8. 排障

| 现象 | 检查 |
| --- | --- |
| 控制台起不来 | `docker compose logs console`，通常是缺少密钥或连不上数据库。 |
| 节点注册失败 `CA fingerprint mismatch` | 节点连到了错误的地址，或中间有设备终结了 TLS。 |
| 节点一直离线 | 节点能否访问 `EDGEWEIR_NODE_API_URL`；防火墙/安全组是否放行 8443；证书的主机名是否在 `EDGEWEIR_NODE_API_HOSTNAMES` 中。 |
| 健康检查 | `curl http://127.0.0.1:3000/healthz` |
