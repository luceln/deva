# DevaPlus 设计系统（现状抽取）

> 本文由代码抽取生成，描述的是**实际在用**的做法，不是理想规范。
> 用于设计评审时判断「新界面是否符合本项目习惯」。
>
> 抽取范围：`apps/desktop/src/renderer/src/redesign/redesign.css`（6306 行）+ 该目录 25 个组件文件 + token 源 `styles/tokens.css`。
> 引用格式 `css:行号` / `文件.tsx:行号`，路径均相对 `E:\deva\apps\desktop\src\renderer\src\`。

---

## 一、Token 速查

### 1.1 颜色：全部来自 `styles/tokens.css`，redesign.css 里一个颜色变量都没定义

`redesign.css` 里自定义的 `--cf-*` 只有 3 个，且**全是尺寸不是颜色**：

| 变量 | 值 | 定义处 | 用途 |
|---|---|---|---|
| `--cf-main` | `780px` | css:19 | 对话/快速开启中列内容宽 |
| `--cf-dock-room` | `38px` | css:1114 | 输入框上方胶囊排占位高 |
| `--cf-dock-text-max` | `160px` | css:2584 | 胶囊内文字最大宽 |

语义变量（`tokens.css`，明/暗双套）：

| 分类 | 变量 | 明色 | 暗色 | 用次（css 内） |
|---|---|---|---|---|
| **强调色** | `--accent` | `#5b5bd6` | `#7c7cf0` | 74 |
| | `--accent-hover` | `#4c4cc4` | `#9090f5` | 4 |
| | `--accent-fg` | `#ffffff` | `#14141a` | 5 |
| | `--accent-tint` | `rgba(91,91,214,.10)` | `rgba(124,124,240,.16)` | 9 |
| 文字灰阶（3 档） | `--fg` | `#1f1f24` | `#e4e4e7` | 82 |
| | `--fg-muted` | `#5c5c66` | `#a1a1aa` | 76 |
| | `--fg-subtle` | `#8a8a94` | `#71717a` | 96 |
| 底色（4 层） | `--bg` | `#ffffff` | `#1e1e20` | 11 |
| | `--bg-panel` | `#f7f7f8` | `#252528` | 16 |
| | `--bg-elevated` | `#ffffff` | `#2a2a2e` | 26 |
| | `--bg-inset` | `#f0f0f2` | `#191919` | 34 |
| 状态叠色（3 层，半透明） | `--bg-hover` | 黑 4.5% | 白 6% | 54 |
| | `--bg-active` | 黑 8% | 白 10% | 5 |
| | `--bg-selected` | accent 12% | accent 20% | 6 |
| 边框（2 档） | `--border` | `#e6e6ea` | `#2f2f33` | 68 |
| | `--border-strong` | `#d5d5db` | `#3d3d42` | 16 |
| 语义色 | `--danger` / `--warning` / `--success` / `--info` | `#e5484d` / `#d9860b` / `#2f9e44` / `#3a7bd5` | 亮一档 | 44/16/16/2 |
| 专用 | `--chat-user-bubble` | `#edeffb` | `#303043` | 1 |

**结论：只有一个强调色（紫 `--accent`）。** 四个语义色用于状态/危险操作，不做装饰。文件类型另有 8 个 `--ft-*`（tokens.css:70-77），仅在附件卡片用一次（css:4074 经 `--tc` 中转）。

### 1.2 硬编码色值：55 处，集中在 4 类场景（其余全部走变量）

| 场景 | 值 | 位置 | 判断 |
|---|---|---|---|
| 白字压深色底 | `#fff` ×11 | css:925/1755/1802/4197/4564/4845/5370/5704/3598 等 | 合理（图片遮罩、主题色/危险色按钮上的字） |
| `--success` 的兜底值 | `#2e7d32` ×6 | css:5075/5129/5130/5171/5172/5206 | **应删**，`--success` 在 tokens.css 已定义，兜底是冗余；且它与 `--success:#2f9e44` 不是同一个绿 |
| 图片查看器遮罩 | `rgba(0,0,0,.42/.55/.4/.6)` | css:4130/4160/4183/4192/4198 | 合理（浮在任意内容上，需固定深色） |
| color-mix 的混色锚点 | `#000` / `#fff` | css:887/893/1812 | 合理（替代不支持的 `black`） |

遗留待清：`#bbb`（css:5544 扫码占位）、`#2b8a3e`（css:6036 暗色下任务角标绿，与 `--success` 暗色 `#51cf66` 不一致）。

### 1.3 字号：**24 种取值，远超 4 档；32% 的声明小于 12px**

实测分布（`redesign.css` 共 210 处 `font-size` 声明，24 个不同值）：

