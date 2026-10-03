# Railway

在 Railway 上用控制台镜像与 Railway PostgreSQL 18 部署控制台：网页控制台步骤与命令行等效操作。

## 要求

| 项目 | 要求 |
| --- | --- |
| Railway | 可创建项目的账户；[命令行部署](#命令行部署) 另需 `railway` CLI，已执行 `railway login` |
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

## 1. 创建项目

在 Railway Dashboard 点击 **New Project** → **Empty project**。

## 2. 添加 PostgreSQL

1. 项目画布右上角 **Create** → **Database** → **Add PostgreSQL**。
2. `Postgres` 服务 **Settings → Source**：镜像为 `ghcr.io/railwayapp-templates/postgres-ssl:18`。
3. 主版本低于 18 时：**Database → Config → Major Version Upgrade** → **Upgrade to PostgreSQL 18**。

## 3. 添加控制台服务

1. 项目画布 **Create** → **Docker Image**，**Image name** 填 `ghcr.io/marvinli001/edgeweir:20260929-a1b2c3d`（替换为目标 tag），回车。
2. 右键服务卡片 → **Update Info**，名称改为 `edgeweir`。

服务进入暂存区，在 [第 7 步](#7-部署设置) 部署。

## 4. 公开 3000 与 8443

`edgeweir` 服务 **Settings → Networking**，按顺序操作：

| 顺序 | 操作 | 结果 |
| --- | --- | --- |
| 1 | **Public Networking → Generate Domain**，端口 `3000` | `<名称>.up.railway.app` |
| 2 | **TCP Proxy**，端口 `8443` | `<名称>.proxy.rlwy.net:<端口>`，端口由 Railway 分配 |

网络设置立即生效，不进入暂存区。服务已有 TCP 代理时不显示 **Generate Domain**：先删除 TCP 代理，生成域名后重新添加。每个服务只能有一个 TCP 代理；删除后重新创建得到新的域名与端口，在注册节点之前完成。

## 5. 生成主密钥

在本机执行：

```bash
umask 077
openssl rand -base64 32 > edgeweir-master-key
```

输出原样使用。`edgeweir-master-key` 离线保存，与数据库备份分开，见 [备份与恢复](backup.md)。

## 6. 设置变量

1. `edgeweir` 服务 **Variables → Raw Editor**，写入后保存：

   ```ini
   PORT=3000
   DATABASE_URL=${{Postgres.DATABASE_URL}}
   EDGEWEIR_PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
   EDGEWEIR_NODE_API_URL=https://${{RAILWAY_TCP_PROXY_DOMAIN}}:${{RAILWAY_TCP_PROXY_PORT}}
   EDGEWEIR_MASTER_KEY=<edgeweir-master-key 的内容>
   ```

2. `EDGEWEIR_MASTER_KEY` 行的 **⋮** 菜单 → **Seal**。

封存后其值不再出现在 Railway 界面、API 与 CLI 中，不可解封；Raw Editor 不再编辑该变量，修改经 **⋮** 菜单；复制环境或服务、PR 环境不带封存的变量。各变量见 [变量](#变量)。

## 7. 部署设置

1. `edgeweir` 服务中设置：

   | 设置 | 位置 | 值 |
   | --- | --- | --- |
   | Healthcheck Path | **Settings → Deploy** | `/healthz` |
   | Serverless | **Settings → Deploy → Enable Serverless** | 关闭 |
   | Restart Policy | **Settings → Deploy** | `Always`；Free 计划与试用不提供，保持默认 `On Failure` |
   | Draining Time | **Settings → Deploy**，或变量 `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `10`：旧部署收到 SIGTERM 后的退出时间，控制台最多需要 8 秒 |
   | Regions | **Settings → Scale** | 与 `Postgres` 服务相同 |

2. 画布顶部暂存横幅点击 **Deploy**，应用第 3、6、7 步的全部变更。

## 8. 初始化

未初始化的控制台每次启动都在日志中输出同一个 setup token。

1. `edgeweir` 服务 **Deployments** → 当前部署 → **Deploy Logs**，过滤框输入 `"first-run setup"`。
2. 该行 `setupToken` 字段为 setup token，`url` 字段为初始化向导地址（`<EDGEWEIR_PUBLIC_URL>/setup`）。
3. 打开向导，填入 setup token，见 [快速上手](../guide/first-site.md#1-完成初始化向导)。

## 命令行部署

与第 1–8 步等效。**Seal** 只能在网页控制台完成。

1. 创建项目、PostgreSQL 与控制台服务：

   ```bash
   railway init --name edgeweir
   railway add --database postgres
   railway add --service edgeweir --image ghcr.io/marvinli001/edgeweir:20260929-a1b2c3d
   ```

2. 公开 3000 与 8443：

   ```bash
   railway domain --service edgeweir --port 3000
   railway tcp-proxy create --service edgeweir --port 8443
   ```

3. 生成主密钥并设置变量；`--skip-deploys` 的命令不触发部署，最后一条触发部署：

   ```bash
   umask 077
   openssl rand -base64 32 > edgeweir-master-key
   railway variable set --service edgeweir --skip-deploys EDGEWEIR_MASTER_KEY --stdin < edgeweir-master-key
   railway variable set --service edgeweir PORT=3000 \
     'DATABASE_URL=${{Postgres.DATABASE_URL}}' \
     'EDGEWEIR_PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}' \
     'EDGEWEIR_NODE_API_URL=https://${{RAILWAY_TCP_PROXY_DOMAIN}}:${{RAILWAY_TCP_PROXY_PORT}}' \
     RAILWAY_DEPLOYMENT_DRAINING_SECONDS=10
   ```

4. [第 7 步](#7-部署设置) 的部署设置：

   ```bash
   railway environment edit \
     --service-config edgeweir deploy.healthcheckPath /healthz \
     --service-config edgeweir deploy.sleepApplication false \
     --service-config edgeweir deploy.restartPolicyType ALWAYS
   ```

   Free 计划与试用去掉 `restartPolicyType` 一行。区域用 `railway scale` 设置。在网页控制台完成 [第 6 步](#6-设置变量) 的 **Seal**。
5. 读取 setup token：

   ```bash
   railway logs --service edgeweir --lines 500 --json | grep setupToken
   ```

## 变量

| 变量 | 值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | Railway 向容器注入 `PORT` 并用它做健康检查；设置为 3000，与域名的目标端口一致。 |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | 私有网络连接串；`Postgres` 为 PostgreSQL 服务名。 |
| `EDGEWEIR_MASTER_KEY` | `openssl rand -base64 32` 的输出 | 必填。 |
| `EDGEWEIR_PUBLIC_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` | 必填。协议为 `https`：Railway 只接受 TLS 入站。使用自定义域名时写字面值。 |
| `EDGEWEIR_NODE_API_URL` | `https://${{RAILWAY_TCP_PROXY_DOMAIN}}:${{RAILWAY_TCP_PROXY_PORT}}` | **系统设置** 的「节点通道」没有保存地址时必填：默认值 `https://<公开域名>:8443` 在 Railway 上不可达。主机名自动写入节点通道证书。 |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `10` | 旧部署收到 SIGTERM 后的退出时间，见 [第 7 步](#7-部署设置)。 |
| `EDGEWEIR_NODE_API_HOSTNAMES` | 空 | 节点通道证书的额外名称，逗号分隔。 |
| `EDGEWEIR_TRUSTED_PROXIES` | 空 | 见 [限制](#限制)。 |
| `EDGEWEIR_VERSION` | 不设置 | 镜像内置的运行版本；版本由镜像 tag 决定。 |
| `BETTER_AUTH_SECRET` | 不设置 | 从已设置它的部署迁移时保留原值。 |

`ROLE`、`HOST`、`NODE_API_PORT` 使用镜像默认值 `all`、`0.0.0.0`、`8443`。全部变量见 [环境变量](../reference/environment.md)。

## 验证

| 检查 | 命令或位置 | 预期 |
| --- | --- | --- |
| 部署 | `edgeweir` 服务 **Deployments** | 当前部署状态 `Active` |
| Web 与 API | `curl -fsS https://<名称>.up.railway.app/healthz` | `{"status":"ok","version":"20260929-a1b2c3d"}` |
| 节点通道 TLS | 下方 `openssl` 命令 | 签发者为 `Edgeweir Node Channel CA`，SAN 含 TCP 代理域名 |
| 节点通道地址 | **系统设置** 的「节点通道」 | `https://<名称>.proxy.rlwy.net:<端口>` |
| 节点注册 | **集群与节点** → **添加节点**（对话框打开即显示安装命令） | `--server` 为 TCP 代理地址；在节点上执行见 [接入节点](nodes.md) |

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

1. Web 控制台：`edgeweir` 服务 **Settings → Networking → + Custom Domain**，填 `console.example.com`，端口 `3000`；在 DNS 中添加界面给出的 `CNAME` 与 `TXT` 记录。`TXT` 记录缺失时该域名返回 404。
2. 节点通道：在 DNS 中将 `nodes.example.com` 以 `CNAME` 指向 `<名称>.proxy.rlwy.net`（不含端口）；端口仍为 Railway 分配的端口。DNS 在 Cloudflare 时关闭代理（仅 DNS）。
3. **Variables** 中修改：

   ```ini
   EDGEWEIR_PUBLIC_URL=https://console.example.com
   EDGEWEIR_NODE_API_URL=https://nodes.example.com:<端口>
   ```

4. 暂存横幅点击 **Deploy**。
5. 验证：以新域名执行 [验证](#验证) 中的 `curl` 与 `openssl` 命令。

命令行：

```bash
railway domain console.example.com --service edgeweir --port 3000
railway variable set --service edgeweir \
  EDGEWEIR_PUBLIC_URL=https://console.example.com \
  EDGEWEIR_NODE_API_URL=https://nodes.example.com:<端口>
```

已注册节点更换节点通道地址见 [节点通道地址与证书](networking.md#节点通道地址与证书)。

## 升级

1. 备份数据库，见 [备份与恢复](backup.md)。
2. `edgeweir` 服务 **Settings → Source**，镜像改为新 tag。
3. 暂存横幅点击 **Deploy**。
4. 验证：

   ```bash
   curl -fsS https://<名称>.up.railway.app/healthz
   ```

   预期：`version` 为新 tag。

命令行（第 2–3 步）：

```bash
railway service source connect --service edgeweir --image ghcr.io/marvinli001/edgeweir:<新 tag>
railway redeploy --service edgeweir --from-source --yes
```

迁移、签名校验与回滚见 [版本、升级与回滚](upgrade.md)。

## 限制

| 项目 | 行为 | 影响 |
| --- | --- | --- |
| 客户端 IP | Railway HTTP 代理以 `X-Real-IP` 传递客户端地址；代理连接容器的来源地址范围未公布 | `EDGEWEIR_TRUSTED_PROXIES` 留空；审计日志 IP 与登录限速按 Railway 代理地址计算，见 [可信代理与客户端 IP](networking.md#可信代理与客户端-ip) |
| TCP 代理地址 | 域名与端口由 Railway 分配，删除后重新创建会改变；自定义域名只替换主机名 | 已注册节点按注册时记录的地址连接；TCP 代理地址变化后这些节点无法连接。新地址在 **系统设置** 的「节点通道」填写，不需要重新部署 |
| 节点的连接来源地址 | TCP 代理不传递节点的地址，也不支持 PROXY 协议 | 节点详情的「连接来源地址」不是节点的公网地址；节点通道无法按来源地址限制访问 |
| Serverless | 服务无出站流量 5–10 分钟后休眠 | 必须关闭：休眠停止 worker 定时任务与节点通道 |
| 健康检查 | 只在部署时请求 `/healthz`，运行期间不检查 | 进程退出由 Restart Policy 处理 |
| 部署切换 | 新部署通过健康检查后停止旧部署：先发送 SIGTERM，draining 时间后强制结束 | 新旧版本短暂同时运行；旧部署上的节点通道连接随之断开。draining 时间设为 10 秒，控制台才能正常关闭连接 |
| Restart Policy | 默认 `On Failure`；Free 计划与试用最多重启 10 次，付费计划不限 | PostgreSQL 60 秒内不可达时控制台退出，计入重启次数 |
| `/downloads/*` | 容器无下载镜像目录，`EDGEWEIR_DOWNLOADS_DIR` 未设置 | 返回 404；`install.sh` 从 GitHub 下载，见 [接入节点](nodes.md#下载镜像) |
