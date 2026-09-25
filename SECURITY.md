# 安全策略

[English summary](#english)

本策略适用于 [edgeweir/edgeweir](https://github.com/edgeweir/edgeweir)（控制面）和 [edgeweir/edgeweir-node](https://github.com/edgeweir/edgeweir-node)（边缘节点）两个仓库，以及它们的官方镜像和发布物。设计依据见 [ADR-0018](docs/adr/0018-trust-and-security-baseline.md)。

## 信任基线

以下规则是硬性约束，两个仓库的代码都必须遵守。

1. **没有 phone-home。** 控制面和节点不主动连接 Edgeweir 项目的任何服务器（edgeweir.com、edgeweir.dev 等），版本检查也不例外。
2. **没有授权校验。** 代码中没有许可证密钥、联网授权或功能锁。
3. **遥测默认关闭。** 只有管理员显式开启后才发送，开启界面列出将要发送的字段和目的地址。
4. **敏感数据信封加密后入库。** 内部 CA 私钥、ACME 账户私钥、证书私钥、DNS 服务商 API 密钥、SSH 凭据（仅在运营者明确选择保存时）等，用主密钥 `EDGEWEIR_MASTER_KEY` 做信封加密：每条记录一个随机数据密钥，数据和数据密钥都用 AES-256-GCM 加密，附加认证数据绑定表、字段和记录 id。一次性注册 token、API key、用户密码只存哈希。
5. **所有管理操作写审计日志。** 写操作、登录与认证事件、初始化、安装命令生成、节点注册与删除都写入 `audit_log`，与业务变更在同一事务内提交，不记录密钥明文。
6. **发布物可验证。** 所有发布物都用 cosign keyless 签名，附 SBOM 和 SLSA provenance；CI 构建产物与源码一一对应，构建可复现（[ADR-0017](docs/adr/0017-release-supply-chain.md)）。

## 支持的版本

1.0 之前只支持 `master` 分支的最新代码。安全修复只进入 `master`，不回移到旧版本或旧的预发布版本。

| 版本 | 是否支持 |
| --- | --- |
| `master` 最新代码 | 支持 |
| 其他任何版本 | 不支持 |

1.0 发布时会更新本节，写明各版本的支持周期。

## 报告漏洞

**请不要通过公开 issue、讨论区或 PR 报告安全漏洞。**

报告渠道（任选其一）：

- 邮件：[security@edgeweir.dev](mailto:security@edgeweir.dev)
- GitHub 私密安全公告：[控制面](https://github.com/edgeweir/edgeweir/security/advisories/new)、[节点](https://github.com/edgeweir/edgeweir-node/security/advisories/new)

请尽量提供：

- 受影响的组件，以及版本或提交哈希；
- 复现步骤或概念验证代码；
- 影响评估（可以达成什么效果，需要什么前提条件）；
- 漏洞是否已经公开，或是否已知被利用。

处理流程：

1. **3 个工作日内**确认收到报告。
2. 完成评估后告知初步结论和修复计划，处理期间同步进展。
3. **90 天协调披露**：从收到报告之日起算。修复发布后公开安全公告，经报告者同意会在公告中致谢。
4. 90 天内无法修复时，与报告者协商延期；漏洞已被在野利用时，可能提前披露缓解措施。

## 验证发布物

> 目前还没有正式发布。以下步骤从第一个正式发布开始适用。签名文件的确切名称以 Release 页面为准。

所有签名都是 cosign keyless 签名：证书身份是对应仓库的 release 工作流，签发者是 GitHub Actions 的 OIDC 服务。验证需要安装 [cosign](https://github.com/sigstore/cosign)，验证 provenance 还需要 [GitHub CLI](https://cli.github.com/)。

### 节点包（deb、rpm、tar.gz）

从 [edgeweir-node 的 Release 页面](https://github.com/edgeweir/edgeweir-node/releases) 下载要安装的包、`checksums.txt` 和它的签名 bundle，然后执行：

```sh
# 1. 验证 checksums.txt 由 edgeweir-node 的 release 工作流在某个 v* tag 上签名
cosign verify-blob \
  --bundle checksums.txt.sigstore.json \
  --certificate-identity-regexp '^https://github\.com/edgeweir/edgeweir-node/\.github/workflows/release\.yml@refs/tags/v.*$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  checksums.txt

# 2. 验证下载的包与 checksums.txt 一致（macOS 用 shasum -a 256 -c）
sha256sum -c checksums.txt --ignore-missing

# 3. （可选）验证构建来源证明
gh attestation verify edgeweir-node_<版本>_linux_amd64.tar.gz --repo edgeweir/edgeweir-node
```

第 1、2 步都通过后再安装。一键安装脚本 `install.sh` 在执行任何下载的程序之前会自动完成同样的校验（[ADR-0016](docs/adr/0016-one-line-install.md)）。

### 控制面镜像

```sh
cosign verify ghcr.io/edgeweir/edgeweir:<tag> \
  --certificate-identity-regexp '^https://github\.com/edgeweir/edgeweir/\.github/workflows/release\.yml@refs/tags/v.*$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

gh attestation verify oci://ghcr.io/edgeweir/edgeweir:<tag> --repo edgeweir/edgeweir
```

验证通过后，建议在 compose 文件中按 digest（`ghcr.io/edgeweir/edgeweir@sha256:...`）固定镜像，而不是只写 tag。

### 从源码重建

检出发布对应的 tag，使用 `go.mod` 中固定的 Go 版本执行与 CI 相同的 goreleaser 构建，得到的二进制 sha256 应与发布物一致。构建可复现的做法见 [ADR-0017](docs/adr/0017-release-supply-chain.md)。

## 威胁模型要点

| 设计 | 防范的问题 | 依据 |
| --- | --- | --- |
| 控制面默认不保存节点 SSH 凭据；SSH 远程安装是可选的一次性操作，凭据用完即弃 | 控制面失陷后借 SSH 凭据横向控制所有节点（GoEdge 2025 年 RingH23 事件） | [ADR-0016](docs/adr/0016-one-line-install.md) |
| 节点私钥在节点本地生成，从不离开节点；控制面只签发证书 | 控制面数据库泄露后冒充节点 | [ADR-0008](docs/adr/0008-node-channel-connect-rpc-mtls.md) |
| 节点通道：安装命令固定 CA 指纹，节点先核对指纹再发送 token；token 一次性、带过期时间、只存哈希；除 `Enroll` 外强制 mTLS；证书 30 天有效期并自动轮换；删除或禁用节点立即生效（删除时吊销证书序列号，节点再连接被拒绝） | 首次连接被中间人劫持；token 泄露或重放；已下线节点继续拉配置 | [ADR-0008](docs/adr/0008-node-channel-connect-rpc-mtls.md) |
| 敏感数据信封加密入库，主密钥不进数据库 | 数据库备份或只读 SQL 注入泄露证书私钥和 DNS 密钥 | [ADR-0018](docs/adr/0018-trust-and-security-baseline.md) |
| 管理操作写审计日志，与变更同事务提交 | 越权或误操作无法追溯 | [ADR-0018](docs/adr/0018-trust-and-security-baseline.md) |
| 客户端 IP 取 TCP 对端地址；`X-Forwarded-For` / `X-Real-IP` 只在对端属于 `EDGEWEIR_TRUSTED_PROXIES` 时采用；登录、2FA 等认证接口的限速计数存 PostgreSQL，多实例共享、重启不清零 | 伪造 IP 绕过登录与 2FA 限速，审计日志里的 IP 失真 | [ADR-0018](docs/adr/0018-trust-and-security-baseline.md) |
| `install.sh` 与 agent 自升级都先校验 cosign 签名和 sha256 再执行；控制台镜像转发只是传输通道 | 下载链路或镜像转发被篡改 | [ADR-0016](docs/adr/0016-one-line-install.md)、[ADR-0017](docs/adr/0017-release-supply-chain.md) |
| agent 只执行类型化操作，不提供执行任意命令的接口 | 控制面失陷后在节点上执行任意代码 | [ADR-0014](docs/adr/0014-node-agent-responsibilities.md) |
| 发布物 keyless 签名、SBOM、SLSA provenance、可复现构建 | 发布的二进制与源码不一致，或被投毒 | [ADR-0017](docs/adr/0017-release-supply-chain.md) |

已知限制：

- `install.sh` 由控制台提供，信任控制台（运营者自己的服务器）是前提。需要更强保证时，先下载脚本审阅，或与 GitHub 上同版本的脚本比对。
- 控制面被攻破时，攻击者可以下发恶意配置（例如把站点指向恶意源站），但不能让节点运行未签名的程序，也拿不到节点私钥。
- 主密钥与数据库同时泄露时，信封加密失去作用。请通过 secret 文件或编排平台的 secret 机制注入 `EDGEWEIR_MASTER_KEY`，并与数据库备份分开保存。
- 首次初始化需要控制台启动时打印在日志里的一次性 setup token（主密钥加密后入库，只比对 SHA-256）。能读控制台日志的人就能完成初始化，请像对待主密钥一样控制日志的访问。
- 节点通道 `:8443` 不能放在反向代理后面由代理终结 TLS，否则 mTLS 失效；只能直接暴露或四层透传。

---

<a id="english"></a>

## English

This policy covers [edgeweir/edgeweir](https://github.com/edgeweir/edgeweir) (console), [edgeweir/edgeweir-node](https://github.com/edgeweir/edgeweir-node) (edge node), and their official images and release artifacts.

**Trust baseline.** No phone-home of any kind and no licence-check code. Telemetry is off by default and requires explicit opt-in. Secrets (CA key, certificate keys, DNS API credentials, optionally saved SSH credentials) are envelope-encrypted with `EDGEWEIR_MASTER_KEY` (AES-256-GCM, a random data key per record) before they reach the database. Every management action is written to an audit log. Every release is signed with cosign keyless, ships with an SBOM and SLSA provenance, and is built reproducibly from the tagged source.

**Supported versions.** Before 1.0, only the latest `master` is supported. Security fixes land on `master` only.

**Reporting a vulnerability.** Do not open a public issue. Email [security@edgeweir.dev](mailto:security@edgeweir.dev) or open a private advisory on GitHub ([console](https://github.com/edgeweir/edgeweir/security/advisories/new), [node](https://github.com/edgeweir/edgeweir-node/security/advisories/new)). We acknowledge reports within 3 working days and follow a 90-day coordinated disclosure window, counted from the day we receive the report.

**Verifying releases.** Node packages: verify `checksums.txt` with `cosign verify-blob`, pinning the certificate identity to the `edgeweir/edgeweir-node` release workflow on a `v*` tag and the issuer to `https://token.actions.githubusercontent.com`, then run `sha256sum -c checksums.txt --ignore-missing`. Console image: `cosign verify ghcr.io/edgeweir/edgeweir:<tag>` with the same kind of identity pinning, and `gh attestation verify` for provenance. The exact commands are in [验证发布物](#验证发布物) above.
