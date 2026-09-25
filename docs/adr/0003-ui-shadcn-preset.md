# ADR-0003: UI：shadcn preset b2D0wqNxT，appica-ui 只作补充

- 状态：已接受
- 日期：2026-09-25
- 适用仓库：edgeweir

## 背景

后台需要一套一致的组件和设计 token：侧边栏外壳、表格、表单、图表、命令面板、登录页。BOOTSTRAP 指定用 shadcn preset `b2D0wqNxT` 初始化。

另有一些 shadcn 没有的组件（color picker、rating、sparkline 等），计划从 appica-ui（`@appica/ui-react`）取用。appica-ui 同样基于 Base UI，但它不是 shadcn registry：它的 `--background`、`--primary`、`--secondary`、`--radius` 等 CSS 变量与 shadcn 同名但含义不同，两者直接混用会互相覆盖。

## 决策

1. **初始化命令：**

   ```sh
   pnpm dlx shadcn@latest init --preset b2D0wqNxT -t vite
   ```

   `shadcn preset decode b2D0wqNxT` 的解码结果（2026-09-25 已核实）：

   | 项 | 值 |
   | --- | --- |
   | style | luma（`components.json` 中为 `"base-luma"`） |
   | base | Base UI |
   | baseColor | neutral |
   | theme | blue |
   | chartColor | emerald |
   | iconLibrary | hugeicons |
   | font | geist |
   | radius | default |
   | menuAccent | subtle |
   | menuColor | inverted-translucent |

2. **CI 校验 preset 不漂移。** `shadcn preset resolve --json` 能从项目文件（`components.json` 与全局 CSS）反推出 preset code。CI 用固定版本的 shadcn CLI 执行它，结果必须等于 `b2D0wqNxT`，否则失败。主题色、圆角、字体、图标库被意外改动时会在 CI 里暴露。
3. **设计 token 以 shadcn 为准。** 颜色、圆角、图表色、侧边栏色都使用 shadcn 生成的 CSS 变量。业务代码使用 Tailwind 语义类（`bg-background`、`text-muted-foreground`、`border-border` 等），不写裸色值。
4. **appica-ui 的使用边界：**
   - 只用于 shadcn 没有的组件，包括动效和数据展示类组件（Loader、Sparkline、Meter、Countdown、BorderBeam、GradientGlow、BackgroundPattern、TextAnimate 等），并鼓励在合适处使用它们提升层次感。shadcn 已有的组件（按钮、输入框、对话框、表格、复制按钮等）一律用 shadcn。
   - 不引入 appica-ui 的全局主题样式（如果它提供），不在 `:root` 上定义它的变量。
   - 通过 `appica-bridge.css` 在局部作用域内映射变量：appica 组件放在一个作用域容器内（例如由 `<AppicaScope>` 渲染、带固定 class 的元素），bridge 只在这个 class 下把 appica 期望的变量赋值为对应的 shadcn token。
   - 同名变量不能在作用域内自引用（`--primary: var(--primary)` 是循环引用，结果无效）。需要时先在 `:root` 为 shadcn token 定义别名（例如 `--ew-primary: var(--primary)`），bridge 再引用别名。
   - 作用域容器里只放 appica 组件，不嵌套 shadcn 组件，否则 shadcn 组件会读到被映射过的变量。
5. **全局只有一个 ThemeProvider**：采用 shadcn Vite 模板的明暗主题方案，在 `<html>` 上切换 `.dark`。appica 组件不单独挂 provider，通过 bridge 和 `.dark` 跟随主题。
6. **后台外壳**用 shadcn 的 sidebar、dashboard、chart、command、login 区块搭建。图标统一用 preset 指定的 Hugeicons。
7. **文案**：面向用户、简短明确。页面不设副标题；对话框、卡片不加说明段落；空状态只有标题和操作；只保留与安全相关的一句话提示（如"仅显示一次"）。操作原理写进文档，不写进界面。
8. **加载**：不用骨架屏。
   - 顶部 2px 进度条（`TopProgress`）：路由加载、请求、提交期间显示，150ms 内完成的不显示；已有数据的后台轮询（`meta: { background: true }`）不触发。
   - 首次加载：内容区居中显示 appica Loader（`LoadingState`，延迟 200ms 淡入）。刷新时保留旧数据，只有进度条在动。
   - 提交按钮：按钮内显示 `Spinner` 并禁用，直到整个动作（包括随后的跳转）完成。
