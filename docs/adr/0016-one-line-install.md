# ADR-0016: 节点一键安装

- 状态：已接受
- 日期：2026-09-25
- 适用仓库：两者

## 背景

- 节点接入要尽量简单：运营者在控制台点一下，把一条命令复制到节点上执行。
- 国内服务器访问 GitHub Releases 慢且不稳定。
- GoEdge 的做法是控制面保存节点的 SSH root 凭据，由控制面远程安装和管理节点。2025 年的 RingH23 攻击正是借助这些凭据，把恶意程序横向投放到所有边缘节点。
- `curl | bash` 本身有风险：脚本和它下载的二进制都必须可以验证。

## 决策

1. **命令形态：**

   ```sh
   curl -fsSL https://<控制台>/install.sh | sudo bash -s -- --token <一次性token> --ca-sha256 <CA指纹> ...
   ```

   `install.sh` 由控制台提供（`:3000`，或其反向代理后的地址）。控制台生成的完整命令还包含节点通道地址等参数；token 与 CA 指纹的含义见 [ADR-0008](0008-node-channel-connect-rpc-mtls.md)。
2. **install.sh 的行为：**
   1. 脚本主体全部包在函数里，最后一行才调用，下载中断时不会执行半截脚本；开启 `set -euo pipefail`。
   2. 检测环境：systemd、发行版、CPU 架构（amd64 或 arm64）。
   3. 下载 edgeweir-node 发布物：默认经控制台的镜像转发地址下载（适合国内网络），也可以指定直接从 GitHub Releases 下载。
   4. **先校验，后执行**：用 cosign 校验 checksums 文件的 keyless 签名，证书身份固定为 `edgeweir/edgeweir-node` 仓库的发布工作流，签发者固定为 GitHub Actions OIDC；再用 sha256 校验下载的包。任何一步失败立即退出，不安装、不执行任何下载的程序。
   5. 安装 edgeweir-node 包（deb、rpm 或 tar.gz）和 OpenResty，写入 systemd 单元。
   6. 用 token 和 `--ca-sha256` 执行注册，启动服务。
3. **控制台镜像转发只是传输通道，不是信任来源。** 经控制台转发的文件必须通过与直连 GitHub 相同的签名和哈希校验，被篡改的文件无法通过校验。
4. **可以先下载再执行**：

   ```sh
   curl -fsSLo install.sh https://<控制台>/install.sh
   less install.sh
   sudo bash install.sh --token <一次性token> --ca-sha256 <CA指纹> ...
   ```

5. **SSH 远程安装是可选的一次性操作。** 管理员在控制台输入 SSH 凭据，控制台连接节点，执行与上面相同的安装命令；完成后凭据从内存中丢弃，默认不写入数据库，也不写入日志。运营者明确选择保存时，凭据用主密钥信封加密后入库（[ADR-0018](0018-trust-and-security-baseline.md)），保存和使用都写审计日志。

## 备选方案与取舍

- **控制面长期保存 SSH 凭据并常驻管理节点（GoEdge）**：控制面一旦失陷，攻击者就拿到所有节点的 root 权限。见背景。
- **只从 GitHub 下载**：国内网络下安装经常失败或极慢。
- **只校验 sha256，不校验签名**：sha256 与文件来自同一来源时，篡改者可以把两者一起替换。
- **通过发行版软件源（apt/yum 仓库）分发**：要维护多个仓库和 GPG 密钥，后续可以作为补充渠道。
- **默认以容器方式运行节点**：CDN 节点对网络性能和端口敏感，host 网络、缓存盘挂载会增加部署复杂度。可以作为补充方式，不作为默认。

## 后果

### 正面

- 节点接入不需要控制面保存任何节点凭据。
- 国内网络可用。
- 安装的二进制可以验证来自哪个仓库的哪个发布工作流。

### 负面

- `install.sh` 本身来自控制台，信任控制台（运营者自己的服务器）是前提。需要更强保证的用户可以先下载脚本审阅，或与 GitHub 上同版本的脚本比对。
- 首次安装时节点上还没有 cosign。install.sh 需要下载固定版本的 cosign，并用脚本内写死的 sha256 校验它，或者使用节点上已有的 cosign。具体方式在实现 install.sh 时确定。
- keyless 校验需要 Sigstore 的信任根。国内访问 Sigstore 基础设施的稳定性有待验证，可能需要控制台一并转发信任根文件；这样做时信任锚点仍然是控制台，与上一条的前提一致。
- 只支持使用 systemd 的主流发行版。

## Phase 0 落地情况

Phase 0 范围：

- 控制台生成一次性安装命令（token 与 CA 指纹）。
- 节点注册流程（[ADR-0008](0008-node-channel-connect-rpc-mtls.md)）。
- 端到端测试通过 compose 直接启动节点容器，不经过 install.sh。

