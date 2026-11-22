#!/usr/bin/env node
/**
 * 真机验证 `rebuildWorktree` / `removeWorktree` 的后端行为（真实 git 仓库，非源码形状）。
 *
 * ## 为什么必须跑真机
 *
 * `check-worktree-wiring.cjs` 只证明「界面调用了这两个函数」，不证明函数真的把 git 弄对了。
 * 而这里的失效方式全是安静的：
 *   · 重建返回 ok:true，但目录其实没建出来（A34 专门要防的假成功）
 *   · 重建把分支新建了一份（带 -b），看起来成功，实际与记录里的分支成了两条
 *   · prune 顺手把分支也删了——分支上是用户还没合走的提交，删了找不回来
 *   · 成功路径不刷新，界面停在旧数据
 *
 * ## 隔离（本文件的红线）
 *
 * 全部夹具在 `os.tmpdir()/deva-wtverify-*` 下：临时 git 仓库、临时 worktree 目录、
 * 临时 DEVA_HOME。**绝不碰**用户真实仓库与 `~/.deva-plus`。
 * 每条用例结束只删自己造的那个临时根。
 *
 * ## 判据
 *   B1 dir-missing → rebuild 成功，目录真的回来了
 *   B2 rebuild 成功后 HEAD 在该分支上（不是新建的同名分支、不是游离头）
 *   B3 rebuild 回读核对不过时必须 ok:false（构造 dir-exists 触发前置拒绝）
 *   B4 branch-missing → rebuild 报 branch-missing，且不偷偷新建分支
 *   B5 prunable → remove（prune 用法）只清登记，**分支仍在**
 *   B6 prune 后 git worktree list 里不再有那条
 *   B7 not-found → rebuild / remove 都明确报 not-found，不静默成功
 */
const esbuild = require('esbuild')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const QA = __dirname
const REPO = path.resolve(QA, '..', '..')
const SRC = path.join(REPO, 'apps', 'desktop', 'src', 'main', 'services', 'worktree')
const DIST = path.join(QA, 'dist')

/** 每条用例一个独立临时根；用完只删自己这个。 */
function mkroot(tag) {
  const root = path.join(os.tmpdir(), `deva-wtverify-${tag}-${Date.now()}`)
  fs.mkdirSync(root, { recursive: true })
  return root
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** 造一个「主仓库 + 一条 feat 分支」的最小现场。返回主仓库路径。 */
function setupRepo(root) {
  const main = path.join(root, 'main')
  fs.mkdirSync(main, { recursive: true })
  git(main, 'init', '-q')
  git(main, 'config', 'user.email', 'qa@local')
  git(main, 'config', 'user.name', 'qa')
  fs.writeFileSync(path.join(main, 'a.txt'), 'hello\n')
  git(main, 'add', '.')
  git(main, 'commit', '-q', '-m', 'init')
  // 固定分支名，避免不同 git 版本默认分支名（master/main）差异影响断言
  git(main, 'branch', '-M', 'main')
  git(main, 'branch', 'feat-x')
  return main
}

async function buildBundle() {
  fs.mkdirSync(DIST, { recursive: true })
  // 把需要的入口打成一个 cjs，external electron（rebuild/remove 不依赖 electron 运行时）
  const entry = path.join(DIST, 'entry.ts')
  fs.writeFileSync(
    entry,
    `export { rebuildWorktree } from ${JSON.stringify(path.join(SRC, 'rebuild.ts'))}
export { removeWorktree } from ${JSON.stringify(path.join(SRC, 'remove.ts'))}
export { upsertRecord, reloadRecordsForTest } from ${JSON.stringify(path.join(SRC, 'store.ts'))}
export { normalizeWorktreePath } from ${JSON.stringify(path.join(SRC, 'paths.ts'))}
`
  )
  await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    outfile: path.join(DIST, 'wtverify.cjs'),
    external: ['electron'],
    logLevel: 'error',
    define: { 'process.env.NODE_ENV': '"test"' }
  })
  return path.join(DIST, 'wtverify.cjs')
}

/**
 * 写入一条 active 记录。字段必须齐全——`rebuildWorktree` / `removeWorktree` 都按
 * `phase`、`branch`、`repoRoot` 做前置判定，缺字段会走到「不是 active」的分支，
 * 于是测出来的不是真实路径。
 */
function seedRecord(mod, { path: wtPath, branch, repoRoot }) {
  const now = Date.now()
  const compareKey = mod.normalizeWorktreePath(wtPath)
  const ok = mod.upsertRecord({
    schemaVersion: 1,
    path: wtPath,
    compareKey,
    repoRoot,
    repoKey: mod.normalizeWorktreePath(repoRoot),
    branch,
    baseSha: '',
    baseLabel: 'main',
    targetBranch: 'main',
    createdAt: now,
    phase: 'active',
    intent: { branchExistedAtStart: true, pathExistedAtStart: false },
    deps: 'skipped'
  })
  if (!ok) throw new Error(`upsertRecord 失败：${wtPath}`)
  return compareKey
}

const results = []
function check(id, name, ok, detail) {
  results.push({ id, name, ok, detail })
  const tag = ok ? 'PASS' : 'FAIL'
  console.log(`  ${tag} ${id} ${name}${detail ? ` :: ${detail}` : ''}`)
}

