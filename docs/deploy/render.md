# Render

在 Render 上用控制台镜像与 Render Postgres 18 部署控制台：Deploy to Render 一键创建、Dashboard 手动创建与 Render CLI 等效操作。

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/marvinli001/edgeweir)

## 要求

| 项目 | 要求 |
| --- | --- |
| Render | 可使用付费计划的账户。Free 计划的 Web 服务无流量 15 分钟后休眠，Free Postgres 创建 30 天后过期，都不能使用 |
| 控制台镜像 | `ghcr.io/marvinli001/edgeweir:<YYYYMMDD>-<commit>`，公开拉取；Render 运行 linux/amd64，镜像包含该架构。tag 规则见 [版本、升级与回滚](upgrade.md) |
| PostgreSQL | Render Postgres，PostgreSQL 18 |
| 节点 | edgeweir-node 0.2.0 及以上：Render 不转发 TCP，节点经 [WebSocket 入口](networking.md#节点通道的-websocket-入口) 连接节点通道 |
| 主密钥 | Blueprint 生成，或 `openssl rand -base64 32` 生成；保存在 Render 之外，与数据库备份分开 |
| 本机命令 | `curl`；手动创建时另需 `openssl`；[Render CLI](#render-cli) 可选 |

## 拓扑

| Render 资源 | 目标 | 承载 |
| --- | --- | --- |
| Web 服务 `edgeweir`，来源为控制台镜像，计划 `0.5c-512mb`，1 个实例 | — | `ROLE=all`（镜像默认）：Web UI、API、节点通道、pg-boss worker |
| `<名称>.onrender.com` 或自定义域名，HTTPS 由 Render 终结 | 容器端口 3000（`PORT=3000`） | 浏览器、`/api/v1`、`/install.sh`、`/healthz`；节点通道的 WebSocket 入口 `/node-channel` |
| Render Postgres `edgeweir-db`，PostgreSQL 18，计划 `0.1c-256mb`，只开放私有网络 | 内部连接串，`DATABASE_URL` | 数据库 |

Render 的每个 Web 服务只转发一个 HTTP 端口，并在负载均衡上终结 TLS。节点通道的 8443 不对外：节点用 `wss://<名称>.onrender.com` 注册，节点通道的 TLS 在 WebSocket 内运行，由控制台终结并要求 mTLS，见 [节点通道的 WebSocket 入口](networking.md#节点通道的-websocket-入口)。

## 一键创建

仓库根目录的 [`render.yaml`](https://github.com/marvinli001/edgeweir/blob/master/render.yaml) 是 Blueprint：

| 资源 | 设置 |
| --- | --- |
| Web 服务 `edgeweir` | `runtime: image`，`ghcr.io/marvinli001/edgeweir:stable`；`plan: 0.5c-512mb`；`healthCheckPath: /healthz` |
| 变量 | `PORT=3000`；`EDGEWEIR_MASTER_KEY` 由 Render 生成（base64 编码的 256 位随机值）；`DATABASE_URL` 取 `edgeweir-db` 的内部连接串；`EDGEWEIR_PUBLIC_URL` 取本服务的 `RENDER_EXTERNAL_URL`；`EDGEWEIR_NODE_API_WEBSOCKET=true` |
| 数据库 `edgeweir-db` | PostgreSQL 18，库与用户 `edgeweir`，`plan: 0.1c-256mb`，`ipAllowList: []`（只开放私有网络） |

两个资源都在 Render 默认区域 `oregon`，创建后不能更改区域；需要其他区域时用 [手动创建](#手动创建)。

1. 点击本页顶部的 **Deploy to Render**（地址 `https://render.com/deploy?repo=https://github.com/marvinli001/edgeweir`），登录 Render。
2. 填写 Blueprint 名称，确认将创建 `edgeweir` 与 `edgeweir-db`，点击 **Deploy Blueprint**。
3. 关闭自动同步：Blueprint 页 **Settings**，**Auto Sync** 设为 **No**。否则本仓库的 `render.yaml` 每次修改都会同步到这个部署，并覆盖在 Dashboard 中改过的同名设置（镜像、变量）。
4. 保存主密钥：`edgeweir` 服务 **Environment**，复制 `EDGEWEIR_MASTER_KEY` 的值，离线保存，与数据库备份分开，见 [备份与恢复](backup.md)。
5. [固定版本](#固定版本)，再 [初始化](#初始化)。

## 手动创建

与 [一键创建](#一键创建) 等效，可选择区域。

1. 生成主密钥：

   ```bash
   umask 077
   openssl rand -base64 32 > edgeweir-master-key
   ```

2. 数据库：Dashboard **+ New → Postgres**。名称 `edgeweir-db`，**PostgreSQL Version** 18，选择区域与计划，点击 **Create Database**。
   - 数据库页右上角 **Connect** 菜单复制内部连接串（Internal）。
   - 新数据库默认允许任意来源地址（`0.0.0.0/0`）凭密码连接：数据库 **Info** 页 **Networking** 部分删除该条目，只保留私有网络，与一键创建的 `ipAllowList: []` 相同。
3. 控制台：**+ New → Web Service**，**Source Code** 选 **Existing Image**，**Image URL** 填 `ghcr.io/marvinli001/edgeweir:20260929-a1b2c3d`（替换为目标 tag），点击 **Connect**。
4. **Name** 填 `edgeweir`，**Region** 与数据库相同，计划选 `0.5c-512mb` 或更高。
5. **Advanced**：
   - 环境变量见下方；
   - **Health Check Path** 填 `/healthz`。

   ```ini
   PORT=3000
   DATABASE_URL=<内部连接串>
   EDGEWEIR_MASTER_KEY=<edgeweir-master-key 的内容>
   EDGEWEIR_PUBLIC_URL=https://edgeweir.onrender.com
   EDGEWEIR_NODE_API_WEBSOCKET=true
   ```

   `EDGEWEIR_PUBLIC_URL` 先按服务名填写；名称已被占用时 Render 分配的子域名不同，创建后在服务页查看实际地址，在 **Environment** 中改正并选 **Save and deploy**。
6. 点击 **Create Web Service**。

## 固定版本

一键创建的镜像为 `stable`。确认首次部署成功后固定为当时的 tag：

1. 读取运行版本：

   ```bash
   curl -fsS https://<名称>.onrender.com/healthz
   ```

   `version` 字段为 tag，如 `20260929-a1b2c3d`。
2. `edgeweir` 服务 **Settings** 页 **Deploy** 部分，镜像地址改为 `ghcr.io/marvinli001/edgeweir:<该 tag>` 并保存。

## 初始化

未初始化的控制台每次启动都在日志中输出同一个 setup token。

1. `edgeweir` 服务 **Logs**，搜索 `first-run setup`。
2. 该行 `setupToken` 字段为 setup token，`url` 字段为初始化向导地址（`<EDGEWEIR_PUBLIC_URL>/setup`）。
3. 打开向导，填入 setup token，见 [快速上手](../guide/first-site.md#1-完成初始化向导)。

## 变量

| 变量 | 值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | Render 的默认端口为 10000；设为 3000，与镜像的健康检查一致。 |
| `DATABASE_URL` | `edgeweir-db` 的内部连接串 | 必填。私有网络连接，同一区域。 |
| `EDGEWEIR_MASTER_KEY` | Blueprint 生成，或 `openssl rand -base64 32` 的输出 | 必填。 |
| `EDGEWEIR_PUBLIC_URL` | `https://<名称>.onrender.com` | 必填。Blueprint 取 `RENDER_EXTERNAL_URL`（不含自定义域名）；使用自定义域名时写字面值。 |
| `EDGEWEIR_NODE_API_WEBSOCKET` | `true` | 节点通道地址默认为 `wss://<EDGEWEIR_PUBLIC_URL 的主机>`，WebSocket 入口始终开放。 |
| `EDGEWEIR_NODE_API_URL` | 不设置 | 设置后取代上一行的默认地址，须为 `wss://` 地址。 |
| `EDGEWEIR_TRUSTED_PROXIES` | 空 | 见 [限制](#限制)。 |
| `EDGEWEIR_VERSION` | 不设置 | 镜像内置的运行版本；版本由镜像 tag 决定。 |
| `BETTER_AUTH_SECRET` | 不设置 | 从已设置它的部署迁移时保留原值。 |

`ROLE`、`HOST`、`NODE_API_PORT` 使用镜像默认值 `all`、`0.0.0.0`、`8443`；8443 只在容器内由 WebSocket 入口连接。全部变量见 [环境变量](../reference/environment.md)。

## 验证

| 检查 | 位置或命令 | 预期 |
| --- | --- | --- |
| 部署 | `edgeweir` 服务 **Deploys** | 当前部署已完成（live） |
| Web 与 API | `curl -fsS https://<名称>.onrender.com/healthz` | `{"status":"ok","version":"20260929-a1b2c3d"}` |
| WebSocket 入口 | `curl -s -o /dev/null -w '%{http_code}\n' https://<名称>.onrender.com/node-channel` | `426` |
| 节点通道地址 | **系统设置** 的「节点通道」 | `wss://<名称>.onrender.com`，连接检查「连接正常」 |
| 节点注册 | **集群与节点** → **添加节点** | `--server wss://<名称>.onrender.com`；在节点上执行见 [接入节点](nodes.md) |

## 自定义域名

在注册节点之前完成；已注册的节点按注册时的地址连接，见 [节点通道地址与证书](networking.md#节点通道地址与证书)。

1. `edgeweir` 服务 **Settings → Custom Domains → + Add Custom Domain**，填 `console.example.com`；在 DNS 中按界面添加 `CNAME`，点击 **Verify**。
2. **Environment** 中修改，选 **Save and deploy**：

   ```ini
   EDGEWEIR_PUBLIC_URL=https://console.example.com
   ```

   节点通道默认地址随之变为 `wss://console.example.com`。Blueprint 的 **Auto Sync** 须为 **No**，否则下次同步把 `EDGEWEIR_PUBLIC_URL` 改回 `RENDER_EXTERNAL_URL`。
3. 验证：以新域名执行 [验证](#验证) 中的命令。

已有经 `wss://<名称>.onrender.com` 注册的节点时，在 **系统设置** 的「节点通道」保存 `wss://console.example.com`，不改环境变量：旧名称留在节点通道证书中，`onrender.com` 子域名保持开启（**Render Subdomain** 不设为 **Disabled**）。

## 升级

1. 备份数据库：数据库页 **Recovery → Create export**，下载导出文件；付费计划另有时间点恢复（Point-in-Time Recovery）。见 [备份与恢复](backup.md)。
2. `edgeweir` 服务 **Settings** 页 **Deploy** 部分，镜像地址改为新 tag 并保存；**Deploys** 页 **Manual Deploy → Deploy latest reference**。
3. 验证：

   ```bash
   curl -fsS https://<名称>.onrender.com/healthz
   ```

   预期：`version` 为新 tag。

迁移、签名校验与回滚见 [版本、升级与回滚](upgrade.md)。

## Render CLI

| 操作 | 命令 |
| --- | --- |
| 校验 Blueprint | `render blueprints validate render.yaml` |
| 读取 setup token | `render logs --resources <服务 ID> --output json \| grep setupToken` |
| 升级 | `render services update <服务 ID> --image ghcr.io/marvinli001/edgeweir:<新 tag>`，再 `render deploys create <服务 ID> --wait` |

## 限制

| 项目 | 行为 | 影响 |
| --- | --- | --- |
| 节点通道 | Web 服务只转发一个 HTTP 端口，不转发 TCP | 节点只能经 WebSocket 入口连接，需要 edgeweir-node 0.2.0 及以上 |
| WebSocket 连接 | Render 不限制时长；实例被替换（部署、重启、平台维护）时关闭 | 节点自动重连；断开期间按最后可用配置继续服务 |
| 部署切换 | 新实例通过健康检查后接收流量；60 秒后旧实例收到 SIGTERM，关闭延迟（默认 30 秒）后强制结束 | 新旧版本短暂同时运行；旧实例上的节点连接断开后重连到新实例 |
| 客户端 IP | 请求经 Cloudflare 与 Render 负载均衡到达容器；负载均衡连接容器的来源地址范围未公布 | `EDGEWEIR_TRUSTED_PROXIES` 留空；审计日志 IP、登录限速与节点的「连接来源地址」按负载均衡地址计算，见 [可信代理与客户端 IP](networking.md#可信代理与客户端-ip) |
| Blueprint 同步 | **Auto Sync** 为 **Yes** 时，`render.yaml` 的修改会同步到资源并覆盖冲突的 Dashboard 设置；删除 Blueprint 管理的资源后下次同步会重建 | 创建后把 **Auto Sync** 设为 **No** |
| 区域 | 创建后不能修改；Web 服务与数据库须在同一区域才能用私有网络 | 一键创建固定为 `oregon` |
| 数据库访问 | `ipAllowList: []` 只允许私有网络 | 本机 `pg_dump` 需先在数据库页添加允许的来源地址；或用 **Recovery** 页的导出 |
| 日志 | 按工作区计划保留（Hobby 7 天） | setup token 每次启动都会重新输出 |
| `/downloads/*` | 容器无下载镜像目录，`EDGEWEIR_DOWNLOADS_DIR` 未设置 | 返回 404；`install.sh` 从 GitHub 下载，见 [接入节点](nodes.md#下载镜像) |
