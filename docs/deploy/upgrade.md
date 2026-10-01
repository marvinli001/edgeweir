# 版本、升级与回滚

控制台镜像的版本规则、版本固定、签名校验、升级与回滚。

## 版本规则

| 项目 | 规则 |
| --- | --- |
| 镜像 | `ghcr.io/marvinli001/edgeweir`，linux/amd64、linux/arm64，公开拉取 |
| tag | `<YYYYMMDD>-<commit>`：UTC 提交日期与提交 ID 前 7 位，例如 `20260929-a1b2c3d`；同一提交始终得到同一 tag（`scripts/image-version.sh`） |
| 发布 | `master` 上的推送通过 CI 后，release 工作流构建 CI 验证过的提交并推送其 tag；不使用语义化版本号 |
| `latest` | 仅在该提交仍是 `master` 最新提交时移动，不回退 |
| 手动发布 | 重建 `master` 最新提交，以同一 tag 推送新的 digest |
| 源码构建 | 版本为 `dev` |
| 镜像标签 | `org.opencontainers.image.version` 为 tag；`org.opencontainers.image.revision` 为完整提交 ID |
| 签名 | cosign keyless 签名，附 SBOM 与 SLSA provenance |
| 全部 tag | [GitHub Packages](https://github.com/marvinli001/edgeweir/pkgs/container/edgeweir)；tag 中的提交改动见 `https://github.com/marvinli001/edgeweir/commit/<提交 ID>` |

边缘节点使用独立的 `vX.Y.Z` 版本，升级见 [节点升级](../guide/node-upgrades.md)。

## 查看版本

| 对象 | 命令或位置 |
| --- | --- |
| 运行中的版本 | `curl -s http://127.0.0.1:3000/healthz` 的 `version`；**系统设置** 的「系统信息」中的「版本」 |
| `latest` 对应的 tag | `docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' ghcr.io/marvinli001/edgeweir:latest`（拉取后执行） |
| tag 的 digest | `docker buildx imagetools inspect ghcr.io/marvinli001/edgeweir:<tag>` 输出的 `Digest` |

## 固定版本

在 `.env` 中固定日期 tag，或连同 digest 固定：

```bash title=".env"
EDGEWEIR_VERSION=20260929-a1b2c3d
# EDGEWEIR_VERSION=20260929-a1b2c3d@sha256:<digest>
```

| 项目 | 约束 |
| --- | --- |
| `latest` | 仅用于评估环境。 |
| digest | 手动发布会以同一 tag 推送新 digest；需要不可变引用时固定 digest。 |
| 自动更新 | 不使用 Watchtower 等工具无人值守地跟随 `latest`：每次启动都可能执行迁移，升级在备份之后进行。 |
| `docker run` | 版本由镜像引用的 tag 决定；`EDGEWEIR_VERSION` 不写入容器环境变量。 |

## 校验镜像签名

```bash
cosign verify ghcr.io/marvinli001/edgeweir:<tag> \
  --certificate-identity https://github.com/marvinli001/edgeweir/.github/workflows/release.yml@refs/heads/master \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

gh attestation verify oci://ghcr.io/marvinli001/edgeweir:<tag> --repo marvinli001/edgeweir
```

证书身份是 `master` 分支上的 release 工作流。节点包与其他发布物的校验见 [SECURITY.md](../../SECURITY.md)。

## 升级

Docker Compose：

1. 备份数据库与 `.env`，见 [备份与恢复](backup.md)。
2. 按上一节校验新 tag 的签名。
3. 修改 `EDGEWEIR_VERSION`：

   ```bash
   sed -i 's|^#* *EDGEWEIR_VERSION=.*|EDGEWEIR_VERSION=20260930-b2c3d4e|' .env
   ```

4. 拉取并重建：

   ```bash
   docker compose pull
   docker compose up -d
   ```

5. 验证：

   ```bash
   curl -s http://127.0.0.1:3000/healthz
   docker compose ps
   ```

   预期：`version` 为新 tag；`console` 为 `healthy`。

启动时的行为：

| 行为 | 说明 |
| --- | --- |
| 数据库迁移 | 启动时执行，advisory lock 串行，多实例同时启动安全。迁移只向前执行，无 down 脚本。 |
| 旧格式密文 | 旧版本写入、未绑定记录 id 的信封密文在启动时用主密钥重新加密；新版本不再读取旧格式，多个控制台实例须同时升级。 |
| 节点 | 不随控制台升级，见 [节点升级](../guide/node-upgrades.md)。 |

其他部署方式：

| 部署 | 升级 |
| --- | --- |
| `deploy.sh` | `./deploy.sh update` 或 `./deploy.sh update <tag>`，先自动备份，见 [deploy.sh 参考](deploy-script.md)。 |
| `docker run` | `docker pull ghcr.io/marvinli001/edgeweir:<新 tag>`，`docker rm -f edgeweir-console`，用相同参数与新 tag 重新创建；数据在 `edgeweir-postgres` 卷中。 |
| 源码构建 | 检出目标提交，执行 `docker compose up -d --build`。 |

## 从多组织控制台升级

控制台只有一个账户，没有组织、成员、角色与单独的管理后台。从有多个组织或账户的版本升级时，迁移 `0033`–`0036` 在启动时自动执行。

升级前：

1. 备份数据库：这些迁移删除账户与组织数据，回滚只能用升级前的备份恢复，见[回滚](#回滚)。
2. 确认最早创建、未被停用的平台管理员可以登录：升级后只有这个账户。
3. 检查待验证的域名：升级后它们直接参与路由，删除不应路由的域名。

迁移结果：

| 对象 | 升级后 |
| --- | --- |
| 账户 | 最早创建、未被停用的平台管理员成为唯一的账户，沿用原密码、两步验证与通行密钥；其他账户连同会话、通行密钥与 AccessKey 被删除 |
| 告警订阅 | 其他账户的订阅并入保留的账户：每个网站与渠道一条，告警种类合并 |
| 数据 | 所有组织的网站、证书、DNS 凭据、封禁、IP 名单、规则、告警、统计与审计日志都保留 |
| IP 名单 | 组织的名单变为「供规则引用」（此前只有平台的放行与拦截名单在边缘生效）；名称与已有名单重复时加后缀 `_<6 位十六进制>`，该组织网站规则中的引用随之改名 |
| 暂停的网站 | 变为停用 |
| 域名 | 待验证的域名直接参与路由；同一域名在多个网站上时只保留一个：已验证的优先，否则保留最早添加的 |
| 删除的设置 | 组织技术限额、组织两步验证要求与默认集群、「允许租户开启 OWASP CRS」开关、「所有权校验 DNS」设置、服务账号中与组织有关的 scope |
| 环境变量 | 不再读取 `EDGEWEIR_DNS_RESOLVERS`，可从 `.env` 删除 |
| 配置 | worker 为每个集群重新发布一次配置（原因「升级后重新编译配置」），使原先未验证的域名与合并后的 IP 名单下发到节点；发布失败的集群保留原版本，控制台日志记录 `recompile after upgrade failed`，下一次修改该集群的配置时更新 |

原 `/admin/*` 页面并入同一个控制台：书签 `/admin/<页面>` 跳转到对应页面（`/admin/settings` 跳转到 `/system`），其他 `/admin` 地址打开概览。

API 变化，使用这些接口的集成需要修改：

| 变化 | 接口 |
| --- | --- |
| 移除 | `organizations.*`、`members.*`、`invitations.*`、`users.*`、`admin.*`（含 `/admin/sites` 的暂停与恢复、`/admin/organizations/{id}/limits`、`/admin/bans`）、`platformIpLists.*`（`/platform-ip-lists`）、`domainOwnership.*` 与 `/sites/{id}/ownership*`、`settings.waf`、`settings.dnsResolvers` |
| 字段 | 网站、封禁、证书、用量与审计记录不再包含组织字段 |
| 路径 | 节点升级为 `/api/v1/node-upgrades`、`/api/v1/node-releases/{version}`，不带 `/admin` 前缀；封禁只用 `/api/v1/bans`，IP 名单只用 `/api/v1/ip-lists` |

## 回滚

1. 检查两个版本之间是否新增迁移（在仓库检出中执行，提交 ID 取自 tag）：

   ```bash
   git diff --name-only <旧提交> <新提交> -- packages/db/migrations/
   ```

2. 按结果回滚：

   | 结果 | 回滚方式 |
   | --- | --- |
   | 无输出：未新增迁移 | 将 `EDGEWEIR_VERSION` 改回旧 tag，执行 `docker compose up -d`。`deploy.sh` 部署执行 `./deploy.sh update <旧 tag>`。 |
   | 列出迁移文件 | 用升级前的备份恢复，以旧 tag 启动，见 [备份与恢复](backup.md)。 |

3. 验证：`curl -s http://127.0.0.1:3000/healthz` 的 `version` 为旧 tag。
