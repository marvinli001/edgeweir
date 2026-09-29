# Railway

在 Railway 上用控制台镜像与 Railway PostgreSQL 18 部署控制台。

## 要求

| 项目 | 要求 |
| --- | --- |
| Railway | 可创建项目的账户；命令行步骤使用 `railway` CLI，已执行 `railway login` |
| 控制台镜像 | `ghcr.io/marvinli001/edgeweir:<YYYYMMDD>-<commit>`，公开拉取；tag 规则见 [版本、升级与回滚](upgrade.md) |
| PostgreSQL | Railway PostgreSQL 服务，镜像 `ghcr.io/railwayapp-templates/postgres-ssl:18` |
| 主密钥 | `openssl rand -base64 32` 生成；保存在 Railway 之外，与数据库备份分开 |
| 常驻运行 | 控制台服务关闭 Serverless |
| 本机命令 | `openssl`、`curl` |

## 拓扑

| Railway 资源 | 目标 | 承载 |
| --- | --- | --- |
| 服务 `edgeweir`，来源为控制台镜像 | — | `ROLE=all`（镜像默认）：Web UI、API、节点通道、pg-boss worker |
| Public Networking 域名：`<名称>.up.railway.app` 或自定义域名 | 容器端口 3000 | HTTPS，Railway 终结 TLS：浏览器、`/api/v1`、`/install.sh`、`/healthz` |
| TCP Proxy：`<名称>.proxy.rlwy.net:<端口>` | 容器端口 8443 | 节点通道；Railway 按 TCP 转发，TLS 与 mTLS 由控制台终结 |
| 服务 `Postgres` | 私有网络，`${{Postgres.DATABASE_URL}}` | PostgreSQL 18；默认无公网访问 |

端口与节点通道证书的通用规则见 [端口、反向代理与可信代理](networking.md)。

## 1. 创建项目与 PostgreSQL

在 Railway 新建 **Empty project**，在项目画布上用 **+ New** 添加 PostgreSQL。命令行：

```bash
railway init --name edgeweir
railway add --database postgres
```

在 `Postgres` 服务的 **Settings → Source** 确认镜像为 `ghcr.io/railwayapp-templates/postgres-ssl:18`。主版本低于 18 时，用 **Database → Config → Major Version Upgrade** 升级到 18。

## 2. 创建控制台服务

在项目画布添加服务，来源选 **Docker Image**，镜像填写 `ghcr.io/marvinli001/edgeweir:20260929-a1b2c3d`（替换为目标 tag），服务命名为 `edgeweir`。命令行：

```bash
railway add --service edgeweir --image ghcr.io/marvinli001/edgeweir:20260929-a1b2c3d
```

## 3. 公开 3000 与 8443

在 `edgeweir` 服务的 **Settings → Networking** 中依次操作：

| 顺序 | 操作 | 结果 |
| --- | --- | --- |
| 1 | **Public Networking → Generate Domain**，端口 `3000` | `<名称>.up.railway.app` |
| 2 | **TCP Proxy**，端口 `8443` | `<名称>.proxy.rlwy.net:<端口>`，端口由 Railway 分配 |

先生成域名，再创建 TCP 代理：已有 TCP 代理的服务添加域名前须删除 TCP 代理。命令行：

```bash
railway domain --service edgeweir --port 3000
railway tcp-proxy create --service edgeweir --port 8443
```

## 4. 生成主密钥

```bash
umask 077
openssl rand -base64 32 > edgeweir-master-key
```

输出原样使用。`edgeweir-master-key` 离线保存，与数据库备份分开，见 [备份与恢复](backup.md)。

## 5. 设置变量

在 `edgeweir` 服务的 **Variables → Raw Editor** 写入：

```ini
PORT=3000
DATABASE_URL=${{Postgres.DATABASE_URL}}
EDGEWEIR_PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
EDGEWEIR_NODE_API_URL=https://${{RAILWAY_TCP_PROXY_DOMAIN}}:${{RAILWAY_TCP_PROXY_PORT}}
EDGEWEIR_MASTER_KEY=<edgeweir-master-key 的内容>
```

命令行（每次设置触发一次部署）：

```bash
railway variable set --service edgeweir PORT=3000 \
  'DATABASE_URL=${{Postgres.DATABASE_URL}}' \
  'EDGEWEIR_PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}' \
  'EDGEWEIR_NODE_API_URL=https://${{RAILWAY_TCP_PROXY_DOMAIN}}:${{RAILWAY_TCP_PROXY_PORT}}'
railway variable set --service edgeweir EDGEWEIR_MASTER_KEY --stdin < edgeweir-master-key
```

