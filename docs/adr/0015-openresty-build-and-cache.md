# ADR-0015: OpenResty 构建与缓存设计

- 状态：已接受
- 日期：2026-09-25
- 适用仓库：edgeweir-node

## 背景

数据面基于 OpenResty（[ADR-0013](0013-node-go-agent-openresty.md)）。

- **构建**：官方包缺少 CDN 常用的模块（brotli、zstd、geoip2、lua-resty-lmdb），HTTP/3 需要特定的编译选项和 TLS 库；但在 MVP 阶段就自己维护一套编译流水线，成本过高。
- **缓存 TTL**：nginx 的 `proxy_cache_valid` 是静态指令，不接受变量；而我们的缓存 TTL 来自可以热更新的缓存规则（[ADR-0011](0011-config-model-nodeconfig-ir.md)、[ADR-0014](0014-node-agent-responsibilities.md)），改规则不应该触发 reload。

## 决策

### 构建

1. **MVP 使用官方镜像和官方包**：容器使用 `openresty/openresty:1.31.1.1-bookworm`，裸机使用 OpenResty 官方 apt/yum 仓库的包。
2. **之后做自定义构建**，加入 http_v3、brotli、zstd、geoip2、lua-resty-lmdb；ModSecurity 加 OWASP CRS 作为可选的动态模块。自定义构建的产物同样签名并附 SBOM（[ADR-0017](0017-release-supply-chain.md)）。

### 缓存机制

3. 使用 nginx 自带的缓存能力：
   - `proxy_cache`：缓存 zone 由 IR 的 `cache_zones` 定义，属于结构性配置。
   - `slice`：大文件和 Range 请求按固定大小分片缓存，cache key 包含 `$slice_range`。
   - `proxy_cache_lock`：同一对象并发未命中时，只有一个请求回源。
   - `proxy_cache_use_stale`：源站出错、超时或对象正在更新时，返回旧对象。
   - `proxy_cache_background_update`：对象过期后在后台刷新，当前请求直接拿到旧对象（等价于 stale-while-revalidate）。

### Phase 0 的双层设计

4. 结构：

   ```
   客户端
     → 外层 server：公共监听端口，proxy_cache
     → 内层 server：unix socket，Lua 选择源站，在响应上加 X-Accel-Expires
     → 源站
   ```

5. **外层**：
   - Lua 按 Host 找到站点，设置 cache key（包含站点 id 和 `cache_generation`），并根据缓存规则决定是否绕过缓存（`BYPASS` 规则对应 `proxy_cache_bypass` 与 `proxy_no_cache`）。
   - `proxy_pass` 到内层的 unix socket。
   - 响应头 `X-Cache` 取 `$upstream_cache_status`，取值包括 `MISS`、`HIT`、`EXPIRED`、`STALE`、`UPDATING`、`REVALIDATED`、`BYPASS`。
6. **内层**：
   - Lua 从站点表中选出源站并回源。
   - 把响应交回外层之前，按命中的缓存规则写入 `X-Accel-Expires`：`OVERRIDE` 总是写入 edge TTL；`RESPECT` 只在源站没有 `Cache-Control` 和 `Expires` 时写入 edge TTL。
   - 对源站响应设置 `proxy_ignore_headers X-Accel-Redirect` 等，防止源站通过 `X-Accel-*` 头触发 nginx 内部跳转。
7. **为什么需要两层**：nginx 在处理上游响应头时确定缓存有效期，优先级为 `X-Accel-Expires` 高于 `Cache-Control` 和 `Expires`，再高于 `proxy_cache_valid`。同一层内，`header_filter_by_lua` 修改的是发给客户端的响应头，影响不了已经做出的缓存决策；`proxy_cache_valid` 又不接受变量。把"决定 TTL"放到内层，以响应头的形式交给外层，TTL 就能随缓存规则热更新，不需要 reload。
8. **头部不外泄**：nginx 默认不会把上游响应中的 `X-Accel-*` 头转发给下游。因此内层写入的 `X-Accel-Expires` 不会发给客户端；源站自带的 `X-Accel-Expires` 也不会被内层转发给外层，TTL 只由我们的规则决定。
9. **代价**：每个未命中的请求多一次本机 unix socket 代理跳转，命中时不经过内层。外层到内层使用 keepalive 连接池。