9. **动效与层次**：页面内容、统计卡片、表格行用 `animate-enter` 依次入场（行延迟上限 12 × 30ms）；卡片有分层阴影，概览统计区有 GradientGlow 光晕，状态卡片用 BorderBeam（颜色随状态变化），登录与初始化页用 BackgroundPattern。所有动效遵循 `prefers-reduced-motion`。

## 备选方案与取舍

- **shadcn 默认的 Radix base**：preset 选用 Base UI，与 appica-ui 共用一套底层原语库，避免同一页面里存在两套焦点管理和 portal 实现。
- **Ant Design、Arco、TDesign 等国内常见后台组件库**：自带完整的设计语言，部分依赖 CSS-in-JS 运行时，难以和 Tailwind token 体系统一；组件以 npm 包形式引入，改细节要靠覆盖样式。shadcn 把组件源码放进仓库，可以直接修改。
- **全局使用 appica 的变量，或全局覆盖 appica 的变量**：两套同名变量语义冲突，任何一方升级都可能让另一方的组件样式错乱。
- **自研设计系统**：成本高，也不是差异化方向。BOOTSTRAP §0 的原则是"自研只做编排层和产品层"。

## 后果

### 正面

- 一套 token、一套明暗主题。
- 组件源码在仓库内，可审阅、可修改。
- CI 能检测主题配置漂移。

### 负面

- shadcn 组件是复制进仓库的代码，上游修复要手动同步。
- appica-ui 升级时要核对 `appica-bridge.css` 的变量映射。
- "作用域内不嵌套 shadcn 组件"这条规则只能靠代码评审保证。
- Base UI 版 shadcn 比 Radix 版新，社区现成示例较少。

## Phase 0 落地情况

Phase 0 范围：

- 用 preset `b2D0wqNxT` 初始化 Vite 模板，Biome 替换模板自带的 ESLint（[ADR-0001](0001-monolithic-console-and-toolchain.md)）。
- 后台外壳：sidebar、login 等区块；单一 ThemeProvider。
- CI 中的 preset 校验（决策第 2 条）。

后续：

- dashboard、chart 区块随 MVP 的统计功能接入真实数据。

## 版本核实

核实日期：2026-09-25。来源：npm registry。

| 组件 | 版本 | 来源 |
| --- | --- | --- |
| shadcn（CLI） | 4.21.0 | npm registry |
| tailwindcss | 4.3.3 | npm registry |
| @appica/ui-react | 1.2.0 | npm registry |

