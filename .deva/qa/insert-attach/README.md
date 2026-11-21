# 插话带附件 —— 浏览器验证

回合进行中（`streaming: true`）也能贴图 / 选文件 / 拖入，并随插话一起送出。
用户报过「主会话在执行过程中，我插话不能输入图片，烦死了，我想截图让你看还不行」。

本目录用 esbuild 把**真实的 `Composer.tsx`**（含 Lexical 编辑器、附件条、插话胶囊）打进浏览器 bundle，
在真 Chromium 里驱动它——不是查字符串，也不是跑副本逻辑。

## 跑法

**CI 与本地同一条命令**（有退出码，绿红由程序判定）：

```bash
node .deva/qa/insert-attach/build.cjs   # 产出 page.html（bundle.js + deva-stub.js + test.ts 内联）
node .deva/qa/insert-attach/run.cjs     # 用真 Chromium 加载它，跑完 6 条并按结果 exit 0 / 1
```

`run.cjs` 会依次找浏览器：`DEVA_CHROME_PATH` 环境变量 → puppeteer 自带的 Chromium →
常见系统路径（Windows / macOS / Linux）。找不到就 exit 1 并说明怎么装。

也可以人工看：浏览器打开 `page.html`，`document.title` 形如 `DONE 6/6`，逐条结果在 `window.__logs`。

CI 里由 `安装 Chromium` + `插话带附件（运行时）` 两步跑（见 `.github/workflows/ci.yml`）。

> 为什么 CI 要显式装 Chromium：`puppeteer` 的 postinstall 在 pnpm 下被跳过（不在
> `onlyBuiltDependencies`），且 workflow 里 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`。
> `pnpm exec puppeteer browsers install chrome --install-deps` 会连带补 Linux 上 Chromium 缺的系统库。

## 这条守的语义（为什么不能只靠静态检查）

**插话带的图不能因为回合被停 / 队友点了撤回就凭空消失。**

用户贴那张图花的力气不比打字少，丢了只能重新截一次。这条是二开 `50e2868` 的验收点，
也是全套检查里**唯一**覆盖它的地方：

- `check-insert-attachments.cjs` 是**形状检查**——看签名有没有 `attachments`、函数体里有没有
  调 `mergePicked` / `mergeDraftAttachments`。**在 `restoreToComposer` 开头写一句
  `if (attachments) { return }`，它照样 19 PASS / 0 FAIL 全绿**，而功能已经废了。
- 本目录的第 6 条用例从 **DOM** 断言（附件 chip 真的回来了），短路后必然红。

实测（破坏验证）：加那句短路 → `5/6`，只有第 6 条红；复原 → `6/6`。

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
