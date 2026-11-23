# 判据被源码注释骗过：正则先剥注释再匹配

> 状态：已落地（`.deva/qa/lib/strip-comments.cjs` + `.deva/qa/check-qa-no-comment-trap.cjs`）
> 日期：2026-11-23

## 问题

`.deva/qa/` 下的判据大量用正则断言源码，比如「`isSafeEntryPath(name)` 这一行必须存在」。
但正则匹配的是**整份文件文本**，包括注释。于是出现一类假绿：

```ts
// if (!isSafeEntryPath(name)) throw new Error('refuse')   ← 这一行被注释掉了
```

判据照样 PASS —— 因为字符串还在，只是代码不跑了。反过来也成立：把正确代码注释掉、
在注释里写一段看起来对的实现，判据同样绿。

**这类假绿比判据没写更危险**：判据没写，至少知道自己没验；假绿是「验证过了」的错觉。

## 做法

`lib/strip-comments.cjs` 提供状态机式剥注释，**把注释替换成等长空格**（不是删掉）：

- 保留行号 → 报错行号仍然准确
- 保留字符位置 → 后续切片（`sliceBraced` / `sliceBracket`）偏移不变
- 保护字符串字面量里的 `//`（如 URL `https://…`）
- 保护**正则字面量**（`/ab+c/`）—— 这一条最容易漏，见下节

导出 `lineWith` / `sliceBraced` / `sliceBracket` 供各判据复用。

## 三个必踩的坑

### 1. 裸正则剥注释会削掉字符串里的内容

最初在 `check-backup-fields.cjs` / `check-worktree-i18n.cjs` 里用的是 `src.replace(/\/\/.*$/gm, '')`。
结果 `'https://example.com'` 被从 `//` 处整段削掉，**文件少了 3210 个字符**，
后续所有偏移全错。必须用状态机，判断当前位置是否在字符串 / 模板串 / 正则里。

### 2. 不认正则字面量 → 整段漏剥

`/ab+c/.test(x)` 里的 `/` 会被当成除法，状态机就此迷失，后面整段代码都被当成「正则内部」而不剥。
`check-qa-no-comment-trap.cjs` 自身一度有这个缺陷，导致它对一批脚本空跑。

### 3. `||` 兜底本身就是假绿来源

判据里写 `if (A.test(x) || B.test(x))` —— 如果 A 能命中，B 永远多余；两个都命中不了时，
这条断言等于什么都没验。元判据把「同一个正则断言里出现 `||`」直接判 FAIL。

**实测抓到过**：`check-worktree-inside-root-ui.cjs:105` 曾写
`/<span[^>]*className="cf-wt__badge"/.test(l) || /<span[^>]*cf-wt__badge/.test(l)`，
第一个分支能命中的第二个必然也能命中，纯冗余。已改成单条正则。

## 元判据的三种检查

`check-qa-no-comment-trap.cjs` 对 `.deva/qa/` 下所有对源码做正则断言的脚本跑三态：

| 检查 | 判什么 |
| --- | --- |
| T1 | 断言的字符串只出现在注释里 → FAIL（真代码里没有） |
| T2 | 正则里出现 `\|\|` 兜底 → FAIL |
| T3 | 用 `[\s\S]{0,N}` 这类超长跨行窗口 → FAIL（能跨过整段代码，等于没限定） |

支持 `--verbose`、`--base=<ref>` / 环境变量 `QA_TRAP_BASE` 做 diff 模式（只对本次改动涉及的脚本报 FAIL）。
**CI 里用 diff 模式**：存量脚本的历史问题不阻塞新提交，但新增/修改的脚本必须干净。

当前 **15 个脚本 45 PASS / 0 FAIL**。

## 反向验证过的三类假绿

| 制造的错误 | 元判据 | 修复前的判据 |
| --- | --- | --- |
| 注释掉 `isSafeEntryPath(name)` | FAIL B4d | **PASS（假绿）** |
| 注释掉 `rm(staging…)` | FAIL B5 | **PASS（假绿）** |
| 注释掉 `trustRoot(targetPath)` | FAIL R11 | **PASS（假绿）** |

## 结构性豁免

`check-git-focus.cjs` 有一条断言是**有意**检查注释内容的（它验的就是「注释里写明了某条约定」）。
这类例外显式写成 `qa-trap-exempt:` 前缀，元判据识别后放行并打印出来 —— 不静默跳过。

## 何时重看这份记录

- 新增 `.deva/qa/` 下的判据脚本时
- 改 `check-qa-no-comment-trap.cjs` 时
- 发现某条判据「一直是绿的」但功能实际坏了的时候
