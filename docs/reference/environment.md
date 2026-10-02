# 环境变量

控制台进程读取的环境变量、默认值与校验规则，以及 Compose 编排使用的宿主机变量。

## 读取与校验

- 进程启动时读取并校验全部变量一次。任一变量不合法时进程退出，日志以 `invalid configuration:` 开头并列出出错的变量。
- 修改后重建容器：`docker compose up -d`。`docker compose restart` 不应用新值。
- `BETTER_AUTH_SECRET`、`EDGEWEIR_NODE_API_URL`、`NODE_API_HOST`、`EDGEWEIR_NODE_RELEASE_BASE_URL` 的空值等同未设置；其余变量的空值按字面校验，例如 `ROLE=` 不合法。
- 默认值列为进程默认值。镜像或 Compose 模板设置的不同值写在说明列。
- **后备值**：**系统设置** 中保存了对应项时，以保存值为准；清空保存值后恢复使用变量。
- 模板与注释：[`.env.example`](https://github.com/marvinli001/edgeweir/blob/master/.env.example)。

## 必需

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `EDGEWEIR_MASTER_KEY` | 无 | 主密钥。规范的 Base64（标准或 URL 安全字母表），解码后至少 32 字节；含空格、引号等其他字符或不足 32 字节时拒绝启动。用 `openssl rand -base64 32` 生成，输出原样使用（保留 `/`、`+`、`=`）。与数据库中加密数据所用的主密钥不一致时报 `EDGEWEIR_MASTER_KEY does not match this database` 并拒绝启动；改用原主密钥，不要设置 `BETTER_AUTH_SECRET`。用于信封加密入库的私钥、DNS API 密钥等，并派生会话密钥。丢失后已加密数据无法恢复；与数据库分开备份。 |
| `EDGEWEIR_MASTER_KEY_FILE` | 未设置 | 存放主密钥的文件（例如 Docker secret），代替 `EDGEWEIR_MASTER_KEY`；文件末尾的换行被忽略，内容按 `EDGEWEIR_MASTER_KEY` 的规则校验。与非空的 `EDGEWEIR_MASTER_KEY` 同时设置，或文件不可读时拒绝启动。Compose 模板不传入，见[主密钥文件](../deploy/docker.md#主密钥文件)。 |
| `DATABASE_URL` | 无 | PostgreSQL 18 连接串。启动时最长等待数据库 60 秒，随后执行迁移。`compose.yml`、`compose.baota.yml` 用 `POSTGRES_PASSWORD` 拼出此值，忽略 `.env` 中的设置；`compose.baota-host.yml` 要求 `.env` 提供。 |
| `EDGEWEIR_PUBLIC_URL` | `http://localhost:3000` | 浏览器访问控制台的地址；在反向代理后为代理地址。格式 `http(s)://主机[:端口]`，不含路径、查询串、片段与用户名密码，末尾的 `/` 与默认端口被去掉；不符合时拒绝启动。用于：认证接口的可信 origin、会话 Cookie 的 `Secure` 属性（`https://` 时启用）、passkey 的 RP ID（主机名）、OpenAPI 文档的 `servers`、`/install.sh` 中的控制台地址、告警通知中的链接、`EDGEWEIR_NODE_API_URL` 的默认主机名。 |
| `BETTER_AUTH_SECRET` | 由主密钥派生 | 会话签名及两步验证密钥加密所用的密钥，至少 32 个字符。未设置时用 HKDF-SHA256 从主密钥派生，参数见 [SECURITY.md](../../SECURITY.md)。已设置过的部署必须保留原值：移除后控制台拒绝启动；换成新值时控制台启动并记录警告，所有会话失效，已启用的两步验证无法再读取。 |

## 访问地址与网络

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `EDGEWEIR_NODE_API_URL` | `https://<EDGEWEIR_PUBLIC_URL 的主机名>:<NODE_API_PORT>` | 节点连接节点通道的 URL，格式 `https://主机[:端口]`，规则同 `EDGEWEIR_PUBLIC_URL`。用作节点安装命令的 `--server`，显示在 **系统设置** 的「节点通道」；主机名写入节点通道服务器证书。默认值取进程的 `NODE_API_PORT`（镜像内为 `8443`），不取 Compose 的 `EDGEWEIR_NODE_API_PORT`；宿主机端口不是 `8443` 或节点经其他地址访问时设置此变量。 |
| `EDGEWEIR_NODE_API_HOSTNAMES` | 空 | 节点通道服务器证书的附加名称（DNS 名或 IP），逗号分隔。证书始终包含 `localhost`、`127.0.0.1`、`::1`、本机主机名（容器内为容器主机名）和 `EDGEWEIR_NODE_API_URL` 的主机。证书在每次启动时签发，已注册节点校验这些名称。 |
| `EDGEWEIR_TRUSTED_PROXIES` | 空 | 可信反向代理的 IP 或 CIDR，逗号分隔。仅采用来自这些地址的 `X-Forwarded-For`、`X-Real-IP`，用于审计日志 IP 与登录限速。空：TCP 对端地址即客户端地址。条目不是 IP 或 CIDR 时拒绝启动。`compose.baota-host.yml` 默认 `127.0.0.1,::1`。配置见[端口、反向代理与可信代理](../deploy/networking.md)。 |
| `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` | 空 | 允许控制台访问的私有或特殊用途网段（CIDR，逗号或空白分隔），约束 Web 端保存的出站目标：告警通知渠道、SMTP、节点发布源。空：只允许公网地址。Web 端保存的值不能放宽此边界。经环境变量设置的发布源不受此约束。条目不是 IP 或 CIDR 时拒绝启动。 |

## 分析

ClickHouse 变量仅在 `EDGEWEIR_ANALYTICS=clickhouse` 时使用。`compose.yml` 的 `analytics` profile 以 `EDGEWEIR_CLICKHOUSE_DATABASE`、`EDGEWEIR_CLICKHOUSE_USER` 和同一密码创建 ClickHouse 数据库与用户。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `EDGEWEIR_ANALYTICS` | `lite` | 访问日志与分钟统计的存储：`lite`（PostgreSQL）或 `clickhouse`。切换不迁移历史数据。显示在 **系统设置** 的「统计模式」。行为见[访问日志与 AccessKey](../guide/access-logs.md)。 |
| `EDGEWEIR_CLICKHOUSE_URL` | `http://clickhouse:8123` | ClickHouse HTTP 接口。仅限 `http`、`https`，不得包含用户名、密码、查询串或片段。`compose.baota.yml` 默认 `http://host.docker.internal:8123`（宿主机，ClickHouse 需监听 Docker 网桥地址），`compose.baota-host.yml` 默认 `http://localhost:8123`。 |
| `EDGEWEIR_CLICKHOUSE_DATABASE` | `edgeweir` | 数据库名，须匹配 `^[A-Za-z_][A-Za-z0-9_]{0,63}$`。 |
| `EDGEWEIR_CLICKHOUSE_USER` | `edgeweir` | 用户名，经 `X-ClickHouse-User` 请求头发送。 |
| `EDGEWEIR_CLICKHOUSE_PASSWORD` | 空 | 密码，经 `X-ClickHouse-Key` 请求头发送。Compose 模板中未设置时依次取 `CLICKHOUSE_PASSWORD`、`edgeweir`。 |

## 证书与 DNS

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `EDGEWEIR_ACME_DIRECTORY` | 空 | 全部证书使用的 ACME 目录 URL，覆盖按证书选择的 CA。设置后「申请证书」不再提供 CA 与 EAB 字段，改为显示该目录；控制台启动时记录一条警告；每张证书记下签发所用的目录，ARI 续期窗口向该目录查询。仅用于私有 PKI 与测试；ACME 账户不在目录之间迁移。空：按证书选择 Let's Encrypt 或 ZeroSSL，见 [HTTPS 与证书](../guide/https.md)。 |
| `EDGEWEIR_ACME_CA_FILE` | 空 | PEM 文件路径，证书助手用它校验 ACME 目录的 TLS 证书。配合 `EDGEWEIR_ACME_DIRECTORY` 使用。 |
| `EDGEWEIR_SMTP_CA_FILE` | 空 | **后备值**，对应 **系统设置 → SMTP** →「CA 证书（PEM）」。SMTP TLS 使用的 CA（PEM 文件路径），仅在 SMTP 设置未保存 CA 时使用。空：系统信任库。 |
| `EDGEWEIR_DNS_TEST_ENDPOINT` | 空 | 集成测试用的本地 DNS 模拟器地址；设置后启用 `test` DNS 服务商。不得用于真实服务商。 |

## 节点发布

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `EDGEWEIR_NODE_RELEASE_BASE_URL` | 空 | **后备值**，对应 **系统设置 → 节点发布源**。节点升级读取发布清单的基址，清单位于 `<基址>/v<版本>/checksums.txt`。仅限 `http`、`https`，不得包含用户名、密码、查询串或片段，最长 2048 字符。空：`https://github.com/marvinli001/edgeweir-node/releases/download`。 |
| `EDGEWEIR_DOWNLOADS_DIR` | 未设置 | `/downloads/*` 所服务的发布文件目录，`install.sh` 从中下载节点包与 cosign。未设置：`/downloads/*` 返回 404，`install.sh` 从 GitHub 下载。目录结构见[接入节点](../deploy/nodes.md)。 |

## 运行时

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `ROLE` | `all` | 进程角色：`all`、`app`、`worker`。各角色运行的组件见[部署概览](../deploy/README.md#进程角色)。 |
| `HOST` | `0.0.0.0` | Web 与 API 的监听地址。`compose.baota-host.yml`：`127.0.0.1`。 |
| `PORT` | `3000` | Web 与 API 的监听端口，1–65535。 |
| `NODE_API_HOST` | `HOST` 的值 | 节点通道的监听地址。`compose.baota-host.yml`：`0.0.0.0`。 |
| `NODE_API_PORT` | `8443` | 节点通道的监听端口。 |
| `LOG_LEVEL` | `info` | `debug`、`info`、`warn`、`error`。日志每行一个 JSON 对象。 |
| `NODE_ENV` | `development`（镜像：`production`） | `development`、`production`、`test`。`production` 启用认证接口限速，计数存于 PostgreSQL。 |
| `EDGEWEIR_WEB_DIST` | `<main.js 所在目录>/../web` | 已构建 Web UI 的目录；镜像内解析为 `/app/dist/web`。`pnpm dev` 不使用。 |
| `EDGEWEIR_CERTD_BIN` | `edgeweir-certd`（镜像：`/usr/local/bin/edgeweir-certd`） | 证书助手的路径；不含 `/` 时在 `PATH` 中查找。源码运行时构建：`cd helpers/certd && go build -o bin/edgeweir-certd .`，填写其绝对路径。 |
| `EDGEWEIR_TELEMETRY` | `false` | 匿名使用遥测。接受 `true`、`1`、`yes`、`on` 与 `false`、`0`、`no`、`off`。当前版本不发送任何数据；状态显示在 **系统设置** 的「遥测」。 |
| `EDGEWEIR_VERSION` | `dev`（镜像：构建版本） | 进程报告的版本，出现在 `/healthz`、OpenAPI 文档与 **系统设置** 的「版本」。镜像构建时写入滚动版本 `<YYYYMMDD>-<commit>`；不要在容器环境中覆盖。Compose 另用同名宿主机变量选择镜像 tag，见 [Compose 宿主机变量](#compose-宿主机变量)。 |

## Compose 宿主机变量

Compose 在宿主机读取以下变量（`.env` 或 shell 环境），用于插值编排文件；控制台进程不读取它们。`deploy.sh` 的无人值守变量见 [deploy.sh 参考](../deploy/deploy-script.md)。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `EDGEWEIR_VERSION` | `latest` | 拉取的镜像 tag：`ghcr.io/marvinli001/edgeweir:<EDGEWEIR_VERSION>`。滚动 tag 格式 `<YYYYMMDD>-<commit>`，可附加 `@sha256:<digest>`。见[版本、升级与回滚](../deploy/upgrade.md)。 |
| `EDGEWEIR_HTTP_PORT` | `3000` | Web 控制台的宿主机端口。`compose.yml`：端口发布规格，可带绑定地址，默认 `127.0.0.1:3000`（Docker 发布的端口绕过 ufw、firewalld），`3000` 发布到所有接口。`compose.baota.yml`：仅数字，绑定 `127.0.0.1`。`compose.baota-host.yml`：仅数字，作为 `PORT`。 |
| `EDGEWEIR_NODE_API_PORT` | `8443` | 节点通道的宿主机端口。`compose.yml`、`compose.baota.yml`：端口发布规格，可带绑定地址。`compose.baota-host.yml`：仅数字，作为 `NODE_API_PORT`。 |
| `POSTGRES_PASSWORD` | 无 | 内置 PostgreSQL 的密码，`compose.yml`、`compose.baota.yml` 用它拼出 `DATABASE_URL`；未设置时这两个编排拒绝启动（早先未设置的部署用的是 `edgeweir`）。须 URL 安全：`openssl rand -hex 24`。PostgreSQL 镜像只在数据目录为空时应用此值，之后修改不改变已有密码。 |
| `CLICKHOUSE_PASSWORD` | `edgeweir` | `EDGEWEIR_CLICKHOUSE_PASSWORD` 未设置时的 ClickHouse 密码，控制台与 `analytics` profile 的 ClickHouse 容器共用。 |
| `DEV_POSTGRES_PORT` | `5432` | `compose.dev.yml`：开发数据库在 `127.0.0.1` 上的端口。 |

### 传入容器的变量

编排文件以 `${变量:-默认值}` 把其余控制台变量传入容器。下表列出固定值与未传入的变量；未传入的变量写在 `.env` 中不生效，需要时加入服务的 `environment`。

| 编排文件 | 固定值 | 未传入 |
| --- | --- | --- |
| `compose.yml` | `ROLE=all` | `EDGEWEIR_MASTER_KEY_FILE`、`HOST`、`PORT`、`NODE_API_HOST`、`NODE_API_PORT`、`NODE_ENV`、`EDGEWEIR_WEB_DIST`、`EDGEWEIR_CERTD_BIN`、`EDGEWEIR_DNS_TEST_ENDPOINT`、`EDGEWEIR_VERSION` |
| `compose.baota.yml` | `ROLE=all` | 同 `compose.yml`，另加 `EDGEWEIR_TELEMETRY`、`LOG_LEVEL`、`EDGEWEIR_DOWNLOADS_DIR` |
| `compose.baota-host.yml` | `ROLE=all`、`HOST=127.0.0.1`、`NODE_API_HOST=0.0.0.0`；`PORT`、`NODE_API_PORT` 取自宿主机端口变量 | `EDGEWEIR_MASTER_KEY_FILE`、`NODE_ENV`、`EDGEWEIR_WEB_DIST`、`EDGEWEIR_CERTD_BIN`、`EDGEWEIR_DNS_TEST_ENDPOINT`、`EDGEWEIR_VERSION`、`EDGEWEIR_TELEMETRY`、`LOG_LEVEL`、`EDGEWEIR_DOWNLOADS_DIR` |
