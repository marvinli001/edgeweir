# 环境变量

控制台进程读取的环境变量：类型、默认值、校验规则与作用，以及 Compose 编排使用的宿主机变量。

## 读取与校验

- 进程启动时读取并校验全部变量一次。任一变量不合法时进程以退出码 1 退出，每个问题输出一行日志 `invalid configuration: <变量>: <原因>`。
- 修改后重建容器：`docker compose up -d`。`docker compose restart` 不应用新值。
- 下列变量的空值等同未设置：`EDGEWEIR_MASTER_KEY_PREVIOUS`、`BETTER_AUTH_SECRET`、`EDGEWEIR_NODE_API_URL`、`EDGEWEIR_NODE_API_WEBSOCKET`、`NODE_API_HOST`、`EDGEWEIR_NODE_RELEASE_BASE_URL`、`EDGEWEIR_E2E_TICK_SECONDS`、`EDGEWEIR_E2E_HEARTBEAT_SECONDS` 与全部 `_FILE` 变量。其余变量的空值按字面校验，例如 `ROLE=` 不合法，`EDGEWEIR_ACME_DIRECTORY=` 为空字符串。
- **默认值** 列为进程默认值。镜像或 Compose 模板设置的不同值写在 **说明** 列。
- **后备值**：**系统设置** 中保存了对应项时，以保存值为准；清空保存值后恢复使用变量。
- 模板与注释：[`.env.example`](../../.env.example)。

| 类型 | 规则 |
| --- | --- |
| 字符串 | 原样使用 |
| 整数 | 十进制，按范围校验 |
| 布尔 | `true`、`1`、`yes`、`on` 为开，`false`、`0`、`no`、`off` 为关，不区分大小写；其他值不合法 |
| 枚举 | 只接受列出的值，区分大小写 |
| 地址 URL | `<协议>://主机[:端口]`：不含路径、查询串、片段与用户名密码；末尾的 `/` 与协议默认端口被去掉；主机为未展开的平台变量（如 `${ZEABUR_WEB_DOMAIN}`）时不合法 |
| 列表 | 逗号分隔，条目两端空白被忽略 |
| 路径 | 文件或目录的路径；启动时不检查是否存在，使用时读取 |

## 必需

