# 接入节点

为集群生成安装命令，在 Linux 主机上安装并注册边缘节点。

## 要求

| 项目 | 要求 |
| --- | --- |
| 系统 | Linux，amd64 或 arm64；systemd（`--no-start` 时不要求） |
| 权限 | root 或 sudo |
| 命令 | `curl`、`sha256sum`、`tar` |
| 访问控制台 | `EDGEWEIR_PUBLIC_URL`（`/install.sh`、`/downloads/*`）与 `EDGEWEIR_NODE_API_URL`（节点通道，默认 8443），见 [端口与反向代理](networking.md) |
| 访问外部 | GitHub Releases 与 `api.github.com`（未使用 `--mirror-only` 时）；`openresty.org`（主机未安装 OpenResty 时） |

主机未安装 OpenResty 时，`install.sh` 从 openresty.org 官方仓库安装，支持范围：

| 包管理器 | 发行版 |
| --- | --- |
| apt | Debian、Ubuntu（amd64、arm64） |
| dnf / yum | CentOS、RHEL 7 及以上；Rocky 8 及以上；Oracle Linux 7–8；Fedora 32 及以上；Amazon Linux 2、2023（2018.03 仅 amd64）；Alibaba Cloud Linux 2–3；TencentOS 2–3；CBL-Mariner 2；`ID_LIKE` 含 `rhel` 的发行版按 RHEL 处理 |

其他发行版先手动安装 OpenResty。

## 1. 生成安装命令

1. 以平台管理员登录，打开 **后台 → 集群与节点**，选择集群，点击 **添加节点**。
2. 填写 **节点名称**，选择 **节点组**（默认为集群的默认节点组）与 **有效期**（15 分钟、1 小时、24 小时，默认 1 小时）。
3. 点击 **生成安装命令**。对话框显示 **安装命令** 与 **CA 指纹**，仅显示一次。

| 项目 | 行为 |
| --- | --- |
| 注册 token | `ewt_` 前缀，单次有效，数据库只存 SHA-256；生成操作写入审计日志。 |
| `--server` | `EDGEWEIR_NODE_API_URL`。 |
| `--ca-sha256` | 节点通道内部 CA 的 SHA-256 指纹。 |
| API | `POST /api/v1/enrollment-tokens`，`ttlMinutes` 取值 5–10080，默认 60，见 [API 与端点](../reference/api.md)。 |
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

预期：`edgeweir-node.service` 为 `active (running)`；**后台 → 集群与节点** 中该节点状态为「在线」，**已应用版本** 显示配置版本号。

## install.sh 流程

| 步骤 | 行为 | 失败时 |
| --- | --- | --- |
| 1 | 读取 token（`EDGEWEIR_TOKEN` 或 `--token-file`），校验 `ewt_` 格式，从环境中移除，子进程不继承 | 退出 |
| 2 | 检查 Linux、root、`curl`、`sha256sum`、`tar`、systemd、架构；`--format auto` 时有 `dpkg` 与 `apt-get` 选 deb，有 `rpm` 与 `dnf`/`yum` 选 rpm，否则 tar.gz | 退出 |
| 3 | 解析版本：`--version`，或下载镜像的 `latest` 文件，再回退到 GitHub 最新发布 | 退出，提示传入 `--version` |
| 4 | 下载 `checksums.txt` 与 `checksums.txt.sigstore.json`：先下载镜像，后 GitHub | 退出 |
| 5 | `cosign verify-blob` 校验签名：证书身份必须为 `https://github.com/marvinli001/edgeweir-node/.github/workflows/release.yml@refs/tags/v<版本>`，签发者 `https://token.actions.githubusercontent.com`。主机无 cosign 时下载 cosign v3.1.3，核对脚本内固定的 SHA-256 后安装到 `/usr/local/bin/cosign` | 退出 |
| 6 | 从已签名的 `checksums.txt` 选出本机的安装包，下载并校验 SHA-256 | 退出 |
| 7 | 未安装 OpenResty 时从 openresty.org 安装 | 退出，提示手动安装 |
| 8 | 安装 deb、rpm 或 tar.gz | 退出 |
| 9 | `edgeweir-node enroll`：核对 CA 指纹后提交 token，本机生成私钥，以 CSR 换取节点证书；此后仅经 mTLS 通信 | 退出 |
| 10 | 停用 `openresty.service`，启用并启动 `edgeweir-node.service`（`--no-start` 时跳过） | — |

