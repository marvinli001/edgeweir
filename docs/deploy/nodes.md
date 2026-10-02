# 接入节点

为集群生成安装命令，在 Linux 主机上安装并注册边缘节点；节点端口与防火墙；运行区域探针。

## 要求

| 项目 | 要求 |
| --- | --- |
| 系统 | Linux，amd64 或 arm64，glibc 2.34 及以上：RHEL、Rocky、AlmaLinux 9 及以上，Debian 12 及以上，Ubuntu 22.04 及以上；systemd（`--no-start` 时不要求） |
| 权限 | root 或 sudo |
| 命令 | `curl`、`sha256sum`、`tar` |
| 访问控制台 | `EDGEWEIR_PUBLIC_URL`（`/install.sh`、`/downloads/*`）与 `EDGEWEIR_NODE_API_URL`（节点通道，默认 8443），见 [端口与反向代理](networking.md) |
| 访问外部 | GitHub Releases 与 `api.github.com`（未使用 `--mirror-only` 时） |

节点使用为 Edgeweir 构建的 OpenResty，与 edgeweir-node 一起发布，列在同一个已签名的 `checksums.txt` 中：

| 软件包 | 内容 | 安装 |
| --- | --- | --- |
| `edgeweir-openresty` | OpenResty 1.31.1.1，含 HTTP/2、HTTP/3、Brotli、Zstandard；`/usr/lib/edgeweir-openresty/`（nginx 为 `/usr/lib/edgeweir-openresty/nginx/sbin/nginx`） | `edgeweir-node` 依赖它，始终安装 |
| `edgeweir-openresty-modsecurity` | ModSecurity 动态模块 `/usr/lib/edgeweir-openresty/modules/ngx_http_modsecurity_module.so` 与 OWASP CRS 规则 `/usr/share/edgeweir-openresty/crs/` | `edgeweir-node` 推荐安装；`install.sh` 默认安装，`--no-modsecurity` 跳过，此时节点不支持 [OWASP CRS](../guide/waf.md) |

两个软件包只有 deb 与 rpm 格式（amd64、arm64）。不再使用 openresty.org 的软件源；早先由 `install.sh` 添加的 openresty.org 软件源与 `openresty` 软件包可以自行删除。

## 1. 生成安装命令

1. 打开 **集群与节点**，选择集群，点击 **添加节点**。
2. 填写 **节点名称**，选择 **节点组**（默认为集群的默认节点组）与 **有效期**（15 分钟、1 小时、24 小时，默认 1 小时）。
3. 点击 **生成安装命令**。对话框显示 **安装命令** 与 **CA 指纹**，仅显示一次。
4. 在节点上执行命令后，对话框的 **注册进度** 每 3 秒刷新：等待节点注册（或令牌已过期）、已注册（节点名称链接到节点详情）、在线、配置已应用、数据面正常、有可供 DNS 使用的地址。

| 项目 | 行为 |
| --- | --- |
| 注册 token | `ewt_` 前缀，单次有效，数据库只存 SHA-256；生成操作写入审计日志。 |
| `--server` | `EDGEWEIR_NODE_API_URL`。 |
| `--ca-sha256` | 节点通道内部 CA 的 SHA-256 指纹。 |
| API | `POST /api/v1/enrollment-tokens`，`ttlMinutes` 取值 5–10080，默认 60；`GET /api/v1/enrollment-tokens/{id}` 返回 `usedAt` 与注册的节点。见 [API 与端点](../reference/api.md)。 |
| 地址提醒 | 控制台地址（`install.sh` 从此下载）或节点通道地址是 localhost、回环或内网地址时，对话框逐条提醒，**系统设置** 中的地址旁显示「仅本机可达」或「内网地址」，控制台启动时写一条警告日志；不阻止生成。 |
| 清理 | 过期或使用超过 7 天的 token 每 30 分钟删除一次。 |

## 2. 执行安装命令

在节点主机（不是控制台主机）上以具备 sudo 权限的账户执行生成的命令：

