# Docker Compose

控制台镜像的 Docker Compose 部署，以及不用 Compose 的 `docker run` 部署。

运行要求与其他平台见 [部署概览](README.md)。宝塔 / aaPanel 与 `deploy.sh` 见 [baota.md](baota.md)。

## 编排服务

`compose.yml` 的项目名为 `edgeweir`：卷名 `edgeweir_postgres-data`，网络名 `edgeweir_default`。

| 服务 | 镜像 | 启用 | 说明 |
| --- | --- | --- | --- |
| `console` | `ghcr.io/marvinli001/edgeweir:${EDGEWEIR_VERSION:-latest}` | 默认 | `ROLE=all`；发布 `${EDGEWEIR_HTTP_PORT:-127.0.0.1:3000}:3000` 与 `${EDGEWEIR_NODE_API_PORT:-8443}:8443`；只读根文件系统、`/tmp` 为 tmpfs、`no-new-privileges` |
| `postgres` | `postgres:18.6-alpine`（按 digest 固定） | 默认 | 卷 `postgres-data` 挂载到 `/var/lib/postgresql`；端口不发布；`pg_isready` 健康检查通过后 `console` 才启动 |
| `clickhouse` | `clickhouse/clickhouse-server:26.9-alpine`（按 digest 固定） | `.env` 中 `COMPOSE_PROFILES=analytics` | 卷 `clickhouse-data` |

镜像公开，拉取无需登录。tag 规则见 [版本、升级与回滚](upgrade.md)。

## 1. 准备

1. 准备 Linux 服务器（amd64 或 arm64），安装 Docker Engine 与 Docker Compose v2：

   ```bash
   docker compose version
   ```

2. 在云安全组放行 8443/TCP。Docker 发布的端口不经过 ufw、firewalld 等主机防火墙，需要按来源限制时用云安全组或 `DOCKER-USER` 链。Docker Engine 28 之前，同一二层网络的主机能访问发布到 `127.0.0.1` 的端口：使用 28 或更新的版本。3000/TCP 的暴露方式见 [端口与反向代理](networking.md)。

## 2. 获取文件

服务器只需要 `compose.yml` 与 `.env`。

```bash
mkdir -p /opt/edgeweir && cd /opt/edgeweir
curl -fsSLO https://raw.githubusercontent.com/marvinli001/edgeweir/master/compose.yml
umask 077
curl -fsSL -o .env https://raw.githubusercontent.com/marvinli001/edgeweir/master/.env.example
```

## 3. 生成密钥

```bash
sed -i "s|^EDGEWEIR_MASTER_KEY=.*|EDGEWEIR_MASTER_KEY=$(openssl rand -base64 32)|" .env
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" .env
```

| 变量 | 生成命令 | 约束 |
| --- | --- | --- |
| `EDGEWEIR_MASTER_KEY` | `openssl rand -base64 32` | 原样使用输出，保留 `/`、`+`、`=`；含其他字符或解码后不足 32 字节时控制台拒绝启动。 |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` | 拼入 `DATABASE_URL`，只用字母与数字。 |

> [!WARNING]
> 主密钥加密入库的内部 CA 私钥、证书私钥、S3 源站密钥、DNS API 凭据与 setup token，并派生会话密钥。离线备份，与数据库备份分开保存；丢失后上述数据不可恢复。

### 主密钥文件

主密钥也可以不写进 `.env`：放进文件，经 Compose secret 挂载，`.env` 中的 `EDGEWEIR_MASTER_KEY` 留空。

```bash
umask 077
openssl rand -base64 32 > master.key
chown 1000 master.key   # 镜像以 node 用户（uid 1000）运行
sed -i "s|^EDGEWEIR_MASTER_KEY=.*|EDGEWEIR_MASTER_KEY=|" .env
```

与 `compose.yml` 同目录的 `compose.override.yml`（Compose 自动合并）：

```yaml
services:
  console:
    environment:
      EDGEWEIR_MASTER_KEY_FILE: /run/secrets/edgeweir_master_key
    secrets:
      - edgeweir_master_key
secrets:
  edgeweir_master_key:
    file: ./master.key
