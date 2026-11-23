/**
 * 导入报告：跨应用重加密后的两个新字段（`unrecoverable` / `rekeyed`）必须被界面正确对待。
 *
 * 背景（主进程 5ab2136 / 8ff9e62 定下的口径）：
 *  - `unrecoverable` **不进 `failed`**，所以 `report.ok` 仍为 true —— 界面必须用「警告」而非「错误」，
 *    且不能让整份报告看起来像失败了。它的数字与 key 名都要能看见，还要有去设置重填的入口。
 *  - `rekeyed` 是 `copied` 的**子集**（覆盖修好了目标里原有的坏密文）。「导入了几条」的唯一口径仍是
 *    `copied.length`，`rekeyed` 只用来加一句「其中 N 条修好了」。
 *  - `secrets-rekey-failed` 这个 reason 已从主进程移除，界面不得再判它。
 *
 * 前半段查源码形状，后半段 esbuild 驱动真实的 `secretsRow` 跑数据（不是跑副本）。
 */
const fs = require('fs')
const path = require('path')

const problems = []
const passes = []
const ok = (m) => passes.push(m)
const bad = (what, detail) => problems.push(`${what} —— ${detail}`)

const REPO = path.resolve(__dirname, '..', '..')
const PANE = path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'src', 'redesign', 'ImportPane.tsx')
// 词条不再从 `messages.ts` 的文本里抠：二开词条已搬到 `i18n/fork.ts`（由 messages.ts 深合并），
// 扫文本会在拆分后静默失效。改读运行时值，见 lib/i18n-source。
const { readI18n, checkKeys } = require('./lib/i18n-source.cjs')
const CSS = path.join(REPO, 'apps', 'desktop', 'src', 'renderer', 'src', 'redesign', 'redesign.css')

const paneRaw = fs.readFileSync(PANE, 'utf8')
/*
 * 断言只看**剥掉注释**的源码（`.deva/qa/lib/strip-comments.cjs`）。
 *
 * 这个文件的注释里写着「`res.message ?? t(...)` 永远不执行」「不得出现 unrecoverable
 * 混进失败计数」等句子 —— 全是断言要查的关键词。不剥注释时，一条跨行宽松正则
 * 就能从注释里命中，把已经改错的实现判成绿。
 */
const { stripComments, sliceBraced } = require('./lib/strip-comments.cjs')
const pane = stripComments(paneRaw)
const i18n = readI18n()
const css = fs.readFileSync(CSS, 'utf8')

// ── A. 源码形状 ────────────────────────────────────────────────────

