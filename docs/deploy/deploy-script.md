# deploy.sh 参考

仓库根目录 `deploy.sh` 的命令、无人值守安装变量、生成的文件、备份布局与退出行为。

## 运行要求

| 项目 | 要求 |
| --- | --- |
| 主机 | 宝塔面板 / aaPanel，或任意装有 Docker 的 Linux |
| Shell | bash |
| Docker | Docker Engine 与 Compose v2（`docker compose`）；`docker info` 能成功执行（root 或 `sudo`） |
| 镜像 | 能拉取 `ghcr.io/marvinli001/edgeweir` 与 `postgres:18.6-alpine`；否则预先 `docker load` 并设置 `EDGEWEIR_NO_PULL=1` |
| 可选工具 | `ss` 或 `netstat`：端口占用检查，缺失时跳过；`openssl`：缺失时改用 `/dev/urandom`；`curl`：下载脚本与 `self-update` 的回退来源 |

```bash
curl -fsSL -o deploy.sh https://raw.githubusercontent.com/marvinli001/edgeweir/master/deploy.sh
sudo bash deploy.sh install
```

脚本必须先保存为文件再运行；经管道（`curl … | bash`）或进程替换（`bash <(curl …)`）运行时以 1 退出。安装后脚本副本位于 `<安装目录>/deploy.sh`，其余命令在该目录以 `./deploy.sh <命令>` 运行。宝塔 / aaPanel 上的完整流程见 [baota.md](baota.md)。

## 命令

