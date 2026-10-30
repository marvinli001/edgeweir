# 接入节点

经 SSH 由控制台安装，或生成安装命令在 Linux 主机上安装并注册边缘节点；节点端口与防火墙；运行区域探针。

## 要求

| 项目 | 要求 |
| --- | --- |
| 系统 | Linux，amd64 或 arm64，glibc 2.34 及以上：RHEL、Rocky、AlmaLinux 9 及以上，Debian 12 及以上，Ubuntu 22.04 及以上；systemd（`--no-start` 时不要求） |
| 权限 | root 或 sudo |
| 命令 | `curl`、`sha256sum`、`tar` |
| 访问控制台 | `EDGEWEIR_PUBLIC_URL`（`/install.sh`、`/downloads/*`）与节点通道地址（**系统设置** 的「节点通道」，默认 8443），见 [端口与反向代理](networking.md) |
| 访问外部 | GitHub Releases 与 `api.github.com`（未使用 `--mirror-only` 时） |

节点使用为 Edgeweir 构建的 OpenResty，与 edgeweir-node 一起发布，列在同一个已签名的 `checksums.txt` 中：

| 软件包 | 内容 | 安装 |
| --- | --- | --- |
| `edgeweir-openresty` | OpenResty 1.31.1.1，含 HTTP/2、HTTP/3、Brotli、Zstandard；`/usr/lib/edgeweir-openresty/`（nginx 为 `/usr/lib/edgeweir-openresty/nginx/sbin/nginx`） | `edgeweir-node` 依赖它，始终安装 |
| `edgeweir-openresty-modsecurity` | ModSecurity 动态模块 `/usr/lib/edgeweir-openresty/modules/ngx_http_modsecurity_module.so` 与 OWASP CRS 规则 `/usr/share/edgeweir-openresty/crs/` | `edgeweir-node` 推荐安装；`install.sh` 默认安装，`--no-modsecurity` 跳过，此时节点不支持 [OWASP CRS](../guide/waf.md) |

两个软件包只有 deb 与 rpm 格式（amd64、arm64）。不再使用 openresty.org 的软件源；早先由 `install.sh` 添加的 openresty.org 软件源与 `openresty` 软件包可以自行删除。

## 1. 生成安装命令

