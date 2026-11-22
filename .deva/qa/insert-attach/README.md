# 插话带附件 —— 浏览器验证

回合进行中（`streaming: true`）也能贴图 / 选文件 / 拖入，并随插话一起送出。
用户报过「主会话在执行过程中，我插话不能输入图片，烦死了，我想截图让你看还不行」。

本目录用 esbuild 把**真实的 `Composer.tsx`**（含 Lexical 编辑器、附件条、插话胶囊）打进浏览器 bundle，
在真 Chromium 里驱动它——不是查字符串，也不是跑副本逻辑。

## 跑法

**CI 与本地同一条命令**：

```bash
node .deva/qa/insert-attach/build.cjs   # 产出 page.html（bundle.js + deva-stub.js + test.ts 内联）
node .deva/qa/insert-attach/run.cjs     # 用真 Chromium 加载它，跑完 6 条并按结果给退出码
```

### 退出码：三种结果必须能分开

「浏览器装不上、用例根本没跑」和「用例跑了、代码真有 bug」是两件事。都 exit 1 会让人以为是代码坏了白查半天；反过来把环境问题算成通过就是假绿。

| 退出码 | 含义 | 该找谁 |
|---|---|---|
| `0` | 6 条全过 | — |
| `1` | **用例真的失败了**（有 FAIL） | 改代码 |
| `2` | **环境问题，用例未执行**（找不到/起不来浏览器、页面没渲染） | 改 CI 或本机环境 |

退出码 2 的输出全部以 `ENV` 开头，并明确写「这是环境问题，不是代码问题」。CI 里会被转成 `::error::` / `::warning::`，不会伪装成用例失败。

### 语言：断言不写死文案

**这套用例曾经只在中文系统成立。** 断言里写死了 `'附加文件'` 和「说明文案里含『附件』二字」，而 GitHub runner 的 `navigator.language` 是 `en-US`，`I18nProvider` 会渲染英文，于是 CI 上：

```
FAIL 回合进行中：附件条上出现「随这条插话带进去」的说明 → 说明文案不对：1 attachments go with it
FAIL 回合进行中：点「附加文件」也能加图（不只粘贴） → 找不到「附加文件」按钮
```

现在断言改成**从词条表取当前 locale 的期望值**再比（`test.ts` 的 `t()` 读 `window.__messages`，locale 取 `document.documentElement.lang`）。不再依赖任何具体文案，中英文都能跑，也不会因为改文案而静默失效。

`deva-stub.js` 把语言钉成 `zh-CN`（config 桩 + `navigator.language` + 清 localStorage 三层），让本地与 CI 跑同一个界面语言；`?locale=en` 可切到英文。

`run.cjs` 支持 `DEVA_TEST_LOCALE`，CI 上中英文各跑一遍：

```bash
node .deva/qa/insert-attach/run.cjs                    # zh-CN（默认）
DEVA_TEST_LOCALE=en node .deva/qa/insert-attach/run.cjs # 英文环境
```

英文那一步是**守「断言不依赖文案」这个性质**的：谁再把中文写死回断言里，它立刻红。

实测两种语言都 6/6，且界面确实渲染成了对应语言（不是碰巧）：

| locale | `cf.attach` 实际渲染 | 说明文案实际渲染 |
|---|---|---|
| `zh-CN` | `附加文件` | `1 个附件也会一起带进去` |
| `en` | `Attach file` | `1 attachments go with it` |

### 浏览器从哪来

`run.cjs` 依次找：`DEVA_CHROME_PATH` 环境变量 → puppeteer 自带的 Chromium → 常见系统路径（Linux `/usr/bin/google-chrome` 等 / Windows / macOS）。都没有就 exit 2 并说明怎么装。

CI **不需要装浏览器**：`ubuntu-latest`（24.04）镜像预装 Google Chrome 157.0.8103.78（与 puppeteer 25.18.1 要求的版本一致）和 Chromium 157，候选链会命中 `/usr/bin/google-chrome`。若哪天真没有，workflow 有一步兜底：装 Google 官方 deb 再用 `DEVA_CHROME_PATH` 指过去重跑。

**`/usr/bin/google-chrome` 已在 CI 实测可用**：日志显示 `browser: /usr/bin/google-chrome（来自 系统安装）`，Chrome 正常启动、用例正常跑完——不需要额外装系统库。runner-images 的 `install-google-chrome.sh` 里也设了 `CHROME_BIN=/usr/bin/google-chrome`，这个路径是它自己保证的。

