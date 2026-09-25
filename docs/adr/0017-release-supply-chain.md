# ADR-0017: 发布与供应链

- 状态：已接受
- 日期：2026-09-25
- 适用仓库：两者

## 背景

GoEdge 发布的二进制与源码不一致，用户无法验证手里的程序是否来自公开源码，后来又出现了官方二进制被投毒的事件。节点 agent 以 root 运行，二进制一旦被篡改，所有边缘节点都会失陷。"可验证的信任"是 Edgeweir 的第一卖点，发布流程必须让任何人都能独立验证。

## 决策

1. **edgeweir-node 用 goreleaser 2 发布：**
   - 目标平台：linux/amd64、linux/arm64。
   - 产物：tar.gz、deb、rpm（由 nfpm 生成，含 systemd 单元），以及 checksums 文件。
   - 编译：`CGO_ENABLED=0`、`-trimpath`，版本信息通过 `-ldflags -X` 注入。
2. **签名：cosign keyless（Sigstore）。** CI 使用 GitHub Actions 的 OIDC 身份对 checksums 文件签名。签名证书中记录了仓库、工作流文件和 tag，签名记录写入 Rekor 透明日志。不存在可被窃取的长期签名私钥。
3. **SBOM**：syft 为每个归档和包生成 SBOM，随 Release 发布。
4. **SLSA provenance**：在 CI 中生成构建来源证明。默认使用 `actions/attest-build-provenance`（GitHub artifact attestations，可以用 `gh attestation verify` 校验，达到 SLSA v1.0 Build L2；构建放在可复用工作流中执行可达到 L3）。需要更强的构建隔离时，换用 `slsa-github-generator`。
5. **可复现构建：**
   - `-trimpath` 去掉本机路径。
   - 时间戳统一取提交时间：goreleaser 的 `mod_timestamp` 使用 `{{ .CommitTimestamp }}`，其他工具使用 `SOURCE_DATE_EPOCH`。
   - Go 工具链版本在 `go.mod` 中固定。
   - 目标：任何人用同一个 tag 和同一个工具链，都能重建出 sha256 相同的二进制。
6. **本地 snapshot 构建**（`goreleaser release --snapshot`）跳过签名，因为 keyless 签名需要 CI 的 OIDC 身份；SBOM 照常生成。edgeweir-node 的 CI 在每次提交时运行 snapshot 构建。
7. **控制面镜像** `ghcr.io/edgeweir/edgeweir`（Docker Hub 同名 `edgeweir/edgeweir`）：多架构构建（amd64、arm64），cosign keyless 签名，附 provenance 与 SBOM attestation。edgeweir-node 若发布镜像（`ghcr.io/edgeweir/edgeweir-node`），规则相同。
8. **每个 Release 附校验说明**，命令见 [SECURITY.md](../../SECURITY.md)。

## 备选方案与取舍

- **GPG 签名**：需要保管长期私钥，泄露或丢失都难以处理；用户侧的公钥分发和信任建立也很麻烦。
- **cosign 基于密钥的签名**：同样有长期私钥的保管问题。
- **维护者本机构建后上传**：无法证明产物来自哪份源码、哪次构建。
- **只发布 sha256**：同源替换即可绕过。

## 后果

### 正面

- 任何人都能验证一个产物来自 `edgeweir/edgeweir-node`（或 `edgeweir/edgeweir`）的哪个工作流、哪个 tag。
- 签名记录公开，可审计。
- 可以用源码重建并比对。

### 负面

- 依赖 GitHub Actions 和 Sigstore 公共基础设施。
- 用户验证时需要安装 cosign（或 `gh`）。
- deb、rpm 和压缩包的逐字节可复现还受文件元数据、压缩实现等因素影响，需要持续验证；二进制本身的可复现是第一目标。

## Phase 0 落地情况

Phase 0 范围：

- edgeweir-node 的 goreleaser 配置：deb、rpm、tar.gz，amd64 与 arm64，cosign 签名与 SBOM。
- edgeweir-node 的 CI 运行 goreleaser snapshot。
- 控制面 CI 构建镜像（不推送、不签名）。

后续：

- 首个正式 tag 之前完成两个仓库的 release 工作流（签名、provenance、推送镜像），并按 SECURITY.md 演练一遍校验命令。
- 独立重建比对，并在文档中记录步骤。

## 版本核实

核实日期：2026-09-25。来源：proxy.golang.org。

| 组件 | 版本 | 来源 |
| --- | --- | --- |
| goreleaser | 2.18.2 | proxy.golang.org（github.com/goreleaser/goreleaser） |
| syft | 1.52.0 | proxy.golang.org（github.com/anchore/syft） |
| cosign | 3.1.3 | proxy.golang.org（github.com/sigstore/cosign） |
| Go | 1.27.1 | proxy.golang.org（golang.org/toolchain） |

> 更新记录：
> - 2026-09-25：GoReleaser 的 `signs.if` 是 Pro 功能，开源版的 `cmd` 也不支持模板。因此签名配置用 `cmd: sh` + 模板化参数：snapshot 构建只打印跳过信息，正式发布执行 `cosign sign-blob --yes --bundle=checksums.txt.sigstore.json checksums.txt`。SBOM 由 syft 为归档和 deb/rpm 生成。本机没有 git remote 时，GoReleaser snapshot 使用占位的 commit 信息（`0.0.1-snapshot+none`），CI 中是真实值。
> - 2026-09-25（收尾）：
>   - **Go 工具链固定到补丁版本（决策第 5 条）。** edgeweir-node 的 `go.mod` 从 `go 1.27` 改为 `go 1.27.1`，CI 的 setup-go 读取它，本地构建和 CI 用同一个工具链。控制台 `helpers/certd/go.mod` 仍是 `go 1.27`（镜像构建用 `golang:1.27.1-alpine`，但 CI 的 setup-go 读 go.mod），同样要改成 `go 1.27.1`。
>   - **首次发布前按 digest / SHA 固定（延后项 D5）。** 目前容器基础镜像只按 tag 固定（`node:24.21.0-alpine`、`golang:1.27.1-alpine`、`openresty/openresty:1.31.1.1-bookworm`、`postgres:18.6-alpine` 等），GitHub Actions 只按主版本 tag 引用（`actions/checkout@v7`、`sigstore/cosign-installer@v4`、`goreleaser/goreleaser-action@v7` 等）。tag 可以被移动，不满足"同一个 tag、同一个工具链重建出相同产物"。首个正式 tag 之前，两个仓库的 Dockerfile、compose 文件和工作流改为按 digest（`image@sha256:...`）和完整 commit SHA（`uses: owner/action@<40 位 SHA> # vX.Y.Z`）固定；列入 [ROADMAP.md](../../ROADMAP.md)「首次发布前」。
