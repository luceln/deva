#!/usr/bin/env node
/**
 * 界面风格守卫：把 `.deva/design-system.md` 的评审 checklist 变成可复跑的命令。
 *
 * ## 为什么基线必须取自上游原版，而不是当前 HEAD
 *
 * 这个脚本第一版把当前 HEAD 的全部违规写成 BASELINE，当成「存量豁免」。那是错的：
 * HEAD 里已经混进了**二开自己新写的界面**（ImportPane / ModelSwapDialog / redesign.css +448 行）。
 * 拿它当基线 = 给二开自己的违规提前开了免责单，报告会显示「全部通过」。
 *
 * 正确口径：
 *   基线 = `upstream/main`（真正的原版）里同一批文件的违规计数
 *   违规 = 当前工作树计数 - 上游基线计数
 * 差额才是二开自己制造的。**上游没有的，一条都不许有。**
 *
 * ## 模式
 *
 *   node ui-guard.cjs              用上游基线扫当前树（默认，CI 用）
 *   node ui-guard.cjs --baseline   只打印上游基线数值（生成基线用）
 *   node ui-guard.cjs --strict     存量也算违规（要求整棵树干净）
 *   node ui-guard.cjs --commits    逐个提交检查二开新增行（见 §提交检查）
 *   node ui-guard.cjs --json       机器可读输出
 *
 * ## 六条判据
 *
 *   FONT    字号只用 13 / 12 / 11（正文/辅助/徽标），大标题 20
 *   RADIUS  圆角只用 --radius-sm / --radius / --radius-lg / --radius-full
 *   SHADOW  阴影只给浮层；面板 1px 边框 + 无阴影
 *   COLOR   颜色只用 tokens 语义变量；白字压深色底与图片遮罩除外
 *   MIDDOT  用户可见文案不用中点 `·` 做分隔
 *   NATIVE  不用原生 <details> / <summary>
 *
 * ## 这个脚本查不到什么（必须说清，否则会被当成「界面合规」的证明）
 *
 *   - 同心圆角（外 = 内 + padding）：要算嵌套容器的几何关系，静态分析判不了
 *   - 视觉层次是否成立：3 档灰阶 + 字重用得对不对，是设计判断
 *   - 间距是否「看起来均匀」：只能查是否用了刻度值，查不出用对了没有
 *   - 动效时长是否合适：能查数值，查不出该不该有动画
 *   - 暗色模式下的对比度：要真实渲染后测色差
 *   - 布局在窄窗口下会不会挤：要真实渲染
 *   - 组件是否复用了既有件（如列表行对齐 ThreadRow）：要人看
 *
 * 所以：**这个脚本绿了不等于界面没问题**，只等于「没有已知的机械可判违规」。
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

// __dirname 是 <repo>/.deva/qa，往上**两级**才是仓库根。
// 第一版写成三级，导致所有文件读不到、计数全 0、然后报「全部通过」——最坏的一类静默。
const ROOT = path.resolve(__dirname, '../..')
const SRC_REL = 'apps/desktop/src/renderer/src'
const SRC = path.join(ROOT, SRC_REL)
const UPSTREAM = 'upstream/main'

/** 参与扫描的 CSS 文件（相对 SRC）。tokens.css 只查字号，见 scanCss 的说明。 */
const CSS_FILES = ['redesign/redesign.css', 'styles/app.css', 'styles/tokens.css']

/** 字号白名单：正文 / 辅助 / 徽标 + 大标题。中间档（11.5/12.5/13.5）是明确要收敛的。 */
const FONT_OK = new Set(['13px', '12px', '11px', '20px'])
/** 圆角白名单：四个 token。裸 px 一律算违规。 */
const RADIUS_OK = new Set(['var(--radius-sm)', 'var(--radius)', 'var(--radius-lg)', 'var(--radius-full)'])
/** 阴影白名单：只认 token 与「环形/焦点环」这类结构性阴影。 */
const SHADOW_OK =
  /^(var\(--shadow\)|none|inherit|0 0 0 \d+px var\(--(accent-tint|bg-panel|bg-inset|bg|danger|warning|success)\)|inset 0 -2px 0 var\(--accent\))$/

/**
 * 有意为之的放行项：**不计数、不报警**，但要在报告里列出来说明「为什么放行」。
 * 每一条都必须能回答「这不是随手写的」。
 */