| 值 | 次数 | 实际层级/场景 |
|---|---|---|
| **20px** | 4 | 页面级大标题：角色资料卡名 css:3071、快速开启标题 css:3239、关于页名 css:3620、名片页名 css:4249 |
| 17px | 1 | 机器人详情名 css:5433 |
| 16px | 1 | 配对码 css:5623 |
| 15px | 2 | 设置页分区标题 css:3404、输入框工具按钮 css:2940 |
| 14px | 2 | 对话头角色名 css:1189、弹窗标题 css:3330 |
| **13.5px** | 3 + 4×calc | **对话正文**（`calc(13.5px * var(--cs))` css:2007）、输入框正文 css:2827/2841、栏标题 css:726、成员名 css:6260 |
| **13px** | 46 | **正文基准**：列表标题、按钮、菜单项、设置行、表单控件 |
| 12.5px | 8 | 胶囊、标签、文件卡名 |
| **12px** | 69 | **辅助行**：次级说明、时间、占位符、下拉选项、标签 |
| 11.5px | 27 | 更弱辅助：专长、计数、路径、提示 |
| **11px** | 30 | **徽标/微标签**：时间戳、分组头、状态签、kbd 说明 |
| 10.5px | 3 | 徽标 css:2487/3026/3556 |
| 10px | 2 | 计数气泡 css:830/5033 |
| 9.5px / 9px / 8px | 3 | 头像叠层 "+N" css:5712/935/5718 |

**判据（项目实际口径）**：
- 正文 **13px**（`.cf-shell` 根 `font-size:13px`，css:15）；对话正文 **13.5px** 并乘 `--chat-scale`。
- 层级**不靠新增字号区分，靠 3 档灰阶 + 字重**：`--fg` → `--fg-muted` → `--fg-subtle`，标题 600/700、正文 400/500。
- 低于 12px 的 65 处（32%）集中在徽标/计数/头像叠字，属于**项目既定惯例**，不是漏改；但 11 与 11.5 两个值语义上完全重叠（同一个"次级元信息"用途两者混用，如 `--fg-subtle` 的时间戳有 11px 也有 11.5px），是**待统一**项。

### 1.4 字重：6 个值，其中 2 个非标准

| 值 | 次数 | 用途 |
|---|---|---|
| 600 | 39 | 主要强调（标题、按钮、选中项） |
| 700 | 15 | 强强调（列表行名、弹窗标题、分组头） |
| 400 | 10 | 正文/次级说明（多用于覆盖父级 700） |
| 500 | 6 | 弱强调（徽标、工具条标签） |
| **750** | 4 | 大标题 css:3072/3240/3621/4250 |
| **650** | 2 | 卡片名 css:3282、任务行标题 css:5082 |

750/650 是可变字体下的中间字重，与 700/600 的视觉差异很小 —— 属"作者偏好"而非系统，新增界面**不建议再引入新值**。

### 1.5 间距：无严格网格，但**强烈偏 2px 偶数**（86% 命中）

合并 `--space-*` token 还原成 px 后统计（gap/padding/margin 共 558 个值）：

| 值 | 占比 | 来源 |
|---|---|---|
| 8px | 20% | `--space-2`（最高频） |
| 12px | 13% | `--space-3` |
| 6px | 12% | **裸值**（未 token 化，最高频裸值） |
| 4px | 10% | `--space-1` |
| 2px | 8% | 裸值（行内微调、gap 收紧） |
| 10px | 7% | 裸值（按钮左右内边距） |
| 16px | 6% | `--space-4` |
| 其余（5/20/3/1/7/9/14px…） | 24% | 零散裸值 |

- **4px 倍数命中率 55%，2px 倍数 86%** —— 有隐形偶数纪律，但**不是 4/8 网格**。
- Token 化程度：`gap` 32%、`padding` 26%、`margin-top` 50% —— **约 2/3 的间距是裸写 px**。
- 刻度表（`tokens.css:15-20`）：4 / 8 / 12 / 16 / 20 / 24；**实际最常用的 6px 与 10px 不在刻度里**。
- 高频组件级固定值：列表行内边距 `8px 12px`（css:869/1012/5048）、按钮左右 `10~14px`、菜单项 `7px 9px`（css:408/463）。

**判据**：新代码优先用 `var(--space-*)`；`6px`、`10px`、`2px` 在项目里已被当作事实刻度使用，评审时**不必判为错误**，但引入第 4 个裸值（如 7px/9px/11px）应视为随意。

### 1.6 圆角：4 档 token 为主，16 处裸值；有同心圆角痕迹（一处标准）

| Token | 值 | 次数 | 用途 |
|---|---|---|---|
| `--radius-sm` | 6px | 22 | 小按钮、内部小块、kbd、下拉项内层 |
| `--radius` | 8px | 44 | **默认**：列表行、按钮、输入框、卡片内层 |
| `--radius-lg` | 12px | 19 | 浮层、弹窗、输入框外盒、卡片 |
| `--radius-full` | 999px | 34 | 胶囊、徽标、开关、红点 |

