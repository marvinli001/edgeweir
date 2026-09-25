# 贡献指南

感谢你愿意参与 Edgeweir。本文说明开发环境、检查命令、提交规范，以及 proto、ADR、i18n 等几条必须遵守的流程。

## 开始之前

- 较大的改动请先开 issue 讨论方向，避免白做。
- 涉及架构的改动（新依赖、进程或部署形态、节点通道协议、NodeConfig IR 语义、安全基线）需要先写 ADR，见下文"ADR 流程"。
- **安全漏洞不要开公开 issue**，按 [SECURITY.md](SECURITY.md) 私下报告。
- 不可违反的原则见 [ADR-0018](docs/adr/0018-trust-and-security-baseline.md)：没有 phone-home，没有授权校验代码，遥测默认关闭，敏感数据信封加密后才入库，管理操作写审计日志。违反这些原则的 PR 不会被合入。

## 开发环境

需要：

- Node.js 24+（版本见 `.nvmrc`）
- pnpm 12（`corepack enable` 后按 `package.json` 的 `packageManager` 自动使用，或 `npm i -g pnpm@12`）
- Docker（本地 PostgreSQL 与端到端测试）
- Go 1.27（仅修改 `helpers/certd` 时需要）
- buf（仅修改 `proto/` 时需要）

启动：

```sh
pnpm install
docker compose -f compose.dev.yml up -d
cp .env.example .env
pnpm dev
```

`pnpm dev` 启动单个进程：`:3000` 提供 UI 和 API，`:8443` 提供节点通道。前端改动走 Vite HMR；服务端改动会重启整个进程。

## 运行检查

提交前在本地运行，CI 会执行同样的检查：

| 命令 | 何时运行 |
| --- | --- |
| `pnpm lint` | 每次提交前 |
| `pnpm typecheck` | 每次提交前 |
| `pnpm test` | 每次提交前 |
| `pnpm build` | 改动构建配置或依赖时 |
| `pnpm proto:lint` | 改动 `proto/` 时 |
| `pnpm e2e` | 改动节点通道、配置编译或页面流程时（需要 Docker） |

格式问题可以用 `pnpm exec biome check --write .` 自动修复。

## 提交规范

使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/)：

```
<type>(<scope>): <subject>

<body>

<footer>
```

type：

| type | 用途 |
| --- | --- |
| `feat` | 新功能 |
| `fix` | 修复缺陷 |
| `docs` | 只改文档 |
| `style` | 不影响逻辑的格式调整 |
| `refactor` | 既不是新功能也不是修复的代码重构 |
| `perf` | 性能优化 |
| `test` | 新增或修改测试 |
| `build` | 构建系统、依赖、Dockerfile |
| `ci` | CI 配置 |
| `chore` | 其他杂项 |
| `revert` | 回退之前的提交 |

scope 示例：`console`、`db`、`contract`、`compiler`、`proto`、`node-channel`、`web`、`deploy`，也可以用 `auth`、`i18n`、`certd` 等。跨越多个模块时可以省略 scope。

示例：

```
feat(node-channel): reject RPCs from disabled nodes
fix(compiler): sort cache rules by (priority, id) before hashing
docs(adr): add ADR-0019 for certificate key delivery
feat(proto)!: replace CacheRuleMatch.expression with a typed AST

BREAKING CHANGE: nodes built from proto/v0.x must be regenerated.
```

要求：

- **小步提交**：一个提交只做一件事，并且单独能通过检查，方便评审和 `git bisect`。
- subject 用中文或英文均可，简短，不超过 72 个字符，结尾不加句号。
- 破坏性变更在 type 后加 `!`，并在 footer 写 `BREAKING CHANGE:` 说明影响和迁移方法。
- **建议加 `Signed-off-by`**：用 `git commit -s` 提交，表示你同意 [Developer Certificate of Origin](https://developercertificate.org/)。

## Pull Request

- 一个 PR 一个主题。描述写清动机、改动内容和验证方式，关联相关的 issue 或 ADR。
- UI 改动附截图。
- 改动了行为，就同步更新文档（README、ADR 的落地情况、部署文档）。

## 代码风格

- TypeScript 的 lint 和格式化统一用 Biome，配置在仓库根目录。不要引入 ESLint 或 Prettier。
- TypeScript 开启 `strict`。避免 `any`；系统边界（API 输入、环境变量、外部数据）用 zod 校验。
- Go 代码（`helpers/certd`）使用 `gofmt`，通过 `go vet`。
- UI 只使用 shadcn 的设计 token 和 Tailwind 语义类，不写裸色值；appica-ui 的使用规则见 [ADR-0003](docs/adr/0003-ui-shadcn-preset.md)。

## i18n 规则

- 所有用户可见的 UI 字符串都通过 Paraglide 的消息函数输出，组件里不写字面量文案（[ADR-0004](docs/adr/0004-i18n-paraglide.md)）。
- 新增或修改消息时，**zh-CN 和 en 必须同时更新**。CI 会校验两种语言的 key 集合一致，缺一个就失败。
- 消息名建议以页面或功能开头，例如 `sites_create_title`、`nodes_online_count`。
- API 返回错误码，由 UI 翻译成当前语言；服务端不拼接面向用户的句子。

## proto 变更流程

`proto/` 是控制面与 edgeweir-node 之间唯一的契约来源（[ADR-0008](docs/adr/0008-node-channel-connect-rpc-mtls.md)）。

1. 修改 `proto/` 下的 `.proto` 文件。同一个包（`edgeweir.node.v1`）内只做向后兼容的新增；需要破坏性变更时新建 `v2` 包。修改 `NodeConfig` 时遵守 [ADR-0011](docs/adr/0011-config-model-nodeconfig-ir.md) 的规范化约束（不使用 `map`，字段按字段号升序声明）。
2. 运行 `pnpm proto:lint`。
3. 与上一个 proto tag 比较，确认没有破坏性变更：

   ```sh
   buf breaking proto --against '.git#tag=proto/vX.Y.Z,subdir=proto'
   ```

4. 运行 `pnpm proto:gen`，把 proto 改动和 `packages/proto` 下的生成代码放在同一个提交里。
5. 合入 `master` 后，由维护者打 tag：`proto/vX.Y.Z`。新增字段或 RPC 升 minor，只改注释升 patch。
6. 在 edgeweir-node 仓库中重新生成 Go 代码并适配：

   ```sh
   make proto PROTO_TAG=proto/vX.Y.Z
   ```

7. 发布时先升级控制面，再升级节点。控制面必须兼容上一个 proto 版本的节点。

## ADR 流程

1. 复制 [docs/adr/template.md](docs/adr/template.md) 为 `docs/adr/NNNN-slug.md`。`NNNN` 取现有最大编号加一（两个仓库共用一套编号），`slug` 用英文小写加连字符。
2. 状态写"提议"，与相关代码放在同一个 PR 中，并在 [docs/adr/README.md](docs/adr/README.md) 的索引表中加一行。
3. 评审通过后把状态改为"已接受"再合入。
4. 要推翻已接受的决策，写一篇新 ADR，并把旧 ADR 的状态改为"已被 ADR-NNNN 取代"。不要改写旧 ADR 的结论。

## 许可证

Edgeweir 以 [AGPL-3.0-only](LICENSE) 发布。提交贡献即表示你同意以 AGPL-3.0-only 授权你的贡献，并确认你有权这样做。