| 命令 | 参数 | 作用 |
| --- | --- | --- |
| `install` | — | 对话式安装：选择数据库模式，检查数据库，写入 `.env`、`compose.yml` 与脚本副本，启动并等待健康检查，打印 setup token |
| `update`（别名 `upgrade`） | `[tag]` `[--no-backup]` | 备份后升级到指定 tag；省略时为 `latest` 对应的日期 tag，见 [update](#update) |
| `backup` | — | 备份数据库、`.env`（不含主密钥）与编排文件到 `backups/<时间>/`，保留最近 5 份，见 [备份](#备份) |
| `config` | — | 修改控制台地址与节点通道地址并重建容器；只能交互运行 |
| `start` | — | 启动编排并等待健康检查 |
| `stop` | — | `docker compose stop`；保留容器 |
| `restart` | — | 重启编排；bundled 模式网关变化时改为重建 |
| `status` | — | `docker compose ps`，以及部署目录、模式与运行版本 |
| `logs` | `[服务…]` | 跟随日志，先输出最近 200 行；服务为 `console`、`postgres`（bundled），省略时为全部 |
| `setup-token` | — | 从控制台日志读取最近一次输出的 setup token |
| `template` | `host` \| `bundled` | 输出编排模板；不需要 Docker |
| `self-update` | — | 替换本脚本，来源见 [self-update](#self-update) |
| `help`（`-h`、`--help`） | — | 打印用法；不带命令时相同 |

## 部署目录

`install`、`template`、`help` 以外的命令按以下顺序查找部署目录，取第一个匹配项：

1. `EDGEWEIR_DIR`
2. 脚本所在目录
3. 当前工作目录
4. `/www/dk_project/edgeweir`
5. `/opt/edgeweir`

| 项目 | 规则 |
| --- | --- |
| 部署目录 | 同时包含 `.env` 与含 `container_name: edgeweir-console` 的编排文件：`compose.yml`、`compose.yaml`、`docker-compose.yml` 或 `docker-compose.yaml` |
| 模式 | 编排文件含 `network_mode: host` 时为 host，否则为 bundled |
| Compose 项目名 | 取自容器 `edgeweir-console` 的 `com.docker.compose.project` 标签；面板以其他名称创建的编排同样适用 |
| 环境变量 | 调用 Compose 前移除 shell 中与 `.env` 或编排文件同名的变量，以 `.env` 为准 |

## install

### 提示

| 顺序 | 提示 | 默认值 | 变量 |
| --- | --- | --- | --- |
| 1 | 安装目录 | 存在 `/www/server/panel` 时 `/www/dk_project/edgeweir`，否则 `/opt/edgeweir` | `EDGEWEIR_DIR` |
| 2 | 数据库方式：`1` 本机或云 PostgreSQL（host），`2` 编排内置 PostgreSQL（bundled） | `1` | `EDGEWEIR_DB` |
| 3 | host：`1` 逐项填写，`2` 粘贴连接串 | `1` | `DATABASE_URL` |
| 3a | 逐项：数据库地址、端口、数据库名、用户名、密码 | `127.0.0.1`、`5432`、`edgeweir`、同数据库名、无（不能为空，输入不回显） | — |
| 3b | 逐项且地址不是回环地址：使用 TLS 连接并校验证书 | 是：写入 `?sslmode=verify-full` | — |
| 4 | 控制台地址 | — | `EDGEWEIR_PUBLIC_URL` |
| 5 | 节点通道地址 | `https://<控制台主机名>:<EDGEWEIR_NODE_API_PORT 或 8443>` | `EDGEWEIR_NODE_API_URL` |
| 6 | Web 控制台端口；仅当端口已被占用时出现 | 被占用端口加 1 | `EDGEWEIR_HTTP_PORT` |
| 7 | 「开始安装？」（先打印目录、数据库、地址与版本） | 是 | — |

变量提供默认值；无人值守时即为答案。`EDGEWEIR_DB` 或 `DATABASE_URL` 已设置时跳过对应提示。回环地址指 `127.*`、`localhost`、`::1`。

### 校验

| 输入 | 规则 |
| --- | --- |
| 安装目录 | 绝对路径；不存在、为空或只有 `deploy.sh`；主机上没有名为 `edgeweir-console` 的容器 |
| 已有数据 | bundled：Docker 卷 `edgeweir_postgres-data`（之前的安装留下的数据库）已存在时中止；host：见 [数据库检查](#数据库检查) |
| 控制台地址 | `http(s)://主机[:端口]`，端口 1–65535，不含路径，末尾 `/` 被去除；不是 `https://` 时警告 |
| 节点通道地址 | `https://主机[:端口]`，不含路径；其中的端口即对外的节点通道端口，省略时为 443 |
| 连接串 | `postgres://` 或 `postgresql://`；含用户名与库名；单一主机；不含空白、引号、反引号、`\`、`$`、`#`，密码中的特殊字符做 URL 编码（`$` 写成 `%24`） |
| 端口 | Web 端口与节点通道端口为数字且不同；节点通道端口已被占用时中止 |

### 结果

1. 解析并拉取镜像版本，见 [版本解析](#版本解析)。
2. 创建安装目录（700），写入 `.env`（600）、`compose.yml` 与 `deploy.sh`（700）。
3. 拉取编排镜像，启动并等待健康检查。
4. 打印运行版本、后续步骤与 setup token。

## 无人值守安装

`EDGEWEIR_YES` 非空，或无法打开 `/dev/tty` 时，脚本不读取输入：每个提示取默认值或下表变量。

| 变量 | 取值 | 默认 | 作用 |
| --- | --- | --- | --- |
| `EDGEWEIR_YES` | 任意非空值 | 空 | 启用无人值守 |
| `EDGEWEIR_DB` | `host` \| `bundled` | `bundled` | 数据库模式；其他值中止 |
| `DATABASE_URL` | `postgres://用户:密码@主机:端口/库名[?sslmode=verify-full]` | — | host 模式必填 |
| `EDGEWEIR_PUBLIC_URL` | `https://主机[:端口]` | — | 必填 |
| `EDGEWEIR_NODE_API_URL` | `https://主机[:端口]` | `https://<控制台主机名>:<EDGEWEIR_NODE_API_PORT>` | 节点通道地址 |
| `EDGEWEIR_NODE_API_PORT` | 端口 | `8443` | 只用于节点通道地址的默认值；写入 `.env` 的端口取自节点通道地址 |
| `EDGEWEIR_HTTP_PORT` | 端口 | `3000` | Web 控制台端口；取最后一个 `:` 之后的部分；已被占用时中止 |
| `EDGEWEIR_VERSION` | tag | `latest` | 要固定的镜像版本 |
| `EDGEWEIR_DIR` | 绝对路径 | 见 [提示](#提示) | 安装目录；其他命令优先在此查找部署 |
| `EDGEWEIR_NO_PULL` | 任意非空值 | 空 | `install` 与 `update` 不拉取镜像，只用本机已有镜像 |
| `EDGEWEIR_BACKUP_KEEP` | 非负整数 | `5` | `backup` 与 `update` 保留的备份份数；`0` 为全部保留 |
| `EDGEWEIR_SCRIPT_URL` | URL | `https://raw.githubusercontent.com/marvinli001/edgeweir/master/deploy.sh` | `self-update` 的回退来源 |

| 确认项 | 无人值守的答案 |
| --- | --- |
| PostgreSQL 主版本低于 18，是否继续 | 否：中止 |
| 数据库检查未通过或数据库不是空的，是否重填 | 不询问：中止 |
| 「开始安装？」 | 是 |
| `update` 回退确认 | 否：中止 |
| `update` 替换编排文件 | 否：保留现有文件 |
| `update` 用镜像内的脚本替换本脚本 | 是 |
| `config` | 不支持：中止 |

```bash
EDGEWEIR_YES=1 EDGEWEIR_DB=bundled \
EDGEWEIR_PUBLIC_URL=https://cdn-admin.example.com \
bash deploy.sh install
```

`EDGEWEIR_NO_PULL=1` 需要本机已有控制台镜像的目标 tag（或 `latest`）与 `postgres:18.6-alpine`（host 模式的检查与备份、bundled 模式的数据库）。

## 数据库检查

host 模式在写入任何文件前检查数据库。检查用 `postgres:18.6-alpine`（按 digest 固定，与 `compose.baota.yml` 相同）在 host 网络上运行 `psql`，密码经环境变量传入，连接超时 8 秒。

| 检查 | 未通过时 |
| --- | --- |
| 连接 | 打印错误与下表提示；交互模式询问是否重填 |
| 当前用户对该库和 `public` schema 有 `CREATE` 权限（迁移与后台任务队列需要） | 提示 `ALTER DATABASE <库> OWNER TO <用户>;` 与 `ALTER SCHEMA public OWNER TO <用户>;` |
| 服务器主版本不低于 18 | 警告并询问是否继续，默认否 |
| 库中没有 `drizzle.__drizzle_migrations`（没有控制台在这个库上运行过） | 提示：库中的加密数据只能用当初的主密钥打开，继续使用它就把当初的 `.env` 放回部署目录后 `./deploy.sh start`，否则换空数据库；交互模式询问是否重填 |

| 错误含 | 提示 |
| --- | --- |
| `refused` | 该地址和端口没有 PostgreSQL 监听 |
| `password` | 用户名或密码错误 |
| `pg_hba` | `pg_hba.conf` 未放行本机 |
| `does not exist` | 数据库或用户不存在 |
| `timeout`、`timed out` | 防火墙、安全组或云数据库白名单 |
| `certificate`、`SSL` | 证书不是公共 CA 签发，或与主机名不符 |

检查与备份按 `DATABASE_URL` 的 `sslmode` 连接：

| `sslmode` | 连接方式 |
| --- | --- |
| 无、`disable`、`allow` | 不加密 |
| `no-verify` | 加密，不校验证书 |
| 其他值 | 校验证书与主机名；CA 取自宿主机的 `/etc/ssl/certs/ca-certificates.crt`、`/etc/pki/tls/certs/ca-bundle.crt` 或 `/etc/ssl/cert.pem`，均不存在时用系统默认 |

## update

`./deploy.sh update [tag] [--no-backup]` 依次执行：

1. 解析目标版本，见 [版本解析](#版本解析)。目标等于 `.env` 中的 `EDGEWEIR_VERSION` 且容器已运行该版本时，输出 `已经是 <版本>。` 并以 0 退出。
2. 目标不是 `latest` 且早于当前版本时视为回退：警告并询问是否继续，默认否。先比较 tag 中的日期；同一天的两个 tag 比较两个镜像的提交时间（标签 `org.opencontainers.image.created`）。无法判断时（tag 不是 `<YYYYMMDD>-<commit>`，或同一天但有镜像不在本机）只提示，不询问。
3. 备份到 `backups/<时间>-before-<目标版本>/`；`--no-backup` 跳过。备份失败时中止，部署不变。
4. 编排文件与脚本内置模板不同时询问是否替换：交互模式默认替换，无人值守保留。旧文件已在第 3 步的备份中；`./deploy.sh template <模式>` 输出模板。
5. 写入 `EDGEWEIR_VERSION`，按 `start` 的流程重建容器。数据库迁移在控制台启动时执行。
6. 输出回退命令 `./deploy.sh update <原版本>`（仅适用于两个版本之间没有新增迁移时）。
7. 新镜像中的 `/app/deploy.sh` 与本脚本不同时询问是否替换本脚本，默认替换。

版本策略与回退约束见 [upgrade.md](upgrade.md)。

### 版本解析

| 目标 | 行为 |
| --- | --- |
| `latest` | 拉取 `ghcr.io/marvinli001/edgeweir:latest`，读取镜像标签 `org.opencontainers.image.version`，拉取该日期 tag 并固定为它；标签为空或为 `dev` 时警告并固定为 `latest` |
| `<tag>` | 拉取该 tag 并原样固定 |
| 设置了 `EDGEWEIR_NO_PULL` | 不拉取；镜像必须已在本机。`latest` 对应的日期 tag 不在本机时，从本机的 `latest` 打上该 tag |

`install` 使用同一规则解析 `EDGEWEIR_VERSION`（默认 `latest`）。

## config

只能交互运行；无人值守或没有终端时中止，此时直接编辑 `.env` 后运行 `./deploy.sh start`。

1. 询问控制台地址与节点通道地址；回车保留当前值。校验规则同 [install](#校验)。
2. 节点通道端口变化时警告：放行新端口，已注册的节点按新地址重新注册。
3. 节点通道主机名变化时警告：已注册的节点重新注册，或把旧主机名加入 `EDGEWEIR_NODE_API_HOSTNAMES`。
4. 确认后写入 `EDGEWEIR_PUBLIC_URL`、`EDGEWEIR_NODE_API_URL` 与 `EDGEWEIR_NODE_API_PORT`（节点通道地址中的端口），按 `start` 的流程重建容器。

`config` 不修改 `EDGEWEIR_HTTP_PORT`，不检查新端口是否被占用。

## 启停与可信代理同步

| 命令 | 行为 |
| --- | --- |
| `start` | bundled：先启动 `postgres` 并同步 `EDGEWEIR_TRUSTED_PROXIES`；再执行 `docker compose up -d --wait --remove-orphans`；未进入健康状态时打印控制台最近 40 行日志并中止 |
| `restart` | bundled 且同步改写了 `EDGEWEIR_TRUSTED_PROXIES`：按 `start` 重建；否则 `docker compose restart` |
| `stop` | `docker compose stop` |

`install`、`update` 与 `config` 使用 `start` 的流程。

| 项目 | 规则 |
| --- | --- |
| 同步条件 | bundled 模式，`postgres` 容器在运行，且 `EDGEWEIR_TRUSTED_PROXIES` 为空或为不等于当前网关的单个 IPv4 地址 |
| 写入值 | `postgres` 容器所在网络的 IPv4 网关 |
| 不改动 | 值为列表或 CIDR；host 模式（模板默认 `127.0.0.1,::1`） |
| host 模式启动后 | 节点通道端口只监听回环地址时警告：镜像不支持 `NODE_API_HOST` |

可信代理的含义见 [networking.md](networking.md#可信代理与客户端-ip)。

## self-update

| 顺序 | 来源 | 使用条件 |
| --- | --- | --- |
| 1 | 镜像 `ghcr.io/marvinli001/edgeweir:<.env 中的 EDGEWEIR_VERSION>` 内的 `/app/deploy.sh` | 能读取、非空、通过 `bash -n` |
| 2 | `EDGEWEIR_SCRIPT_URL` | 下载成功且通过 `bash -n`；否则中止，不替换 |

内容相同时不改动。替换时写入新文件（700）并重命名覆盖本脚本；运行中的进程继续读取旧文件。

## 生成的文件

| 路径 | 权限 | 内容 | 写入 |
| --- | --- | --- | --- |
| `<目录>/` | 700 | 部署目录 | `install` |
| `<目录>/.env` | 600 | 见下表 | `install`；`update`、`config` 与可信代理同步修改其中的键 |
| `<目录>/compose.yml` | 按 umask；替换后 600 | 所选模式的模板，与 [`compose.baota-host.yml`](../../compose.baota-host.yml) 或 [`compose.baota.yml`](../../compose.baota.yml) 逐字一致 | `install`；`update` 确认后替换 |
| `<目录>/deploy.sh` | 700 | 脚本副本 | `install`；`update`、`self-update` 替换 |
| `<目录>/backups/` | 700 | 备份 | `backup`、`update` |

| `.env` 键 | 模式 | 值 |
| --- | --- | --- |
| `EDGEWEIR_MASTER_KEY` | 全部 | `openssl rand -base64 32`；没有 `openssl` 时为 32 字节随机数的 base64 |
| `DATABASE_URL` | host | 输入的连接串，或由各项拼成：各部分 URL 编码，IPv6 地址加方括号 |
| `POSTGRES_PASSWORD` | bundled | `openssl rand -hex 24` |
| `EDGEWEIR_HTTP_PORT` | 全部 | Web 控制台端口 |
| `EDGEWEIR_NODE_API_PORT` | 全部 | 节点通道地址中的端口 |
| `EDGEWEIR_PUBLIC_URL` | 全部 | 控制台地址 |
| `EDGEWEIR_NODE_API_URL` | 全部 | 节点通道地址 |
| `EDGEWEIR_VERSION` | 全部 | 固定的镜像 tag |
| `EDGEWEIR_TRUSTED_PROXIES` | bundled | Docker 网关地址；首次启动时写入 |

值不加引号。修改某个键时保留其他行与 600 权限。其余变量见 [环境变量](../reference/environment.md)。

## 备份

```text
<目录>/backups/
└── 20260929-153000-before-20260930-b2c3d4e/
    ├── edgeweir.dump
    ├── env
    └── compose.yml
```

| 文件 | 内容 |
| --- | --- |
| `edgeweir.dump` | `pg_dump --format=custom`。host：按 `DATABASE_URL` 用 `postgres:18.6-alpine` 在 host 网络转储；bundled：在 `postgres` 容器内转储 |
| `env` | `.env` 副本；`EDGEWEIR_MASTER_KEY` 与 `BETTER_AUTH_SECRET` 两行改为注释，不含其值 |
| `compose.yml` | 编排文件副本，保留原文件名 |

| 项目 | 规则 |
| --- | --- |
| 目录名 | `YYYYMMDD-HHMMSS`；`update` 创建的备份加后缀 `-before-<目标版本>` |
| 权限 | 目录 700，文件 600 |
| 前提 | bundled 模式的 `postgres` 容器在运行 |
| 失败 | `pg_dump` 失败时中止 |
| 保留 | 成功备份后只留最近 `EDGEWEIR_BACKUP_KEEP` 份（默认 5，`0` 为全部保留），按目录名删除更早的；`backups/` 中其他名称的目录不动 |
| 主密钥 | 不在备份中：只在 `.env`（或 `EDGEWEIR_MASTER_KEY_FILE` 指定的文件）里，另行离线保存；恢复数据库需要它 |
| 范围 | 不含 ClickHouse 数据 |

恢复步骤见 [backup.md](backup.md)。

## 退出与中止

| 情况 | 行为 |
| --- | --- |
| 成功 | 退出码 0 |
| 中止 | 输出 `✗ <原因>`，退出码 1 |
| 未知命令 | 打印用法，退出码 1 |
| 底层命令失败 | 立即退出（`set -Eeuo pipefail`），退出码为该命令的退出码 |
| 输入结束（EOF） | 中止：「输入已结束，安装取消。」或「输入已结束，已取消。」 |
| 拒绝确认 | 中止：「已取消。」 |
| `install` 确认前 | 不写入安装目录 |
| `install` 启动失败 | 文件保留，输出「启动失败。修正 .env 后运行 ./deploy.sh start 重试。」；该目录此后被识别为已有部署，再次 `install` 被拒绝 |
| `update` 启动失败 | `.env` 已指向目标版本；按输出的回退命令或备份恢复 |
| `setup-token` 找不到令牌 | 中止：已完成初始化，或容器未启动 |

`template` 与 `setup-token` 的结果写到标准输出；进度、提示与错误写到标准错误，标准错误是终端时带颜色。
