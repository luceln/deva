# 合并上游 0.1.16 时摘掉的界面功能：待恢复清单

> **已实现（2026-11-23 归档时核实）** —— 本清单要求的迁移已全部完成，留作决策记录。
> 落盘证据：
> - `renderer/src/redesign/ModelPanel.tsx:13-22` 文件头写明「失效标红 + 批量替换」已接入
> - `:113-120` 失效态贴片换成红色/警示色、点击直接开批量替换
> - `:48-49` `swapTarget = { mainId, fromRef }` 引用快照（打开时不随 broken 消失）
> - `:36,138` `ModelSwapDialog` 已挂载
> - 六类 kind 齐备：`model-availability.ts:154` `model-disabled`、`:169` `keyunreadable`、
>   `:135` `missing`(provider)、`:152` `missing`(model)；`messages.ts` 六条中英文案（含 `keyunreadable` 与 `nokey` 分开）
> - `Composer.tsx` 里 `ModelPicker` 已不存在（`grep -n ModelPicker` 无命中）
>
> **本文件因此是「已完成的决策记录」**，不是待办。**剩余未做的一项**：清单「验证要求」第 1 条
> （`.deva/qa/spec-gate.cjs` 模型切换断言仍绿）需在交付前实跑确认，本文件不记录其结论。

## 为什么有这个文件

合并 `upstream/main` @ `718908e`（0.1.16）时，上游 `9daa64f`（「输入框新增模型面板」）把模型选择器
**整个重写**了：

| | 合并前（我们的） | 合并后（上游） |
|---|---|---|
| 位置 | `redesign/Composer.tsx` 内的 `ModelPicker`（246 行） | `redesign/ModelPanel.tsx` + `ModelMenu.tsx` + `context-usage.ts` |
| 形态 | 胶囊 + 菜单 | 胶囊（上下文占用圆环）+ 面板 + 二级菜单 |
| 新增 | — | 上下文占用百分比、进度条、自动压缩竖线、思考等级合并进同一面板 |

我们那块 `ModelPicker` 里带着**模型失效标红**与**批量替换**，上游的新面板没有这些。

按「一次提交只做一件事」的原则，这次合并**只做合并、不夹带功能迁移**：先按上游版本合并（功能暂时缺席），
再用独立提交把失效标红迁到 `ModelPanel.tsx`。这样万一出问题，能分清是合并造成的还是迁移造成的。

## 已摘掉的东西

### 1. `ModelPicker`（`Composer.tsx`，246 行）

原文完整备份在 `.deva/qa/removed-ModelPicker.tsx.bak`。

它做的事（迁移时一条都不能少）：

- **只列对话模型**：`purpose === 'llm'` 的服务商 × `enabled` 的模型，按服务商分组
- **本对话生效模型的解析**：读 `currentBinding.model` 的 `"pid:mid"` 引用，空 / 非法 / 已删除 → 回落 `activeModel`
- **失效标红**（核心）：`brokenModels[mainId]` 里本会话的条目非空时，胶囊标红、文案换成「模型不可用」
- **警示色 vs 危险色**：失效原因全为 `nokey` / `keyunreadable` 时用警示色（填密钥就好），否则危险色
- **右侧挂受影响会话数**：点它直接开批量替换对话框，而不是弹普通模型菜单
- **切换语义**：① 写会话覆盖层并立即落库（`setSessionModel`）；② 记为「最近使用」（`setActiveModel`）

### 2. `ModelSwapDialog` 的挂载点

组件文件 `redesign/ModelSwapDialog.tsx` 与 store 侧 action 都还在，只是 `Composer.tsx` 里的
import 与渲染点没了（见该文件 import 区的注释）。

## 迁移时要对齐的东西

上游新面板已经把「模型」与「思考等级」合进同一套二级菜单，所以**不要**再把 `ModelPicker` 原样搬回来，
那会出现两套模型选择器。正确做法是只把「失效标红 + 批量替换」两件事**接进 `ModelPanel.tsx` 的
`PanelChip` 与 `ModelMenu`**：

| 要迁移的判断 | 大概落点 |
|---|---|
| 胶囊是否标红、用哪种颜色 | `ModelPanel.tsx` 的 `PanelChip`（`accent` 取值处） |
| 失效时点胶囊打开批量替换而非模型菜单 | `ModelPanel.tsx` 的 chip onClick |
| 右侧受影响会话数 | 同上，chip 内容 |
| 菜单项「不可用」态与禁用 | `ModelMenu.tsx` |

## 验证要求（恢复后必须做到）

1. `.deva/qa/spec-gate.cjs` 的模型切换相关断言仍绿
2. `brokenModels` 的四种 kind（`model-disabled` / `nokey` / `keyunreadable` / `ref-gone`）各构造一次，
   胶囊文案与颜色对得上
3. **反向验证**：把标红判断改成恒 false，断言必须变红
4. 上游新功能（上下文占用圆环、思考等级）在恢复后仍然工作——这是最容易在迁移中碰坏的部分

## 上游那几个新文件在哪

- `apps/desktop/src/renderer/src/redesign/ModelPanel.tsx` — 面板主体
- `apps/desktop/src/renderer/src/redesign/ModelMenu.tsx` — 模型二级菜单
- `apps/desktop/src/renderer/src/redesign/context-usage.ts` — 上下文占用的计算与订阅
- `apps/desktop/src/renderer/src/redesign/model-panel.css` — 样式