裸值（共 16 处，多数可归入 token）：`9px`（css:5376/5871/5884 机器人 logo、成员行）、`14px`（css:5850 成员下拉）、`12px`（css:6169 handoff 框）、`10px`（css:4003/4061 附件图、文件卡）、`8px`（css:4499）、`7px`（css:4337）、`4px`（css:4148/6026 看大图/角标）、`50%`×3、`999px`×2、`1px`（css:1931 刻度横线）。

**同心圆角**：有且只有一处严格按 `外 = 内 + padding` 做 —— `.cf-seg`：外层 `--radius`=8px、`padding: 2px`，内层 `.cf-seg__opt` 用 `--radius-sm`=6px（css:3449-3461），8−2=6 完全吻合 ✓。其余嵌套容器（`.cf-rows`/`.cf-setrow`、`.cf-box`/内部 textarea、`.cf-modal`/`.cf-pane`）**未做同心处理**（内层多半干脆无圆角，靠 `overflow:hidden` 裁）。

### 1.7 边框与阴影：**1px 微边框（不是 0.5px）+ 面板纯平 + 阴影只给浮层**

- **边框宽度：1px ×70 处，占 100%。全项目 `border: * 0.5px` 出现次数 = 0。** 另有 2px（拖拽指示线 css:769/772/1029/1032）、3px（引用左竖线 css:2030）、1.5px（复选框 css:1758）。
- **面板纯平**：`.cf-set`（css:3418）、`.cf-rows`（3480）、`.bots-card`（5455）、`.cf-qcard`（3264）、`.cf-rows`、`.cf-profile__ava` 等卡片全部只有 `1px solid var(--border)`，**无阴影**。
- **`--shadow`（`0 6px 24px rgba(0,0,0,.12)` / 暗色 `0 8px 30px rgba(0,0,0,.5)`）共 12 处，全是离屏/悬浮物**：

| 场景 | 位置 |
|---|---|
| 悬停浮出的会话列表 | css:209 |
| 添加/新建对话菜单 | css:327 |
| 右键菜单 | css:455 |
| 轮次索引展开面板 | css:1960 |
| "回到底部"浮标 | css:2399 |
| `/` 指令联想 | css:2433 |
| 胶囊（待办/后台任务） | css:2603 |
| 待办面板 | css:2764 |
| 弹窗 | css:3320 |
| 记忆标签气泡 | css:4655 |
| **输入框外盒** | css:2814 ← 唯一一个"在流内却带阴影"的元素 |
| **分段选择器选中项** | css:3472 ← 唯一一个"小控件带阴影"的元素 |

- 焦点环：`box-shadow: 0 0 0 3px var(--accent-tint)`（输入框 css:4473、任务盒 css:2921）；键盘焦点用 `outline: 2px solid var(--accent)` + `offset: 1px/4px`（12 处 `:focus-visible`）。
- 环形分隔：`box-shadow: 0 0 0 2px var(--bg-panel)` 用于红点/角标垫底（css:279/1102），与头像形状无关的圆形外圈**不使用** border。

### 1.8 动效（附带，评审常问）

`transition` 时长几乎只有两个值：**0.12s（11 处）** 与 **0.15s（11 处）**，另有 0.16s（列宽）、0.2s/0.3s（折叠、进度环）。浮层进场 `animation: 0.14s ease`（7 处）。**9 处 `prefers-reduced-motion` 全部显式降级**（css:40/232/310/435/525/699/1294/2183/4212）。

---

## 二、布局骨架

### 2.1 主壳 `ChatFirstShell`（`ChatFirstShell.tsx:617-792`）

```
.cf-shell            position:fixed; inset:0; display:grid; rows:1fr; font-size:13px        css:7-20
└ .cf-body           display:grid; columns:
                       [图标栏] [列表列] [主区]
                       var(--cf-rail-w,56px)  var(--cf-side,300px)  minmax(0,1fr)          css:27-36
   ├ ResizeHandle    position:absolute; left: calc(railW + sidebarW)                         resizable.tsx:87
   ├ IconRail        <nav.cf-iconrail>                                                        Rail.tsx:106
   ├ BotsPane | TasksPane   （占满列表列 + 主区，不出 Rail）
   └ Rail + 主区三选一：ProfileView | QuickStart | LiveConversation
```

- **没有独立标题栏**（微信式）：min/max/close 用系统原生 `titleBarOverlay` 叠加，不自绘按钮（`ChatFirstShell.tsx:621-622`）。
- 窗口拖拽区（`-webkit-app-region: drag`，4 处）：图标栏 css:125、列表列顶行 css:539、对话头 css:1123、`.cf-dragbar` css:1170。所有交互控件**逐个** "no-drag" 排除（19 处 `no-drag`）。
- 会话列表收起：列宽归 0 但元素保留（`visibility:hidden`，css:200-203），悬停图标浮出（`.is-peek`，css:205-211，带 `--shadow`）。
- 收起/展开列宽过渡 `0.16s ease`，拖动时挂 `body.cf-resizing-x` 全局关过渡（css:37-39）。
- **`.cf-body` 的 z-index/堆叠**：`is-peeking` 时列表 `z-index:45`，低于弹窗（60）。

