# renderer/src/redesign/AGENTS.md

二开新增的外壳层：对话优先布局、各设置面板、成员与工作区面板。上游 `features/` 与
`components/` 保持原样，新功能一律落在本目录。父级约定见仓库根 `AGENTS.md`。

**依赖方向单向**：本目录 import `features/`（19 处），`features/` 从不反向 import 本目录。
不要制造回指，否则功能层会被外壳绑死。

## 必须复用的类名

| 用途 | 类名 | 定义处 |
| --- | --- | --- |
| 按钮 | `.btn` + `btn--` 变体 | `styles/app.css` |
| 设置项 / 表单行 | `.cf-set` / `.cf-set__row` | `redesign.css` |
| 输入框 / 文本域 | `.cf-input` / `.cf-textarea` | `redesign.css` |
| 徽标 | `.cf-badge` / `.cf-badge.is-accent` | `redesign.css` |
| 行内风险提示 | `.cf-setrow__note--warn` | `redesign.css` |

`.cf-btn` 是二开自造（7 个文件 16 处），**新代码不要用**。`.cf-backup__card` 这类竖排卡片
已移除，不要加回来——设置区一律用 `.cf-set` 的行结构。

## 这个目录特有的坑

**手写内联样式的输入框会露出橙色浏览器默认框。** `.cf-input` 自带 `outline: none` 与主题色
focus 光圈（`box-shadow`）；自己拼一个 `<input>` 加内联样式就丢了这两条，聚焦时出现浏览器默认外框。
要么用 `.cf-input`，要么把 `outline: none` 和 focus 光圈一起写上。

**图标对齐用 flex，`vertical-align: middle` 不够。** 在 block 容器里图标独占行盒，
只加 `vertical-align` 对不齐；容器要 `display: inline-flex; align-items: center`。

**徽标与风险提示是两种东西，别混用。** `.cf-badge` 是 10.5px 带全圆边框的角标；
需要一行橙色提示文字时用 `.cf-setrow__note--warn`（11px 橙字）。用 badge 装警告文案
会既挤又不像警告——`BackupPane.tsx` 里对此有注释说明。

**文案不用中点 `·` 做分隔**（`.deva/design-system.md` 第 12 条，属存量债，新代码别再制造）。
