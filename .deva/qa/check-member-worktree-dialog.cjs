#!/usr/bin/env node
/**
 * `MemberWorktreeDialog` 的 5 个回调是否真的接到了 IPC —— 判据。
 *
 * ## 为什么不能只查「回调名出现了」
 *
 * `MemberWorktreePanel` 的 5 个回调**全是可选**（`onPrecheck?`、`onReturnToOriginal?`…）。
 * 漏接一个不会报错：Panel 自己会把它当「没有桥」处理，静默隐藏对应按钮。
 * 用户看到的是「这个按钮怎么没有了」，而 `tsc` 一句话都不会说。
 *
 * 更要紧的是**空实现**：写 `onReturnToOriginal={async () => {}}` 类型完全合法、
 * 按钮也在、点了也有确认框，但**什么都不会发生** —— 这种「看起来接好了」最坏。
 * 所以本判据按「回调体里到底有没有调那个真实通道」来判，不看名字在不在。
 *
 * ## 三步
 *   1. 每个回调必须存在，且回调体内出现对应 IPC 方法名（正着查）
 *   2. 回调体内**不能**是空实现 / 只有 `void`（反着查）
 *   3. 主进程与 preload 侧通道必须真的存在（否则接了个不存在的函数，运行时才炸）
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', '..')
const DIALOG = path.join(ROOT, 'apps/desktop/src/renderer/src/redesign/MemberWorktreeDialog.tsx')
const PRELOAD = path.join(ROOT, 'apps/desktop/src/preload/index.ts')
const I18N = path.join(ROOT, 'apps/desktop/src/renderer/src/i18n/messages.ts')

let pass = 0
let fail = 0
const ok = (n, d) => {
  pass += 1
  console.log(`  PASS ${n}${d ? ` :: ${d}` : ''}`)
}
const bad = (n, d) => {
  fail += 1
  console.log(`  FAIL ${n}${d ? ` :: ${d}` : ''}`)
}

const { stripComments } = require('./lib/strip-comments.cjs')

/*
 * 断言一律看**剥掉注释**的源码。
 *
 * 这个脚本查的字符串（`bindingInconsistent`、`memberWorktreeReturnOriginal`、
 * `useChatState()` 反例）在修复类注释里会原样出现 —— 头注释就在讲「bf30126 revert 掉了
 * 协议字段」「不要再读当前选中会话」。不剥注释时，把实现删掉、只留注释也照样 PASS。
 */
const dialog = stripComments(fs.readFileSync(DIALOG, 'utf8'))
const preload = stripComments(fs.readFileSync(PRELOAD, 'utf8'))
const i18n = fs.readFileSync(I18N, 'utf8')

/*
 * 依赖的功能不在本分支 → 显式 SKIP，不是 FAIL。
 *
 * `MemberWorktreeDialog` 及其 4 个 `memberWorktree*` 桥、`returned` 词条只存在于
 * `feat/member-worktree`，在本分支被 `bf30126` revert 掉了。此时本判据只能验到
 * 「这些东西都不在」，那 6 条红不代表实现写错，也不是判据坏了 —— 是**没有可判的对象**。
 *
 * 判据：preload 里一个 `memberWorktree*` 桥都找不到，就认定功能不在此分支。
 * **绝不静默 exit 0**（`.deva/qa/AGENTS.md`：跳过项必须打印），否则下一个人会以为检查过了。
 */
{
  const bridges = [
    'memberWorktreePrecheck',
    'memberWorktreeBind',
    'memberWorktreeRetryBind',
    'memberWorktreeReturnOriginal'
  ]
  const present = bridges.filter((b) => new RegExp(`\\b${b}\\b`).test(preload))
  if (present.length === 0) {
    console.log('\n==SKIP== 本判据未执行（不计入通过，也不是失败）')
    console.log(
      '  依赖的功能不在此分支：preload 里 4 个 memberWorktree* 桥一个都不在' +
        '（apps/desktop/src/preload/index.ts）'
    )
    console.log('  该功能只在 feat/member-worktree 分支存在（本分支被 bf30126 revert 掉了）。')
    console.log('  合回 feat/member-worktree 后本判据自动生效；在此之前它一条断言都没跑。')
    console.log('  → 退出码 0，但请把它当作「没跑」，不要当作「全绿」。')
    process.exit(0)
  }
}