```bash title="节点"
export EDGEWEIR_TOKEN='<一次性 token>'
curl -fsSL https://cdn-admin.example.com/install.sh | sudo --preserve-env=EDGEWEIR_TOKEN bash -s -- \
  --server https://cdn-admin.example.com:8443 --ca-sha256 <CA 指纹>
```

token 只经 `EDGEWEIR_TOKEN` 环境变量或 `--token-file PATH` 传递，不出现在进程参数中；`--token` 参数被拒绝。全部选项见 [命令行](../reference/cli.md)。

## 3. 验证

```bash title="节点"
systemctl status edgeweir-node
journalctl -u edgeweir-node -f
```

预期：`edgeweir-node.service` 为 `active (running)`；**集群与节点** 中该节点状态为「在线」，**已应用版本** 显示配置版本号。

## install.sh 流程

| 步骤 | 行为 | 失败时 |
| --- | --- | --- |
| 1 | 读取 token（`EDGEWEIR_TOKEN` 或 `--token-file`），校验 `ewt_` 格式，从环境中移除，子进程不继承。状态目录已有 `identity.json`（已注册）时不需要 token，给出也不使用 | 退出 |
| 2 | 检查 Linux、root、`curl`、`sha256sum`、`tar`、systemd、架构；`--format auto` 时有 `dpkg` 与 `apt-get` 选 deb，有 `rpm` 与 `dnf`/`yum` 选 rpm，否则 tar.gz。未注册时再检查节点通道：`--server` 须有 HTTP 响应（任意状态码，不发送 token）；主机有 `openssl` 时，服务器出示的最后一张证书须为 `--ca-sha256` 固定的 CA | 退出，指出无法连接或前面有终结 TLS 的代理 |
| 3 | 解析版本：`--version`，或下载镜像的 `latest` 文件，再回退到 GitHub 最新发布 | 退出，提示传入 `--version` |
| 4 | 下载 `checksums.txt` 与 `checksums.txt.sigstore.json`：先下载镜像，后 GitHub | 退出 |
| 5 | `cosign verify-blob` 校验签名：证书身份必须为 `https://github.com/marvinli001/edgeweir-node/.github/workflows/release.yml@refs/tags/v<版本>`，签发者 `https://token.actions.githubusercontent.com`。主机无 cosign 时下载 cosign v3.1.3，核对脚本内固定的 SHA-256 后安装到 `/usr/local/bin/cosign` | 退出 |
| 6 | 从已签名的 `checksums.txt` 选出本机的安装包，以及同一发布的 `edgeweir-openresty`、`edgeweir-openresty-modsecurity`（每个软件包、格式、架构恰好一个文件）；glibc 低于 2.34 时退出；下载（先镜像，后 GitHub）并校验 SHA-256 | 退出 |
| 7 | 先安装 `edgeweir-openresty` 与 `edgeweir-openresty-modsecurity`。tar.gz 安装时按主机的 `dpkg` 或 `rpm` 选择格式；两者都没有时要求已安装 `edgeweir-openresty` | 退出 |
| 8 | 安装 deb、rpm 或 tar.gz | 退出 |
| 9 | `edgeweir-node enroll`：核对 CA 指纹后提交 token，本机生成私钥，以 CSR 换取节点证书；此后仅经 mTLS 通信。已注册时跳过（重新注册：先 `systemctl stop edgeweir-node`，再 `edgeweir-node enroll --force`，然后启动） | 退出 |
| 10 | 停用 `openresty.service`，启用并启动 `edgeweir-node.service`（`--no-start` 时跳过）；tar.gz 安装时先重启运行中的服务（deb、rpm 由包脚本重启） | — |

- 第 5、6 步通过前不执行任何下载的程序。`--allow-unsigned` 跳过第 5 步，仅用于开发，仍校验 SHA-256。
- 脚本全部由函数组成，最后一行才调用 `main`：下载中断时不执行任何内容。
- 已注册的主机可以重新运行同一命令：某一步失败后重试，或更新软件包。
- 控制台不保存 SSH 凭据；节点私钥不离开节点。