### 之后

10. 自定义构建完成后，评估能否用模块或补丁把 TTL 决策合并回单层。合并时更新本 ADR。

## 备选方案与取舍

- **按固定 TTL 档位拆多个 location，各自设置 `proxy_cache_valid`**：TTL 只能取有限几档，修改规则仍要 reload。
- **用 Lua 自己实现缓存，或使用 srcache**：放弃了 nginx proxy_cache 的 slice、缓存锁、stale、后台更新等成熟能力。
- **MVP 就做自定义构建**：发行版、架构、模块组合成的编译矩阵维护成本过高。
- **Varnish 或 ATS 作缓存层**：多一个组件，而且与 Lua 热更新体系脱节。

## 后果

### 正面

- MVP 使用官方包，安装简单。
- 缓存 TTL 等策略热更新，不需要 reload。
- 复用 nginx 成熟的缓存实现。

### 负面

- 双层结构带来一次额外的本机跳转，配置也更复杂。
- 使用官方包期间没有 brotli、zstd、geoip2。ROADMAP 的 MVP 包含 Brotli、Zstd 以及按国家、省份、ASN 的黑白名单，这些依赖自定义构建（或在 Lua 层实现的替代方案），因此自定义构建需要在 MVP 期间完成。

## Phase 0 落地情况

Phase 0 范围：

- 使用官方镜像 `openresty/openresty:1.31.1.1-bookworm`。
- 双层结构：外层 proxy_cache，内层 unix socket 回源并写 `X-Accel-Expires`。
- 按 Host 路由、`X-Cache` 响应头。
- 端到端测试验证同一 URL 第一次 `MISS`、第二次 `HIT`。

后续：

- MVP：`slice`、Range、`use_stale`、`background_update` 的配置化；自定义构建（http_v3、brotli、zstd、geoip2）。
- v1：ModSecurity + OWASP CRS 可选模块；lua-resty-lmdb。

## 版本核实

核实日期：2026-09-25。来源：Docker Hub。

| 组件 | 版本 | 来源 |
| --- | --- | --- |
| OpenResty | 1.31.1.1，镜像 `openresty/openresty:1.31.1.1-bookworm` | Docker Hub |