> 曾经这里跑 `puppeteer browsers install chrome --install-deps`，在 CI 上必红：
> `--install-deps` 要装系统库、需要 root，而 runner 默认不是 root，报
> `Installing system dependencies requires root privileges`。
> 另外别用 `apt install libasound2`：Ubuntu 24.04 起它成了 virtual package（实现是
> `libasound2t64`），单独装会 `no installation candidate`；也别用 `chromium-browser`
> （24.04 上是 snap 过渡包）。走 deb 让 apt 自己解析依赖就不会碰到这两个坑。

也可以人工看：浏览器打开 `page.html`，`document.title` 形如 `DONE 6/6`，逐条结果在 `window.__logs`。

## 这条守的语义（为什么不能只靠静态检查）

**插话带的图不能因为回合被停 / 队友点了撤回就凭空消失。**

用户贴那张图花的力气不比打字少，丢了只能重新截一次。这条是二开 `50e2868` 的验收点，也是全套检查里**唯一**覆盖它的地方：

- `check-insert-attachments.cjs` 是**形状检查**——看签名有没有 `attachments`、函数体里有没有调 `mergePicked` / `mergeDraftAttachments`。
- 本目录的第 6 条用例从 **DOM** 断言（附件 chip 真的回来了）。

这组对照是最好的例子，说明「静态判据全绿」和「功能没坏」不是一回事。在 `restoreToComposer` 开头插一句 `if (attachments) { return }`（模拟「附件永远不还回去」的回归）：

| 检查 | 结果 |
|---|---|
| `check-insert-attachments.cjs`（静态形状） | **19 PASS / 0 FAIL，exit=0** —— 完全看不出问题 |
| `run.cjs`（运行时用例） | **5/6，exit=1** —— 第 6 条红：`超时：插话失败后附件没放回输入框` |

复原后两边都绿（19/0、6/6）。所以形状检查守着「代码长什么样」，运行时用例守着「用户还能不能用」——两者缺一不可。

## 用例（6 条）

| # | 验的是 |
|---|---|
| 1 | 回合进行中粘贴图片能进输入框（旧行为是直接丢弃） |
| 2 | 附件条上出现「随这条插话带进去」的说明 |
| 3 | 只有附件、没有正文也能插话，且 `insert` 的入参里带上了附件路径 |
| 4 | 点「附加文件」也能加图（不只粘贴） |
| 5 | 插话成功后输入框与附件条清空（不残留、不重复发） |
| 6 | **插话失败（回合恰好结束）→ 正文与附件一起放回输入框** ← 见上一节，唯一能抓短路的一条 |

## 反向验证（改坏哪一处会让哪条红）

改 `Composer.tsx` 后重跑 `build.cjs`，实测：

| 改回旧写法 | 结果 |
|---|---|
| `onPaste` 里恢复 `if (!streaming) void ingest(files)` | 2/6（粘贴相关 4 条全红） |
| `insertNow` 改回 `onInsert(full)`（不传附件） | 4/6（第 3、4 条红：`附件应带 1 项，实际 undefined`） |
| 失败分支改回 `restoreToComposer(sid, full)`（不还附件） | 5/6（第 6 条红） |

## 桩与取舍

- `deva-stub.js`：**必须在 bundle 之前**注入（模块顶层读 `window.deva.platform`，晚一步整个 bundle 抛错）。
  除显式写出的 `fs.pasteAttachment` / `droppedEntries` / `attachmentImage` 外，其余 `window.deva.*`
  由 Proxy 兜底成万能异步函数——Composer 的依赖链很深，逐个照抄签名只会让桩面无限膨胀、且与上游漂移。
- `stub-chat.ts`：真实 `ChatProvider` 挂载会打一串 IPC，且「回合进行中」只能由真实回合驱动，
  本用例恰恰要验它 → 整模块替换。`insert` / `send` 的返回值照抄真实签名 `Promise<boolean>`，
  写成 `{ok}` 对象会让失败分支永远不走（踩过）。
- `stub-browsercapsule.ts`：真实 BrowserCapsule 要一整套 `window.deva.browser.*`，与本用例无关，整个替换掉。
