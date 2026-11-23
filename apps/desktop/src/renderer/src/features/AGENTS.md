# renderer/src/features/AGENTS.md

按功能切分的渲染层模块，三个子目录：`chat/`（对话块、待办、后台任务、Markdown）、
`browser/`（浏览器胶囊与面板）、`settings/`（模型与供应商设置）。父级约定见仓库根 `AGENTS.md`。

**依赖方向单向**：`redesign/` import 本目录（19 处），本目录**从不** import `redesign/`。
这条必须守住——否则功能模块被外壳布局绑死，`redesign/` 一改就得跟着改。

## 这个目录特有的坑

**本目录已有 8 个文件直接 import `../../store/chat`（9 处）**：`browser/BrowserCapsule.tsx`、
`chat/` 下的 `BackgroundTasks` / `blocks` / `DeliverablesCard` / `ModelSetupCard` /
`TaskConfirmCard` / `TaskPickers` / `Todos`。这是既存事实，但**不要照着扩大**——
新组件优先接收 props。真需要读时用范围最小的 `useChatState` / `useChatStream` / `useChatActions`，
别把整个 store 接进来。

**样式放本子目录自己的 css。** `browser/` 有 `browser.css` 与 `capsule.css`；不要往
`redesign.css` 里加本目录专用样式——那是外壳的样式表。

**`settings/` 已有模型设置页，新设置项别另建一套。** 该子目录里 `ModelSettings.tsx` 是主表单、
`ProviderAdvanced.tsx` 是供应商高级项、`Switch.tsx` 是开关控件、`ModelDetail.tsx` 是详情页；
新增字段先看这几处是否已有承载位置。