> 更新记录：
> - 2026-09-25：实际使用的区块：dashboard-01（sidebar、chart、data-table，其 data-table 已是 TanStack Table v9 API）、login-03、command。shadcn 的 sonner 组件默认依赖 `next-themes`，已改为使用模板自带的 ThemeProvider，并移除 `next-themes`，保证全局只有一个 ThemeProvider。recharts 采用 shadcn chart 组件指定的 3.8.0。`shadcn preset resolve --json` 的校验写成了 Vitest 用例（apps/console/test/web/ui-preset.test.ts）。Phase 0 没有用到 shadcn 缺失的组件，因此尚未引入 @appica/ui-react 与 appica-bridge.css。
> - 2026-09-25（Phase 0 之后的 UI 调整）：引入 `@appica/ui-react` 1.2.0，并确定决策第 7–9 条。落地方式：
>   - 不导入 appica 的 `styles.css`（它在 `@theme` 和 `:root` 上定义与 shadcn 同名但语义不同的变量，例如 appica 的 `--primary` 是近黑色、`--secondary` 才是蓝色强调色）。
>   - `src/web/appica-bridge.css`：每个用到的组件一条 `@source`（只扫描这些组件的编译产物）；用 `@theme inline` 注册 appica 独有的工具类名（`text-primary-soft`、`bg-background-strong` 等），其变量值只在 `.appica-scope` 内定义并映射到 shadcn token；同名变量（`--primary`、`--background`、`--foreground`、`--border`、`--radius`）保持 shadcn 的值；另外复制了 border-beam、gradient-glow 需要的 `@property` 与 keyframes。
>   - 读取 appica token 的组件（Loader、Sparkline、Meter、Countdown）由 `src/web/components/appica/` 下的封装组件包进 `<AppicaScope>`（`display: contents`）。只接收颜色参数、不读 appica token 的效果组件（BorderBeam、GradientGlow、TextAnimate，以及把 `--pattern-color` 覆盖为 shadcn token 的 BackgroundPattern）不需要作用域，可以包裹 shadcn 内容。
>   - 不使用 appica 的 ThemeProvider，仍然只有一个 ThemeProvider。appica 的 CopyButton 内部渲染 appica Button，与 shadcn Button 重复，因此不用。
>   - `apps/console/test/web/ui-rules.test.ts` 校验：业务代码不使用 Skeleton；appica 只能在 `components/appica/` 中导入；不导入 appica 全局样式；bridge 的 `@source` 列表与实际导入的组件一致。
> - 2026-09-25（MVP M1）：新增 appica OTPField（TOTP 验证码，经 `components/appica/otp-field.tsx`）。它用 appica input 组件的 `input-variants.js` 给输入格加样式，因此 bridge 也扫描这个文件，并在 `.appica-scope` 内为它用到的 token（`border-strong`、`ring-input`、`error-subtle` 等）映射 shadcn token。`ui-rules.test.ts` 相应收紧：已导入 appica 组件的内部依赖目录也必须有 `@source`，且每个 `@source` 路径都必须存在。TOTP 二维码用 uqr 0.1.3（MIT，无依赖）生成模块矩阵，再画成一个 SVG path，不使用 `innerHTML`。新增 shadcn tabs（网站详情页、组织与用户）。页头在 `sm` 以下把页面操作换到第二行，保证 375px 下标题和 [控制台 | 后台] 切换可用。
> - 2026-09-25（数据展示重做）：维护者要求控制台与后台的数据展示参考 Cloudflare 仪表盘，决策第 9 条随之修改：
>   - 统计与图表放在 `src/web/components/analytics/` 的扁平面板里（`rounded-xl` 细边框、无阴影和光晕）：标题、数值（TextAnimate 数值动画）、与上一时段相比的涨跌箭头（绿色或红色取决于该指标上升是好是坏），下面是图。大图带右侧数值轴和水平细网格线；小图不画坐标轴，面积通到卡片边缘。折线 1.5px，面积为同色 10% 透明度，十字线提示框先列时间、再列数值。时间范围是统计区上方的一个下拉按钮，写进 URL（`?range=`）；换范围时保留旧图并变淡。
>   - 图表仍用 shadcn chart（recharts 3.8.0）。颜色是 `index.css` 中的新 token：`--metric`（折线）、`--status-2xx`…`--status-5xx`（状态码）、`--delta-good` / `--delta-bad`（涨跌文字）、`--state-good` / `--state-warn`（节点状态点）、`--star`（星标）。折线与状态码色板用 dataviz 校验脚本在亮色（白底）和暗色（`#171717` 底）下分别校验：亮度区间、CVD 与正常视觉下相邻色差全部通过；亮色下 3xx、4xx 对白底不足 3:1，因此状态码卡片总是同时显示数值和百分比。
>   - 概览页（控制台首页、平台概览）顶部是 Cloudflare 式的资源列：标题带数量和箭头链接，行之间细分隔线，整行可点。控制台首页：网站（星标在前）、最近访问；平台概览：集群、节点（异常在前）、最近发布。
>   - 移除 `SectionCards`、`TrafficChart` 和 appica Sparkline、Meter 的封装（不再有调用方），`appica-bridge.css` 同步去掉两条 `@source`。BorderBeam、GradientGlow 只留在登录与初始化页。
>   - 指标卡片和状态码卡片整张可点，打开 Cloudflare 式的详情浮窗（`detail-dialog.tsx`）：上面是按网站 / 节点（仅管理员）/ 状态码 / 缓存状态拆分的时间图，下面是排行列表（名称、占比条、数值，同时是图的表格视图）。流量类用折线（前 5 项），状态码和缓存状态用堆叠柱（前 5 项 + 灰色「其他」，柱宽按本地时钟取整：1 天 → 1 小时一根）。可拆的维度多于一个时以 Tab 切换；只看一个网站的租户没有可拆维度的指标显示放大的趋势图。浮窗内也有时间范围，与页面共用同一个 `?range=`。
>   - 拆分序列的颜色是新 token `--series-1`…`--series-5`（dataviz 分类色前 5 位）和 `--series-other`（灰）。在白底和 `#171717` 底下各自校验：相邻 CVD 色差最低 9.1 / 8.4，正常视觉最低 19.6 / 19.3；亮色下 3–5 号对白底不足 3:1，因此图例和排行列表总是显示数值。同一个浮窗里，某一项第一次拿到的颜色在刷新后保持不变。
> - 2026-09-25（收尾：落地页与界面规则）：
>   - 决策第 9 条在「数据展示重做」时被原地改写，现已恢复原文；那次的变化只以上面的「数据展示重做」记录为准（ADR README：已接受的 ADR 不改写结论）。决策第 4 条现在的写法（appica 也用于动效与数据展示类组件，复制按钮用 shadcn）是「Phase 0 之后的 UI 调整」时定下的，那条记录当时没有写明，在此补记。
>   - 营销页例外：`/` 是可选的公开落地页（后台系统设置里选模板；关闭时 `/` 直接跳到控制台首页 `/overview`，见 mvp.md 0.2）。落地页面向访客，可以有营销文案（标语、说明段落、FAQ），不受决策第 7 条限制，但文案仍全部走 Paraglide（zh-CN、en）。控制台和后台没有这条例外。
>   - 模板用中性名称 Horizon、Orbit；界面、文案和代码注释里不出现其他厂商的名称，也不写"仿照某站"。
>   - 落地页只用浅色（模板是固定的浅色色板）：`public/theme-init.js` 在 `/` 上不加 `.dark`，并在根节点标记浅色锁（`data-theme-lock`）；ThemeProvider 在锁被持有时显示浅色（`useLightTheme`，落地页挂载时持有，离开后恢复用户的主题），`/` 跳转到控制台或初始化页时释放首屏的锁（悬停预加载不释放）。锁在唯一的 ThemeProvider 里，决策第 5 条不变。锁住时快捷键 `d` 不改动保存的选择，sonner 跟随屏幕上的配色。所有 localStorage 访问都经过 `lib/theme.ts` 里带 try/catch 的函数，浏览器禁用站点数据时主题仍然可用。
>   - `/` 在三个请求完成前显示 `LoadingState`（`pendingMs: 0`，Loader 自带 200ms 延迟淡入，快的请求看不到），失败时显示错误态。
>   - Rubik 字体保留，只用于 Orbit 模板：`@fontsource-variable/rubik` 5.3.0，字体许可为 SIL Open Font License 1.1（包内附 LICENSE）。woff2 文件由 Vite 打包进 `dist/web/assets`，与控制台同源提供，不请求第三方字体服务；Playwright（`e2e/landing.spec.ts`）断言落地页不向其他源发请求。
>   - 模板配色是 `landing.css` 里的 CSS 变量（`--hz-*`、`--ob-*`；Orbit 插画用 `--ob-<色相>-<n>` 色阶，n = (1 − HSL 亮度) × 1000；阴影也是变量），后台设置里的模板缩略图用同一套变量。二维码用 `fill-black`。shadcn chart 里匹配 recharts 默认描边色的选择器移到 `index.css`（与上游 `chart.tsx` 的差异）。
>   - 一行安全提示改用 `SafetyNote`（`components/safety-note.tsx`）；`*Description` 组件（CardDescription、DialogDescription、FieldDescription 等）不再使用，Alert 的 AlertDescription 是提示内容本身，保留。确认对话框的 `note` 仍通过 `aria-describedby` 描述对话框。移除未使用的 Skeleton 与 SidebarMenuSkeleton。
>   - shadcn 组件里的无障碍文字（Spinner 的"加载中"、对话框和抽屉的"关闭"、侧边栏、面包屑、命令面板）改走 Paraglide；命令面板和移动端侧边栏的隐藏说明删除（Base UI 的对话框不要求说明）。
>   - `ui-rules.test.ts` 相应收紧：`src/web` 任何地方（包括 shadcn 组件）都不能有 Skeleton 和 `animate-pulse`；不能用 `*Description` 组件（AlertDescription 除外）；TS/TSX 里不能写十六进制或 `rgb()`、`hsl()`、`oklch()` 等颜色字面量；`src/web`、`index.html`、`public/` 里指向其他站点的 URL 只允许 ICP 备案查询、本项目仓库和 SVG 命名空间（另有 example.com、.test 等保留名称）；落地页代码和 `landing_*` 文案里不能出现其他厂商的名称。`i18n.test.ts` 用 Vite 导出的 oxc 解析器检查组件里的英文：JSX 文本、`aria-label` 等纯文本属性、`title`、`alt`，以及 `placeholder`、`label`、`description` 里成句的英文（启发式，允许清单只有产品名 Edgeweir）。
