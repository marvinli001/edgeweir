# 备份与恢复

备份分成两份保存：PostgreSQL 数据，以及独立保管的 `EDGEWEIR_MASTER_KEY`、`BETTER_AUTH_SECRET` 和部署配置。数据库中包含已加密的 CA、证书及通知凭据；只有数据库备份而丢失主密钥，无法解密它们。备份文件仍包含账户信息及日志，应限制读取权限。

## 制作备份

使用与服务器同主版本的 PostgreSQL 工具，凭据通过受限的 `.pgpass` 或环境注入，不放进命令行或 Git。

```sh
umask 077
pg_dump --format=custom --file=edgeweir.dump --dbname=edgeweir
pg_restore --list edgeweir.dump > edgeweir.dump.list
```

另行备份 ClickHouse（若启用），以及节点的私有状态目录 `/var/lib/edgeweir-node`。缓存目录可以重建。节点私钥留在节点备份内，不上传到控制台。主密钥备份应与数据库备份分开保存并确认可取回。

## 恢复到新数据库

```sh
createdb edgeweir_restored
pg_restore --exit-on-error --dbname=edgeweir_restored edgeweir.dump
```

先在隔离环境验证。为恢复后的控制台配置原来的主密钥、认证 secret、节点通道地址和新的 `DATABASE_URL`，使用与备份匹配或支持其迁移的控制台版本启动。一次只允许一个恢复环境对真实 DNS 和通知渠道执行后台任务；演练使用本地模拟服务。

数据库里的 CA 恢复后，已注册节点仍可通过 mTLS 连接。等待节点的首次新心跳，再发布配置。控制台在每次发布时取「数据库最新 revision」与「本集群节点上报的最大 applied_revision」的较大值加一；即便内容没有改变，只要节点版本领先，也会生成更高序号。这样恢复旧备份不会让节点永久停在 last-known-good。不能用恢复前的陈旧心跳代替这一步。

验收需要同时检查：节点在线、数据面健康、节点 applied_revision 与控制台最新 revision 相同、内容哈希相同、实际 HTTP/HTTPS 请求成功。恢复成功后保留旧数据库，按自己的备份保留策略再处理。

ClickHouse 与 PostgreSQL 必须来自同一恢复点，或使用新的 ClickHouse 数据库开始写入。恢复旧的 PostgreSQL 游标而继续复用较新的 ClickHouse 表，可能与之前的批次序号冲突。跨存储恢复不自动完成，不能仅用 PostgreSQL 恢复结果宣称 ClickHouse 也已恢复。

## 可复现演练

`node scripts/e2e-restore.mjs` 只针对 `compose.e2e.yml` 的测试数据库：制作真实 pg_dump，先让节点应用高于备份的 revision，创建新数据库并执行 pg_restore，切换控制台连接，收到新心跳后发布相同内容，确认节点继续接受更高 revision。脚本随后切回原测试数据库并重新同步，保留恢复数据库供检查。

本轮本地结果：备份 revision 92 → 节点 93 → 新库恢复后的发布 94，节点在线、健康、版本与内容哈希一致。证据在 `.e2e/restore-result.json`；测试数据和凭据不能用于正式部署。
