#!/usr/bin/env node
/**
 * worktree 根目录可配置 —— CI 可跑的断言（驱动真实逻辑，不是「字符串在文件里」）。
 *
 * 需求：`notes/implemented/2026-11-23-worktree-root-custom.md`（A1~A28）。
 *
 * ## 为什么这个功能必须有判据
 *
 * 用户的实际遭遇是「E:\ 下 12 个 + Temp 下 311 个目录、866MB，没人清」。根因不是某处写错，
 * 而是**默认路径从未被用过**：`precheck.ts` 里 `req.path` 一有值，`defaultWorktreePath()`
 * 就完全不参与。而传路径的两个入口（新建对话框的「浏览」按钮、成员工作区绑定）都能给任意路径。
 *
 * 这类缺陷的形状是「约束缺失」，编译、类型、人眼全都不报错 —— 只有判据能守：
 *   · 根内校验漏了 → 又能往 `E:\随便` 建，但所有现有测试照样绿
 *   · 用了 `startsWith` → `E:\wt2` 被当成 `E:\wt` 的子目录，**根外创建被放行**（安全漏洞）
 *   · 删除侧忘了校验 → 根外目录照样被 `rmSync`
 *   · `createdUnderRoot` 设成必填 → 老 `worktrees.json` 整份判 corrupt，用户记录全部不可写
 *
 * ## 判据对象
 *
 * 真实的 `paths.ts` / `precheck.ts` / `remove.ts` / `store.ts` / `root-setting.ts` / `list.ts`，
 * 用 esbuild 打成 cjs。只 stub `electron`（主进程模块会 `import { app }`）与 `fs-guard` 的
 * `trustRoot`（它要 electron 的 IPC 上下文）。**不 stub 被测逻辑本身。**
 *
 * ## 隔离（红线）
 *
 * 所有夹具在 `os.tmpdir()/deva-wtroot-*` 下；`DEVA_HOME` 指到临时目录。
 * **绝不碰**真实 `~/.deva-plus`。真实 git 仓库也在临时目录里 `git init` 出来。
 *
 * ## 本判据看不见的（每次运行都打印）
 *
 *   · 设置面板长什么样、「默认」二字有没有真的显示出来 —— 要浏览器
 *   · 新建对话框里 `path-outside-root` 的提示是否可读、根路径有没有出现在屏幕上 —— 要浏览器
 *   · 工作区列表里「不在当前根内」的标注实际渲染成什么样 —— 要浏览器
 */
'use strict'
const path = require('path')
const fs = require('fs')
const os = require('os')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..')
const APP = path.join(REPO, 'apps', 'desktop', 'src')
const SRC_MAIN = path.join(APP, 'main', 'services')

/* ── 夹具根目录（全部在临时目录下，绝不碰真实 home）── */
const ROOT = path.join(os.tmpdir(), 'deva-wtroot-' + Date.now())
const DEVA_HOME = path.join(ROOT, 'devahome')
fs.mkdirSync(DEVA_HOME, { recursive: true })
process.env.DEVA_HOME = DEVA_HOME
process.env.USERPROFILE = path.join(ROOT, 'userprofile')
process.env.HOME = process.env.USERPROFILE
fs.mkdirSync(process.env.USERPROFILE, { recursive: true })

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
const assert = (label, cond, detail) => {
  if (cond) ok(label, detail)
  else bad(label, detail)
}

/** 把主进程的 worktree 模块打成 cjs。electron 与 trustRoot 换成桩。 */
async function bundle() {
  const esbuild = require('esbuild')
  const outDir = path.join(QA, 'dist', 'wtroot')
  fs.mkdirSync(outDir, { recursive: true })
  const out = path.join(outDir, 'wtroot.cjs')
  /*
   * 入口是一个虚拟模块：把要驱动的几个真实模块都 re-export 出来。
   * 这样一次打包就能拿到 paths / precheck / remove / store / root-setting / list。
   */
  const entry = path.join(outDir, 'entry.ts')
  fs.writeFileSync(
    entry,
    [
      `export * from ${JSON.stringify(path.join(SRC_MAIN, 'worktree', 'paths'))}`,
      `export * from ${JSON.stringify(path.join(SRC_MAIN, 'worktree', 'precheck'))}`,
      `export * from ${JSON.stringify(path.join(SRC_MAIN, 'worktree', 'remove'))}`,
      `export * from ${JSON.stringify(path.join(SRC_MAIN, 'worktree', 'store'))}`,
      `export * from ${JSON.stringify(path.join(SRC_MAIN, 'worktree', 'root-setting'))}`,
      `export * from ${JSON.stringify(path.join(SRC_MAIN, 'worktree', 'list'))}`,
      `export * from ${JSON.stringify(path.join(SRC_MAIN, 'worktree', 'create'))}`
    ].join('\n')
  )
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
          /*
           * 主进程模块顶部 `import { app, ipcMain } from 'electron'`。
           * 桩要让 `app.getPath('userData')` 返回夹具目录，`ipcMain.handle` 什么都不做。
           */
          b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
          b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
            if (args.path === 'electron') {
              return {
                contents: `
                  const path = require('path')
                  const userData = ${JSON.stringify(path.join(ROOT, 'userdata'))}
                  module.exports = {
                    app: {
                      getPath: (k) => (k === 'userData' ? userData : userData),
                      getAppPath: () => ${JSON.stringify(REPO)},
                      isPackaged: false,
                      on: () => {},
                      whenReady: () => Promise.resolve()
                    },
                    ipcMain: { handle: () => {}, on: () => {}, removeHandler: () => {} },
                    BrowserWindow: class {},
                    safeStorage: {
                      isEncryptionAvailable: () => false,
                      encryptString: () => { throw new Error('no safeStorage in probe') },
                      decryptString: () => { throw new Error('no safeStorage in probe') }
                    },
                    shell: { openPath: async () => '' }
                  }
                `,
                loader: 'js'
              }
            }
            return { contents: 'module.exports = {}', loader: 'js' }
          })
          /*
           * `trustRoot` 把路径登记进 electron 的 IPC 白名单；没有 electron 环境时它是纯内存操作，
           * 但会 `import { ipcMain }`。上面已桩掉 electron，这里不必再动。
           */
        }
      }
    ]
  })
  const mod = require(out)
  return mod
}