安装结果：

| 路径 | 内容 |
| --- | --- |
| `/usr/bin/edgeweir-node` | agent |
| `/usr/share/edgeweir-node/lua/edgeweir/` | OpenResty Lua 模块 |
| `/usr/lib/edgeweir-openresty/` | OpenResty（`edgeweir-openresty`）；`modules/` 下为 ModSecurity 模块 |
| `/usr/share/edgeweir-openresty/crs/` | OWASP CRS 规则（`edgeweir-openresty-modsecurity`，版本随软件包固定，运行时不下载） |
| `/var/lib/edgeweir-node/` | 状态目录（`edgeweir` 用户，0700）：`node.key`、`node.crt`、`ca.crt`、`identity.json`、`config/`（最后可用配置与 `receipts.json`） |
| `/var/cache/edgeweir-node/` | 缓存目录（`edgeweir` 用户，0750） |
| `edgeweir-node.service` | deb、rpm：`/usr/lib/systemd/system/`；tar.gz：`/etc/systemd/system/` |

deb、rpm 由包脚本创建 `edgeweir` 用户与目录；tar.gz 由 `install.sh` 创建。

## 端口与防火墙

节点在以下端口接受用户流量，主机防火墙与云安全组需要放行；节点只主动连接控制台的节点通道，不需要为控制台开放入站端口。