const INTENTIONAL = [
  {
    rule: 'FONT',
    re: /font-size:\s*0\s*[;}]/,
    why: '.cf-mention__at 一类：让字符不占位但复制时仍带上，是技术手段不是字号选择'
  },
  {
    rule: 'FONT',
    re: /font-size:\s*calc\(13px\s*\*\s*var\(--cs\)\)/,
    why: '对话缩放：实际值在 calc 括号里，13px 是缩放基准'
  },
  {
    rule: 'COLOR',
    re: /^\s*#[0-9a-fA-F]{3,8}\s*$/,
    why: 'tokens.css 里的颜色**定义**，必须裸值（查它等于问「字典里为什么有字」）'
  }
]

/**
 * 代码高亮语法色：VS Code 配色，与主题 token 无关，必须裸写。
 * 这些色值出现在 .hljs / .tok-* / .code-* 一类选择器块里。
 */
const SYNTAX_COLOR = /#(ce9178|569cd6|b5cea8|dcdcaa|a31515|098658|2f9e44|e5484d|4ec9b0|c586c0|d7ba7d|9cdcfe|1e1e1e)\b/i
const SYNTAX_SELECTOR = /\.(hljs|tok-|code-|syntax-|cm-|mtk)/

// ─────────────────────────── 扫描器 ───────────────────────────

/**
 * 扫一份 CSS 文本，返回违规列表。**纯函数**：不碰文件系统，上游文本与当前文本走同一条路径。
 * @param {string} rel  相对 SRC 的路径（用于报告定位与「是否 tokens.css」判断）
 * @param {string} css  CSS 文本
 * @param {{offset?:number, source?:string}} opt  offset=行号偏移（扫 diff 片段时用）
 */