```

文件末尾的换行被忽略；同时设置非空的 `EDGEWEIR_MASTER_KEY`，或文件为空、不可读时，控制台拒绝启动。

### 其他机密文件

以下变量同样可以从文件读取：设置 `<变量>_FILE`，按上例挂载文件，`.env` 中不设置该变量。规则与主密钥文件相同。

| 变量 | 用于 |
| --- | --- |
| `DATABASE_URL_FILE` | 外部 PostgreSQL（`compose.baota-host.yml`、[单独的容器](#不用-compose单独的容器)）：文件内容为完整连接串。`compose.yml` 的内置数据库只在编排网络内可达，`POSTGRES_PASSWORD` 留在 `.env` |
| `BETTER_AUTH_SECRET_FILE` | 已设置 `BETTER_AUTH_SECRET` 的部署 |
| `EDGEWEIR_CLICKHOUSE_PASSWORD_FILE` | 外部 ClickHouse；`compose.override.yml` 中另设 `EDGEWEIR_CLICKHOUSE_PASSWORD: ""`，否则与模板的默认值冲突 |

### 轮换主密钥

更换主密钥（例如怀疑泄露），已加密的数据改用新主密钥：

1. `.env` 中把原值移到 `EDGEWEIR_MASTER_KEY_PREVIOUS`，`EDGEWEIR_MASTER_KEY` 设为 `openssl rand -base64 32` 的输出。用文件时对应 `EDGEWEIR_MASTER_KEY_PREVIOUS_FILE` 与 `EDGEWEIR_MASTER_KEY_FILE`。
2. `docker compose up -d`。
3. 等待日志 `no envelope uses EDGEWEIR_MASTER_KEY_PREVIOUS any more`：

   ```bash
   docker compose logs console | grep EDGEWEIR_MASTER_KEY_PREVIOUS
   ```

   日志为 `envelopes still use EDGEWEIR_MASTER_KEY_PREVIOUS: keep it set` 时保留旧主密钥，按 `cannot re-seal` 日志排查。
4. 删除 `EDGEWEIR_MASTER_KEY_PREVIOUS`，再执行 `docker compose up -d`。

| 项目 | 说明 |
| --- | --- |
| 会话与两步验证 | 不受影响：会话密钥保持原值。主密钥泄露时另设新的 `BETTER_AUTH_SECRET`：全部会话失效，两步验证需重新启用 |
| 节点 | 无需操作 |
| 多个控制台实例 | 全部实例用同一组变量重建 |
| 轮换前的备份 | 仍由旧主密钥加密：离线保留旧主密钥，恢复时设为 `EDGEWEIR_MASTER_KEY_PREVIOUS` |
| `deploy.sh` 部署 | 编辑 `.env` 后运行 `./deploy.sh restart`；备份中不含 `EDGEWEIR_MASTER_KEY_PREVIOUS` |

## 4. 配置 `.env`

设置控制台地址：

```bash
sed -i "s|^EDGEWEIR_PUBLIC_URL=.*|EDGEWEIR_PUBLIC_URL=https://cdn-admin.example.com|" .env
```

必填变量：

| 变量 | 说明 |
| --- | --- |
| `EDGEWEIR_MASTER_KEY` 或 `EDGEWEIR_MASTER_KEY_FILE` | 主密钥，或存放主密钥的文件，见上一步。缺失时控制台拒绝启动。 |
| `POSTGRES_PASSWORD` 或 `DATABASE_URL` | 内置 PostgreSQL 的密码。`compose.yml` 由它拼出 `DATABASE_URL`，忽略 `.env` 中的 `DATABASE_URL` 行。未设置时 Compose 拒绝启动；早先未设置的部署用的是 `edgeweir`，填入它即可。[不用 Compose](#不用-compose单独的容器) 时改设 `DATABASE_URL`。 |
| `EDGEWEIR_PUBLIC_URL` | 浏览器访问控制台的地址，含协议与端口。须与浏览器地址栏一致，否则登录因来源校验失败。默认 `http://localhost:3000`，此时生成的节点安装命令也指向本机。 |

