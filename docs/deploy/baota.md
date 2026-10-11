# 宝塔面板 / aaPanel

在宝塔面板或 aaPanel 上用 Docker Compose 部署控制台：编排模式、面板配置与手动部署。

## 编排模式

`deploy.sh install` 按所选数据库模式写入对应的编排文件。

| 项目 | host | bundled |
| --- | --- | --- |
| 数据库 | 本机 PostgreSQL（宝塔 **数据库 → PgSQL**）或云数据库 | 编排内置 `postgres:18.6-alpine`，数据在 Docker 卷 `edgeweir_postgres-data` |
| 编排文件 | [`compose.baota-host.yml`](../../compose.baota-host.yml) | [`compose.baota.yml`](../../compose.baota.yml) |
| 容器网络 | `network_mode: host`；容器内 `127.0.0.1` 即宿主机，只监听回环地址的本机 PostgreSQL 无需修改 `listen_addresses` 与 `pg_hba.conf` | Docker 网桥；数据库不对外 |
| Web 控制台 | 进程监听 `127.0.0.1:3000`（`EDGEWEIR_HTTP_PORT`） | 端口映射 `127.0.0.1:3000`（`EDGEWEIR_HTTP_PORT`）→ `3000` |
| 节点通道 | 进程监听 `0.0.0.0:8443`（`EDGEWEIR_NODE_API_HOST`、`EDGEWEIR_NODE_API_PORT`） | 端口映射 `8443`（`EDGEWEIR_NODE_API_PORT`）→ `8443` |
| 端口变量格式 | 只能是数字 | `EDGEWEIR_HTTP_PORT` 只能是数字；`EDGEWEIR_NODE_API_PORT` 可带绑定地址，例如 `127.0.0.1:18443` |
| `EDGEWEIR_TRUSTED_PROXIES` | 默认 `127.0.0.1,::1` | Docker 网关地址，由 `deploy.sh` 写入并在启动时同步 |
| 面板容器列表的端口列 | 空（host 网络没有端口映射） | 显示映射 |

镜像 `ghcr.io/marvinli001/edgeweir` 公开，面板中无需添加镜像仓库或登录。tag 格式与版本固定见 [upgrade.md](upgrade.md)。

## 1. 准备