function scanCss(rel, css, opt = {}) {
  const out = []
  const lineOffset = opt.offset || 0
  const source = opt.source || rel
  const isTokens = /(^|\/)tokens\.css$/.test(rel)
  const lines = css.split('\n')
  /** 当前所在的规则选择器（用于判断语法色块） */
  let selector = ''

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const at = `${source}:${i + 1 + lineOffset}`
    const line = raw
    const sel = line.match(/^\s*([.#][\w-][^{]*)\{/)
    if (sel) selector = sel[1]

    // ── 字号 ──
    for (const m of line.matchAll(/font-size:\s*([^;}]+)/g)) {
      const v = m[1].trim()
      // 有意为之的放行（见 INTENTIONAL）
      if (/^calc\(/.test(v)) continue
      // var(--font-*) 是 token 引用，合规。带 fallback 的 `var(--font-sm, 13px)` 也合规：
      // fallback 本身就是白名单里的值，实际渲染出来仍是 13px。
      if (/^var\(--font-[\w-]+(\s*,\s*(13px|12px|11px|20px))?\)$/.test(v)) continue
      if (v === 'inherit' || v === '0') continue
      if (FONT_OK.has(v)) continue // 白名单：合规，不计数
      out.push({ rule: 'FONT', at, value: v, why: `字号 ${v} 不在白名单（13/12/11/20）` })
    }

    // tokens.css 是颜色/圆角的**定义**处，只查字号，不查裸值与圆角。
    if (isTokens) continue

    // ── 圆角 ──
    for (const m of line.matchAll(/border-radius:\s*([^;}]+)/g)) {
      const v = m[1].trim()
      if (v === 'inherit' || v === '0') continue
      if (RADIUS_OK.has(v)) continue // token：合规
      // 四角简写里只含 token 的（`0 var(--radius) var(--radius) 0`）也是合规
      if (/^[\d\s]*var\(--radius(-sm|-lg|-full)?\)/.test(v) && !/\d+px/.test(v)) continue
      out.push({ rule: 'RADIUS', at, value: v, why: `圆角 ${v} 不是 token` })
    }

    // ── 阴影 ──
    for (const m of line.matchAll(/box-shadow:\s*([^;}]+)/g)) {
      const v = m[1].trim()
      if (SHADOW_OK.test(v)) continue
      out.push({ rule: 'SHADOW', at, value: v, why: '阴影只给浮层且用 var(--shadow)；面板应 1px 边框无阴影' })
    }

    // ── 裸色值 ──
    for (const m of line.matchAll(/(#[0-9a-fA-F]{3,8})\b/g)) {
      const v = m[1]
      if (v.toLowerCase() === '#fff' || v.toLowerCase() === '#000') continue // color-mix 锚点 / 白字压深色底
      if (SYNTAX_COLOR.test(v) && SYNTAX_SELECTOR.test(selector)) continue // 代码高亮语法色
      out.push({ rule: 'COLOR', at, value: v, why: '颜色应走 tokens 语义变量' })
    }
  }
  return out
}

/**
 * 扫 tsx/ts 文本里的中点与原生折叠元素。
 * 中点只查**代码**，注释里的不算（文档与举例常用）。
 */
function scanTsx(rel, code, opt = {}) {
  const out = []
  const lineOffset = opt.offset || 0
  const source = opt.source || rel
  const lines = code.split('\n')
  let inBlock = false

  for (let i = 0; i < lines.length; i++) {
    const at = `${source}:${i + 1 + lineOffset}`
    const raw = lines[i]
    let codeOnly = ''

    // 逐行去掉注释，正确处理跨行块注释
    let j = 0
    while (j < raw.length) {
      if (inBlock) {
        const end = raw.indexOf('*/', j)
        if (end === -1) { j = raw.length; break }
        inBlock = false
        j = end + 2
        continue
      }
      if (raw[j] === '/' && raw[j + 1] === '/') break // 行注释：本行后面全不算
      if (raw[j] === '/' && raw[j + 1] === '*') { inBlock = true; j += 2; continue }
      // 跳过字符串里的内容？字符串里的中点**是**用户可见文案，必须查
      codeOnly += raw[j]
      j++
    }

    if (codeOnly.includes('·')) {
      out.push({ rule: 'MIDDOT', at, value: '·', why: '用户可见文案不用中点做分隔；用顿号或逗号' })
    }
    if (/<details[\s>]|<summary[\s>]/.test(codeOnly)) {
      out.push({
        rule: 'NATIVE',
        at,
        value: 'details/summary',
        why: '不用原生 <details>：不继承 --fg/--accent、无 cursor:pointer、marker 是浏览器默认外观'
      })
    }
  }
  return out
}

// ─────────────────────────── 文件读取 ───────────────────────────

const notes = []

/** 读当前工作树里的文件。读不到要留痕——「读不到」绝不等于「没有违规」。 */
function readWorktree(rel) {
  const p = path.join(SRC, rel)
  try {
    return fs.readFileSync(p, 'utf8')
  } catch (e) {
    notes.push(`读不出当前树 ${rel}（${e.code || e.message}）——该文件未被检查，不等于没有违规`)
    return null
  }
}

/** 读上游版本的文件。git 里没有这个文件也是「读不到」，要留痕。 */
function readUpstream(rel) {
  const spec = `${UPSTREAM}:${SRC_REL}/${rel}`
  try {
    return execFileSync('git', ['show', spec], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (e) {
    notes.push(`读不出上游 ${spec}——基线缺这一项，无法判断它是存量还是新增`)
    return null
  }
}

function walkTsx(dir, base = dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    notes.push(`读不出目录 ${dir}（${e.code || e.message}）——其下文件未被检查`)
    return out
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist') continue
      walkTsx(p, base, out)
    } else if (/\.(tsx|ts)$/.test(e.name) && !/\.d\.ts$/.test(e.name)) {
      out.push(path.relative(base, p).split(path.sep).join('/'))
    }
  }
  return out
}

// ─────────────────────────── 主流程 ───────────────────────────

const argv = process.argv.slice(2)
const MODE_BASELINE = argv.includes('--baseline')
const MODE_STRICT = argv.includes('--strict')
const MODE_COMMITS = argv.includes('--commits')
const MODE_JSON = argv.includes('--json')

/** 计数键：`文件::规则::取值` */
const keyOf = (rel, rule, value) => `${rel}::${rule}::${value}`

/** 扫一整套（上游或当前树），返回 { counts, problems } */
function scanTree(getText, label) {
  const counts = Object.create(null)
  const problems = []
  const add = (rel, list) => {
    for (const p of list) {
      const k = keyOf(rel, p.rule, p.value)
      counts[k] = (counts[k] || 0) + 1
      problems.push({ ...p, rel })
    }
  }
  for (const rel of CSS_FILES) {
    const text = getText(rel, label)
    if (text === null) continue
    add(rel, scanCss(rel, text))
  }
  // tsx：上游树里有的文件才扫（当前树新增的 tsx 在上游不存在，基线计 0，这是对的）
  const tsxRels = label === 'current' ? walkTsx(SRC) : upstreamTsxList()
  for (const rel of tsxRels) {
    const text = getText(rel, label)
    if (text === null) continue
    add(rel, scanTsx(rel, text))
  }
  return { counts, problems }
}

/** 上游树里的 tsx 清单（只扫上游已有的文件，用于基线） */
function upstreamTsxList() {
  try {
    const out = execFileSync(
      'git',
      ['ls-tree', '-r', '--name-only', UPSTREAM, '--', `${SRC_REL}`],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    )
    return out
      .split('\n')
      .filter(Boolean)
      .map((p) => p.slice(SRC_REL.length + 1))
      .filter((p) => /\.(tsx|ts)$/.test(p) && !/\.d\.ts$/.test(p))
  } catch (e) {
    notes.push(`列不出上游 tsx 清单（${e.code || e.message}）——tsx 类判据没有基线，只报当前计数`)
    return []
  }
}

// ── 模式：只打印上游基线 ──
if (MODE_BASELINE) {
  const up = scanTree(readUpstream, 'upstream')
  console.log(`上游基线（${UPSTREAM}）：共 ${Object.keys(up.counts).length} 项\n`)
  const rows = Object.entries(up.counts).sort((a, b) => a[0].localeCompare(b[0]))
  for (const [k, n] of rows) console.log(`  ${String(n).padStart(4)}  ${k}`)
  console.log(`\n合计 ${up.problems.length} 处存量违规`)
  if (notes.length) {
    console.log('\n未读到：')
    for (const n of notes) console.log(`  ${n}`)
  }
  process.exit(notes.some((n) => n.includes('基线缺这一项')) ? 2 : 0)
}

// ── 模式：逐个提交检查新增行 ──
if (MODE_COMMITS) {
  const report = scanCommits()
  if (MODE_JSON) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    printCommitReport(report)
  }
  process.exit(report.totalNew > 0 ? 1 : 0)
}

// ── 默认：上游基线 vs 当前树 ──
const up = scanTree(readUpstream, 'upstream')
const cur = scanTree(readWorktree, 'current')

/** 差额：当前计数 - 上游计数。正数 = 二开新增。 */
const deltas = []
for (const [k, n] of Object.entries(cur.counts)) {
  const base = up.counts[k] || 0
  if (n > base) deltas.push({ key: k, now: n, base, added: n - base })
}
/** 上游有、当前没有（存量被清理）：只提示。 */
const shrunk = []
for (const [k, base] of Object.entries(up.counts)) {
  const n = cur.counts[k] || 0
  if (n < base) shrunk.push({ key: k, now: n, base, removed: base - n })
}

/**
 * 把「差额」落到具体行：**用真实 diff**，不用「取最后 N 个」那种猜法。
 *
 * 为什么不能猜：上游 18 处 11.5px、当前 27 处，差额 9。如果这 9 处散落在文件各处，
 * 「取最后 9 个」会把上游的老行也标成新增。用户拿到报告去改，会改到上游代码。
 * 所以只认 diff 里真正带 `+` 的行。
 */
function locateNew(delta) {
  const [rel, rule, value] = delta.key.split('::')
  const added = diffAddedLines(rel)
  const hits = added.filter((l) => {
    const list = /\.css$/.test(rel) ? scanCss(rel, l.text, { offset: l.line - 1, source: rel }) : scanTsx(rel, l.text, { offset: l.line - 1, source: rel })
    return list.some((p) => p.rule === rule && p.value === value)
  })
  if (hits.length > 0) return hits.map((l) => ({ at: `${rel}:${l.line}`, why: `新增行：${l.text.trim()}` }))
  // diff 里找不到（比如整块被重写、行号对不上）：退回当前树里的候选，但要标明是「推定」
  const fallback = cur.problems.filter((p) => p.rel === rel && p.rule === rule && p.value === value).slice(-delta.added)
  return fallback.map((p) => ({ at: p.at, why: `（diff 未命中，按计数推定）${p.why}` }))
}

/** 取某个文件相对上游新增的行（带真实行号），结果缓存。 */
const _diffCache = new Map()
function diffAddedLines(rel) {
  if (_diffCache.has(rel)) return _diffCache.get(rel)
  let out = []
  try {
    const diff = execFileSync(
      'git',
      ['diff', '--unified=0', `${UPSTREAM}..HEAD`, '--', `${SRC_REL}/${rel}`],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }
    )
    out = extractAddedLines(diff).flatMap((b) =>
      b.lines.map((text, i) => ({ line: b.startLine + i, text }))
    )
  } catch (e) {
    notes.push(`取 ${rel} 的 diff 失败（${e.code || e.message}）——该文件的新增行无法定位`)
  }
  _diffCache.set(rel, out)
  return out
}

