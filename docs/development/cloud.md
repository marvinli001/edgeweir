# Claude 云端开发

仓库地址是 `marvinli001/edgeweir`，默认分支是 `master`。节点代码位于同级的 `marvinli001/edgeweir-node` 仓库。

仓库共享 `.claude/settings.json` 的 SessionStart 钩子。只有 `CLAUDE_CODE_REMOTE=true` 时才执行安装；本地会话直接退出。脚本从 `.nvmrc` 和 `package.json` 读取工具链要求，下载并校验 Node 的 SHA-256，检查最低版本，在用户目录安装固定版本的 pnpm，再执行 `pnpm install --frozen-lockfile`。通过 `CLAUDE_ENV_FILE` 为后续命令保留 PATH。

云端环境的网络策略需要允许 `nodejs.org`、npm/pnpm 使用的包源及项目依赖的下载源。初始化脚本不复制本地 `.env`、数据库、密钥或登录会话。需要数据库的开发服务仍要显式配置自己的测试环境。

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

这些检查使用内存 PostgreSQL（PGlite），不要求 Docker。涉及 Go helper 或节点时，还需要对应 `go.mod` 的 Go 工具链。完整 `pnpm e2e` 需要两个仓库、Docker、Go、goreleaser、syft 和 cosign（版本见 CI 工作流）；是否可在云端运行由实际环境能力决定，不能用单元测试代替该项验收。

2026-09-26 已在干净的 `node:22-bookworm` 容器中验证远端启动分支：安装仓库要求的 Node/pnpm 后，lint 和全部 workspace 类型检查通过；本地启动分支验证为无操作。Anthropic 实际云端的网络策略和会话钩子触发仍需在首次云端会话读回确认。

钩子机制与环境变量持久化见 [Claude Code 官方文档](https://code.claude.com/docs/en/hooks#sessionstart)。