### 2.2 宽度约束定义处（全部是 JS 常量 + CSS 变量，**没有媒体查询**）

| 约束 | 值 | 定义处 |
|---|---|---|
| 图标栏 | 56px（macOS 红绿灯可见时 72px） | `resizable.tsx:30-31` → `--cf-rail-w` |
| 列表列默认 / 下限 / 上限 | 300 / 220 / 480 | `resizable.tsx:24-26` |
| 列表列自动收起阈值 | < 140（拖动越过） | `resizable.tsx:28` |
| 主区最小宽 | 480（窗口窄时反压列表列上限） | `resizable.tsx:33` |
| 主内容列（对话/快速开启/空态） | `--cf-main: 780px`，`margin:0 auto` | css:19；用在 css:1977/2419/3229 |
| 角色资料卡 | 560px（**故意比 `--cf-main` 窄**） | css:3045 |
| 弹窗 | 720px（编辑器窄版 560px，扫码 520px，选机器人 460px） | css:3313/4403/5514/5722 |
| 输入框高度 | 44 / 80 / 400，另限窗口高 45% | `resizable.tsx:35-39` |
| 浮动面板限高 | 一律 `min(Npx, N vh)` | css:334/1414/1522/1643/2760/5846/640 |

**断点：零**。`redesign.css` 里除 `prefers-reduced-motion` 外**没有任何 `@media`**（`app.css` 也没有）。所有自适应都靠 `clampSidebar()` / `clampComposer()` 在 JS 里按 `window.innerWidth/Height` 夹取 —— 桌面窗口语义，不是响应式断点语义。新界面**不要**引入媒体查询做布局分支。

### 2.3 中列内部结构（`.cf-conv`）

`.cf-conv` flex column，内部：`.cf-conv__head`（40px 拖拽头 + 右侧 140px 让位系统窗口控件，css:1121；mac 下让位归零 css:1126）→ `.cf-convmid`（仅定位容器，css:1821）→ `.cf-msgs`（唯一滚动体，`scrollbar-gutter:stable`，css:1852-1865）→ `.cf-composer`（css:2380）。

---

## 三、组件习惯

### 3.1 命名约定

| 项 | 现状 |
|---|---|
| 前缀 | **`cf-`**（conversation-first）：903 个选择器命中。CSS 文件头明写"类名统一 `cf-` 前缀，与 app.css 完全隔离"（css:4） |
| **例外** | 机器人 pane 全用 **`bots-`** 前缀（64 处，css:5353-5786），是唯一逃出约定的模块 |
| BEM | `block` + `block__element`，两级，**不嵌三层**（如 `.cf-thread__owner--ws` 是唯一三层组合） |
| 修饰符 `--` | 少量，12 个：`.cf-box--task`、`.cf-resizer--x/--y/--box`、`.cf-search--filter`、`.cf-wschip--mounted`、`.cf-tdetail__act--danger` 等 |
| **状态修饰符 `is-*`** | **主流写法，59 个不同值**：`.is-active`(20) `.is-on`(17) `.is-open`(13) `.is-closed`(8) `.is-error`(7) `.is-dim` `.is-hint` `.is-dragging` `.is-selected` `.is-peek` `.is-collapsed` |
| 动态状态 | 模板串直接拼：`` `cf-trow__icon is-${task.status}` ``（TasksPane.tsx:449）、`` `is-${badge}` ``（RewindModal.tsx:370） |
| 根元素标记 | `.is-mac`、`.has-traffic-lights` 挂在 `.cf-shell` 上（ChatFirstShell.tsx:619） |

**约定本身**：`is-*` 是状态（可增删，可组合），`--*` 是变体（结构不同，通常单选）。评审新代码时：**静态差异用 `--`，运行时状态用 `is-`**，混用视为不合习惯。

**根级自定义属性也算约定**：组件通过就地覆盖变量做主题适配，如 `.cf-thread` 覆盖 `--row-bg`（css:884-897）、`.cf-mprogress__pill` 覆盖 `--ring`（css:2145）、`.cf-setrow` 覆盖 `--ring`（css:5702）。这是项目里唯一的"局部换肤"手法。

### 3.2 可复用组件清单（`shell-common.tsx`）