if (MODE_JSON) {
  console.log(
    JSON.stringify(
      {
        upstream: UPSTREAM,
        totals: { upstream: up.problems.length, current: cur.problems.length },
        added: deltas.map((d) => ({ ...d, where: locateNew(d).map((p) => p.at) })),
        shrunk,
        notes
      },
      null,
      2
    )
  )
  process.exit(deltas.length > 0 ? 1 : 0)
}

// ── 人类可读输出 ──
const RULE_LABEL = {
  FONT: '字号',
  RADIUS: '圆角',
  SHADOW: '阴影',
  COLOR: '裸色值',
  MIDDOT: '中点',
  NATIVE: '原生折叠'
}

console.log('═══════ 界面风格守卫 ═══════')
console.log(`基线来源：${UPSTREAM}（上游原版，不是当前 HEAD）`)
console.log(`上游存量 ${up.problems.length} 处 / 当前 ${cur.problems.length} 处\n`)

if (cur.problems.length === 0 && up.problems.length === 0 && notes.length > 0) {
  console.log('⚠ 一个文件都没扫到，且没有任何违规计数——这几乎一定是路径错了，不能当成「通过」。\n')
}

const byRule = Object.create(null)
for (const d of deltas) {
  const rule = d.key.split('::')[1]
  byRule[rule] = (byRule[rule] || 0) + d.added
}