// A1 unrecoverable 用警告呈现，不是错误：不得出现「因 unrecoverable 而把整份报告标失败」的分支，
//    且它必须被渲染出来（取 .length），而不是被忽略。
{
  const rendersIt = /<UnrecoverableNotice\s+keys=\{[^}]*unrecoverable[^}]*\}/.test(pane)
  rendersIt
    ? ok('A1 界面渲染了 unrecoverable（UnrecoverableNotice 收到该字段）')
    : bad('A1 界面渲染了 unrecoverable', '没找到 <UnrecoverableNotice keys={...unrecoverable} />')
}
{
  /*
   * A2：unrecoverable 不得混进失败计数 / 失败清单。
   *
   * 原实现是两条跨行宽松正则（`[\s\S]{0,200}` / `{0,300}`）用 `!bad1 && !bad2` 兜——
   * 它们能从 `failureTotal` 一路吞到 200/300 字符之后的任何 `unrecoverable`，
   * 于是「两者只是碰巧挨得近」也算缺陷（假红），而**真正**把 unrecoverable 加进
   * 失败集合的写法（在不同行、距离更远）反而漏掉。
   *
   * 改为按语义查：不许出现 `[...unrecoverable]` 参与失败聚合的形状，也不许
   * `unrecoverable.length` 出现在失败总数表达式里。逐行查，不跨行。
   */
  const codeLines = pane.split('\n')
  const badLines = codeLines.filter((l) => {
    const t = l.trim()
    if (!t.includes('unrecoverable')) return false
    // 与失败聚合直接相连：同一行里既提到 unrecoverable，又提到失败计数/清单
    return /failureTotal|allFailures|\bfailed\b|failures\s*\./.test(t)
  })
  badLines.length === 0
    ? ok('A2 unrecoverable 没有混进失败计数 / 失败清单', '逐行检查，无同行混用')
    : bad('A2 unrecoverable 没有混进失败计数', `这些行同时出现两者：${badLines.map((l) => l.trim().slice(0, 90)).join(' | ')}`)
}
{
  // 警告面板用 cf-imp__warn 这一套（警示色），不用失败清单那套（cf-imp__fails，危险色）
  const usesWarn = /className="cf-imp__warn"/.test(pane)
  usesWarn ? ok('A3 警告面板用 cf-imp__warn（警示色），与失败清单分离') : bad('A3 警告面板样式', '没找到 cf-imp__warn')
}
{
  // 必须有去「设置 › 模型」的入口，且走既有 bus（不在 ImportPane 里自造跳转）
  const hasBtn = /settings\.import\.unrecoverable\.goSettings/.test(pane)
  const usesBus = /import \{ openModelSettings \} from '\.\/modelSettingsBus'/.test(pane)
  hasBtn && usesBus
    ? ok('A4 「去设置 › 模型」按钮复用 modelSettingsBus')
    : bad('A4 「去设置 › 模型」按钮', `按钮=${hasBtn} bus=${usesBus}`)
}
{
  /*
   * A5：逐条列出 key 名（不是只报数字）。
   *
   * 原写法 `/keys\.map\(/.test(pane) || /shown\.map\(/.test(pane)` 是典型 `||` 兜底：
   * 两个候选只要有一个在就判过。它还有第二个毛病 —— `keys.map(` 这类泛化写法在别的
   * 列表里也可能出现，于是「真正那条渲染被删了、但别处恰好有个 keys.map」仍然绿。
   *
   * 真正承载渲染的是 `UnrecoverableNotice` 组件**定义**（调用点只传 props），
   * 所以在这里取该函数体（剥注释后），断言块内对 shown/keys 做了 map。
   */
  const defAt = pane.indexOf('function UnrecoverableNotice')
  /*
   * 不能直接取 `defAt` 之后的第一个 `{` —— 那里是参数解构 `({ keys })`，
   * 配平出来只有 `{ keys }`，会误报「函数体里没有 map」。
   * 先跨过参数列表的右括号，再取第一个 `{` 才是函数体。
   */
  const parenAt = defAt === -1 ? -1 : pane.indexOf(')', defAt)
  const bodyStart = parenAt === -1 ? -1 : pane.indexOf('{', parenAt)
  const body = bodyStart === -1 ? null : sliceBraced(pane, bodyStart)
  const mapsKeys = body !== null && /\b(keys|shown)\s*\.map\s*\(/.test(body)
  if (body === null) bad('A5 逐条列出 key 名', '没找到 UnrecoverableNotice 函数体')
  else if (!mapsKeys) bad('A5 逐条列出 key 名', `函数体内没有对 keys/shown 的 map：${body.replace(/\s+/g, ' ').slice(0, 140)}`)
  else ok('A5 逐条列出要重填的 key 名', 'UnrecoverableNotice 体内对 keys/shown 做了 map')
}
{
  // 条数很多时折叠，不把面板撑爆
  const capped = /UNRECOVERABLE_LIMIT/.test(pane)
  capped ? ok('A6 key 名过多时折叠（UNRECOVERABLE_LIMIT）') : bad('A6 key 名过多时折叠', '没有上限常量')
}
{
  // rekeyed 要挂到密钥行的 notes 上（成功面板补一句）
  const notesIt = /stat\.rekeyed\.length > 0\)\s*notes\.push\(\{\s*kind:\s*'rekeyed'/.test(pane.replace(/\s+/g, ' '))
  notesIt ? ok('A7 rekeyed 进了密钥行说明（成功面板补一句）') : bad('A7 rekeyed 进密钥行说明', '没找到 rekeyed 的 note push')
}
{
  /*
   * 已移除的 reason 不得再用。
   *
   * 词条侧改为查运行时值：这个 key 若还在任何语言里，`entry()` 就会返回它。
   * （原实现扫 `messages.ts` 文本，词条搬走后会误判为「已移除」——正好把这条检查变成假 PASS。）
   */
  const inPane = /secrets-rekey-failed/.test(pane)
  /*
   * 词条侧两个来源都查（结构化 entry + 扁平 key 列表），任一命中即算残留。
   * 原写法把 `||` 写在 filter 回调里、跨两行，既难读又容易被当成「兜底正则」——
   * 这里拆成两个具名条件，语义不变但可核对。
   */
  const inI18n = i18n.locales.filter((loc) => {
    const byEntry = Object.hasOwn(i18n.entry('settings.import.secretGroup.secretsRekeyFailed') ?? {}, loc)
    const byFlatKey = Object.keys(i18n.locale(loc)).some((k) => k.includes('secrets-rekey-failed'))
    return byEntry || byFlatKey
  })
  const stale = inPane || inI18n.length > 0
  !stale
    ? ok('A8 不再引用已移除的 reason secrets-rekey-failed')
    : bad('A8 secrets-rekey-failed', `源码里=${inPane}，词条里=${inI18n.join('/') || '无'}`)
}
{
  /*
   * 中英双语各一套。
   *
   * 原实现靠两个文本特征：`unrecoverable: { title:` 出现、`goSettings:` 恰好 2 次（中英各一）。
   * 改为按 key 查运行时值——每个语言都必须有 `unrecoverable.title` 与 `goSettings` 两个词条。
   * 语义等价（「中英各一套」），但不再依赖词条住在哪个文件、也不依赖缩进/换行等文本形状。
   */
  const r = checkKeys(['settings.import.unrecoverable.title', 'settings.import.unrecoverable.goSettings'])
  if (!r.ok) bad('A9 unrecoverable 词条中英各一套', r.detail)
  else ok('A9 unrecoverable 词条中英各一套', `${i18n.locales.join('/')} 各一套`)
}
{
  /*
   * 字号只用 12px / 13px（规范），不引入 11.5/12.5。
   *
   * 原写法 `/\.cf-imp__warn[\s\S]{0,600}font-size:\s*1[12]\.5px/` 跨行吞 600 字符 ——
   * 足够从 `.cf-imp__warn` 一路吞到**下一条规则**里，于是警告面板自己字号合规、隔壁
   * 某条写了 12.5px 也会被判成「警告面板违规」（假红）；反之若警告面板真写了 12.5px
   * 但排在 600 字符之后，又查不到（假绿）。
   *
   * 改为取该选择器的**规则块**（到配对的 `}`），只在块内查字号。
   */
  const selAt = css.indexOf('.cf-imp__warn')
  const braceAt = selAt === -1 ? -1 : css.indexOf('{', selAt)
  let ruleBody = null
  if (braceAt !== -1) {
    const end = css.indexOf('}', braceAt)
    ruleBody = end === -1 ? null : css.slice(braceAt, end + 1)
  }
  const badPx = ruleBody !== null && /font-size:\s*1[12]\.5px/.test(ruleBody)
  if (ruleBody === null) bad('A10 字号', '找不到 .cf-imp__warn 规则块')
  else if (badPx) bad('A10 字号', `出现 11.5/12.5px：${ruleBody.replace(/\s+/g, ' ').slice(0, 100)}`)
  else ok('A10 新增样式字号合规（无 11.5 / 12.5px）', '.cf-imp__warn 规则块内')
}

// ── B. 运行时：驱动真实的 secretsRow ────────────────────────────────
async function runtime() {
  if (typeof globalThis.window === 'undefined')
    globalThis.window = { deva: { platform: 'win32' }, addEventListener() {}, removeEventListener() {} }
  const esbuild = require('esbuild')
  const outDir = path.join(__dirname, 'dist')
  fs.mkdirSync(outDir, { recursive: true })
  const out = path.join(outDir, `check-import-rekey-${Date.now()}.cjs`)

  // 把 secretsRow 所在的模块整体 bundle，只为拿到那一个纯函数。
  await esbuild.build({
    entryPoints: [PANE],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: out,
    jsx: 'automatic',
    loader: { '.tsx': 'tsx', '.ts': 'ts' },
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'error',
    nodePaths: [path.join(REPO, 'node_modules'), path.join(REPO, 'apps', 'desktop', 'node_modules')],
    plugins: [
      {
        name: 'noop-css',
        setup(b) {
          b.onResolve({ filter: /\.css$/ }, () => ({ path: 'noop.css', namespace: 'noop' }))
          b.onLoad({ filter: /.*/, namespace: 'noop' }, () => ({ contents: '' }))
        }
      }
    ]
  })

  // 这一段驱动真实的 secretsRow：export 出去的不是副本，就是界面实际用的那个函数。
  const mod = require(out)
  fs.rmSync(out, { force: true })

  const { secretsRow } = mod
  if (typeof secretsRow !== 'function') {
    bad('B0 导出 secretsRow', 'ImportPane.tsx 没导出该函数，无法驱动真实实现')
    return
  }

  const run = (name, fn) => {
    try {
      fn()
      ok(name)
    } catch (e) {
      bad(name, e.message)
    }
  }
  const eq = (a, b, m) => {
    if (JSON.stringify(a) !== JSON.stringify(b))
      throw new Error(`${m}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`)
  }
  /*
   * SecretsStat 的夹具。
   *
   * 必须覆盖该类型的**全部必填字段**：`secretsRow` 会读 `pluginManaged` / `failed` / `rekeyed`
   * 等每一栏，漏一个就是 `Cannot read properties of undefined (reading 'length')`——
   * 看着像功能坏了，其实只是夹具没跟上类型（上游后来又加了 `pluginManaged`）。
   * 这里是该类型的完整空值，**新增字段时这份夹具要跟着补**。
   */
  const st = (patch) => ({
    copied: [],
    skipped: [],
    ignored: [],
    noEncryption: [],
    invalid: [],
    unrecoverable: [],
    rekeyed: [],
    pluginManaged: [],
    failed: [],
    ...patch
  })

  run('B1 只有 rekeyed 时 copied 不叠加它（3 条仍是 3 条）', () => {
    const row = secretsRow(st({ copied: ['a', 'b', 'c'], rekeyed: ['a'] }))
    eq(row.copied, 3, 'copied 数')
    const rk = row.notes.find((n) => n.kind === 'rekeyed')
    if (!rk) throw new Error('没有 rekeyed 说明')
    eq(rk.count, 1, 'rekeyed 条数')
    eq(rk.tone, 'good', 'rekeyed 应用成功色（不是失败色）')
  })

  run('B2 rekeyed 进明细（用户能看到是哪一条修好了）', () => {
    const row = secretsRow(st({ copied: ['a'], rekeyed: ['a'] }))
    const g = row.noteIds.find((x) => x.kind === 'rekeyed')
    if (!g) throw new Error('明细里没有 rekeyed 分组')
    eq(g.ids, ['a'], '分组内容')
  })

  run('B3 unrecoverable 不进 failed 计数、也不出现在密钥行标签里', () => {
    const row = secretsRow(st({ copied: ['a'], unrecoverable: ['x', 'y'] }))
    eq(row.failed, 0, 'failed 数（应为 0，界面不会报「导入失败」）')
    eq(row.copied, 1, 'copied 数')
    if (row.notes.some((n) => n.kind === 'unrecoverable'))
      throw new Error('密钥行里不该有 unrecoverable 标签（由面板级警告承担）')
  })

  run('B4 noEncryption 仍计入 failed，且不重复报', () => {
    const row = secretsRow(
      st({ noEncryption: ['k1'], failed: [{ step: 'secrets', id: 'k1', reason: 'no-encryption' }] })
    )
    eq(row.failed, 1, 'failed 数（不重复累加）')
    eq(row.notes.find((n) => n.kind === 'noEncryption').count, 1, 'noEncryption 条数')
    if (row.notes.find((n) => n.kind === 'failed')) throw new Error('真失败说明不该出现')
  })

  run('B5 secrets-write-failed 仍是真失败（危险色、进计数）', () => {
    const row = secretsRow(st({ failed: [{ step: 'secrets', id: 'z', reason: 'secrets-write-failed' }] }))
    eq(row.failed, 1, 'failed 数')
    const f = row.notes.find((n) => n.kind === 'failed')
    if (!f) throw new Error('缺少 failed 说明')
    eq(f.tone, 'bad', '真失败用危险色')
  })

  run('B6 全部为空：无任何说明标签', () => {
    const row = secretsRow(st({}))
    eq(row.notes.length, 0, 'notes 数')
    eq(row.copied, 0, 'copied 数')
  })
}

runtime()
  .catch((e) => bad('B 运行时', String(e && (e.stack || e.message))))
  .finally(() => {
    for (const p of passes) console.log(`PASS ${p}`)
    for (const p of problems) console.log(`FAIL ${p}`)
    console.log(`\n共 ${passes.length} PASS / ${problems.length} FAIL`)
    process.exit(problems.length === 0 ? 0 : 1)
  })