| 导出 | 行 | 场景 |
|---|---|---|
| `basename` / `samePath` / `clipName` | 17/22/34 | 路径末段、跨平台路径比较、纯文本标题限长（避免 CSS 省略吃掉句尾问号） |
| `DragBar` | 43 | 无对话头界面（快速开启/资料卡/空态）的 40px 透明拖拽把手 |
| `IS_MAC` / `DEFAULT_PERSONA_ID` | 47/50 | 平台判断、默认角色 `general` |
| `useRelativeTime` / `useShortTime` | 53/111 | 相对时间（"3 分钟前"）、时刻短写（今天只写时分） |
| `fill` | 69 | 文案占位替换 `{name}` |
| `Fold` | 78 | 高度过渡折叠（grid `1fr→0fr` + 淡出，收起后 `visibility:hidden`） |
| `useHoverMenu` | 132 | 悬停/点击开合浮层，140ms 收起容错。**新建对话菜单、添加菜单共用** |
| `AvatarStack` | 175 | 头像叠放 + `+N`（`--sz` 控尺寸，默认 20，最多 3） |
| `Segmented` | 217 | 分段选择器（设置页文字大小/主题等） |
| `Toggle` | 241 | 开关（38×22，`is-on`）。用在：按工作区分组、关闭到托盘、扩展启用 |
| `Avatar` | 267 | **全应用唯一头像**（走 Humation）：角色/用户、`size`、`busy`（生成中转星芒）、`attention`/`unread`（右上红点）、`compact`（≤20px 自动） |
| `useStableCallback` | 330 | 恒定引用回调，传给 `memo` 组件（Conversation → Composer） |

另有跨文件复用的块：`AddMenu` / `GroupFace`（`Rail.tsx:1206/1267`，TasksPane 复用）、`ContextMenu`（`ContextMenu.tsx`）、`ResizeHandle`（`resizable.tsx:87`）。

### 3.3 通用样式件（只在 CSS 层，无 React 封装）

`.cf-btn`（34px 高，`is-primary`，css:4960）、`.cf-input` / `.cf-textarea`（34px 高，css:4442）、`.cf-modal`（css:3311）、`.cf-badge`（css:3555）、`.cf-ctx`（右键菜单，css:447）、`.cf-empty`（css:3198）、`.cf-field` / `.cf-field__label`（css:4418）。下拉浮层不自绘，复用 `app.css` 的 `.select-menu`（css:634 明确"外观沿用统一下拉框"）。

---

## 四、列表行结构（以 `ThreadRow` 为例）

源码：`Rail.tsx:1338-1418`；样式：`css:860-999` + `css:4991-5002`。

```
<button class="cf-thread [is-active]">          grid: 38px | 1fr, gap 12px
  │                                             padding 8px 12px; radius 8px        css:860-872
  ├ <span class="cf-thread__face">  38×38        Avatar size=38 或 GroupFace        css:899-903
  │     └ Avatar / GroupFace                    busy→星芒, attention/unread→右上红点 (css:1081)
  └ <div class="cf-thread__main">
        ├ <div class="cf-thread__top">          flex, align baseline, gap 8px       css:943-947
        │    ├ <span class="cf-thread__title">  13px / 600 / --fg, 单行省略           css:949-957
        │    └ <span class="cf-thread__time">   11px / 400 / --fg-subtle, margin-left:auto  css:958-963
        └ <div class="cf-thread__sub">          margin-top 2px, flex, gap 6px       css:965-970
             ├ <div class="cf-thread__owner">   11px / --fg-subtle, flex:1, 省略     css:972-980
             │    ├ 有草稿：<span.cf-thread__draft> "[草稿]" --danger + 内容开头     css:982-985
             │    ├ 有工作区：.cf-thread__owner--ws + <Folder size=11> + 文件夹名    css:987-999
             │    └ 否则：角色名
             └ <span class="cf-thread__badges"> gap 5px, --fg-subtle                css:4991-5002
                  ├ <AlarmClock size=13>  定时任务徽标
                  └ <Globe size=12>       内置浏览器页数
```

**尺寸与层级要点**

| 项 | 值 | 依据 |
|---|---|---|
| 行布局 | `grid-template-columns: 38px minmax(0,1fr)`，`gap: 12px`（`--space-3`） | css:862-863 |
| 行内边距 / 圆角 | `8px 12px` / `--radius`(8px) | css:869-870 |
| 头像列 | 38×38，**固定不缩放** | css:901-902 |
| 标题 | 13px/600/`--fg` —— 与列表外正文同字号，靠字重和主色阶提级 | css:951-953 |
| 时间 | 11px/`--fg-subtle`，`margin-left:auto` 靠右 | css:961-963 |
| 副行 | 11px/`--fg-subtle`，比标题小 2px 且降一档灰 | css:975-976 |
| 行高 | 8+38+8 ≈ 54px（两行文字按 13/11 排） | css:869 + 901 |

**hover / active**

| 态 | 表现 | 依据 |
|---|---|---|
| `:hover` | `background: var(--bg-hover)`（半透明叠色） | css:873-875 |
| `.is-active` | `background: var(--bg-selected)`（accent 12%/20%） | css:876-878 |
| 两者都额外改 `--row-bg` | `color-mix(--bg-panel, #000 4.5%)` / `color-mix(--bg-panel, accent 12%)` | css:884-897 |