for (const [rule, label] of Object.entries(RULE_LABEL)) {
  const added = byRule[rule] || 0
  const upN = up.problems.filter((p) => p.rule === rule).length
  const curN = cur.problems.filter((p) => p.rule === rule).length
  const mark = added > 0 ? '红' : 'OK'
  console.log(`  ${mark.padEnd(3)} ${label.padEnd(6)} 上游 ${String(upN).padStart(3)} 处 → 当前 ${String(curN).padStart(3)} 处` + (added > 0 ? `  ← 二开新增 ${added}` : ''))
}

if (deltas.length > 0) {
  console.log('\n─── 二开新增的违规（上游没有，必须处置） ───')
  for (const d of deltas) {
    const where = locateNew(d)
    console.log(`  +${d.added}  ${d.key}  （上游 ${d.base} → 当前 ${d.now}）`)
    for (const w of where) console.log(`        ${w.at}  ${w.why}`)
  }
}

if (shrunk.length > 0) {
  console.log('\n─── 存量比上游少了（说明清理过，不阻塞） ───')
  for (const s of shrunk) console.log(`  -${s.removed}  ${s.key}  （上游 ${s.base} → 当前 ${s.now}）`)
}

if (notes.length > 0) {
  console.log('\n─── 未检查到的部分（读不到 ≠ 没有违规） ───')
  for (const n of notes) console.log(`  ${n}`)
}

console.log(`
边界：本脚本只查「能机械判定的六条」。以下**查不到**，不要把它当成界面合规的证明：
  · 同心圆角（外 = 内 + padding）—— 要算嵌套容器的几何关系
  · 视觉层次是否成立 —— 3 档灰阶与字重用得对不对，是设计判断
  · 间距是否用对了刻度 —— 只能查有没有用刻度值
  · 动效时长是否合适 —— 能查数值，查不出该不该有动画
  · 暗色模式对比度、窄窗口布局 —— 要真实渲染
  · 组件是否复用了既有件 —— 要人看`)

/**
 * 基线缺项 = 无法判断存量与新增的边界。这时**必须非零退出**。
 * 第一版的教训：路径算错三级 → 所有文件读不到 → 计数全 0 → 打印「全部通过」并 exit 0。
 * 「读不到」被当成「没问题」，是最坏的一类静默。
 */
const baselineGaps = notes.filter((n) => n.includes('基线缺这一项'))
if (baselineGaps.length > 0) {
  console.log(`\n界面风格守卫无法给出结论：基线缺 ${baselineGaps.length} 个文件（见上「未检查到的部分」）。`)
  console.log('读不到 ≠ 没有违规。先修路径或补上游引用，再重跑。')
  process.exit(2)
}

if (deltas.length > 0) {
  console.log(`\n界面风格守卫未通过：二开新增 ${deltas.reduce((n, d) => n + d.added, 0)} 处违规（${deltas.length} 项）。`)
  process.exit(1)
}
if (MODE_STRICT && cur.problems.length > 0) {
  console.log(`\n--strict：${cur.problems.length} 处存量违规也视为未通过。`)
  process.exit(1)
}
console.log('\n界面风格守卫通过：二开没有引入新违规。')

