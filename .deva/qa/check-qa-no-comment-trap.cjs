#!/usr/bin/env node
/**
 * 元判据：`.deva/qa/*.cjs` 自己有没有「被注释骗过」的假绿缺陷。
 *
 * ## 为什么要有这个脚本
 *
 * 一批判据脚本都是「读 `.ts`/`.tsx` 源码 → 对文本做正则断言 → PASS/FAIL」。它们的失效方式
 * 不在被测代码里，而在**判据自己身上**：注释里天然会提到类名、字段名、词条名（尤其修复类
 * 注释会原样写出「原来错在哪」）。一条跨行宽松正则（`[^<]*`、`[\s\S]{0,400}`）就能从注释里
 * 命中，把已经改错的实现判成绿。已经实测过的两个真实案例：
 *
 *   · `check-worktree-fields` 的 G1：把 `disabled={!view.mergeGate.mayMerge}` 改成
 *     `disabled={false}` 并把正确表达式挪进注释 —— 原判据 11 PASS 全绿。
 *   · `check-worktree-size` 的 S7：把真实 `onSize` 订阅删掉、只在注释里留一句
 *     `window.deva.worktree.onSize(...)` —— 原判据 9 PASS 全绿。
 *
 * 单条判据修完容易，难的是**新写的判据不再犯**。所以这里把判据的判据固定下来。
 *
 * ## 查什么
 *
 * 只查「真的在拿正则断言源码文本」的脚本 —— 用 `includes` 精确匹配、或 esbuild 驱动真实
 * 函数跑数据的脚本不受注释影响，不该被报红（否则这条判据自己就成了噪音）。
 *
 *   T1  正则断言源码 → 必须剥注释
 *       脚本里出现 `/<re>/.test(<源码变量>)` 且该变量来自 `readFileSync('*.ts(x)')`，
 *       就必须有剥注释的调用（`stripComments(...)` 或等价的块注释 `replace`）。
 *   T2  不得用 `||` 兜底正则
 *       `/a/.test(x) || /b/.test(x)` 这种「两个候选命中一个就算过」的写法，等于把两条
 *       断言降级成一条更弱的断言。
 *   T3  不得用无锚点的超长跨行窗口
 *       `[\s\S]{0,N}`（N ≥ 100）且窗口后没有紧跟收口锚点 —— N 越大越容易从注释或
 *       隔壁组件命中。正确做法几乎总是按花括号配平（sliceBraced / sliceBracket）或按行定位。
 *
 * 每处命中都可以用 `qa-trap-exempt:` 注释豁免（写清为什么这里不会假绿）。
 *
 * ## 它自己怎么被反向验证
 *
 * 把任意一个受查脚本的剥注释删掉（或换成不生效的写法），T1 必须变红。见报告里的实测。
 *
 * ## 两种模式：全量 / 只拦新增
 *
 * 全量模式（默认，本地排查用）：所有脚本的存量缺陷都算 FAIL。
 *
 * `--base=<ref>`（或环境变量 `QA_TRAP_BASE`）进入「只拦新增」模式：只把**本次改动涉及**
 * 的脚本（`git diff --diff-filter=ACMR <ref> -- .deva/qa`，加上未跟踪的新脚本）的 T1/T2/T3
 * 判 FAIL，其余脚本的存量缺陷只汇总、不拦。
 *
 * 为什么要有这个模式：存量缺陷会让一接进 CI 就全红，然后所有人把这条关掉 —— 与
 * `.jscpd-baseline.json` 挡重复代码是同一个坑、同一个解法。元判据的价值是**拦住以后新写的**
 * 假绿；不接进 CI 它就只是一次性检查。
 *
 * 两种模式都保留完整判定逻辑，`--base` 只影响**哪些 FAIL 进入退出码**，绝不改变判定本身
 * （绝不能「因为不在 diff 里就不查」——那样存量会悄悄再长）。
 *
 * 用法：
 *   node .deva/qa/check-qa-no-comment-trap.cjs                    全量
 *   node .deva/qa/check-qa-no-comment-trap.cjs --base=origin/dev  只拦新增（CI 用）
 *   --verbose 看「不适用」清单与存量 FAIL 明细；--debug <脚本名> 看变量识别中间结果
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..')
const SELF = path.basename(__filename)
const VERBOSE = process.argv.includes('--verbose')
const DEBUG = process.argv.includes('--debug')

/**
 * 从 `--base=<ref>` 或环境变量 `QA_TRAP_BASE` 取基线引用。都没有 → 全量模式（null）。
 *
 * 没传就退回全量是刻意的：本地排查要看全部；CI 里才用「只拦新增」，
 * 免得存量缺陷让流水线一上线全红、然后被人关掉。
 */