`--row-bg` 是为**群组头像的重叠分隔环**（`.cf-group__more` 的 `--hm-ring`，css:919-923）准备的："等效不透明底色"，因为 `--bg-hover` 是半透明叠色，SVG 环形需要实色。**新增带叠色的行若要放重叠头像，必须照抄这套 `--row-bg`。**

**同类行的一致性**：`.cf-prow`（角色行，css:1002-1053）、`.cf-trow`（任务行，css:5038-5057）与 `.cf-thread` **结构完全同构**（grid 首列固定宽 + 1fr、gap 12、padding 8/12、radius 8、同样的 hover/active 变量）。差异只有首列宽：对话/角色 38px，任务 30px。

---

## 五、与 `desktop-agent-ui` 规范的差异

对照 `E:\Ludi-Herry\desktop-agent-ui\SKILL.md` 与 `references\acceptance.md`。**以项目现状为准**，冲突项标注。

| # | 通用规范要求 | 项目现状 | 判定 |
|---|---|---|---|
| 1 | **0.5px 极细边框** | 全项目 **1px**，0.5px 边框出现 0 次（边框 70 处全 1px） | ❌ **项目有一套：1px 微边框**。加分屏下已足够轻；评审不要因"不是 0.5px"判错 |
| 2 | **字号 ≤4 档（推荐 3 档）** | **24 个不同值**；≥12px 有 9 档（11/11.5/12/12.5/13/13.5/14/15/17/20） | ❌ 明显不符。项目用"3 档灰阶 + 6 档字重"补层级，字号本身是失控的。**评审建议：新界面只用 13 / 12 / 11 三档**（正文/辅助/徽标），大标题才用 20 |
| 3 | **最小字号 12px 硬门禁** | 32% 的声明 < 12px（11px 30 处、11.5px 27 处、10.5px 3 处、10px 2 处、9.5/9/8px 各 1） | ⚠️ **项目明知的例外**：仅用于徽标、计数、头像叠字、时间戳。评审时**不要判为缺陷**，但新增正文/说明文字用 <12px 应指出 |
| 4 | **禁用中点 `·` 分隔符** | 用户可见文案仍在用：`Rail.tsx:848/944`（工作区上级目录提示）、`Rail.tsx:1166`（角色悬停 title）、`attachments.tsx:123/472`（"PNG · 386 KB"）、`ConvMessage.tsx:423`、`messages.ts` 12 处（如 `Claude 系列 · 国内通常需代理`） | ❌ **未遵守**。属于"应该修"的存量项，不是设计习惯 |
| 5 | **单强调色** | ✓ 只有一个 `--accent`（紫）。语义色 danger/warning/success 只表状态 | ✅ 符合 |
| 6 | **页面默认平（Zero Shadow on Panels）** | ✓ 卡片/设置行/任务卡全为 1px 边框无阴影；`--shadow` 12 处全在浮层 | ✅ 符合，唯二例外见 §1.7（输入框外盒、分段选中项） |
| 7 | **同心圆角 `R内 = max(0, R外 − padding)`** | 仅 `.cf-seg` 一处严格做到（外 8px − padding 2px = 内 6px） | ⚠️ 项目**大量嵌套容器不做同心**（内层干脆无圆角 + `overflow:hidden`）。评审不要把"没做同心"当硬伤，但浮层内嵌卡片时建议 |
| 8 | **动效降级 / 减弱动效** | ✓ 9 处 `prefers-reduced-motion` 全覆盖 | ✅ 符合，且是有意识的逐条处理 |
| 9 | **暗色模式字重下调一档** | **未实现**（`redesign.css` 里 4 处 `data-theme='dark'` 只改颜色，无 `font-weight` 覆盖） | ❌ 未落地，属"可修"项 |
| 10 | **`tabular-nums` 锁动态数值** | ✓ 19 处：计数、时间戳、任务统计、胶囊数字 | ✅ 符合 |
| 11 | **`text-wrap: balance` 防孤字** | **全文 0 处** | ❌ 未落地 |
| 12 | **严禁左彩条卡片** | `.cf-navbtn.is-active::before` 有一条 3px 强调色竖条（css:175-185）——但这是**导航图标选中指示器**，不是卡片彩条 | ✅ 可接受（不属于该反模式的适用对象） |
| 13 | **文案冗余/去 eyebrow** | 项目大量使用小标题分组（`.cf-ctx__section`、`.cf-profile__convs-label` 11px/uppercase/`letter-spacing`），但都已带真实语义（"角色"/"文件夹"/"运行历史"），非无意义悬顶标签 | ✅ 可接受 |
| 14 | **真实状态 / 无伪造进度** | ✓ 全部来自 store 事件（`sessionStates`、`TaskRecord.runs[].status`），无前端计时器造假 | ✅ 符合 |
| 15 | **组件库优先 / 已有系统不折腾** | ✓ 零 UI 框架依赖，纯手写 CSS；无第二套重复库 | ✅ 符合（项目就是"自有 Tokens"形态） |