1. 打开 **集群与节点**，选择集群，点击 **添加节点**，切换到 **手动命令**（默认页签是 [SSH 安装](#ssh-安装)）。对话框立即显示 **安装命令**：集群的默认节点组，有效期 1 小时，不带节点名称。
2. 需要节点名称、其他节点组或有效期时，打开 **选项**：填写 **节点名称**，选择 **节点组**（集群有多个节点组时显示）与 **有效期**（15 分钟、1 小时、24 小时），点击 **重新生成**。
3. 复制 **安装命令**。命令下方显示剩余时间、「仅显示一次」、地址提醒与 [节点通道连接检查](#节点通道连接检查)；关闭对话框后不再显示，再次打开生成新的 token。
4. 在节点上执行命令后，对话框的 **注册进度** 每 3 秒刷新：等待节点注册（或令牌已过期）、已注册（节点名称链接到节点详情）、在线、配置已应用、数据面正常、有可供 DNS 使用的地址。

| 项目 | 行为 |
| --- | --- |
| 注册 token | `ewt_` 前缀，单次有效，数据库只存 SHA-256；生成操作写入审计日志。 |
| `--server` | **系统设置** 中的「节点通道」地址，见 [节点通道地址与证书](networking.md#节点通道地址与证书)。 |
| `--ca-sha256` | 节点通道内部 CA 的 SHA-256 指纹，与 **系统设置** 中的「CA 指纹」相同。 |
| API | `POST /api/v1/enrollment-tokens`，`ttlMinutes` 取值 5–10080，默认 60；`GET /api/v1/enrollment-tokens/{id}` 返回 `usedAt` 与注册的节点。见 [API 与端点](../reference/api.md)。 |
| 地址提醒 | 控制台地址（`install.sh` 从此下载）或节点通道地址是 localhost、回环或内网地址时，对话框逐条提醒，**系统设置** 中的地址旁显示「仅本机可达」或「内网地址」；控制台地址是公网 HTTP 地址时提醒「控制台地址未加密，install.sh 将以明文传输」，**系统设置** 中标「未加密」。控制台启动时为每条提醒写一条警告日志；不阻止生成。 |
| 清理 | 过期或使用超过 7 天的 token 每 30 分钟删除一次。 |

### 节点通道连接检查

控制台用节点通道地址与自己的节点通道做一次 TLS 握手（不带客户端证书，不发送请求），比较对方出示的证书链与节点通道内部 CA；`wss://`、`ws://` 地址先在 `/node-channel` 完成 WebSocket 握手，再在其中做这次 TLS 握手。结果在 **系统设置** 的「节点通道」卡片中显示在地址下方；在添加节点对话框中显示为一行，检查未通过时带「修改」链接，打开 **系统设置**。

| 结果（系统设置 / 添加节点对话框） | 含义 |
| --- | --- |
| 连接正常 / 节点通道连接正常 | 握手成功，证书链含节点通道内部 CA |
| 控制台无法连接该地址 / 控制台无法连接节点通道地址 | 3 秒内没有完成握手：地址或解析错误，端口未放行，或控制台所在网络到不了该地址 |
| 证书不符，前面可能有代理或 CDN / 节点通道证书不符，前面可能有代理或 CDN | 出示了其他证书链：代理或 CDN 终结了 TLS，或地址指向其他服务，节点 mTLS 会失败，见 [节点通道四层透传](networking.md#节点通道四层透传)；`wss://`、`ws://` 地址的 WebSocket 握手被拒绝（入口未开放或地址指向其他服务）也是此结果，见 [节点通道的 WebSocket 入口](networking.md#节点通道的-websocket-入口) |
| 出站策略不允许连接该地址 / 出站策略不允许连接节点通道地址 | **系统设置** 中保存的地址解析到内网、回环等特殊用途地址，`EDGEWEIR_OUTBOUND_ALLOW_CIDRS` 未放行：控制台不连接，与其他在 Web 界面保存的目标相同。`EDGEWEIR_NODE_API_URL` 与默认地址不受此限制 |

检查只作提示，不阻止任何操作：控制台能连上自己的地址，不代表其他网络的节点也能连上；控制台所在网络不支持访问自己的公网地址（NAT 回流）时，结果为无法连接，节点仍可能正常注册。结果缓存 30 秒，地址改变后重新检查。API：`GET /api/v1/settings/node-channel-check`，返回 `{ url, result, checkedAt }`，`result` 为 `ok`、`unreachable`、`mismatch` 或 `refused`。

## 2. 执行安装命令

在节点主机（不是控制台主机）上以具备 sudo 权限的账户执行生成的命令：

```bash title="节点"
export EDGEWEIR_TOKEN='<一次性 token>'
curl -fsSL https://cdn-admin.example.com/install.sh | sudo --preserve-env=EDGEWEIR_TOKEN bash -s -- \
  --server https://cdn-admin.example.com:8443 --ca-sha256 <CA 指纹>
```

token 只经 `EDGEWEIR_TOKEN` 环境变量或 `--token-file PATH` 传递，不出现在进程参数中；`--token` 参数被拒绝。全部选项见 [命令行](../reference/cli.md)。

## 3. 验证

`install.sh` 最后等待 `edgeweir-node healthcheck` 通过（[install.sh 流程](#installsh-流程) 第 11 步），输出 `done: edgeweir-node is healthy (revision N, M sites)`。之后：

```bash title="节点"
systemctl status edgeweir-node
journalctl -u edgeweir-node -f
```

预期：`edgeweir-node.service` 为 `active (running)`；**集群与节点** 中该节点状态为「在线」，**已应用版本** 显示配置版本号。节点注册后、首次连接节点通道前状态为「等待心跳」；在线但尚未应用配置时 **已应用版本** 标「待应用配置」。

## SSH 安装

不登录节点主机也能添加节点：控制台用 SSH 连接一次，运行与 [安装命令](#2-执行安装命令) 相同的 `install.sh`（同样的签名校验与选项），再断开；之后的一切仍经节点通道。

1. **添加节点** 对话框默认是 **SSH 安装**（另一个页签是 **手动命令**，上次的选择会记住）。
2. **单台**：填写 **主机**、**端口**（默认 22）、**用户**（默认 root）。**批量**：在 **主机列表** 每行填一台 `主机[:端口] [用户] [节点名称]`（IPv6 写成 `[2001:db8::1]:22`），或 CSV `主机,端口,用户,节点名称`（可带表头，空字段取默认值），`#` 开头的行忽略；一次最多 200 台，全部主机共用一份凭据，行内的用户优先。
3. **认证**：**密码**，或 **私钥**（OpenSSH、PEM 或 PPK，加密的私钥填 **私钥口令**）。用户不是 root 时：填 **sudo 密码** 用 `sudo -S`；不填时要求免密 sudo（`sudo -n`）。
4. **选项**：节点名称、预期的 **主机指纹**（单台）、节点组、**版本**（默认最新）、**包格式**、**下载镜像**、**只用镜像**、**安装 ModSecurity**、**并发**（批量，默认 5，最大 20）、**单台超时**（默认 15 分钟，1–60）。
5. 点击 **读取主机指纹**：控制台只完成 SSH 握手、读取主机密钥后断开，不登录。逐台核对表中的 `SHA256:…` 指纹与主机上 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` 的输出；填了预期指纹而不符的主机标「与填写的指纹不符」，不会安装。
6. 点击 **安装 N 台**：每台主机依次显示排队、连接中、安装中（及当前步骤：检查、下载、校验、安装软件包、注册、启动、健康检查）、已注册或失败原因；点击主机看输出的最后几十行。单台安装成功后显示与手动命令相同的 **注册进度**。可以 **停止**、**重试** 失败的主机（使用表单里仍保留的凭据）、**复制结果**（制表符分隔：主机、端口、用户、状态、原因、节点 id）。

| 项目 | 行为 |
| --- | --- |
| 主机指纹 | 控制台按 ssh2 的算法顺序协商（ssh-ed25519 优先）。安装时只接受确认过的指纹，其他密钥在登录前断开（`host_key_mismatch`），不发送任何凭据 |
| 注册 token | 每台主机、每次尝试单独生成一个一次性 token（有效期为单台超时加 5 分钟），失败、停止或超时后立即作废 |
| 远端执行 | 登录 shell 执行一段固定的 `sh` 脚本：token 是标准输入第一行，sudo 密码是第二行；`install.sh` 先以登录用户下载到 `mktemp -d` 的临时目录，再以 root 运行，其标准输入为 `/dev/null`；token 写进该目录里仅本人可读的文件，以 `--token-file` 交给 `install.sh`（不经环境变量：sudo 会把保留的环境变量连同值写进日志），结束时删除临时目录。命令行、环境与 sudo 日志里只有地址、选项与 token 文件路径 |
| 凭据 | 只在该次安装期间留在控制台进程内存里，安装结束（全部主机结束或停止）即丢弃；控制台绝不保存 SSH 凭据，不写入数据库、日志、任务队列、审计或错误信息。重试需要再次提交凭据 |
| 输出 | 每台最多保留最后 64 行、16 KiB，先删去密码、口令、token 与私钥块 |
| 任务状态 | 只在控制台进程内存里：结束后保留 1 小时，控制台重启后丢失（界面提示到节点列表核对）。最多 4 个任务同时进行 |
| 出站策略 | 主机解析一次后按地址连接；解析到内网、回环等特殊用途地址时需要 `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` 放行，否则为「出站策略不允许连接该地址」 |
| 审计 | `ssh_install.start`（集群、任务 id、主机数）、每台主机一条 `ssh_install.host`（主机、端口、用户、主机指纹、结果、节点 id、token id）、`ssh_install.cancel` |
| 网络 | 控制台要能连上主机的 SSH 端口；主机要能访问控制台地址（`install.sh`）与节点通道地址，与手动命令相同 |

失败原因：

| 原因 | 含义 |
| --- | --- |
| 主机指纹不符 | 主机出示的密钥不是确认过的，可能被中间人拦截或主机已重装 |
| 无法连接 / 超时 | 地址、端口或防火墙；或单台超时用完 |
| 认证失败 | 用户、密码或私钥不对 |
| 需要 sudo 密码 / sudo 密码错误 / 没有 sudo 权限 | 非 root 用户的 sudo |
| sudo 要求终端（requiretty） | sudoers 设置了 `requiretty`，SSH 安装不支持，改用手动命令或去掉该设置 |
| 下载 install.sh 失败 | 主机访问不到控制台地址 |
| 系统不受支持 | 不是 Linux、没有 systemd、架构或 glibc 不支持（退出码 21） |
| 主机连不上节点通道 | 节点通道地址不通、CA 指纹不符或 WebSocket 入口未开放（22，或注册时的 `unreachable`、`ca_mismatch`） |
| 签名或校验和不符 | cosign 签名或 SHA-256 校验失败（24） |
| 令牌被拒绝 | 控制台拒绝了本次的 token（26，节点的 `token_rejected`） |
| 已注册到其他控制台或集群 | 主机的身份固定在另一个控制台的 CA 上（26，节点的 `enrolled_elsewhere`），或注册结果是本控制台另一个集群的节点 |
| 主机上另有安装在进行 | 另一个 `install.sh` 或 `edgeweir-node enroll` 正在运行（29，或节点的 `busy`）；稍后重试 |
| 服务启动失败 / 已启动，健康检查未通过 | 第 10 步（27）或第 11 步（28），查看该主机的输出与 `journalctl -u edgeweir-node -n 50` |
| install.sh 失败 | 其他失败，查看该主机的输出 |
| 未注册（主机已注册，但不是本控制台的节点） | `install.sh` 正常结束，既没有使用 token，也没有报告本控制台的节点：主机上的 edgeweir-node 早于 1.7.0、身份属于别处（要重新注册用手动命令加 `--force`） |

重试与再次运行不会产生第二个节点：每次尝试用新的一次性 token；已注册的主机（edgeweir-node 1.7.0 起）经 `edgeweir-node enroll --if-not-enrolled` 报告原来的节点；SSH 断线时节点已经注册的，同一私钥再次注册得到同一个节点（[按密钥幂等](#重新注册与节点身份)）。

API（`/api/v1`，AccessKey 须有写权限；服务账号不能调用；只读 AccessKey 只能查询）：

| 请求 | 说明 |
| --- | --- |
| `POST /ssh-installs/host-keys` | `{ hosts: [{ host, port }] }`，返回每台的 `algorithm`、`fingerprint` 或 `error`（`unreachable`、`timeout`、`not_ssh`、`outbound_refused`） |
| `POST /ssh-installs` | `{ clusterId, nodeGroupId?, credential: { username, password?, privateKey?, passphrase?, sudoPassword? }, hosts: [{ host, port, username?, nodeName?, hostKeyFingerprint }], options: { version, format, mirror, mirrorOnly, modsecurity, noStart }, concurrency, timeoutMinutes }`，返回任务 |
| `GET /ssh-installs/{id}` | 任务与每台主机的 `state`、`step`（安装中的当前步骤：`check`、`download`、`verify`、`install`、`enroll`、`start`、`health`，其他时候为 `null`）、`error`、`exitCode`、`tokenId`、`nodeId`、`output`；任务不存在（过期或控制台重启）为 404 `SSH_INSTALL_NOT_FOUND` |
| `POST /ssh-installs/{id}/cancel` | 停止 |
| `POST /ssh-installs/{id}/retry` | `{ credential, hosts?: [{ id, hostKeyFingerprint? }] }`，默认重试全部失败与已停止的主机；任务仍在进行时 409 `SSH_INSTALL_BUSY` |

`POST /ssh-installs` 与 `/retry` 不接受 `Idempotency-Key`（请求体带凭据，见 [API 与端点](../reference/api.md)）。

## install.sh 流程

| 步骤 | 行为 | 失败时 |
| --- | --- | --- |
| 1 | 读取 token（`EDGEWEIR_TOKEN` 或 `--token-file`），校验 `ewt_` 格式，从环境中移除，子进程不继承。状态目录已有 `identity.json`（已注册）时不需要 token，给出也不使用；加 `--force` 时仍需要 token | 退出 |
| 2 | 检查 Linux、root、`curl`、`sha256sum`、`tar`、systemd、架构；`--format auto` 时有 `dpkg` 与 `apt-get` 选 deb，有 `rpm` 与 `dnf`/`yum` 选 rpm，否则 tar.gz。未注册时再检查节点通道：`--server` 须有 HTTP 响应（任意状态码，不发送 token）；主机有 `openssl` 时，服务器出示的最后一张证书须为 `--ca-sha256` 固定的 CA。`wss://`、`ws://` 地址改为请求 `https://`（`ws://` 为 `http://`）`<主机[:端口]>/node-channel`，须返回 426（入口开放）；CA 在第 9 步注册时于 WebSocket 内核对 | 退出，指出无法连接、前面有终结 TLS 的代理，或 WebSocket 入口未开放 |
| 3 | 解析版本：`--version`，或下载镜像的 `latest` 文件，再回退到 GitHub 最新发布。已注册的主机未给 `--version` 与 `--force` 时跳过第 3–9 步，不下载、不安装。经 `wss://`、`ws://` 地址注册时版本须为 0.2.0 及以上 | 退出，提示传入 `--version` |
| 4 | 下载 `checksums.txt` 与 `checksums.txt.sigstore.json`：先下载镜像，后 GitHub | 退出 |
| 5 | `cosign verify-blob` 校验签名：证书身份必须为 `https://github.com/marvinli001/edgeweir-node/.github/workflows/release.yml@refs/tags/v<版本>`，签发者 `https://token.actions.githubusercontent.com`。主机无 cosign 时下载 cosign v3.1.3，核对脚本内固定的 SHA-256 后安装到 `/usr/local/bin/cosign` | 退出 |
| 6 | 从已签名的 `checksums.txt` 选出本机的安装包，以及同一发布的 `edgeweir-openresty`、`edgeweir-openresty-modsecurity`（每个软件包、格式、架构恰好一个文件）；glibc 低于 2.34 时退出；下载（先镜像，后 GitHub）并校验 SHA-256 | 退出 |
| 7 | 先安装 `edgeweir-openresty` 与 `edgeweir-openresty-modsecurity`。tar.gz 安装时按主机的 `dpkg` 或 `rpm` 选择格式；两者都没有时要求已安装 `edgeweir-openresty` | 退出 |
| 8 | 安装 deb、rpm 或 tar.gz | 退出 |
| 9 | `edgeweir-node enroll`：核对 CA 指纹后提交 token，本机生成私钥，以 CSR 换取节点证书；此后仅经 mTLS 通信。已注册时跳过；加 `--force` 时先停止 `edgeweir-node.service`，以新 token 执行 `edgeweir-node enroll --force` 替换身份，第 10 步再启动 | 退出 |
| 10 | 停用 `openresty.service`，启用并启动 `edgeweir-node.service`（`--no-start` 时跳过第 10、11 步）；tar.gz 安装与跳过安装的重新运行先重启运行中的服务（deb、rpm 由包脚本重启） | 退出 |
| 11 | 每 3 秒执行一次 `edgeweir-node healthcheck`，最多 90 秒，直到数据面已应用配置；通过时输出 `done: edgeweir-node is healthy (revision N, M sites)` | 退出码 28，提示 `journalctl -u edgeweir-node -n 50` |

- 第 5、6 步通过前不执行任何下载的程序。`--allow-unsigned` 跳过第 5 步，仅用于开发，仍校验 SHA-256。
- 脚本全部由函数组成，最后一行才调用 `main`：下载中断时不执行任何内容。
- 已注册的主机可以重新运行同一命令：不下载、不重装，启动服务（运行中则重启）并做健康检查；加 `--version <版本>` 时先安装该版本。主机上没有 `/usr/bin/edgeweir-node` 时安装最新版本。edgeweir-node 1.7.0 起先执行 `edgeweir-node enroll --if-not-enrolled` 核对身份：属于本控制台时报告原来的节点，属于另一个控制台时以退出码 26 失败，不重启服务。
- 重新注册（例如证书已过期）：在控制台生成新的安装命令，在命令末尾加 `--force` 执行；之后删除控制台中原来的节点。
- 节点通道地址改变后，节点 v1.2.0 起自动跟随新地址；旧地址已下线、节点失联时，在节点上执行 `sudo edgeweir-node set-server --server <新地址>`，不必重新注册，见 [更换节点通道地址](networking.md#更换节点通道地址)。
- 控制台不保存 SSH 凭据（[SSH 安装](#ssh-安装) 只在该次安装期间用于内存中）；节点私钥不离开节点。

### 结果行与退出码

`install.sh` 的说明文字在 stderr；stdout 每步一行 `EDGEWEIR_RESULT {"v":1,"step":"…","status":"…"}`（JSON 在同一行，未知字段忽略），供 SSH 安装等自动化读取。步骤为 `args`、`check`、`download`、`verify`、`install`、`enroll`、`start`、`health`；`status` 为 `ok`、`skipped` 或 `failed`（失败行带英文 `message`），注册一步由 edgeweir-node 1.7.0 起自己写（`enrolled`、`already_enrolled`、`token_rejected`、`enrolled_elsewhere` …，带 `node_id`）。最后一行为 `{"step":"done","status":"ok|failed","failed_step":"…","exit":N}`。

| 退出码 | 含义 |
| --- | --- |
| 0 | 完成 |
| 1 | 其他错误 |
| 20 | 参数错误 |
| 21 | 系统不受支持（不是 Linux 或 root、缺少命令、架构、glibc） |
| 22 | 节点通道不通、CA 指纹不符或 WebSocket 入口未开放 |
| 23 | 下载失败 |
| 24 | 签名或 SHA-256 校验失败 |
| 25 | 安装软件包失败 |
| 26 | 注册失败（原因见注册结果行），或已注册到另一个控制台 |
| 27 | 服务启动失败 |
| 28 | 健康检查超时 |
| 29 | 主机上另有安装在运行（`/run/edgeweir-install.lock`） |

## 重新注册与节点身份

控制台按节点证书的公钥识别节点：同一私钥再次注册（例如注册成功但应答丢失后重试）得到同一个节点与新证书，不会产生第二个节点。token 须是该节点当初用掉的，或同一集群（及节点组）未用的新 token；其他集群的 token 被拒绝。edgeweir-node 1.7.0 起在注册成功前保留待用私钥，重试时自动沿用。

节点报告主机的 machine-id 摘要；新注册的节点与已有节点在同一台机器上（重装了状态目录，或复制了镜像）时，审计 `node.enroll` 记下 `sameMachineAs`，控制台日志给出警告。这只是提示，不会合并节点。

## 退役节点

不登录主机就让节点停止服务（edgeweir-node 1.7.0 起，能力 `decommission-v1`）：在 **集群与节点** 的节点菜单或节点详情点击 **退役** 并确认。节点收到任务后停止 OpenResty，删除身份、最后可用配置与缓存，留下标记使服务（重启主机后也）不再提供服务，直到重新注册；控制台随后吊销其证书并删除节点（审计 `node.delete`，`decommissioned: true`）。

- 节点离线时请求保留，上线后执行；完成前可以 **撤回**。
- 节点报告失败时请求清除，详情显示「上次退役失败」与原因，可以再次退役。
- 软件包仍留在主机上，卸载需要 root：`apt-get remove edgeweir-node edgeweir-openresty edgeweir-openresty-modsecurity`（rpm 用 `dnf remove`）。
- 没有该能力的节点不显示 **退役**，用 **删除** 并在主机上停止服务。

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
| 443/TCP | HTTPS | 集群中有选择了证书的网站绑定 443 |
| 443/UDP | HTTP/3 | 绑定 443 的网站开启 HTTP/3，见 [监听端口](../guide/https.md#监听端口) |
| 集群的附加 HTTP / HTTPS 端口（TCP） | HTTP、HTTPS | 集群「设置」页签设置了这些端口，见 [集群的监听端口](../guide/https.md#集群的监听端口) |
| 附加 HTTPS 端口的同号 UDP | HTTP/3 | 绑定该端口的网站开启 HTTP/3 |
| 集群的端口池 | [L4 转发](../guide/l4.md) | TCP 端口池放行 TCP，UDP 端口池放行 UDP，TCP + UDP 两者都放行；也可以只放行已有 L4 应用使用的端口 |

| 项目 | 说明 |
| --- | --- |
| 权限 | 端口池只含 1024–65535，systemd 单元与镜像不需要额外权限 |
| 容器节点 | 发布端口池中的端口，例如 `-p 9000:9000 -p 9000:9000/udp`，区间写成 `-p 20000-20100:20000-20100`；端口池较大时使用 host 网络（`--network host`） |
| 端口变化 | 新建、删除 L4 应用或修改其端口，增删集群的附加监听端口时节点 reload，已有连接由旧 worker 继续服务，见 [reload 与长连接](../guide/l4.md#reload-与长连接) |
| 1024 以下的附加端口 | 与 80、443 相同由 nginx 主进程绑定，不需要额外权限 |
| 端口段 | 每个端口占一个监听 socket；UDP 端口段每个 worker 各占一个（`reuseport`）。节点按监听 socket 数提高 `worker_connections`，并把自身的打开文件数软限制提到硬限制 |

## 访客 IP

集群「设置」页签的「访客 IP」决定节点 HTTP / HTTPS 监听的访客地址：规则的 `ip.src`、封禁、CC、访问日志、错误页的 `{{client_ip}}`、维护模式的放行地址、PURGE 按访客地址的限频与回源的 `X-Real-IP` 都使用它。修改后发布配置版本，节点 reload。

| 来源 | 行为 | 适用 |
| --- | --- | --- |
| 直连（默认） | TCP 对端 | 访客直接连接节点 |
| PROXY protocol | 每个 TCP 连接必须以 PROXY protocol v1 或 v2 头开头，没有头的连接被关闭；访客地址取头中的源地址（`UNKNOWN` 时为 TCP 对端）。HTTP/3（QUIC）不经过 PROXY protocol，取 UDP 对端 | 节点前有发送 PROXY protocol 的四层负载均衡 |
| 可信代理报头 | 对端在「可信 CIDR」（1–64 条）内时读「报头」（`X-Forwarded-For`、`X-Real-IP`、`CF-Connecting-IP`、`True-Client-IP` 或自定义名），否则用对端地址。`X-Forwarded-For` 从右向左跳过可信地址，取第一个不可信地址 | 节点前有七层代理或另一个 CDN |

| 项目 | 说明 |
| --- | --- |
| 回源报头 | `X-Real-IP` 为访客地址；`X-Forwarded-For` 为收到的 `X-Forwarded-For` 后追加直连对端（PROXY protocol 时是负载均衡器）。直连模式可打开「丢弃访客自带的 X-Forwarded-For」，回源只带直连对端 |
| `ip.peer` | 规则字段 `ip.peer` 始终是直连对端 |
| 可信代理 | 可信 CIDR 内的地址永不封禁，也不计入 CC 单 IP 计数 |
| 报头格式 | 由 nginx realip 模块解析：值不是合法地址时用对端地址；`地址:端口` 取地址；`X-Real-IP` 等单值报头含逗号时取最后一项；`X-Forwarded-For` 中可信地址之前出现非法项时，取最后一个合法的可信地址；全部为可信地址时取最左一项 |
| 内核封禁 | 只匹配 TCP 对端，后两种模式下对访客地址不生效，见 [节点前的负载均衡](../guide/bans.md#节点前的负载均衡) |
| 探针 | 区域探针对要求 PROXY 头的监听先发送 PROXY v1 头 |
| 节点能力 | PROXY protocol、可信代理报头与「丢弃访客自带的 X-Forwarded-For」需要 `client-ip-v1`；集群有活动节点缺少它时卡片显示「集群中有节点不支持」 |
| 审计 | `cluster.client_ip_update` |

> [!WARNING]
> PROXY protocol 模式下，能直接连到节点端口的客户端可以在头中声明任意地址；只对负载均衡器开放节点的 HTTP / HTTPS 端口。可信 CIDR 只写代理实际使用的地址：列表中的地址可以为任意访客声明地址。

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

区域探针从所在区域探测各节点的调度地址，结果驱动备用 IP 与智能调度，见[区域探针与智能调度](../guide/scheduling.md)。探针是 `edgeweir-node` 的 `probe` 模式：不运行 OpenResty，不监听端口，身份与节点分开。注册令牌在 **系统设置** →「监控」→「添加探针」生成，只显示一次。

| 项目 | 要求 |
| --- | --- |
| 运行方式 | 节点镜像（Docker，amd64 / arm64），或 Linux amd64 / arm64 上的 systemd 单元与二进制 |
| 出站 | 节点通道地址（默认 8443），以及各节点调度地址上的监听端口 |
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
| 节点通道地址改变 | 探针 v1.2.0 起每轮获取目标时取得新地址，检查通过后切换并写入 `probe.json`；失联时执行 `edgeweir-node set-server --probe --server <新地址>`，见 [更换节点通道地址](networking.md#更换节点通道地址) |
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
      edgeweir-openresty_1.31.1.1-3_amd64.deb
      edgeweir-openresty-1.31.1.1-3.x86_64.rpm
      edgeweir-openresty-modsecurity_1.31.1.1-3_amd64.deb
      edgeweir-openresty-modsecurity-1.31.1.1-3.x86_64.rpm
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

节点的警告、错误与关键事件也在节点详情的「日志」页签，见[节点日志](../guide/node-logs.md)。

在节点上执行 `sudo edgeweir-node diagnose`（v1.5.0 起）逐项检查身份、节点证书、控制台连通性、与控制台的时钟偏差、运行中的 agent、配置与数据面，每项一行（`ok`、`warn`、`fail`、`skip`），有 `fail` 时退出码 1；`--json` 输出完整结果。需要分析 agent 本身时，`sudo edgeweir-node pprof heap --output heap.pb.gz`（或 `profile`、`goroutine` 等）从本机诊断 socket 取 Go profile。

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 节点详情的「时钟偏差」标「偏差过大」，或收到「节点时钟偏差过大」告警 | 节点主机没有时间同步，时钟比控制台快或慢超过告警规则的秒数 | 在节点上开启 NTP（如 `timedatectl set-ntp true`，或 chrony），之后的心跳会更新偏差。 |
| `no enrollment token` | `sudo` 未保留 `EDGEWEIR_TOKEN` | 原样执行生成的命令：`export` 与 `sudo --preserve-env=EDGEWEIR_TOKEN`。 |
| `the enrollment token is malformed (expected ewt_...)` | token 复制不完整 | 重新复制安装命令。 |
| `systemd is required` | 主机无 systemd | 使用 systemd 主机，或加 `--no-start` 只安装与注册。 |
| `could not determine the latest edgeweir-node version; pass --version` | 下载镜像无 `latest`，且 GitHub 不可达或无发布 | 加 `--version`，或配置下载镜像。 |
| `edgeweir-openresty needs glibc 2.34 or later` | 发行版过旧 | 使用 RHEL、Rocky、AlmaLinux 9，Debian 12，Ubuntu 22.04 或更新的系统。 |
| `checksums.txt does not list exactly one ... package of edgeweir-openresty...` | 镜像或发布缺少该软件包，或同一架构有多个版本 | 按 `checksums.txt` 补齐镜像目录；发布不含 ModSecurity 模块时加 `--no-modsecurity`。 |
| `edgeweir-openresty comes as .deb and .rpm only` | tar.gz 安装，主机没有 `dpkg` 与 `rpm`，也没有安装 `edgeweir-openresty` | 改用有 deb 或 rpm 包管理的主机。 |
| `cosign signature verification FAILED`、`SHA-256 verification FAILED` | 下载内容与签名或校验和不符 | 检查下载源与镜像目录内容；不跳过校验。 |
| `CA pin mismatch`、`does not present the console's node CA` | 8443 被代理或 CDN 终结 TLS（包括开启了代理的 Cloudflare 记录），或 `--server` 指向其他服务 | 直连或 [四层透传](networking.md#节点通道四层透传)；Cloudflare 记录改为仅 DNS。 |
| `cannot reach the node channel` | `--server` 的地址或域名解析错误，防火墙或安全组未放行该端口，或节点通道地址是本机或内网地址 | 核对地址与解析，放行端口；在节点上执行 `curl -k https://<地址>:8443/` 应返回 404。地址错误时在 **系统设置** 的「节点通道」修改，再生成新的安装命令。 |
| `console rejected the enrollment token (expired or already used)` | token 已过期或已使用 | 重新生成安装命令。 |
| `edgeweir-node is installed but not healthy after 90s` | 节点 90 秒内未应用配置：连不上节点通道、证书被拒绝，或 OpenResty 未能启动 | 查看 `journalctl -u edgeweir-node -n 50`；处理后重新运行同一命令（只重启服务并检查）。 |
| `node is already enrolled (use --force to replace the identity)` | 主机已有节点身份（`/var/lib/edgeweir-node/identity.json`） | 保留现有注册；替换身份时用新的安装命令加 `--force` 执行 `install.sh`，或先停止节点（`systemctl stop edgeweir-node`，运行中的节点会拒绝），用新 token 执行 `edgeweir-node enroll --force` 后再启动，参数见 [edgeweir-node](https://github.com/marvinli001/edgeweir-node)。 |
| 节点日志 `client certificate expired at ...`，控制台节点标 **证书已过期** | 节点离线超过证书剩余有效期，未能续期；节点通道拒绝并说明 `client certificate has expired (CERT_HAS_EXPIRED)` | 生成新的安装命令，在节点上以 `--force` 执行新的安装命令（或 `systemctl stop edgeweir-node`，用新 token 执行 `edgeweir-node enroll --force` 后启动）；删除控制台中原来的节点。 |
| `x509: certificate is valid for ..., not ...` | 节点连接的名称不在节点通道证书中：注册时的地址来自已经改掉的 `EDGEWEIR_NODE_API_URL` | 将该名称加入 `EDGEWEIR_NODE_API_HOSTNAMES`，重启控制台，见 [节点通道地址与证书](networking.md#节点通道地址与证书)。 |
| 注册超时，或节点一直离线 | 防火墙或安全组未放行 8443；节点通道地址解析错误 | 放行 8443；核对域名解析。 |
| 修改节点通道地址后，已注册的节点离线 | v1.2.0 以前的节点一直使用注册时的地址；或旧地址在节点切换前就已下线 | 恢复原地址（端点、DNS 记录或端口转发），等节点切换（先升级 v1.2.0 以前的节点）；已失联的 v1.2.0 及以上节点执行 `sudo edgeweir-node set-server --server <新地址>`；更早的节点以 `--force` 执行新的安装命令重新注册，再删除控制台中原来的节点。 |
| 节点标「无法切换」 | 节点检查新地址失败，原因在悬停提示与节点详情中：无法连接、该地址没有 WebSocket 入口、证书不是本控制台签发的（前面有代理或 CDN 终结了 TLS）等 | 从节点所在网络确认新地址可达且为四层透传；修正后节点在下一次重试（至多 60 分钟）时切换，重启节点服务会立即重试。 |
| 节点一直显示「等待心跳」 | 已注册，但 agent 还没有经 mTLS 连上节点通道：服务未启动（如 `--no-start`），或连接失败 | 在节点上执行 `systemctl status edgeweir-node` 与 `journalctl -u edgeweir-node -n 50`。 |
| 连接检查显示「证书不符，前面可能有代理或 CDN」 | 节点通道地址指向终结 TLS 的代理、CDN 或其他服务 | 直连或 [四层透传](networking.md#节点通道四层透传)，或在 **系统设置** 改为直连的地址。 |
| L4 应用的端口连接超时 | 节点防火墙或安全组未放行端口池；容器节点未发布端口 | 按 [端口与防火墙](#端口与防火墙) 放行或发布端口。 |
| `probe is not enrolled: the first run needs --server, --ca-sha256 and a probe token` | 探针首次启动缺少注册参数（退出码 2） | 设置 `EDGEWEIR_SERVER`、`EDGEWEIR_CA_SHA256` 与 `EDGEWEIR_TOKEN` 后重新启动。 |
| `probe enrollment failed: console rejected the enrollment token (expired or already used)` | 探针令牌已过期或已使用 | 重新「添加探针」生成令牌。 |
| 探针容器显示 `unhealthy` | 镜像健康检查查询数据面 | 关闭容器健康检查，见[容器](#容器)。 |