function baseRefOf() {
  const arg = process.argv.find((a) => a.startsWith('--base='))
  const fromArg = arg ? arg.slice('--base='.length).trim() : ''
  const fromEnv = (process.env.QA_TRAP_BASE || '').trim()
  return fromArg || fromEnv || null
}
const BASE_REF = baseRefOf()

const passes = []
/** FAIL 条目：`{ name, text }` —— 带脚本名才能按「改动集合」过滤决定是否拦。 */
const problems = []
const ok = (n, d) => passes.push(d ? `${n} —— ${d}` : n)
let currentScript = ''
const bad = (n, d) => problems.push({ name: currentScript, text: d ? `${n} —— ${d}` : n })

/**
 * 本次改动涉及的 `.deva/qa/*.cjs` 文件名集合。
 *
 * 三项相加（少一项都会漏）：
 *   · `git diff --diff-filter=ACMR <base>` —— 改过 / 新增 / 复制 / 重命名的已跟踪文件
 *   · `git diff --cached` —— 已 `git add` 但还没提交的（CI 里通常没有，本地常见）
 *   · `git ls-files --others --exclude-standard` —— 未跟踪的新脚本（CI 里一次性文件不存在，
 *     但本地新写的判据正是最该拦的对象 —— 漏了它「只拦新增」就成了空话）
 *
 * 拿不到 base（浅克隆 / ref 拼错 / 不在 git 仓库）时返回 `null`，调用方退化为全量 —— 
 * 宁可多拦也不要静默放行。
 */
function changedQaScripts(baseRef) {
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return null
    }
  }

  const tracked = git(['diff', '--name-only', '--diff-filter=ACMR', baseRef, '--', '.deva/qa'])
  if (tracked === null) return null

  const staged = git(['diff', '--cached', '--name-only', '--', '.deva/qa']) || ''
  const untracked = git(['ls-files', '--others', '--exclude-standard', '--', '.deva/qa']) || ''

  const set = new Set()
  for (const block of [tracked, staged, untracked]) {
    for (const line of block.split('\n')) {
      const p = line.trim()
      if (!p || !p.endsWith('.cjs')) continue
      // 只认 .deva/qa 直属的判据脚本；lib/、子目录夹具（insert-attach/、git-pill/）不算
      if (path.dirname(p) !== '.deva/qa') continue
      const name = path.basename(p)
      if (name === SELF) continue
      if (!fs.existsSync(path.join(REPO, p))) continue // 已删除的不查
      set.add(name)
    }
  }
  return set
}

const CHANGED = BASE_REF ? changedQaScripts(BASE_REF) : null
/** 真正生效的模式：拿到 base 且拿到改动集合才算「只拦新增」。 */
const DIFF_MODE = BASE_REF !== null && CHANGED !== null

/**
 * 剥掉脚本自身的注释 —— 直接复用被测的那份实现（`lib/strip-comments.cjs`），
 * 不再在这里维护第二份状态机。
 *
 * 教训：原来这里内联了一份简化版，它不认正则字面量里的 `'`，于是某个判据脚本的
 * `mainSrc.match(/ipcMain\.handle\('chat:.../g)` 会让它一头扎进「字符串」状态不再出来，
 * 后面整段注释漏剥 —— 结果把**判据自己注释里举例的旧正则**当成真实断言报红。
 * 判据的判据必须和被测对象用同一套规则，否则测出来的东西没有意义。
 */