async function main() {
  // 隔离红线：store 会往 DEVA_HOME/worktrees.json 写记录。必须在 require 之前就指到临时目录，
  // 否则会写进用户真实的 ~/.deva-plus ——这正是上次卸载实测踩过的坑。
  const devaHome = path.join(os.tmpdir(), `deva-wtverify-home-${Date.now()}`)
  fs.mkdirSync(devaHome, { recursive: true })
  process.env.DEVA_HOME = devaHome
  console.log(`临时 DEVA_HOME: ${devaHome}`)

  const bundle = await buildBundle()
  const mod = require(bundle)

  // ── 用例组 A：dir-missing → rebuild 成功（B1 / B2）────────────────────────
  {
    const root = mkroot('rebuild')
    const main = setupRepo(root)
    const wtPath = path.join(root, 'wt-a')
    try {
      // 造：分支检出到 wt-a，登记进 store，然后手工删掉目录（= 用户 rm -rf）
      git(main, 'worktree', 'add', '-q', wtPath, 'feat-x')
      seedRecord(mod, { path: wtPath, branch: 'feat-x', repoRoot: main })
      fs.rmSync(wtPath, { recursive: true, force: true })

      const res = await mod.rebuildWorktree({ path: wtPath })
      check('B1', 'dir-missing → rebuild 成功且目录回来', res.ok === true && fs.existsSync(wtPath), `ok=${res.ok} exists=${fs.existsSync(wtPath)} reason=${res.reason ?? '-'}`)

      // B2：HEAD 必须在该分支上，且分支只有一条（没被 -b 新建成第二条）
      let headBranch = ''
      let branchCount = 0
      try {
        headBranch = git(wtPath, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
        branchCount = git(main, 'branch', '--list', 'feat-x').split('\n').filter(Boolean).length
      } catch (e) {
        headBranch = `<err:${e.message.slice(0, 40)}>`
      }
      check(
        'B2',
        'rebuild 后 HEAD 在 feat-x 且分支未重复',
        headBranch === 'feat-x' && branchCount === 1,
        `HEAD=${headBranch} feat-x 分支数=${branchCount}`
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }

  // ── 用例组 B：branch-missing（B3 / B4）──────────────────────────────────
  {
    const root = mkroot('branchmiss')
    const main = setupRepo(root)
    const wtPath = path.join(root, 'wt-b')
    try {
      git(main, 'worktree', 'add', '-q', wtPath, 'feat-x')
      seedRecord(mod, { path: wtPath, branch: 'feat-x', repoRoot: main })
      fs.rmSync(wtPath, { recursive: true, force: true })
      // 删掉分支前必须先清掉 git 登记：分支还被那条登记占着，直接 -D 会被拒。
      // 真实用户的操作顺序也是这样（目录没了 → prune → 才可能删分支）。
      git(main, 'worktree', 'prune')
      git(main, 'branch', '-D', 'feat-x')

      const res = await mod.rebuildWorktree({ path: wtPath })
      check('B4', 'branch-missing → 报 branch-missing', res.ok === false && res.reason === 'branch-missing', `ok=${res.ok} reason=${res.reason ?? '-'}`)

      const stillGone = git(main, 'branch', '--list', 'feat-x').trim() === ''
      check('B3', 'branch-missing 时不偷偷新建分支', stillGone, stillGone ? 'feat-x 仍不存在' : 'feat-x 被建出来了')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }

  // ── 用例组 C：prunable → prune 只清登记、分支保留（B5 / B6）──────────────
  {
    const root = mkroot('prune')
    const main = setupRepo(root)
    const wtPath = path.join(root, 'wt-c')
    try {
      git(main, 'worktree', 'add', '-q', wtPath, 'feat-x')
      seedRecord(mod, { path: wtPath, branch: 'feat-x', repoRoot: main })
      // prunable 的现场：目录没了
      fs.rmSync(wtPath, { recursive: true, force: true })

      // prune 在界面上走的就是 remove({ path, deleteBranch: false })：
      // 不带 deleteBranch 会走「删整个工作区」的默认语义，连分支一起删掉。
      const res = await mod.removeWorktree({ path: wtPath, deleteBranch: false })
      check('B5a', 'prune 调用返回 ok', res.ok === true, `ok=${res.ok} reason=${res.reason ?? '-'}`)

      const branchAlive = git(main, 'branch', '--list', 'feat-x').trim() !== ''
      check('B5b', 'prune 后分支 feat-x 仍在', branchAlive, branchAlive ? '分支保留' : '分支被删了')

      const list = git(main, 'worktree', 'list', '--porcelain')
      const stillListed = list.includes(wtPath.replace(/\\/g, '/')) || list.includes(wtPath)
      check('B6', 'prune 后 git 登记里没有那条', !stillListed, stillListed ? '登记仍在' : '登记已清')
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }

  // ── 用例组 D：not-found（B7）────────────────────────────────────────────
  {
    const root = mkroot('notfound')
    try {
      const ghost = path.join(root, 'never-existed')
      const rb = await mod.rebuildWorktree({ path: ghost })
      const rm = await mod.removeWorktree({ path: ghost })
      check(
        'B7',
        'not-found → rebuild/remove 都不静默成功',
        rb.ok === false && rb.reason === 'not-found' && rm.ok === false && rm.reason === 'not-found',
        `rebuild=${rb.reason ?? rb.ok} remove=${rm.reason ?? rm.ok}`
      )
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }

  const fails = results.filter((r) => !r.ok).length
  console.log('')
  if (fails === 0) {
    console.log(`worktree 后端行为校验通过：${results.length} 项（真实 git 仓库，临时目录）`)
    process.exit(0)
  }
  console.log(`worktree 后端行为校验失败：${fails}/${results.length} 项`)
  process.exit(1)
}

main().catch((e) => {
  console.error('运行出错：', e && e.stack ? e.stack : e)
  process.exit(2)
})
