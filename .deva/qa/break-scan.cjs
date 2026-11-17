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
const pass = (n, d = '') => console.log(`PASS ${n}${d ? ` :: ${d}` : ''}`)
const fail = (n, d = '') => {
  fails++
  console.log(`FAIL ${n}${d ? ` :: ${d}` : ''}`)
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
    throw e
  }
  const r = run(dir)
  fs.rmSync(dir, { recursive: true, force: true })
  return r
}

/** 在副本里替换文本；命中不到就抛（源码结构变了时不能静默失效）。 */
function sub(dir, file, from, to, label, opts = {}) {
  const f = path.join(dir, file)
  const before = fs.readFileSync(f, 'utf8')
  /*
   * 换行符归一化：仓库源码在本机是 CRLF，而脚本里的多行模板写的是 LF，
   * 直接 includes 永远为 false。统一折成 LF 匹配、再按原文件风格写回。
   */
  const crlf = before.includes('\r\n')
  const n = crlf ? before.replace(/\r\n/g, '\n') : before
  if (!n.includes(from)) throw new Error(`${label}：要替换的原文没找到`)
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
if (b1.code !== 0 && /BARE\s+importer-assoc\.ts/.test(b1.out)) pass('A1：mergeDir 回裸 existsSync → 变红')
else fail('A1 没被抓到', b1.out.split('\n').filter((l) => l.startsWith('BARE')).join(' | ') || '无 BARE 行')

const b2 = withCopy('b2', (d) => {
  // copySecrets 改回「读失败当没有」（旧 bug 的现场）：整段三态判断换回一个大 catch return
  sub(
    d,
    'importer-config.ts',
    [
      "  } catch (e) {",
      "    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return stat // 原版没有密钥文件：正常",
      '    // 读到了但解析不了，与读不出来分开说，用户处置不同（前者要检查文件，后者稍后重试）',
      "    const reason = (e as Error)?.message?.startsWith('Unexpected') || e instanceof SyntaxError",
      "      ? 'source-secrets-corrupt'",
      "      : (e as Error)?.message ?? String(e)",
      "    stat.failed = [{ step: 'secrets', id: '<secrets.json>', reason }]",
      '    return stat',
      '  }'
    ].join('\n'),
    '  } catch {\n    return stat\n  }',
    'A2'
  )
})
if (b2.code !== 0 && /(BARE|SWALLOW)\s+importer-config\.ts/.test(b2.out)) pass('A2：copySecrets 改回读失败当没有 → 变红')
else fail('A2 没被抓到', b2.out.split('\n').filter((l) => /BARE|SWALLOW/.test(l)).join(' | ') || '无相关行')

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
if (b3.code !== 0 && /DISCARD\s+importer-memory\.ts/.test(b3.out)) pass('A3：去掉 readMemoryFile 的失败通道 → 变红（DISCARD）')
else fail('A3 没被抓到（三态调用方的 unreadable 丢弃检测失效）', b3.out.split('\n').filter((l) => /^DISCARD/.test(l)).join(' | ') || '无 DISCARD 行')

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
if (/BARE\s+importer-personas\.ts/.test(b4.out) && b4.code !== 0) pass('B1：头像拆回裸 existsSync → 又变红')
else fail('B1 没被抓到（修好的位置复发时扫描失灵）', b4.out.split('\n').filter((l) => /^BARE/.test(l)).join(' | '))

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
if (/BARE\s+importer-personas\.ts/.test(b5.out) && b5.code !== 0) pass('B2：角色本体塞回 existsSync 真分支 → 又变红')
else fail('B2 没被抓到', b5.out.split('\n').filter((l) => /^BARE/.test(l)).join(' | '))

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
if (/BARE\s+importer-config\.ts/.test(b6.out) && b6.code !== 0) pass('B3：readJson 拆回读失败当没有 → 又变红')
else fail('B3 没被抓到', b6.out.split('\n').filter((l) => /^BARE|^SWALLOW/.test(l)).join(' | '))

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
if ((/BARE\s+importer-memory\.ts/.test(b7.out) || /已找不到/.test(b7.out)) && b7.code !== 0) {
  pass('B4：readMemoryFile 拆回读失败当没有 → 又变红（BARE 或 canary 失效）')
} else {
  fail('B4 没被抓到', b7.out.split('\n').filter((l) => /^BARE|^SWALLOW|已找不到/.test(l)).join(' | '))
}

console.log(`\n${fails === 0 ? '全部按预期（A 抓得到，B 复发也抓得到）' : `${fails} 项未按预期`}（fail=${fails}）`)
process.exit(fails === 0 ? 0 : 1)
