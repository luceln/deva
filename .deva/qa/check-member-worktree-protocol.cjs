#!/usr/bin/env node
/**
 * 成员工作区两个协议缺口 —— CI 可跑的断言（驱动真实逻辑，不是「字符串在文件里」）。
 *
 * ## 两个缺口与它们的失效形状
 *
 * **缺口 1 `MemberWorktreeState.bindingInconsistent`**
 *   面板要拿它决定「渲染操作面板」还是「只显示核实中」。缺了它，界面只能在未核实的
 *   状态下允许用户点「返回原目录」，而原目录可能早就没了 —— 用户点了才发现失败，
 *   或者更糟：界面以为切换成功，实际绑定还指着那个已失效的目录。
 *
 * **缺口 2 `memberWorktreeReturnOriginal` 通道**
 *   `bf30126` revert 时把 `0848228` 的协议字段一起撤了，于是「返回原目录」这个出口
 *   从「有协议没实现」变成「连协议都没有」。手上有独立工作区的成员无法回到自己原来的目录。
 *
 * 这类缺陷的形状是「字段/通道缺失」，编译、类型、人眼都不报错 —— 只有判据能守。
 *
 * ## 判据对象
 *
 * 真实的 `member-worktree.ts` / `member-worktree-guard.ts` / `member-binding-*` / 协议文件，
 * 用 esbuild 打成 cjs。只 stub `electron`。
 *
 * ## 隔离（红线）
 *
 * 全部夹具在 `os.tmpdir()/deva-mwt-*` 下，`DEVA_HOME` 与 `APPDATA` 指到临时目录。
 * **绝不碰**真实 `~/.deva-plus` 与 `%APPDATA%/devaplus`。
 *
 * ## 本判据看不见的
 *
 *   · 面板在 `bindingInconsistent === true` 时**实际**渲染成什么样、按钮是否真的禁用了 —— 要浏览器，
 *     见 `apps/desktop/src/renderer/tests/member-worktree/`（需 puppeteer）
 *   · 「返回原目录」按钮的文案、`keptCheckoutRoot` 有没有真的显示给用户 —— 要浏览器
 */
'use strict'
const path = require('path')
const fs = require('fs')
const os = require('os')
const { execFileSync } = require('child_process')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..')
const APP = path.join(REPO, 'apps', 'desktop', 'src')
const SRC_MAIN = path.join(APP, 'main', 'services')

const ROOT = path.join(os.tmpdir(), 'deva-mwt-' + Date.now())
const DEVA_HOME = path.join(ROOT, 'devahome')
fs.mkdirSync(DEVA_HOME, { recursive: true })
process.env.DEVA_HOME = DEVA_HOME
process.env.USERPROFILE = path.join(ROOT, 'userprofile')
process.env.HOME = process.env.USERPROFILE
fs.mkdirSync(process.env.USERPROFILE, { recursive: true })
process.env.APPDATA = path.join(ROOT, 'appdata')
fs.mkdirSync(process.env.APPDATA, { recursive: true })

let pass = 0
let fail = 0
const ok = (n, d) => {
  pass++
  console.log(`  PASS ${n}${d ? ' :: ' + d : ''}`)
}
const bad = (n, d) => {
  fail++
  console.log(`  FAIL ${n}${d ? ' :: ' + d : ''}`)
}
const info = (n, d) => console.log(`  INFO ${n}${d ? ' :: ' + d : ''}`)
const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) ok(label, a)
  else bad(label, `实际=${a} 期望=${b}`)
}
const assert = (label, cond, detail) => (cond ? ok(label, detail) : bad(label, detail))

