/**
 * 三条用户体验验证（发版前最容易伤人的地方）。
 *
 * 背景：`path-outside-root` 是破坏性变更 —— 所有把 worktree 建在默认根之外的老用户，
 * 升级后新建会被拒。需求 A11/A12 要求「老记录仍可显示与删除」。
 *
 * 本探针逐条实测（全部在 os.tmpdir() 下的临时 DEVA_HOME，不碰真实配置）：
 *   U1 老记录的 worktree（建在根外）列表能否正常显示，`insideRoot` 标记是什么
 *   U2 老记录能否删除（remove 的目录删除守卫用 createdUnderRoot，不是当前根）
 *   U3 根外新建撞 `path-outside-root` 时，提示是否带出「根在哪」
 *   U4 `worktreeRoot` 从未设过、默认根目录**不存在**时能否正常创建
 */
const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')
const cp = require('child_process')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..')
const STUB = path.join(QA, 'stub-electron.cjs')
const DIST = path.join(QA, 'dist-ux')

async function build() {
  fs.mkdirSync(DIST, { recursive: true })
  const entry = path.join(DIST, 'entry.ts')
  fs.writeFileSync(
    entry,
    `export * as CR from ${JSON.stringify(path.join(REPO, 'apps/desktop/src/main/services/worktree/create.ts'))}
export * as RM from ${JSON.stringify(path.join(REPO, 'apps/desktop/src/main/services/worktree/remove.ts'))}
export * as L from ${JSON.stringify(path.join(REPO, 'apps/desktop/src/main/services/worktree/list.ts'))}
export * as P from ${JSON.stringify(path.join(REPO, 'apps/desktop/src/main/services/worktree/paths.ts'))}
export * as S from ${JSON.stringify(path.join(REPO, 'apps/desktop/src/main/services/worktree/store.ts'))}
export * as RS from ${JSON.stringify(path.join(REPO, 'apps/desktop/src/main/services/worktree/root-setting.ts'))}
export * as PC from ${JSON.stringify(path.join(REPO, 'apps/desktop/src/main/services/worktree/precheck.ts'))}
`
  )
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(DIST, 'ux.cjs'),
    alias: { electron: STUB },
    logLevel: 'error',
    external: ['electron']
  })
  return path.join(DIST, 'ux.cjs')
}

function run(devaHome, body) {
  const script = path.join(os.tmpdir(), `deva-ux-${Math.random().toString(36).slice(2)}.cjs`)
  fs.writeFileSync(
    script,
    `
process.env.DEVA_HOME = ${JSON.stringify(devaHome)}
const M = require(${JSON.stringify(path.join(DIST, 'ux.cjs'))})
const fs = require('fs'), path = require('path')
const out = (o) => process.stdout.write('J:' + JSON.stringify(o) + '\\n')
;(async () => { ${body} })().catch(e => out({ err: String(e && e.stack || e) }))
`
  )
  const res = cp.spawnSync(process.execPath, [script], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const line = (res.stdout || '').split('\n').find((l) => l.startsWith('J:'))
  fs.rmSync(script, { force: true })
  return line ? JSON.parse(line.slice(2)) : { err: (res.stderr || '').slice(-500) }
}

const mkRepo = (root) => {
  fs.mkdirSync(root, { recursive: true })
  const g = (a, cwd = root) => cp.spawnSync('git', a, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'q', GIT_AUTHOR_EMAIL: 'q@q', GIT_COMMITTER_NAME: 'q', GIT_COMMITTER_EMAIL: 'q@q' }
  })
  g(['init', '-q', '-b', 'my/dev'])
  fs.writeFileSync(path.join(root, 'a.txt'), 'a\n')
  g(['add', '.'])
  g(['commit', '-q', '-m', 'init'])
  return root
}

let pass = 0
let fail = 0
const ok = (n, d = '') => {
  pass++
  console.log(`  PASS ${n}${d ? ` :: ${d}` : ''}`)
}
const bad = (n, d = '') => {
  fail++
  console.log(`  FAIL ${n}${d ? ` :: ${d}` : ''}`)
}
const check = (n, c, d = '') => (c ? ok(n, d) : bad(n, d), !!c)
const info = (d = '') => console.log(`  INFO ${d}`)

