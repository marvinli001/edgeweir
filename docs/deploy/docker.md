# 用 Docker Compose 部署 Edgeweir 控制台

控制台是**一个镜像、一个进程**：同时提供 Web 控制台和 API（`:3000`）、节点通道（`:8443`）和后台任务。唯一的外部依赖是 PostgreSQL 18。

> 宝塔 / aaPanel 用户请看 [baota.md](baota.md)。

## 版本与镜像

镜像是公开的 `ghcr.io/marvinli001/edgeweir`（linux/amd64、linux/arm64），不需要登录即可拉取。

发布采用**滚动更新**，没有 `v1.2.3` 这类版本号和发布 tag：`master` 上每个通过 CI 的提交都会发布成 `日期-提交` 格式的镜像 tag，例如 `20260929-a1b2c3d`（UTC 提交日期 + 提交 ID 前 7 位，同一个提交永远是同一个 tag），`latest` 随之指向最新一个。

- 生产环境在 `.env` 里用 `EDGEWEIR_VERSION` 固定一个日期 tag，升级就是换成更新的 tag；只有评估环境才建议直接跟 `latest`。也可以连 digest 一起固定：`EDGEWEIR_VERSION=20260929-a1b2c3d@sha256:<digest>`。
- 全部 tag 见 [GitHub Packages](https://github.com/marvinli001/edgeweir/pkgs/container/edgeweir)；tag 里的 7 位提交 ID 可以直接打开 `https://github.com/marvinli001/edgeweir/commit/<提交 ID>` 查看改动。
- 正在运行的版本：`curl -s http://127.0.0.1:3000/healthz` 返回的 `version`，后台「系统设置」里也有显示。从源码构建的镜像显示 `dev`。

## 1. 准备

- Linux 服务器，Docker Engine 24+，Docker Compose v2（`docker compose version`）。
- 放行端口：
  - `3000/TCP`：Web 控制台与 API。可以放在反向代理后面（在代理上配置 HTTPS）。
  - `8443/TCP`：节点通道。**必须直连或四层透传**：TLS 由控制台自己终结，节点用客户端证书做双向认证，反向代理终结 TLS 会让双向认证失效。

## 2. 获取编排文件并生成密钥

服务器上只需要 `compose.yml` 和 `.env`，不需要源码。生产使用前应完成自己的容量、外部 DNS/ACME 凭据和恢复验收。

```bash
mkdir -p /opt/edgeweir && cd /opt/edgeweir
curl -fsSLO https://raw.githubusercontent.com/marvinli001/edgeweir/master/compose.yml
umask 077
curl -fsSL -o .env https://raw.githubusercontent.com/marvinli001/edgeweir/master/.env.example
```

想从源码构建时改用 `git clone https://github.com/marvinli001/edgeweir.git /opt/edgeweir`，其余步骤相同，启动时加 `--build`。

编辑 `.env`，至少填写：

| 变量 | 说明 |
| --- | --- |
| `EDGEWEIR_MASTER_KEY` | 主密钥，用于信封加密入库的私钥和 DNS API 密钥。`openssl rand -base64 32` 生成，**务必离线备份**，丢失后已加密的数据无法恢复。 |
| `BETTER_AUTH_SECRET` | 会话签名密钥，`openssl rand -base64 32` 生成。 |
| `POSTGRES_PASSWORD` | 内置 PostgreSQL 的密码（数据库端口不对外暴露），`openssl rand -hex 24` 生成（会拼进 `DATABASE_URL`，只用字母和数字）。 |
| `EDGEWEIR_PUBLIC_URL` | 浏览器访问控制台的地址，例如 `https://cdn-admin.example.com`。 |
| `EDGEWEIR_NODE_API_URL` | 节点连接节点通道的地址，例如 `https://cdn-admin.example.com:8443`。留空时取 `EDGEWEIR_PUBLIC_URL` 的主机名加 `:8443`。 |
| `EDGEWEIR_VERSION` | 要运行的镜像 tag，默认 `latest`；生产固定为某个日期 tag，见[版本与镜像](#版本与镜像)。 |

一次性生成三个密钥（`openssl rand -base64 32` 的输出原样使用，不要删掉其中的 `/`、`+`、`=`，否则解码后可能不足 32 字节，控制台会拒绝启动；数据库密码要放进 `DATABASE_URL`，所以用十六进制）：

```bash
sed -i "s|^EDGEWEIR_MASTER_KEY=.*|EDGEWEIR_MASTER_KEY=$(openssl rand -base64 32)|" .env
sed -i "s|^BETTER_AUTH_SECRET=.*|BETTER_AUTH_SECRET=$(openssl rand -base64 32)|" .env
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" .env
```

控制台缺少 `EDGEWEIR_MASTER_KEY` 或 `BETTER_AUTH_SECRET` 时会拒绝启动，并在日志里写明原因。

## 3. 启动

```bash
docker compose pull
docker compose up -d
docker compose logs -f console
```

从源码目录构建则执行 `docker compose up -d --build`（本地镜像会占用同名 tag，之后要回到发布镜像先 `docker compose pull`）。

首次启动会自动执行数据库迁移、生成节点通道的内部 CA（私钥用主密钥加密后入库），然后监听 `:3000` 和 `:8443`。

初始化需要一次性的 setup token。未初始化的控制台每次启动都会把它打印到日志（同一个 token，直到用掉为止）：

```bash
docker compose logs console | grep setupToken
```

浏览器打开 `EDGEWEIR_PUBLIC_URL`，在初始化向导里填入 setup token，创建平台管理员和第一个组织；默认集群会自动创建。没有 token 的初始化请求一律被拒绝（写入审计日志），所以初始化之前控制台暴露在网络上，别人也无法抢先创建管理员。token 用主密钥加密后存在数据库里；更换主密钥后会重新生成。

初始化之后，SMTP（含私有 CA 证书）、节点发布源、源站地址允许清单、GeoIP 和首页都在 **后台 → 系统设置** 填写，保存即生效，不需要改 `.env` 或重启。`.env` 只保留密钥、访问地址、端口和网络信任边界（`EDGEWEIR_TRUSTED_PROXIES`、`EDGEWEIR_OUTBOUND_ALLOW_CIDRS`、`EDGEWEIR_DNS_RESOLVERS`）等必须由运营者在宿主机上决定的项。

`compose.yml` 另有两个可选 profile。在 `.env` 中设置 `EDGEWEIR_ANALYTICS=clickhouse` 和独立的 `CLICKHOUSE_PASSWORD` 后，`analytics` 启用 ClickHouse 原始访问日志与分钟快照。控制台图表和告警仍使用 PostgreSQL 精确汇总。站点访问日志采样默认关闭，需在站点日志页面显式开启；原始日志保留 7 天。切换存储模式不会迁移历史数据，详见[日志与 AccessKey](../guide/access-logs.md)。

```bash
docker compose --profile analytics up -d   # ClickHouse：可选日志与分钟统计
docker compose --profile cache up -d       # Valkey：预留
```

## 4. 添加节点

以下一键安装命令适用于已发布的签名版本。目前请按[节点仓库](https://github.com/marvinli001/edgeweir-node)的源码构建说明评估；不要把未发布的示例版本号当成可下载的发行版。

平台管理员在后台「集群与节点」为集群生成一条一次性安装命令，在节点服务器上用有 sudo 权限的账号执行：

```bash
export EDGEWEIR_TOKEN='<一次性 token>'
curl -fsSL https://cdn-admin.example.com/install.sh | sudo --preserve-env=EDGEWEIR_TOKEN bash -s -- \
  --server https://cdn-admin.example.com:8443 --ca-sha256 <CA 指纹>
```

token 只经环境变量传递（`--preserve-env` 让 sudo 保留它），不出现在任何命令行参数里，`ps` 看不到；也可以写进文件用 `--token-file PATH` 传入。安装脚本先校验 cosign 签名（证书身份必须是 edgeweir-node 的 release 工作流、且正是要安装的版本 tag）和 SHA-256，再安装 OpenResty 和 `edgeweir-node`：Debian/Ubuntu 装 .deb，RHEL 系装 .rpm，其余用 tar.gz（脚本自己创建 `edgeweir` 用户和目录）。机器上没有 cosign 时，脚本下载固定版本（v3.1.3）并先核对它的 SHA-256。节点在本机生成私钥，用 token 换取证书，之后全程 mTLS。控制台不保存任何 SSH 凭据。

常用参数：`--version 0.2.0` 指定版本（默认最新），`--format deb|rpm|tar`，`--no-start` 只安装和注册、不启用 systemd 服务（容器里测试用），`--mirror URL` / `--mirror-only` 指定下载源，`--allow-unsigned` 只用于开发（仍校验 SHA-256）。

### 控制台镜像（可选）

节点访问 GitHub 慢时，可以让控制台转发发布文件：把 edgeweir-node 发布页上的文件放进一个目录，挂载进容器并设置 `EDGEWEIR_DOWNLOADS_DIR`，安装脚本会先从 `<控制台>/downloads/edgeweir-node/` 下载，没有的文件再去 GitHub。镜像只是传输通道，签名和 SHA-256 照样在节点上校验。

```text
downloads/
  edgeweir-node/
    latest                      # 内容是版本号，例如 0.2.0
    v0.2.0/
      checksums.txt
      checksums.txt.sigstore.json
      edgeweir-node_0.2.0_amd64.deb
      edgeweir-node-0.2.0-1.x86_64.rpm
      edgeweir-node_0.2.0_linux_amd64.tar.gz
      ...
  cosign/
    v3.1.3/
      cosign-linux-amd64
      cosign-linux-arm64
```

compose.yml 里取消 `volumes` 注释（`./downloads:/srv/edgeweir-downloads:ro`），`.env` 里设置 `EDGEWEIR_DOWNLOADS_DIR=/srv/edgeweir-downloads`。未设置时 `/downloads/*` 一律 404。

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

控制台默认**不信任** `X-Forwarded-For` / `X-Real-IP`：审计日志里的 IP 和登录限速都按 TCP 对端地址计算，否则任何人都能伪造 IP 绕过限速。放在反向代理后面时，把代理连到控制台时使用的地址写进 `.env` 的 `EDGEWEIR_TRUSTED_PROXIES`（逗号分隔的 IP 或 CIDR），只有来自这些地址的转发头才会被采用。代理跑在宿主机、经 Docker 端口映射访问 `127.0.0.1:3000` 时，先用 `docker network inspect edgeweir_default` 核实网关及控制台实际看到的对端地址，再配置该单一地址；不要信任整个私网范围或客户端可直接进入的网段。

登录、改密码等认证接口的限速计数存在 PostgreSQL 里，多个 `app` 副本共享，重启后也不会清零。

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

同一个镜像用 `ROLE` 选择角色：`all`（默认）、`app`（Web/API/节点通道）、`worker`（pg-boss 后台任务）。流量大时可以运行多个 `app` 副本和一个或多个 `worker`，它们共享 PostgreSQL，通过 LISTEN/NOTIFY 广播配置变更。所有实例使用同一个镜像 tag。

### 不用 Compose：单独的容器

`compose.yml` 等价于一个专用网络上的两个容器，也可以直接用 `docker run` 创建（面板的「容器」功能按同样的参数填写，见 [baota.md](baota.md#不用编排单独创建容器)）。已有 PostgreSQL 18 时跳过第一个容器，把 `DATABASE_URL` 指向它即可（容器里的 `127.0.0.1` 是容器自己，不是宿主机）。

```bash
cd /opt/edgeweir
umask 077
POSTGRES_PASSWORD=$(openssl rand -hex 24)
cat > console.env <<ENV
DATABASE_URL=postgres://edgeweir:${POSTGRES_PASSWORD}@edgeweir-postgres:5432/edgeweir
EDGEWEIR_MASTER_KEY=$(openssl rand -base64 32)
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
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

`console.env` 里的变量与 `compose.yml` 的 `environment` 相同，其余可选变量按需加入；不要写 `EDGEWEIR_VERSION`，它在镜像里表示运行中的版本。升级时拉取新 tag，删除旧的 `edgeweir-console` 容器，用同样的参数和新 tag 重新创建；数据在 `edgeweir-postgres` 卷里，不受影响。

## 7. 升级、备份与验证

- 控制台升级（滚动）：先[备份](backup.md)，把 `.env` 的 `EDGEWEIR_VERSION` 改成新的日期 tag，然后：

  ```bash
  docker compose pull
  docker compose up -d
  curl -s http://127.0.0.1:3000/healthz
  ```

  迁移在启动时自动执行（带锁，多实例安全）。启动时还会把旧版本写入的信封密文（附加数据未绑定记录 id）用主密钥重新加密一次；新版本不再读取旧格式，所以多个控制台实例要一起升级。源码评估环境则检出目标提交后执行 `docker compose up -d --build`。
- 回滚：把 `EDGEWEIR_VERSION` 改回上一个 tag 再 `docker compose up -d`。迁移只向前执行、没有 down 脚本，所以只有两个版本之间没有新增迁移（对比两次提交的 `packages/db/migrations/`）时才能直接换回旧镜像；否则恢复升级前的备份。
- 不建议用 Watchtower 之类的工具无人值守地跟随 `latest`：每次启动都可能执行迁移，升级应当在备份之后、有人看着时进行。
- 节点升级：[签名升级、试运行与回滚](../guide/node-upgrades.md)。固定监督进程、cosign 和 OpenResty 使用完整镜像或系统包更新。
- 备份与恢复：见[完整操作步骤](backup.md)，包括数据库、独立保管的主密钥、节点状态、经过认证的 revision 回执，以及可选 ClickHouse 的一致恢复点。
- 校验镜像签名（证书身份是 `master` 分支上的 release 工作流）：

```bash
cosign verify ghcr.io/marvinli001/edgeweir:<版本> \
  --certificate-identity https://github.com/marvinli001/edgeweir/.github/workflows/release.yml@refs/heads/master \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

## 8. 排障

| 现象 | 检查 |
| --- | --- |
| 控制台起不来 | `docker compose logs console`，通常是缺少密钥或连不上数据库。 |
| 节点注册失败 `CA fingerprint mismatch` | 节点连到了错误的地址，或中间有设备终结了 TLS。 |
| 节点一直离线 | 节点能否访问 `EDGEWEIR_NODE_API_URL`；防火墙/安全组是否放行 8443；证书的主机名是否在 `EDGEWEIR_NODE_API_HOSTNAMES` 中。 |
| 健康检查 | `curl http://127.0.0.1:3000/healthz` |