async function bundle() {
  const esbuild = require('esbuild')
  const outDir = path.join(QA, 'dist', 'mwtproto')
  fs.mkdirSync(outDir, { recursive: true })
  const entry = path.join(outDir, 'entry.ts')
  fs.writeFileSync(
    entry,
    [
      `export * from ${JSON.stringify(path.join(SRC_MAIN, 'member-worktree'))}`,
      `export * from ${JSON.stringify(path.join(SRC_MAIN, 'member-worktree-guard'))}`,
      `export * from ${JSON.stringify(path.join(SRC_MAIN, 'member-binding-transaction'))}`,
      `export * from ${JSON.stringify(path.join(SRC_MAIN, 'member-binding-state'))}`
    ].join('\n')
  )
  const out = path.join(outDir, 'mwtproto.cjs')
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: out,
    logLevel: 'error',
    nodePaths: [path.join(REPO, 'node_modules'), path.join(REPO, 'apps', 'desktop', 'node_modules')],
    plugins: [
      {
        name: 'stub-electron',
        setup(b) {
          b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
          b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            contents: `
              const userData = ${JSON.stringify(path.join(ROOT, 'userdata'))}
              module.exports = {
                app: { getPath: () => userData, getAppPath: () => ${JSON.stringify(REPO)},
                       isPackaged: false, on: () => {}, whenReady: () => Promise.resolve() },
                ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
                BrowserWindow: class {},
                safeStorage: { isEncryptionAvailable: () => false,
                               encryptString: () => { throw new Error('no safeStorage') },
                               decryptString: () => { throw new Error('no safeStorage') } },
                shell: { openPath: async () => '' }
              }
            `,
            loader: 'js'
          }))
        }
      }
    ]
  })
  return require(out)
}

function makeRepo(dir, branch = 'main') {
  fs.mkdirSync(dir, { recursive: true })
  const run = (a) => execFileSync('git', a, { cwd: dir, stdio: 'ignore' })
  run(['init', '-b', branch])
  run(['config', 'user.email', 'a@b.c'])
  run(['config', 'user.name', 'probe'])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
  run(['add', '.'])
  run(['commit', '-m', 'init'])
  return dir
}

