/**
 * 验 `WorktreeRootView.defaultRoot`：
 *   1. 缺键时 defaultRoot === root（且等于 <DEVA_HOME>/worktrees）
 *   2. 设过自定义根时 defaultRoot 仍是默认值，root 是自定义值
 *   3. `DEVA_HOME` 变了，defaultRoot 跟着变（这正是不能在渲染层写死的原因）
 *   4. root 与 defaultRoot 来自同一次调用，自洽
 *   5. `setWorktreeRoot(undefined)` 仍是删键恢复默认（语义没被改动）
 */
const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..')
const SRC = path.join(REPO, 'apps', 'desktop', 'src')
const DIST = path.join(QA, 'dist', 'wtroot')

let pass = 0
let fail = 0
const ok = (n, d) => {
  pass += 1
  console.log(`  PASS ${n}${d ? ' :: ' + d : ''}`)
}
const bad = (n, d) => {
  fail += 1
  console.log(`  FAIL ${n}${d ? ' :: ' + d : ''}`)
}
const eq = (n, got, want) => (got === want ? ok(n, String(got)) : bad(n, `期望 ${want}，实际 ${got}`))

async function build() {
  fs.mkdirSync(DIST, { recursive: true })
  const entry = path.join(DIST, 'entry.ts')
  fs.writeFileSync(
    entry,
    `export { readWorktreeRoot, setWorktreeRoot } from ${JSON.stringify(
      path.join(SRC, 'main/services/worktree/root-setting.ts')
    )}
export { defaultWorktreeRoot } from ${JSON.stringify(path.join(SRC, 'main/services/worktree/paths.ts'))}
`
  )
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(DIST, 'wtroot.cjs'),
    alias: { electron: path.join(QA, 'stubs', 'electron.cjs') },
    logLevel: 'error'
  })
  return require(path.join(DIST, 'wtroot.cjs'))
}

/** 在独立子进程里跑，保证每次 DEVA_HOME 干净。 */
function runCase(home, body) {
  const script = path.join(DIST, `case-${Math.random().toString(36).slice(2)}.cjs`)
  fs.writeFileSync(
    script,
    `process.env.DEVA_HOME = ${JSON.stringify(home)}
const M = require(${JSON.stringify(path.join(DIST, 'wtroot.cjs'))})
const out = (() => { ${body} })()
process.stdout.write('J:' + JSON.stringify(out))
`
  )
  const { execFileSync } = require('child_process')
  const stdout = execFileSync(process.execPath, [script], { encoding: 'utf8' })
  const m = stdout.match(/J:(.+)$/)
  fs.rmSync(script, { force: true })
  if (!m) throw new Error('子进程没输出：' + stdout.slice(-300))
  return JSON.parse(m[1])
}

async function main() {
  await build()
  const root = path.join(os.tmpdir(), `wtrootchk-${Date.now()}`)

  console.log('-- 1. 缺键：root === defaultRoot === <DEVA_HOME>/worktrees --')
  for (const name of ['homeA', 'homeB']) {
    const home = path.join(root, name)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'config.json'), '{}')
    const v = runCase(home, 'return M.readWorktreeRoot()')
    eq(`1a[${name}] isDefault`, v.isDefault, true)
    eq(`1b[${name}] defaultRoot 以 home 结尾`, path.basename(v.defaultRoot), 'worktrees')
    eq(
      `1c[${name}] defaultRoot 落在该 DEVA_HOME 下`,
      v.defaultRoot.toLowerCase().includes(name.toLowerCase()),
      true
    )
    eq(`1d[${name}] root === defaultRoot`, v.root, v.defaultRoot)
  }

  console.log('\n-- 2. DEVA_HOME 不同 → defaultRoot 不同（证明不能写死） --')
  {
    const a = path.join(root, 'homeA')
    const b = path.join(root, 'homeB')
    const va = runCase(a, 'return M.readWorktreeRoot()')
    const vb = runCase(b, 'return M.readWorktreeRoot()')
    if (va.defaultRoot !== vb.defaultRoot) ok('2a 两个 DEVA_HOME 的 defaultRoot 不同', `${va.defaultRoot} vs ${vb.defaultRoot}`)
    else bad('2a 两个 DEVA_HOME 的 defaultRoot 竟相同', va.defaultRoot)
  }

  console.log('\n-- 3. 自定义根：root 是自定义，defaultRoot 仍是默认 --')
  {
    const home = path.join(root, 'homeA')
    const custom = path.join(root, 'custom-wt')
    fs.mkdirSync(custom, { recursive: true })
    const v = runCase(
      home,
      `const before = M.readWorktreeRoot()
       const set = M.setWorktreeRoot(${JSON.stringify(custom)})
       const after = M.readWorktreeRoot()
       return { before, set, after }`
    )
    eq('3a 设置成功', v.set.ok, true)
    eq('3b 设置后 isDefault', v.after.isDefault, false)
    eq('3c 设置后 root 变了', v.after.root === v.before.root, false)
    eq('3d 设置后 defaultRoot 未变', v.after.defaultRoot, v.before.defaultRoot)
    eq('3e root !== defaultRoot（此时两者应不同）', v.after.root !== v.after.defaultRoot, true)
  }

  console.log('\n-- 4. setWorktreeRoot(undefined) 仍是删键恢复默认 --')
  {
    const home = path.join(root, 'homeA')
    const custom = path.join(root, 'custom-wt')
    const v = runCase(
      home,
      `const set1 = M.setWorktreeRoot(${JSON.stringify(custom)})
       const set2 = M.setWorktreeRoot(undefined)
       const view = M.readWorktreeRoot()
       const raw = require('fs').readFileSync(require('path').join(process.env.DEVA_HOME,'config.json'),'utf8')
       return { set2, view, hasKey: Object.prototype.hasOwnProperty.call(JSON.parse(raw), 'worktreeRoot') }`
    )
    eq('4a 恢复默认成功', v.set2.ok, true)
    eq('4b 恢复后 isDefault', v.view.isDefault, true)
    eq('4c 恢复后 root === defaultRoot', v.view.root, v.view.defaultRoot)
    eq('4d config.json 里没有 worktreeRoot 键（是删键不是写默认值）', v.hasKey, false)
  }

  fs.rmSync(root, { recursive: true, force: true })
  console.log(fail === 0 ? `\n==RESULT== ${pass} PASS / 0 FAIL` : `\n==RESULT== ${pass} PASS / ${fail} FAIL`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(1)
})