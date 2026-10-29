# 界面基准

本文件是 Edgeweir 控制台的界面基准。界面改动遵循本文件；需要改变规则时，在同一次改动里修改本文件（见 [修改基准](#6-修改基准)）。

- 取值的唯一来源是 `apps/console/src/web/tokens.css`。本文件列出的数值与它一致，两者不一致时以 `tokens.css` 为准，并修正本文件。
- 路径相对于 `apps/console/src/web/`。

## 1. 设计理念

| 原则 | 含义 |
| --- | --- |
| 企业级、安静 | 灰色画布上的白色面板，1px 细线分隔；颜色只用来表达品牌、状态与数据 |
| 该密的地方密 | 表格、列表、监控面板紧凑（13px、44px 行高）；页面四周与面板之间留足空白 |
| 结构 | 参照腾讯云控制台：56px 顶栏、分组侧边栏、页头条带与线形页签、表格上方的筛选栏、`共 N 项` 表尾 |
| 观感 | 参照阿里云百炼：浅色调 KPI 卡片、克制的字重、只用于氛围页面的柔和渐变 |
| 组件来源 | 只用 [Arc](https://uiarc.dev) 免费层（MIT）；Arc 没有的面板、表单、表格由 `components/layout/` 提供 |
| 文案简短 | 一个标签、一个数值、一个动作；说明写进文档，不写进界面 |

刻意不做：

- 不用骨架屏（包括 Arc 的 Skeleton）与 `animate-pulse`。
- 不做装饰性动效：没有光晕、描边流光、粒子、倾斜、聚光灯，也没有常驻的循环动画（唯一例外是概览「边缘网络」的地球，见 [2.9](#29-动效)）。
- 数据背后不放渐变：表格、图表、表单下面永远是纯色面板。
- 没有页面副标题，对话框、面板、空状态没有说明段落。
- 面板不投阴影；阴影只属于浮层（菜单、弹出层、对话框、抽屉、提示）。
- 不用 Arc Pro，不用 shadcn/ui、appica 或其他组件库。
- 字重只有 400 与 500。

## 2. Token

三层：

| 层 | 位置 | 读取者 |
| --- | --- | --- |
| `--ew-*` 取值 | `tokens.css` 的 `:root`（浅色）与 `.dark`（深色） | 下面两层；应用 CSS 可直接读 |
| 语义名（`--background`、`--card`、`--primary`…） | `tokens.css` | Tailwind `@theme inline`（`index.css`），即 `bg-card`、`text-muted-foreground` 等类 |
| `--arc-*` | `components/arc/foundation.css` | Arc 组件的 CSS module |

- 主题：唯一的 `ThemeProvider` 在 `<html>` 上同时设置 `class="dark"` 与 `data-theme="dark"`；token 以 `.dark` 为准。主题可选浅色、深色、跟随系统。
- TS/TSX 中不写颜色字面量，一律用 token 或对应的 Tailwind 类。

### 2.1 颜色：品牌

| Token | 浅色 | 深色 | 用途 |
| --- | --- | --- | --- |
| `--ew-brand` | `#0052D9` | `#4582E6` | 指示：激活页签下划线、进度条、图表系列 1、选中的控件 |
| `--ew-brand-hover` | `#266FE8` | `#5C93EC` | 主按钮悬停 |
| `--ew-brand-active` | `#0034B5` | `#3A6FD8` | 主按钮按下 |
| `--ew-brand-fill` | `#0052D9` | `#3A6FD8` | 主按钮底色（白字 4.5:1） |
| `--ew-brand-on` | `#FFFFFF` | `#FFFFFF` | 品牌底色上的文字 |
| `--ew-brand-ink` | `#0052D9` | `#699EF5` | 品牌色文字：链接、激活的导航项、激活页签 |
| `--ew-brand-tint` | `#ECF2FE` | `#1B2F51` | 激活导航项底色、选中行、信息提示底色 |
| `--ew-brand-tint-strong` | `#D9E1FF` | `#22407A` | 按下的浅色、分段控件的选中项 |

### 2.2 颜色：状态

基色用于圆点、图标、图表与进度；`-ink` 用于文字（在面板、画布及其浅色底上达到 4.5:1）；`-tint` 用于提示与徽标底色。

| 状态 | 基色 浅 / 深 | `-ink` 浅 / 深 | `-tint` 浅 / 深 |
| --- | --- | --- | --- |
| success `--ew-success` | `#2BA471` / `#56C08D` | `#008858` / `#56C08D` | `#E3F9E9` / `#193A2A` |
| warning `--ew-warning` | `#E37318` / `#F08A3C` | `#AD5200` / `#F5A15B` | `#FFF1E9` / `#4F2A1D` |
| error `--ew-error` | `#D54941` / `#F36D64` | `#C4342C` / `#F7857D` | `#FFF0ED` / `#3A2422` |
| info `--ew-info` | = brand | = brand-ink | = brand-tint |

- 语义名：`--destructive` = error-ink；`--success`、`--warning` = 基色；`--success-ink`、`--warning-ink`；`--tint-success`、`--tint-warning`、`--tint-destructive`、`--tint-primary`。
- 表格与列表里的状态是「圆点 + 文字」，文字保持正文色。

### 2.3 颜色：中性色

| Token | 浅色 | 深色 | 用途 |
| --- | --- | --- | --- |
| `--ew-canvas` | `#F3F4F7` | `#181818` | 页面底色（`bg-background`） |
| `--ew-panel` | `#FFFFFF` | `#242424` | 面板、顶栏、侧边栏、页头条带、输入框、表格（`bg-card`） |
| `--ew-overlay` | `#FFFFFF` | `#2C2C2C` | 菜单、弹出层、对话框、抽屉、通知（`bg-popover`） |
| `--ew-faint` | `#F7F8FA` | `#2C2C2C` | 表头、代码与日志区、禁用输入、对话框内的灰色块（`bg-well`、`bg-muted`） |
| `--ew-hover` | `rgb(0 0 0 / 4%)` | `rgb(255 255 255 / 6%)` | 行、菜单项、幽灵按钮悬停（`bg-wash`） |
| `--ew-pressed` | `rgb(0 0 0 / 7%)` | `rgb(255 255 255 / 10%)` | 中性按下 |
| `--ew-hairline` | `#E7E8EB` | `#383838` | 面板边框、行分隔线、顶栏与侧边栏边线（`border`） |
| `--ew-border` | `#DCDCDC` | `#4B4B4B` | 输入框与默认按钮边框（`--input`） |
| `--ew-border-strong` | `#C5C5C5` | `#5E5E5E` | 悬停的输入框边框 |
| `--ew-text` | `rgb(0 0 0 / 90%)` | `rgb(255 255 255 / 90%)` | 正文、标题、数字 |
| `--ew-text-secondary` | `rgb(0 0 0 / 60%)` | `rgb(255 255 255 / 60%)` | 标签、表头、说明、单位（`text-muted-foreground`） |
| `--ew-text-placeholder` | `rgb(0 0 0 / 40%)` | `rgb(255 255 255 / 35%)` | 只用于占位符，不承载信息 |
| `--ew-text-disabled` | `rgb(0 0 0 / 26%)` | `rgb(255 255 255 / 22%)` | 禁用文字 |
| `--ew-scrim` | `rgb(0 0 0 / 40%)` | `rgb(0 0 0 / 60%)` | 对话框与抽屉的遮罩，不模糊 |
| `--ew-tooltip` / `--ew-tooltip-text` | `#242424` / `#FFFFFF` | `#4B4B4B` / `#FFFFFF` | 反色提示 |
| `--ew-control-edge` | `rgb(0 0 0 / 45%)` | `rgb(255 255 255 / 45%)` | 复选框、单选、开关的边界（3:1） |
| `--ew-focus` | `#0052D9` | `#699EF5` | 键盘焦点环 |

### 2.4 颜色：数据

| Token | 浅色 | 深色 |
| --- | --- | --- |
| `--ew-series-1` … `-5` | `#0052D9` `#029CD4` `#2BA471` `#E37318` `#8E56DD` | `#4582E6` `#3BB8E0` `#56C08D` `#F08A3C` `#A87FEA` |
| `--ew-series-other` | `#7A8599` | `#8B95A8` |
| `--ew-status-2xx` … `-5xx` | `#2BA471` `#0052D9` `#E37318` `#D54941` | `#56C08D` `#4582E6` `#F08A3C` `#F36D64` |
| `--ew-grid` | `#EEEFF2` | `#303030` |
| `--ew-axis` | `rgb(0 0 0 / 40%)` | `rgb(255 255 255 / 40%)` |
| `--ew-star` | `#E3A400` | `#F5BA18` |

- 每个系列在面板上达到 3:1。主系列总是品牌蓝；单系列图表只用系列 1。
- 线宽 1.5px，不加光晕或渐变描边；面积填充是系列色的低透明度。
- 语义名：`--series-*`、`--chart-*`、`--status-*`、`--metric`（= 系列 1）、`--signal`（= 系列 2，实时视图）、`--delta-good` / `--delta-bad`（环比变化的文字色）。

### 2.5 颜色：KPI 与氛围

| Token | 浅色 | 深色 | 用途 |
| --- | --- | --- | --- |
| `--ew-kpi-1` / `-2` / `-3` | `#EDF3FF` / `#EEF0FB` / `#EAF6FD` | `#1D2738` / `#23233A` / `#1B2C36` | 一行 KPI 卡片的浅色底，按 1→2→3 轮换（`bg-kpi-1..3`） |
| `--ew-mesh` | 蓝、青、紫三个径向渐变叠在 `--ew-mesh-base`（`#F5F8FF`）上 | 同构，底 `#10131C` | 氛围页面（`bg-mesh`），见 [4.16](#416-氛围页面) |
| `--ew-gradient-plan` | `linear-gradient(135deg, #3D7BFF, #6C8CFF 45%, #A58BFF)` | 同左 | 保留，控制台不使用 |

### 2.6 圆角与阴影

| Token | 值 | Tailwind | 用途 |
| --- | --- | --- | --- |
| `--ew-radius-badge` | 4px | `rounded-sm` | 徽标、标签、键帽 |
| `--ew-radius-control` | 6px | `rounded-md` | 按钮、输入框、选择器、菜单项、导航项、提示条 |
| `--ew-radius-panel` | 8px | `rounded-lg` | 面板、卡片、KPI 卡片、弹出层、菜单、通知 |
| `--ew-radius-dialog` | 12px | `rounded-xl` | 对话框、抽屉内侧边、登录卡片 |
| `--ew-radius-pill` | 9999px | `rounded-full` | 只用于头像、状态圆点、开关、进度条 |

| Token | 浅色值 | 用途 |
| --- | --- | --- |
| `--ew-shadow-1` | `0 1px 2px rgb(0 0 0 / 4%)` | 内容在其下滚动的吸附条 |
| `--ew-shadow-2` | 三层，最大 `0 8px 10px 1px rgb(0 0 0 / 6%)` | 菜单、弹出层、下拉列表、通知、浮动的批量操作条 |
| `--ew-shadow-3` | 三层，最大 `0 16px 24px 2px rgb(0 0 0 / 4%)` | 对话框、抽屉、命令面板、登录卡片 |

深色主题的阴影更深（透明度 30%–45%），完整取值见 `tokens.css`。面板一律 `bg-card border rounded-lg`，没有阴影。

### 2.7 字体与字号

- `--ew-font-sans`：Inter Variable（自托管）→ PingFang SC → HarmonyOS Sans SC → Microsoft YaHei → Noto Sans SC Variable（打包，只在没有系统中文字体时加载）→ 系统无衬线。
- `--ew-font-mono`：JetBrains Mono → SFMono-Regular → 系统等宽。域名、地址、路径、代码用等宽。
- 字重：`--ew-weight-regular` 400（`font-normal`）、`--ew-weight-medium` 500（`font-medium`）。不用 600/700，不合成粗体。
- 数字：表格、徽标、数字输入、KPI 用 `tabular-nums`（`readout` 工具类）。
- 中文与拉丁字母之间的间隙由浏览器（`text-autospace`）处理，文案里不打空格。

| Token | 字号 / 行高 | Tailwind | 用途 |
| --- | --- | --- | --- |
| `--ew-text-caption` | 12 / 20 | `text-xs` | 辅助行、单位、侧边栏分组标签、徽标 |
| `--ew-text-dense` | 13 / 20 | `text-dense` | 表格单元格与表头、表尾、监控卡片标题 |
| `--ew-text-body` | 14 / 22 | `text-sm` | 默认正文、表单标签、按钮、导航项 |
| `--ew-text-section` | 16 / 24，500 | `text-section` | 面板标题、对话框标题、产品名 |
| `--ew-text-title` | 18 / 26，500 | `text-title` | 页面标题 |
| `--ew-text-display` | 28 / 36，500 | `text-display` | KPI 数字 |
| `--ew-text-hero` | 36 / 44，500 | `text-hero` | 只用于登录、初始化 |

### 2.8 间距与尺寸

| Token | 值 | 用途 |
| --- | --- | --- |
| `--ew-space-1` … `-12` | 4、8、12、16、20、24、32、40、48 px | 4px 网格 |
| `--ew-topbar-height` | 56px | 顶栏（`--header-height`） |
| `--ew-sidebar-width` | 208px | 侧边栏 |
| `--ew-rail-width` | 56px | 收起后的图标栏 |
| `--ew-content-max` | 1600px | 内容列最大宽度 |
| `--ew-gutter` / `--ew-gutter-phone` | 24px / 16px | 内容列左右边距（768px 以下用后者） |
| `--ew-control-sm` / `-md` / `-lg` | 28 / 32 / 36 px | 控件高度，默认 md |
| `--ew-control-touch` | 44px | 粗指针（`pointer: coarse`）下所有控件的高度 |
| `--ew-row-height` | 44px | 表格行；表头 40px |
| `--ew-form-label` | 120px | 表单标签列 |

面板内边距 20px（手机与 `size="sm"` 为 16px），面板之间 16px，内容列在页头条带下方 20px 开始，底部留 40px。

### 2.9 动效

| Token | 值 | 用途 |
| --- | --- | --- |
| `--ew-ease-standard` | `cubic-bezier(0.22, 1, 0.36, 1)` | 一般过渡 |
| `--ew-ease-enter` | `cubic-bezier(0.16, 1, 0.3, 1)` | 进入 |
| `--ew-ease-exit` | `cubic-bezier(0.7, 0, 0.84, 0)` | 离开 |
| `--ew-duration-instant` | 120ms | 悬停、按下 |
| `--ew-duration-fast` | 160ms | 菜单、提示 |
| `--ew-duration-standard` | 240ms | 对话框、抽屉、侧边栏收起 |

- 只有淡入淡出与不超过 8px 的位移；弹簧不回弹（`components/arc/motion-tokens.ts`）。
- 页面与面板入场用 `animate-enter`（200ms 淡入）；列表行用 `enterDelay(index)` 错开 20ms，最多错开 12 行。
- 允许的持续动画只有：加载转圈、2px 顶部进度条、进行中状态的圆点脉冲（`dot-pulse`），以及概览「边缘网络」卡片里慢转的地球（cobe，`effects/edge-globe.tsx`）：标出节点公网地址的 GeoIP 位置，按健康着色、按节点数定大小，可拖动；离屏、标签页在后台或减少动态效果时停转，没有光晕；旁边的位置列表是它的文字替代。KPI 数字变化时滚动（`FlowNumber`），折线图挂载时画出。
- Motion 只经 `components/effects/motion`，在 `LazyMotion` 下使用轻量组件。
- 减少动态效果（`prefers-reduced-motion: reduce`）：位移与缩放变为淡入淡出，循环停止，进度条静止，数字不滚动。

### 2.10 层级

层级没有 token，以下是组件中固定的值；新增浮层沿用这一顺序。

| z-index | 元素 |
| --- | --- |
| 1 | 横向滚动时固定的首列（`cell-pinned`） |
| 2 | 吸附的表头 |
| 10 | 吸附的保存条、浮动批量操作条、拖动中的行 |
| 30 | 顶栏 |
| 50 / 51 | 对话框与抽屉的遮罩 / 面板 |
| 60 | 菜单、下拉列表、通知栈、顶部进度条 |
| 90 | 提示（tooltip） |

## 3. 布局

框架：`components/shell/app-shell.tsx`（顶栏 + 侧边栏 + 画布）与 `components/page.tsx`（页头条带 + 内容列）。

### 3.1 顶栏

`components/shell/top-bar.tsx`

- 56px，`bg-card`，底部细线，吸附在顶部。
- 起始：菜单按钮（只在 768px 以下），品牌块（28px 品牌色方块里的标志）与产品名（16px 500）。桌面端品牌区与侧边栏同宽。
- 末尾依次：⌘K 搜索框、语言、主题、告警、账户。顺序固定。
  - 搜索框：32px 高，宽 `min(20rem, 28vw)`，`bg-well` 底，占位文字与 `⌘ K` / `Ctrl K` 键帽；点击打开命令面板。768px 以下换成图标按钮。
  - 语言、主题、告警：32px 图标按钮，次要文字色，悬停 `bg-wash`，带提示。告警在有待处理事项时显示红点。640px 以下隐藏语言按钮（账户菜单里也有）。
  - 账户：40px 高的块，28px 头像 + 名字（13px）与角色（11px 次要色）；1024px 以下只显示头像。菜单包含账户页面、语言、主题、退出。
- 不放外部文档链接。

### 3.2 侧边栏

`components/shell/side-nav.tsx`，导航定义在 `components/nav-items.tsx`

- 208px，`bg-sidebar`（= 面板色），右侧细线，从顶栏下吸附到视口底部；底色与细线贯穿整页。
- 顶部是控制台的主操作（次要按钮，全宽）。
- 导航按组排列：12px 次要色的组标签，组间 16px。
- 导航项：36px 高（粗指针 44px），6px 圆角，左右缩进 8px，14px 文字，16px 次要色图标；悬停 `bg-wash`；激活项为 `--ew-brand-tint` 底 + `--ew-brand-ink` 文字与图标 + 500 字重，不加竖条，带 `aria-current="page"`。
- 需要处理的事项数显示在对应导航项末尾，为警告色徽标；数量为 0 时不显示。
- 底部的「收起侧边栏」把它收成 56px 图标栏：只显示图标，标题移到右侧提示，组之间用细线分隔，宽度过渡 200ms。选择按浏览器记住（`localStorage` 键 `edgeweir.sidebar-rail`，读写失败时只在本页生效）。
- 768px 以下侧边栏换成从左侧滑出的 Arc Drawer（288px），由顶栏菜单按钮打开，任何导航都会关闭它。

### 3.3 页头条带与页签

`Page`、`PageTabs`（`components/page.tsx`）

- 画布顶部一条白色带（`bg-card`，底部细线，`data-slot="page-header"`），内部列与内容列对齐（同样的最大宽度与边距）。
- 第一行至少 56px：可选的返回按钮（幽灵图标按钮）、页面标题（`text-title font-medium`，`h1`，超长截断）、页面操作（末尾）。640px 以下操作换到标题下方。
- 没有副标题，没有面包屑。
- 页面的线形页签（`TabsList variant="line"`）放进 `PageTabs`，渲染在条带内、标题下方；条带的底线就是页签栏的线，页签列表自己不画边框。页签：激活项 `--ew-brand-ink` 文字 + 500 字重 + 2px `--ew-brand` 下划线，其余为次要色。页签超出宽度时横向滚动，并在被遮挡的一侧渐隐（`scroll-fade`）。
- 页签状态保存在 URL（`?tab=`）。

### 3.4 画布、内容列与面板

- 条带以下是灰色画布（`bg-background`）。内容列 `max-w-(--ew-content-max)` 居中，左右 24px（手机 16px），上 20px、下 40px，块之间 16px。
- `width="narrow"` 的页面（短表单）内容列最大 60rem。
- 内容列是名为 `main` 的容器，组件按它的宽度（容器查询）而不是视口变化。
- 面板：`Panel`、`PanelHeader`、`PanelTitle`、`PanelAction`、`PanelContent`、`PanelFooter`（`components/layout/panel.tsx`）。`bg-card`，1px 细线，8px 圆角，无阴影，内边距 20px。标题 16px 500，操作在标题行末尾。超宽内容在面板内横向裁切，不撑宽手机页面。
- 面板内的次级区域（代码、日志、选项列表）用 `faint-well`：`bg-well` + 细线。

### 3.5 断点

| 断点 | 宽度 | 变化 |
| --- | --- | --- |
| `sm` | 640px | 页面操作与标题同行；顶栏显示语言按钮 |
| `md` | 768px | 显示侧边栏（以下为抽屉）；顶栏显示搜索框；边距 24px（以下 16px） |
| `lg` | 1024px | 账户块显示名字与角色 |
| 容器 `main` < 42rem | 672px | 数据表格的行变为卡片 |
| 容器 `panel` ≥ 40rem | 640px | 表单标签左置 |
| 容器 `main` < 64rem / 72rem | 1024 / 1152px | 标记 `hideBelow: "lg"` / `"xl"` 的次要列隐藏 |
| `pointer: coarse` | — | 所有控件、导航项、页签至少 44px |

## 4. 组件与模式

所有组件来自 Arc 免费层（`components/arc/<name>/`，Radix 部分移植到 Base UI，图标用 Hugeicons，文案经 Paraglide），或基于 token 的自有布局部件（`components/layout/`）。

### 4.1 按钮

Arc `Button`（`components/arc/button/button.tsx`）；路由链接用 `LinkButton`。

| 变体 | 外观 | 用于 |
| --- | --- | --- |
| `primary`（默认） | `--ew-brand-fill` 底、白字，悬停 `-hover`、按下 `-active`，无阴影 | 一个区域里唯一的主操作：新建、保存、提交 |
| `secondary` | 面板底 + `--ew-border` 边框 + 正文色 | 其他操作、筛选按钮、时间范围、翻页 |
| `ghost` | 无底，悬停 `bg-wash` | 图标按钮、行菜单、返回 |
| `danger` | `--ew-error` 底、白字 | 只用于破坏性确认对话框的确认按钮 |

- 尺寸 `sm` / `md` / `lg` = 28 / 32 / 36px；页头与工具栏用 `sm`。纯图标按钮加 `icon-button`（正方形），并且必须有 `aria-label` 与提示。
- 默认 `type="button"`；只有表单的提交按钮写 `type="submit"`。
- 提交中：按钮禁用并在文字前显示 `Spinner`。

做：每个区域只有一个主按钮。不做：在列表行里放「编辑 / 删除」按钮对；给按钮加阴影或渐变。

### 4.2 表单

`Field`、`FieldLabel`、`FieldError`、`FieldSet`、`FieldGroup`（`components/layout/form.tsx`），`InputGroup`（`components/layout/input-group.tsx`），Arc `Input`、`Textarea`、`Select`、`Switch`、`Checkbox`、`OtpInput`。

- 设置表单放在 `PanelContent form` 或 `SettingsCard`（`components/settings-card.tsx`）里。面板宽度 ≥ 40rem 时标签左置：120px 标签列（次要色）+ 24px 间隔 + 最宽 32rem 的控件列，行距 24px；没有标签的行（开关、提示、添加按钮）从控件列开始。对话框、窄面板、手机上标签在上。
- 控件宽度贴合内容：端口窄，域名宽。
- 输入框：面板底，1px `--ew-border`，悬停 `--ew-border-strong`，聚焦边框 `--ew-brand` + 品牌色 20% 光环，错误边框 `--ew-error`。
- 校验：字段错误用 `FieldError`（`role="alert"`，12px `text-destructive`）紧贴字段显示；保存失败的错误显示在保存按钮旁；字段错误优先于通知。
- 设置的来源徽标（「已保存 / 环境变量 / 默认」，`SettingSourceBadge`）放在控件下方，不挤占标签列。
- 保存条：`SaveBar`（`components/site/save-site.tsx`）。按钮在前，与控件列对齐（`indent`）；未修改时禁用，保存中显示转圈；长编辑器传 `sticky`，保存条吸附在视口底部（面板底色 + 顶部细线）。
- 有未保存修改时，离开页面或切换页签先确认（`useUnsavedChanges` + `UnsavedChangesGuard`）；同页的筛选与翻页不拦截。

做：每个表单一个保存按钮。不做：字段说明段落（`FieldDescription` 等）；每次按键都校验。

### 4.3 表格

`DataTable`、`FilterBar`（`components/data-table.tsx`），`Table` 系列（`components/layout/table.tsx`），`Pager`（`components/pager.tsx`），`SearchBox`（`components/search-box.tsx`），`ItemMenu`（`components/row-menu.tsx`），`MoreList`（`components/more-list.tsx`）。

| 部位 | 规则 |
| --- | --- |
| 主操作 | 在页头条带的页面操作里（`size="sm"` 主按钮），不在筛选栏里 |
| 筛选栏 | 表格上方一行可换行的 `FilterBar`：子列表切换（默认变体 `TabsList`）、搜索框（宽 18rem，手机全宽，停止输入 300ms 后写入 URL）、筛选选择器、次要按钮 |
| 容器 | `bg-card` + 细线 + 8px 圆角，不投阴影 |
| 表头 | 40px，`bg-well` 底，13px 400 次要色；表格不横向滚动时吸附在顶栏下方 |
| 行 | 44px，13px，单元格左右 16px、垂直居中，细线分隔；悬停 `bg-wash`，选中 `bg-tint-primary` |
| 打开 | 有行链接（`rowLink`）的行点击任意位置打开，键盘聚焦链接时整行着色 |
| 行操作 | 次要操作收在行末的「…」菜单（`ItemMenu`），删除放在最后、分隔线之后，并经确认对话框 |
| 单元格内的列表 | 保持一行：首项 + `+N`，其余放在提示里（`MoreList`） |
| 状态 | 「圆点 + 文字」（`StatusDot`） |
| 宽表 | 次要列用 `hideBelow` 先隐藏；仍然放不下时表格在面板内横向滚动，`pinFirstColumn` 固定首列 |
| 批量 | 首列复选框；选中后底部浮出操作条（`bg-overlay` + `shadow-elev-2`，吸附在视口底部） |
| 表尾 | 顶部细线，13px 次要色：左侧 `共 N 项`（`table_total`），右侧 `Pager`（`21–40 / 57` + 上一页 / 下一页，只有一页时不显示） |
| 空 | 列表为空：`EmptyState`，小图标 + 一行标题 + 主操作 |
| 排序 | 可排序的列在表头文字后放箭头按钮（`DataTable` 的 `sort`，列有 `accessorFn` 即可排序），一次一列，`aria-sort` 标明方向；排序写入 URL（`sort=name` / `sort=-port`）。分页由服务端完成的列表不在页内排序 |
| 时间 | 相对时间用 `TimeAgo`（`components/time-ago.tsx`），悬停显示完整日期时间 |
| 无结果 | 筛选后为空：`NoMatch`（`components/states.tsx`），搜索图标 + 「没有匹配的…」+ 次要按钮「清除筛选」，与「还没有…」区分 |

手机上的卡片见 [4.17](#417-手机卡片)。

做：搜索、筛选与页码保存在 URL，返回时仍在。不做：在表格外面再套一层面板标题；表头用粗体。

### 4.4 KPI 卡片

`components/overview/live-kpis.tsx`

- 浅色底（`bg-kpi-1..3` 依次轮换），无边框、无阴影，8px 圆角，最小高度 144px。
- 首行：16px 图标 + 13px 次要色标签，可选的时间范围在末尾；下面是 `text-display` 数字（500），单位跟在数字后。
- 数字变化时滚动（`FlowNumber`），首次加载显示加载状态，不显示一排 0。
- 实时数据的卡片组标题旁放 `LiveDot`。

### 4.5 图表与监控面板

`components/analytics/`（`panel.tsx` 的 `MetricCard`、`breakdown-charts.tsx`、`range-select.tsx`），Arc `LineChart`、`Sparkline`，`components/effects/`（实时图、拓扑、地图）。

- 监控卡片是细线面板：13px 次要色标题，下方是数值与环比（`↗ 39.6%`，好坏用 `--delta-good` / `--delta-bad`，并带读屏文字），再下方是图表。整张卡片可点击打开明细对话框，悬停时右上角出现展开图标。
- 卡片按内容列宽度排成 2–4 列网格；一行小卡片都没有数据时只显示数值，不画空图。
- 折线图：Arc `LineChart`；空值留缺口；比例用 `domain`；卡片里的小图用 `axis={false}`。横轴标签按可用宽度隔项显示，最新一项总在，标签不重叠（堆叠条同样）。网格线 `--ew-grid`，坐标轴文字 `--ew-axis`。
- 堆叠条与状态码条：`breakdown-charts.tsx` 的 SVG，状态码用 `--ew-status-*`，片段之间留间隙。
- 表格单元格里的趋势：`Sparkline`，单系列品牌蓝。
- 时间范围：区域标题行末尾的次要按钮（日历图标 + 当前范围），点开为单选菜单（`RangeSelect`）；旁边是刷新等图标按钮。
- 进度与配额：`Meter`（1.5px 高轨道，按区间着成功 / 警告 / 错误色），必须同时显示数值文字。

不做：图表下面放渐变或网格背景；双色渐变线；没有数据时画一条 0 线冒充数据。

### 4.6 提示条

Arc `Alert`（`components/arc/alert/alert.tsx`）

- 语气 `info`（默认）、`success`、`warning`、`danger`；浅色底（对应 `-tint`），无边框，6px 圆角，16px 状态色图标，14px 文字，一行。
- `danger` 用 `role="alert"`，其余用 `role="status"`。
- 用于页面或面板内的状态说明与加载失败（`ErrorState`）；不写说明段落。

### 4.7 对话框与抽屉

Arc `Dialog`、`Drawer`；`FormDialog`（`components/form-dialog.tsx`）、`ConfirmDialog` / `ControlledConfirmDialog`（`components/confirm-dialog.tsx`）。

- 对话框：`bg-popover`，12px 圆角，`--ew-shadow-3`，遮罩 `--ew-scrim`（不模糊），默认最宽 28rem，手机上左右各留 16px。标题（16px 500）+ 关闭按钮，内容，页脚。
- 表单对话框：标签在上；页脚有顶部细线，右侧依次是「取消」（`secondary`）与提交按钮，长表单滚动时页脚保持可见；错误显示在字段下方，对话框不关闭；Esc 与关闭按钮关闭。
- 确认对话框：标题写明对象（「删除网站 shop.example.com？」这类）；可选一行 `SafetyNote` 说明会影响什么；破坏性确认在标题旁放红色浅底警告图标，确认按钮为 `danger`；失败时错误留在对话框里。
- 抽屉：用于手机导航与需要保留页面上下文的长内容；内侧边 12px 圆角，`--ew-shadow-3`。

### 4.8 状态圆点

`Dot`、`StatusDot`、`LiveDot`（`components/status-dot.tsx`）

| 语气 | 颜色 | 含义 |
| --- | --- | --- |
| `good` | `--ew-success` | 正常、在线、运行中 |
| `warn` | `--ew-warning` | 进行中、部分生效、需要注意 |
| `bad` | `--ew-error-ink` | 失败、离线 |
| `idle` | 次要色 50% | 停用、未知 |

- 圆点 8px（`small` 6px），永远与文字成对出现；文字保持正文色。
- `pulse` 只用于会结束的进行中状态（签发、发布、灰度、等待心跳）；常驻状态不闪烁。减少动态效果时不脉冲。

### 4.9 徽标

Arc `Badge`（`components/arc/badge/badge.tsx`）

- 语气 `neutral`、`success`、`info`、`warning`、`danger`：浅色底 + `-ink` 文字；4px 圆角，12px，`sm` 20px 高（表格内）、`md` 24px 高。
- 用于标签、来源、计数、环境；不用来表示行的运行状态（那是状态圆点）。

### 4.10 加载、空与错误状态

`QueryView`、`LoadingState`、`ErrorState`、`EmptyState`（`components/states.tsx`、`components/loading-state.tsx`）

- 每个数据区域都有加载、空、错误三种状态，经 `QueryView` 渲染。
- 首次加载：居中的转圈 + 「加载中」，延迟 200ms 淡入，快的请求不闪。
- 刷新已有数据：保留旧内容，只走顶部进度条；后台刷新失败继续显示旧数据。
- 首次加载失败：`danger` 提示条 + 重试按钮。记录不存在（404）时用页面自己的「未找到」内容。
- 空：Arc `EmptyState`，24px 图标 + 一行标题 + 可选操作，居中；面板内的空小节用 `compact`（一行文字与操作并排，`bg-well` 底）。不写说明。

### 4.11 顶部进度条

`TopProgress`（`components/top-progress.tsx`）

- 视口顶部 2px，`z-60`，品牌色不定进度扫动（1.1s 循环）。
- 路由加载、请求、提交时出现，超过 150ms 才显示。
- 已加载数据的后台轮询（`meta: { background: true }`）不触发。
- 减少动态效果时为静止的满条。

### 4.12 通知

`toast`（`lib/toast.ts`）→ Arc toast stack（`components/toaster.tsx`，全局一个）

- 类型 `success`、`info`、`warning`、`error`、`loading`；`loading` 保持到被同 id 更新。
- 用于用户视线之外的结果（后台任务完成、复制成功、撤销入口）。表单与对话框里的错误留在原处，不改用通知。

### 4.13 命令面板

`CommandMenu`（`components/command-menu.tsx`），基于 Arc command palette

- `⌘K` / `Ctrl K` 或顶栏搜索框打开。
- 内容：网站（无搜索时为星标与最近，按名称、域名、标签搜索）、标签、网站的快捷操作（防御模式、刷新缓存）、所有页面、全局操作（新建、主题、语言）。
- 新页面与新的主要操作都要加入命令面板。

### 4.14 页面操作菜单与提示

- 页头的次要操作收进「…」菜单（Arc `DropdownMenu`），破坏性项为 `destructive` 变体，排在最后。
- 提示（Arc `Tooltip`）：反色底，12px 白字，4px 圆角，无箭头；用于图标按钮、截断文字、禁用原因。
- 禁用原因：因条件不满足而禁用的控件包在 `DisabledHint`（`components/disabled-hint.tsx`）里，悬停或聚焦时用一句话说明原因（「先创建集群」「最多 64 条规则」）；提交中、未修改这类显而易见的禁用不加。

### 4.15 一行安全提示

`SafetyNote`（`components/safety-note.tsx`）：14px 次要色的一行，只说明风险或影响（「仅显示一次」「将影响 3 个网站」），不解释功能。

### 4.16 氛围页面

`AuthShell`、`AuthFrame`（`components/auth-shell.tsx`），概览欢迎条（`routes/_app/overview.tsx`）

- `bg-mesh` 只用于登录、初始化、概览顶部的欢迎条。
- 登录与初始化：全屏渐变，居中 24rem 列；上方是 36px 品牌方块与产品名；卡片为白色面板，12px 圆角，`--ew-shadow-3`，无边框，内边距 32px（手机 20px）；右上角主题切换；卡片切换时淡入淡出。
- 初始化显示步骤条（账户、节点、网站）。
- 欢迎条：8px 圆角的渐变条，左侧问候（`text-title`），右侧最多两个起步操作。
- 渐变上的内容放在白色面板上或只放标题与按钮；表格、图表、表单不放在渐变上。

### 4.17 手机卡片

`DataTable` 的 `stack`（默认开启）在内容列窄于 42rem 时把每行变成卡片：

- 首行：`lead` 列（名称与行链接）、`aside` 列（状态）在其末尾、`end` 列（行菜单）在最末。
- 其余列为带标签的行：5.5rem 宽的 12px 次要色标签 + 13px 值；`hide` 与 `hideBelow` 的列不出现；空单元格不占行。
- 卡片内边距 14px × 16px；表头只保留全选复选框（如有）。
- 页面因此在手机上没有横向滚动；只有读成网格的表格才关闭 `stack`。

## 5. 文案、国际化、无障碍与手机

### 5.1 文案

- 面向用户，简短：标签用名词，按钮用动词（「新建网站」「保存」）。
- 没有页面副标题；对话框、面板、空状态不写说明段落（不用 `*Description` 组件）。唯一允许的补充是一行 `SafetyNote`。
- 空状态是一行标题加一个操作。
- 错误具体：说明哪里错、怎么改；服务端返回错误码，界面按语言翻译。
- 同一概念在所有页面用同一个词。
- 数字：千分位与单位按语言格式化（中文用「万」），时间可同时给相对与绝对值（提示中给后者）。

### 5.2 国际化

- 所有界面字符串经 Paraglide：`apps/console/messages/zh-CN.json`（默认）与 `en.json`，key 为 snake_case，以页面或功能开头。
- 两种语言同时增改；key、占位符一致，值不为空；英文数量用复数变体。
- 组件里不写中文或英文界面文字，包括 `aria-*`、`title`、`alt`、`placeholder`。

### 5.3 无障碍

| 项 | 规则 |
| --- | --- |
| 焦点 | 只在键盘操作时显示：没有边框的元素用 `focus-ring`（2px `--ew-focus` 内描边），输入框用品牌色边框 + 20% 光环 |
| 对比度 | 文字在所在表面上 ≥ 4.5:1；焦点环、控件边界、数据描边 ≥ 3:1；两套主题都满足 |
| 名称 | 图标按钮有 `aria-label`；当前导航项 `aria-current="page"`；加载状态 `role="status"` |
| 颜色之外 | 状态总有文字；环比带方向图标与读屏文字；进度与配额同时显示数值 |
| 键盘 | Tab 顺序与视觉一致；Esc 关闭对话框、抽屉、菜单；`⌘K` 打开命令面板 |
| 强制颜色 | 焦点改为 `Highlight` 轮廓；选中、激活、进度填充用系统色（`index.css`） |
| 减少动态效果 | 见 [2.9](#29-动效) |
| 安全上下文 | 不依赖只在 HTTPS 下可用的浏览器 API（控制台可能经局域网 HTTP 访问） |

### 5.4 手机

- 以 390px 宽验收，375px 也不得出现横向页面滚动；浅色与深色都检查。
- 768px 以下：侧边栏变抽屉，导航后自动关闭；边距 16px；面板内边距 16px。
- 触控：粗指针下控件、导航项、页签至少 44px；行操作在卡片首行末尾可点。
- 页面操作在 640px 以下换到标题下方；页签栏横向滚动并渐隐边缘；筛选栏各项全宽堆叠。
- 对话框宽度为视口减 32px，长表单在对话框内滚动，页脚保持可见。

## 6. 修改基准

- 改变规则或数值时：在同一次改动里修改 `tokens.css`（数值只写在这里）与本文件，并补一条 ADR 记录说明原因。
- 新组件优先从 Arc 免费层安装（`npx shadcn add @uiarc/<name>`），按本文件移植到 `--arc-` token、Base UI、Hugeicons 与 Paraglide。
- 规则测试不得削弱、跳过或删除；规则变化时同步修改测试。

以下部分由测试强制执行：

| 测试 | 强制的规则 |
| --- | --- |
| `apps/console/test/web/ui-rules.test.ts` | 无骨架屏与 `animate-pulse`；无说明段落组件；TS/TSX 无颜色字面量；外部链接只限允许清单；只用 Arc 免费组件，无 shadcn/ui 与 appica；`components/layout/` 只依赖 React、Base UI、Arc、Hugeicons 与 `lib/`；视觉效果库只经 `components/effects`，重型效果按页懒加载；Motion 只用轻量组件；排除的视觉库不得引入；token 在 Arc 桥接之前只加载一次；Arc 使用的 `--arc-` 名都在 `foundation.css` 定义；按钮默认 `type="button"`；行可从任意位置打开；加载与错误状态经 `QueryView`，后台刷新失败保留数据；不用安全上下文专用 API |
| `apps/console/test/web/tokens.test.ts` | Arc 来自免费注册表并使用 Hugeicons；字体为 Inter + 平台中文字体 + 打包后备；两套主题定义了全部品牌、状态与中性 token；状态页使用控制台 token；全局只有一个 `ThemeProvider` |
| `apps/console/test/web/contrast.test.ts` | 两套主题下正文 4.5:1、焦点环与控件边界 3:1、数据描边 3:1 |
| `apps/console/test/web/theme.test.ts` | 首屏主题、存储不可用时的回退 |
| `apps/console/test/web/i18n.test.ts` | 默认 zh-CN 并带 en；key、占位符、复数变体一致；组件里没有中文与英文界面文字 |
| `apps/console/test/web/third-party.test.ts` | 界面中第三方代码的许可证 |
| `apps/console/e2e/helpers.ts`（`shots`） | 截图覆盖浅色与深色，375px 宽时页面不得横向滚动 |

没有被测试覆盖的规则（布局尺寸、文案风格、组件用法）由评审对照本文件与截图检查。
