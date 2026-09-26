# ADR-0012: 规则引擎：wirefilter 风格表达式语言

- 状态：已接受
- 日期：2026-09-25
- 适用仓库：两者

## 背景

- Cloudflare 早期的 Page Rules 把缓存、跳转、安全等设置塞进一种规则，一个请求只命中一条 Page Rule，组合能力差。它已被拆分为 Cache、Configuration、Redirect、Origin、Transform、Compression 等几类 Rules，这些规则共用一门表达式语言，语法来自开源的 wirefilter。
- GoEdge 的"路由规则"可以按路径覆盖几乎所有站点设置，功能强，但模型松散。
- MVP 的访问控制、限速、重定向、改写、请求头与响应头规则都需要一个统一的匹配语言。它要能在控制面做静态检查，也要能在节点上高效执行。

## 决策

1. **语言：wirefilter 风格的表达式。** 示例：

   ```
   http.host eq "a.com" and ip.src in $blocklist
   http.request.uri.path matches "^/api/" and not http.request.method in {"GET" "HEAD"}
   ```

   - 字段：有类型的请求与连接属性，例如 `http.host`、`http.request.uri.path`、`http.request.method`、`http.request.headers["..."]`、`ip.src`。完整字段表在实现时确定并写入文档。
   - 运算符：比较（`eq`、`ne`、`lt`、`le`、`gt`、`ge`）、`contains`、`matches`（正则）、`in`（集合字面量或命名列表 `$name`），逻辑运算 `not`、`and`、`or`。
   - 类型：字符串、整数、布尔、IP 与 CIDR、数组、映射。
   - 命名列表（如 `$blocklist`）单独管理、单独热更新，规则只引用列表名。
2. **分工：**
   - 控制面（TypeScript）：解析、类型检查（字段是否存在、类型是否匹配、字段在该执行阶段是否可用，例如响应字段只能用于 response-transform）、复杂度限制，然后编译成 IR。
   - 节点：把 IR 编译成 Lua 函数并缓存，按规则版本失效。
3. **执行阶段固定顺序：**

   request-transform → redirect → config → waf-custom → ratelimit → cache → origin → response-transform

4. **规则分类共享同一门语言**：Cache、Configuration、Redirect、Origin、Transform、Compression Rules，以及 WAF 自定义规则和限速规则。每条规则由表达式、动作和动作参数组成。每一类规则的命中语义（首条命中即停止，或所有命中规则依次叠加）由该类规则定义，并写入 IR。
5. **安全约束：**
   - 正则：OpenResty 的 `ngx.re` 使用 PCRE（回溯引擎），存在 ReDoS 风险。控制面限制正则长度，拒绝反向引用等高风险构造；节点侧设置 `lua_regex_match_limit` 并启用 PCRE JIT。
   - 表达式长度、嵌套深度、集合与列表大小都有上限。
   - 生成的 Lua 在受限环境中加载，只暴露字段访问和内置函数。用户不能写任意 Lua。
6. **不做的事：**
   - 不做 Page Rules 式的单体规则模型。
   - 不复刻 Auto Minify、Mirage、Rocket Loader。前两者 Cloudflare 已经废弃；Rocket Loader 通过改写页面的脚本加载方式工作，容易破坏站点。现代前端构建工具已经完成压缩和拆包，边缘再做一遍收益小、风险大。
7. **IR 形式：** 按上面的分工，IR 携带的是控制面类型检查之后的结构化表达式（新增 protobuf 消息表示 AST），节点不需要实现解析器，控制面是唯一的语法权威。Phase 0 的 `CacheRuleMatch.expression` 是字符串占位，实现规则引擎时可能以新的结构化字段取代它；具体的 IR 结构届时另写 ADR 确定。

## 备选方案与取舍

- **Page Rules 式单体规则**：见背景。
- **让用户直接写 Lua**：无法静态检查，沙箱难做，租户脚本风险高。边缘计算放在 v2，并且租户脚本需要审批。
- **CEL（Common Expression Language）**：类型系统完善，但没有成熟的 Lua 运行时，完整实现规范的工作量大；wirefilter 语法对 Cloudflare 用户更熟悉。
- **OPA/Rego**：面向策略决策，表达能力过强，逐请求执行时的性能和可预测性不合适。
- **所有规则都用 ModSecurity 的 SecRule 语法**：语法晦涩，只适合 WAF 场景。OWASP CRS 托管规则仍以 ModSecurity 可选模块的形式提供（[ADR-0015](0015-openresty-build-and-cache.md)）。
- **只用结构化条件（路径前缀列表、后缀列表）**：易用但表达力有限。Phase 0 先用它；表达式语言落地后，它在 UI 中作为常见表达式的快捷写法保留。

## 后果

### 正面

- 一门语言覆盖所有规则类型，用户只学一次。
- 控制面静态检查，错误表达式到不了节点。
- IR 与 Lua 解耦，将来 Pingora 引擎可以另写一个后端。

### 负面

- 要自己实现解析器、类型检查器和 Lua 代码生成器，并保证两端语义一致，需要一套共享的一致性测试用例。
- PCRE 与 wirefilter 使用的 Rust regex（线性时间引擎）在语义上有差异，文档要写明支持的正则子集。

## Phase 0 落地情况

Phase 0 范围：

- IR 预留 `CacheRuleMatch.expression`，节点拒绝表达式非空的配置。
- 缓存规则使用结构化条件（`path_prefixes`、`extensions`）。

后续（MVP）：

- 访问控制、限速、重定向、改写、请求头与响应头规则需要表达式语言。届时实现解析器、类型检查、IR 结构和 Lua 编译器，并补充字段表文档。

## 版本核实

核实日期：2026-09-25。本 ADR 不引入新的依赖。表达式语言实现时，所用的解析库和 Lua 依赖另行核实并记录。

| 组件 | 版本 | 来源 |
| --- | --- | --- |
| OpenResty（节点端执行环境） | 1.31.1.1，镜像 `openresty/openresty:1.31.1.1-bookworm` | Docker Hub |

## 2026-09-27 M4 更新

- 独立 `@edgeweir/rule-engine` 完成受限语法解析，IR 使用 `EdgeRule` / `RuleExpression` / `RuleAction` / `IpList`。Lua 将 AST 编译为固定函数组合，不使用 load/loadstring；Go 对类型、阶段、名单引用和复杂度做第二次验证，拒绝整个无效配置。
- `rules-v1` 是基础能力，City / ASN 数据分别协商 `geoip-city-v1` / `geoip-asn-v1`。表达式与名单通过原有原子 site-table Unix socket 通道热更新。
- 正则限 ASCII 子集与 PCRE 匹配预算，失败关闭；IP 前缀树查询按地址位数有界。限速使用不会强制淘汰已有键的共享内存操作，内存不足拒绝请求。
- 默认数据源 DB-IP Lite（CC BY 4.0），由运维者自行下载并在节点提供 City / ASN MMDB；无自动外连。maxminddb-golang v2.6.0，测试数据由 mmdbwriter v1.2.0 自行生成。外部服务、UI 和具体规则语义见 [规则指南](../../docs/guide/rules.md)。
- 平台规则先于同阶段的站点规则；回滚不能撤销当前平台规则与 IP 名单。阶段顺序、放行范围、固定窗口和字段限制在指南中明确。
