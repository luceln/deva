# 分支 pill 刷新时机 —— 运行时行为验证（需浏览器，手动跑）

覆盖用户实测反馈的 bug：**在终端把仓库切了分支，点回应用，挂载 chip 上的分支 pill 还是旧分支名**，
必须切走再切回该会话（触发组件重新挂载）才更新。

## 怎么跑

```bash
node .deva/qa/git-pill/build.cjs
# 用内置浏览器打开 .deva/qa/git-pill/page.html（换 ?v=时间戳 强刷，file:// 会拿缓存）
# 页面标题变 DONE n/10 即结束；window.__logs 里是逐条 PASS/FAIL
```

`build.cjs` 用 esbuild 把**真实的 `GitWidget.tsx`（含 `useGitStatus`）**打进浏览器 bundle，
只把两个与本用例无关的重依赖换成桩：

| 桩 | 原因 |
|---|---|
| `store/chat` | 真实 `ChatProvider` 挂载时会打一串 `chat.*` IPC，与 pill 无关 |
| `store/models` | 只用来拼「生成提交信息」的模型，本用例给空 |

`i18n` / `Toast` / `Dialog` / `Modal` / `ContextMenu` / `lucide` 全用真实实现。
`window.deva.git` 用桩：`branchNow` 是「外部世界当前的分支」，测试中途改它模拟终端切分支。

## 10 条用例

| # | 用例 | 证明了什么 |
|---|---|---|
| 1 | 挂载即渲染当前分支（dev） | 基线成立 |
| 2 | 外部切到 main 后，不触发任何动作时 pill 仍是旧值 | **复现 bug**：不刷新就不变 |
| 3 | 窗口重新获得焦点 → pill 更新为 main | **本次修复** |
| 4 | 窗口不可见（hidden）时 focus 不触发拉取 | 没有多花一次 git 进程 |
| 5 | 可见但 `document.hasFocus()` 为假时不拉取 | 同上（窗口被别的应用盖住） |
| 6 | 恢复可见 + 聚焦 → pill 跟上 feature/x | 从隐藏回到前台也能跟上 |
| 7 | 连续两次 focus 不叠加并发请求 | `reqRef` 防竞态够用 |
| 8 | status 抛错时 pill 隐藏而不崩 | 容错路径 |
| 9 | 恢复后 focus 能让 pill 重新出现 | 错误可恢复 |
| 10 | 卸载后 focus 监听已移除 | 清理正确，不残留不发请求 |

## 结果

- 修复后：**10/10 PASS**
- 反向验证（把 `useEffect` 里的 focus 注册与清理整段换成 `return undefined`）：**4/10**，
  失败 6 条正好是依赖 focus 刷新的第 3/4/6/7/8/9 条 —— 说明这套用例不是空转。
- 恢复后回到 10/10。

## 边界

这套用例驱动的是真组件、真 DOM、真事件，但 `window.deva.git` 是桩：
它证明「事件 → 重渲染 → pill 文本更新」这条链路，**不证明**真实主进程 `git status` 的返回正确
（那是主进程的事，另有场景覆盖）。

CI 里跑的是 `.deva/qa/check-git-focus.cjs`（纯源码结构判据，无需浏览器），
它只能证明「注册了 focus 监听、清理了、回调调到 refresh、没改成轮询、注释与实现一致」，
**不能**替代这里的运行时验证。
