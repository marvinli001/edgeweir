# MVP 完成与复核记录

本轮范围于 2026-09-26 确认为：完成公开仓库及云端准备，审查和修复现有 M1/M2，并继续完成 `docs/specs/mvp.md` 的 M3–M6。v1/v2 保留为后续路线图。验收以源码、自动化测试及真实组件组成的本地端到端结果为准。

## 已验证的基础修复

- 云端 SessionStart 脚本已在干净 Node 22 容器中完成安装、lint、全部 workspace 类型检查；本地分支无操作。实际 Anthropic 云端会话尚未触发。
- GitHub 仓库已是公开 AGPL-3.0 仓库，默认分支为 master；安装和 CI 使用实际的 `marvinli001` 命名空间。
- 首次初始化不再让数据库连接排队等待同一个会话锁；竞争失败立即释放连接并返回稳定错误码。
- 组织管理员不能在成员列表中拿到 owner 邀请凭据。
- 旧整站刷新接口与任务式刷新共享组织限额。
- 默认 Compose 注入的空节点 URL 可正确回退到默认地址。
- 安装脚本的 ShellCheck SC2015 问题已修复，没有跳过检查。

## 里程碑状态

| 范围 | 当前状态 | 验收证据 |
| --- | --- | --- |
| 原有功能与上述修复 | 单元检查通过，等待最终全链路回归 | M3 开始前控制台 192 个测试通过；新增修复测试位于 setup、console、cache-tasks 和 env 测试文件 |
| M3 证书、HTTPS、协议 | 核心链路已通过，准备协议标签与远端 CI | `M3 E2E OK`；Playwright 申请证书与 HTTPS 设置通过；375px 深色截图无横向溢出；Go race、Lua、类型检查及控制台测试通过 |
| M4 访问控制与规则 | 待实现 | 不标记为完成 |
| M5 DNS、统计、告警与 API | 待实现 | 不标记为完成 |
| M6 升级、日志、AccessKey、性能与恢复 | 待实现 | 不标记为完成 |

## 集成记录

- M3 采用 `required_features` / `NodeInfo.supported_features` 显式能力协商；不认识的能力与枚举均拒绝整个配置，保留 last-known-good。
- HTTP-01 通过 certd 的有确认消息的 stdin/stdout 协议发布公开挑战，等待在线节点回执后才通知 ACME 服务器验证；私钥和 DNS 凭据不进入 IR 或命令行。
- 当前官方 OpenResty 1.31.1.1 镜像包含 HTTP/2 和 HTTP/3 模块；Brotli、Zstd 未包含，界面保持不可用，后续自定义构建的决定会记录在 ADR。
- 本轮端到端环境使用独立 Compose 项目 `edgeweir-mvp-audit`，不覆盖已有开发容器或数据库。

## 已发布基础修复

- 控制面 `1539652`：初始化锁、owner 邀请信息与旧刷新接口限额修复，完整 GitHub CI 通过。
- 节点 `06a074f`：未知枚举拒绝校验，完整 GitHub CI 通过。
- 两个公开仓库的 GitHub private vulnerability reporting 均已启用并读回确认。
- M3 证书更新不 reload、未知能力/枚举保留旧配置、重载后表推送失败恢复、持久化失败不报告成功，均有对应测试。DNS 服务商账户与 ZeroSSL 的外部验收尚未使用真实凭据。