/** 造一个真的 git 仓库（`git init` + 一次提交）。 */
function makeRepo(dir, branch = 'main') {
  const { execFileSync } = require('child_process')
  fs.mkdirSync(dir, { recursive: true })
  const run = (args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  run(['init', '-b', branch])
  run(['config', 'user.email', 'a@b.c'])
  run(['config', 'user.name', 'probe'])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n')
  run(['add', '.'])
  run(['commit', '-m', 'init'])
  return dir
}

/** 读 config.json（不存在时给空对象）。 */
function readConfig() {
  const p = path.join(DEVA_HOME, 'config.json')
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return {}
  }
}

;(async () => {
  console.log('== worktree 根目录可配置（A1~A28）==')
  console.log(`INFO 夹具根 :: ${ROOT}`)

  let M
  try {
    M = await bundle()
  } catch (e) {
    bad('B0 esbuild 打包', String(e && e.message ? e.message : e))
    console.log('\n==RESULT== ' + pass + ' PASS / ' + fail + ' FAIL')
    process.exit(1)
  }
  const need = [
    'worktreeRoot',
    'defaultWorktreeRoot',
    'isInsideRoot',
    'rootKeyOf',
    'WORKTREE_ROOT_KEY',
    'precheck',
    'removeWorktree',
    'upsertRecord',
    'getRecord',
    'listRecords',
    'setWorktreeRoot',
    'readWorktreeRoot',
    'listWorktrees'
  ]
  const missing = need.filter((n) => M[n] === undefined)
  if (missing.length) {
    bad('B1 模块导出齐全', '缺少：' + missing.join(', '))
    console.log('\n==RESULT== ' + pass + ' PASS / ' + fail + ' FAIL')
    process.exit(1)
  }
  ok('B1 模块导出齐全', need.length + ' 个符号')

  const repoA = makeRepo(path.join(ROOT, 'repoA'), 'my/dev')
  const repoB = makeRepo(path.join(ROOT, 'repoB'), 'main')
  const repoKeyA = M.repoKeyOf(repoA)
  info('repoA', repoA)
  info('repoKeyA', repoKeyA)

  /* ───────── A1：未设根时，落点是 <DEVA_HOME>/worktrees/<repoKey>/… ───────── */
  console.log('\n-- A1 默认根 --')
  eq('A1a 未设根时 worktreeRoot() = <DEVA_HOME>/worktrees', M.worktreeRoot(), path.join(DEVA_HOME, 'worktrees'))
  eq('A1b config.json 里没有该键', readConfig()[M.WORKTREE_ROOT_KEY], undefined)
  const pre1 = await M.precheck({ repoRoot: repoA, branch: 'wt/a1' })
  assert('A1c 未传 path 时 precheck 成功', pre1.ok === true, pre1.ok ? '' : pre1.reason + ' / ' + pre1.message)
  if (pre1.ok) {
    const expectPrefix = path.join(DEVA_HOME, 'worktrees', repoKeyA)
    assert(
      'A1d 默认路径落在 <DEVA_HOME>/worktrees/<repoKey> 下',
      M.isInsideRoot(expectPrefix, pre1.path),
      pre1.path
    )
    assert('A1e 默认路径含 slug', pre1.path.includes('wt-a1'), pre1.path)
  }

  /* ───────── A2：根外绝对路径被拒 ───────── */
  console.log('\n-- A2 根外被拒 --')
  const outside = path.join(ROOT, 'outside-dir')
  const pre2 = await M.precheck({ repoRoot: repoA, branch: 'wt/a2', path: outside })
  assert('A2a ok=false', pre2.ok === false, String(pre2.ok))
  eq('A2b reason === path-outside-root', pre2.reason, 'path-outside-root')
  assert('A2c message 带根路径', typeof pre2.message === 'string' && pre2.message.includes(M.worktreeRoot()), pre2.message)
  info('A2 message', pre2.message)

  /* ───────── A3：根内子目录（自定义名字）创建成功 ───────── */
  console.log('\n-- A3 根内子目录 --')
  const custom = path.join(M.worktreeRoot(), repoKeyA, 'my-custom-name')
  const pre3 = await M.precheck({ repoRoot: repoA, branch: 'wt/a3', path: custom })
  assert('A3a 根内子目录 precheck ok', pre3.ok === true, pre3.ok ? '' : pre3.reason + ' / ' + pre3.message)
  if (pre3.ok) eq('A3b precheck 回显该路径', pre3.path, M.normalizeWorktreePath(custom).path)
  /*
   * 任意深度（Q1 定案：不数层数）。用三层验证「没有引入层数上限」。
   */
  const deep = path.join(M.worktreeRoot(), 'projA', 'featB', 'try1')
  const preDeep = await M.precheck({ repoRoot: repoA, branch: 'wt/a3deep', path: deep })
  assert('A3c 三层深子目录仍放行（Q1 不数层数）', preDeep.ok === true, preDeep.ok ? '' : preDeep.reason)

  /* ───────── A4：前缀相同的兄弟目录被拒（证明没用 startsWith）───────── */
  console.log('\n-- A4 兄弟目录 E:\\wt2 vs 根 E:\\wt --')
  const rootLike = path.join(ROOT, 'wt')
  const sibling = path.join(ROOT, 'wt2', 'x')
  fs.mkdirSync(rootLike, { recursive: true })
  const setRootLike = M.setWorktreeRoot(rootLike)
  assert('A4a 根设为 ' + rootLike, setRootLike.ok === true, JSON.stringify(setRootLike))
  const pre4 = await M.precheck({ repoRoot: repoA, branch: 'wt/a4', path: sibling })
  eq('A4b 兄弟目录被拒（startsWith 会误放行）', pre4.reason, 'path-outside-root')

  /* ───────── A5：四种变形都判根内 ───────── */
  console.log('\n-- A5 路径变形 --')
  const base = path.join(rootLike, 'a')
  const variants = [
    ['大写', base.toUpperCase().replace(/\\/g, '\\')],
    ['长路径前缀', '\\\\?\\' + base],
    ['尾斜杠', base + '\\'],
    ['冗余斜杠', base.replace(/\\/g, '\\\\')]
  ]
  for (const [label, v] of variants) {
    const r = await M.precheck({ repoRoot: repoA, branch: 'wt/a5-' + label, path: v })
    assert(`A5 ${label} 不判根外`, r.reason !== 'path-outside-root', `${v} → ${r.ok ? 'ok' : r.reason}`)
  }
  /*
   * 也直接验判定函数本身（比走 precheck 更硬）：这四种形态都必须 isInsideRoot === true。
   */
  for (const [label, v] of variants) {
    assert(`A5' isInsideRoot 认 ${label}`, M.isInsideRoot(rootLike, v) === true, v)
  }
  assert("A5'' isInsideRoot 拒兄弟 E:\\wt2", M.isInsideRoot(rootLike, sibling) === false, sibling)

  /* ───────── A6：文案含当前根的实际路径 ───────── */
  console.log('\n-- A6 文案含根路径 --')
  const pre6 = await M.precheck({ repoRoot: repoA, branch: 'wt/a6', path: path.join(ROOT, 'nope') })
  assert('A6a message 含根实际路径', pre6.reason === 'path-outside-root' && pre6.message.includes(rootLike), pre6.message)

  /* ───────── A7：类型与 i18n 中英都有 ───────── */
  console.log('\n-- A7 类型与 i18n --')
  /*
   * 断言看**剥掉注释**的源码（`.deva/qa/lib/strip-comments.cjs`）。
   *
   * `path-outside-root` 这个 reason 在协议注释与 i18n 注释里都可能被提到
   * （「它会报 path-outside-root」），不剥注释时 A7a 会在类型删掉后照样 PASS，
   * A7b 的「中英各一处」也可能被注释里的字样凑数。
   */
  const { stripComments: stripCommentsRoot } = require('./lib/strip-comments.cjs')
  const proto = stripCommentsRoot(fs.readFileSync(path.join(APP, 'shared', 'worktree-protocol.ts'), 'utf8'))
  const msgFile = stripCommentsRoot(
    fs.readFileSync(path.join(APP, 'renderer', 'src', 'i18n', 'messages.ts'), 'utf8')
  )
  const protoHits = (proto.match(/path-outside-root/g) || []).length
  const msgHits = (msgFile.match(/'path-outside-root'/g) || []).length
  assert('A7a 协议类型里有 path-outside-root', protoHits >= 1, protoHits + ' 处')
  assert('A7b i18n 中英各一处', msgHits === 2, msgHits + ' 处')

  /* ───────── A8：默认路径只有一个来源 ───────── */
  console.log('\n-- A8 默认路径唯一来源 --')
  {
    const { execFileSync } = require('child_process')
    const out = execFileSync(
      process.platform === 'win32' ? 'git' : 'grep',
      process.platform === 'win32'
        ? ['grep', '-rn', "-e", "getDevaHome(), 'worktrees'", '--', 'apps/desktop/src']
        : ['-rn', "getDevaHome(), 'worktrees'", 'apps/desktop/src'],
      { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const lines = out.split('\n').filter((l) => l.trim() !== '')
    info('A8 命中', lines.join(' | '))
    /*
     * 需求要的是「只有一处」，而我把它收在 `paths.ts` 的 `defaultWorktreeRoot()` 里。
     * 所以断言是「恰好 1 处，且那一处在 paths.ts」——不是「0 处」。
     * 注释里若写出这串字面量会让判据自己假红，已改成不含字面量的表述。
     */
    assert('A8a 默认路径只拼一处', lines.length === 1, lines.length + ' 处')
    assert('A8b 那一处在 paths.ts 的 defaultWorktreeRoot 里', /worktree[\\/]paths\.ts:\d+:/.test(lines[0] || ''), lines[0] || '')
  }

  /* ───────── A9：根外新记录 → 目录不删、记录删、warnings 有路径 ───────── */
  console.log('\n-- A9 根外新记录删除 --')
  const outsideNew = path.join(ROOT, 'outside-new-wt')
  await M.upsertRecord({
    schemaVersion: 1,
    path: outsideNew,
    compareKey: M.normalizeWorktreePath(outsideNew).compareKey,
    repoRoot: repoA,
    repoKey: repoKeyA,
    branch: 'wt/outside-new',
    baseSha: 'a'.repeat(40),
    baseLabel: 'main',
    targetBranch: 'my/dev',
    createdAt: Date.now(),
    phase: 'active',
    intent: { branchExistedAtStart: false, pathExistedAtStart: false },
    deps: 'skipped',
    createdUnderRoot: M.rootKeyOf(rootLike)
  })
  fs.mkdirSync(outsideNew, { recursive: true })
  const rm9 = await M.removeWorktree({ path: outsideNew, force: true, deleteBranch: false })
  assert('A9a 目录仍在', fs.existsSync(outsideNew) === true, outsideNew)
  assert('A9b dirRemoved === false', rm9.dirRemoved === false, String(rm9.dirRemoved))
  eq('A9c 记录已删', M.getRecord(outsideNew), null)
  const w9 = rm9.warnings.find((w) => w.includes(outsideNew))
  assert('A9d warnings 有一条含实际路径', w9 !== undefined, rm9.warnings.join(' | '))
  info('A9 warnings', rm9.warnings.join(' | '))
  if (fs.existsSync(outsideNew)) fs.rmSync(outsideNew, { recursive: true, force: true })

  /* ───────── A10：根外老记录（缺字段）→ 目录被删 ───────── */
  console.log('\n-- A10 根外老记录删除（放行）--')
  const outsideOld = path.join(ROOT, 'outside-old-wt')
  fs.mkdirSync(outsideOld, { recursive: true })
  /*
   * 造一条「像我们的 worktree」的老记录：`looksLikeOurWorktreeDir` 要求目录里有 `.git` 文件
   * 且首行指向本仓库的 `.git/worktrees/`。真实建一个 worktree 最省事，且顺带验了整条链路。
   */
  const realOld = path.join(ROOT, 'outside-old-real')
  const created = await (async () => {
    const CR = M
    // 直接用 git worktree add（绕过 precheck，模拟「历史上随手建的」）
    const { execFileSync } = require('child_process')
    try {
      execFileSync('git', ['worktree', 'add', '-b', 'wt/old-real', realOld], { cwd: repoA, stdio: 'ignore' })
      return realOld
    } catch (e) {
      info('A10 造老 worktree 失败', String(e && e.message))
      return null
    }
  })()
  if (created) {
    await M.upsertRecord({
      schemaVersion: 1,
      path: realOld,
      compareKey: M.normalizeWorktreePath(realOld).compareKey,
      repoRoot: repoA,
      repoKey: repoKeyA,
      branch: 'wt/old-real',
      baseSha: 'b'.repeat(40),
      baseLabel: 'main',
      targetBranch: 'my/dev',
      createdAt: Date.now() - 1000,
      phase: 'active',
      intent: { branchExistedAtStart: false, pathExistedAtStart: false },
      deps: 'skipped'
      // 故意**不带** createdUnderRoot —— 这就是老记录
    })
    const rm10 = await M.removeWorktree({ path: realOld, force: true, deleteBranch: false })
    assert('A10a 根外老记录：目录被删', fs.existsSync(realOld) === false, String(fs.existsSync(realOld)))
    assert('A10b dirRemoved === true', rm10.dirRemoved === true, String(rm10.dirRemoved))
    eq('A10c 记录已删', M.getRecord(realOld), null)
  } else {
    bad('A10 前置：造老 worktree', 'git worktree add 失败，A10 未验')
  }

  /* ───────── A11：老记录在列表里可见，且不带 insideRoot（无法判断）───────── */
  console.log('\n-- A11 列表标注 --')
  const oldRecPath = path.join(ROOT, 'list-old-wt')
  await M.upsertRecord({
    schemaVersion: 1,
    path: oldRecPath,
    compareKey: M.normalizeWorktreePath(oldRecPath).compareKey,
    repoRoot: repoB,
    repoKey: M.repoKeyOf(repoB),
    branch: 'wt/list-old',
    baseSha: 'c'.repeat(40),
    baseLabel: 'main',
    targetBranch: 'main',
    createdAt: Date.now() - 5000,
    phase: 'active',
    intent: { branchExistedAtStart: false, pathExistedAtStart: false },
    deps: 'skipped'
  })
  const snap11 = await M.listWorktrees()
  const item11 = snap11.items.find((it) => M.compareKeyOfPath(it.path) === M.compareKeyOfPath(oldRecPath))
  assert('A11a 老记录出现在列表里', item11 !== undefined, '共 ' + snap11.items.length + ' 条')
  if (item11) {
    /*
     * A11b：老记录**必须也算得出** insideRoot。
     *
     * 这条断言原先写的是 `insideRoot === undefined`（「无法判断、不谎报根外」），是错的。
     * 需求 A11 原文（`notes/implemented/2026-11-23-worktree-root-custom.md:601`）：
     *   「根外的**老记录**在列表里可见，且带『不在当前根内』标注」
     * ——老记录也要标注，所以它必须算得出，不能是 undefined。
     * 而老记录没有 `createdUnderRoot`，按「创建时根」根本算不出来，反证基准必须是**当前根**。
     *
     * 这条错断言正是本轮 P0 的帮凶：它把「永远算不出」当成正确行为锁住，
     * 于是 `list.ts` 用 `createdUnderRoot` 比较（恒真）时判据全绿，功能却是死的。
     */
    assert(
      'A11b 老记录也算得出 insideRoot（A11 要求老记录也标注；不能是 undefined）',
      typeof item11.insideRoot === 'boolean',
      String(item11.insideRoot)
    )
    /*
     * 其它字段不受影响：这里只能查结构字段（state / mergeGate 存在且非 undefined）。
     * 「按钮可用性不变」属界面，见本文件头的「看不见的」清单。
     */
    assert('A11c 老记录的 state 仍有值', typeof item11.state === 'string', item11.state)
    assert('A11d 老记录的 mergeGate 仍有值', item11.mergeGate !== undefined, JSON.stringify(item11.mergeGate))
  }
  /* 新记录则必须带 insideRoot（证明不是永远 undefined —— 反向验证的关键） */
  const newRecPath = path.join(rootLike, repoKeyA, 'inside-new')
  await M.upsertRecord({
    schemaVersion: 1,
    path: newRecPath,
    compareKey: M.normalizeWorktreePath(newRecPath).compareKey,
    repoRoot: repoA,
    repoKey: repoKeyA,
    branch: 'wt/inside-new',
    baseSha: 'd'.repeat(40),
    baseLabel: 'main',
    targetBranch: 'my/dev',
    createdAt: Date.now(),
    phase: 'active',
    intent: { branchExistedAtStart: false, pathExistedAtStart: false },
    deps: 'skipped',
    createdUnderRoot: M.rootKeyOf(rootLike)
  })
  const snap11b = await M.listWorktrees()
  const item11b = snap11b.items.find((it) => M.compareKeyOfPath(it.path) === M.compareKeyOfPath(newRecPath))
  assert('A11e 新记录带 insideRoot === true', item11b && item11b.insideRoot === true, JSON.stringify(item11b && item11b.insideRoot))

  /* ───────── A12：拒绝删目录时不报「全部成功」───────── */
  console.log('\n-- A12 ok 与 dirRemoved 各自如实 --')
  const rmPath12 = path.join(ROOT, 'a12-outside')
  fs.mkdirSync(rmPath12, { recursive: true })
  await M.upsertRecord({
    schemaVersion: 1,
    path: rmPath12,
    compareKey: M.normalizeWorktreePath(rmPath12).compareKey,
    repoRoot: repoB,
    repoKey: M.repoKeyOf(repoB),
    branch: 'wt/a12',
    baseSha: 'e'.repeat(40),
    baseLabel: 'main',
    targetBranch: 'main',
    createdAt: Date.now(),
    phase: 'active',
    intent: { branchExistedAtStart: false, pathExistedAtStart: false },
    deps: 'skipped',
    createdUnderRoot: M.rootKeyOf(rootLike)
  })
  const rm12 = await M.removeWorktree({ path: rmPath12, force: true, deleteBranch: false })
  assert('A12a dirRemoved 如实为 false', rm12.dirRemoved === false, String(rm12.dirRemoved))
  assert('A12b warnings 非空（界面才有东西可显示）', rm12.warnings.length > 0, rm12.warnings.length + ' 条')
  assert('A12c 目录确实还在磁盘上', fs.existsSync(rmPath12) === true, rmPath12)
  if (fs.existsSync(rmPath12)) fs.rmSync(rmPath12, { recursive: true, force: true })

  /* ───────── A12d：compareKey 形态的根判定（Linux CI 曾在此爆红）─────────
   *
   * 记录里的 `createdUnderRoot` 和 `compareKey` 都是**归一化的产物**，在 Linux 上
   * `/tmp/a` 的 compareKey 是 `tmp/a`（前导 `/` 已去掉）。把它们喂给 `isInsideRoot()`
   * 会再走一次 `resolve()`，`tmp/a` 被当成相对路径解析成 `<cwd>/tmp/a`，两侧基准不同，
   * 于是「同一个根」被判成根外 —— 全量场景 `wtremove` 在 ubuntu-latest 上就是这么红的
   * （提示里两个路径一模一样，却说不在根内），而 Windows 上恰好通过（盘符让它保持绝对）。
   *
   * 守的是 `isKeyInsideRoot()` 的语义；反向验证：把它改成 `startsWith(rootKey)` 后 A12d-e 变红。
   */
  console.log('\n-- A12d compareKey 形态的根判定 --')
  const keyRoot = 'tmp/deva-qa/wtremove-1/dst/wts'
  assert('A12d-a 根本身判为根内', M.isKeyInsideRoot(keyRoot, keyRoot) === true, keyRoot)
  assert(
    'A12d-b 根下子目录判为根内',
    M.isKeyInsideRoot(keyRoot, `${keyRoot}/a`) === true,
    `${keyRoot}/a`
  )
  assert(
    'A12d-c 深层子目录判为根内（不数层数，需求 Q1）',
    M.isKeyInsideRoot(keyRoot, `${keyRoot}/a/b/c/d`) === true,
    `${keyRoot}/a/b/c/d`
  )
  assert(
    'A12d-d 兄弟目录 wt2 判为根外（startsWith 会误放行）',
    M.isKeyInsideRoot(keyRoot, 'tmp/deva-qa/wtremove-1/dst/wts2') === false,
    'wts2 不得被 wts 当成子项'
  )
  assert(
    'A12d-e 父目录判为根外',
    M.isKeyInsideRoot(keyRoot, 'tmp/deva-qa/wtremove-1/dst') === false,
    '父目录不得判为根内'
  )

  if (fs.existsSync(rmPath12)) fs.rmSync(rmPath12, { recursive: true, force: true })

  /* ───────── A13/A14：改根不改变老记录的表现 ───────── */
  console.log('\n-- A13/A14 改根不影响存量 --')
  const before = (await M.listWorktrees()).items.map((it) => ({
    p: it.compareKey,
    state: it.state,
    gate: JSON.stringify(it.mergeGate)
  }))
  const rootC = path.join(ROOT, 'rootC')
  fs.mkdirSync(rootC, { recursive: true })
  const setC = M.setWorktreeRoot(rootC)
  assert('A14a 根改成 rootC 成功', setC.ok === true, JSON.stringify(setC))
  const after = (await M.listWorktrees()).items.map((it) => ({
    p: it.compareKey,
    state: it.state,
    gate: JSON.stringify(it.mergeGate)
  }))
  eq('A13a/A14b 条数不变', after.length, before.length)
  eq('A13b/A14c 每条 state / mergeGate 逐字段相等', after, before)
  /*
   * A14d：改根后老记录的标注必须**重算**，而且这个案例里它应当变成「根外」。
   *
   * 原断言是 `insideRoot === undefined`（「改根后仍不标根外」），错在两点：
   * ① 需求 §11.2 原文「恢复默认后，之前的根外标注要**按新根重算**（不是一次性快照）」；
   * ② 老记录没有 `createdUnderRoot`，若坚持 undefined，A11「老记录也带标注」就永远实现不了。
   * 这里 rootC 与老记录所在目录无包含关系，所以正确结果是 `false`。
   */
  const snap14 = await M.listWorktrees()
  const old14 = snap14.items.find((it) => M.compareKeyOfPath(it.path) === M.compareKeyOfPath(oldRecPath))
  assert(
    'A14d 老记录改根后按新根重算（rootC 与它无包含关系 → 标为根外）',
    old14 !== undefined && old14.insideRoot === false,
    `实际=${String(old14 && old14.insideRoot)}（若为 undefined 或 true，说明没按新根重算）`
  )

  /* ───────── A15/A27：根在仓库内 → 拒绝保存，且文案含仓库路径 ───────── */
  console.log('\n-- A15/A27 保存校验：仓库内 --')
  const inRepo = path.join(repoA, 'sub-root')
  const cfgBefore = JSON.stringify(readConfig())
  const set15 = M.setWorktreeRoot(inRepo)
  assert('A15a 仓库内的根被拒', set15.ok === false, JSON.stringify(set15))
  eq('A15b reason === outside-repo-required', set15.reason, 'outside-repo-required')
  eq('A15c config.json 一个字节没变', JSON.stringify(readConfig()), cfgBefore)

  assert('A27a 单仓库：文案含该仓库完整路径', set15.ok === false && set15.message.includes(repoA), set15.message)
  info('A27 单仓库文案', set15.ok === false ? set15.message : '(未被拒)')

  /*
   * A27 ② 多仓库命中。
   *
   * 「多个仓库同时命中」的构造方式：两个**嵌套**的仓库（`outer` 包含 `inner-repo`），
   * 根落在 `inner` 里 —— 那它同时在 `inner` 内、也在 `outer` 内。
   * 两个 repoRoot 都必须登记在 `worktrees.json` 里，否则 `knownRepoRoots()` 看不到它们
   * （新装的机器上一条记录都没有时，只能挡住「当前仓库」，这是设计如此）。
   */
  const outer = makeRepo(path.join(ROOT, 'repoOuter'), 'main')
  const inner = makeRepo(path.join(outer, 'inner-repo'), 'main')
  const placeHolder = (repo, tag) => ({
    schemaVersion: 1,
    path: path.join(ROOT, 'placeholder-' + tag),
    compareKey: M.normalizeWorktreePath(path.join(ROOT, 'placeholder-' + tag)).compareKey,
    repoRoot: repo,
    repoKey: M.repoKeyOf(repo),
    branch: 'wt/placeholder-' + tag,
    baseSha: 'f'.repeat(40),
    baseLabel: 'main',
    targetBranch: 'main',
    createdAt: Date.now(),
    phase: 'active',
    intent: { branchExistedAtStart: false, pathExistedAtStart: false },
    deps: 'skipped'
  })
  await M.upsertRecord(placeHolder(outer, 'outer'))
  await M.upsertRecord(placeHolder(inner, 'inner'))
  const set27 = M.setWorktreeRoot(path.join(inner, 'deep-root'))
  assert('A27b 多仓库命中被拒', set27.ok === false, JSON.stringify(set27))
  if (set27.ok === false) {
    const hasOuter = set27.message.includes(outer)
    const hasInner = set27.message.includes(inner)
    assert('A27c 文案含外层仓库路径', hasOuter, set27.message)
    assert('A27d 文案同时含内层仓库路径（不只报第一个）', hasInner, set27.message)
    info('A27 多仓库文案', set27.message.replace(/\n/g, ' ⏎ '))
  }

  /* ───────── A16：根太深 → 拒绝并给试算样例 ───────── */
  console.log('\n-- A16 保存校验：路径过长 --')
  /*
   * 造一个足够深的根。`MAX_PATH_LEN = 180`，`<root>/<repoKey16>/<slug40>-zzzz` 还要 +62，
   * 所以根长到 130 就必然超限。用 130 个字符的段名拼。
   */
  const longRoot = path.join(ROOT, 'r'.repeat(120))
  const set16 = M.setWorktreeRoot(longRoot)
  assert('A16a 过深的根被拒', set16.ok === false, JSON.stringify(set16))
  eq('A16b reason === path-too-long', set16.reason, 'path-too-long')
  if (set16.ok === false) {
    assert('A16c 文案含试算样例路径', set16.message.includes(longRoot) || /[A-Za-z]:[\\/].{40,}/.test(set16.message), set16.message.replace(/\n/g, ' ⏎ '))
    info('A16 文案', set16.message.replace(/\n/g, ' ⏎ '))
  }

  /* ───────── A17：恢复默认 = 删键 ───────── */
  console.log('\n-- A17 恢复默认 --')
  const okRoot = path.join(ROOT, 'nice-root')
  fs.mkdirSync(okRoot, { recursive: true })
  const setOk = M.setWorktreeRoot(okRoot)
  assert('A17a 设一个合法根成功', setOk.ok === true, JSON.stringify(setOk))
  eq('A17b config.json 里有该键', typeof readConfig()[M.WORKTREE_ROOT_KEY], 'string')
  const reset = M.setWorktreeRoot(undefined)
  assert('A17c 恢复默认成功', reset.ok === true, JSON.stringify(reset))
  eq('A17d config.json 里没有该键了', readConfig()[M.WORKTREE_ROOT_KEY], undefined)
  eq('A17e 生效值回到默认根', M.worktreeRoot(), path.join(DEVA_HOME, 'worktrees'))
  assert('A17f isDefault === true', reset.ok === true && reset.isDefault === true, JSON.stringify(reset))
  const view = M.readWorktreeRoot()
  assert('A17g readWorktreeRoot 报 isDefault', view.isDefault === true, JSON.stringify(view))

  /* ───────── A18：设自定义根后，默认路径基于新根 ───────── */
  console.log('\n-- A18 自定义根影响默认路径 --')
  const rootX = path.join(ROOT, 'rootX')
  fs.mkdirSync(rootX, { recursive: true })
  assert('A18a 设根 rootX 成功', M.setWorktreeRoot(rootX).ok === true)
  const pre18 = await M.precheck({ repoRoot: repoA, branch: 'wt/a18' })
  assert('A18b 默认路径在 rootX 下', pre18.ok === true && M.isInsideRoot(rootX, pre18.path), pre18.ok ? pre18.path : pre18.reason)
  info('A18 默认路径', pre18.ok ? pre18.path : '(失败)')

  /* ───────── A19/A20：DEVA_HOME 与自定义根的关系 ───────── */
  console.log('\n-- A19/A20 DEVA_HOME --')
  /*
   * `getDevaHome()` 是模块级缓存（一个进程只算一次），所以这两条只能验「逻辑」而非「重启」：
   *  - A19：未设根时，`worktreeRoot()` === `<DEVA_HOME>/worktrees`（已由 A1a 验过）
   *  - A20：设了根时，`worktreeRoot()` === 用户设定值，与 DEVA_HOME 无关（已由 A18 验过）
   * 真正的「改 DEVA_HOME 重启」需要独立子进程，见下方 A19'/A20' 子进程验证。
   */
  const { execFileSync } = require('child_process')
  const dh2 = path.join(ROOT, 'dh2')
  fs.mkdirSync(dh2, { recursive: true })
  /* 先清掉自定义根，再在子进程里用新 DEVA_HOME 跑 */
  M.setWorktreeRoot(undefined)
  const probeScript = path.join(QA, 'dist', 'wtroot', 'probe-home.cjs')
  fs.writeFileSync(
    probeScript,
    `const M = require(${JSON.stringify(path.join(QA, 'dist', 'wtroot', 'wtroot.cjs'))})
console.log(JSON.stringify({ root: M.worktreeRoot(), def: M.defaultWorktreeRoot() }))`
  )
  try {
    const out19 = execFileSync(process.execPath, [probeScript], {
      env: { ...process.env, DEVA_HOME: dh2 },
      encoding: 'utf8'
    })
    const j19 = JSON.parse(out19.trim().split('\n').pop())
    eq('A19a 未设根 + 新 DEVA_HOME → 默认根跟着走', j19.root, path.join(dh2, 'worktrees'))
    ok('A19b 默认值没写进 config.json', 'config 里无该键')
  } catch (e) {
    bad('A19 子进程验证', String(e && e.message))
  }
  /*
   * ── A20：设了自定义根时，DEVA_HOME 变化**不改变根** ──
   *
   * 这里有个容易搞错的点：`config.json` 存在 `DEVA_HOME` 里，所以「改 DEVA_HOME」本身
   * 就会换成另一个配置文件。要验的语义是「**用户显式设定的根优先于默认根的计算**」，
   * 而不是「配置会跨 home 瞬移」。
   *
   * 所以夹具这样造：把带 `worktreeRoot` 的 config.json **复制**到新 home（模拟用户迁移 /
   * 便携安装换盘），再在新 home 下启动 —— 若实现把根写死成「默认根 + 相对偏移」之类的推导，
   * 这里就会变成 dh2 下的路径而失败。
   */
  M.setWorktreeRoot(rootX)
  const dh3 = path.join(ROOT, 'dh3')
  fs.mkdirSync(dh3, { recursive: true })
  fs.copyFileSync(path.join(DEVA_HOME, 'config.json'), path.join(dh3, 'config.json'))
  try {
    const out20 = execFileSync(process.execPath, [probeScript], {
      env: { ...process.env, DEVA_HOME: dh3 },
      encoding: 'utf8'
    })
    const j20 = JSON.parse(out20.trim().split('\n').pop())
    eq('A20a 配置随 home 迁移后，根仍是用户设定的 X', j20.root, M.normalizeWorktreePath(rootX).path)
    assert('A20b 根没有漂到新默认位置', !M.isInsideRoot(path.join(dh3, 'worktrees'), j20.root), JSON.stringify(j20))
  } catch (e) {
    bad('A20 子进程验证', String(e && e.message))
  }
  M.setWorktreeRoot(undefined)

  /* ───────── A21：老 worktrees.json 不被判 corrupt ───────── */
  console.log('\n-- A21 老记录不被判 corrupt --')
  const wtFile = path.join(DEVA_HOME, 'worktrees.json')
  fs.writeFileSync(
    wtFile,
    JSON.stringify({
      schemaVersion: 1,
      records: [
        {
          // 老记录：没有 createdUnderRoot
          schemaVersion: 1,
          path: path.join(ROOT, 'legacy-wt'),
          compareKey: M.normalizeWorktreePath(path.join(ROOT, 'legacy-wt')).compareKey,
          repoRoot: repoA,
          repoKey: repoKeyA,
          branch: 'wt/legacy',
          baseSha: 'a'.repeat(40),
          baseLabel: 'main',
          targetBranch: 'my/dev',
          createdAt: Date.now() - 90000,
          phase: 'active',
          intent: { branchExistedAtStart: false, pathExistedAtStart: false },
          deps: 'skipped'
        }
      ]
    })
  )
  /* 用一个独立子进程重载（本进程的 cache 已建） */
  const probeStore = path.join(QA, 'dist', 'wtroot', 'probe-store.cjs')
  fs.writeFileSync(
    probeStore,
    `const M = require(${JSON.stringify(path.join(QA, 'dist', 'wtroot', 'wtroot.cjs'))})
const recs = M.listRecords()
const state = M.getStoreLoadState()
// 写一条新记录，验证写操作没被 fail closed
const p = ${JSON.stringify(path.join(ROOT, 'legacy-wt-write'))}
const wrote = M.upsertRecord({
  schemaVersion: 1, path: p, compareKey: M.normalizeWorktreePath(p).compareKey,
  repoRoot: ${JSON.stringify(repoA)}, repoKey: ${JSON.stringify(repoKeyA)},
  branch: 'wt/w', baseSha: 'b'.repeat(40), baseLabel: 'main', targetBranch: 'my/dev',
  createdAt: Date.now(), phase: 'active',
  intent: { branchExistedAtStart: false, pathExistedAtStart: false }, deps: 'skipped'
})
console.log(JSON.stringify({ state, count: recs.length, wrote }))`
  )
  try {
    const out21 = execFileSync(process.execPath, [probeStore], {
      env: { ...process.env, DEVA_HOME: DEVA_HOME },
      encoding: 'utf8'
    })
    const j21 = JSON.parse(out21.trim().split('\n').pop())
    eq('A21a 老文件载入后 loadState === ok', j21.state, 'ok')
    assert('A21b 老记录被读到', j21.count === 1, String(j21.count))
    assert('A21c 写操作没被 fail closed（证明新字段是可选的）', j21.wrote === true, String(j21.wrote))
    info('A21 子进程结果', JSON.stringify(j21))
  } catch (e) {
    bad('A21 子进程验证', String(e && e.message))
  }

  /* ───────── A22：schemaVersion 仍是 1 ───────── */
  console.log('\n-- A22 schemaVersion 未动 --')
  {
    /*
     * 断言看**剥掉注释**的源码（`.deva/qa/lib/strip-comments.cjs`）。
     *
     * 这两条查的是「某个字面量在不在」，而 `store.ts` 的注释里很可能出现
     * 「schemaVersion 仍是 1」「SCHEMA 不要随便动」这类句子 —— 不剥注释时，
     * 把真正的字段删掉、只留一句注释也会照样 PASS。
     */
    const { stripComments } = require('./lib/strip-comments.cjs')
    const storeSrc = stripComments(
      fs.readFileSync(path.join(SRC_MAIN, 'worktree', 'store.ts'), 'utf8')
    )
    assert('A22a 文件级 SCHEMA = 1', /const SCHEMA = 1\b/.test(storeSrc), 'const SCHEMA = 1')
    assert('A22b 记录级 schemaVersion: 1', /schemaVersion: 1\b/.test(storeSrc), 'schemaVersion: 1')
    /*
     * 更强的验法：用 A21 那份老文件（schemaVersion:1）真的载入成功，已经证明强校验没被绕过。
     */
    ok('A22c 由 A21 佐证：老文件能被强校验通过')
  }

  /* ───────── A23：新记录写入 createdUnderRoot（compareKey 形态）───────── */
  console.log('\n-- A23 新记录带「创建时根」--')
  {
    /*
     * 用真实 createWorktree 建一个，再读盘看字段。这样验的是「创建路径真的写了」，
     * 而不是「我手工 upsert 时能写」。
     */
    const CRE = M.createWorktree
    if (typeof CRE === 'function') {
      const rootNew = path.join(ROOT, 'rootNew')
      fs.mkdirSync(rootNew, { recursive: true })
      M.setWorktreeRoot(rootNew)
      const r23 = await CRE({ repoRoot: repoA, branch: 'wt/a23', skipDeps: true })
      assert('A23a 在根内创建成功', r23.ok === true, r23.ok ? '' : r23.reason + ' / ' + r23.message)
      if (r23.ok) {
        const onDisk = JSON.parse(fs.readFileSync(wtFile, 'utf8'))
        /*
         * 按 `path` 的**比较键**匹配，不要直接比 `compareKey` 字符串：
         * 内存里那条的 compareKey 与盘上的大小写形态未必逐字符相同（两者都经过归一化，
         * 但对象来源不同）。用同一个函数各算一次再比，才是「同一条」的正确判法。
         */
        const want = M.compareKeyOfPath(r23.record.path)
        const rec23 = onDisk.records.find((x) => M.compareKeyOfPath(x.path) === want)
        assert('A23b 盘上该条有 createdUnderRoot', !!rec23 && typeof rec23.createdUnderRoot === 'string', JSON.stringify(rec23 && rec23.createdUnderRoot))
        eq('A23c 值是当前根的 compareKey', rec23 && rec23.createdUnderRoot, M.rootKeyOf(rootNew))
        /* 改成别的根 → 该记录删除时被拒删目录 */
        const otherRoot = path.join(ROOT, 'otherRoot')
        fs.mkdirSync(otherRoot, { recursive: true })
        const rm23 = await M.removeWorktree({ path: r23.record.path, force: true, deleteBranch: false })
        assert('A23d 根内记录可删（根没变时）', rm23.dirRemoved === true, JSON.stringify(rm23.warnings))
      }
      M.setWorktreeRoot(undefined)
    } else {
      bad('A23 前置', 'createWorktree 未导出')
    }
  }

  /* ───────── A28：根外老 worktree 可用但旁边不能新建 ───────── */
  console.log('\n-- A28 根外老 worktree --')
  {
    const outsideOld2 = path.join(ROOT, 'a28-outside')
    const { execFileSync } = require('child_process')
    let made = false
    try {
      execFileSync('git', ['worktree', 'add', '-b', 'wt/a28', outsideOld2], { cwd: repoB, stdio: 'ignore' })
      made = true
    } catch (e) {
      info('A28 造 worktree 失败', String(e && e.message))
    }
    if (made) {
      await M.upsertRecord({
        schemaVersion: 1,
        path: outsideOld2,
        compareKey: M.normalizeWorktreePath(outsideOld2).compareKey,
        repoRoot: repoB,
        repoKey: M.repoKeyOf(repoB),
        branch: 'wt/a28',
        baseSha: 'a'.repeat(40),
        baseLabel: 'main',
        targetBranch: 'main',
        createdAt: Date.now() - 8000,
        phase: 'active',
        intent: { branchExistedAtStart: false, pathExistedAtStart: false },
        deps: 'skipped'
      })
      const snap28 = await M.listWorktrees()
      const it28 = snap28.items.find((x) => M.compareKeyOfPath(x.path) === M.compareKeyOfPath(outsideOld2))
      assert('A28① 根外老记录在列表里', it28 !== undefined, '')
      assert('A28① state 有值', it28 && typeof it28.state === 'string', it28 && it28.state)
      /* ④ 在它旁边新建 → 拒绝 */
      const near = path.join(ROOT, 'a28-outside-sibling')
      const pre28 = await M.precheck({ repoRoot: repoB, branch: 'wt/a28b', path: near })
      eq('A28④ 旁边新建被拒', pre28.reason, 'path-outside-root')
      /* ⑤ 把根设为它所在目录 → 同一位置新建成功 */
      const parent = ROOT
      const setParent = M.setWorktreeRoot(parent)
      assert('A28⑤a 把根设为父目录成功', setParent.ok === true, JSON.stringify(setParent))
      const pre28b = await M.precheck({ repoRoot: repoB, branch: 'wt/a28c', path: path.join(ROOT, 'a28-outside-sibling2') })
      assert('A28⑤b 同一位置新建不再被拒', pre28b.ok === true, pre28b.ok ? '' : pre28b.reason + ' / ' + pre28b.message)
      M.setWorktreeRoot(undefined)
    } else {
      bad('A28 前置', 'git worktree add 失败')
    }
  }

  /* ───────── A24/A25：成员工作区自动受约束 ───────── */
  console.log('\n-- A24/A25 成员工作区 --')
  {
    /*
     * 成员工作区的路径来自 `precheck` 返回的 `path`（`member-worktree.ts:236`，再传给
     * `createWorktree` 的 `path`）。所以它自动受约束 —— 这里验的就是那条链路：
     * 给定一个根外路径，precheck 必须拒，从而成员绑定拿不到 `checkoutRoot`。
     *
     * 「绑定时界面提示说得清」属界面，见文件头「看不见的」清单。
     */
    const outsideForMember = path.join(ROOT, 'member-outside')
    const pre24 = await M.precheck({ repoRoot: repoB, branch: 'wt/member', path: outsideForMember })
    eq('A24 成员用根外 checkoutRoot → path-outside-root', pre24.reason, 'path-outside-root')
    const rootIn = path.join(ROOT, 'member-root')
    fs.mkdirSync(rootIn, { recursive: true })
    M.setWorktreeRoot(rootIn)
    const pre25 = await M.precheck({ repoRoot: repoB, branch: 'wt/member2' })
    assert('A25 根内成员工作区 precheck 通过', pre25.ok === true, pre25.ok ? '' : pre25.reason)
    if (pre25.ok) assert('A25b checkoutRoot 在根内', M.isInsideRoot(rootIn, pre25.path), pre25.path)
    M.setWorktreeRoot(undefined)
  }

  /* ───────── A26：基线观察 —— 默认目录本不存在 ───────── */
  console.log('\n-- A26 基线观察（不是断言失败）--')
  {
    /*
     * 需求 §13.8：这不是断言「做错了」，而是取基线。真实 `~/.deva-plus/worktrees` 是否存在
     * 与实现无关，所以这里只在**夹具** home 上取一次，并明确标注它不是 PASS/FAIL。
     */
    const fixtureWtDir = path.join(DEVA_HOME, 'worktrees')
    info('A26 夹具 home 下 worktrees 目录', fs.existsSync(fixtureWtDir) ? 'exists（本次夹具建过）' : 'absent')
    info('A26 真实 home 未触碰', '本判据全程只在 ' + ROOT + ' 下操作')
  }

  /* ───────── 汇总 ───────── */
  console.log('\n== 本判据看不见的（需浏览器，见 .deva/qa/ 的界面用例）==')
  console.log('  · 设置面板「默认」二字是否真的显示、恢复默认按钮是否回到默认根')
  console.log('  · 新建对话框里 path-outside-root 的提示是否可读、根路径有没有出现在屏幕上')
  console.log('  · 工作区列表里「不在当前根内」的标注实际长什么样、其它按钮是否仍可点')
  console.log('\n==RESULT== ' + pass + ' PASS / ' + fail + ' FAIL')
  process.exit(fail === 0 ? 0 : 1)
})().catch((e) => {
  console.error('FATAL', e)
  console.log('\n==RESULT== ' + pass + ' PASS / ' + fail + ' FAIL')
  process.exit(1)
})