/** 取某个 JSX 属性的回调体（从 `名字={` 起按花括号配对到收尾）。 */
function attrBody(src, name) {
  const at = src.indexOf(`${name}={`)
  if (at < 0) return null
  let i = src.indexOf('{', at)
  let depth = 0
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1
    else if (src[j] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(i + 1, j)
    }
  }
  return null
}

/* ── 1. 五个回调都接到真实 IPC ── */
console.log('== 1. 五个回调分别在回调体内调用对应 IPC ==')
/*
 * `MemberWorktreePanel` 的 Props 里 5 个回调，逐个钉到它必须调的那个通道。
 * `onBound` / `onUseDirectory` 不在下面这张表里：前者故意空实现（主进程 bind 已把
 * focus 改好，再 bind 一次会绑两遍），后者要单独查 setFocus 的会话参数。
 */
const WIRED = [
  ['onPrecheck', 'memberWorktreePrecheck'],
  ['onCreateAndBind', 'memberWorktreeBind'],
  ['onRetryBind', 'memberWorktreeRetryBind'],
  ['onReturnToOriginal', 'memberWorktreeReturnOriginal']
]
for (const [attr, channel] of WIRED) {
  const body = attrBody(dialog, attr)
  if (body === null) {
    bad(`${attr} 没接`, 'Panel 会当成「没有桥」，对应按钮静默消失')
    continue
  }
  /*
   * 反着查空实现：去掉注释与空白后若只剩 `async () => {}` / 只有 void/return，
   * 就是「按钮在、点了没事发生」那种最坏的假接线。
   */
  const bare = body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\s+/g, '')
  if (bare.length < 20) {
    bad(`${attr} 是空实现`, `去掉注释后只剩 ${bare.length} 字符：「${bare}」`)
    continue
  }
  if (bare.includes(channel)) ok(`${attr} 调了 ${channel}`)
  else bad(`${attr} 没调 ${channel}`, '回调体里找不到该通道名')
}

/* ── 2. onUseDirectory 必须用 sessionId，不能引用当前选中会话 ── */
console.log('\n== 2. onUseDirectory 用 sessionId 调 setFocus（不读当前选中会话）==')
const useBody = attrBody(dialog, 'onUseDirectory')
if (useBody === null) bad('onUseDirectory 没接')
else {
  const bare = useBody.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/\s+/g, '')
  if (!bare.includes('setFocus')) bad('onUseDirectory 没调 setFocus')
  else if (!/sessionId/.test(bare)) bad('onUseDirectory 没带 sessionId', '请求中途切会话会绑错成员')
  else if (/activeSession|currentSession|selectedSession|useChatState\(\)/.test(bare))
    bad('onUseDirectory 读了当前选中会话', '用户中途切会话会把成员绑到别的目录上')
  else ok('onUseDirectory 用 sessionId 调 setFocus', '不依赖当前选中会话')
}

/* ── 3. bindingInconsistent 真的被用来挡 Panel ── */
console.log('\n== 3. bindingInconsistent === true 时不渲染 Panel ==')
/*
 * 架构与主进程都强调过：这个字段为真时渲染操作面板，用户会对着一个假的
 * 「返回原目录」按钮点下去（原目录早没了）。所以必须出现在「不渲染 Panel」的分支上。
 */