后续：

- install.sh 的完整实现与控制台镜像转发。
- 签名校验：依赖首个带签名的正式发布（[ADR-0017](0017-release-supply-chain.md)）。
- SSH 一次性远程安装。

## 版本核实

核实日期：2026-09-25。来源：proxy.golang.org、Docker Hub。

| 组件 | 版本 | 来源 |
| --- | --- | --- |
| cosign | 3.1.3 | proxy.golang.org（github.com/sigstore/cosign） |
| OpenResty | 1.31.1.1 | Docker Hub（`openresty/openresty:1.31.1.1-bookworm`） |

> 更新记录：
> - 2026-09-25：控制台 `GET /install.sh` 提供安装脚本（`apps/console/src/server/install/install.sh`），先用 `cosign verify-blob --bundle checksums.txt.sigstore.json` 校验签名（身份为 edgeweir-node 的 release 工作流），再 `sha256sum -c` 校验归档，全部通过后才安装和执行；只有显式传入 `--allow-unsigned`（仅供开发）才跳过签名校验，SHA-256 仍会校验。命令里的 `--ca-sha256` 是内部 CA 证书 DER 的 SHA-256。
> - 2026-09-25（收尾）：
>   - **绝不保存 SSH 凭据。** 决策第 5 条中"运营者明确选择保存时，凭据用主密钥信封加密后入库"一句不再适用，以 mvp.md 0.3 与 [SECURITY.md](../../SECURITY.md) 为准：控制面不保存 SSH 凭据，也没有保存的选项。SSH 一次性远程安装没有实现，也不在 MVP 计划内（批量 SSH 安装见 PROGRESS「待决策」22）；将来如果实现，凭据只在内存中使用一次，不写入数据库、日志和审计明细。
>   - **命令形态改变（决策第 1、4 条）。** token 不再是命令行参数（`ps` 能看到）：控制台生成 `export EDGEWEIR_TOKEN='<token>'` 和 `curl -fsSL https://<控制台>/install.sh | sudo --preserve-env=EDGEWEIR_TOKEN bash -s -- --server <节点通道地址> --ca-sha256 <CA指纹>` 两行；先下载再执行时同样用 `sudo --preserve-env=EDGEWEIR_TOKEN bash install.sh ...`，或 `--token-file PATH`。install.sh 拒绝 `--token`，读取 token 后立即从环境中删除，只把它经 `EDGEWEIR_TOKEN` 交给 `edgeweir-node enroll`（agent 也接受 `--token-file` / `EDGEWEIR_TOKEN_FILE`，`--token` 仍可用但会警告）。
>   - **install.sh 重写**（`apps/console/src/server/install/install.sh`）：整个脚本由函数组成，最后一行调用 `main`；`--server` 必须是 https URL，`--ca-sha256` 必须是 64 位小写十六进制，`--version` 按 semver 校验（默认 `latest`：先读镜像的 `latest`，失败再问 GitHub API）。签名的证书身份精确等于 `https://github.com/edgeweir/edgeweir-node/.github/workflows/release.yml@refs/tags/v<要安装的版本>`，不再接受任意 `v*` tag。机器上没有 cosign 时下载固定的 cosign v3.1.3（先镜像后 GitHub），先核对脚本里写死的 amd64 / arm64 SHA-256 再使用（负面第 2 条的做法由此确定）。包格式默认自动选择：有 apt 用 .deb，有 dnf / yum 用 .rpm（包的脚本创建 `edgeweir` 用户和状态目录），否则用 tar.gz（去掉版本顶层目录，由脚本创建用户、目录和 systemd 单元）；包名从已签名的 `checksums.txt` 里选，SHA-256 校验通过后才安装。其余参数：`--format`、`--mirror URL`、`--mirror-only`、`--no-start`（只安装和注册，不要求也不启动 systemd，供容器测试）、`--allow-unsigned`（仅开发，SHA-256 照常校验）。启动服务前停用发行版自带的 `openresty.service`（agent 自己管理 OpenResty）。
>   - **控制台镜像转发 `/downloads`**（决策第 3 条的实现）：`EDGEWEIR_DOWNLOADS_DIR` 指向一个目录，`/downloads/<项目>/latest` 和 `/downloads/<项目>/v<semver>/<文件>` 从中读取，项目只有 `edgeweir-node` 和 `cosign`；未设置、路径不合规则、文件不存在或符号链接指向目录之外时一律 404，不返回 SPA 的 `index.html`。install.sh 默认从 `<控制台>/downloads/edgeweir-node` 下载，失败再去 GitHub Releases（`--mirror-only` 时不去）。Sigstore 信任根不经控制台转发，由 cosign 按默认方式获取（负面第 3 条仍然成立）。
