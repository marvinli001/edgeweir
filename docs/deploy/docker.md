# Docker Compose

控制台镜像的 Docker Compose 部署，以及不用 Compose 的 `docker run` 部署。

运行要求与其他平台见 [部署概览](README.md)。宝塔 / aaPanel 与 `deploy.sh` 见 [baota.md](baota.md)。

## 编排服务

`compose.yml` 的项目名为 `edgeweir`：卷名 `edgeweir_postgres-data`，网络名 `edgeweir_default`。

| 服务 | 镜像 | 启用 | 说明 |
| --- | --- | --- | --- |
| `console` | `ghcr.io/marvinli001/edgeweir:${EDGEWEIR_VERSION:-latest}` | 默认 | `ROLE=all`；发布 `${EDGEWEIR_HTTP_PORT:-3000}:3000` 与 `${EDGEWEIR_NODE_API_PORT:-8443}:8443`；只读根文件系统、`/tmp` 为 tmpfs、`no-new-privileges` |
| `postgres` | `postgres:18.6-alpine`（按 digest 固定） | 默认 | 卷 `postgres-data` 挂载到 `/var/lib/postgresql`；端口不发布；`pg_isready` 健康检查通过后 `console` 才启动 |
| `clickhouse` | `clickhouse/clickhouse-server:26.9-alpine`（按 digest 固定） | `--profile analytics` | 卷 `clickhouse-data` |
| `valkey` | `valkey/valkey:9.2-alpine`（按 digest 固定） | `--profile cache` | 控制台目前未使用 |

镜像公开，拉取无需登录。tag 规则见 [版本、升级与回滚](upgrade.md)。

## 1. 准备

1. 准备 Linux 服务器（amd64 或 arm64），安装 Docker Engine 与 Docker Compose v2：

   ```bash
   docker compose version
   ```

2. 在防火墙与云安全组放行 8443/TCP。3000/TCP 的暴露方式见 [端口与反向代理](networking.md)。

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

## 4. 配置 `.env`

设置控制台地址：

```bash
sed -i "s|^EDGEWEIR_PUBLIC_URL=.*|EDGEWEIR_PUBLIC_URL=https://cdn-admin.example.com|" .env
```

必填变量：

| 变量 | 说明 |
| --- | --- |
| `EDGEWEIR_MASTER_KEY` | 主密钥，见上一步。缺失时控制台拒绝启动。 |
| `POSTGRES_PASSWORD` | 内置 PostgreSQL 的密码。`compose.yml` 由它拼出 `DATABASE_URL`，忽略 `.env` 中的 `DATABASE_URL` 行。 |
| `EDGEWEIR_PUBLIC_URL` | 浏览器访问控制台的地址，含协议与端口。须与浏览器地址栏一致，否则登录因来源校验失败。 |

常用可选变量（在 `.env` 中取消注释后填写）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `EDGEWEIR_VERSION` | `latest` | 拉取的镜像 tag。生产环境固定日期 tag，见 [固定版本](upgrade.md#固定版本)。 |
| `EDGEWEIR_NODE_API_URL` | `https://<EDGEWEIR_PUBLIC_URL 的主机名>:8443` | 节点连接节点通道的地址，见 [节点通道地址与证书](networking.md#节点通道地址与证书)。 |
| `EDGEWEIR_TRUSTED_PROXIES` | 空 | 反向代理地址，见 [可信代理](networking.md#可信代理与客户端-ip)。 |
| `EDGEWEIR_HTTP_PORT`、`EDGEWEIR_NODE_API_PORT` | `3000`、`8443` | 宿主机发布端口，可带绑定地址，例如 `127.0.0.1:3000`。 |
| `BETTER_AUTH_SECRET` | 空，由主密钥派生 | 已设置的部署保留原值；移除后控制台拒绝启动。 |
| `EDGEWEIR_DOWNLOADS_DIR` | 空 | 节点安装包下载镜像目录，见 [下载镜像](nodes.md#下载镜像)。 |

全部变量见 [环境变量](../reference/environment.md)。

初始化之后，SMTP、节点发布源、源站地址允许清单与 GeoIP 在 **系统设置** 配置，保存即生效，无需重启。系统设置中保存的值优先于 `.env` 中的 `EDGEWEIR_SMTP_CA_FILE`、`EDGEWEIR_NODE_RELEASE_BASE_URL`，两者都没有时使用默认值。`EDGEWEIR_OUTBOUND_ALLOW_CIDRS` 约束系统设置中保存的出站地址，网页控制台不能放宽。

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
| `analytics` | ClickHouse：原始访问日志与分钟级统计 | `.env` 设置 `EDGEWEIR_ANALYTICS=clickhouse` 与 `CLICKHOUSE_PASSWORD` |
| `cache` | Valkey | 控制台目前未使用 |

```bash
docker compose --profile analytics up -d
```

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
| `EDGEWEIR_MASTER_KEY does not match this database` | 主密钥不是这个数据库所用的：更换了主密钥，或数据库来自另一次安装 | 恢复原主密钥（原 `.env` 或其离线副本）；设置 `BETTER_AUTH_SECRET` 无济于事。 |
| `BETTER_AUTH_SECRET is not set, but this database was used with another secret` | 已有部署移除了 `BETTER_AUTH_SECRET` | 恢复原值。 |
| 重复输出 `database not reachable yet`，60 秒后退出 | 数据库不可达 | `docker compose ps postgres` 检查数据库容器；外部数据库检查 `DATABASE_URL`。 |
| 登录失败或提示来源不受信任 | `EDGEWEIR_PUBLIC_URL` 与浏览器地址的协议、主机名或端口不一致 | 修正 `EDGEWEIR_PUBLIC_URL`，执行 `docker compose up -d`。 |
| `console` 为 `unhealthy` | `/healthz` 无响应 | `docker compose logs console`。 |
| 节点注册或连接失败 | — | 见 [接入节点排障](nodes.md#排障)。 |