**一句话**：项目的**视觉气质（单一强调色、面板纯平、浮层才带阴影、1px 微边框、13px 正文）与规范高度一致**；不一致的是**排版纪律（字号档位失控、<12px 泛滥、中点分隔符、暗色字重补偿缺失）**。

---

## 五之二、新代码字号口径（**强制**）

存量有 24 档字号（§1.3），那是历史债。**新代码不许再加，只许用这四档。**

判据不是「数值接近」，而是**用户读不读它**：

| 档位 | 用途 | 上游证据 |
|---|---|---|
| **12px** | **用户要读的内容**：说明、失败原因、提示、次级正文、可点操作 | `.cf-set__hint`（设置说明）、`.cf-field__hint`（字段提示）、`.cf-setrow__note`（行说明） |
| **11px** | **扫一眼的元信息**：计数、徽标、路径、时间戳、标签 | `.cf-addmenu__count`、`.cf-fcard__meta`、`.cf-cap__kind`、`.cf-profile__convs-label` |
| 13px | 正文基准 | `.cf-shell` 根字号 |
| 20px | 页面级大标题 | 角色卡名、快速开启标题 |

**禁止出现 11.5px 与 12.5px。**

- `11.5px` 在上游 27 处、`12px` 72 处，两者**语义完全重叠**（§六-1 已登记为「应修」）。新代码再引入 11.5 就是继续制造这个债。
- `12.5px` 全项目仅 1 处（`.cf-fcard__name`），是孤例，不是体系。
- 11 与 12 各有明确分工（元信息 vs 要读的内容），**已经够用**。

**徽标用 11px，不是 10.5px。** 上游 `.cf-badge` 的 10.5px 是存量例外（全项目 4 处 <12px），不是体系；本节把「徽标/微标签」的正式档位定为 11px。新代码不新增 <12px 的档位。

**存量暂不还，但新代码不许加。** 上游那 38 处 11.5/12.5/13.5、16 处裸圆角**这次不动**——一次全改会让 `git diff upstream` 变得巨大，以后同步上游会痛。要求只有一条：**新代码干净**。

机器判定：`node .deva/qa/ui-guard.cjs`（基线取自 `upstream/main`，二开新增违规必须为 0）。

## 六、现存的不一致（待统一）

按严重程度排序。**"现状"= 已稳定使用，评审时按此判；"应修"= 项目自己没统一，建议后续收敛。**

### 高：同一语义两套实现，会让新界面无从选择

| # | 问题 | 证据 | 定性 |
|---|---|---|---|
| 1 | **次级元信息用了 11 / 11.5 / 12 三个字号**，语义无差别 | 11px：时间戳 css:961、角色名 css:975、分组头 css:791、状态签 css:5157；11.5px：专长 css:1048、计数 css:356/683、路径 css:3737；12px：占位符 css:570、说明 css:3409 | **应修** → 收敛为 11px |
| 2 | **`--success` 的自定义兜底值 `#2e7d32` 与 token 定义 `#2f9e44` 是两个绿** | css:5075/5129/5130/5171/5172/5206 写 `var(--success, #2e7d32)`；而 `tokens.css:64` 定义 `--success:#2f9e44`（暗色 `#51cf66`） | **应修** → 去掉兜底。暗色任务角标另有 `#2b8a3e`（css:6036）是第三个绿 |
| 3 | **按钮高度 5 套**：30 / 32 / 34 / 36 / 40px | 30px css:1200(wschip)/2934(iconbtn)/5499(bots-btn)；32px css:241(addbtn)/544(search)/1794(selbar__btn)/2979(send)；34px css:4454(input)/4961(cf-btn)；36px css:5270(tdetail__act)；40px css:154(navbtn) | **现状+应修**：`--control-h:34px` 已存在于 `tokens.css:33`（并在 `app.css` 用了 3 次），但 redesign.css **一次都没引用**。建议新代码统一 34px（表单类）或 32px（工具条类） |
| 4 | **圆角裸值 16 处**：9px / 10px / 12px / 14px / 8px / 7px / 4px / 50% / 999px | css:5376/5871/5884(9px)、4003/4061(10px)、6169(12px)、5850(14px)、4499(8px)、4337(7px)、4148/6026(4px)、276/2498/5398(50%)、1332/5389(999px) | **应修**：浮层圆角同时存在 `--radius-lg`(12) 与 14px；`999px` 与 `--radius-full` 并存 |
| 5 | **字号 24 档 / 字重 6 档**（见 §1.3/1.4） | — | **应修**：优先砍 11.5 / 12.5 / 13.5 三个中间档与 650/750 两个字重 |

### 中：约定被局部破坏

