/**
 * 破坏验证：guardpath 的「② 本体失败那轮没有 #avatar」这条断言够不够严。
 *
 * 上一轮我说「没拿到干净的反向证据」。这次源码稳定了，做干净：
 * 把「本体 unreadable 后的 continue」去掉 → copyAvatar 会被调用 → ② 那轮多出 #avatar
 * → 断言应变红。
 *
 * 同时也验 ③ 那条：把 copyAvatar 整体禁掉 → ③ 那轮没有 #avatar → 另一条应红。
 * 两条都红才说明它们各自在守一个真实的行为，而不是恒真。
 *
 * 产品代码不动：全部在 tmp 副本上做。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const REPO = 'E:\\deva'

function withCopy(mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpv-'))
  fs.cpSync(REPO, dir, {
    recursive: true,
    filter: (s) => {
      const p = path.relative(REPO, s).split(path.sep)
      return !p.includes('node_modules') && p[0] !== '.git'
    }
  })
  for (const nm of ['node_modules', 'apps/desktop/node_modules']) {
    const src = path.join(REPO, nm)
    const dst = path.join(dir, nm)
    if (!fs.existsSync(src)) continue
    fs.mkdirSync(path.dirname(dst), { recursive: true })
    try {
      fs.symlinkSync(src, dst, 'junction')
    } catch {}
  }
  mutate(dir)
  let out = ''
  let code = 0
  try {
    out = execFileSync(process.execPath, [path.join(dir, '.deva/qa/repro-accept.cjs'), 'guardpath'], {
      cwd: dir,
      env: { ...process.env, QA_SRC: dir },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch (e) {
    code = e.status ?? 1
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
  fs.rmSync(dir, { recursive: true, force: true })
  return { code, out }
}

/** CRLF 归一化 + 找不到就抛（见 break-scan.cjs 的同款说明）。 */
function sub(dir, file, from, to, label) {
  const f = path.join(dir, 'apps/desktop/src/main', file)
  const s = fs.readFileSync(f, 'utf8')
  const crlf = s.includes('\r\n')
  const n = crlf ? s.replace(/\r\n/g, '\n') : s
  if (!n.includes(from)) throw new Error(`${label}：要替换的原文没找到`)
  const out = n.replace(from, to)
  fs.writeFileSync(f, crlf ? out.replace(/\n/g, '\r\n') : out)
}

let fails = 0
const pass = (n, d = '') => console.log(`PASS ${n}${d ? ` :: ${d}` : ''}`)
const fail = (n, d = '') => {
  fails++
  console.log(`FAIL ${n}${d ? ` :: ${d}` : ''}`)
}

/* ── 基线 ── */
const base = withCopy(() => {})
if (base.code === 0) pass('基线：guardpath 13 条全过')
else fail('基线应通过却红', base.out.split('\n').filter((l) => /FAIL/.test(l)).slice(0, 2).join(' | '))

/*
 * 破坏 1 的正确选点：去掉 **unreadable 分支本身**，让它落到 absent（于是会去 copyFileSync +
 * copyAvatar）。
 *
 * 上一版我改的是「去掉 continue」——那抓不到，因为接着的 `copyFileSync` 会抛 EBUSY、被外层
 * catch 记成一条 `locked`（原始消息），头像仍然没被尝试，所以「没有 #avatar」照样成立。
 * 换句话说：那条 continue 在这里是**冗余的**（后面的 copy 会先抛），它守的场景是
 * 「目标可写但读不出」（少见），不是本场景。如实记下这一点。
 *
 * 而「unreadable 分支整体存在」是这条断言真正依赖的东西：没有它，`inspectTarget` 会落到
 * absent → copyFileSync → copyAvatar → 多出 `#avatar`。
 */
const b1 = withCopy((d) => {
  sub(
    d,
    'importer-personas.ts',
    "      if (probe.kind === 'unreadable') {\n        if (!builtin) stat.failed.push({ step: 'personas', id: `${id}#read`, reason: 'target-unreadable' })\n        continue\n      }",
    "      if (probe.kind === 'unreadable') {\n        // 破坏：不再 prior-return，让它落到 absent 分支去 copy\n      }",
    'B1'
  )
})
if (b1.code !== 0 && /② 本体失败那轮/.test(b1.out)) {
  pass('破坏 1：去掉 unreadable 的提前返回 → ② 「只有 #read」那条变红')
  console.log(`     ${b1.out.split('\n').find((l) => /FAIL ② /.test(l))?.slice(0, 140)}`)
} else {
  fail('破坏 1 没被抓到', b1.out.split('\n').filter((l) => /FAIL/.test(l)).slice(0, 2).join(' | '))
}

/* ── 破坏 2：copyAvatar 永远返回 undefined（从不尝试头像）→ ③ 那条应红 ── */
const b2 = withCopy((d) => {
  sub(
    d,
    'importer-personas.ts',
    'function copyAvatar(srcDir: string, dstDir: string, id: string): string | undefined {',
    'function copyAvatar(srcDir: string, dstDir: string, id: string): string | undefined {\n  if (1) return undefined // 破坏：从不尝试头像',
    'B2'
  )
})
if (b2.code !== 0 && /③ 本体成功那轮/.test(b2.out)) {
  pass('破坏 2：头像永不尝试 → ③ 「只有 #avatar」那条变红（证明它不是恒真）')
  console.log(`     ${b2.out.split('\n').find((l) => /FAIL ③ /.test(l))?.slice(0, 140)}`)
} else {
  fail('破坏 2 没被抓到', b2.out.split('\n').filter((l) => /FAIL/.test(l)).slice(0, 2).join(' | '))
}

console.log(`\n${fails === 0 ? '两条断言都有反向证据' : `${fails} 项未按预期`}（fail=${fails}）`)
process.exit(fails === 0 ? 0 : 1)