> 更新记录：
> - 2026-09-25：双层设计已按本 ADR 实现：外层公共监听按站点选择 cache zone 做 `proxy_cache`，响应头 `X-Cache: $upstream_cache_status`；内层监听 unix socket（`/run/edgeweir-node/origin.sock`）选源站回源，并按规则在响应上设置 `X-Accel-Expires`。没有匹配缓存规则的请求为 BYPASS；未知 Host 返回 404 并带 `X-Edgeweir-Error: unknown-host`。proto v0.1.0 尚无下发证书材料的 RPC，因此 HTTPS 监听暂被跳过（需要后续 proto 增加 GetCertificate 一类接口）；回源 HTTPS 暂不校验证书（IR 缺少对应开关）。
> - 2026-09-25（MVP M2）：源站层改用 `balancer_by_lua`（lua-resty-core 0.1.34 的 `ngx.balancer`）：access 阶段按负载均衡策略和健康状态排出候选源站（最多 3 个）并用 lua-resty-dns 解析（缓存 ≤30 秒，失败 5 秒），balancer 阶段逐次设置对端、重试次数、按站点的超时（`set_timeouts`）和按地址 + 端口 + SNI 区分的 keep-alive 连接池（`set_current_peer` 第三个参数 + `enable_keepalive`）；换源重试时若 Host 或 S3 签名不同就 `recreate_request`；不校验证书的 HTTPS 连接不进连接池。TLS 校验开关是静态指令，所以源站层分为校验和不校验两个 unix socket server，边缘层按站点选择（`proxy_pass http://$edgeweir_origin_layer`）；没有找到 CA bundle 时需要校验的 HTTPS 源站直接失败。缓存规则的请求条件在边缘层判断，候选规则经 `X-Edgeweir-Rules` 传给源站层，由源站层按状态码和大小决定 `X-Accel-Expires`。stale：不再静态配置 `proxy_cache_use_stale`，由源站层把规则的 stale-while-revalidate / stale-if-error 写成 Cache-Control 扩展（nginx 在 `X-Accel-Expires` 之外仍解析这两个扩展），原头放在 `X-Edgeweir-CC` 中由边缘层还原；nginx 只对传输错误使用 stale-if-error，因此边缘层带着过期副本（`X-Edgeweir-Cache-Status: EXPIRED`）而源站失败时，源站层在 header filter 中断开连接，让边缘层回落到 stale。Range：边缘层配置 `slice 1m`，但只有站点开启分片时才通过 `map ... volatile` 求值 `$slice_range`，其余请求不分片。WebSocket 经两层透传（Upgrade / Connection 按请求设置），不进缓存。以上机制都先在 `openresty/openresty:1.31.1.1-bookworm` 中做了原型验证。
> - 2026-09-25（收尾）：
>   - **回源 TLS 校验源站自己的名称。** `proxy_ssl_name` 默认是 `$proxy_host`，也就是 upstream 名 `edgeweir_balancer`；`balancer.set_current_peer` 的第三个参数（SNI）在未配置 `proxy_ssl_name` 时同时用作证书校验的名称。nginx 1.29.7 起 upstream 默认开启 keep-alive，缓存的连接只按对端地址匹配，为一个名称校验过的 TLS 连接会被另一个需要校验不同名称的请求复用。因此 `edgeweir_balancer` 设为 `keepalive 0`，连接池只由 `balancer.enable_keepalive`（按地址 + 端口 + SNI 区分）负责；源站层设置 `proxy_ssl_name $edgeweir_ssl_name`，balancer 阶段每次尝试都把它设为传给 `set_current_peer` 的 SNI。按 IP 配置的 HTTPS 源站需要证书覆盖的 SNI 或回源 Host。
>   - **备用源只在全部主源不可用时使用。** 候选顺序是：健康的主源（重试也只在它们之间）；所有主源都被标记为不可用时，健康的备用源；全部不可用时所有源站（主源在前）。
>   - **缓存键。** 缓存键读取全部请求头（与剥离内部头时相同），不再只读前 100 个；键里每个可变部分都做百分号转义，不能冒充其他部分；配置里 `x-edgeweir-*` 的键头被忽略。缓存键和清缓存匹配都改用 nginx 规范化后的 `$uri`，清缓存标记的路径按同样规则规范化，`/%73tatic/x` 不再能躲过对 `/static/` 的清除。普通 URL 的键不变，含转义的 URL 升级后各 MISS 一次。
>   - **`Authorization`。** 带 `Authorization` 的请求在边缘层不查缓存、在源站层 `X-Accel-Expires: 0`，除非适用的规则打开了 `cache_authorized`（[ADR-0011](0011-config-model-nodeconfig-ir.md) 收尾记录）。
>   - **Host 缓存分开。** 解码后的站点、Host 命中、Host 未命中各用一个 worker 内缓存；未命中的 Host 用一个 1024 条的小缓存，泛域名命中按父域名缓存一次，伪造 Host 的洪泛不再挤掉站点和它们的轮询、哈希环状态。
>   - **回环与特殊地址。** 边缘层先做 `CDN-Loop` 检查（带本节点标识的请求返回 508），源站层丢弃落在特殊用途地址的 DNS 结果（[ADR-0018](0018-trust-and-security-baseline.md) 收尾记录）；被动健康状态改为按"站点 + 源站"区分。
>   - **PROXY protocol 与 S3。** 使用 PROXY protocol 的监听从 PROXY 头取客户端地址（`real_ip_header proxy_protocol`），发往源站的 `$remote_addr`、`X-Real-IP`、`X-Forwarded-For` 是真实客户端而不是负载均衡器。S3 源站是候选时，源站层删除访问者带来的全部 `x-amz-*` 请求头（节点只签 `host`、`x-amz-date`、`x-amz-content-sha256`）。
