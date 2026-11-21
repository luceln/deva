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
# 页面标题变 DONE n/25 即结束；window.__logs 里是逐条 PASS/FAIL
```

`build.cjs` 用 esbuild 把**真实的 `ImportPane` 与 `ModelSwapDialog`**（含 `Modal` / `Select` / i18n / CSS）
打进浏览器 bundle，只替换四个模块：

| 桩 | 原因 |
|---|---|
| `importBridge` | 报告要能从外面可控地喂进去，不经过 IPC |
| `store/chat` | 真实 `ChatProvider` 挂载就打一串 IPC，且 `applyModelSwap` 的返回值必须可控 |
| `store/models` | 要断言 superseded 显示的是**模型名**（`Claude Lite`）而不是引用原文，需要固定服务商 |
| `store/extensions` / `modelSettingsBus` | 导入成功后只调 refresh；本用例不验跳转 |

## 25 条用例

**pluginManaged（A，导入报告）**

| 用例 | 证明了什么 |
|---|---|
| 服务商行有「由插件管理，未导入」标签，跳过数仍为 0 | 不把插件托管算成「已存在，跳过」 |
| 展开明细逐条列出 id + 「去插件里改」 | 用户知道说的是哪些、该去哪改 |
| 只有插件托管项的行仍然显示 | 0 新增 0 跳过不被行过滤吞掉（否则等于界面上一字不提） |
| 密钥行的插件托管不落进「需要重新填写」警告 | 不给一条走不通的指引（插件密钥在设置页没有输入框） |
| 英文环境用插件口径 | 中英都到位，不是中文硬编码 |
| 英文单复数（1 managed / 2 managed）+ 明细用英文冒号逗号 | 不出现「1 belong to a plugin」「not imported：magpie」 |

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

**文案缺陷（E，验收实测那三处 + toast 漏失败项）**

| 用例 | 证明了什么 |
|---|---|
| 查不到名字时不把内部引用摆给用户 | `openai:gpt-mystery` 只进 `title`，可见文本是「另一个模型」 |
| 查得到名字时仍显示模型名 | 修复没有退化成「一律另一个模型」 |
| 英文摘要不含全角标点（，、：；） | 分隔符按语言取，不是写死 |
| 英文插件标签单复数正确 | 不再出现「1 belong to a plugin」 |
| 导入明细用英文冒号与逗号 | 不再出现「not imported：magpie」 |
| toast 与对话框摘要**完全一致** | 失败项不在 toast 里消失 |
| 中文侧仍是全角分隔符 | 没为英文把中文改坏 |

**观感（F，同屏一致性与中文插值）**

| 用例 | 证明了什么 |
|---|---|
| 中文 superseded 行插值前无空格（真名 / 空引用 / 未知三种） | 不再渲染成「用的是 Claude Lite」 |
| 英文 superseded 行的空格保持 | 没有为中文把英文改坏 |
| 中文同屏只有一套插件术语 | 标签与明细都是「由插件管理」，无双说法 |
| 英文同屏只有一套插件术语 | 标签与明细都是 `managed by`，不残留 `Owned by` |

**失败码文案（G，会话两条新码）**

| 用例 | 证明了什么 |
|---|---|
| 中文：历史锁定 / 附件缺失说人话 | 不出现 `session-history-locked`、`session-media-missing`；锁定条说明「没有丢」并给出「聊完再导入」 |
| 英文：同一组失败码 | 不出现错误码，全角标点一个都没有，读到 `No data was lost` |
| 未知码仍原样显示 | 没为这两条把兜底改成静默 |

**英文与字段名（D）**：英文环境下三项都说英文，且界面上不出现 `indexStale` / `superseded` / `pluginManaged`
这类字段名。

## 结果

- 修复后：**25/25 PASS**，`window.__errors` 为空。
- 反向验证 ①：把三处渲染分别短路（插件标签、indexStale 区块、superseded 区块）→ **1/11**（当时 11 条），
  失败的 10 条正好是依赖这三处展示的用例；唯一仍通过的是 C3，它本来就该通过。
- 反向验证 ②（文案缺陷这批）：把 `refLabel` 回落改回引用原文、分隔符写死全角逗号、toast 去掉失败项、
  明细写死全角冒号顿号 → **14/18**，失败的是 E1 / E3 / E5 / E6；再把英文单复数改回 `{n} belong to a plugin`
  → E4 失败。恢复后回到 18/18。
- 反向验证 ③（观感这批）：中文模板加回插值前的空格、术语改回「归插件管 / Owned by」→ **18/22**，
  失败的是 F1（三种形态全红）/ F3 / F4，以及同样校验明细术语的 E5。恢复后回到 22/22。
- 反向验证 ④（两条会话失败码）：把 `FAILURE_REASON_KEY` 里这两条映射删掉 → **23/25**，G1 / G2 因错误码
  原样渲染而红。恢复后回到 **25/25**。
- 深色模式（`data-theme="dark"`）下看过一遍：标签颜色档位正常，无串色。

## 边界

`window.deva.chat.applyModelSwap` 与 `importBridge` 都是桩：证明「后端返回值 → 渲染 → 文案」这条链路，
**不证明**主进程真的会在这些情形下返回这些字段（那是 `model-swap.ts` / `importer-mcp.ts` 的事，另有场景覆盖），
也没有在真实 Electron 里手点过目录选择、真实 Git 操作与跨重启恢复。