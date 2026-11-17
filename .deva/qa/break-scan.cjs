#!/usr/bin/env node
/**
 * 破坏验证：证明「同类扫描」不是自说自话（章程第 4 步的自检）。
 *
 * 一个永远通过的检查没有价值；一个**修好之后仍然报红**的检查同样没价值——那会逼人
 * 把真问题加进豁免清单，最终把机制用废。所以两个方向都要证明：
 *
 *   A. 把守卫拆回旧写法 → 扫描必须变红（正问题抓得到）
 *   B. 把当前 4 条真问题**修掉**（在副本上）→ 扫描必须变绿（修好了会认）
 *
 * B 尤其重要：它是「扫描不会逼人把真 bug 登记成豁免」的唯一证据。
 *
 * 产品代码一个字节都不动：全部在 os.tmpdir() 里的副本上做。
 *
 * 用法：node .deva/qa/break-scan.cjs
 * 退出码：全部按预期 → 0；有不符合 → 1
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const REPO = path.resolve(__dirname, '..', '..')
const SRC = path.join(REPO, 'apps/desktop/src/main')
const SCAN = path.join(__dirname, 'scan-same-class.cjs')

let fails = 0
let skips = 0
const skipped = []
const pass = (n, d = '') => console.log(`PASS ${n}${d ? ` :: ${d}` : ''}`)
const fail = (n, d = '') => {
  fails++
  console.log(`FAIL ${n}${d ? ` :: ${d}` : ''}`)
}
/**
 * 记一次跳过。
 *
 * 为什么必须有这个：破坏样本锚在**源码片段**上，源码一演进（重构、改名、挪位置）样本就命中不到。
 * 之前的写法是 `throw` —— 那会让整个脚本崩在第一条失效样本上，**后面所有项都没跑**，
 * 而外面只看到一段堆栈、看不到「这次跑了哪些、哪些没跑」。
 * 那就是本仓库最防的「不报错但没生效」：脚本看起来执行过，实际只有前 3 条被验证。
 *
 * 和 driver.cjs 的 skipReason 同一套思路：跳过必须具名、必须写原因、必须在汇总里单独列，
 * 且 `--strict` 下视为未完成（非 0 退出）。
 */
const skip = (n, d) => {
  skips++
  skipped.push({ name: n, why: d })
  console.log(`SKIP ${n}${d ? ` :: ${d}` : ''}`)
}