常用可选变量（在 `.env` 中取消注释后填写）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `EDGEWEIR_VERSION` | `latest` | 拉取的镜像 tag。生产环境固定日期 tag，见 [固定版本](upgrade.md#固定版本)。 |
| `EDGEWEIR_NODE_API_URL` | `https://<EDGEWEIR_PUBLIC_URL 的主机名>:8443` | 节点连接节点通道的地址；**系统设置** 的「节点通道」中保存的地址优先，见 [节点通道地址与证书](networking.md#节点通道地址与证书)。 |
| `EDGEWEIR_TRUSTED_PROXIES` | 空 | 反向代理地址，见 [可信代理](networking.md#可信代理与客户端-ip)。 |
| `EDGEWEIR_HTTP_PORT`、`EDGEWEIR_NODE_API_PORT` | `127.0.0.1:3000`、`8443` | 宿主机发布端口，可带绑定地址。Web 端口默认只在本机：Docker 发布的端口绕过 ufw、firewalld，由反向代理对外；`EDGEWEIR_HTTP_PORT=3000` 发布到所有接口。 |
| `BETTER_AUTH_SECRET` | 空，由主密钥派生 | 已设置的部署保留原值；移除后控制台拒绝启动。 |
| `EDGEWEIR_DOWNLOADS_DIR` | 空 | 节点安装包下载镜像目录，见 [下载镜像](nodes.md#下载镜像)。 |

全部变量见 [环境变量](../reference/environment.md)。

初始化之后，节点发布源与源站地址允许清单在 **系统设置** 配置，GeoIP 在 **防护设置**，SMTP 在 **告警** 页配置，保存即生效，无需重启。控制台中保存的值优先于 `.env` 中的 `EDGEWEIR_SMTP_CA_FILE`、`EDGEWEIR_NODE_RELEASE_BASE_URL`，两者都没有时使用默认值。`EDGEWEIR_OUTBOUND_ALLOW_CIDRS` 约束控制台中保存的出站地址，网页控制台不能放宽。

## 5. 启动

```bash
docker compose pull
docker compose up -d
docker compose logs -f console
```

启动顺序：

| 顺序 | 行为 | 日志 |
| --- | --- | --- |
| 1 | 等待数据库，最长 60 秒 | `database not reachable yet` |
| 2 | 执行数据库迁移 | `database migrated` |
| 3 | 首次启动生成节点通道内部 CA，私钥经主密钥加密入库 | — |
| 4 | 未初始化时输出 setup token | `first-run setup` |
| 5 | 节点通道监听 8443，输出 CA 指纹 | `node channel listening`（`caSha256`） |
| 6 | Web 控制台与 API 监听 3000 | `console listening` |

## 6. 初始化

1. 读取 setup token：

   ```bash
   docker compose logs console | grep setupToken
   ```

   未初始化的控制台每次启动输出同一个 token，直到使用。token 经主密钥加密存于数据库；主密钥更换后重新生成。

2. 打开 `<EDGEWEIR_PUBLIC_URL>/setup`，填入 setup token 与姓名、邮箱、密码，创建控制台账户。控制台同时创建默认集群 `default`。初始化向导见 [快速上手](../guide/first-site.md)。

无 token 或 token 错误的初始化请求被拒绝，并写入审计日志。token 在初始化成功后失效。

## 7. 验证

```bash
curl -s http://127.0.0.1:3000/healthz
docker compose ps
```

预期：`{"status":"ok","version":"<镜像 tag>"}`；`console` 状态为 `healthy`。

## 可选组件

| Profile | 组件 | 启用 |
| --- | --- | --- |
| `analytics` | ClickHouse：原始访问日志与分钟级统计 | `.env` 设置 `COMPOSE_PROFILES=analytics`、`EDGEWEIR_ANALYTICS=clickhouse` 与 `CLICKHOUSE_PASSWORD` |

```bash title=".env"
COMPOSE_PROFILES=analytics
EDGEWEIR_ANALYTICS=clickhouse
CLICKHOUSE_PASSWORD=<密码>
```

```bash
docker compose up -d
```

Compose 从 `.env` 读取 `COMPOSE_PROFILES`，此后每条 `docker compose` 命令（`up`、`pull`、`logs`、`down`）都包含 ClickHouse，无需加 `--profile analytics`。

控制台图表与告警使用 PostgreSQL 汇总数据。访问日志采样默认关闭，在网站的日志页面开启；原始日志保留 7 天。切换存储模式不迁移历史数据。详见 [访问日志与 AccessKey](../guide/access-logs.md)。

## 从源码构建

```bash
git clone https://github.com/marvinli001/edgeweir.git /opt/edgeweir
cd /opt/edgeweir
docker compose up -d --build
```

其余步骤相同。本地构建的镜像占用同名 tag，版本显示为 `dev`；改回发布镜像前执行 `docker compose pull`。

## 不用 Compose：单独的容器

`compose.yml` 等价于专用网络上的两个容器。已有 PostgreSQL 18 时省略 `edgeweir-postgres`，将 `DATABASE_URL` 指向该数据库。

```bash
cd /opt/edgeweir
umask 077
POSTGRES_PASSWORD=$(openssl rand -hex 24)
cat > console.env <<ENV
DATABASE_URL=postgres://edgeweir:${POSTGRES_PASSWORD}@edgeweir-postgres:5432/edgeweir
EDGEWEIR_MASTER_KEY=$(openssl rand -base64 32)
EDGEWEIR_PUBLIC_URL=https://cdn-admin.example.com
EDGEWEIR_NODE_API_URL=https://cdn-admin.example.com:8443
ENV

docker network create edgeweir
docker run -d --name edgeweir-postgres --network edgeweir --restart unless-stopped \
  -e POSTGRES_USER=edgeweir -e POSTGRES_DB=edgeweir -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  -v edgeweir-postgres:/var/lib/postgresql \
  postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873
docker run -d --name edgeweir-console --network edgeweir --restart unless-stopped \
  --env-file console.env -e ROLE=all \
  -p 127.0.0.1:3000:3000 -p 8443:8443 \
  --read-only --tmpfs /tmp --security-opt no-new-privileges:true \
  ghcr.io/marvinli001/edgeweir:20260929-a1b2c3d
```

| 项目 | 约束 |
| --- | --- |
| `console.env` | 变量与 `compose.yml` 的 `environment` 相同，可选变量按需加入；已设置 `BETTER_AUTH_SECRET` 的部署带上原值。 |
| `EDGEWEIR_VERSION` | 不写入 `console.env`：镜像内该变量表示运行中的版本。版本由镜像引用的 tag 决定。 |
| `DATABASE_URL` | 容器内的 `127.0.0.1` 指容器自身，不是宿主机。 |
| PostgreSQL 卷 | 挂载到 `/var/lib/postgresql`：PostgreSQL 18 镜像的数据位于 `/var/lib/postgresql/<主版本>/docker`。 |
| 加固参数 | `--read-only`、`--tmpfs /tmp`、`--security-opt no-new-privileges:true` 与 `compose.yml` 一致。 |

升级单独的容器见 [升级](upgrade.md#升级)。

## 排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 日志 `invalid configuration:`，随后列出变量 | 变量缺失或格式错误 | 按列出的变量修正 `.env`，执行 `docker compose up -d`。 |
| `EDGEWEIR_MASTER_KEY: is not valid base64` 或 `must be at least 32 bytes` | 主密钥被截断或改写，例如面板把 `+` 换成了空格，或值带引号 | 使用 `openssl rand -base64 32` 的原样输出。 |
| `EDGEWEIR_MASTER_KEY does not match this database` | 主密钥不是这个数据库所用的：更换了主密钥，或数据库来自另一次安装 | 恢复原主密钥（原 `.env` 或其离线副本），或按[轮换主密钥](#轮换主密钥)把它设为 `EDGEWEIR_MASTER_KEY_PREVIOUS`；设置 `BETTER_AUTH_SECRET` 无济于事。 |
| `BETTER_AUTH_SECRET is not set, but this database was used with another secret` | 已有部署移除了 `BETTER_AUTH_SECRET` | 恢复原值。 |
| 重复输出 `database not reachable yet`，60 秒后退出 | 数据库不可达 | `docker compose ps postgres` 检查数据库容器；外部数据库检查 `DATABASE_URL`。 |
| 登录失败或提示来源不受信任 | `EDGEWEIR_PUBLIC_URL` 与浏览器地址的协议、主机名或端口不一致 | 修正 `EDGEWEIR_PUBLIC_URL`，执行 `docker compose up -d`。 |
| `console` 为 `unhealthy` | `/healthz` 无响应 | `docker compose logs console`。 |
| 节点注册或连接失败 | — | 见 [接入节点排障](nodes.md#排障)。 |
