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
   - 只用于 shadcn 没有的组件。shadcn 已有的组件（按钮、输入框、对话框、表格等）一律用 shadcn。
   - 不引入 appica-ui 的全局主题样式（如果它提供），不在 `:root` 上定义它的变量。
   - 通过 `appica-bridge.css` 在局部作用域内映射变量：appica 组件放在一个作用域容器内（例如由 `<AppicaScope>` 渲染、带固定 class 的元素），bridge 只在这个 class 下把 appica 期望的变量赋值为对应的 shadcn token。
   - 同名变量不能在作用域内自引用（`--primary: var(--primary)` 是循环引用，结果无效）。需要时先在 `:root` 为 shadcn token 定义别名（例如 `--ew-primary: var(--primary)`），bridge 再引用别名。
   - 作用域容器里只放 appica 组件，不嵌套 shadcn 组件，否则 shadcn 组件会读到被映射过的变量。
5. **全局只有一个 ThemeProvider**：采用 shadcn Vite 模板的明暗主题方案，在 `<html>` 上切换 `.dark`。appica 组件不单独挂 provider，通过 bridge 和 `.dark` 跟随主题。
6. **后台外壳**用 shadcn 的 sidebar、dashboard、chart、command、login 区块搭建。图标统一用 preset 指定的 Hugeicons。

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

- appica-ui 在第一次需要 shadcn 缺失的组件时引入，同时创建 `appica-bridge.css` 和作用域容器组件。
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