function run(scanRoot) {
  try {
    const out = execFileSync(process.execPath, [SCAN], {
      env: { ...process.env, SCAN_ROOT: scanRoot },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

function withCopy(tag, mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `scan-break-${tag}-`))
  fs.cpSync(SRC, dir, { recursive: true })
  try {
    mutate(dir)
  } catch (e) {
    fs.rmSync(dir, { recursive: true, force: true })
    /*
     * 样本失效不是脚本崩溃，是「这条验证这次没发生」。
     * 交给调用处记 SKIP 并继续跑后面的项 —— 否则第一条失效样本就把整份验证废掉。
     */
    if (e instanceof SampleStale) return { stale: true, label: e.label, detail: e.message, code: -1, out: '' }
    throw e
  }
  const r = run(dir)
  fs.rmSync(dir, { recursive: true, force: true })
  return r
}

/**
 * 判「破坏后必须变红」。
 *
 * `pattern` 保留「报出的是哪个文件」这层特异性：只说「变红了」不够，
 * 变红可能是因为样本把别处碰坏了 —— 那证明的不是这条判据有效。
 */
function judgeRed(r, name, pattern, about) {
  if (r.stale) return skip(name, `${about ? `${about} · ` : ''}${r.detail}`)
  const hits = r.out.split('\n').filter((l) => /^(BARE|SWALLOW|DISCARD)\s/.test(l))
  if (r.code !== 0 && (!pattern || pattern.test(r.out))) return pass(name)
  return fail(`${name} 没被抓到`, hits.join(' | ') || '扫描仍全绿')
}

/**
 * 破坏样本失效（源码演进后找不到原文）。
 *
 * 与「破坏没生效」分开：样本失效说明**这条验证这次没有发生**（该记 SKIP），
 * 而破坏没生效说明**脚本自己有 bug**（该记 FAIL）。混成一个错误码会让
 * 「这次少验了 5 条」和「验证逻辑写错了」看起来一样。
 */
class SampleStale extends Error {
  constructor(label, detail) {
    super(`${label}：${detail}`)
    this.name = 'SampleStale'
    this.label = label
  }
}

/** 在副本里替换文本；命中不到就抛 SampleStale（由调用处转 SKIP，而不是崩掉整个脚本）。 */
function sub(dir, file, from, to, label, opts = {}) {
  const f = path.join(dir, file)
  const before = fs.readFileSync(f, 'utf8')
  /*
   * 换行符归一化：仓库源码在本机是 CRLF，而脚本里的多行模板写的是 LF，
   * 直接 includes 永远为 false。统一折成 LF 匹配、再按原文件风格写回。
   */
  const crlf = before.includes('\r\n')
  const n = crlf ? before.replace(/\r\n/g, '\n') : before
  if (!n.includes(from)) throw new SampleStale(label, '要替换的原文没找到（源码结构变了，样本需更新）')
  const out = n.replace(from, to)
  const written = crlf ? out.replace(/\n/g, '\r\n') : out
  fs.writeFileSync(f, written)

  /*
   * ⚠️ **破坏验证本身的验证**：确认文件内容真的变了、且包含新片段。
   *
   * 这一条是被 CRLF 问题逼出来的：脚本模板写 LF、源码是 CRLF 时 `includes` 恒 false，
   * 替换静默不发生 —— 于是「破坏后的场景仍然全绿」会被读成「扫描抓不到」，而真相是
   * **我根本没改到代码**。那种假绿比漏检更难察觉，因为它出现在验证环节本身。
   *
   * 三道检查缺一不可：
   *   a) 写回后内容与原文不同（替换真的发生了）；
   *   b) 新片段确实在文件里（写的是我要的那句，不是被别的替换掩盖）；
   *   c) 旧片段确实不在文件里了（不是「加了新代码但旧代码还在」，那种会得到两套逻辑同时生效）。
   */
  const after = fs.readFileSync(f, 'utf8')
  if (after === before) throw new Error(`${label}：写入后内容未变（替换没生效）`)
  const norm = (s) => (s.includes('\r\n') ? s.replace(/\r\n/g, '\n') : s)
  const na = norm(after)
  if (!na.includes(to)) throw new Error(`${label}：写入后找不到新片段（替换结果不对）`)
  /*
   * 第 3 道：旧片段不该还在。
   *
   * 但「插入型破坏」（在旧代码前包一层 `if (existsSync(to)) {`，旧代码本身要保留）是合法形态，
   * 调用方传 `{ keepOld: true }` 显式声明。不传时一律要求旧片段消失——
   * 否则「加了新代码、旧代码还在」会让两套逻辑同时生效，破坏出来的结果没有解释力。
   */
  if (!opts.keepOld && na.includes(from)) {
    throw new Error(`${label}：旧片段仍在（替换没删干净，两套逻辑会同时生效）`)
  }
}

/** 破坏验证：断言「破坏已生效」的自检（对 sub 的三道检查做一次反证）。 */
function selfCheckSub() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subself-'))
  const f = path.join(dir, 't.ts')
  let fails = 0
  const ok = (name, fn) => {
    try {
      fn()
      fails++
      console.log(`FAIL 自检 ${name}：本应抛错却没抛`)
    } catch {
      console.log(`PASS 自检 ${name}：正确抛错`)
    }
  }
  fs.writeFileSync(f, 'AAA\r\nBBB\r\n')
  ok('原文不存在时', () => sub(dir, 't.ts', 'NOPE', 'X', 'selfcheck'))
  // 写入后内容未变：from === to
  fs.writeFileSync(f, 'AAA\r\nBBB\r\n')
  ok('new 与 old 相同时（写回内容不变）', () => sub(dir, 't.ts', 'AAA', 'AAA', 'selfcheck'))
  // 旧片段仍在：to 里包含 from
  fs.writeFileSync(f, 'AAA\r\nBBB\r\n')
  ok('新片段包含旧片段时（旧片段仍在）', () => sub(dir, 't.ts', 'AAA', 'AAABBB', 'selfcheck'))
  // 正向：正常替换必须成功
  fs.writeFileSync(f, 'AAA\r\nBBB\r\n')
  try {
    sub(dir, 't.ts', 'BBB', 'CCC', 'selfcheck-ok')
    const got = fs.readFileSync(f, 'utf8')
    if (got === 'AAA\r\nCCC\r\n') console.log('PASS 自检 正常替换（CRLF 保留）成功')
    else {
      fails++
      console.log(`FAIL 自检 正常替换结果不对：${JSON.stringify(got)}`)
    }
  } catch (e) {
    fails++
    console.log(`FAIL 自检 正常替换被误拒：${e.message}`)
  }
  fs.rmSync(dir, { recursive: true, force: true })
  return fails
}

/* ── 基线：当前树应当通过（四条已修） ── */
const base = withCopy('baseline', () => {})
if (base.code === 0) pass('基线：当前树通过（四条已修，BARE 0）')
else fail('基线应通过却报红', base.out.split('\n').filter((l) => /^BARE|^SWALLOW|^DISCARD|FAIL/.test(l)).slice(0, 4).join(' | '))

/* ── 先自检「破坏」这套手段本身 —— 它坏了，下面所有 PASS 都不可信 ── */
const selfFails = selfCheckSub()
if (selfFails === 0) pass('破坏手段自检：替换真的改到代码（三道检查各能抛错 + 正常替换成功）')
else fail(`破坏手段自检有 ${selfFails} 项不对`)

/* ══════ A 方向：拆回旧写法必须变红 ══════ */

const b1 = withCopy('b1', (d) => {
  /*
   * mergeDir 文件分支改回裸 existsSync（旧 bug 的形状）。
   *
   * ⚠️ 同一文件里有两处 `const probe = inspectTarget(to)`（mergeDir 与 media 循环），
   * 只替换第一处会留下第二处 —— sub 的第 3 道检查（旧片段仍在）会拦下。
   * 所以这里带上足够上下文精确定位。
   */
  sub(
    d,
    'importer-assoc.ts',
    '      } else if (st.isFile()) {\n        const probe = inspectTarget(to)',
    '      } else if (st.isFile()) {\n        if (existsSync(to)) continue\n        const probe = inspectTarget(to)',
    'A1'
  )
  sub(
    d,
    'importer-assoc.ts',
    "import { copyFileSync, lstatSync, mkdirSync, rmSync, statSync, utimesSync } from 'fs'",
    "import { copyFileSync, existsSync, lstatSync, mkdirSync, rmSync, statSync, utimesSync } from 'fs'",
    'A1-import'
  )
})
judgeRed(b1, 'A1：mergeDir 回裸 existsSync → 变红', /BARE\s+importer-assoc\.ts/, 'mergeDir 文件分支')

const b2 = withCopy('b2', (d) => {
  /*
   * copySecrets 改回「读失败当没有」（旧 bug 的现场）。
   *
   * 锚点只取**代码行**、不带注释：注释最容易随解释更新而漂移，把注释写进 from 会让样本
   * 每改一次说明就失效一次（这正是它上一版 SKIP 的原因）。
   * 这里把「ENOENT 才正常、其余记 failed」改成「一律 return stat」。
   */
  sub(
    d,
    'importer-config.ts',
    `  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return stat`,
    `  } catch (e) {
    if (e) return stat`,
    'A2'
  )
})
judgeRed(b2, 'A2：copySecrets 改回读失败当没有 → 变红', /(?:BARE|SWALLOW)\s+importer-config\.ts/, 'copySecrets 三态')

const b3 = withCopy('b3', (d) => {
  // readMemoryFile 的 unreadable 不再被转成 failed（去掉调用方的失败通道）
  sub(
    d,
    'importer-memory.ts',
    "    if (read.kind === 'unreadable') {\n      projects.failed.push({ step: 'memories', id: key, reason: read.reason })\n      continue\n    }",
    "    if (read.kind === 'unreadable') continue",
    'A3'
  )
})
judgeRed(b3, 'A3：去掉 readMemoryFile 的失败通道 → 变红（DISCARD）', /DISCARD\s+importer-memory\.ts/, 'readMemoryFile 三态调用方')

/* ══════ B 方向：已修好的四条，拆回旧写法必须重新变红 ══════ */

/*
 * 上一版这段是「把 4 条真问题修掉 → 扫描应变绿」，用来证明扫描不会把真 bug 永远钉死。
 * 那 4 条现已修进产品代码，基线本来就是绿的，所以这段改成**反向**：
 * 把每条修复拆回旧写法，扫描必须重新报出 BARE。
 *
 * 这比上一版更硬：修好之后还能不能抓到复发，才是这套机制长期有效的判据。
 */

const b4 = withCopy('b4', (d) => {
  // ① 头像：拆回裸 existsSync（四态 → 两态）
  sub(
    d,
    'importer-personas.ts',
    "      const probe = inspectTarget(to)\n      if (probe.kind === 'usable') return undefined // 已有同名头像：不覆盖\n      if (probe.kind === 'blocked') return 'target-blocked'\n      if (probe.kind === 'unreadable') return 'target-unreadable'",
    '      if (existsSync(to)) return undefined // 已有同名头像：不覆盖',
    'B1'
  )
})
judgeRed(b4, 'B1：头像拆回裸 existsSync → 又变红', /BARE\s+importer-personas\.ts/, '头像四态')

const b5 = withCopy('b5', (d) => {
  // ② 角色本体：把四态判定塞回 existsSync 真分支里（模拟「守卫写在安全的那一侧」）
  sub(
    d,
    'importer-personas.ts',
    "      const probe = inspectTarget(to)\n      if (probe.kind === 'blocked') {",
    "      if (existsSync(to)) {\n      const probe = inspectTarget(to)\n      if (probe.kind === 'blocked') {",
    'B2',
    { keepOld: true }
  )
})
judgeRed(b5, 'B2：角色本体塞回 existsSync 真分支 → 又变红', /BARE\s+importer-personas\.ts/, '角色本体四态')

const b6 = withCopy('b6', (d) => {
  // ③ readJson：拆回「读失败返回 null」
  sub(
    d,
    'importer-config.ts',
    "function readJson(p: string): JsonRead {\n  let raw: string\n  try {\n    raw = readFileSync(p, 'utf8')\n  } catch (e) {\n    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }\n    return { kind: 'unreadable', reason: 'source-config-unreadable' }\n  }",
    'function readJson(p: string): JsonRead {\n  try {\n    return { kind: \'ok\', cfg: JSON.parse(readFileSync(p, \'utf8\')) as Cfg }\n  } catch {\n    return { kind: \'absent\' }\n  }',
    'B3'
  )
})
judgeRed(b6, 'B3：readJson 拆回读失败当没有 → 又变红', /(?:BARE|SWALLOW)\s+importer-config\.ts/, 'readJson 三态')

const b7 = withCopy('b7', (d) => {
  // ④ readMemoryFile：拆回「读失败返回空」
  sub(
    d,
    'importer-memory.ts',
    "function readMemoryFile(file: string): MemoryFileRead {\n  let raw: string\n  try {\n    raw = readFileSync(file, 'utf8')\n  } catch (e) {\n    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }\n    return { kind: 'unreadable', reason: 'source-memory-unreadable' }\n  }",
    'function readMemoryFile(file: string): MemoryFileRead {\n  try {\n    return { kind: \'ok\', entries: [], root: null }\n  } catch {\n    return { kind: \'absent\' }\n  }\n  try {\n    readFileSync(file, \'utf8\')\n  } catch {\n  }',
    'B4'
  )
})
judgeRed(b7, 'B4：readMemoryFile 拆回读失败当没有 → 又变红', /BARE\s+importer-memory\.ts|已找不到/, 'readMemoryFile 本体')

/* ── 汇总 ── */
console.log(
  `\n${fails === 0 && skips === 0 ? '全部按预期（A 抓得到，B 复发也抓得到）' : fails > 0 ? `${fails} 项未按预期` : '无失败，但有跳过'}（fail=${fails}，skip=${skips}）`
)
if (skips > 0) {
  /*
   * 跳过必须单独点名：`7/11 通过` 不能冒充 `11/11`。
   * 破坏样本锚在源码片段上，产品代码一重构样本就失效 —— 这是这类脚本的固有衰减，
   * 唯一能做的就是让衰减可见（这条与 driver.cjs 的 SKIP 汇总同一套思路）。
   */
  console.log(`本次未覆盖 ${skips} 项（样本锚在源码片段上，源码演进后失效）：`)
  for (const s of skipped) console.log(`  - ${s.name} :: ${s.why}`)
  console.log('处置：按当前源码更新该条 sub() 的 from/to，或确认该形态已不存在 → 删掉这一项。')
}
const strict = process.argv.includes('--strict')
if (strict && skips > 0) {
  console.log('--strict：跳过视为未完成。')
}
process.exit(fails === 0 && !(strict && skips > 0) ? 0 : 1)
