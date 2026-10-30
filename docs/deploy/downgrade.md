# 降级

控制台与节点回退到先前版本的条件、步骤与风险；数据库迁移只向前执行，跨迁移的回退须用升级前的备份恢复。

## 回退条件

| 两个版本之间 | 回退方式 | 数据 |
| --- | --- | --- |
| 没有新增迁移 | 把镜像 tag 改回旧版本并重建容器，见 [直接回退](#直接回退) | 保留 |
| 有新增迁移 | 用升级前的备份恢复数据库，再以旧版本启动，见 [按备份回退](#按备份回退) | 备份之后的全部变更丢失 |

> [!WARNING]
> 控制台不检查数据库 schema 是否比镜像新：旧镜像连接已迁移的数据库时找不到待执行的迁移，照常启动，读写新增或改动的表时出错。不要在有新增迁移时只换回旧 tag。

## 迁移规则

| 项目 | 规则 |
| --- | --- |
| 位置 | `packages/db/migrations/<序号>_<名称>.sql`，顺序记录在 `packages/db/migrations/meta/_journal.json` |
| 执行记录 | 表 `drizzle.__drizzle_migrations`：每个已执行的迁移一行（`hash`、`created_at`） |
| 启动时 | 执行 `created_at` 晚于最后一条记录的迁移；全部在一个事务中，失败时回滚 |
| 方向 | 只向前；没有 down 脚本 |
| 发布说明 | `stable` 的 GitHub Release 在「兼容性」中列出该版本新增的迁移 |

## 判断是否新增迁移

方法一，在仓库检出中比较两个提交（提交 ID 为 tag 中 `-` 之后的部分）：

```bash
git diff --name-only <旧提交> <新提交> -- packages/db/migrations/
```

无输出表示没有新增迁移。

方法二，比较数据库已执行的迁移数与旧版本的迁移数：

```bash
docker compose exec -T postgres psql -U edgeweir -d edgeweir -Atc \
  'select count(*) from drizzle.__drizzle_migrations'
git show <旧提交>:packages/db/migrations/meta/_journal.json | jq '.entries | length'
```

两个数相等表示没有新增迁移；数据库的数大于旧版本的数表示有新增迁移。

## 直接回退

适用于两个版本之间没有新增迁移。

| 部署 | 操作 |
| --- | --- |
| Docker Compose | `.env` 的 `EDGEWEIR_VERSION` 改回旧 tag，执行 `docker compose up -d` |
| `deploy.sh` | `./deploy.sh update <旧 tag>`；目标早于当前版本时脚本警告并询问是否继续，默认否，见 [deploy.sh 参考](deploy-script.md#update) |
| `docker run` | 用相同参数与旧 tag 重新创建 `edgeweir-console` |
| Railway、Fly.io、bunny.net、Render、Zeabur | 镜像 tag 改为旧的日期 tag 后重新部署，见各平台文档的「升级」一节 |

验证：`curl -s http://127.0.0.1:3000/healthz` 的 `version` 为旧 tag。

## 按备份回退

适用于两个版本之间有新增迁移。需要升级前的数据库备份（`deploy.sh update` 自动写入 `backups/<时间>-before-<新 tag>/`）与备份时的主密钥。

### deploy.sh

1. `.env` 的 `EDGEWEIR_VERSION` 改回旧 tag。
2. 恢复升级前的备份：

   ```bash
   ./deploy.sh restore backups/<时间>-before-<新 tag>
   ```

   脚本先备份当前数据库，停止控制台，删除并重建数据库，导入备份，再以 `.env` 中的版本启动，见 [deploy.sh 参考](deploy-script.md#restore)。

### Docker Compose

1. 停止控制台：

   ```bash
   docker compose stop console
   ```

2. 备份当前数据库（回退失败时用它回到新版本）：

   ```bash
   umask 077
   docker compose exec -T postgres pg_dump -U edgeweir -d edgeweir --format=custom > edgeweir-after-upgrade.dump
   ```

3. 删除并重建数据库：

   ```bash
   docker compose exec -T postgres dropdb -U edgeweir --force edgeweir
   docker compose exec -T postgres createdb -U edgeweir edgeweir
   ```

4. 导入升级前的备份：

   ```bash
   docker compose exec -T postgres pg_restore -U edgeweir -d edgeweir --exit-on-error < edgeweir.dump
   ```

5. `.env` 的 `EDGEWEIR_VERSION` 改回旧 tag，启动：

   ```bash
   docker compose up -d
   ```

6. 按 [回退后验证](#回退后验证) 检查。

外部 PostgreSQL 与云平台的数据库按 [备份与恢复](backup.md#2-恢复) 恢复到新数据库，`DATABASE_URL` 指向它，再以旧 tag 部署。

### 丢失的数据

备份之后发生的以下变更不在恢复后的数据库中：

| 数据 | 恢复后 | 处理 |
| --- | --- | --- |
| 网站、规则、证书、DNS 等配置变更 | 回到备份时的状态 | 重新操作 |
| 备份之后注册的节点 | 数据库中没有该节点，节点无法连接 | 在节点上用新的安装命令加 `--force` 重新注册 |
| 备份之后签发或续期的证书 | 数据库中为备份时的证书，下一次配置发布后节点改用它 | 备份之后新申请的证书重新申请；临近到期的证书点击「立即续期」 |
| 审计日志、访问日志、统计、告警记录 | 缺少备份之后的部分 | — |
| 配置版本号 | 节点已应用的版本可能高于数据库中的最新版本 | 发布一次配置，见 [节点重新同步](backup.md#3-节点重新同步) |

## 回退后验证

| 检查项 | 通过条件 |
| --- | --- |
| 版本 | `/healthz` 返回 `"status":"ok"`，`version` 为旧 tag |
| 迁移数 | `drizzle.__drizzle_migrations` 的行数等于旧版本 `_journal.json` 的条目数 |
| 日志 | `docker compose logs console` 无 `"level":"error"` 行 |
| 节点 | **集群与节点** 中节点「在线」；发布一次配置后为「已同步」 |

## 节点回退

节点版本独立于控制台，控制台降级不要求回退节点。

| 方式 | 条件与步骤 |
| --- | --- |
| 自动回滚 | 签名升级的候选程序 90 秒内未通过健康检查时，监督进程恢复上一版程序、Lua 与配置快照，不需要操作，见 [监督进程与回滚](../guide/node-upgrades.md#监督进程与回滚) |
| 升级任务安装旧版本 | 节点默认拒绝比当前旧的版本（「版本 … 未通过升级检查，保留原版本」）。在节点的 `/etc/default/edgeweir-node` 中设置 `EDGEWEIR_UPGRADE_ALLOW_DOWNGRADE=true`，执行 `systemctl restart edgeweir-node`；全部节点都不低于目标版本时控制台的「发起升级」不能提交，经 API `POST /api/v1/node-upgrades`（`version`、`nodeGroupId`）发起。完成后删除该设置 |
| 重装旧版本软件包或镜像 | 监督进程发现基础安装变化后改用新安装的程序与 Lua；尚未确认的升级任务记为「版本 … 的任务因本机软件包更新而终止」 |

节点的身份密钥、证书、凭据与统计游标不随程序回退而倒退。回退到缺少集群当前配置所需能力的版本后，该节点显示「需要升级」，按最后可用配置服务。

## 风险

| 风险 | 说明 |
| --- | --- |
| 只换回旧 tag | 有新增迁移时旧代码运行在新 schema 上，请求与后台任务出错；数据可能写入不一致 |
| 数据丢失 | 按备份回退丢失备份之后的全部变更，见 [丢失的数据](#丢失的数据) |
| 主密钥 | 恢复需要备份时的主密钥；备份后轮换过主密钥时，把旧主密钥设为 `EDGEWEIR_MASTER_KEY_PREVIOUS`，见 [主密钥轮换](maintenance.md#主密钥轮换) |
| 会话密钥 | `BETTER_AUTH_SECRET` 须与备份时一致；不同则全部会话失效，两步验证无法验证 |
| 多实例 | 全部控制台实例同时回退；不同版本的实例不能共用一个数据库 |
| 安全修复 | 旧版本缺少之后发布的安全修复 |
| 节点能力 | 旧控制台不认识新节点上报的新能力，不影响连接 |
