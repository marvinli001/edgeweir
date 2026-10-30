# 版本与升级

控制台镜像的版本与渠道、版本固定、签名校验、各部署方式的升级步骤、启动时迁移与节点兼容。

## 版本规则

| 项目 | 规则 |
| --- | --- |
| 镜像 | `ghcr.io/marvinli001/edgeweir`，linux/amd64、linux/arm64，公开拉取 |
| tag | `<YYYYMMDD>-<commit>`：UTC 提交日期与提交 ID 前 7 位，例如 `20260929-a1b2c3d`；同一提交始终得到同一 tag（`scripts/image-version.sh`）。不使用语义化版本号 |
| 发布 | `master` 上的推送通过 CI 后，release 工作流构建该提交并推送其日期 tag |
| `stable` | 默认渠道：维护者经 promote 工作流把它指向一个已发布日期 tag 的同一 digest（不重新构建、不重新签名）；每次移动附一个 [GitHub Release](https://github.com/marvinli001/edgeweir/releases)，写明配套的节点版本、proto 版本、新增的数据库迁移与升级步骤 |
| `latest` | 预览渠道：跟随 `master`，仅在构建的提交仍是 `master` 最新提交时移动，不回退 |
| 手动发布 | 重建 `master` 最新提交，以同一日期 tag 推送新的 digest |
| 源码构建 | 版本为 `dev` |
| 镜像标签 | `org.opencontainers.image.version` 为日期 tag；`org.opencontainers.image.revision` 为完整提交 ID |
| 签名 | cosign keyless 签名，附 SBOM 与 SLSA provenance |
| 全部 tag | [GitHub Packages](https://github.com/marvinli001/edgeweir/pkgs/container/edgeweir)；提交改动见 `https://github.com/marvinli001/edgeweir/commit/<提交 ID>` |

边缘节点使用独立的语义化版本 `vX.Y.Z`，升级见 [节点升级](../guide/node-upgrades.md)。安全修复只进入 `master`，随下一个 `stable` 与节点补丁版本发布，不回移到旧版本。

## 节点兼容

| 项目 | 规则 |
| --- | --- |
| 配套版本 | 每个 `stable` 的 GitHub Release 的「兼容性」一节列出配套的 edgeweir-node 版本与 proto 版本 |
| 判断依据 | 控制台按节点上报的[能力](../guide/node-upgrades.md#节点能力)判断，不按版本号拒绝节点 |
| 缺少能力的节点 | 保留上一份可用配置，**集群与节点** 中显示「需要升级」；控制台账户可以发布这类配置，服务账号与后台任务发布时返回 409 `NODE_CAPABILITY_REQUIRED` |
| WebSocket 入口 | 节点通道地址为 `wss://`、`ws://` 时需要 edgeweir-node 0.2.0 及以上；`install.sh` 拒绝安装更早的版本 |
| 升级顺序 | 先升级控制台，再升级节点 |

## 查看版本

| 对象 | 命令或位置 |
| --- | --- |
| 运行中的版本 | `curl -s http://127.0.0.1:3000/healthz` 的 `version`；**系统设置** 的「系统信息」中的「版本」 |
| 渠道对应的日期 tag | `docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' ghcr.io/marvinli001/edgeweir:stable`（拉取后执行；`latest` 同理） |
| tag 的 digest | `docker buildx imagetools inspect ghcr.io/marvinli001/edgeweir:<tag>` 输出的 `Digest` |
| 已执行的迁移数 | `docker compose exec -T postgres psql -U edgeweir -d edgeweir -Atc 'select count(*) from drizzle.__drizzle_migrations'` |

## 固定版本

在 `.env` 中固定日期 tag，或连同 digest 固定：

```bash title=".env"
EDGEWEIR_VERSION=20260929-a1b2c3d
# EDGEWEIR_VERSION=20260929-a1b2c3d@sha256:<digest>
```

| 项目 | 约束 |
| --- | --- |
| `stable` | 未设置 `EDGEWEIR_VERSION` 时 `compose.yml` 的默认值；`deploy.sh` 把它解析为日期 tag 后固定 |
| `latest` | 仅用于评估环境 |
| digest | 手动发布会以同一 tag 推送新 digest；需要不可变引用时固定 digest |
| 自动更新 | 不使用 Watchtower 等工具或平台的自动更新无人值守地跟随渠道：启动时可能执行迁移，升级须在备份之后进行 |
| `docker run` | 版本由镜像引用的 tag 决定；`EDGEWEIR_VERSION` 不写入容器环境变量（镜像内该变量表示运行中的版本） |

## 校验镜像签名

```bash
cosign verify ghcr.io/marvinli001/edgeweir:<tag> \
  --certificate-identity https://github.com/marvinli001/edgeweir/.github/workflows/release.yml@refs/heads/master \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

gh attestation verify oci://ghcr.io/marvinli001/edgeweir:<tag> --repo marvinli001/edgeweir
```

证书身份是 `master` 分支上的 release 工作流；`stable` 与对应日期 tag 是同一 digest，签名相同。节点包与其他发布物的校验见 [安全策略](../../SECURITY.md)。

## 升级前检查

| 检查项 | 方法 |
| --- | --- |
| 当前版本 | 记录 `/healthz` 的 `version`，用于[降级](downgrade.md) |
| 发布说明 | 阅读当前版本之后每个 GitHub Release 的「兼容性」与「升级」，记录新增的迁移与需要的节点版本 |
| 数据库备份 | 按 [备份与恢复](backup.md) 备份，确认 `pg_restore --list` 可读取 |
| 密钥 | `EDGEWEIR_MASTER_KEY`（及设置过的 `BETTER_AUTH_SECRET`）有离线副本 |
| 签名 | 按上一节校验目标 tag |
| 节点 | **集群与节点** 中节点「在线」且「已同步」，记录各节点的「Agent / 引擎」版本 |
| 磁盘 | 数据库卷所在磁盘的剩余空间大于数据库大小：迁移可能重写表 |

## 升级

Docker Compose：

1. 完成 [升级前检查](#升级前检查)。
2. 修改 `EDGEWEIR_VERSION`：

   ```bash
   sed -i 's|^#* *EDGEWEIR_VERSION=.*|EDGEWEIR_VERSION=20260930-b2c3d4e|' .env
   ```

3. 拉取并重建：

   ```bash
   docker compose pull
   docker compose up -d
   ```

4. 按 [升级后验证](#升级后验证) 检查。

### 其他部署方式

| 部署 | 升级 | 详细步骤 |
| --- | --- | --- |
| 宝塔 / aaPanel（`deploy.sh`） | `./deploy.sh update`（`stable` 渠道）或 `./deploy.sh update <tag>`；先自动备份到 `backups/<时间>-before-<目标版本>/` | [deploy.sh 参考](deploy-script.md#update) |
| 宝塔 / aaPanel 面板 | 修改 `.env` 的 `EDGEWEIR_VERSION`，在面板中更新镜像（aaPanel **Update Image**）；面板不备份数据库，先手动备份 | [宝塔 / aaPanel](baota.md#升级与备份) |
| `docker run` | `docker pull ghcr.io/marvinli001/edgeweir:<新 tag>`；`docker rm -f edgeweir-console`；用相同参数与新 tag 重新创建 | [单独的容器](docker.md#不用-compose单独的容器) |
| Railway | `edgeweir` 服务 **Settings** 中的更新按钮，或 `railway redeploy --service edgeweir --from-source --yes` | [Railway](railway.md#升级) |
| Fly.io | 在 `fly.toml` 所在目录执行 `fly deploy` | [Fly.io](fly.md#升级) |
| bunny.net | 应用页面的 **Apply Update**，或经 `bunny api` 更新容器的 digest | [bunny.net](bunny.md#升级) |
| Render | 镜像地址改为新 tag，**Manual Deploy → Deploy latest reference** | [Render](render.md#升级) |
| Zeabur | **Settings → Service Image** 的 tag 改为新版本，或 `npx zeabur@latest service update tag -t <新 tag>` | [Zeabur](zeabur.md#升级) |
| 源码构建 | 检出目标提交，执行 `docker compose up -d --build` | — |

Railway、Render、bunny.net、Zeabur 先启动新实例，健康检查通过后停止旧实例：新旧版本短暂同时运行，旧实例上的节点通道连接断开后重连。

### 启动时的步骤

控制台每次启动按顺序执行下列步骤，任一步失败时进程以非 0 退出，容器按重启策略重启。

| 顺序 | 步骤 | 失败时的日志 |
| --- | --- | --- |
| 1 | 校验环境变量 | 每个问题一行 `invalid configuration: <变量>: <原因>` |
| 2 | 等待数据库，最多 60 秒 | `database not reachable yet`（带 `attempt`）；证书错误另带 `hint` |
| 3 | 执行未执行过的迁移：advisory lock 串行，全部迁移在一个事务中，多个实例同时启动安全 | 迁移的 SQL 错误；事务回滚，数据库保持升级前的 schema |
| 4 | 校验主密钥与数据库一致 | `EDGEWEIR_MASTER_KEY does not match this database` |
| 5 | 校验会话密钥 | `BETTER_AUTH_SECRET is not set, but this database was used with another secret` |
| 6 | 把未绑定记录 id 的旧格式密文重新加密 | `cannot upgrade a legacy envelope` |
| 7 | 主密钥轮换后，把旧主密钥加密的密文改用新主密钥 | `cannot re-seal an envelope of the previous master key` |
| 8 | 启动 Web、API、节点通道（`ROLE` 为 `all`、`app`）与 worker（`ROLE` 为 `all`、`worker`） | — |

| 规则 | 说明 |
| --- | --- |
| 迁移方向 | 只向前执行，无 down 脚本；回退见 [降级](downgrade.md) |
| 旧格式密文 | 新版本不再读取旧格式：多个控制台实例须同时升级 |
| 配置重新编译 | 升级改变了已存数据的编译结果时，worker 为每个集群发布一次配置（原因「升级后重新编译配置」）；发布失败的集群保留原版本，日志 `recompile after upgrade failed` |
| 节点 | 不随控制台升级，见 [节点升级](../guide/node-upgrades.md) |

## 升级后验证

| 检查项 | 通过条件 |
| --- | --- |
| 版本 | `curl -s http://127.0.0.1:3000/healthz` 返回 `{"status":"ok","version":"<新 tag>"}` |
| 容器 | `docker compose ps` 中 `console` 为 `healthy` |
| 迁移 | 日志含 `database migrated`，无 `level":"error"` 行：`docker compose logs console \| grep '"level":"error"'` 无输出 |
| worker | 日志含 `worker started` |
| 节点 | **集群与节点** 中节点「在线」，「已应用版本」为「已同步」 |
| 登录 | 用现有账户登录成功，两步验证可用 |

未通过时见 [故障排查](troubleshooting.md)，需要回退时见 [降级](downgrade.md)。

## 从多组织控制台升级

控制台只有一个账户，没有组织、成员、角色与单独的管理后台。从有多个组织或账户的版本升级时，迁移 `0033`–`0036` 在启动时自动执行。

升级前：

1. 备份数据库：这些迁移删除账户与组织数据，回退只能用升级前的备份恢复，见 [降级](downgrade.md)。
2. 确认最早创建、未被停用的平台管理员可以登录：升级后只有这个账户。
3. 检查待验证的域名：升级后它们直接参与路由，删除不应路由的域名。

| 对象 | 升级后 |
| --- | --- |
| 账户 | 最早创建、未被停用的平台管理员成为唯一的账户，沿用原密码、两步验证与通行密钥；其他账户连同会话、通行密钥与 AccessKey 被删除 |
| 告警订阅 | 其他账户的订阅并入保留的账户：每个渠道一条，包含这些订阅的网站，告警种类合并 |
| 数据 | 所有组织的网站、证书、DNS 凭据、封禁、IP 名单、规则、告警、统计与审计日志都保留 |
| IP 名单 | 组织的名单变为「供规则引用」；名称与已有名单重复时加后缀 `_<6 位十六进制>`，该组织网站规则中的引用随之改名 |
| 网站状态 | 只有启用与停用：处于其他下线状态的网站变为停用 |
| 域名 | 待验证的域名直接参与路由；同一域名在多个网站上时只保留一个：已验证的优先，否则保留最早添加的 |
| 删除的设置 | 组织技术限额、组织两步验证要求与默认集群、OWASP CRS 的组织开关、所有权校验 DNS 设置、服务账号中与组织有关的 scope |
| 环境变量 | 不再读取 `EDGEWEIR_DNS_RESOLVERS`，可从 `.env` 删除 |
| 配置 | worker 为每个集群重新发布一次配置，使原先未验证的域名与合并后的 IP 名单下发到节点 |
| 页面 | 书签 `/admin/<页面>` 跳转到对应页面（`/admin/settings` 跳转到 `/system`），其他 `/admin` 地址打开概览 |

| API 变化 | 接口 |
| --- | --- |
| 移除 | `organizations.*`、`members.*`、`invitations.*`、`users.*`、`admin.*`（含 `/admin/sites`、`/admin/organizations/{id}/limits`、`/admin/bans`）、`platformIpLists.*`（`/platform-ip-lists`）、`domainOwnership.*` 与 `/sites/{id}/ownership*`、`settings.waf`、`settings.dnsResolvers` |
| 字段 | 网站、封禁、证书、用量与审计记录不再包含组织字段 |
| 路径 | 节点升级为 `/api/v1/node-upgrades`、`/api/v1/node-releases/{version}`，不带 `/admin` 前缀；封禁只用 `/api/v1/bans`，IP 名单只用 `/api/v1/ip-lists` |