if (!/bindingInconsistent/.test(dialog)) {
  bad('Dialog 没读 bindingInconsistent', '状态不可信时仍渲染操作面板')
} else {
  /*
   * 取到渲染门禁 `if (!state || ... )`，确认 `bindingInconsistent` **经变量真的参与**了它。
   *
   * 只查 `const inconsistent = !!state?.bindingInconsistent` 存在是不够的 —— 实测把
   * `blocked = inconsistent || ...` 改成 `blocked = unfinishedRecovery`（同时留一句
   * `void inconsistent` 消掉未使用告警）后，那种查法仍然全绿，而 Panel 照样渲染出来了。
   * 必须一路追到门禁条件里。
   */
  const viaVar = /const\s+inconsistent\s*=\s*!!state\?\.bindingInconsistent/.test(dialog)
  const blockedAt = dialog.indexOf('const blocked =')
  const blockedLine = blockedAt >= 0 ? dialog.slice(blockedAt, dialog.indexOf('\n', blockedAt)) : ''
  const gateAt = dialog.indexOf('if (!state ||')
  const gate = gateAt >= 0 ? dialog.slice(gateAt, dialog.indexOf(')', gateAt) + 1) : ''
  const inGate = /\bblocked\b/.test(gate)
  const inBlocked = /\binconsistent\b/.test(blockedLine)
  if (!viaVar) bad('找不到 bindingInconsistent 的具名变量', '无法确认它参与门禁')
  else if (!inBlocked) bad('inconsistent 没参与 blocked 的计算', `blocked = ${blockedLine.split('=')[1]?.trim()}`)
  else if (!inGate) bad('blocked 没参与渲染门禁', '页面照样渲染出操作按钮')
  else ok('bindingInconsistent 一路参与渲染门禁', 'inconsistent → blocked → if (!state || … || blocked)')
}

/* ── 4. 通道在 preload / 主进程侧真的存在 ── */
console.log('\n== 4. 通道在 preload 里真的存在（不是接了个不存在的函数）==')
for (const [, channel] of WIRED) {
  if (new RegExp(`${channel}\\s*:\\s*\\(`).test(preload) || new RegExp(`${channel}\\s*:`).test(preload))
    ok(`preload 有 ${channel}`)
  else bad(`preload 缺 ${channel}`, '运行时会是 undefined.cannot read')
}

/* ── 5. original-unavailable 的文案路径存在 ── */
console.log('\n== 5. 返回原目录的两个出口都有文案 ==')
/*
 * 两个出口：失败（原目录不可用，用主进程 message）与成功（keptCheckoutRoot 还在）。
 * 成功这条最容易漏 —— 不说的话用户以为工作区被一起删了。
 */
const keptAt = dialog.indexOf('keptCheckoutRoot')
if (keptAt < 0) bad('成功回调没读 keptCheckoutRoot', '用户以为工作区被删了')
else ok('成功回调读了 keptCheckoutRoot')
/* 失败路径必须原样采用主进程 message，不能自己拼一句不动听的。 */
const retBody = attrBody(dialog, 'onReturnToOriginal') || ''
if (/result\.message\s*\?\?\s*result\.reason/.test(retBody)) ok('失败路径用主进程 message ?? reason', '不自己拼文案')
else bad('失败路径没用主进程 message', 'original-unavailable 里带的保留路径会丢')
/* 词条：中英都要有，且 returnedKept 带 {path}。 */
for (const key of ['returned', 'returnedKept']) {
  const hits = [...i18n.matchAll(new RegExp(`^\\s{8}${key}:\\s*'([^']*)'`, 'gm'))].map((m) => m[1])
  if (hits.length < 2) bad(`${key} 词条不足`, `只有 ${hits.length} 处，应 zh + en`)
  else if (key === 'returnedKept' && !hits.every((s) => s.includes('{path}')))
    bad('returnedKept 缺 {path}', '路径嵌不进去，用户看不到目录在哪')
  else ok(`${key} 中英齐全`, key === 'returnedKept' ? '带 {path}' : '2 处')
}
/* 填充：{path} 必须真的被 keptCheckoutRoot 填。 */
if (/returnedKept'\)\.replace\('\{path\}',\s*result\.keptCheckoutRoot\)/.test(dialog))
  ok('returnedKept 的 {path} 被 keptCheckoutRoot 填充')
else bad('returnedKept 的 {path} 没填充', '会显示成「独立工作区目录仍在：{path}」')

/* ── 6. onBound 故意空实现（回归保护）── */
console.log('\n== 6. onBound 是故意空实现（再 bind 一次会绑两遍）==')
if (/onBound=\{\(\)\s*=>\s*\{\}\}/.test(dialog)) ok('onBound 空实现', '主进程 bind 已改好 focus，不重复绑')
else bad('onBound 被改成有副作用', '可能把同一成员绑两遍')

console.log(
  fail === 0 ? `\n==RESULT== ${pass} PASS / 0 FAIL` : `\n==RESULT== ${pass} PASS / ${fail} FAIL`
)
process.exit(fail === 0 ? 0 : 1)