const { stripComments: stripJsComments } = require('./lib/strip-comments.cjs')

const EXEMPT = /qa-trap-exempt\s*:/

/**
 * 赋值右侧是否说明「该变量已经是剥过注释的文本」。
 *
 * 用字符串匹配而不是正则表达式，避免为「匹配一个正则」再写一层转义
 * （之前正因这层转义写错，导致 `stripped` 永远是空集，元判据静默失效 —— 又是假绿）。
 */
function isStrippedRhs(rhs) {
  if (/\bstripComments\w*\s*\(/.test(rhs)) return true // 共用 lib
  if (/\bstripCommentsFlat\s*\(/.test(rhs)) return true
  if (rhs.includes('.replace(/*') || rhs.includes('.replace(/\\/\\*')) return true // 内联块注释正则
  if (rhs.includes('replace(/\\/\\*')) return true
  if (rhs.includes('.replace(/\\/\\*[')) return true
  // 通用：`.replace(/...` 里含 `\\*` 与 `*\\/` 的，多半就是剥块注释
  if (/\.replace\(/.test(rhs) && /\\\*/.test(rhs) && /\*\\\//.test(rhs)) return true
  return false
}

/**
 * 右侧是「从已剥注释的文本切一段出来」的调用 —— 结果仍然是剥过注释的。
 * 例：`const m = sliceBraced(pane, i)`、`const seg = pane.slice(a, b)`、
 * `const body = keepsBody`、`const line = pane.split('\n').find(...)`。
 * 这些派生变量不该被要求再剥一次。
 */
const DERIVE_CALL =
  /\bsliceBraced\s*\(|\bsliceBracket\s*\(|\blineWith\s*\(|\.slice\s*\(|\.split\s*\(|\.match\s*\(|\.matchAll\s*\(|\.find\s*\(|\.filter\s*\(|\.trim\s*\(|\.pop\s*\(/

/**
 * 判断一个脚本是否「拿正则断言源码文本」。
 *
 * 分两步：
 *   a) 找出脚本里被当作源码读取的变量名 —— 满足任一：
 *      · `readFileSync(<含 .ts/.tsx 字面量>)` 的赋值目标
 *      · `readFileSync(<某变量>)` 的赋值目标，且该变量由 `path.join(..., '*.tsx')` 之类构造
 *        （`check-worktree-fields` 就是 `read(PANE)` 这种包一层的写法，只看字面量会漏）
 *      · 上述变量的别名（`const pane = stripComments(paneRaw)`）
 *   b) 代码里有没有 `/<re>/.test(<源码变量>)`。
 *
 * 另外脚本里必须真的出现 `.ts`/`.tsx` 路径（否则读的是 JSON/日志，不受注释影响）。
 */
function sourceVarsOf(code) {
  const lines = code.split('\n')
  const vars = new Set()
  /** 已经是「剥过注释」的文本变量。 */
  const strippedInit = new Set()

  /** 该脚本里是否有指向 .ts/.tsx 的路径构造（字面量或 path.join 片段）。 */
  const hasTsPath = lines.some((l) => /['"][^'"]*\.(tsx?|jsx?)['"]/.test(l))
  if (!hasTsPath) return { vars, stripped: new Set() }

  // 路径常量：const PANE = path.join(ROOT, 'apps/.../BackupPane.tsx')
  const pathConsts = new Set()
  for (const l of lines) {
    const m = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n]+)/.exec(l)
    if (m && /\.(tsx?|jsx?)['"]/.test(m[2])) pathConsts.add(m[1])
  }

  // 直接读字面量：readFileSync('...tsx')
  for (const l of lines) {
    if (!/readFileSync/.test(l)) continue
    const m = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/.exec(l)
    if (!m) continue
    const name = m[1]
    const rhs = l.slice(l.indexOf('=', l.indexOf(name)) + 1)
    /*
     * 同一行里被剥注释包住的（`const pane = stripComments(fs.readFileSync(...))`）
     * 必须一开始就记进 strippedInit —— 否则 `while (grew)` 那一步会因为
     * `vars.has(name)` 直接跳过它，`stripped` 永远是空集（实测过：元判据因此静默失效）。
     */
    const inStripped = isStrippedRhs(rhs)
    if (/\.(tsx?|jsx?)['"]/.test(l)) {
      vars.add(name)
      if (inStripped) strippedInit.add(name)
      continue
    }
    // readFileSync(PANE) —— 参数是路径常量
    for (const c of pathConsts) {
      if (new RegExp(`readFileSync\\(\\s*${c.replace(/\$/g, '\\$')}\\b`).test(l)) {
        vars.add(name)
        if (inStripped) strippedInit.add(name)
        break
      }
    }
  }

  /*
   * 沿赋值链传播两组标记：
   *   · `vars`     —— 来自（未剥注释的）源码及其派生
   *   · `stripped` —— 已经是「剥过注释」的文本及其派生
   *
   * 传播规则（先判 stripped，再判 vars —— 派生自剥过注释的文本仍然是剥过的）：
   *   · 右侧是剥注释调用 / 抽注释文本 / 引用到 stripped 变量 → 新变量进 stripped
   *   · 否则右侧引用到 vars 变量 → 新变量进 vars
   * 这样能覆盖多级派生：`pane = stripComments(raw)` → `m = sliceBraced(pane,i)` → 断言 m。
   */
  const stripped = new Set(strippedInit)
  let grew = true
  while (grew) {
    grew = false
    for (const l of lines) {
      const m = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n]+)/.exec(l)
      if (!m) continue
      const [, name, rhs] = m
      if (vars.has(name) || stripped.has(name)) continue

      const refs = (set) =>
        [...set].some((v) => new RegExp(`\\b${v.replace(/\$/g, '\\$')}\\b`).test(rhs))

      /*
       * 「从源码里专门抽出注释文本」也算 stripped：`const commentBlock =
       * (leading.match(/\/\*\*[\s\S]*?\*\//g) || []).pop() || ''` ——
       * `check-git-focus` 的 F7 就是要断言注释内容，查的对象本身就是注释。
       */
      const extractsComment = /match\(\s*\/\\\/\\\*/.test(rhs)

      const isStripped =
        isStrippedRhs(rhs) || extractsComment || refs(stripped)

      if (isStripped) {
        stripped.add(name)
        vars.add(name) // 仍算断言对象
        grew = true
        continue
      }
      if (refs(vars)) {
        vars.add(name)
        grew = true
      }
    }
  }
  return { vars, stripped }
}

/** 脚本里所有对源码变量做正则断言的位置（行号 + 原文）。 */
function regexAssertions(codeLines, vars) {
  const hits = []
  if (vars.size === 0) return hits
  const varAlt = [...vars].map((v) => v.replace(/\$/g, '\\$')).join('|')
  // /re/.test(v)  或  /re/.test(v.something)  或  new RegExp(...).test(v)
  const re = new RegExp(`/\\^?[^/\\n]+\\$?/[gimsuy]*\\.test\\(\\s*(?:${varAlt})\\b`)
  const reNew = new RegExp(`new RegExp\\([^)]*\\)\\.test\\(\\s*(?:${varAlt})\\b`)
  for (let i = 0; i < codeLines.length; i += 1) {
    if (EXEMPT.test(codeLines[i])) continue
    if (re.test(codeLines[i]) || reNew.test(codeLines[i])) hits.push(i + 1)
  }
  return hits
}

const scripts = fs
  .readdirSync(QA)
  .filter((f) => f.endsWith('.cjs') && f !== SELF)
  .sort()

console.log('== 判据脚本的假绿风险（只查对源码做正则断言的脚本）==\n')

let checked = 0
const notApplicable = []

for (const name of scripts) {
  currentScript = name // 供 bad() 记录归属脚本，diff 模式按它过滤
  const raw = fs.readFileSync(path.join(QA, name), 'utf8')
  const code = stripJsComments(raw)
  const codeLines = code.split('\n')

  const { vars, stripped } = sourceVarsOf(code)
  const assertions = regexAssertions(codeLines, vars)
  if (DEBUG && name === process.argv[process.argv.indexOf('--debug') + 1]) {
    console.log(`[debug] ${name}`)
    console.log('  vars:', [...vars].join(','))
    console.log('  stripped:', [...stripped].join(','))
    console.log('  assertions:', assertions.join(','))
  }
  if (assertions.length === 0) {
    notApplicable.push(name)
    continue
  }
  checked += 1

  /* ── T1：正则断言源码 → 必须剥注释 ── */
  /*
   * 判定「有没有给**源码变量**剥注释」—— 必须**绑定到具体变量**，不能只看文件里
   * 出现过 `stripComments(` 或 `replace(/\/\*.../)`。
   *
   * 实测过两次假绿：
   *   · 一个脚本把 `stripComments` 定义成恒等函数（`(x) => x`）—— 按「出现过 `stripComments(`
   *     就算剥了」的判法照样 PASS，而实际上一个字符都没剥；
   *   · `check-worktree-root-ui.cjs` 里 `replace(/\/\*[\s\S]*?\*\//g,'')` 是给 **CSS** 用的，
   *     按「有内联块注释正则就算剥了」判法会放过它，可它对 `.tsx` 源码根本没剥。
   *
   * 所以判据改为：存在某个**源码断言变量**，它在赋值链上被 `stripComments(...)` 包裹，
   * 或被 `replace(/\*...` 处理过 —— 也就是 `stripped` 里确实有成员，且这些成员真的
   * 被断言用到。
   */
  const strippedVars = [...stripped].filter((v) => assertions.some((ln) => {
    const l = codeLines[ln - 1] || ''
    const m = /\.test\(\s*([A-Za-z_$][\w$]*)/.exec(l)
    return m && m[1] === v
  }))
  const usesShared = strippedVars.length > 0 && /stripComments\w*\s*\(/.test(code)
  const usesInline = strippedVars.length > 0 && !usesShared

  /*
   * 例外：有些脚本**有意**断言注释内容（例如 `check-git-focus.cjs` 的 F7 要验
   * 「文档注释有没有跟上实现」）。这类断言剥了注释就没什么可查，不该要求它剥。
   *
   * 判定标准不是「作者声明一句就算」，而是**全部**正则断言都落在注释变量上：
   * 找出断言里传给 `.test()` 的标识符，只要有一个来自 `readFileSync` 的**未剥注释**源码，
   * 就必须剥。全部都不是（如只对注释内容、或只对 i18n 运行时值断言）则豁免。
   */
  const assertsOnlyCommentVars = assertions.every((ln) => {
    const l = codeLines[ln - 1] || ''
    const m = /\.test\(\s*([A-Za-z_$][\w$]*)/.exec(l)
    if (!m) return false
    const v = m[1]
    // 不是「未剥注释的源码变量」→ 这类断言不受注释陷阱影响
    return !vars.has(v) || stripped.has(v)
  })

  if (strippedVars.length > 0) {
    ok(
      `${name} T1 剥了注释`,
      `${usesShared ? '共用 lib/strip-comments.cjs' : '内联块注释正则'}（作用于 ${strippedVars.slice(0, 3).join(',')}）`
    )
  } else if (assertsOnlyCommentVars) {
    ok(
      `${name} T1 不需剥注释`,
      `全部 ${assertions.length} 处正则断言的都不是未剥注释的源码（有意查注释内容）`
    )
  } else {
    const offenders = assertions.filter((ln) => {
      const l = codeLines[ln - 1] || ''
      const m = /\.test\(\s*([A-Za-z_$][\w$]*)/.exec(l)
      return !m || (vars.has(m[1]) && !stripped.has(m[1]))
    })
    bad(
      `${name} T1 没剥注释`,
      `${offenders.length} 处正则断言未剥注释的源码（行 ${offenders.slice(0, 6).join(',')}），却没有剥注释调用`
    )
  }

  /* ── T2：不得用 || 兜底正则 ── */
  const orFallback = []
  for (let i = 0; i < codeLines.length; i += 1) {
    const l = codeLines[i]
    if (EXEMPT.test(l)) continue
    if (/\/[^/\n]+\/[gimsuy]*\.test\([^)]*\)\s*\|\|\s*\/[^/\n]+\/[gimsuy]*\.test\(/.test(l)) {
      orFallback.push(`${i + 1}: ${l.trim().slice(0, 110)}`)
      continue
    }
    if (/^\s*\|\|\s*\/[^/\n]+\/[gimsuy]*\.test\(/.test(l)) {
      orFallback.push(`${i + 1}: ${l.trim().slice(0, 110)}`)
    }
  }
  if (orFallback.length === 0) ok(`${name} T2 没有 || 兜底正则`)
  else bad(`${name} T2 用了 || 兜底正则`, `${orFallback.length} 处：${orFallback.join(' | ')}`)

  /* ── T3：不得用无锚点的超长跨行窗口 ── */
  const wideWindows = []
  for (let i = 0; i < codeLines.length; i += 1) {
    const l = codeLines[i]
    if (EXEMPT.test(l)) continue
    for (const m of l.matchAll(/\[\\s\\S\]\{0,(\d+)\}/g)) {
      const n = Number(m[1])
      if (n < 100) continue
      // 强锚点：窗口之后紧跟 `])` / `})` / `</` 之类的收口
      const tail = l.slice(m.index + m[0].length)
      if (/^\??\]\s*\)/.test(tail) || /^\??\}\s*\)/.test(tail) || /^\??<\//.test(tail)) continue
      wideWindows.push(`${i + 1}: [\\s\\S]{0,${n}}`)
    }
  }
  if (wideWindows.length === 0) ok(`${name} T3 没有无锚点的超长跨行窗口`)
  else bad(`${name} T3 用了超长跨行窗口`, `${wideWindows.length} 处：${wideWindows.join(' | ')}`)
}

console.log('')
for (const p of passes) console.log(`PASS ${p}`)

/*
 * 输出与退出码分离：
 *   · 全量模式 —— 每条 FAIL 都打印、都拦（本地排查要看见全部）。
 *   · `--base` 模式 —— FAIL 全部打印（存量也让人看得见），但**只有改动脚本的**进退出码。
 *
 * 只有「拦住」的那部分决定 exit code，这一行是两种模式唯一的实质差别；
 * 判定逻辑本身一行都没按模式分支 —— 绝不能出现「不在 diff 里就不查」。
 */
const blocking = DIFF_MODE ? problems.filter((p) => CHANGED.has(p.name)) : problems
const baselineOnly = DIFF_MODE ? problems.filter((p) => !CHANGED.has(p.name)) : []

for (const p of blocking) console.log(`FAIL ${p.text}`)
if (baselineOnly.length > 0) {
  console.log(`\n（存量 ${baselineOnly.length} 条不拦，仅列明细 —— 本次没有改动这些脚本）`)
  for (const p of baselineOnly) console.log(`  BASELINE ${p.text}`)
}

if (DIFF_MODE) {
  console.log(
    `\n模式：只拦新增（base=${BASE_REF}，改动脚本 ${CHANGED.size} 个${
      CHANGED.size > 0 ? `：${[...CHANGED].join(', ')}` : ''
    }）`
  )
} else if (BASE_REF !== null) {
  console.log(`\n模式：全量（传了 base=${BASE_REF} 但拿不到改动清单，退化为全量以免静默放行）`)
} else {
  console.log('\n模式：全量（未传 --base / QA_TRAP_BASE）')
}

if (VERBOSE) {
  console.log(`\n（不涉及：${notApplicable.length} 个脚本不对源码做正则断言 —— ${notApplicable.join(', ')}）`)
} else {
  console.log(`\n（另有 ${notApplicable.length} 个脚本不对源码做正则断言，不适用本判据；加 --verbose 看清单）`)
}
console.log(
  `\n共检查 ${checked} 个脚本：${passes.length} PASS / ${
    DIFF_MODE ? `${blocking.length} FAIL（拦）+ ${baselineOnly.length} 存量（不拦）` : `${problems.length} FAIL`
  }`
)
process.exit(blocking.length === 0 ? 0 : 1)