在变量菜单中对 `EDGEWEIR_MASTER_KEY` 执行 **Seal**：封存后其值不再出现在 Railway 界面、API 与 CLI 中。各变量见 [变量](#变量)。

## 6. 部署设置

在 `edgeweir` 服务中设置：

| 设置 | 位置 | 值 |
| --- | --- | --- |
| Healthcheck Path | **Settings → Deploy** | `/healthz` |
| Serverless | **Settings → Deploy** | 关闭 |
| Region | **Settings** | 与 `Postgres` 服务相同 |
| Restart Policy | **Settings** | `Always`；免费计划不提供，保持默认 `On Failure` |

Railway 界面中的变更先进入暂存区；点击画布横幅上的 **Deploy** 应用。

## 7. 初始化

未初始化的控制台每次启动都在日志中输出同一个 setup token：

```bash
railway logs --service edgeweir --lines 500 --json | grep setupToken
```

Railway 日志页面按 `"first-run setup"` 过滤，展开该行查看 `setupToken`。打开该行 `url` 字段的地址（`<EDGEWEIR_PUBLIC_URL>/setup`），在初始化向导中填入 setup token，见 [快速上手](../guide/first-site.md#1-完成初始化向导)。

## 变量

| 变量 | 值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | Railway 向容器注入 `PORT` 并用它做健康检查；设置为 3000，与域名的目标端口一致。 |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | 私有网络连接串；`Postgres` 为 PostgreSQL 服务名。 |
| `EDGEWEIR_MASTER_KEY` | `openssl rand -base64 32` 的输出 | 必填。 |
| `EDGEWEIR_PUBLIC_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` | 协议为 `https`：Railway 只接受 TLS 入站。使用自定义域名时写字面值。 |
| `EDGEWEIR_NODE_API_URL` | `https://${{RAILWAY_TCP_PROXY_DOMAIN}}:${{RAILWAY_TCP_PROXY_PORT}}` | 必填：默认值 `https://<公开域名>:8443` 在 Railway 上不可达。主机名自动写入节点通道证书。 |
| `EDGEWEIR_NODE_API_HOSTNAMES` | 空 | 节点通道证书的额外名称，逗号分隔。 |
| `EDGEWEIR_TRUSTED_PROXIES` | 空 | 见 [限制](#限制)。 |
| `EDGEWEIR_VERSION` | 不设置 | 镜像内置的运行版本；版本由镜像 tag 决定。 |
| `BETTER_AUTH_SECRET` | 不设置 | 从已设置它的部署迁移时保留原值。 |

`ROLE`、`HOST`、`NODE_API_PORT` 使用镜像默认值 `all`、`0.0.0.0`、`8443`。全部变量见 [环境变量](../reference/environment.md)。

## 验证

| 检查 | 命令或位置 | 预期 |
| --- | --- | --- |
| Web 与 API | `curl -fsS https://<名称>.up.railway.app/healthz` | `{"status":"ok","version":"20260929-a1b2c3d"}` |
| 节点通道 TLS | 下方 `openssl` 命令 | 签发者为 `Edgeweir Node Channel CA`，SAN 含 TCP 代理域名 |
| 节点通道地址 | **后台 → 系统设置** 的「节点通道」 | `https://<名称>.proxy.rlwy.net:<端口>` |
| 节点注册 | **后台 → 集群与节点** → **添加节点** → **生成安装命令** | `--server` 为 TCP 代理地址；在节点上执行见 [接入节点](nodes.md) |

```bash
openssl s_client -connect <名称>.proxy.rlwy.net:<端口> -servername <名称>.proxy.rlwy.net </dev/null 2>/dev/null \
  | openssl x509 -noout -text | grep -E 'Issuer:|Subject:|DNS:'
```

预期：

```text
        Issuer: CN=Edgeweir Node Channel CA, O=Edgeweir
        Subject: CN=edgeweir-node-api, O=Edgeweir
                DNS:localhost, IP Address:127.0.0.1, IP Address:0:0:0:0:0:0:0:1, DNS:<容器主机名>, DNS:<名称>.proxy.rlwy.net
```

出现其他签发者表示 TLS 被中间设备终结。

## 自定义域名

在注册节点之前完成。

| 入口 | 操作 | 变量 |
| --- | --- | --- |
| Web 控制台 | **Settings → Networking → + Custom Domain**，端口 `3000`，添加界面给出的 `CNAME` 与 `TXT` 记录；或 `railway domain console.example.com --service edgeweir --port 3000` | `EDGEWEIR_PUBLIC_URL=https://console.example.com` |
| 节点通道 | DNS 中将 `nodes.example.com` 以 `CNAME` 指向 `<名称>.proxy.rlwy.net`（不含端口）；端口仍为 Railway 分配的端口 | `EDGEWEIR_NODE_API_URL=https://nodes.example.com:<端口>` |

`TXT` 记录缺失时自定义域名返回 404。已注册节点更换节点通道地址见 [节点通道地址与证书](networking.md#节点通道地址与证书)。

## 升级

1. 备份数据库，见 [备份与恢复](backup.md)。
2. 在 `edgeweir` 服务的 **Settings → Source** 将镜像改为新 tag，点击 **Deploy**。
3. 验证：

   ```bash
   curl -fsS https://<名称>.up.railway.app/healthz
   ```

   预期：`version` 为新 tag。

迁移、签名校验与回滚见 [版本、升级与回滚](upgrade.md)。

## 限制

| 项目 | 行为 | 影响 |
| --- | --- | --- |
| 客户端 IP | Railway HTTP 代理以 `X-Real-IP` 传递客户端地址；代理连接容器的来源地址范围未公布 | `EDGEWEIR_TRUSTED_PROXIES` 留空；审计日志 IP 与登录限速按 Railway 代理地址计算，见 [可信代理与客户端 IP](networking.md#可信代理与客户端-ip) |
| TCP 代理地址 | 域名与端口由 Railway 分配；自定义域名只替换主机名 | 已注册节点按注册时记录的地址连接；TCP 代理地址变化后这些节点无法连接 |
| Serverless | 服务无出站流量 5–10 分钟后休眠 | 必须关闭：休眠停止 worker 定时任务与节点通道 |
| 健康检查 | 只在部署时请求 `/healthz`，运行期间不检查 | 进程退出由 Restart Policy 处理 |
| 部署切换 | 新部署通过健康检查后停止旧部署 | 新旧版本短暂同时运行；旧部署上的节点通道连接随之断开 |
| Restart Policy | 默认 `On Failure`，最多重启 10 次 | PostgreSQL 60 秒内不可达时控制台退出，计入重启次数 |
| `/downloads/*` | 容器无下载镜像目录，`EDGEWEIR_DOWNLOADS_DIR` 未设置 | 返回 404；`install.sh` 从 GitHub 下载，见 [接入节点](nodes.md#下载镜像) |