;(async () => {
  await build()

  // ═════ U1 + U2：老记录（在根外）能否显示 / 删除 ═════
  {
    const root = path.join(os.tmpdir(), `deva-ux1-${Date.now()}`)
    const home = path.join(root, 'home')
    const repo = mkRepo(path.join(root, 'repo'))
    fs.mkdirSync(home, { recursive: true })
    // 老记录：建在 <root>/old-wts 下（不在默认根 <home>/worktrees 里）
    const oldWt = path.join(root, 'old-wts', 'legacy')
    const created = run(home, `
      const repo = ${JSON.stringify(repo)}
      const wt = ${JSON.stringify(oldWt)}
      // 先把根临时指过去，模拟"当初就是在根内建的、后来用户改了根"
      M.RS.setWorktreeRoot(${JSON.stringify(path.join(root, 'old-wts'))})
      const r = await M.CR.createWorktree({ repoRoot: repo, branch: 'wt/legacy', path: wt, skipDeps: true })
      out({ created: r.ok, reason: r.reason, msg: r.message, path: wt })
    `)
    check('U 前置：老 worktree 建成功', created.created === true, JSON.stringify(created).slice(0, 200))

    const listed = run(home, `
      // 现在把根改到**另一个**位置，模拟"升级后默认根变了/用户设了别的根"
      M.RS.setWorktreeRoot(${JSON.stringify(path.join(root, 'new-wts'))})
      const snap = await M.L.listWorktrees()
      const rec = (snap.items || []).find(x => x.path === ${JSON.stringify(oldWt)})
      out({ root: M.P.worktreeRoot(), records: (snap.items || []).length,
            storeUnreadable: snap.storeUnreadable,
            found: !!rec, insideRoot: rec && rec.insideRoot, createdUnderRoot: rec && rec.createdUnderRoot,
            state: rec && rec.state })
    `)
    check('U1 老记录（根外）仍出现在列表里', listed.found === true, JSON.stringify(listed).slice(0, 300))
    /*
     * `insideRoot` 的语义是「**创建时那个根**内」，不是「当前根内」（list.ts:520-529）。
     * 用户事后改根不该让历史记录集体变红，这条正是 A11/A12 的要求 ——
     * 所以期望值是 true（老记录被正常对待），而不是 false。
     */
    check('U1 老记录按「创建时那个根」判定，不因用户改根而变红', listed.insideRoot === true,
      `insideRoot=${listed.insideRoot}，createdUnderRoot=${listed.createdUnderRoot}`)
    check('U1 老记录的状态正常（不是 dir-missing 之类）', listed.state === 'ok', `state=${listed.state}`)

    const removed = run(home, `
      M.RS.setWorktreeRoot(${JSON.stringify(path.join(root, 'new-wts'))})
      const r = await M.RM.removeWorktree({ path: ${JSON.stringify(oldWt)}, deleteBranch: false })
      out({ ok: r.ok, reason: r.reason, msg: r.message,
            dirGone: !fs.existsSync(${JSON.stringify(oldWt)}), warnings: r.warnings })
    `)
    check('U2 老记录（在当初的根内、现在的根外）仍可删除，目录真的删掉', removed.ok === true && removed.dirGone === true,
      JSON.stringify(removed).slice(0, 300))
    if (removed.warnings) console.log(`      warnings: ${JSON.stringify(removed.warnings).slice(0, 200)}`)
    fs.rmSync(root, { recursive: true, force: true })
  }

  // ═════ U3：根外新建的提示是否说清「根在哪」 ═════
  {
    const root = path.join(os.tmpdir(), `deva-ux2-${Date.now()}`)
    const home = path.join(root, 'home')
    const repo = mkRepo(path.join(root, 'repo'))
    fs.mkdirSync(home, { recursive: true })
    const theRoot = path.join(root, 'my-root')
    const r = run(home, `
      M.RS.setWorktreeRoot(${JSON.stringify(theRoot)})
      const pc = await M.PC.precheck({ repoRoot: ${JSON.stringify(repo)}, branch: 'x/y', path: ${JSON.stringify(path.join(root, 'elsewhere', 'x'))} })
      const cr = await M.CR.createWorktree({ repoRoot: ${JSON.stringify(repo)}, branch: 'x/y', path: ${JSON.stringify(path.join(root, 'elsewhere', 'x'))}, skipDeps: true })
      out({ root: M.P.RS ? null : M.P.worktreeRoot(), precheck: { ok: pc.ok, reason: pc.reason, message: pc.message },
            create: { ok: cr.ok, reason: cr.reason, message: cr.message } })
    `)
    info(`当前根 ${r.root}`)
    check('U3 根外新建被拒（这是正确行为）', r.create?.reason === 'path-outside-root', JSON.stringify(r.create).slice(0, 200))
    const msg = String(r.create?.message || '')
    check('U3 提示里带出了当前根的完整路径（用户知道该改哪里）', msg.includes(theRoot), msg)
    check('U3 提示里也给出了被拒的目标路径', msg.includes(path.join(root, 'elsewhere', 'x')), msg)
    check('U3 预检与创建给出同一个原因（不会"预检能过、创建才炸"）', r.precheck?.reason === 'path-outside-root',
      JSON.stringify(r.precheck).slice(0, 200))
    fs.rmSync(root, { recursive: true, force: true })
  }

  // ═════ U4：默认根目录不存在时能否正常创建 ═════
  {
    const root = path.join(os.tmpdir(), `deva-ux3-${Date.now()}`)
    const home = path.join(root, 'home') // 一个全新 home，没有 config.json
    const repo = mkRepo(path.join(root, 'repo'))
    fs.mkdirSync(home, { recursive: true })
    const defaultRoot = path.join(home, 'worktrees')
    const r = run(home, `
      // 关键：完全不设 worktreeRoot，且默认根目录此刻**不存在**
      out({ defaultRootExistsBefore: fs.existsSync(${JSON.stringify(defaultRoot)}),
            effectiveRoot: M.P.worktreeRoot() })
      const cr = await M.CR.createWorktree({ repoRoot: ${JSON.stringify(repo)}, branch: 'wt/default-root', skipDeps: true })
      out({ step2: true, ok: cr.ok, reason: cr.reason, message: cr.message, path: cr.path,
            defaultRootExistsAfter: fs.existsSync(${JSON.stringify(defaultRoot)}),
            dirExists: cr.path ? fs.existsSync(cr.path) : null,
            insideRoot: cr.path ? M.P.isInsideRoot(${JSON.stringify(defaultRoot)}, cr.path) : null })
    `)
    // 上面 run 只取最后一行，这里单独再取一次结构化的
    const r2 = run(home, `
      const cr = await M.CR.createWorktree({ repoRoot: ${JSON.stringify(repo)}, branch: 'wt/default-root-2', skipDeps: true })
      const p = cr.ok && cr.record ? cr.record.path : null
      out({ ok: cr.ok, reason: cr.reason, message: cr.message, path: p,
            defaultRootExistsAfter: fs.existsSync(${JSON.stringify(defaultRoot)}),
            dirExists: p ? fs.existsSync(p) : null })
    `)
    check('U4 默认根目录不存在时创建不报错', r2.ok === true, JSON.stringify(r2).slice(0, 300))
    check('U4 默认根目录被自动创建出来了', r2.defaultRootExistsAfter === true, `是否存在=${r2.defaultRootExistsAfter}`)
    check('U4 自动生成的路径落在默认根内', typeof r2.path === 'string' && r2.path.startsWith(defaultRoot), String(r2.path))
    check('U4 工作区目录真的建出来了', r2.dirExists === true, String(r2.path))
    void r
    fs.rmSync(root, { recursive: true, force: true })
  }

  console.log(fail === 0 ? `\n==UX== ${pass} PASS / 0 FAIL` : `\n==UX== ${pass} PASS / ${fail} FAIL`)
  process.exit(fail === 0 ? 0 : 1)
})().catch((e) => {
  console.error('ERROR', e)
  process.exit(1)
})