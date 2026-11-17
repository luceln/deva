#!/usr/bin/env node
/**
 * 豁免可证伪验证：「ALLOW 白名单」本身是不是假的。
 *
 * ## 为什么需要这个脚本
 *
 * `scan-same-class.cjs` 的 ALLOW 清单是**审查方登记的免检牌**。它的问题不是「豁免太多」，
 * 而是：**豁免一旦命中，该位置的失败处置就再没有任何东西检查**。
 *
 * 实测（2026-11-17）：把 13 条 ALLOW 各自对应的**失败通道 / 处置方向**逐条改坏，
 * 扫描器**全部依然绿**。也就是说 ALLOW 的「理由」是**声明**，不是**验证**。
 *
 * 反面参照：白名单**之外**的位置改坏（`break-scan.cjs` 的 A1/A2/A3/B1~B4）全都能抓到。
 * 两个方向的差别就是这份脚本存在的理由：**不是扫描器不准，是免检牌后面没有东西。**
 *
 * ## 两个判据（缺一不可）
 *
 * **判据 A —— 豁免是否必需**：把这条 ALLOW 从扫描器副本里删掉，重跑扫描。
 *   - 仍绿 → `REDUNDANT`：**这条豁免根本没在起作用**，删掉它不影响任何检查，纯属噪音。
 *   - 变红 → 该豁免确实压住了一个真实命中，继续判据 B。
 *
 * **判据 B —— 豁免是否可证伪**：给它配一个「最像它要放行的那种、但其实是 bug」的样本，
 *   写进源码副本 → 扫描必须变红。
 *   - 变红 → `PASS`：这条豁免的理由是**被验证过**的。
 *   - 仍绿 → `BLIND`：理由只是**声明**。一旦进白名单，该位置的失败处置再没人查。
 *
 * 两个判据合起来才有意义：REDUNDANT 说明「豁免多余」，BLIND 说明「豁免免检」。
 * 实测（2026-11-17 首版）13 条里 8 条 REDUNDANT、5 条 BLIND、0 条 PASS。
 *
 * BLIND / REDUNDANT 都不算脚本自身出错，但脚本以**非零退出**收尾，
 * 因为「豁免冗余或免检」这件事本身需要有人看见。
 *
 * ## 用法
 *   node .deva/qa/break-allow.cjs            # 跑全部
 *   node .deva/qa/break-allow.cjs --strict   # BLIND 也算失败（CI 用）
 *
 * 产品代码一个字节都不动：全部在 os.tmpdir() 里的副本上做。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const REPO = path.resolve(__dirname, '..', '..')
const SRC = path.join(REPO, 'apps/desktop/src/main')
const SCAN = path.join(__dirname, 'scan-same-class.cjs')
const STRICT = process.argv.includes('--strict')

let blind = 0
let pass = 0
let redundant = 0
const problems = []

/** 读扫描器源码里的 ALLOW 条目（用于判据 A：逐条删掉看是否冗余）。 */
function allowEntries() {
  const src = fs.readFileSync(SCAN, 'utf8')
  const lines = src.split('\n')
  const out = []
  const start = lines.findIndex((l) => /^const ALLOW = \[/.test(l))
  if (start < 0) return out
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\]/.test(lines[i])) break
    const m = /^\s+key: (?:'([^']*)'|"([^"]*)"),?\s*$/.exec(lines[i])
    if (m) out.push({ lineIndex: i, key: m[1] ?? m[2] })
  }
  return out
}

/**
 * 判据 A：把某条 ALLOW 删掉后，扫描还绿吗？
 * 绿 ⇒ 这条豁免是冗余的（删掉不影响任何检查）。
 */