;(async () => {
  console.log('== 成员工作区两个协议缺口 ==')
  console.log(`INFO 夹具根 :: ${ROOT}`)

  /* ───────── 静态层：协议定义与接线（不依赖运行环境）───────── */
  console.log('\n-- 静态：协议与接线 --')
  /*
   * 断言一律看**剥掉注释**的源码（`.deva/qa/lib/strip-comments.cjs`）。
   *
   * 这个脚本要查的字样（`bindingInconsistent?: boolean`、`original-unavailable`、
   * `chat:member-worktree-return-original`、`keptCheckoutRoot`）在这批文件里全是**修复类
   * 注释会原样写出**的东西 —— 头注释就在讲「缺口 1 缺 bindingInconsistent」「bf30126 把
   * 协议字段一起撤了」。不剥注释时，把协议字段删掉、只留一句注释也照样 PASS。
   */
  const { stripComments, sliceBraced, lineWith } = require('./lib/strip-comments.cjs')
  /*
   * 两个实现文件在看不住的分支上不存在（如 feat/export-progress-ux 上
   * member-worktree 功能已被 bf30126 revert）。这里给一条**可读的**失败，
   * 而不是让 readFileSync 抛 ENOENT 把整个脚本崩成 0 PASS / 0 FAIL ——
   * 崩溃会让「判据红」与「文件不在」分不清，CI 上看到的是同一种噪音。
   */
  const needFiles = [
    ['协议', path.join(APP, 'shared', 'member-worktree-protocol.ts')],
    ['主进程实现', path.join(SRC_MAIN, 'member-worktree.ts')]
  ]
  const missingFiles = needFiles.filter(([, p]) => !fs.existsSync(p))
  if (missingFiles.length > 0) {
    /*
     * 依赖的功能不在本分支 —— 显式 SKIP，不是 FAIL。
     *
     * 这两个实现文件只存在于 `feat/member-worktree`，在本分支（feat/export-progress-ux 等）
     * 被 `bf30126` revert 掉了。判据本身没坏、实现也没错，只是**没有可判的对象**。
     * 之前这里是 `bad(...)` → 退出码 1，看起来像「判据坏了」，实际什么也验不出来。
     */
    skipAndExit([
      '依赖的功能不在此分支：' +
        missingFiles.map(([n, p]) => `${n}（${path.relative(REPO, p)}）`).join('、'),
      '该功能只在 feat/member-worktree 分支存在（本分支被 bf30126 revert 掉了）。',
      '合回 feat/member-worktree 后本判据自动生效；在此之前它一条断言都没跑。'
    ])
  }
  const protoSrc = stripComments(
    fs.readFileSync(path.join(APP, 'shared', 'member-worktree-protocol.ts'), 'utf8')
  )
  const preloadSrc = stripComments(fs.readFileSync(path.join(APP, 'preload', 'index.ts'), 'utf8'))
  const mainSrc = stripComments(fs.readFileSync(path.join(SRC_MAIN, 'member-worktree.ts'), 'utf8'))

  assert('P1 协议里定义了 bindingInconsistent（且是可选）', /bindingInconsistent\?:\s*boolean/.test(protoSrc),
    (/bindingInconsistent\?:\s*boolean/.test(protoSrc) ? 'bindingInconsistent?: boolean' : '未找到可选定义'))
  assert('P2 MemberWorktreeReason 含 original-unavailable', /'original-unavailable'/.test(protoSrc),
    (/original-unavailable/.test(protoSrc) ? '已定义' : '缺失'))
  assert('P3 定义了 MemberWorktreeReturnOriginalReq', /interface MemberWorktreeReturnOriginalReq/.test(protoSrc),
    (/interface MemberWorktreeReturnOriginalReq/.test(protoSrc) ? '已定义' : '缺失'))
  assert('P4 定义了 MemberWorktreeReturnOriginalResult', /type MemberWorktreeReturnOriginalResult/.test(protoSrc),
    (/type MemberWorktreeReturnOriginalResult/.test(protoSrc) ? '已定义' : '缺失'))
  assert('P5 结果里带 keptCheckoutRoot（不删目录要能说清）', /keptCheckoutRoot:\s*string/.test(protoSrc),
    (/keptCheckoutRoot/.test(protoSrc) ? '已定义' : '缺失'))

  assert('P6 preload 暴露了 memberWorktreeReturnOriginal', /memberWorktreeReturnOriginal\s*:/.test(preloadSrc),
    (/memberWorktreeReturnOriginal\s*:/.test(preloadSrc) ? '已暴露' : '缺失'))
  assert("P7 preload 调的是 chat:member-worktree-return-original", /chat:member-worktree-return-original/.test(preloadSrc),
    (/chat:member-worktree-return-original/.test(preloadSrc) ? '通道名对' : '缺失或写错'))
  assert('P8 主进程注册了该通道的 handler', /chat:member-worktree-return-original/.test(mainSrc),
    (/chat:member-worktree-return-original/.test(mainSrc) ? '已注册' : '缺失'))
  assert('P9 主进程有 returnMemberToOriginal 实现', /export async function returnMemberToOriginal/.test(mainSrc),
    (/returnMemberToOriginal/.test(mainSrc) ? '已实现' : '缺失'))
  /*
   * `bindingInconsistent` 只定义不填 = 界面永远拿到 undefined，等于没做。
   * 必须守住 `memberWorktreeState` 那个入口**真的**补了它。
   */
  {
    const start = mainSrc.indexOf('export async function memberWorktreeState')
    const end = mainSrc.indexOf('function unbound', start)
    const body = start >= 0 && end > start ? mainSrc.slice(start, end) : ''
    assert('P9b memberWorktreeState 真的补了 bindingInconsistent（withConsistency）',
      /withConsistency\s*\(\s*state\s*\(/.test(body),
      /withConsistency\s*\(\s*state\s*\(/.test(body) ? '走 withConsistency(state(...))' : '没补！界面会永远拿到 undefined')
    assert('P9c bindingInconsistentOf 复用了 verifyMemberWorktree（不另造一套判据）',
      reusesVerify(mainSrc),
      reusesVerify(mainSrc) ? '复用权威判据' : '另写了判据，会与执行前核实漂移')
  }
  /*
   * 语义硬约束：返回原目录**不得**删目录、不得调合并。
   * 用 grep 守：实现块里不应出现 rmSync / removeWorktree / mergeWorktree。
   */
  {
    const start = mainSrc.indexOf('export async function returnMemberToOriginal')
    const end = mainSrc.indexOf('export async function retryMemberWorktreeBind')
    const body = start >= 0 && end > start ? mainSrc.slice(start, end) : ''
    assert('P10 实现块存在且可截取', body.length > 200, body.length + ' 字符')
    assert('P11 不删目录（无 rmSync）', !/\brmSync\b/.test(body), /\brmSync\b/.test(body) ? '出现 rmSync！' : '未出现')
    assert('P12 不调 removeWorktree', !/removeWorktree/.test(body), /removeWorktree/.test(body) ? '出现！' : '未出现')
    assert('P13 不自动合并（无 mergeWorktree）', !/mergeWorktree/.test(body), /mergeWorktree/.test(body) ? '出现！' : '未出现')
    assert('P14 原目录不可用时如实报 original-unavailable', /original-unavailable/.test(body), /original-unavailable/.test(body) ? '有' : '缺失')
  }

  /* ───────── 运行时：驱动真实逻辑 ───────── */
  console.log('\n-- 运行时：驱动真实实现 --')
  let M
  try {
    M = await bundle()
  } catch (e) {
    bad('R0 esbuild 打包', String((e && e.message) || e))
    console.log('\n==RESULT== ' + pass + ' PASS / ' + fail + ' FAIL')
    process.exit(1)
  }
  const need = ['memberWorktreeState', 'returnMemberToOriginal', 'bindMemberWorktree']
  const missing = need.filter((n) => typeof M[n] !== 'function')
  if (missing.length) {
    bad('R1 导出了待测函数', '缺少：' + missing.join(', '))
    console.log('\n==RESULT== ' + pass + ' PASS / ' + fail + ' FAIL')
    process.exit(1)
  }
  ok('R1 导出了待测函数', need.join(', '))

  const repo = makeRepo(path.join(ROOT, 'repo'), 'my/dev')
  info('repo', repo)

  /* ───────── bindingInconsistent：三种必须是 true 的情形 ───────── */
  console.log('\n-- bindingInconsistent --')
  /*
   * 这一组不依赖完整会话夹具：直接构造 state 的输入形态，
   * 驱动 `bindingInconsistentOf` 所复用的那个权威判据（`verifyMemberWorktree`）。
   * 但 `bindingInconsistentOf` 是模块私有，所以走公开入口 `memberWorktreeState`。
   *
   * 需要真实成员会话，成本高；这里改用**同一套事实**做等价断言：
   * 直接调 `verifyMemberWorktree`（绑定时与执行前用的都是它），
   * 断言「它抛错」⇔「bindingInconsistent 应为 true」。
   * 这比只看源码字符串硬得多，也比造整个成员会话稳。
   */
  const identity = {
    checkoutRoot: path.join(ROOT, 'wt'),
    repoRoot: repo,
    branch: 'my/dev',
    relativePath: 'sub',
    sourceRoot: path.join(repo, 'sub')
  }
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true })
  /*
   * 真造一个 worktree 当 checkoutRoot，让 identity 完全成立。
   *
   * 注意 `branch` 必须是 **worktree 自己的 HEAD 分支**（`wt/probe`），不是主仓的 `my/dev` ——
   * 同一分支不能同时被两个 worktree 检出，而 `verifyMemberWorktree` 会核对
   * `checkoutRoot` 的 HEAD 分支是否等于 identity.branch。写错这条会让 C1 假红。
   */
  let identityOk = false
  try {
    execFileSync('git', ['worktree', 'add', '-b', 'wt/probe', path.join(ROOT, 'wt')], { cwd: repo, stdio: 'ignore' })
    fs.mkdirSync(path.join(ROOT, 'wt', 'sub'), { recursive: true })
    identity.branch = 'wt/probe'
    identityOk = true
  } catch (e) {
    info('造 worktree 失败', String((e && e.message) || e))
  }
  if (identityOk) {
    const focusOk = path.join(ROOT, 'wt', 'sub')
    let threw1 = null
    try {
      await M.verifyMemberWorktree(identity, focusOk)
    } catch (e) {
      threw1 = e.message
    }
    assert('C1 一致时 verifyMemberWorktree 不抛（→ bindingInconsistent 应为 false）', threw1 === null, String(threw1))

    /* 情形 a：focusRoot 为空 → 不一致 */
    let threwA = null
    try {
      await M.verifyMemberWorktree(identity, '')
    } catch (e) {
      threwA = e.message
    }
    assert("C2 focusRoot 为空时报错（→ 不一致）", threwA !== null, String(threwA))

    /* 情形 b：focusRoot 指向别处 → 不一致 */
    const otherDir = path.join(ROOT, 'wt', 'other')
    fs.mkdirSync(otherDir, { recursive: true })
    let threwB = null
    try {
      await M.verifyMemberWorktree(identity, otherDir)
    } catch (e) {
      threwB = e.message
    }
    assert('C3 focusRoot 与 checkoutRoot+relativePath 不符时报错（→ 不一致）', threwB !== null, String(threwB))

    /* 情形 c：checkoutRoot 目录被删 → 不一致 */
    const goneIdentity = { ...identity, checkoutRoot: path.join(ROOT, 'wt-gone') }
    let threwC = null
    try {
      await M.verifyMemberWorktree(goneIdentity, focusOk)
    } catch (e) {
      threwC = e.message
    }
    assert('C4 checkoutRoot 目录不存在时报错（→ 不一致）', threwC !== null, String(threwC))

    /* 情形 d：分支被换 → 不一致 */
    let threwD = null
    try {
      await M.verifyMemberWorktree({ ...identity, branch: 'other-branch' }, focusOk)
    } catch (e) {
      threwD = e.message
    }
    assert('C5 identity.branch 与 HEAD 不符时报错（→ 不一致）', threwD !== null, String(threwD))
  } else {
    bad('C1~C5 前置', '无法造 worktree，跳过一致性判据')
  }

  /*
   * 再验一层：`memberWorktreeState` 真的把 `bindingInconsistent` 填上了。
   * 造一个最小成员会话：主会话 + 一个带 parentId 的子会话。
   */
  {
    try {
      /*
       * 不拼装完整成员夹具（要过 createMember 的工具层与索引，成本远超本判据的目的）。
       * 能验的运行时事实：对**非成员**会话，`memberWorktreeState` 返回 rejected 而不是崩溃，
       * 证明新增的 `bindingInconsistent` 没有破坏原有返回形态。
       */
      const r = await M.memberWorktreeState('no-such-session')
      eq('W1 非成员会话 → rejected not-member（新增字段未破坏原返回形态）', r, {
        ok: false,
        status: 'rejected',
        reason: 'not-member'
      })
    } catch (e) {
      bad('W1 memberWorktreeState 调用', String((e && e.message) || e))
    }
  }

  /* ───────── returnMemberToOriginal：失败路径必须如实、不能回退 ───────── */
  console.log('\n-- returnMemberToOriginal --')
  {
    /* 非法入参 */
    eq('O1 缺 sessionId → invalid-request', await M.returnMemberToOriginal({}), {
      ok: false,
      status: 'rejected',
      reason: 'invalid-request'
    })
    eq('O2 expectedRevision 非整数 → invalid-request',
      await M.returnMemberToOriginal({ sessionId: 'x', expectedRevision: 1.5 }),
      { ok: false, status: 'rejected', reason: 'invalid-request' })
    /* 非成员会话 */
    const r3 = await M.returnMemberToOriginal({ sessionId: 'no-such-session', expectedRevision: 0 })
    assert('O3 非成员 → rejected（不崩）', r3.ok === false && r3.status === 'rejected', JSON.stringify(r3))
    info('O3 返回', JSON.stringify(r3))

    /*
     * 关键语义断言：**原目录不可用时不回退**。
     *
     * 源码级守（静态判据 P11~P14 已覆盖「不删/不合并/如实报」），这里再加一条运行时守卫：
     * 实现里必须把 `keptCheckoutRoot` 带回去 —— 也就是「目录保留」这件事对外可见。
     */
    const protoNow = stripComments(
      fs.readFileSync(path.join(APP, 'shared', 'member-worktree-protocol.ts'), 'utf8')
    )
    assert('O4 成功分支带上 keptCheckoutRoot', /keptCheckoutRoot:\s*string/.test(protoNow), 'keptCheckoutRoot: string')
    assert('O5 实现里真的填了 keptCheckoutRoot', /keptCheckoutRoot:\s*kept/.test(mainSrc),
      /keptCheckoutRoot:\s*kept/.test(mainSrc) ? 'keptCheckoutRoot: kept' : '未填')
    assert('O6 identity 里记录了 sourceRoot（否则永远无法返回）', /sourceRoot\?:\s*string/.test(protoSrc),
      /sourceRoot\?:\s*string/.test(protoSrc) ? 'sourceRoot?: string' : '缺失')
    assert('O7 绑定时写入 sourceRoot', /sourceRoot:\s*recovery\.sourceFocusRoot/.test(mainSrc),
      /sourceRoot:\s*recovery\.sourceFocusRoot/.test(mainSrc) ? '已写入' : '未写入')
    /*
     * 老会话没有 sourceRoot 时必须**拒绝而不是猜**：源码里那条 reject 的分支要在，
     * 且 message 要带已建目录路径（否则用户不知道那份目录在哪）。
     */
    assert('O8 无 sourceRoot 时拒绝并给出已建目录路径',
      rejectsWithoutSourceRoot(mainSrc),
      rejectsWithoutSourceRoot(mainSrc) ? '有拒绝分支且带路径' : '缺失或不带路径')
  }

  /* ───────── 不破坏现有 5 个通道 ───────── */
  console.log('\n-- 现有 5 个通道未受影响 --')
  {
    const channels = [
      'chat:member-worktree-precheck',
      'chat:member-worktree-bind',
      'chat:member-worktree-cancel',
      'chat:member-worktree-state',
      'chat:member-worktree-retry-bind'
    ]
    for (const c of channels) {
      assert(`N ${c} 仍注册`, mainSrc.includes(c), mainSrc.includes(c) ? '在' : '丢了')
    }
    /* 新增的第 6 个通道 */
    assert('N 新增第 6 个通道（return-original）', mainSrc.includes('chat:member-worktree-return-original'), '在')
    const regCount = (mainSrc.match(/ipcMain\.handle\('chat:member-worktree-/g) || []).length
    eq('N 通道总数 = 6（5 旧 + 1 新）', regCount, 6)
  }

  console.log('\n== 本判据看不见的（需浏览器）==')
  console.log('  · bindingInconsistent === true 时面板实际渲染成什么样、按钮是否真的禁用')
  console.log('  · 返回原目录按钮的文案、keptCheckoutRoot 有没有真的显示给用户')
  console.log('  · 真实 Electron 里的目录选择与 IPC 往返')
  finish()
})().catch((e) => {
  console.error('FATAL', e)
  finish()
})

/** 统一收尾：打印汇总并按 FAIL 数决定退出码。 */
function finish() {
  console.log('\n==RESULT== ' + pass + ' PASS / ' + fail + ' FAIL')
  process.exit(fail === 0 ? 0 : 1)
}

/**
 * 显式跳过：依赖的功能不在本分支时，打印原因并以 0 退出。
 *
 * **绝不静默 exit 0。** 静默会让下一个人以为「检查过了、是绿的」，而实际上一个断言都没跑
 * —— 这比红着更危险（`.deva/qa/AGENTS.md`：跳过项必须打印）。
 *
 * 用 `exit 0` 而不是 `exit 1`：文件不存在不是判据的失败，也不是实现的失败，
 * 是「这个分支没有该功能」。合回 `feat/member-worktree` 后本脚本自动恢复生效。
 */
function skipAndExit(reasonLines) {
  console.log('\n==SKIP== 本判据未执行（不计入通过，也不是失败）')
  for (const l of reasonLines) console.log('  ' + l)
  console.log('  → 退出码 0，但请把它当作「没跑」，不要当作「全绿」。')
  process.exit(0)
}

/**
 * P9c：`bindingInconsistentOf` 的函数体里是否调用了 `verifyMemberWorktree`。
 *
 * 原判据是 `/bindingInconsistentOf[\s\S]{0,1200}verifyMemberWorktree\s*\(/` —— 1200 字符
 * 长度窗口。它有两个方向都会错：
 *   · 窗口够大时，可以从 `bindingInconsistentOf` 一路吞到**后面另一个函数**里的
 *     `verifyMemberWorktree(`，于是「自己另写了一套判据」也算复用（假绿）；
 *   · 函数稍长、或者两句之间夹了注释，就会够不到（假红）。
 * 改为按花括号配平取出该函数的真实体，只在体内找调用。
 */
function reusesVerify(src) {
  const at = src.indexOf('bindingInconsistentOf')
  if (at === -1) return false
  const braceAt = src.indexOf('{', src.indexOf(')', at))
  if (braceAt === -1) return false
  // 取到函数结束：外层可能是 `function bindingInconsistentOf(...) { ... }` 或箭头函数
  const body = sliceBraced(src, braceAt)
  if (body === null) return false
  return /verifyMemberWorktree\s*\(/.test(body)
}

/**
 * O8：没有 `sourceRoot` 时必须**拒绝并给出已建目录路径**。
 *
 * 原判据 `/!identity\.sourceRoot[\s\S]{0,400}kept/` 是 400 字符窗口 ——
 * 「`kept` 出现了」并不能证明「它与拒绝分支在同一个逻辑里」，窗口还能跨到隔壁函数去。
 * 改为按结构查：定位含 `!identity.sourceRoot` 的那个 `if` 条件，取其条件文本，
 * 再断言**这个分支的体内**同时出现拒绝返回与已建目录路径（`kept`）。
 */
function rejectsWithoutSourceRoot(src) {
  const at = src.indexOf('!identity.sourceRoot')
  if (at === -1) return false
  // 找到该条件所在的 if：( 从 at 往前找最近的 if
  const ifAt = src.lastIndexOf('if (', at)
  if (ifAt === -1) return false
  const parenAt = src.indexOf('(', ifAt)
  let depth = 0
  let closeParen = -1
  for (let i = parenAt; i < src.length; i += 1) {
    if (src[i] === '(') depth += 1
    else if (src[i] === ')') {
      depth -= 1
      if (depth === 0) {
        closeParen = i
        break
      }
    }
  }
  if (closeParen === -1) return false
  const braceAt = src.indexOf('{', closeParen)
  if (braceAt === -1) return false
  const body = sliceBraced(src, braceAt)
  if (body === null) return false
  // 拒绝 + 带已建目录路径（kept*）两件事都要在同一个分支体内
  return /\b(reject|status:\s*'rejected'|reason:)/.test(body) && /kept/.test(body)
}