使用 `compose.yml` 或 `compose.baota.yml` 时，`DATABASE_URL` 由 [Compose 宿主机变量](#compose-宿主机变量) `POSTGRES_PASSWORD` 拼出。

| 变量 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `EDGEWEIR_MASTER_KEY` | Base64 | 无 | 主密钥。规范的 Base64（标准或 URL 安全字母表），解码后至少 32 字节；含空格、引号等其他字符或不足 32 字节时拒绝启动。生成：`openssl rand -base64 32`，输出原样使用（保留 `/`、`+`、`=`）。与数据库中加密数据所用的主密钥不一致时报 `EDGEWEIR_MASTER_KEY does not match this database` 并拒绝启动；此时改回原主密钥，或在轮换时把原主密钥设为 [`EDGEWEIR_MASTER_KEY_PREVIOUS`](#主密钥轮换)。用于信封加密入库的私钥、DNS API 密钥等，并派生会话密钥。丢失后已加密数据无法恢复；与数据库分开备份 |
| `EDGEWEIR_MASTER_KEY_FILE` | 路径 | 未设置 | 存放主密钥的文件（例如 Docker secret），代替 `EDGEWEIR_MASTER_KEY`，规则见[从文件读取](#从文件读取)。Compose 模板不传入，见[主密钥文件](../deploy/docker.md#主密钥文件) |
| `DATABASE_URL` | 字符串 | 无 | PostgreSQL 18 连接串，非空。启动时最长等待数据库 60 秒（每次失败输出 `database not reachable yet`），随后执行迁移。`sslmode=require`、`prefer`、`verify-ca` 与 `verify-full` 一样校验证书和主机名（与 libpq 不同）：证书不是公共 CA 签发时用 `sslrootcert=<CA 文件>` 指定 CA，或用 `uselibpqcompat=true&sslmode=require`（libpq 的行为）、`sslmode=no-verify` 跳过校验；证书校验失败时日志带 `hint` 字段。`compose.yml`、`compose.baota.yml` 用 `POSTGRES_PASSWORD` 拼出此值，忽略 `.env` 中的设置；`compose.baota-host.yml` 取自 `.env`，或由 `compose.override.yml` 设置的 `DATABASE_URL_FILE` 读取 |
| `EDGEWEIR_PUBLIC_URL` | 地址 URL（`http`、`https`） | `http://localhost:3000` | 浏览器访问控制台的地址；在反向代理后为代理地址。用于：认证接口的可信 origin、会话 Cookie 的 `Secure` 属性（`https://` 时启用）、passkey 的 RP ID（主机名）、OpenAPI 文档的 `servers`、`/install.sh` 中的控制台地址、告警通知中的链接、默认节点通道地址的主机。默认值只适合本机访问：节点安装命令与告警链接指向 localhost。地址只有本机可达、是内网地址或是 `http://` 地址时，启动日志写警告，见[接入节点](../deploy/nodes.md#1-生成安装命令) |

## 会话密钥

| 变量 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `BETTER_AUTH_SECRET` | 字符串，至少 32 字符 | 由主密钥派生 | 会话签名及两步验证密钥加密所用的密钥。未设置时用 HKDF-SHA256 从主密钥派生，参数见 [安全策略](../../SECURITY.md)；[轮换主密钥](#主密钥轮换)后保持原值。已设置过的部署必须保留原值：移除后控制台拒绝启动（`BETTER_AUTH_SECRET is not set, but this database was used with another secret`）；换成新值时控制台启动并记录警告，所有会话失效，已启用的两步验证无法再读取 |

## 主密钥轮换

| 变量 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `EDGEWEIR_MASTER_KEY_PREVIOUS` | Base64 | 未设置 | 轮换前的主密钥，只用于解密，规则同 `EDGEWEIR_MASTER_KEY`；与它相同时拒绝启动。启动时接受它加密的数据，并把库中它加密的全部信封改用 `EDGEWEIR_MASTER_KEY` 重新加密，日志 `master key rotation` 记录数量。全部改完后日志输出 `no envelope uses EDGEWEIR_MASTER_KEY_PREVIOUS any more: remove it and restart the console`，此后移除并重启；仍有信封使用它时输出 `envelopes still use EDGEWEIR_MASTER_KEY_PREVIOUS: keep it set`。节点保存的 revision 回执在设置期间仍可验证，节点下次拉取配置时换成新主密钥的回执。未设置 `BETTER_AUTH_SECRET` 时，会话密钥保持为旧主密钥派生的值，经新主密钥加密存入 `system_setting`，会话与两步验证不受影响。步骤见[轮换主密钥](../deploy/docker.md#轮换主密钥) |

## 从文件读取

`<变量>_FILE` 指定一个文件，文件内容即变量值（例如 Docker secret）。

| 规则 | 说明 |
| --- | --- |
| 内容 | 去掉末尾的换行后，按变量本身的规则校验 |
| 拒绝启动 | 同时设置非空的变量与其 `_FILE`；文件为空；文件不可读 |
| 空值 | `_FILE` 为空等同未设置 |
| Compose | 模板不传入 `_FILE` 变量；挂载与设置见[其他机密文件](../deploy/docker.md#其他机密文件) |

| 变量 | 代替 |
| --- | --- |
| `EDGEWEIR_MASTER_KEY_FILE` | `EDGEWEIR_MASTER_KEY` |
| `EDGEWEIR_MASTER_KEY_PREVIOUS_FILE` | `EDGEWEIR_MASTER_KEY_PREVIOUS` |
| `DATABASE_URL_FILE` | `DATABASE_URL` |
| `BETTER_AUTH_SECRET_FILE` | `BETTER_AUTH_SECRET` |
| `EDGEWEIR_CLICKHOUSE_PASSWORD_FILE` | `EDGEWEIR_CLICKHOUSE_PASSWORD`；Compose 模板为该变量设置了默认值，在 `compose.override.yml` 中把它设为 `""` |

## 访问地址与网络

| 变量 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `EDGEWEIR_NODE_API_URL` | 地址 URL（`https`、`wss`、`ws`） | `https://<EDGEWEIR_PUBLIC_URL 的主机名>:<NODE_API_PORT>`；`EDGEWEIR_NODE_API_WEBSOCKET` 为开时 `wss://<EDGEWEIR_PUBLIC_URL 的主机[:端口]>`（`EDGEWEIR_PUBLIC_URL` 为 `http://` 时 `ws://`） | **系统设置** 的「节点通道」没有保存地址时节点连接的 URL：`https://` 为节点通道端口，`wss://`、`ws://` 为 Web 端口上的 WebSocket 入口，见[节点通道的 WebSocket 入口](../deploy/networking.md#节点通道的-websocket-入口)。用作节点安装命令的 `--server`；主机名写入节点通道服务器证书。默认值取进程的 `NODE_API_PORT`（镜像内为 `8443`），不取 Compose 的 `EDGEWEIR_NODE_API_PORT`；宿主机端口不是 `8443` 或节点经其他地址访问时，在系统设置中填写地址或设置此变量，见[节点通道地址与证书](../deploy/networking.md#节点通道地址与证书) |
| `EDGEWEIR_NODE_API_WEBSOCKET` | 布尔 | `false` | 开启时：未设置 `EDGEWEIR_NODE_API_URL` 的默认节点通道地址为 WebSocket 入口（见上一行），Web 端口上的 WebSocket 入口 `/node-channel` 无论保存的地址是什么都保持开放。用于只转发 HTTP 的平台（如 [Render](../deploy/render.md)）。Compose 模板不传入 |
| `EDGEWEIR_NODE_API_HOSTNAMES` | 列表 | 空 | 节点通道服务器证书的附加名称（DNS 名或 IP）。证书始终包含 `localhost`、`127.0.0.1`、`::1`、本机主机名（容器内为容器主机名）、节点通道地址的主机，以及系统设置中保存过的节点通道地址的主机。修改后重启生效；已注册节点校验这些名称 |
| `EDGEWEIR_TRUSTED_PROXIES` | 列表（IP 或 CIDR） | 空 | 可信反向代理。仅采用来自这些地址的 `X-Forwarded-For`、`X-Real-IP`，用于审计日志 IP、登录限速与登录白名单。空：TCP 对端地址即客户端地址。条目不是 IP 或 CIDR 时拒绝启动。`compose.baota-host.yml` 默认 `127.0.0.1,::1`。见[端口、反向代理与可信代理](../deploy/networking.md) |
| `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` | 列表（IP 或 CIDR，逗号或空白分隔） | 空 | 允许控制台访问的私有或特殊用途网段，约束 Web 端保存的出站目标：告警渠道、SMTP、节点发布源。空：只允许公网地址。Web 端保存的值不能放宽此边界；经环境变量设置的发布源不受此约束。条目不是 IP 或 CIDR 时拒绝启动 |

## 分析

ClickHouse 变量仅在 `EDGEWEIR_ANALYTICS=clickhouse` 时使用。`compose.yml` 的 `analytics` profile 以 `EDGEWEIR_CLICKHOUSE_DATABASE`、`EDGEWEIR_CLICKHOUSE_USER` 和同一密码创建 ClickHouse 数据库与用户。

| 变量 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `EDGEWEIR_ANALYTICS` | 枚举：`lite`、`clickhouse` | `lite` | 访问日志与分钟统计的存储：`lite` 为 PostgreSQL。切换不迁移历史数据。显示在 **系统设置** 的「统计模式」。见[访问日志](../guide/access-logs.md) |
| `EDGEWEIR_CLICKHOUSE_URL` | URL（`http`、`https`） | `http://clickhouse:8123` | ClickHouse HTTP 接口；不得包含用户名、密码、查询串或片段。`compose.baota.yml` 默认 `http://host.docker.internal:8123`（宿主机，ClickHouse 需监听 Docker 网桥地址），`compose.baota-host.yml` 默认 `http://localhost:8123` |
| `EDGEWEIR_CLICKHOUSE_DATABASE` | 字符串，`^[A-Za-z_][A-Za-z0-9_]{0,63}$` | `edgeweir` | 数据库名 |
| `EDGEWEIR_CLICKHOUSE_USER` | 字符串 | `edgeweir` | 用户名，经 `X-ClickHouse-User` 请求头发送 |
| `EDGEWEIR_CLICKHOUSE_PASSWORD` | 字符串 | 空 | 密码，经 `X-ClickHouse-Key` 请求头发送。Compose 模板中未设置时依次取 `CLICKHOUSE_PASSWORD`、`edgeweir` |

## 证书与 DNS

| 变量 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `EDGEWEIR_ACME_DIRECTORY` | 字符串（URL） | 空 | **后备值**，对应 **系统设置 →「证书颁发机构」** 的自定义 ACME 目录。只有此变量提供地址时，没有指定 CA 的申请默认使用自定义目录。每张证书记下签发所用的目录，ARI 续期窗口向该目录查询；ACME 账户不在目录之间迁移。见[系统设置](../guide/system.md#证书颁发机构)与 [HTTPS 与证书](../guide/https.md#证书颁发机构) |
| `EDGEWEIR_ACME_CA_FILE` | 路径（PEM） | 空 | **后备值**，对应「证书颁发机构」的「CA 证书（PEM）」：自定义 ACME 目录 TLS 证书的签发者，与系统信任库一起使用 |
| `EDGEWEIR_SMTP_CA_FILE` | 路径（PEM） | 空 | **后备值**，对应 **告警 → SMTP** 的「CA 证书（PEM）」：SMTP TLS 使用的 CA，仅在 SMTP 设置未保存 CA 时读取。空：系统信任库 |
| `EDGEWEIR_DNS_TEST_ENDPOINT` | 字符串 | 空 | 集成测试用的本地 DNS 模拟器地址；设置后启用隐藏的 `test` DNS 服务商，并传给证书助手。不得用于真实服务商 |

## 节点发布

| 变量 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `EDGEWEIR_NODE_RELEASE_BASE_URL` | URL（`http`、`https`），最长 2048 字符 | 空 | **后备值**，对应 **系统设置 →「节点发布源」**。节点升级读取发布清单的基址，清单位于 `<基址>/v<版本>/checksums.txt`。不得包含用户名、密码、查询串或片段。空：`https://github.com/marvinli001/edgeweir-node/releases/download` |
| `EDGEWEIR_DOWNLOADS_DIR` | 路径（目录） | 未设置 | `/downloads/*` 所服务的发布文件目录，`install.sh` 从中下载节点包与 cosign。未设置：`/downloads/*` 返回 404，`install.sh` 从 GitHub 下载。目录结构见[接入节点](../deploy/nodes.md) |

## 运行时

| 变量 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `ROLE` | 枚举：`all`、`app`、`worker` | `all` | 进程角色，见[容器](cli.md#容器)与[部署概览](../deploy/README.md#进程角色) |
| `HOST` | 字符串 | `0.0.0.0` | Web 与 API 的监听地址。`compose.baota-host.yml`：`127.0.0.1` |
| `PORT` | 整数，1–65535 | `3000` | Web 与 API 的监听端口 |
| `NODE_API_HOST` | 字符串 | `HOST` 的值 | 节点通道的监听地址。`compose.baota-host.yml`：取自 `EDGEWEIR_NODE_API_HOST`，默认 `0.0.0.0` |
| `NODE_API_PORT` | 整数，0–65535 | `8443` | 节点通道的监听端口 |
| `LOG_LEVEL` | 枚举：`debug`、`info`、`warn`、`error` | `info` | 日志级别。日志每行一个 JSON 对象 |
| `NODE_ENV` | 枚举：`development`、`production`、`test` | `development`（镜像：`production`） | `production` 启用 `/api/auth` 的限速，计数存于 PostgreSQL |
| `EDGEWEIR_WEB_DIST` | 路径（目录） | `<main.js 所在目录>/../web` | 已构建 Web UI 的目录；镜像内解析为 `/app/dist/web`。`pnpm dev` 不使用 |
| `EDGEWEIR_CERTD_BIN` | 路径 | `edgeweir-certd`（镜像：`/usr/local/bin/edgeweir-certd`） | 证书助手；不含 `/` 时在 `PATH` 中查找。源码运行时构建：`cd helpers/certd && go build -o bin/edgeweir-certd .`，填写其绝对路径 |
| `EDGEWEIR_VERSION` | 字符串 | `dev`（镜像：构建版本） | 进程报告的版本，出现在 `/healthz`、OpenAPI 文档与 **系统设置** 的「版本」。镜像构建时写入滚动版本 `<YYYYMMDD>-<commit>`；不要在容器环境中覆盖。不经校验。Compose 另用同名宿主机变量选择镜像 tag，见 [Compose 宿主机变量](#compose-宿主机变量) |

## 测试专用

只用于端到端测试（`compose.e2e.yml`）；部署中不设置。

| 变量 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `EDGEWEIR_E2E_TICK_SECONDS` | 整数，1–59 | 未设置 | worker 每分钟一次的任务另外每隔该秒数运行一次 |
| `EDGEWEIR_E2E_HEARTBEAT_SECONDS` | 整数，1–15 | 未设置（节点心跳间隔 15 秒） | 下发给节点的心跳间隔；节点在三个心跳间隔内视为在线 |

## Compose 宿主机变量

Compose 在宿主机读取以下变量（`.env` 或 shell 环境），用于插值编排文件；控制台进程不读取它们。`deploy.sh` 的变量见 [deploy.sh 参考](../deploy/deploy-script.md)。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `EDGEWEIR_VERSION` | `stable` | 拉取的镜像 tag：`ghcr.io/marvinli001/edgeweir:<EDGEWEIR_VERSION>`。渠道 `stable`、`latest`，或日期 tag `<YYYYMMDD>-<commit>`，可附加 `@sha256:<digest>`。见[版本、升级与回滚](../deploy/upgrade.md) |
| `EDGEWEIR_POSTGRES_IMAGE` | `postgres:18.6-alpine`（按 digest 固定） | 只用于 `compose.baota.yml`：内置 PostgreSQL 的镜像。`deploy.sh` 在离线安装（`EDGEWEIR_NO_PULL`）无法使用固定版本时写入 |
| `EDGEWEIR_HTTP_PORT` | `compose.yml`：`127.0.0.1:3000`；其他：`3000` | Web 控制台的宿主机端口。`compose.yml`：端口发布规格，可带绑定地址（Docker 发布的端口绕过 ufw、firewalld），`3000` 发布到所有接口。`compose.baota.yml`：仅数字，绑定 `127.0.0.1`。`compose.baota-host.yml`：仅数字，作为 `PORT` |
| `EDGEWEIR_NODE_API_PORT` | `8443` | 节点通道的宿主机端口。`compose.yml`、`compose.baota.yml`：端口发布规格，可带绑定地址。`compose.baota-host.yml`：仅数字，作为 `NODE_API_PORT` |
| `EDGEWEIR_NODE_API_HOST` | `0.0.0.0` | 只用于 `compose.baota-host.yml`：节点通道的监听地址，作为 `NODE_API_HOST`；同一主机上的 nginx `stream` 透传时设为 `127.0.0.1`。写在 `.env` 中：面板以 `-f` 运行编排，不读取 `compose.override.yml` |
| `POSTGRES_PASSWORD` | 无 | 内置 PostgreSQL 的密码，`compose.yml`、`compose.baota.yml` 用它拼出 `DATABASE_URL`；未设置时这两个编排拒绝启动（早先未设置的部署用的是 `edgeweir`）。须 URL 安全：`openssl rand -hex 24`。PostgreSQL 镜像只在数据目录为空时应用此值，之后修改不改变已有密码 |
| `COMPOSE_PROFILES` | 空 | Compose 启用的 profile，逗号分隔。`analytics`：`compose.yml` 的 ClickHouse 服务；写在 `.env` 中时每条 `docker compose` 与 `deploy.sh` 命令都包含它，无需 `--profile` |
| `CLICKHOUSE_PASSWORD` | `edgeweir` | `EDGEWEIR_CLICKHOUSE_PASSWORD` 未设置时的 ClickHouse 密码，控制台与 `analytics` profile 的 ClickHouse 容器共用 |
| `DEV_POSTGRES_PORT` | `5432` | `compose.dev.yml`：开发数据库在 `127.0.0.1` 上的端口 |

### 传入容器的变量

编排文件以 `${变量:-默认值}` 把其余控制台变量传入容器。下表列出固定值与未传入的变量；未传入的变量写在 `.env` 中不生效，需要时加入服务的 `environment`（`compose.override.yml`）。

| 编排文件 | 固定值 | 未传入 |
| --- | --- | --- |
| `compose.yml` | `ROLE=all`；`DATABASE_URL` 由 `POSTGRES_PASSWORD` 拼出 | `_FILE` 变量、`EDGEWEIR_NODE_API_WEBSOCKET`、`HOST`、`PORT`、`NODE_API_HOST`、`NODE_API_PORT`、`NODE_ENV`、`EDGEWEIR_WEB_DIST`、`EDGEWEIR_CERTD_BIN`、`EDGEWEIR_DNS_TEST_ENDPOINT`、`EDGEWEIR_VERSION`、`EDGEWEIR_E2E_*` |
| `compose.baota.yml` | `ROLE=all`；`DATABASE_URL` 由 `POSTGRES_PASSWORD` 拼出 | 同 `compose.yml`，另加 `LOG_LEVEL`、`EDGEWEIR_DOWNLOADS_DIR` |
| `compose.baota-host.yml` | `ROLE=all`、`HOST=127.0.0.1`；`PORT`、`NODE_API_HOST`、`NODE_API_PORT` 取自 `EDGEWEIR_HTTP_PORT`、`EDGEWEIR_NODE_API_HOST`、`EDGEWEIR_NODE_API_PORT` | `_FILE` 变量、`EDGEWEIR_NODE_API_WEBSOCKET`、`NODE_ENV`、`EDGEWEIR_WEB_DIST`、`EDGEWEIR_CERTD_BIN`、`EDGEWEIR_DNS_TEST_ENDPOINT`、`EDGEWEIR_VERSION`、`EDGEWEIR_E2E_*`、`LOG_LEVEL`、`EDGEWEIR_DOWNLOADS_DIR` |