| # | 问题 | 证据 | 定性 |
|---|---|---|---|
| 6 | **`bots-` 前缀游离于 `cf-` 体系之外** | 64 个 `bots-*` 选择器（css:5353-5786），同文件其他模块全 `cf-` | **现状**：BotsPane 后加，未对齐。新模块请用 `cf-` |
| 7 | **定义了但从不生效的变量引用** | `--radius-2`（css:4495，全项目未定义 → 该 `border-radius` 声明无效，靠下一行 css:4499 `border-radius:8px` 兜住）；`--text-muted`（css:4525 未定义，无 fallback → 该处文字用继承色而非 subtle）；`--font-sm`（css:4526 未定义，有 `13px` fallback） | **应修**：`--text-muted` 会导致该处文字用继承色，非 subtle |
| 8 | **`is-paused` 无样式** | `TaskStatus = 'active'\|'paused'\|'completed'\|'error'`（`preload/index.ts:374`），行图标按 `is-${status}` 拼接（TasksPane.tsx:449），但 CSS 只有 `is-active` / `is-error` / `is-completed`（css:5068/5071/5074） | **应修**：paused 行图标回落为默认灰，与"暂停"语义无视觉区分 |
| 9 | **tsx 里用了、CSS 里没有的类**（悬空，无样式） | `cf-field--avatar`（ProfileView.tsx:373）、`cf-wsgroup__items`（Rail.tsx:950）、`cf-ins` / `cf-ins__label`（Composer.tsx:184/186）、`cf-bpages`（browser/shared.tsx:39）、`is-pending` / `is-pinned` / `is-selectable` / `is-selecting` | **现状**：多数是靠父选择器继承或纯结构钩子，无副作用，但增加噪声 |

### 低：`redesign.css` 死代码（**定义了、全项目无任何引用，未删除**）

以下经全仓 `*.tsx` / `*.ts` / 其他 `*.css` 交叉核对确认零引用：

| 死代码块 | 行范围 | 行数 |
|---|---|---|
| `.cf-tools` / `.cf-tool` / `.cf-tool__row` / `__label` / `__chev` / `__detail` —— 整套"内联工具调用条" | css:2326-2374 | 49 |
| `.cf-hint` + `.cf-hint kbd` | css:3018-3031 | 14 |
| `.cf-profile__spec` | css:3076-3081 | 6 |
| `.cf-profile__convs`（`__convs-label` 仍在用，父块无用） | css:3132-3135 | 4 |
| `.cf-setrow__sub` | css:3542-3546 | 5 |
| `.cf-field--row` + `.cf-field--row > .cf-field` | css:4424-4430 | 7 |
| `.cf-field__hint` | css:4436-4439 | 4 |
| `.cf-me__hint` | css:4593-4597 | 5 |
| `.cf-addmenu__pop--fit` | css:388-392 | 5 |
| `.cf-tdetail__act--primary` + `:hover` | css:5286-5292 | 7 |
| `.cf-badge.is-accent` + 变体 | css:3564-3568 | 5 |
| **合计** | | **约 111 行** |

> 另注意：`.cf-att--sent .cf-att__thumb`（css:4000）**不是死码** —— 类名由 `` `cf-att--${variant}` `` 运行时拼出（attachments.tsx:241，`variant:'sent'`）。

---

## 附：给评审的最短checklist

新界面提交时，按项目习惯应满足：

1. [ ] 类名 `cf-` 前缀 + `block__element`；静态变体用 `--`，运行时状态用 `is-*`
2. [ ] 颜色只用 `tokens.css` 的语义变量；除"白字压深色底 / 图片遮罩"外无裸色值
3. [ ] 字号只用 13 / 12 / 11（正文/辅助/徽标），大标题才用 20；不为新组件引入新字号；**禁止 11.5px / 12.5px**（详见 §五之二）
4. [ ] 间距只用 `var(--space-1..6)` 或 6px / 10px / 2px（项目事实刻度）
5. [ ] 圆角用 `--radius-sm` / `--radius` / `--radius-lg` / `--radius-full`，不写裸 px
6. [ ] 卡片/面板 1px `var(--border)` 边框 + **无阴影**；阴影只给浮层，且用 `var(--shadow)`
7. [ ] 列表行结构对齐 ThreadRow：grid 首列固定宽 + 1fr、gap 12、padding 8/12、radius 8、hover `--bg-hover`、active `--bg-selected`
8. [ ] 动态数字加 `font-variant-numeric: tabular-nums`
9. [ ] 动效用 0.12s / 0.15s，浮层进场 0.14s；带 `prefers-reduced-motion` 降级
10. [ ] 不用媒体查询做布局（窗口自适应走 `resizable.tsx` 的 clamp 函数）
11. [ ] 拖拽区（`-webkit-app-region: drag`）内的可点控件必须显式 `no-drag`
12. [ ] 文案不用中点 `·` 做分隔（这是存量债，新代码别再制造）
