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
| 运行中的版本 | `curl -s http://127.0.0.1:3000/healthz` 的 `version`；**后台 → 系统设置** 「系统信息」中的「版本」 |
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
