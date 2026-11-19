# 流式输出滚动跳变 —— 修复与实测

用户报：「输出内容时我想上滚看最新内容，结果莫名跳到很上面，像很久之前的内容。
期望是：我一旦自己滚，就打断自动往下滚，直到我滚回底部或点向下的按钮。」

## 根因（实测确证）

**补段落位用的是「距底距离」，而正解是「元素锚点」。**

用户上滚到离已渲染内容顶部 600px 以内 → `loadEarlier()` 补进 10 轮更早历史 →
补完按 `scrollHeight - restoreRef` 重新落位。这个算法把**底部的增长**也算进补偿里，
而底部增长与「用户在看哪一行」毫无关系，于是画面被推走。

第一次实测（旧代码，一击命中）：

```
拍 ｜ 滚动前(top/turn) → 滚动后(top/turn/DOM条数) ｜ 实际位移(期望 -120)
 11 ｜  739/14 →  619/13/22 ｜ -120
 12 ｜  619/13 → 2817/13/42 ｜ +2198   ← 向上滚，scrollTop 却暴增 2198
```

补段前后视野：第 17 个问题 → 第 13 个问题。

### 排除的其它假设

| 假设 | 结论 | 证据 |
|---|---|---|
| 滚动锚定（`overflow-anchor`） | **不是主因** | 关掉 `overflow-anchor: none` 后十个用例全绿；本场景我们自己写 `scrollTop`，锚定根本没机会介入 |
| 节点重建（key 不稳） | **不是** | `updateLastAssistant`（`store/chat.tsx:939-951`）用 `{ ...last, blocks }` 更新末条，`id` 恒定 |
| 强制滚动覆盖用户意图 | **方向相反** | 自动跟随有 `stickRef` 判断，用户上滚后实测位置纹丝不动 |
| 虚拟滚动 | **没有** | 是「分段渲染窗口」，DOM 真实存在、不做高度估算 |
| `scroll-behavior: smooth` | **不是** | 全库仅 `jumpToLatest` 一处；补段走直接赋值 |

**是上游代码，不是二开引入**：`git show upstream/main:.../Conversation.tsx` 里这几处逻辑一致。

## 改了什么

| 文件 | 改动 |
|---|---|
| `redesign/ConvMessage.tsx` | 各分支根节点加 `data-msg-id={msg.id}`（7 处），作补段锚点 |
| `redesign/Conversation.tsx` | ① 元素锚点落位（`captureAnchor` / `restoreAnchor`）；② 双阈值（按钮 200px / 恢复跟随 8px）；③ 脱离跟随改为 `wheel` / `touchmove` / `keydown` 输入事件驱动，`scroll` 方向判断兜底；④ `LOAD_MORE_PX` 600→120 + `loadingRef` 闸门；⑤ `writeScrollTop` 统一「写位置并同步基线」；⑥ 落底改 `useLayoutEffect` |
| `redesign/redesign.css` | `.cf-msgs` 加 `overflow-anchor: none` + `scroll-behavior: auto` |

### 关键实现说明

- **锚点用 `data-msg-id` 而不是 `data-turn`**：同一轮里有多条消息（用户气泡、助手回复、卡片），turn 会重复。
- **`writeScrollTop` 必须同步基线**：`scroll` 事件分不出是用户滚的还是程序滚的；程序写完不改基线，下一个 scroll 事件会被读成「用户上滚」，跟随被打断。
- **`PageUp` 的边界 bug（S7）**：`detach()` 置 `stickRef=false` 后，`dist` 仍是 0（已在最底，按键不产生位移），ResizeObserver 的「已到底就恢复跟随」分支立刻把它吃回去。修法：**只有内容真的变矮**（`scrollHeight` 未增长）才在该分支恢复跟随。「位置碰巧在底部」≠「用户想回到底部」。

## S1~S10 实测（真实 `Conversation` 组件，Chrome 驱动）

| # | 场景 | 期望 | 实测 | 结论 |
|---|---|---|---|---|
| S1 | 流式输出中持续不上滚 | 稳定跟随 | dist 轨迹 20 拍全为 0 | PASS |
| S2 | 上滚 | 立即停止、不跳变 | 1890→1690（-200），再输出 10 拍仍 1690 | PASS |
| S3 | 上滚后继续输出 | 位置纹丝不动 | dist 300 → 15 拍全 300 | PASS |
| S4 | 自己滚回底部 | 恢复跟随 | 滚回后 dist=0，再 9 拍仍 0 | PASS |
| S5 | 点「回到底部」 | 平滑滚底并恢复 | 点击后 dist=0，再 7 拍仍 0 | PASS |
| S6 | 上滚触发补段 | 位置保持 | 位移 2318 / 上方插入 2319（差值 **-1px**） | PASS |
| S7 | PageUp / ArrowUp | 同 S2 | 按钮出现并保持，位置不动 | PASS |
| S8 | 拖滚动条上移 | 同 S2 | dist 500，输出后仍 500 | PASS |
| S9 | 输入框里按 ArrowUp | 不触发脱离 | dist 保持 0（仍跟随） | PASS |
| S10 | 高度大幅变化 | 不跳变 | 贴底态大 chunk 后 dist=0 | PASS |

### S6 前后对比（核心）

```
补段前  top=1200  h=2301  DOM=20  锚点=m243  offsetTop=1159
补段后  top=2358  h=5170  DOM=41  锚点 offsetTop=3478（上方插入 2319px）
位移=2318px；总增高=2869px；上方插入=2319px
差值：位移-上方插入 = -1px   ← 元素锚点语义正确
差值：位移-总增高  = -551px  ← 底部新增的 551px 没有被算进来
```

## 三条反向验证

| 撤掉什么 | 结果 | 说明 |
|---|---|---|
| `overflow-anchor: none` | **全部仍绿** | **这条不是主因**，如实说明。我们自己也写 `scrollTop`，锚定在本场景没机会介入；保留它是防御性的（避免将来别处的内容变化触发锚定） |
| 元素锚点 → 距底距离 | **S6 红**：位移 2869 vs 上方插入 2319 | **偏差 +550px，方向是「往下推」**，视野从第 12 个问题滑到第 14 个。这直接印证了业界结论「距底距离会把底部增长也算进补偿，把读者推过头」 |
| 去掉输入事件、只留位置判断 | **S7 红**：PageUp 后不脱离 | S2 仍绿（wheel 有位移，方向判断能兜住）；键盘上滚在贴底时零位移，位置判断完全失效 |

## 关于调研那条「`m.id` 流式期间不稳定」的推断

**不成立**。`updateLastAssistant`（`store/chat.tsx:939-951`）流式每 chunk 都是
`copy[last] = { ...last, blocks: nextBlocks }`，`id` 原样保留，`key` 稳定。

## 跑法

```bash
node .deva/qa/stream-scroll/build.cjs   # 产出 page.html
# 浏览器打开 .deva/qa/stream-scroll/page.html，看 document.title（形如 DONE 10/10）与 window.__logs
```