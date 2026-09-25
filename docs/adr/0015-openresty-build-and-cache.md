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
