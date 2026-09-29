# 在宝塔面板 / aaPanel 中部署 Edgeweir 控制台

适用于已安装宝塔面板（BT Panel）9.x 或 aaPanel（宝塔国际版）并启用 Docker 功能的服务器，两者的 Docker 菜单相同，下文写作「宝塔 / aaPanel」。思路：用面板的「容器编排」（aaPanel 菜单名 Compose）运行控制台和 PostgreSQL；Web 控制台交给面板 nginx 反向代理（可以在面板上配置 HTTPS）；**节点通道 8443 不经过面板 nginx 的 HTTP 反代**。

镜像是公开的 `ghcr.io/marvinli001/edgeweir`，不需要在面板里添加镜像仓库或登录。版本是滚动发布的 `日期-提交` tag（例如 `20260929-a1b2c3d`），`latest` 指向最新一个，没有 `v1.2.3` 式的版本号；生产环境固定一个日期 tag，详见 [docker.md](docker.md#版本与镜像)。面板的点击流程按官方文档整理，尚未在真实面板服务器上逐项验收。

## 1. 为什么 8443 不能交给宝塔反代

节点和控制台之间是双向 TLS（mTLS）：节点注册时校验控制台内部 CA 的指纹，注册后每个请求都带客户端证书。这要求 TLS 由控制台自己终结。如果宝塔 nginx 在 8443 上终结 TLS，节点看到的是宝塔的证书（指纹对不上，注册失败），控制台也拿不到节点的客户端证书。所以 8443 只能：

- **直接暴露**（默认，最简单）；或
- 用 nginx **stream 四层透传**（不解密，只转发 TCP）。

## 2. 准备

1. 宝塔「软件商店」安装 **Docker**（宝塔 9.x 自带「Docker」菜单）。
2. 在宝塔「安全」和云厂商安全组中放行 **8443/TCP**。3000 不需要对外放行（只给宝塔 nginx 本机访问）。
3. 准备一个控制台域名，例如 `cdn-admin.example.com`，解析到这台服务器。

## 3. 创建编排

1. 宝塔「Docker → 容器编排 → 添加容器编排」（aaPanel「Docker → Compose → Add」）。
2. 名称填 `edgeweir`，把仓库中的 [`compose.baota.yml`](../../compose.baota.yml) 内容粘贴进去。
3. 在编排的 `.env` 栏填入下面的变量（面板把它保存为编排目录里的 `.env`，一般是 `/www/dk_project/edgeweir/.env`）。面板没有 `.env` 栏时，在面板终端里进入编排目录生成：

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

   - `EDGEWEIR_MASTER_KEY` 用于加密入库的私钥和 DNS 密钥，并派生登录会话 secret，**请离线备份**。
   - 不需要再填 `BETTER_AUTH_SECRET`。已经填过它的旧编排要保留原值，删掉后控制台拒绝启动（否则所有人会被登出，已启用的两步验证也无法读取）。
   - `EDGEWEIR_VERSION` 换成 [GitHub Packages](https://github.com/marvinli001/edgeweir/pkgs/container/edgeweir) 上当前最新的日期 tag；评估环境可以写 `latest`。
   - 在 `.env` 栏里填写时，等号右边要填在终端里生成好的实际值，面板不会执行其中的命令。

4. 点击「确定/启动」，面板会先拉取镜像。在「容器」列表里应看到 `edgeweir-console`（healthy）和 `edgeweir-postgres`。

## 4. 反向代理 Web 控制台

1. 宝塔「网站 → 添加站点」，域名填 `cdn-admin.example.com`，PHP 选「纯静态」。
2. 站点设置 →「反向代理 → 添加反向代理」，目标 URL 填 `http://127.0.0.1:3000`，发送域名保持 `$host`。
3. 站点设置 →「SSL」申请或上传证书，开启「强制 HTTPS」。
4. 在宝塔「Docker → 容器 → console → 日志」里找到 `setupToken`（一次性 setup token），浏览器打开 `https://cdn-admin.example.com`，在初始化向导里填入它并创建管理员。
5. SMTP、节点发布源、所有权校验 DNS、源站地址允许清单和 GeoIP 在控制台 **后台 → 系统设置** 填写，不需要改 `.env`。

`EDGEWEIR_PUBLIC_URL` 必须与浏览器实际访问的地址一致（含 `https://`），否则登录会因来源校验失败。

宝塔 nginx 经 Docker 端口映射访问 `127.0.0.1:3000`，控制台看到的对端是 Docker 网桥网关。要让审计日志和登录限速使用访客的真实 IP，在 `.env` 里加 `EDGEWEIR_TRUSTED_PROXIES=172.16.0.0/12`（以 `docker network inspect edgeweir_default` 显示的网关为准）并重启编排；不设置时控制台不采信任何 `X-Forwarded-For`。

## 5. （可选）用 stream 透传 8443

如果想让 8443 也经过宝塔的 nginx（例如统一端口管理），只能做四层透传：

1. 把 compose 中节点通道端口改为只监听本机：`.env` 里加 `EDGEWEIR_NODE_API_PORT=127.0.0.1:18443`，重启编排。
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

## 不用编排：单独创建容器

面板的「容器 → 创建容器」也能部署，但表单无法设置编排里的只读根文件系统、`tmpfs` 和 `no-new-privileges` 加固，所以推荐用编排。确实要用时，按 [docker.md 的等价命令](docker.md#不用-compose单独的容器)创建：

1. 「Docker → 网络」新建网络 `edgeweir`（或在终端 `docker network create edgeweir`）。
2. PostgreSQL 容器：镜像 `postgres:18.6-alpine`，名称 `edgeweir-postgres`，网络 `edgeweir`，不映射端口；环境变量 `POSTGRES_USER=edgeweir`、`POSTGRES_DB=edgeweir`、`POSTGRES_PASSWORD=<openssl rand -hex 24 的输出>`；卷 `edgeweir-postgres` 挂到 `/var/lib/postgresql`；重启策略「总是 / unless-stopped」。
3. 控制台容器：镜像 `ghcr.io/marvinli001/edgeweir:<日期 tag>`，名称 `edgeweir-console`，网络 `edgeweir`；端口 `127.0.0.1:3000 → 3000` 和 `8443 → 8443`；环境变量 `ROLE=all`、`DATABASE_URL=postgres://edgeweir:<上面的密码>@edgeweir-postgres:5432/edgeweir`、`EDGEWEIR_MASTER_KEY`、`EDGEWEIR_PUBLIC_URL`、`EDGEWEIR_NODE_API_URL`（其余可选变量见 `compose.baota.yml`；旧部署设置过的 `BETTER_AUTH_SECRET` 要保留；不要填 `EDGEWEIR_VERSION`）。

升级单独创建的容器：拉取新 tag，删除旧的 `edgeweir-console`，用相同参数和新 tag 重建。数据在 PostgreSQL 的卷里，不受影响。

## 6. 添加节点

平台管理员在后台「集群与节点」生成一次性安装命令（先 `export EDGEWEIR_TOKEN=...`，再 `curl ... | sudo --preserve-env=EDGEWEIR_TOKEN bash -s -- ...`），在**节点服务器**（不是这台控制台服务器）上用有 sudo 权限的账号执行。token 只经环境变量传递，不出现在命令行参数里。命令里的 `--server` 就是 `EDGEWEIR_NODE_API_URL`，`--ca-sha256` 是内部 CA 指纹，节点注册前会校验。节点访问 GitHub 慢时可以配置控制台镜像，见 [docker.md](docker.md#控制台镜像可选)。

## 7. 升级、回滚与备份

- 先备份：`docker exec edgeweir-postgres pg_dump -U edgeweir edgeweir > edgeweir.sql`，并单独备份 `.env`（含主密钥）。完整步骤见 [backup.md](backup.md)。
- 滚动升级：在编排的 `.env` 里把 `EDGEWEIR_VERSION` 改成新的日期 tag，保存后在「容器编排 → edgeweir」执行「更新镜像」（aaPanel「Update image」），或在编排目录执行 `docker compose pull && docker compose up -d`。跟随 `latest` 的环境直接「更新镜像」即可。数据库迁移在启动时自动执行。
- 确认版本：`curl -s http://127.0.0.1:3000/healthz` 返回的 `version` 应是新 tag。
- 回滚：把 `EDGEWEIR_VERSION` 改回上一个 tag 再更新。迁移只向前执行，只有两个版本之间没有新增迁移时才能直接换回旧镜像，否则恢复升级前的备份（见 [docker.md](docker.md#7-升级备份与验证)）。
- 不要用自动更新工具无人值守地跟随 `latest`。

## 8. 常见问题

| 现象 | 处理 |
| --- | --- |
| 登录后立刻退出 / 提示来源不受信任 | `EDGEWEIR_PUBLIC_URL` 与实际访问地址不一致（协议、域名、端口）。 |
| 节点注册报 CA 指纹不匹配 | 8443 被宝塔或 CDN 终结了 TLS；改为直连或 stream 透传。 |
| 节点注册超时 | 安全组/宝塔防火墙未放行 8443；`EDGEWEIR_NODE_API_URL` 的域名解析是否正确。 |
| 控制台容器反复重启 | 查看容器日志，通常是 `.env` 未被读取导致缺少密钥。 |
