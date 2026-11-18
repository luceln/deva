# 模型失效标红 —— 运行时行为验证（需浏览器，手动跑）

覆盖「模型失效标红 + 批量替换」迁进上游 `ModelPanel.tsx` 之后的行为：贴片长什么样、点了会发生什么、
以及**上游新功能有没有被这次迁移碰坏**（这是迁移最容易出的事）。

## 背景

合并上游 0.1.16 时，上游 `9daa64f`（「输入框新增模型面板」）把模型选择器整个重写成
`ModelPanel.tsx` + `ModelMenu.tsx` + `context-usage.ts`。我们原来的 `ModelPicker`（246 行）
里带着失效标红与批量替换，按「一次提交只做一件事」在合并时先摘掉，再由独立提交迁回。
原文备份在 `.deva/qa/removed-ModelPicker.tsx.bak`，清单在 `.deva/pending-model-swap-ui.md`。

## 怎么跑

```bash
node .deva/qa/model-panel/build.cjs
# 用内置浏览器打开 .deva/qa/model-panel/page.html（换 ?v=时间戳 强刷，file:// 会拿缓存）
# 页面标题变 DONE n/18 即结束；window.__logs 里是逐条 PASS/FAIL
```

`build.cjs` 用 esbuild 把**真实的 `ModelPanel.tsx`**（含 `ModelMenu` / `ModelSwapDialog` /
`clampEffort` / `context-usage`）打进浏览器 bundle，只把两个重依赖换成桩：

| 桩 | 原因 |
|---|---|
| `store/chat` | 真实 `ChatProvider` 挂载时会打一串 IPC，且无法从外部构造 `brokenModels` / 成员会话 |
| `store/models` | 真实 `ModelsProvider` 从 mock/models 起种子，构造不出「缺密钥 / 不支持思考」这些边界 |

`i18n` / `Toast` / `Dialog` / `Modal` / `Select` / `shared/effort` 全用真实实现。
`window.deva.chat.contextUsage` 返回可控读数，用来验上游的圆环与进度条。

## 18 条用例

**迁移过来的判断（12 条）**

| 用例 | 证明了什么 |
|---|---|
| 正常态显示模型名、无 is-broken、无徽标 | 不误标 |
| 正常态点贴片 → 打开面板 | 上游交互没被改坏 |
| 四种 kind 各一次（model-disabled / disabled / missing / malformed） | 都是危险色 |
| nokey / keyunreadable | 警示色（`is-nokey`） |
| 一处 nokey + 一处 model-disabled | 只要有一处真坏就危险色 |
| 只有别的会话坏、本会话没坏 | 不误伤 |
| 成员会话 | 按主对话判断（主对话名单反查） |
| 失效态点贴片 | 直接开替换对话框，**不弹**模型面板 |

**上游新功能回归（6 条）**

| 用例 | 证明了什么 |
|---|---|
| 有读数时贴片是占用圆环而不是色点 | 圆环没被标红逻辑挤掉 |
| 面板里有百分比 / 进度条 / 自动压缩竖线 | 上下文占用区完整 |
| 思考等级选择后贴片显示灯泡 + 档位 | `clampEffort` 收敛仍工作 |
| 思考等级菜单能打开并列出档位 | 二级菜单没坏 |
| 模型二级菜单能切换模型 | `setSessionModel` + `setActiveModel` 仍接对 |
| 缺密钥服务商的模型不可选并写明原因 | `ModelMenu` 新增的不可用态 |

## 结果

- 迁移后：**18/18 PASS**
- **反向验证 ①**（浏览器层）：把 `broken` 判断改成恒 `false` → **9/18**，失败 9 条正好是
  依赖标红判断的那些（6 种 kind + 混合 + 成员会话 + 失效态点击）。恢复后 18/18。
- **反向验证 ②**（CI 判据层，`.deva/qa/check-model-swap.cjs`）：`broken` 恒 false → 2 FAIL；
  去掉 `trim` → 1 FAIL；`onlyNoKey` 恒 false → 3 FAIL。恢复后 21 PASS / 0 FAIL。

## 边界

`window.deva.chat` 是桩：证明「状态 → 渲染 → 交互」这条链路，**不证明**主进程的扫描判定正确
（那是 `model-availability.ts` 的事，另有场景覆盖）。

CI 里跑的是 `.deva/qa/check-model-swap.cjs`：它驱动**真实的** `brokenInfoOf` / `mainIdOf` 纯函数，
能证明判断逻辑对不对；**不能**证明红色贴片长什么样、点了会怎样、上游新功能还在不在。
两层不互相冒充。
