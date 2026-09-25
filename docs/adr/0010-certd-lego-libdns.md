# ADR-0010: 证书与 DNS helper：edgeweir-certd（lego + libdns）

- 状态：已接受
- 日期：2026-09-25
- 适用仓库：edgeweir

## 背景

MVP 需要：

- ACME 自动证书，包括泛域名证书（只能用 DNS-01 验证），续期时间最好遵循 CA 给出的 ARI（ACME Renewal Information）窗口。
- 接入第三方 DNS（DNSPod、阿里云、华为云、Cloudflare 等）：自动下发 CNAME、健康检查失败时摘除记录、记录修复任务。

TypeScript 生态里的 ACME 库（例如 acme-client）能处理基本的签发流程，但对国内 DNS 服务商的覆盖零散、质量参差，ARI 支持也不完整。Go 生态里，lego（Traefik 使用）覆盖大量 DNS 服务商并支持 ARI，libdns（Caddy 使用）提供统一的 DNS 记录管理接口，两者都很成熟。

## 决策

1. **在 `helpers/certd` 写一个 Go 程序 `edgeweir-certd`：**
   - lego v4 负责 ACME：账户注册、DNS-01 与 HTTP-01 验证、签发、续期。续期时间以 ARI 返回的窗口为准，CA 不支持 ARI 时按剩余有效期计算。
   - libdns 负责 DNS 记录的增删改查，用于 CNAME 下发、记录修复，以及 DNS-01 所需的 TXT 记录。
   - DNS-01 优先通过一个薄适配层实现：把 libdns 的 provider 包装成 lego 的 challenge provider，这样每家 DNS 服务商只需要一套凭据格式，同时服务于证书签发和记录管理。某家服务商没有 libdns 实现时，退回使用 lego 自带的 provider。
2. **构建**：`CGO_ENABLED=0` 静态编译，在控制面 Dockerfile 的多阶段构建中编译，复制进同一个镜像。不单独发布镜像。
3. **调用方式**：由 pg-boss 任务（`worker` 角色，[ADR-0006](0006-data-postgresql-drizzle-pgboss.md)）以子进程方式调用，协议为 stdin/stdout JSON：
   - 请求：一个 JSON 对象写入 stdin，包含协议版本、命令、参数和解密后的凭据。
   - 响应：一个 JSON 对象写到 stdout；日志写到 stderr；退出码非 0 表示失败，此时 stdout 仍输出结构化的错误信息。
   - 凭据只经 stdin 传递，不放在命令行参数（`ps` 可见）或环境变量里。
   - 每次调用都有超时，超时后由调用方终止子进程。
4. **certd 无状态**：不访问数据库，不监听端口。ACME 账户私钥和证书私钥由控制面保存（主密钥信封加密，[ADR-0018](0018-trust-and-security-baseline.md)），调用时传入；结果返回后由控制面加密入库。

## 备选方案与取舍

- **纯 TypeScript（acme-client 等）**：见背景。DNS 服务商覆盖和 ARI 支持不足，自己补齐 provider 的开发量和维护成本都高。
- **certbot 或 acme.sh**：分别依赖 Python 和 shell，输出面向人阅读，难以做结构化的错误处理。acme.sh 对国内 DNS 服务商覆盖很好，但以 shell 脚本嵌入会让错误语义和凭据传递都难以控制。
- **certd 做成常驻服务（gRPC 或 HTTP）**：多一个进程要监管，多一个端口要保护。证书和 DNS 操作频率低，按需启动子进程更简单。
- **用 cgo 或 N-API 把 Go 代码做成 Node 原生扩展**：构建复杂；Go 运行时崩溃会把整个控制台进程一起带走。

## 后果

### 正面

- 直接复用 lego 和 libdns 已有的 DNS 服务商覆盖。
- certd 无状态、无网络监听，攻击面小。
- 子进程崩溃或超时不影响控制台进程。

### 负面

- 镜像中多一个 Go 二进制，体积增加若干 MB。
- Go 与 TypeScript 之间的 JSON 协议需要两边都有类型定义和测试。
- lego 和 libdns 各 provider 的质量不一，每接入一家 DNS 服务商都要实测。

## Phase 0 落地情况

Phase 0 范围：

- `helpers/certd` 的 Go 骨架：工程结构和 stdin/stdout JSON 协议外壳。
- 在多阶段构建中编译并放进控制面镜像。
- 不包含实际的 ACME 和 DNS 调用。

后续（MVP）：

- ACME 签发与续期（ARI、DNS-01、HTTP-01）。
- DNSPod、阿里云、华为云、Cloudflare 的记录管理。
- CNAME 自动下发与记录修复任务。

## 版本核实

核实日期：2026-09-25。来源：proxy.golang.org、Docker Hub、npm registry。

| 组件 | 版本 | 来源 |
| --- | --- | --- |
| Go | 1.27.1，镜像 `golang:1.27.1-alpine` | proxy.golang.org（golang.org/toolchain）、Docker Hub |
| lego | v4.35.2（github.com/go-acme/lego/v4） | proxy.golang.org |
| libdns | v1.1.1（github.com/libdns/libdns） | proxy.golang.org |
| pg-boss | 12.34.0 | npm registry |
