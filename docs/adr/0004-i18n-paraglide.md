# ADR-0004: 国际化：Paraglide JS 2

- 状态：已接受
- 日期：2026-09-25
- 适用仓库：edgeweir

## 背景

维护者和主要用户使用中文，同时要服务海外用户。国际化必须从第一天接入，后补需要全量改动字符串。要求类型安全：缺少翻译、消息名写错、插值参数不匹配，都应当在编译期发现，而不是在运行时显示出一个 key。

## 决策

1. **使用 Paraglide JS 2**（`@inlang/paraglide-js`）。语言：`zh-CN`（基础语言，默认）和 `en`。
2. **消息文件**：每种语言一个 JSON 文件（inlang message format，默认布局 `messages/{locale}.json`），语言列表在 inlang 项目配置 `project.inlang/settings.json` 中声明。
3. **编译**：Paraglide 的 Vite 插件在开发和构建时把消息编译成 ES 模块，每条消息是一个带类型的函数，例如 `m.sites_create_title()`、`m.nodes_online_count({ count })`。没有被引用的消息会被 tree-shaking 去掉。
4. **语言选择顺序**：cookie，其次浏览器语言，最后回退到 `zh-CN`（Paraglide 的 `cookie`、`preferredLanguage`、`baseLocale` 策略）。不使用 URL 前缀：后台不需要 SEO，页面地址不随语言变化。
5. **规则：**
   - UI 中所有用户可见的字符串都通过消息函数输出，组件里不写字面量文案。
   - 新增或修改消息时，`zh-CN` 和 `en` 同时更新。
   - CI 校验两种语言的 key 集合完全一致，任一方缺 key 即失败。
   - API 返回稳定的错误码和结构化参数，由 UI 翻译成当前语言。服务端不拼接面向用户的自然语言句子。
   - 服务端确实需要生成文案的场景（邮件、告警通知），同样调用 Paraglide 编译出的消息函数，按收件人的语言渲染。
   - 日期、数字、字节数、时长用 `Intl` API 按当前语言格式化。

## 备选方案与取舍

- **i18next / react-i18next**：运行时按字符串 key 查表，默认没有类型检查（需要额外生成类型声明），整份语言包在运行时加载。
- **FormatJS（react-intl）**：ICU 消息格式功能完整，但运行时体积较大，key 仍是字符串。
- **Lingui**：同样在编译期处理，但依赖 Babel/SWC 宏和一套提取流程。Paraglide 直接生成普通函数，服务端代码也能直接调用。
- **手写 key 到字符串的对象**：没有插值参数类型、复数处理和编译期检查。

## 后果

### 正面

- 缺翻译、写错消息名、参数不匹配都在 `pnpm typecheck` 阶段暴露。
- 只打包用到的消息。
- 前端和服务端（邮件、通知）共用同一套消息。

### 负面

- 改消息名要同时改两份 JSON 和所有调用点。
- 非开发者参与翻译需要编辑 JSON，后续可以接入 inlang 生态的翻译编辑工具。
- 英文的复数等语言相关形式要使用 inlang 消息格式的 variant 能力，写法比普通字符串复杂。

## Phase 0 落地情况

Phase 0 范围：

- Phase 0 的全部页面（登录、初始化向导、概览、集群与节点、网站、设置）提供 `zh-CN` 与 `en` 两种语言。
- CI 中的 key 一致性校验。

后续：

- 按需增加语言（例如 `zh-TW`）。
- 翻译协作流程与工具。

## 版本核实

核实日期：2026-09-25。来源：npm registry。

| 组件 | 版本 | 来源 |
| --- | --- | --- |
| @inlang/paraglide-js | 2.25.4 | npm registry |

> 更新记录：
> - 2026-09-25：Paraglide 2.25 的 inlang 插件（plugin-message-format、plugin-m-function-matcher）作为 devDependency 安装，`project.inlang/settings.json` 用本地路径加载，构建时不再从 jsDelivr 拉取模块（离线和国内网络可构建）。语言策略 localStorage → preferredLanguage → baseLocale（zh-CN），切换语言时整页重载。
