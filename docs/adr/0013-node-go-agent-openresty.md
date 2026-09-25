# ADR-0013: 节点形态：Go agent + OpenResty

- 状态：已接受
- 日期：2026-09-25
- 适用仓库：edgeweir-node

## 背景

数据面要承担 TLS 终结、HTTP/1.1、HTTP/2、HTTP/3、反向代理、磁盘缓存、压缩和 WAF，单台节点可能要处理数万 QPS。节点还需要一个控制代理，负责注册、同步配置、重载、清缓存、上报和升级。节点通常是用户自己的 VPS，安装和升级必须简单。

CDNFly v6 采用 OpenResty 加 Go agent 的节点形态，已被国内 CDN 运营者大量使用和验证。

## 决策

1. **数据面：OpenResty**（nginx + LuaJIT）。需要热更新的逻辑（按 Host 路由、选择源站、执行规则）用 Lua 实现。
2. **控制代理：Go 编写的 agent**，二进制名 `edgeweir-node`：
   - `CGO_ENABLED=0` 静态编译，支持 linux/amd64 和 linux/arm64。
   - 由 systemd 管理。
   - 职责见 [ADR-0014](0014-node-agent-responsibilities.md)。
3. **数据面不使用 TypeScript、Bun 或 Node。**
4. **agent 与 OpenResty 分工明确**：
   - agent 负责需要权限或持久化的操作：写配置文件、执行 `nginx -t`、发送信号、落盘、自升级，以及将来的 nftables/ipset 联动。
   - agent 通过本地 unix socket 把热数据推给 Lua。
   - Lua 只处理请求路径上的逻辑。

## 备选方案与取舍

- **TypeScript、Bun 或 Node 做数据面**：GC 停顿和内存占用不适合高并发代理；没有成熟的磁盘缓存、分片缓存（slice）、缓存锁等 CDN 基础能力，要从头实现。
- **纯 Go 代理（GoEdge 的做法）或 Caddy**：缓存要自己实现或依赖较新的第三方模块，成熟度不如 nginx 的 proxy_cache；大量连接下 Go GC 的尾延迟需要额外调优。
- **Envoy**：缓存过滤器不成熟，xDS 配置体系重。
- **Pingora**：它是 Rust 库而不是现成的代理产品，缓存 API 仍在演进，HTTP/3 尚不成熟。IR 与引擎解耦（[ADR-0011](0011-config-model-nodeconfig-ir.md)），等它成熟后可以作为第二个引擎加入。
- **只用 Lua，在 nginx worker 里直接连控制面**：在 worker 里做 mTLS 客户端、落盘、reload 和自升级都不合适，也无法处理 nginx 自身重启的情况。
- **Rust 写 agent**：可行。但 Go 与 connect-go、lego、libdns 属于同一生态，开发效率更高，静态编译同样简单。

## 后果

### 正面

- 复用 nginx 成熟的缓存和 TLS 实现。
- Lua 提供热更新能力，常规变更不需要 reload。
- agent 是单个静态二进制，安装和升级简单。

### 负面

- 节点上有两套运行时（Go 和 OpenResty），agent 需要同时关注两者的健康状态。
- Lua 代码的测试需要 OpenResty 环境（例如 Test::Nginx 或容器化测试）。
- OpenResty 官方包的模块有限，Brotli、Zstd、GeoIP2 等高级功能需要自定义构建（[ADR-0015](0015-openresty-build-and-cache.md)）。

## Phase 0 落地情况

Phase 0 范围：

- Go agent 骨架：注册、mTLS、watch、快照落盘、渲染最小 nginx.conf、经 unix socket 推送站点表。
- Lua 按 Host 路由到上游，开启 proxy_cache，响应带 `X-Cache` 头。
- 端到端测试中的节点容器基于 OpenResty 官方镜像。

后续：

- deb/rpm 包中的 systemd 单元与安装后脚本（[ADR-0017](0017-release-supply-chain.md)）。
- 自升级（[ADR-0014](0014-node-agent-responsibilities.md)）。
- nftables/ipset 联动（v1）。

## 版本核实

核实日期：2026-09-25。来源：proxy.golang.org、Docker Hub。

| 组件 | 版本 | 来源 |
| --- | --- | --- |
| Go | 1.27.1，镜像 `golang:1.27.1-alpine` | proxy.golang.org（golang.org/toolchain）、Docker Hub |
| OpenResty | 1.31.1.1，镜像 `openresty/openresty:1.31.1.1-bookworm` | Docker Hub |
| connectrpc.com/connect | v1.21.0 | proxy.golang.org |
| google.golang.org/protobuf | v1.36.12 | proxy.golang.org |
