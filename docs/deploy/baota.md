# 在宝塔面板 / aaPanel 中部署 Edgeweir 控制台

适用于已安装宝塔面板（BT Panel）9.x 或 aaPanel（宝塔国际版）并启用 Docker 功能的服务器，两者的 Docker 菜单相同，下文写作「宝塔 / aaPanel」。推荐用仓库根目录的安装脚本 [`deploy.sh`](../../deploy.sh)：它对话式生成 `.env`、启动 Docker Compose 编排，之后的升级、备份、重启也都用它。脚本同样适用于没有面板、装了 Docker 的 Linux。Web 控制台交给面板 nginx 反向代理（在面板上配置 HTTPS）；**节点通道 8443 不经过面板 nginx 的 HTTP 反代**。

镜像是公开的 `ghcr.io/marvinli001/edgeweir`，不需要在面板里添加镜像仓库或登录。版本是滚动发布的 `日期-提交` tag（例如 `20260929-a1b2c3d`），`latest` 指向最新一个，没有 `v1.2.3` 式的版本号；脚本安装时把 `latest` 当前对应的日期 tag 固定进 `.env`，详见 [docker.md](docker.md#版本与镜像)。脚本在等价的 Linux Docker 主机上验证过两种编排；面板的点击流程按官方文档整理，尚未在真实面板服务器上逐项验收。

## 1. 两种编排

安装时先选数据库放在哪里，脚本据此选用编排文件：

| | 本机或云 PostgreSQL（host 网络） | 编排内置 PostgreSQL |
| --- | --- | --- |
| 编排文件 | [`compose.baota-host.yml`](../../compose.baota-host.yml) | [`compose.baota.yml`](../../compose.baota.yml) |
| 数据库 | 宝塔「数据库 → PgSQL」装在本机的 PostgreSQL，或云数据库 | 编排里的 `postgres:18.6`，数据在 Docker 卷 `edgeweir_postgres-data` |
| 容器网络 | `network_mode: host`，容器里的 `127.0.0.1` 就是宿主机 | Docker 网桥，数据库不对外 |
| Web 控制台 | 进程自己只监听 `127.0.0.1:3000` | 端口映射 `127.0.0.1:3000 → 3000` |
| 节点通道 | 进程监听 `0.0.0.0:8443` | 端口映射 `8443 → 8443` |
| 可信代理 | 宝塔 nginx 从 `127.0.0.1` 转发，默认信任回环地址 | 宝塔 nginx 经 Docker 网关转发，脚本把网关写进 `EDGEWEIR_TRUSTED_PROXIES` |

host 网络的好处：宝塔装的 PostgreSQL 默认只监听 `127.0.0.1`，网桥里的容器连不到它，要改 `listen_addresses`、`pg_hba.conf` 和防火墙；host 网络下容器直接用 `127.0.0.1:5432`，不需要这些改动。代价是容器不再有自己的网络命名空间，端口直接占用宿主机端口（面板「容器」列表里也不显示端口映射，这是正常的）。

## 2. 为什么 8443 不能交给宝塔反代

节点和控制台之间是双向 TLS（mTLS）：节点注册时校验控制台内部 CA 的指纹，注册后每个请求都带客户端证书。这要求 TLS 由控制台自己终结。如果宝塔 nginx 在 8443 上终结 TLS，节点看到的是宝塔的证书（指纹对不上，注册失败），控制台也拿不到节点的客户端证书。所以 8443 只能：

- **直接暴露**（默认，最简单）；或
- 用 nginx **stream 四层透传**（不解密，只转发 TCP），见[第 7 节](#7-可选用-stream-透传-8443)。

## 3. 准备

1. 宝塔「Docker」页面安装 Docker（需要 Compose v2，即 `docker compose`）。
2. 在宝塔「安全」和云厂商安全组中放行 **8443/TCP**。3000 不需要对外放行（只给宝塔 nginx 本机访问）。
3. 准备一个控制台域名，例如 `cdn-admin.example.com`，解析到这台服务器。
4. 用本机或云 PostgreSQL 时，先建好空数据库和它的**所有者**用户：宝塔「数据库 → PgSQL → 添加数据库」，库名和用户名例如 `edgeweir`，密码随机。控制台在 PostgreSQL 18 上测试，更低版本脚本会提示。云数据库要把这台服务器的 IP 加进白名单。

## 4. 用 deploy.sh 安装

在服务器终端（宝塔「终端」或 SSH）以 root 执行：

```bash
curl -fsSL -o deploy.sh https://raw.githubusercontent.com/marvinli001/edgeweir/master/deploy.sh
sudo bash deploy.sh install
```

脚本依次询问：

1. **安装目录**：检测到宝塔时默认 `/www/dk_project/edgeweir`，否则 `/opt/edgeweir`。
2. **数据库方式**：`1` 本机或云 PostgreSQL（host 网络），`2` 编排内置 PostgreSQL。
3. 选 `1` 时的**数据库连接**：逐项填写地址（默认 `127.0.0.1`）、端口、库名、用户、密码（输入不回显），非本机地址会询问是否使用 TLS 并校验证书（`sslmode=verify-full`，云数据库推荐）；也可以直接粘贴 `postgres://` 连接串。脚本用一个临时的 PostgreSQL 客户端容器实际连接一次，检查版本以及该用户能否建表、建 schema，失败时给出原因并允许重填。
4. **控制台地址**（`EDGEWEIR_PUBLIC_URL`）：浏览器打开的地址，例如 `https://cdn-admin.example.com`。
5. **节点通道地址**（`EDGEWEIR_NODE_API_URL`）：默认同一域名加 `:8443`；地址里的端口就是对外开放的节点通道端口。端口被占用时脚本会提示换一个。

确认后脚本：

- 拉取 `latest`，把它对应的日期 tag 写进 `EDGEWEIR_VERSION`；
- 生成主密钥（`openssl rand -base64 32`）和内置数据库的密码（`openssl rand -hex 24`），写入 `.env`（权限 600）；
- 写入所选的编排文件 `compose.yml`，并把自己复制为 `<安装目录>/deploy.sh`；
- 启动编排并等待健康检查通过，最后打印一次性初始化令牌和后续步骤。

安装目录里的 `.env` 含主密钥：`EDGEWEIR_MASTER_KEY` 用于加密入库的私钥和 DNS 密钥，并派生登录会话 secret，**请离线备份**，丢失后已加密的数据无法恢复。

无人值守安装用环境变量回答全部问题：

```bash
EDGEWEIR_YES=1 EDGEWEIR_DB=host \
EDGEWEIR_PUBLIC_URL=https://cdn-admin.example.com \
DATABASE_URL='postgres://edgeweir:<URL 编码的密码>@127.0.0.1:5432/edgeweir' \
bash deploy.sh install
```

可选 `EDGEWEIR_DIR`、`EDGEWEIR_NODE_API_URL`、`EDGEWEIR_VERSION`（固定某个 tag）、`EDGEWEIR_HTTP_PORT`；`EDGEWEIR_DB=bundled` 时不需要 `DATABASE_URL`。服务器访问 GHCR 困难时，可以先用 `docker load` 导入镜像（控制台镜像，以及 host 模式下用于连接检查和备份的 `postgres:18.6-alpine`），再加 `EDGEWEIR_NO_PULL=1`。

## 5. 反向代理 Web 控制台

1. 宝塔「网站 → 添加站点」，域名填 `cdn-admin.example.com`，PHP 选「纯静态」。
2. 站点设置 →「反向代理 → 添加反向代理」，目标 URL 填 `http://127.0.0.1:3000`，发送域名保持 `$host`。
3. 站点设置 →「SSL」申请或上传证书，开启「强制 HTTPS」。
4. 浏览器打开 `https://cdn-admin.example.com/setup`，填入脚本打印的初始化令牌并创建管理员（令牌可以用 `./deploy.sh setup-token` 再次查看）。
5. SMTP、节点发布源、所有权校验 DNS、源站地址允许清单和 GeoIP 在控制台 **后台 → 系统设置** 填写，不需要改 `.env`。

`EDGEWEIR_PUBLIC_URL` 必须与浏览器实际访问的地址一致（含 `https://`），否则登录会因来源校验失败；改地址用 `./deploy.sh config`。

审计日志和登录限速要拿到访客的真实 IP，控制台必须信任宝塔 nginx 的 `X-Forwarded-For`：host 编排默认信任 `127.0.0.1,::1`；内置数据库编排由脚本把 Docker 网关地址写进 `EDGEWEIR_TRUSTED_PROXIES`，编排网络重建（网关变化）后，下一次 `./deploy.sh start`、`restart` 或 `update` 会自动改正。不设置时控制台不采信任何转发头。

## 6. 日常维护

在安装目录里运行（`cd /www/dk_project/edgeweir`）：

| 命令 | 作用 |
| --- | --- |
| `./deploy.sh update` | 拉取 `latest`，把它对应的日期 tag 写进 `.env`，先备份再重建容器；数据库迁移在启动时自动执行 |
| `./deploy.sh update <tag>` | 升级（或回退）到指定 tag，例如 `20260929-a1b2c3d` |
| `./deploy.sh backup` | 备份到 `backups/<时间>/`：`edgeweir.dump`（`pg_dump --format=custom`）、`env`（含主密钥）和编排文件 |
| `./deploy.sh status` / `logs [console]` | 容器状态与运行版本 / 跟随日志 |
| `./deploy.sh start` / `stop` / `restart` | 启动（等待健康检查）/ 停止 / 重启 |
| `./deploy.sh config` | 修改控制台地址和节点通道地址并重建容器 |
| `./deploy.sh setup-token` | 显示首次初始化令牌 |
| `./deploy.sh template host\|bundled` | 输出编排模板 |
| `./deploy.sh self-update` | 从 GitHub 更新脚本本身 |

- `update` 发现 `compose.yml` 与脚本自带的模板不同（模板更新过，或你改过它）时，会询问是否替换；旧文件已在这次的备份里。无人值守运行时保留现有文件。
- 回退：迁移只向前执行，只有两个版本之间没有新增迁移时才能直接 `./deploy.sh update <旧 tag>`，否则用升级前的备份恢复（[backup.md](backup.md)）。
- 备份目录含主密钥和全部数据，复制到别的机器保管；`backups/` 不会自动清理。ClickHouse（若启用）另行备份。
- 确认版本：`curl -s http://127.0.0.1:3000/healthz` 返回的 `version`。
- 不要用 Watchtower 等工具无人值守地跟随 `latest`。

## 7. （可选）用 stream 透传 8443

如果想让 8443 也经过宝塔的 nginx（例如统一端口管理），只能做四层透传：

1. 让节点通道只监听本机另一个端口：
   - 内置数据库编排：`.env` 里改 `EDGEWEIR_NODE_API_PORT=127.0.0.1:18443`；
   - host 编排：`.env` 里改 `EDGEWEIR_NODE_API_PORT=18443`，并把 `compose.yml` 中的 `NODE_API_HOST: 0.0.0.0` 改成 `NODE_API_HOST: 127.0.0.1`（以后 `update` 询问替换模板时选 n）。

   然后 `./deploy.sh start`。节点通道地址（`EDGEWEIR_NODE_API_URL`）保持 `:8443` 不变。
2. 宝塔「软件商店 → Nginx → 设置 → 配置修改」，在 `http { ... }` 块**之外**加入：

```nginx
stream {
    server {
        listen 8443;
        proxy_pass 127.0.0.1:18443;
        proxy_timeout 1h;   # 节点通道有长连接（WatchConfig 流）
    }
}
```

3. 保存并重载 Nginx。注意不要写 `ssl` 或 `proxy_ssl`，这里只转发 TCP。

## 8. 不用脚本：面板里手动编排

1. 宝塔「Docker → 容器编排 → 添加容器编排」（aaPanel「Docker → Compose → Add」），名称填 `edgeweir`，粘贴 [`compose.baota.yml`](../../compose.baota.yml)（内置数据库）或 [`compose.baota-host.yml`](../../compose.baota-host.yml)（本机或云数据库）的内容。
2. 在编排的 `.env` 栏填入变量（面板把它保存为编排目录里的 `.env`，一般是 `/www/dk_project/edgeweir/.env`）。面板没有 `.env` 栏时，在面板终端里进入编排目录生成。内置数据库：

```bash
cd /www/dk_project/edgeweir
umask 077
cat > .env <<ENV
EDGEWEIR_MASTER_KEY=$(openssl rand -base64 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
EDGEWEIR_PUBLIC_URL=https://cdn-admin.example.com
EDGEWEIR_NODE_API_URL=https://cdn-admin.example.com:8443
EDGEWEIR_VERSION=20260929-a1b2c3d
ENV
chmod 600 .env
```

   host 编排把 `POSTGRES_PASSWORD` 这一行换成 `DATABASE_URL=postgres://edgeweir:<URL 编码的密码>@127.0.0.1:5432/edgeweir`（云数据库加 `?sslmode=verify-full`），其余相同。

   - 不需要再填 `BETTER_AUTH_SECRET`。已经填过它的旧编排要保留原值，删掉后控制台拒绝启动（否则所有人会被登出，已启用的两步验证也无法读取）。
   - `EDGEWEIR_VERSION` 换成 [GitHub Packages](https://github.com/marvinli001/edgeweir/pkgs/container/edgeweir) 上当前最新的日期 tag；评估环境可以写 `latest`。
   - 在 `.env` 栏里填写时，等号右边要填在终端里生成好的实际值，面板不会执行其中的命令。
   - 内置数据库编排还要加 `EDGEWEIR_TRUSTED_PROXIES=<Docker 网关>`（`docker network inspect edgeweir_default` 显示的 Gateway），否则审计日志和登录限速看到的都是网关地址。

3. 点击「确定/启动」，面板会先拉取镜像。在「容器」列表里应看到 `edgeweir-console`（healthy），内置数据库编排还有 `edgeweir-postgres`。初始化令牌在「容器 → edgeweir-console → 日志」里的 `setupToken`。

面板创建的编排也可以交给脚本维护：把 `deploy.sh` 放进编排目录再运行 `./deploy.sh update` 等命令（脚本按容器 `edgeweir-console` 找到编排）。升级时也可以只在面板里改 `EDGEWEIR_VERSION` 再「更新镜像」，但这样不会先备份。

## 9. 不用编排：单独创建容器

面板的「容器 → 创建容器」也能部署，但表单无法设置编排里的只读根文件系统、`tmpfs` 和 `no-new-privileges` 加固，所以推荐用编排。确实要用时，按 [docker.md 的等价命令](docker.md#不用-compose单独的容器)创建：

1. 「Docker → 网络」新建网络 `edgeweir`（或在终端 `docker network create edgeweir`）。
2. PostgreSQL 容器：镜像 `postgres:18.6-alpine`，名称 `edgeweir-postgres`，网络 `edgeweir`，不映射端口；环境变量 `POSTGRES_USER=edgeweir`、`POSTGRES_DB=edgeweir`、`POSTGRES_PASSWORD=<openssl rand -hex 24 的输出>`；卷 `edgeweir-postgres` 挂到 `/var/lib/postgresql`；重启策略「总是 / unless-stopped」。
3. 控制台容器：镜像 `ghcr.io/marvinli001/edgeweir:<日期 tag>`，名称 `edgeweir-console`，网络 `edgeweir`；端口 `127.0.0.1:3000 → 3000` 和 `8443 → 8443`；环境变量 `ROLE=all`、`DATABASE_URL=postgres://edgeweir:<上面的密码>@edgeweir-postgres:5432/edgeweir`、`EDGEWEIR_MASTER_KEY`、`EDGEWEIR_PUBLIC_URL`、`EDGEWEIR_NODE_API_URL`（其余可选变量见 `compose.baota.yml`；旧部署设置过的 `BETTER_AUTH_SECRET` 要保留；不要填 `EDGEWEIR_VERSION`）。

升级单独创建的容器：拉取新 tag，删除旧的 `edgeweir-console`，用相同参数和新 tag 重建。数据在 PostgreSQL 的卷里，不受影响。

## 10. 添加节点

平台管理员在后台「集群与节点」生成一次性安装命令（先 `export EDGEWEIR_TOKEN=...`，再 `curl ... | sudo --preserve-env=EDGEWEIR_TOKEN bash -s -- ...`），在**节点服务器**（不是这台控制台服务器）上用有 sudo 权限的账号执行。token 只经环境变量传递，不出现在命令行参数里。命令里的 `--server` 就是 `EDGEWEIR_NODE_API_URL`，`--ca-sha256` 是内部 CA 指纹，节点注册前会校验。节点访问 GitHub 慢时可以配置控制台镜像，见 [docker.md](docker.md#控制台镜像可选)。

## 11. 常见问题

| 现象 | 处理 |
| --- | --- |
| 安装时数据库连接失败 | 按脚本提示检查：`refused` 是地址或端口不对、数据库没启动；`password` 是密码错误；`pg_hba` 是数据库没有放行这台服务器；云数据库超时多半是白名单或安全组。 |
| 提示用户不能建表或建 schema | 该用户不是数据库所有者。宝塔新建数据库时选择这个用户，或执行 `ALTER DATABASE edgeweir OWNER TO edgeweir;` 和 `ALTER SCHEMA public OWNER TO edgeweir;`。 |
| host 编排提示节点通道只监听回环地址 | 镜像太旧，不支持 `NODE_API_HOST`；`./deploy.sh update` 升级。 |
| 登录后立刻退出 / 提示来源不受信任 | `EDGEWEIR_PUBLIC_URL` 与实际访问地址不一致（协议、域名、端口），用 `./deploy.sh config` 修改。 |
| 节点注册报 CA 指纹不匹配 | 8443 被宝塔或 CDN 终结了 TLS；改为直连或 stream 透传。 |
| 节点注册超时 | 安全组/宝塔防火墙未放行 8443；`EDGEWEIR_NODE_API_URL` 的域名解析是否正确。 |
| 审计日志里的 IP 都是 `172.x.x.1` | 内置数据库编排的 `EDGEWEIR_TRUSTED_PROXIES` 与 Docker 网关不一致，运行 `./deploy.sh restart`。 |
| 控制台容器反复重启 | `./deploy.sh logs console` 查看原因，通常是 `.env` 缺少密钥或数据库连不上。 |