function probeRedundant(entry) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'allow-red-'))
  try {
    const lines = fs.readFileSync(SCAN, 'utf8').split('\n')
    // 结构固定为 `{` / `key:` / `why:` / `}` —— 从 key 上一行起删 4 行
    lines.splice(entry.lineIndex - 1, 4)
    const copy = path.join(dir, 'scan.cjs')
    fs.writeFileSync(copy, lines.join('\n'))
    let red = false
    try {
      execFileSync(process.execPath, [copy], {
        env: { ...process.env, SCAN_ROOT: SRC },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch {
      red = true
    }
    return !red // 仍绿 = 冗余
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** 跑一份源码树上的扫描；返回是否红。 */
function runScan(root) {
  try {
    const out = execFileSync(process.execPath, [SCAN], {
      env: { ...process.env, SCAN_ROOT: root },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { red: false, out }
  } catch (e) {
    return { red: true, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

/** 在副本里替换文本；替换没发生就抛（不能静默失效，否则 PASS 全是假的）。 */
function sub(dir, file, from, to, label) {
  const f = path.join(dir, file)
  const before = fs.readFileSync(f, 'utf8')
  const crlf = before.includes('\r\n')
  const n = crlf ? before.replace(/\r\n/g, '\n') : before
  if (!n.includes(from)) throw new Error(`${label}：要替换的原文没找到（源码结构变了？）`)
  const out = n.replace(from, to)
  const written = crlf ? out.replace(/\n/g, '\r\n') : out
  fs.writeFileSync(f, written)
  // 破坏验证本身的验证：真的改到了，且不是「新代码加了旧代码还在」
  const after = fs.readFileSync(f, 'utf8')
  const na = after.includes('\r\n') ? after.replace(/\r\n/g, '\n') : after
  if (after === before) throw new Error(`${label}：写入后内容未变`)
  if (!na.includes(to)) throw new Error(`${label}：写入后找不到新片段`)
}

function withCopy(tag, mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `allow-${tag}-`))
  fs.cpSync(SRC, dir, { recursive: true })
  try {
    mutate(dir)
    const r = runScan(dir)
    return r
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * 每条 probe：
 *   id      含 ALLOW 编号 + 它守的东西（名字里能看出守哪条豁免）
 *   allow   对应的 ALLOW 键（用于报告和 STALE 核对）
 *   scope   'silent' = 把失败伪装成「没有/成功」，**在扫描器职责内**，抓不到就是漏洞
 *           'logic'  = 方向写反的逻辑错误，扫描器本来就不查这个（它查的是「静默」），
 *                      抓不到不算扫描器失职，但**必须有运行时断言**兜住
 *   why     为什么这个样本「最像它要放行的那种」
 *   mutate  破坏动作
 */
const PROBES = [
  {
    id: 'ALLOW#1 probeLock：锁文件探测改成「探不到就当正在运行」',
    allow: 'importer-gate.ts::existsSync(path)',
    why: '豁免理由是「返 false 只说明没锁文件＝没在运行，这是正确结论」。最像它的坏样本：同样一句 existsSync，但把 false 判成 running——用户会永远看到「原版正在运行」而永远导不进去。',
    mutate: (d) =>
      sub(
        d,
        'importer-gate.ts',
        `  if (!existsSync(path)) return 'free'`,
        `  if (!existsSync(path)) return 'running'`,
        'ALLOW#1'
      )
  },
  {
    id: 'ALLOW#2 lexists：catch 把 EPERM/EBUSY 压回 absent',
    allow: 'importer-skills.ts::lexists(to)',
    why: '这条就是本轮漏掉的第 9 处。最像它的坏样本：保留 lstat（断链仍正确），但 catch 一律返 absent——ACL 拒绝 / 被索引服务占用时会去建链接，覆盖用户手装的同名技能。',
    mutate: (d) =>
      sub(
        d,
        'importer-skills.ts',
        `  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable'
  }`,
        `  } catch (e) {
    return 'absent'
  }`,
        'ALLOW#2'
      )
  },
  {
    id: 'ALLOW#2b lexists 调用方：删掉 unreadable 分支',
    allow: 'importer-skills.ts::lexists(to)',
    why: '探测本身三态正确，但调用方不处理 unreadable（只留 present/absent）——与直接写 existsSync 等价。这是「修了探测、没修处置」。',
    mutate: (d) =>
      sub(
        d,
        'importer-skills.ts',
        `      const at = lexists(to)
      if (at === 'unreadable') {
        if (!builtin) stat.failed.push({ step: 'skills', id: name, reason: 'target-unreadable' })
        continue
      }
      if (at === 'present') {`,
        `      const at = lexists(to)
      if (at === 'present') {`,
        'ALLOW#2b'
      )
  },
  {
    id: 'ALLOW#3 源条目 lstat：外层 catch 的失败通道拆掉',
    allow: 'importer-skills.ts::const st = lstatSync(from)',
    why: '豁免理由是「在 try 内，抛错由外层 catch 接住并记 writeFailureReason——有通道」。最像它的坏样本：try 还在，但 catch 改成空吞——通道没了，报告仍 ok:true。',
    mutate: (d) =>
      sub(
        d,
        'importer-skills.ts',
        `    } catch (e) {
      stat.failed.push({ step: 'skills', id: name, reason: writeFailureReason(e) })
    }`,
        `    } catch {
      /* 吞掉 */
    }`,
        'ALLOW#3'
      )
  },
  {
    id: 'ALLOW#4 countEntries：读失败从 null 改成 0',
    allow: 'importer-gate.ts::return readdirSync(dir, { withFileTypes: true }).filter((d) =>',
    why: '豁免理由是「只影响预览数字，不参与写入」。最像它的坏样本：把 null（不知道该显示多少）压成 0（确定一个都没有）——预览会显示「0 个」并让用户主动放弃导入。',
    mutate: (d) =>
      sub(
        d,
        'importer-gate.ts',
        `    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : null`,
        `    return 0`,
        'ALLOW#4'
      )
  },
  {
    id: 'ALLOW#5 summarize 会话计数：删掉 unreadable 上报',
    allow: 'importer-gate.ts::for (const d of readdirSync(chats, { withFileTypes: true })) {',
    why: '豁免理由是「预览统计，内层有 per-file try 兜底」。最像它的坏样本：外层 catch 改成空吞，整个 data/chats 读不出来时 unreadable 不再上报——预览显示 0 个会话，而屏幕上是绿的。',
    mutate: (d) =>
      sub(
        d,
        'importer-gate.ts',
        `  } catch (e) {
    // 整个目录读不出来：sessions 记 0 是**假的**，必须挂进 unreadable
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') unreadable.push('data/chats')
  }`,
        `  } catch {
    /* 吞掉 */
  }`,
        'ALLOW#5'
      )
  },
  {
    id: 'ALLOW#6 inspectTarget 探针：open 失败改成 usable',
    allow: "importer-target.ts::openSync(to, 'r')",
    why: '豁免理由是「这就是修法本身」。最像它的坏样本：lstat 四态都对，但 open 失败仍报 usable——打不开的文件被当成可覆盖，copyFileSync 先截断再写。',
    mutate: (d) =>
      sub(
        d,
        'importer-target.ts',
        `    return { kind: 'unreadable', error: (e as Error)?.message ?? String(e) }
  }
  return { kind: 'usable', size: st.size }`,
        `    return { kind: 'usable', size: st.size }
  }
  return { kind: 'usable', size: st.size }`,
        'ALLOW#6'
      )
  },
  {
    id: 'ALLOW#7 makeLink：junction 失败也返回成功',
    allow: 'importer-skills.ts::if (!isWin || !isDir) return null',
    why: '豁免理由是「失败由调用方记 link-failed（有通道）」。最像它的坏样本：makeLink 假成功返回 junction——调用方会记进 linked，用户以为技能已导进来。',
    mutate: (d) =>
      sub(
        d,
        'importer-skills.ts',
        `    symlinkSync(target, dest, 'junction')
    return 'junction'
  } catch {
    return null
  }`,
        `    symlinkSync(target, dest, 'junction')
    return 'junction'
  } catch {
    return 'junction'
  }`,
        'ALLOW#7'
      )
  },
  {
    id: 'ALLOW#9 makeLink 的 statSync(target)：读不出时猜成文件（方向反）',
    allow: 'importer-skills.ts::statSync(target)',
    why: '豁免理由是「读不到时按目录猜，失败方向是再试一次 junction，不会写穿」。最像它的坏样本：把猜的方向改成「按文件」——断链时 symlink 用 file 类型，Windows 上必定失败且不再回落 junction，技能被静默丢掉。',
    scope: 'logic',
    mutate: (d) =>
      sub(
        d,
        'importer-skills.ts',
        `    return 'unreadable'
  }
  try {
    symlinkSync(target, dest, isWin ? (isDir ? 'dir' : 'file') : undefined)`,
        `    return null
  }
  try {
    symlinkSync(target, dest, isWin ? (isDir ? 'dir' : 'file') : undefined)`,
        'ALLOW#9'
      )
  },
  {
    id: 'ALLOW#10 isStaleTarget：读失败从「不刷」改成「刷」',
    allow: 'importer-assoc.ts::const st = statSync(to)',
    why: '豁免理由是「返失败 → false → 不刷 mtime，幂等优先，无害」。最像它的坏样本：失败返 true——目标其实没导入成功也把 mtime 刷成现在，下一轮清扫不会删它，坏副本永久留下。',
    mutate: (d) =>
      sub(
        d,
        'importer-assoc.ts',
        `    const st = statSync(to)
    if (!st.isFile()) return false
    return Date.now() - st.mtimeMs > STALE_MTIME_MS
  } catch {
    return false
  }`,
        `    const st = statSync(to)
    if (!st.isFile()) return false
    return Date.now() - st.mtimeMs > STALE_MTIME_MS
  } catch {
    return true
  }`,
        'ALLOW#10'
      )
  },
  {
    id: 'ALLOW#11 copyFileFresh 尺寸校验：调用方 catch 吞掉',
    allow: 'importer-assoc.ts::statSync(to).size',
    why: '豁免理由是「读失败会抛给调用方的 catch 记一条 failure」。最像它的坏样本：调用方改成空 catch——半截副本不再报错，而它看起来和成功副本一样。',
    mutate: (d) =>
      sub(
        d,
        'importer-assoc.ts',
        `        copyFileFresh(from, to)`,
        `        try { copyFileFresh(from, to) } catch { /* 吞掉 */ }`,
        'ALLOW#11'
      )
  },
  {
    id: 'ALLOW#12 源 blob 尺寸：包 try 后静默 continue',
    allow: 'importer-assoc.ts::statSync(join(srcMedia, name))',
    why: '豁免理由是「读失败会抛到本文件 catch 记 failure」。最像它的坏样本：就地包一层 try 静默 continue——读取失败的 media 被跳过且不计数，报告里「媒体 N 个」少了也没人知道。',
    mutate: (d) =>
      sub(
        d,
        'importer-assoc.ts',
        `          const srcSize = statSync(join(srcMedia, name)).size`,
        `          let srcSize = 0
          try { srcSize = statSync(join(srcMedia, name)).size } catch { continue }`,
        'ALLOW#12'
      )
  },
  {
    id: 'ALLOW#13 源 compacted 尺寸：包 try 后静默 continue',
    allow: 'importer-sessions.ts::statSync(join(srcDir, name))',
    why: '豁免理由是「读失败同上抛给 catch 记 failure」。最像它的坏样本：同上就地包 try 静默 continue——那个会话的早期历史被跳过，用户看不到少了一段。',
    mutate: (d) =>
      sub(
        d,
        'importer-sessions.ts',
        `      const srcSize = statSync(join(srcDir, name)).size`,
        `      let srcSize = 0
      try { srcSize = statSync(join(srcDir, name)).size } catch { continue }`,
        'ALLOW#13'
      )
  }
]

/* ── 基线：当前树必须绿，否则下面所有结论都不成立 ── */
const base = runScan(SRC)
if (base.red) {
  console.log('FAIL 基线：当前树本来就红，豁免验证无从判断')
  console.log(base.out.split('\n').filter((l) => /^(BARE|SWALLOW|DISCARD)/.test(l)).slice(0, 4).join('\n'))
  process.exit(1)
}
console.log(`基线：当前树为绿（GUARDED ${(base.out.match(/GUARDED (\d+)/) ?? [])[1] ?? '?'} 处）\n`)

/* ── 判据 A：逐条删掉 ALLOW，看哪条是冗余的 ── */
console.log('═══ 判据 A：这条豁免是必需的吗（删掉它，扫描还绿 ⇒ 冗余）═══\n')
const entries = allowEntries()
const redundantKeys = []
for (const e of entries) {
  const isRedundant = probeRedundant(e)
  if (isRedundant) {
    redundant++
    redundantKeys.push(e.key)
    console.log(`REDUNDANT ${e.key}`)
  } else {
    console.log(`必需      ${e.key}`)
  }
}
console.log(`\n（${entries.length} 条豁免：${entries.length - redundant} 条必需 / ${redundant} 条冗余）\n`)

/* ── 判据 B：逐条破坏，看命中该豁免的位置是否还有东西在查 ── */
/**
 * 探针的职责归属。
 *
 * 扫描器只查一件事：**失败有没有被伪装成「没有 / 成功」**（静默）。它不查「方向写反」。
 * 所以抓不到要分两种说法：
 *   - `silent` 抓不到 ⇒ **扫描器漏了**，这是真漏洞（该补形状）。
 *   - `logic`  抓不到 ⇒ 扫描器本来不负责这个，但**必须有运行时断言**兜住，否则没人管。
 * 混为一谈会让我把「职责外」说成「机制失效」，那是夸大。
 */
const SCOPE = {
  'ALLOW#1': 'logic', // existsSync 返 false 判成 running：方向反，非静默
  'ALLOW#2': 'silent', // EPERM 压成 absent
  'ALLOW#2b': 'silent', // 调用方不处理 unreadable
  'ALLOW#3': 'silent', // 外层 catch 空吞
  'ALLOW#4': 'silent', // null（不知道）压成 0
  'ALLOW#5': 'silent', // 删掉 unreadable 上报
  'ALLOW#6': 'silent', // 打不开 → usable
  'ALLOW#7': 'silent', // junction 失败假成功
  'ALLOW#9': 'logic', // 断链时按文件猜：方向反
  'ALLOW#10': 'logic', // 读失败返 true：方向反
  'ALLOW#11': 'silent', // 调用方空 catch
  'ALLOW#12': 'silent', // 包 try 静默 continue
  'ALLOW#13': 'silent' // 包 try 静默 continue
}
let gap = 0 // silent 类抓不到 = 扫描器真漏洞
let logicOnly = 0 // logic 类抓不到 = 职责外，需运行时断言
console.log('═══ 判据 B：这条豁免的理由被验证过吗（改坏它守的东西，扫描必须红）═══\n')
const results = []
for (const p of PROBES) {
  const tag = /^(ALLOW#[0-9]+b?)/.exec(p.id)?.[1] ?? ''
  const scope = SCOPE[tag] ?? 'silent'
  let r
  try {
    r = withCopy(p.id.replace(/[^\w]+/g, '').slice(0, 16), p.mutate)
  } catch (e) {
    problems.push(`${p.id}：破坏没生效 —— ${e.message}`)
    console.log(`ERROR ${p.id} :: ${e.message}`)
    continue
  }
  if (r.red) {
    pass++
    const hit = r.out.split('\n').filter((l) => /^(BARE|SWALLOW|DISCARD)\s/.test(l))[0] ?? ''
    results.push({ ...p, caught: true, scope })
    console.log(`PASS ${p.id}`)
    if (hit) console.log(`     ↳ 扫描报出：${hit.trim()}`)
  } else if (scope === 'logic') {
    logicOnly++
    results.push({ ...p, caught: false, scope })
    console.log(`NO-CHECK(职责外) ${p.id}`)
    console.log(`     ↳ 豁免：${p.allow}`)
    console.log(`     ↳ 扫描器只查「静默」，不查方向；但没有任何运行时断言拦这个方向错误`)
  } else {
    gap++
    blind++
    results.push({ ...p, caught: false, scope })
    console.log(`GAP ${p.id}`)
    console.log(`     ↳ 豁免：${p.allow}`)
    console.log(`     ↳ 这是静默类（失败被伪装成没有/成功），扫描器职责内却没抓到`)
  }
}

/* ── 汇总 ── */
console.log(
  `\n═══ 汇总 ═══
判据 B（豁免可证伪性，${PROBES.length} 条探针）：
  抓得到 ${pass} 条 / **职责内漏检 ${gap} 条** / 职责外未查 ${logicOnly} 条
判据 A（豁免必需性，${entries.length} 条豁免）：
  必需 ${entries.length - redundant} 条 / 冗余 ${redundant} 条`
)
if (redundantKeys.length) {
  console.log(`\nREDUNDANT（删掉它扫描照样绿 ⇒ 这条豁免根本没在起作用，可直接移除）：`)
  for (const k of redundantKeys) console.log(`  - ${k}`)
}
if (gap > 0) {
  console.log(`\nGAP = 扫描器职责内漏检（失败被伪装成没有/成功，本该抓到却没抓到）。
处置（三条都要做，缺一不可）：
  1. 补形状 —— 在 scan-same-class.cjs 加对应判据（例：三态读取器的返回值必须被 === 'unreadable' 检查）。
  2. 删冗余 —— 上列 REDUNDANT 条目直接移除，豁免越少越好。
  3. 补运行时断言 —— 在 repro-accept 里造出该失败并断言进了 failed（真正验「有通道」的地方）。
`)
}
if (problems.length) {
  console.log(`另有 ${problems.length} 条探针自身失效（源码结构变了，需更新样本）：`)
  for (const x of problems) console.log(`  - ${x}`)
}

const exitCode = gap > 0 || problems.length > 0 ? 1 : 0
process.exit(exitCode)
