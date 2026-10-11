# Zeabur

在 Zeabur Server 上用控制台镜像与 PostgreSQL 18 部署控制台：模板一键创建、Dashboard 手动创建与 Zeabur CLI 等效操作。

[![Deploy on Zeabur](https://zeabur.com/button.svg)](https://zeabur.com/templates/5MQJR2)

## 要求

| 项目 | 要求 |
| --- | --- |
| Zeabur | Dev 计划及以上：Free 计划的服务空闲后自动休眠，会停止 worker 与节点通道 |
| Zeabur Server | 向 Zeabur 购买（**Servers → Create → Buy a Server from Zeabur**），或接入自有服务器（至少 1 CPU、2 GB 内存，放行 22、80、443、4222、6443、30000–32767）。Zeabur 的共享集群已不接受新服务 |
| 控制台镜像 | `ghcr.io/marvinli001/edgeweir:<YYYYMMDD>-<commit>`，公开拉取；linux/amd64、linux/arm64。tag 规则见 [版本、升级与回滚](upgrade.md) |
| PostgreSQL | PostgreSQL 18，与控制台在同一项目 |
| 主密钥 | `openssl rand -base64 32` 生成；保存在 Zeabur 之外，与数据库备份分开 |
| 节点 | edgeweir-node 0.2.0 及以上：节点默认经 [WebSocket 入口](networking.md#节点通道的-websocket-入口) 连接节点通道 |
| 本机命令 | `openssl`、`curl`；模板部署另需 Node.js（`npx zeabur@latest`） |

## 拓扑

| Zeabur 资源 | 目标 | 承载 |
| --- | --- | --- |
| 服务 `edgeweir`（Docker Image） | — | `ROLE=all`（镜像默认）：Web UI、API、节点通道、pg-boss worker |
| HTTP 端口 `web`：`<前缀>.zeabur.app` 或自定义域名，Zeabur 签发证书并终结 TLS | 容器端口 3000 | 浏览器、`/api/v1`、`/install.sh`、`/healthz`；节点通道的 WebSocket 入口 `/node-channel`（默认的节点通道地址） |
| TCP 端口 `node`：端口转发 `<主机>:<端口>`，端口由 Zeabur 分配（NodePort 30000–32767） | 容器端口 8443 | 节点通道直连（可选，见 [节点通道直连](#节点通道直连)）；按 TCP 转发 |
| 服务 `postgresql`，卷挂载 `/var/lib/postgresql`，不转发端口 | 私有网络 `postgresql.zeabur.internal:5432` | PostgreSQL 18 |

节点默认用 `wss://<前缀>.zeabur.app` 注册：节点通道的 TLS 在 WebSocket 内运行，由控制台终结并要求 mTLS，见 [节点通道的 WebSocket 入口](networking.md#节点通道的-websocket-入口)。端口与节点通道证书的通用规则见 [端口、反向代理与可信代理](networking.md)。

## 模板一键创建

仓库根目录的 [`zeabur.yaml`](https://github.com/marvinli001/edgeweir/blob/master/zeabur.yaml) 是 Zeabur 模板，已发布为 [`5MQJR2`](https://zeabur.com/templates/5MQJR2)：

| 服务 | 设置 |
| --- | --- |
| `postgresql` | `postgres:18.6-alpine`（按 digest 固定）；卷 `data` 挂载 `/var/lib/postgresql`；库与用户 `edgeweir`，密码为 Zeabur 生成的 `${PASSWORD}`；`portForwarding.enabled: false`；TCP 健康检查 |
| `edgeweir` | `ghcr.io/marvinli001/edgeweir:stable`；端口 `web` 3000/HTTP、`node` 8443/TCP；HTTP 健康检查 `/healthz`；`PORT=3000`、`DATABASE_URL=${POSTGRES_CONNECTION_STRING}`、`EDGEWEIR_PUBLIC_URL=https://${ZEABUR_WEB_DOMAIN}`、`EDGEWEIR_NODE_API_WEBSOCKET=true`；部署说明列出 setup token 的位置与直连地址 `https://<主机>:<端口>` |
| 模板变量 | `PUBLIC_DOMAIN`：`zeabur.app` 域名前缀，绑定到 `web` 端口；`EDGEWEIR_MASTER_KEY`：主密钥 |

1. 生成主密钥：

   ```bash
   umask 077
   openssl rand -base64 32 > edgeweir-master-key
   ```

2. 点击本页顶部的 **Deploy on Zeabur**，在模板页点击 **Deploy**；按提示选择项目或在 Server 上新建项目，填写域名前缀（得到 `<前缀>.zeabur.app`）与主密钥（`edgeweir-master-key` 的内容）。

   命令行等效（首次执行 `npx zeabur@latest auth login`）；`-f zeabur.yaml` 部署本地的模板文件：

   ```bash
   npx zeabur@latest template deploy -c 5MQJR2
   ```
3. [固定版本](#固定版本)，再 [初始化](#初始化)。

模板变量会写入项目中的全部服务，`EDGEWEIR_MASTER_KEY` 也出现在 `postgresql` 服务的变量中；PostgreSQL 不读取它。

## 手动创建

与 [模板一键创建](#模板一键创建) 等效。

1. 生成主密钥（同上）。
2. **Create Project**，选择已有 **Server**、**Buy New Server** 或 **Bind External Server**，点击 **Create Project**。
3. 数据库：**Deploy New Service → Databases → PostgreSQL**。Zeabur 的 PostgreSQL 模板为 `postgres:18`，默认开启端口转发（5432 可从公网连接）；关闭：

   ```bash
   npx zeabur@latest context set project
   npx zeabur@latest context set service --name postgresql
   npx zeabur@latest service port-forward --disable
   ```

4. 控制台：**Deploy New Service → Docker Image**，镜像 `ghcr.io/marvinli001/edgeweir:20260929-a1b2c3d`（替换为目标 tag）。
   - **Ports**：`web`，3000，`HTTP`；`node`，8443，`TCP`。
   - **Environment Variable**：

     ```ini
     PORT=3000
     DATABASE_URL=${POSTGRES_CONNECTION_STRING}
     EDGEWEIR_MASTER_KEY=<edgeweir-master-key 的内容>
     EDGEWEIR_PUBLIC_URL=https://${ZEABUR_WEB_DOMAIN}
     EDGEWEIR_NODE_API_WEBSOCKET=true
     ```

   点击 **Deploy**。
5. `edgeweir` 服务 **Domains → Generate Domain**，得到 `<前缀>.zeabur.app`。
6. `edgeweir` 服务 **Settings → Health Check**，路径填 `/healthz`。

## 固定版本

模板部署的镜像为 `stable`。确认首次部署成功后固定为当时的 tag：

1. 读取运行版本：

   ```bash
   curl -fsS https://<前缀>.zeabur.app/healthz
   ```

   `version` 字段为 tag，如 `20260929-a1b2c3d`。
2. `edgeweir` 服务 **Settings → Service Image**，第二个输入框（tag）改为该 tag，点击 **Save**；服务以新镜像重启。CLI：

   ```bash
   npx zeabur@latest context set service --name edgeweir
   npx zeabur@latest service update tag -t <该 tag>
   ```

## 初始化

未初始化的控制台每次启动都在日志中输出同一个 setup token。

1. `edgeweir` 服务 **Logs**，过滤 `first-run setup`。服务重启或重新部署后看不到之前实例的日志，搜索最新实例即可。
2. 该行 `setupToken` 字段为 setup token，`url` 字段为初始化向导地址（`<EDGEWEIR_PUBLIC_URL>/setup`）。
3. 打开向导，填入 setup token，见 [快速上手](../guide/first-site.md#1-完成初始化向导)。

CLI：`npx zeabur@latest deployment log -t=runtime --service-name edgeweir | grep setupToken`。

## 变量

| 变量 | 值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | Zeabur 向服务注入 `PORT`；设为 3000，与 `web` 端口一致。 |
| `DATABASE_URL` | `${POSTGRES_CONNECTION_STRING}` | 必填。`postgresql` 服务公开（Expose）的私有网络连接串。 |
| `EDGEWEIR_MASTER_KEY` | `openssl rand -base64 32` 的输出 | 必填。 |
| `EDGEWEIR_PUBLIC_URL` | `https://${ZEABUR_WEB_DOMAIN}` | 必填。`web` 端口绑定的域名；使用自定义域名时写字面值。 |
| `EDGEWEIR_NODE_API_WEBSOCKET` | `true` | 节点通道地址默认为 `wss://<EDGEWEIR_PUBLIC_URL 的主机>`，WebSocket 入口始终开放。 |
| `EDGEWEIR_NODE_API_URL` | 不设置 | 不要设为 `https://${PORT_FORWARDED_HOSTNAME}:${NODE_PORT_FORWARDED_PORT}`：这两个变量在服务变量中展开后不是有效地址，控制台拒绝启动。直连地址在 **系统设置** 中保存，见 [节点通道直连](#节点通道直连)。 |
| `EDGEWEIR_NODE_API_HOSTNAMES` | 空 | 节点通道证书的额外名称，逗号分隔。 |
| `EDGEWEIR_TRUSTED_PROXIES` | 空 | 见 [限制](#限制)。 |
| `EDGEWEIR_VERSION` | 不设置 | 镜像内置的运行版本；版本由镜像 tag 决定。 |
| `BETTER_AUTH_SECRET` | 不设置 | 从已设置它的部署迁移时保留原值。 |

`${KEY}` 在服务启动时展开：先取本服务的变量，再取其他服务公开的变量，最后取 Zeabur 的特殊变量。`ROLE`、`HOST`、`NODE_API_PORT` 使用镜像默认值 `all`、`0.0.0.0`、`8443`。全部变量见 [环境变量](../reference/environment.md)。

## 验证

| 检查 | 位置或命令 | 预期 |
| --- | --- | --- |
| 服务 | `edgeweir`、`postgresql` 服务 **Overview** | 均为运行状态 |
| Web 与 API | `curl -fsS https://<前缀>.zeabur.app/healthz` | `{"status":"ok","version":"20260929-a1b2c3d"}` |
| WebSocket 入口 | `curl -s -o /dev/null -w '%{http_code}\n' https://<前缀>.zeabur.app/node-channel` | `426` |
| 节点通道地址 | **系统设置** 的「节点通道」 | `wss://<前缀>.zeabur.app`，连接检查「连接正常」 |
| 节点注册 | **集群与节点** → **添加节点** | `--server wss://<前缀>.zeabur.app`；在节点上执行见 [接入节点](nodes.md) |
| 端口转发 | `edgeweir` 服务 **Networking**；`npx zeabur@latest service network` | `node` 端口有 `<主机>:<端口>`；`postgresql` 没有 |

## 自定义域名

在注册节点之前完成。

1. `edgeweir` 服务 **Domains → Custom Domain**，填 `console.example.com`，点击 **Create Domain**，按界面在 DNS 中添加记录。
2. 修改变量（服务重启）：

   ```ini
   EDGEWEIR_PUBLIC_URL=https://console.example.com
   ```

   节点通道默认地址随之变为 `wss://console.example.com`。
3. 验证：以新域名执行 [验证](#验证) 中的 `curl` 命令。

已有经 `wss://<前缀>.zeabur.app` 注册的节点时，在 **系统设置** 的「节点通道」保存 `wss://console.example.com`，不改 `EDGEWEIR_NODE_API_WEBSOCKET`：旧名称留在节点通道证书中，`<前缀>.zeabur.app` 域名保持绑定。

已注册节点更换节点通道地址见 [节点通道地址与证书](networking.md#节点通道地址与证书)。

## 升级

1. 备份数据库，见 [备份与恢复](backup.md)：
   - `postgresql` 服务 **Overview → Command** 执行 `pg_dump -U edgeweir -d edgeweir -Fc -f /var/lib/postgresql/edgeweir.dump`，在 **Overview → Files** 下载该文件后执行 `rm /var/lib/postgresql/edgeweir.dump`；
   - 或使用该服务的 **Backup** 页（Dev 计划及以上，备份保留 7 天）。
2. `edgeweir` 服务 **Settings → Service Image**，tag 改为新版本，点击 **Save**；或 `npx zeabur@latest service update tag -t <新 tag>`。
3. 验证：

   ```bash
   curl -fsS https://<前缀>.zeabur.app/healthz
   ```

   预期：`version` 为新 tag。

迁移、签名校验与回滚见 [版本、升级与回滚](upgrade.md)。

## 节点通道直连

节点可以不经 Zeabur 的 HTTP 入口，直接连接 `node` 端口的 TCP 端口转发地址。在注册节点之前完成。

1. 读取端口转发地址：`edgeweir` 服务 **Networking** 中 `node` 端口的 `<主机>:<端口>`，或模板部署说明中的「Direct node channel URL」；CLI：`npx zeabur@latest service network`。
2. 可选：在 DNS 中添加 `nodes.example.com`，`A` 记录指向该主机地址（Zeabur Server 的公网 IP）；DNS 在 Cloudflare 时关闭代理（仅 DNS）。端口转发的主机或端口变化时只需修改这条记录或节点通道地址。
3. **系统设置** 的「节点通道」保存 `https://<主机>:<端口>`（或 `https://nodes.example.com:<端口>`），连接检查应为「连接正常」；立即生效，不重启服务。
4. 验证 TLS 由控制台终结：

   ```bash
   openssl s_client -connect <主机>:<端口> </dev/null 2>/dev/null \
     | openssl x509 -noout -text | grep -E 'Issuer:|Subject:|DNS:'
   ```

   预期：签发者为 `CN=Edgeweir Node Channel CA, O=Edgeweir`。出现其他签发者表示 TLS 被中间设备终结。使用域名时加 `-servername nodes.example.com`。

已注册的节点继续连接注册时的地址，见 [节点通道地址与证书](networking.md#节点通道地址与证书)。

### 从旧模板部署迁移

2026-10-10 之前的模板把 `EDGEWEIR_NODE_API_URL` 设为 `https://${PORT_FORWARDED_HOSTNAME}:${NODE_PORT_FORWARDED_PORT}`，控制台启动时报 `EDGEWEIR_NODE_API_URL: expected https://, wss:// or ws://host[:port] without a path` 并不断重启。`edgeweir` 服务 **Variables** 中删除 `EDGEWEIR_NODE_API_URL`，添加 `EDGEWEIR_NODE_API_WEBSOCKET=true`，服务重启后恢复。

## 限制

| 项目 | 行为 | 影响 |
| --- | --- | --- |
| 节点通道 | 默认经 HTTP 入口的 WebSocket 入口连接 | 需要 edgeweir-node 0.2.0 及以上；入口的连接时长与空闲限制未公布，连接被关闭时节点自动重连，断开期间按最后可用配置继续服务 |
| 端口转发地址 | 主机与端口由 Zeabur 分配，通常不变，Zeabur 不保证永久不变 | 直连时已注册节点一直连接注册时的地址：节点通道地址用指向 Server IP 的域名 |
| 客户端 IP | HTTP 入口以 `X-Forwarded-For` 传递客户端地址；入口连接容器的来源地址范围未公布 | `EDGEWEIR_TRUSTED_PROXIES` 留空；审计日志 IP、登录限速与经 WebSocket 连接的节点的「连接来源地址」按入口地址计算，见 [可信代理与客户端 IP](networking.md#可信代理与客户端-ip) |
| 直连节点的连接来源地址 | 端口转发是否保留节点的地址未公布，不支持 PROXY 协议 | 节点详情的「连接来源地址」可能不是节点的公网地址 |
| 部署切换 | 无卷的服务先启动新实例，健康检查通过后结束旧实例；有卷的服务（`postgresql`）先停后启 | 控制台新旧版本短暂同时运行；修改 `postgresql` 服务（镜像、变量）时数据库短暂停止，期间控制台的请求与后台任务失败，数据库恢复后继续 |
| 日志 | 服务重启或重新部署后看不到之前实例的日志 | setup token 每次启动都会重新输出 |
| 模板变量 | 写入项目中的全部服务 | 主密钥也出现在 `postgresql` 服务的变量中 |
| `/downloads/*` | 容器无下载镜像目录，`EDGEWEIR_DOWNLOADS_DIR` 未设置 | 返回 404；`install.sh` 从 GitHub 下载，见 [接入节点](nodes.md#下载镜像) |
