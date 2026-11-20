# 导入新状态展示 —— 运行时验证（需浏览器，手动跑）

验本批接进界面的三个后端新字段：`indexStale`（P2-⑦）、`superseded`（P2-⑥）、`pluginManaged`（magpie MCP）。
后端判定不是本用例的目标，这里只证明**用户能不能看见**这三件事。

## 为什么另建一套

`.deva/qa/import-report/` 验的是 `unrecoverable` / `rekeyed`，`.deva/qa/model-panel/` 验的是模型失效标红与
上游回归。本批是「已有报告里新增两栏」+「导入报告的第三类排除」，单独一套，既不动那两个已经跑通过的装置，
也让断言只盯这次的三项。

## 怎么跑

```bash
node .deva/qa/import-new-fields/build.cjs
# 用内置浏览器打开 .deva/qa/import-new-fields/page.html（file:// 会拿缓存，改完加 ?v=时间戳）
# 页面标题变 DONE n/11 即结束；window.__logs 里是逐条 PASS/FAIL
```

`build.cjs` 用 esbuild 把**真实的 `ImportPane` 与 `ModelSwapDialog`**（含 `Modal` / `Select` / i18n / CSS）
打进浏览器 bundle，只替换四个模块：

| 桩 | 原因 |
|---|---|
| `importBridge` | 报告要能从外面可控地喂进去，不经过 IPC |
| `store/chat` | 真实 `ChatProvider` 挂载就打一串 IPC，且 `applyModelSwap` 的返回值必须可控 |
| `store/models` | 要断言 superseded 显示的是**模型名**（`Claude Lite`）而不是引用原文，需要固定服务商 |
| `store/extensions` / `modelSettingsBus` | 导入成功后只调 refresh；本用例不验跳转 |

## 11 条用例

**pluginManaged（A，导入报告）**

| 用例 | 证明了什么 |
|---|---|
| 服务商行有「归插件管，未导入」标签，跳过数仍为 0 | 不把插件托管算成「已存在，跳过」 |
| 展开明细逐条列出 id + 「去插件里改」 | 用户知道说的是哪些、该去哪改 |
| 只有插件托管项的行仍然显示 | 0 新增 0 跳过不被行过滤吞掉（否则等于界面上一字不提） |
| 密钥行的插件托管不落进「需要重新填写」警告 | 不给一条走不通的指引（插件密钥在设置页没有输入框） |
| 英文环境用插件口径 | 中英都到位，不是中文硬编码 |

**indexStale（B，替换结果）**

| 用例 | 证明了什么 |
|---|---|
| 标题与说明说「已保存、索引待重建」，并写明数据没丢、刷新一次即可 | 不写成失败 |
| 与真实写盘失败并存时两者都出现，计数不互相吞掉 | `indexStale` 不进 `failed`，`failed` 也不被掩盖 |

**superseded（C，替换结果）**

| 用例 | 证明了什么 |
|---|---|
| 标题有未改动数；每行写「未改动」+ **当前真实模型名** | 不再静默；显示的是 `Claude Lite` 而不是 `anthropic:claude-lite` |
| 说明讲清「没有覆盖」+「下面是现在实际使用的」 | 用户知道是自己的选择被保留了 |
| 字段缺省时不多出区块 | 旧持久化结果 / 旧调用方不受影响 |

**英文与字段名（D）**：英文环境下三项都说英文，且界面上不出现 `indexStale` / `superseded` / `pluginManaged`
这类字段名。

## 结果

- 修复后：**11/11 PASS**，`window.__errors` 为空。
- 反向验证：把三处渲染分别短路（插件标签、indexStale 区块、superseded 区块）→ **1/11**，
  失败的 10 条正好是依赖这三处展示的用例；唯一仍通过的是 C3（「字段缺省不多出区块」），它本来就该通过。
  恢复源码后回到 11/11。
- 深色模式（`data-theme="dark"`）下看过一遍：标签颜色档位正常，无串色。

## 边界

`window.deva.chat.applyModelSwap` 与 `importBridge` 都是桩：证明「后端返回值 → 渲染 → 文案」这条链路，
**不证明**主进程真的会在这些情形下返回这些字段（那是 `model-swap.ts` / `importer-mcp.ts` 的事，另有场景覆盖），
也没有在真实 Electron 里手点过目录选择、真实 Git 操作与跨重启恢复。