| 端口 | 用途 | 条件 |
| --- | --- | --- |
| 80/TCP | HTTP、ACME HTTP-01 | 始终 |
| 443/TCP | HTTPS | 集群中有网站选择了证书 |
| 443/UDP | HTTP/3 | 有网站开启 HTTP/3，见 [监听端口](../guide/https.md#监听端口) |
| 集群的端口池 | [四层转发](../guide/l4.md) | TCP 端口池放行 TCP，UDP 端口池放行 UDP，TCP + UDP 两者都放行；也可以只放行已有 L4 应用使用的端口 |

| 项目 | 说明 |
| --- | --- |
| 权限 | 端口池只含 1024–65535，systemd 单元与镜像不需要额外权限 |
| 容器节点 | 发布端口池中的端口，例如 `-p 9000:9000 -p 9000:9000/udp`，区间写成 `-p 20000-20100:20000-20100`；端口池较大时使用 host 网络（`--network host`） |
| 端口变化 | 新建、删除 L4 应用或修改其端口时节点 reload，已有连接由旧 worker 继续服务，见 [reload 与长连接](../guide/l4.md#reload-与长连接) |

### 旧 worker 的关闭时间

reload 后，旧 worker 默认一直服务已有的连接（四层长连接、HTTP keep-alive、WebSocket），直到连接结束；频繁的结构性变更会留下多组旧 worker。节点参数 `--stream-shutdown-timeout`（环境变量 `EDGEWEIR_STREAM_SHUTDOWN_TIMEOUT`）限制这段时间：

| 值 | 行为 |
| --- | --- |
| `0`（默认） | 不限时，旧 worker 在最后一个连接结束后退出 |
| 时长，如 `30m`、`2h` | 到时间后旧 worker 关闭仍在服务的全部连接（nginx `worker_shutdown_timeout`），四层、HTTP 与 WebSocket 连接都受影响 |

```bash title="/etc/default/edgeweir-node"
EDGEWEIR_STREAM_SHUTDOWN_TIMEOUT=30m
```

修改后执行 `sudo systemctl restart edgeweir-node`。容器节点用 `-e EDGEWEIR_STREAM_SHUTDOWN_TIMEOUT=30m`。

## 区域探针

区域探针从所在区域探测各节点的调度地址，结果驱动备用 IP 与智能调度，见[区域探针与智能调度](../guide/scheduling.md)。探针是 `edgeweir-node` 的 `probe` 模式：不运行 OpenResty，不监听端口，身份与节点分开。注册令牌在 **区域与探针** →「探针」→「添加探针」生成，只显示一次。

| 项目 | 要求 |
| --- | --- |
| 运行方式 | 节点镜像（Docker，amd64 / arm64），或 Linux amd64 / arm64 上的 systemd 单元与二进制 |
| 出站 | 节点通道（`EDGEWEIR_NODE_API_URL`，默认 8443），以及各节点调度地址上的监听端口 |
| 入站 | 不需要 |
| 位置 | 放在要代表的运营商或地区网络中 |
| 数量 | 地址按全部探测方的严格多数判定可达性：只有一个探测方时，它自己的网络故障也会让地址被判为不可达；至少两个时需要超过一半同时失败 |

### 容器

控制台给出的「启动命令」是 `docker run`，见[添加探针](../guide/scheduling.md#添加探针)。Compose 写法：

```yaml title="compose.yml（探针主机）"
services:
  probe:
    image: ghcr.io/marvinli001/edgeweir-node:latest
    entrypoint: ["/usr/local/bin/edgeweir-node", "probe"]
    environment:
      EDGEWEIR_STATE_DIR: /var/lib/edgeweir-probe
      EDGEWEIR_SERVER: https://cdn-admin.example.com:8443
      EDGEWEIR_CA_SHA256: <CA 指纹>
      EDGEWEIR_TOKEN: <注册令牌>   # 只在首次启动时使用
    volumes:
      - probe-state:/var/lib/edgeweir-probe
    healthcheck:
      disable: true
    restart: unless-stopped
volumes:
  probe-state:
```

| 项目 | 行为 |
| --- | --- |
| 健康检查 | 镜像自带的健康检查查询数据面，探针不运行数据面：Compose 中关闭（如上），`docker run` 加 `--no-healthcheck`（控制台生成的命令已带）；不关闭时容器显示 `unhealthy`，不影响探测 |
| 用户 | 容器以 uid 10001 运行，状态目录在卷中 |
| 令牌 | 注册完成后忽略，可以从配置中删除 |

### systemd

edgeweir-node 的 deb、rpm 软件包含 `edgeweir-probe.service`（默认不启用），tar.gz 在 `systemd/` 目录中提供同一单元。软件包依赖 `edgeweir-openresty`，探针模式不启动它；安装前按 [SECURITY.md](../../SECURITY.md#验证发布物) 校验发布物，探针主机不启用 `edgeweir-node.service`。

```bash title="探针主机"
sudo tee /etc/default/edgeweir-probe >/dev/null <<'CONF'
EDGEWEIR_SERVER=https://cdn-admin.example.com:8443
EDGEWEIR_CA_SHA256=<CA 指纹>
EDGEWEIR_TOKEN=<注册令牌>
CONF
sudo chmod 600 /etc/default/edgeweir-probe
sudo systemctl enable --now edgeweir-probe
journalctl -u edgeweir-probe -f
```

| 项目 | 行为 |
| --- | --- |
| 用户与权限 | `edgeweir` 用户，不授予任何 capability，文件系统除状态目录外只读，只允许 IP 与 unix 套接字 |
| 配置 | `/etc/default/edgeweir-probe`（0600）只由 systemd 读取；注册完成后令牌一行可以删除 |
| 缺少注册参数 | 退出码 2，不自动重启 |

### 命令行

```text
EDGEWEIR_TOKEN=<注册令牌> edgeweir-node probe --server URL --ca-sha256 HEX [--server-name NAME] [--state-dir DIR]
edgeweir-node probe [--state-dir DIR]     # 已注册
```

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--server` | 无（首次运行必填） | 节点通道地址 |
| `--ca-sha256` | 无（首次运行必填） | 节点通道内部 CA 证书（DER）的 SHA-256，十六进制 |
| `--token-file` | 无 | 注册令牌文件（首次运行） |
| `--token` | 无 | 注册令牌（首次运行）；出现在进程列表中，优先用 `EDGEWEIR_TOKEN` 或 `--token-file` |
| `--server-name` | `--server` 的主机名 | 校验的 TLS 服务器名 |
| `--state-dir` | `/var/lib/edgeweir-probe` | 探针身份目录，与节点的分开 |
| `--timeout` | `30s` | 每个控制台 RPC 的超时 |
| `--log-level` | `info` | `debug`、`info`、`warn`、`error` |
| `--log-format` | `text` | `text`、`json` |

参数也可由环境变量 `EDGEWEIR_<参数名>` 设置（如 `--state-dir` → `EDGEWEIR_STATE_DIR`），命令行优先。

### 注册与身份

| 项目 | 行为 |
| --- | --- |
| 首次启动 | 本机生成 ECDSA P-256 私钥与 CSR，核对 CA 指纹后提交令牌，换取探针证书；控制台不可达或繁忙时以同一令牌退避重试（1–30 秒），令牌被拒或指纹不符时退出 |
| 之后 | 忽略令牌，全程 mTLS；证书剩余不足三分之一时自动续期 |
| 状态目录 | `/var/lib/edgeweir-probe`（0700）：`probe.key`（0600）、`probe.crt`、`ca.crt`、`probe.json` |
| 重新注册 | 在控制台删除原探针（吊销证书），删除 `probe.json`（或整个状态目录），用新令牌启动 |
| 与节点同机 | 可以；状态目录分开。节点本身兼任探针时不需要单独的探针进程，见[节点兼任探针](../guide/scheduling.md#节点兼任探针) |

## 下载镜像

节点访问 GitHub 受限时，控制台可在 `/downloads/*` 提供发布文件。镜像只是传输通道：签名与 SHA-256 仍在节点上校验。

| 项目 | 行为 |
| --- | --- |
| 启用 | 设置 `EDGEWEIR_DOWNLOADS_DIR`；未设置时 `/downloads/*` 一律返回 404 |
| 默认镜像地址 | `install.sh` 使用 `<EDGEWEIR_PUBLIC_URL>/downloads/edgeweir-node`，`--mirror URL` 可替换 |
| 回退 | 镜像缺少的文件从 GitHub 下载；`--mirror-only` 禁止回退 |
| 项目 | 仅 `edgeweir-node` 与 `cosign` |
| 路径规则 | `<项目>/latest`，或 `<项目>/v<语义化版本>/<文件名>`；其他路径、目录与指向目录外的符号链接返回 404 |
| 缓存头 | `latest`：`no-cache`；其他文件：`public, max-age=86400, immutable` |
| 权限 | 目录与文件须对容器用户 `node`（uid 1000）可读。启动时目录不存在或不可读，控制台日志写 `EDGEWEIR_DOWNLOADS_DIR cannot be served`；文件存在但不可读时返回 404，并写 `cannot read the download mirror`（同一错误每分钟一条） |

目录结构：

```text
downloads/
  edgeweir-node/
    latest                      # 版本号，例如 0.2.0
    v0.2.0/
      checksums.txt
      checksums.txt.sigstore.json
      edgeweir-node_0.2.0_amd64.deb
      edgeweir-node-0.2.0-1.x86_64.rpm
      edgeweir-node_0.2.0_linux_amd64.tar.gz
      edgeweir-openresty_1.31.1.1-2_amd64.deb
      edgeweir-openresty-1.31.1.1-2.x86_64.rpm
      edgeweir-openresty-modsecurity_1.31.1.1-2_amd64.deb
      edgeweir-openresty-modsecurity-1.31.1.1-2.x86_64.rpm
      ...
  cosign/
    v3.1.3/
      cosign-linux-amd64
      cosign-linux-arm64
```

启用步骤（`compose.yml`）：

1. 将 edgeweir-node 发布页的文件按上述结构放入 `/opt/edgeweir/downloads`。
2. 在 `compose.yml` 的 `console` 服务取消 `volumes` 注释：`./downloads:/srv/edgeweir-downloads:ro`。
3. 在 `.env` 设置 `EDGEWEIR_DOWNLOADS_DIR=/srv/edgeweir-downloads`，执行 `docker compose up -d`。
4. 验证：

   ```bash
   curl -s https://cdn-admin.example.com/downloads/edgeweir-node/latest
   ```

   预期：输出版本号。

节点 agent 自升级使用的发布源在 **系统设置 → 节点发布源** 配置，与本镜像无关，见 [节点升级](../guide/node-upgrades.md)。

## 排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `no enrollment token` | `sudo` 未保留 `EDGEWEIR_TOKEN` | 原样执行生成的命令：`export` 与 `sudo --preserve-env=EDGEWEIR_TOKEN`。 |
| `the enrollment token is malformed (expected ewt_...)` | token 复制不完整 | 重新复制安装命令。 |
| `systemd is required` | 主机无 systemd | 使用 systemd 主机，或加 `--no-start` 只安装与注册。 |
| `could not determine the latest edgeweir-node version; pass --version` | 下载镜像无 `latest`，且 GitHub 不可达或无发布 | 加 `--version`，或配置下载镜像。 |
| `edgeweir-openresty needs glibc 2.34 or later` | 发行版过旧 | 使用 RHEL、Rocky、AlmaLinux 9，Debian 12，Ubuntu 22.04 或更新的系统。 |
| `checksums.txt does not list exactly one ... package of edgeweir-openresty...` | 镜像或发布缺少该软件包，或同一架构有多个版本 | 按 `checksums.txt` 补齐镜像目录；发布不含 ModSecurity 模块时加 `--no-modsecurity`。 |
| `edgeweir-openresty comes as .deb and .rpm only` | tar.gz 安装，主机没有 `dpkg` 与 `rpm`，也没有安装 `edgeweir-openresty` | 改用有 deb 或 rpm 包管理的主机。 |
| `cosign signature verification FAILED`、`SHA-256 verification FAILED` | 下载内容与签名或校验和不符 | 检查下载源与镜像目录内容；不跳过校验。 |
| `CA pin mismatch`、`does not present the console's node CA` | 8443 被代理或 CDN 终结 TLS，或 `--server` 指向其他服务 | 直连或 [四层透传](networking.md#节点通道四层透传)。 |
| `cannot reach the node channel` | `--server` 的地址或域名解析错误，防火墙或安全组未放行该端口，或控制台的 `EDGEWEIR_NODE_API_URL` 是本机或内网地址 | 核对地址与解析，放行端口；在节点上执行 `curl -k https://<地址>:8443/` 应返回 404。 |
| `console rejected the enrollment token (expired or already used)` | token 已过期或已使用 | 重新生成安装命令。 |
| `node is already enrolled (use --force to replace the identity)` | 主机已有节点身份（`/var/lib/edgeweir-node/identity.json`） | 保留现有注册；替换身份时先停止节点（`systemctl stop edgeweir-node`，运行中的节点会拒绝），用新 token 执行 `edgeweir-node enroll --force` 后再启动，参数见 [edgeweir-node](https://github.com/marvinli001/edgeweir-node)。 |
| `x509: certificate is valid for ..., not ...` | 节点连接的名称不在节点通道证书中 | 将该名称加入 `EDGEWEIR_NODE_API_HOSTNAMES`，重启控制台，见 [节点通道地址与证书](networking.md#节点通道地址与证书)。 |
| 注册超时，或节点一直离线 | 防火墙或安全组未放行 8443；`EDGEWEIR_NODE_API_URL` 解析错误 | 放行 8443；核对域名解析。 |
| L4 应用的端口连接超时 | 节点防火墙或安全组未放行端口池；容器节点未发布端口 | 按 [端口与防火墙](#端口与防火墙) 放行或发布端口。 |
| `probe is not enrolled: the first run needs --server, --ca-sha256 and a probe token` | 探针首次启动缺少注册参数（退出码 2） | 设置 `EDGEWEIR_SERVER`、`EDGEWEIR_CA_SHA256` 与 `EDGEWEIR_TOKEN` 后重新启动。 |
| `probe enrollment failed: console rejected the enrollment token (expired or already used)` | 探针令牌已过期或已使用 | 重新「添加探针」生成令牌。 |
| 探针容器显示 `unhealthy` | 镜像健康检查查询数据面 | 关闭容器健康检查，见[容器](#容器)。 |