// ─────────────────────────── 提交检查 ───────────────────────────

/**
 * 逐个提交检查二开新增的界面行。
 *
 * 为什么按「新增行」而不是按「提交后的整棵树」：一个提交可能只改了 3 行，
 * 用整棵树比基线会把**别人之前引入的**违规算到它头上。只有 diff 的 `+` 行是这个提交自己的。
 *
 * 局限（必须说清）：
 *   - 只看 `+` 行，所以「删除一行合规代码、加一行违规代码」能抓到；
 *     但「把 13px 改成 13.5px」这种同行修改，在 diff 里是 -13px / +13.5px，同样能抓到。
 *   - 无法判断一个 `+` 行属于新组件还是搬动老代码（搬动会重复计）。报告里标注为「可能搬动」。
 */
function scanCommits() {
  let log
  try {
    log = execFileSync(
      'git',
      ['log', '--format=%H%x09%s', `${UPSTREAM}..HEAD`, '--', `${SRC_REL}`],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    )
  } catch (e) {
    notes.push(`取提交列表失败（${e.code || e.message}）——提交检查无法进行`)
    return { commits: [], totalNew: 0, notes }
  }
  const commits = log
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [sha, subject] = l.split('\t')
      return { sha, subject }
    })

  const results = []
  for (const c of commits) {
    let diff
    try {
      diff = execFileSync(
        'git',
        [
          'show',
          c.sha,
          '--format=',
          '--unified=0',
          '--',
          `${SRC_REL}/**/*.css`,
          `${SRC_REL}/**/*.tsx`,
          `${SRC_REL}/**/*.ts`
        ],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }
      )
    } catch (e) {
      notes.push(`取 ${c.sha.slice(0, 7)} 的 diff 失败（${e.code || e.message}）`)
      continue
    }
    const added = extractAddedLines(diff)
    const found = []
    for (const blk of added) {
      const rel = blk.file.replace(`${SRC_REL}/`, '')
      const isCss = /\.css$/.test(rel)
      const list = isCss ? scanCss(rel, blk.lines.join('\n'), { offset: blk.startLine - 1, source: rel }) : scanTsx(rel, blk.lines.join('\n'), { offset: blk.startLine - 1, source: rel })
      for (const p of list) found.push({ ...p, file: rel })
    }
    results.push({ ...c, addedLines: added.reduce((n, b) => n + b.lines.length, 0), violations: found })
  }
  return { commits: results, totalNew: results.reduce((n, r) => n + r.violations.length, 0), notes }
}

/** 从 `git show --unified=0` 输出里抽出每个文件的 `+` 行块（带真实行号）。 */
function extractAddedLines(diff) {
  const out = []
  let file = null
  let cur = null
  let newLine = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      file = line.slice(6)
      cur = null
      continue
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      newLine = parseInt(hunk[1], 10)
      cur = null
      continue
    }
    if (!file) continue
    if (line.startsWith('+')) {
      if (!cur) {
        cur = { file, startLine: newLine, lines: [] }
        out.push(cur)
      }
      cur.lines.push(line.slice(1))
      newLine++
    } else if (line.startsWith('-')) {
      // 删除行不推进新文件行号
    } else if (line.startsWith(' ')) {
      cur = null
      newLine++
    }
  }
  return out
}

function printCommitReport(report) {
  console.log('═══════ 二开提交界面检查 ═══════')
  console.log(`范围：${UPSTREAM}..HEAD，仅碰过 renderer 的提交，只查 diff 的 + 行\n`)
  const bad = report.commits.filter((c) => c.violations.length > 0)
  console.log(`提交 ${report.commits.length} 个，其中 ${bad.length} 个引入了界面违规，共 ${report.totalNew} 处\n`)
  if (bad.length === 0) {
    console.log('没有提交引入界面违规。')
  } else {
    console.log('| 提交 | 文件:行 | 规则 | 违规内容 |')
    console.log('|---|---|---|---|')
    for (const c of bad) {
      for (const v of c.violations) {
        console.log(`| ${c.sha.slice(0, 7)} ${c.subject.slice(0, 24)} | ${v.at} | ${v.rule} | ${String(v.value).replace(/\|/g, '\\|')} |`)
      }
    }
  }
  if (report.notes.length) {
    console.log('\n未检查到：')
    for (const n of report.notes) console.log(`  ${n}`)
  }
}