| 项目 | 要求 | 宝塔面板 | aaPanel |
| --- | --- | --- | --- |
| Docker | Docker Engine 与 Compose v2（`docker compose`） | **Docker** 页面安装 | **Docker** 页面安装 |
| 防火墙 | 放行节点通道端口（默认 8443/TCP）；Web 端口 3000 不对外放行。bundled 模式由 Docker 发布端口，不经过系统防火墙，需要按来源限制时用云安全组 | **安全 → 系统防火墙 → 添加端口规则**：协议 TCP，来源所有 IP，策略允许 | **Security → Firewall → Add Port Rule**：Protocol TCP，Source IP All，Strategy Allow |
| 云安全组 | 放行同一端口 | — | — |
| 域名 | 控制台域名（例如 `cdn-admin.example.com`）解析到本机 | — | — |
| 数据库（host） | PostgreSQL 18；空数据库及其所有者用户；云数据库白名单包含本机 IP | **数据库 → PgSQL → 添加数据库** | **Databases → PgSQL → Add DB** |
| 镜像 | 能访问 `ghcr.io`；否则预先 `docker load` 导入，见 [deploy-script.md](deploy-script.md#无人值守安装) 的 `EDGEWEIR_NO_PULL` | — | — |
| 终端 | root | **终端** 或 SSH | **Terminal** 或 SSH |

其余运行要求见 [部署概览](README.md#运行要求)。

## 2. 用 deploy.sh 安装

1. 下载脚本：

   ```bash
   curl -fsSL -o deploy.sh https://raw.githubusercontent.com/marvinli001/edgeweir/master/deploy.sh
   ```

2. 运行安装，依次回答安装目录、数据库模式、数据库连接、控制台地址、节点通道地址。提示与默认值见 [deploy-script.md](deploy-script.md#install)。

   ```bash
   sudo bash deploy.sh install
   ```

   存在 `/www/server/panel` 时默认安装目录为 `/www/dk_project/edgeweir`，否则为 `/opt/edgeweir`。控制台地址填浏览器访问的地址，例如 `https://cdn-admin.example.com`；节点通道地址默认 `https://<控制台域名>:8443`。

3. 记录输出末尾的 setup token。

> [!IMPORTANT]
> 安装目录中的 `.env` 含 `EDGEWEIR_MASTER_KEY`。离线备份；丢失后已加密的数据无法恢复。见 [backup.md](backup.md)。

无人值守安装（以 root 运行；变量表见 [deploy-script.md](deploy-script.md#无人值守安装)）：

```bash
EDGEWEIR_YES=1 EDGEWEIR_DB=host \
EDGEWEIR_PUBLIC_URL=https://cdn-admin.example.com \
DATABASE_URL='postgres://edgeweir:<URL 编码的密码>@127.0.0.1:5432/edgeweir' \
bash deploy.sh install
```

`EDGEWEIR_DB=bundled` 时不设置 `DATABASE_URL`。

## 3. 反向代理与 HTTPS

面板 nginx 终结 HTTPS，并反向代理到 `http://127.0.0.1:3000`（`EDGEWEIR_HTTP_PORT` 改过时替换端口）。

| 步骤 | 宝塔面板 | aaPanel |
| --- | --- | --- |
| 1. 站点 | **网站 → PHP项目 → 添加站点**：域名填控制台域名，PHP 版本选「纯静态」 | **Website → Proxy Project** 添加站点：域名填控制台域名，代理目标填 `http://127.0.0.1:3000` |
| 2. 证书 | 站点设置 **SSL → Let's Encrypt → 申请证书**，开启强制 HTTPS | 站点设置 **SSL → Let's Encrypt** 申请证书 |
| 3. 反向代理 | 站点设置 **反向代理 → 添加反向代理**：目标 URL 填 `http://127.0.0.1:3000` | 第 1 步已设置 |

- 证书文件验证失败时改用 DNS 验证。
- 发送域名（`Host`）保持默认值：控制台只按 `EDGEWEIR_PUBLIC_URL` 校验请求来源。
- 安装时填写的控制台地址不是 `https://` 时，证书生效后运行 `./deploy.sh config` 改为 `https://`。

通用 nginx 配置与请求头见 [networking.md](networking.md#反向代理-web-控制台)。

## 4. 初始化与验证

1. 读取 setup token（安装输出中已打印）：

   ```bash
   cd /www/dk_project/edgeweir   # 安装目录
   ./deploy.sh setup-token
   ```

2. 打开 `https://cdn-admin.example.com/setup`，填入 setup token 与姓名、邮箱、密码，创建控制台账户。初始化向导见 [快速上手](../guide/first-site.md)。

3. 验证 Web 控制台：

   ```bash
   curl -s http://127.0.0.1:3000/healthz
   ```

   预期：`{"status":"ok","version":"<.env 中的 EDGEWEIR_VERSION>"}`。

4. 验证节点通道（在另一台主机执行）：

   ```bash
   openssl s_client -connect cdn-admin.example.com:8443 -servername cdn-admin.example.com </dev/null 2>/dev/null \
     | openssl x509 -noout -issuer
   ```

   预期：签发者含 `Edgeweir Node Channel CA`。

节点发布源与源站地址允许清单在 **系统设置** 配置，见 [集群与系统](../guide/system.md#系统设置)；GeoIP 数据库在 **防护设置**，见 [防护设置](../guide/system.md#防护设置)；SMTP 在 **告警** 页配置，见 [SMTP](../guide/dns-and-alerts.md#smtp)。添加节点见 [接入节点](nodes.md)；安装命令中的 `--server` 即 **系统设置** 的「节点通道」（没有保存地址时为 `EDGEWEIR_NODE_API_URL`），修改见 [节点通道地址与证书](networking.md#节点通道地址与证书)。

## 节点通道端口

| 方式 | 配置 | 约束 |
| --- | --- | --- |
| 直接暴露（默认） | 防火墙与安全组放行 `EDGEWEIR_NODE_API_PORT` | — |
| nginx `stream` 四层透传 | 控制台监听本机 `18443`，面板 nginx 在 `8443` 透传 TCP | 面板 nginx 需包含 stream 模块 |
| 面板 HTTP 反向代理、CDN | 不支持 | 终结 TLS 使节点注册报 `CA pin mismatch`，mTLS 无法建立 |

`stream` 块、原理与验证见 [networking.md](networking.md#节点通道四层透传)。宝塔 / aaPanel 上的步骤：

1. 确认面板 nginx 包含 stream 模块：

   ```bash
   /www/server/nginx/sbin/nginx -V 2>&1 | grep -o -- '--with-stream[^ ]*'
   ```

   预期：其中一行恰为 `--with-stream`。没有该行时使用直接暴露。

2. 将节点通道改到本机 `18443`，`EDGEWEIR_NODE_API_URL` 保持 `:8443`：

   | 模式 | 修改 |
   | --- | --- |
   | bundled | `.env`：`EDGEWEIR_NODE_API_PORT=127.0.0.1:18443` |
   | host | `.env`：`EDGEWEIR_NODE_API_PORT=18443`、`EDGEWEIR_NODE_API_HOST=127.0.0.1` |

   ```bash
   ./deploy.sh start
   ```

3. 面板的 `/www/server/nginx/conf/nginx.conf` 已有 `stream { }` 块，并包含 `/www/server/panel/vhost/nginx/tcp/*.conf`；不要再加一个 `stream` 块，`nginx -t` 会报 `"stream" directive is duplicate`。新建 `/www/server/panel/vhost/nginx/tcp/edgeweir.conf`：

   ```nginx title="/www/server/panel/vhost/nginx/tcp/edgeweir.conf"
   server {
     listen 8443;
     proxy_pass 127.0.0.1:18443;
     proxy_timeout 1h;
   }
   ```

   节点通道域名有 AAAA 记录时再加 `listen [::]:8443;`。检查并重载：

   ```bash
   /www/server/nginx/sbin/nginx -t && /www/server/nginx/sbin/nginx -s reload
   ```

4. 按第 4 节第 4 步验证。

| 场景 | 约束 |
| --- | --- |
| `./deploy.sh config` | 保留第 2 步的 `EDGEWEIR_NODE_API_PORT`；节点通道地址的端口改变时，自行调整 nginx 的 `listen`。 |
| `./deploy.sh update` | 替换 `compose.yml` 不影响 `.env` 中第 2 步的设置。 |
| 在面板中重启或更新该编排 | 面板以 `docker compose -f <编排文件>` 执行：读取 `.env`，第 2 步的设置不受影响；不读取 `compose.override.yml`，其中的改动只在用 `./deploy.sh` 启停与升级时生效。 |
| host 模式的 `compose.yml` 不含 `EDGEWEIR_NODE_API_HOST`（较早的模板） | `.env` 中的 `EDGEWEIR_NODE_API_HOST` 不生效，`./deploy.sh start` 时警告；按 `./deploy.sh template host` 修改其中 `NODE_API_HOST` 一行。 |

## 不用脚本部署

### 容器编排

1. 取得模板：`bash deploy.sh template bundled`（或 `host`）的输出，或仓库中的 [`compose.baota.yml`](../../compose.baota.yml)、[`compose.baota-host.yml`](../../compose.baota-host.yml)。

2. 在面板终端生成 `.env` 内容（bundled）：

   ```bash
   cat <<ENV
   EDGEWEIR_MASTER_KEY=$(openssl rand -base64 32)
   POSTGRES_PASSWORD=$(openssl rand -hex 24)
   EDGEWEIR_PUBLIC_URL=https://cdn-admin.example.com
   EDGEWEIR_NODE_API_URL=https://cdn-admin.example.com:8443
   EDGEWEIR_VERSION=20260929-a1b2c3d
   ENV
   ```

   host 模式把 `POSTGRES_PASSWORD` 一行换成 `DATABASE_URL=postgres://edgeweir:<URL 编码的密码>@127.0.0.1:5432/edgeweir`（云数据库追加 `?sslmode=verify-full`）。

3. 添加编排：宝塔 **Docker → 容器编排 → 添加容器编排**；aaPanel **Docker → Compose → Add Compose**。名称填 `edgeweir`，编排内容粘贴模板，`.env` 栏（aaPanel **.env Content**）粘贴上一步的输出，创建编排。

4. 确认容器：`edgeweir-console` 为 healthy；bundled 另有 `edgeweir-postgres`。

5. bundled 模式设置可信代理：把 `deploy.sh` 放入编排目录后运行 `./deploy.sh restart`，脚本把 Docker 网关地址写入 `EDGEWEIR_TRUSTED_PROXIES` 并重建容器。手动设置时写入以下命令输出的地址；环境变量在重建容器后生效。

   ```bash
   docker inspect -f '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}' edgeweir-postgres
   ```

6. 读取 setup token，按 [第 4 节](#4-初始化与验证) 继续：

   ```bash
   docker logs edgeweir-console 2>&1 | grep -o '"setupToken":"[^"]*"' | tail -n 1
   ```

| 变量 | 约束 |
| --- | --- |
| `.env` 栏 | 面板不执行其中的命令；填入终端生成的实际值。 |
| `EDGEWEIR_VERSION` | [GitHub Packages](https://github.com/marvinli001/edgeweir/pkgs/container/edgeweir) 上的日期 tag；`stable` 由 `deploy.sh` 解析为日期 tag，`latest` 仅用于评估环境。 |
| `BETTER_AUTH_SECRET` | 新部署不设置。已设置的部署保留原值；移除后控制台拒绝启动。 |
| 其他变量 | 见 [环境变量](../reference/environment.md)。 |

### 不用编排：单独创建容器

面板 **创建容器** 表单无法设置编排中的只读根文件系统、`tmpfs` 与 `no-new-privileges`。需要这些加固时在终端执行 [docker.md](docker.md#不用-compose单独的容器) 中的 `docker run` 命令。

1. 创建网络 `edgeweir`：宝塔 **Docker → 网络**；aaPanel **Docker → Network → Add Network**；或终端：

   ```bash
   docker network create edgeweir
   ```

2. 创建两个容器：宝塔 **Docker → 容器 → 创建容器**；aaPanel **Docker → Container → Create Container**。

   | 字段 | `edgeweir-postgres` | `edgeweir-console` |
   | --- | --- | --- |
   | 镜像 | `postgres:18.6-alpine` | `ghcr.io/marvinli001/edgeweir:<日期 tag>` |
   | 网络 | `edgeweir` | `edgeweir` |
   | 端口 | 不映射 | `127.0.0.1:3000` → `3000`；`8443` → `8443` |
   | 卷 | `edgeweir-postgres` → `/var/lib/postgresql` | — |
   | 环境变量 | `POSTGRES_USER=edgeweir`、`POSTGRES_DB=edgeweir`、`POSTGRES_PASSWORD=<openssl rand -hex 24 的输出>` | `ROLE=all`、`DATABASE_URL=postgres://edgeweir:<同一密码>@edgeweir-postgres:5432/edgeweir`、`EDGEWEIR_MASTER_KEY`、`EDGEWEIR_PUBLIC_URL`、`EDGEWEIR_NODE_API_URL`、`EDGEWEIR_TRUSTED_PROXIES=<edgeweir 网络的网关>` |
   | 重启策略 | `unless-stopped` 或 `always` | `unless-stopped` 或 `always` |

   - 控制台容器不设置 `EDGEWEIR_VERSION`：镜像内该变量表示运行中的版本。
   - 已设置 `BETTER_AUTH_SECRET` 的部署保留原值。
   - 网关地址：

     ```bash
     docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' edgeweir
     ```

   - 表单无法把端口绑定到 `127.0.0.1` 时改用终端 `docker run`。

3. 升级：拉取新 tag，删除 `edgeweir-console`，以相同参数和新 tag 重建。数据在 `edgeweir-postgres` 卷中。升级前备份，见 [backup.md](backup.md)。

## 升级与备份

在部署目录运行：

```bash
cd /www/dk_project/edgeweir
./deploy.sh update                     # 备份后升级到 stable 对应的日期 tag
./deploy.sh update 20260929-a1b2c3d    # 升级或回退到指定 tag
./deploy.sh backup                     # 备份到 backups/<时间>/
./deploy.sh restore backups/<时间>      # 先备份，再用该备份替换数据库
```

轮换主密钥：`.env` 中把原值移到 `EDGEWEIR_MASTER_KEY_PREVIOUS`、写入新的 `EDGEWEIR_MASTER_KEY`，运行 `./deploy.sh restart`；`./deploy.sh logs console` 出现 `no envelope uses EDGEWEIR_MASTER_KEY_PREVIOUS any more` 后删除该行，再 `./deploy.sh restart`。说明见[轮换主密钥](docker.md#轮换主密钥)。

命令、备份布局与中止行为见 [deploy-script.md](deploy-script.md)；版本策略与回退约束见 [upgrade.md](upgrade.md)；恢复见 [backup.md](backup.md)。

| 场景 | 行为 |
| --- | --- |
| 面板创建的编排 | 把 `deploy.sh` 放入编排目录后可用全部命令；脚本按 `.env` 与含 `container_name: edgeweir-console` 的编排文件识别部署，沿用面板的 Compose 项目名。 |
| 面板中修改 `EDGEWEIR_VERSION` 后更新镜像（aaPanel **Update Image**） | 不备份数据库。 |

## 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 安装时数据库检查失败 | 地址、密码、`pg_hba.conf`、白名单或 TLS 证书 | 按脚本输出的提示处理，对照 [数据库检查](deploy-script.md#数据库检查)。 |
| 提示用户不能建表或建 schema | 用户不是数据库所有者 | 宝塔新建数据库时选择该用户，或执行 `ALTER DATABASE edgeweir OWNER TO edgeweir;` 与 `ALTER SCHEMA public OWNER TO edgeweir;`。 |
| `无法访问 Docker` | 非 root 运行或 Docker 未启动 | 用 `sudo` 运行；在面板 **Docker** 页面启动 Docker。 |
| 拉取镜像失败 | 无法访问 `ghcr.io` | `docker load` 导入镜像后设置 `EDGEWEIR_NO_PULL=1`。 |
| 登录失败或登录后立即退出 | `EDGEWEIR_PUBLIC_URL` 与浏览器地址的协议、域名或端口不一致 | `./deploy.sh config`。 |
| 节点注册报 `CA pin mismatch` | 节点通道端口上的 TLS 被面板 nginx 或 CDN 终结 | 直接暴露或 `stream` 透传；按第 4 节第 4 步验证。 |
| 节点注册超时 | 防火墙或安全组未放行节点通道端口，或节点通道域名解析错误 | 放行端口；检查节点通道地址的域名解析。 |
| host 模式警告节点通道只监听回环地址 | 镜像不支持 `NODE_API_HOST` | `./deploy.sh update`。 |
| host 模式警告 `compose.override.yml` 设置了 `NODE_API_HOST` | 面板重启或更新编排时不读取覆盖文件，该设置丢失 | 改在 `.env` 中设置 `EDGEWEIR_NODE_API_HOST`（[节点通道端口](#节点通道端口) 第 2 步），从覆盖文件删除 `NODE_API_HOST`，`./deploy.sh start`。 |
| 审计日志中的 IP 均为 Docker 网关（`172.x.x.1`） | bundled 模式 `EDGEWEIR_TRUSTED_PROXIES` 与当前网关不一致 | `./deploy.sh restart`。 |
| `./deploy.sh start` 报「启动失败」 | `.env` 缺少变量或数据库不可达 | `./deploy.sh logs console`；修正 `.env` 后 `./deploy.sh start`。 |