- 第 5、6 步通过前不执行任何下载的程序。`--allow-unsigned` 跳过第 5 步，仅用于开发，仍校验 SHA-256。
- 脚本全部由函数组成，最后一行才调用 `main`：下载中断时不执行任何内容。
- 控制台不保存 SSH 凭据；节点私钥不离开节点。

安装结果：

| 路径 | 内容 |
| --- | --- |
| `/usr/bin/edgeweir-node` | agent |
| `/usr/share/edgeweir-node/lua/edgeweir/` | OpenResty Lua 模块 |
| `/var/lib/edgeweir-node/` | 状态目录（`edgeweir` 用户，0700）：`node.key`、`node.crt`、`ca.crt`、`identity.json`、`config/`（最后可用配置与 `receipts.json`） |
| `/var/cache/edgeweir-node/` | 缓存目录（`edgeweir` 用户，0750） |
| `edgeweir-node.service` | deb、rpm：`/usr/lib/systemd/system/`；tar.gz：`/etc/systemd/system/` |

deb、rpm 由包脚本创建 `edgeweir` 用户与目录；tar.gz 由 `install.sh` 创建。

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

节点 agent 自升级使用的发布源在 **后台 → 系统设置 → 节点发布源** 配置，与本镜像无关，见 [节点升级](../guide/node-upgrades.md)。

## 排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `no enrollment token` | `sudo` 未保留 `EDGEWEIR_TOKEN` | 原样执行生成的命令：`export` 与 `sudo --preserve-env=EDGEWEIR_TOKEN`。 |
| `the enrollment token is malformed (expected ewt_...)` | token 复制不完整 | 重新复制安装命令。 |
| `systemd is required` | 主机无 systemd | 使用 systemd 主机，或加 `--no-start` 只安装与注册。 |
| `could not determine the latest edgeweir-node version; pass --version` | 下载镜像无 `latest`，且 GitHub 不可达或无发布 | 加 `--version`，或配置下载镜像。 |
| `openresty.org has no packages for ...` | 发行版不在 openresty.org 支持范围 | 手动安装 OpenResty 后重新执行。 |
| `cosign signature verification FAILED`、`SHA-256 verification FAILED` | 下载内容与签名或校验和不符 | 检查下载源与镜像目录内容；不跳过校验。 |
| `CA pin mismatch` | 8443 被代理或 CDN 终结 TLS，或 `--server` 指向其他服务 | 直连或 [四层透传](networking.md#节点通道四层透传)。 |
| `console rejected the enrollment token (expired or already used)` | token 已过期或已使用 | 重新生成安装命令。 |
| `node is already enrolled (use --force to replace the identity)` | 主机已有节点身份（`/var/lib/edgeweir-node/identity.json`） | 保留现有注册；替换身份时用新 token 执行 `edgeweir-node enroll --force`，参数见 [edgeweir-node](https://github.com/marvinli001/edgeweir-node)。 |
| `x509: certificate is valid for ..., not ...` | 节点连接的名称不在节点通道证书中 | 将该名称加入 `EDGEWEIR_NODE_API_HOSTNAMES`，重启控制台，见 [节点通道地址与证书](networking.md#节点通道地址与证书)。 |
| 注册超时，或节点一直离线 | 防火墙或安全组未放行 8443；`EDGEWEIR_NODE_API_URL` 解析错误 | 放行 8443；核对域名解析。 |

