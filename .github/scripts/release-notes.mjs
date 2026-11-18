/**
 * 生成 Release 版本说明：取上一个版本 tag 到本次之间的提交，按提交前缀（feat: / fix: …）分组成 Markdown。
 * CI 把结果写进草稿 Release，发版人在 GitHub 上看过、按需改写后再点「发布」。
 *
 * 只收面向用户的类型；docs / style / build / chore / ci / test 跳过（草稿里需要的话手动补）。
 * 正式版从上一个正式版算起（跳过中间的 beta 等预发布 tag），预发布版从上一个任意版本 tag 算起。
 *
 * 用法：node .github/scripts/release-notes.mjs <tag> [ref]
 *   ref 默认等于 tag；tag 还没打时可传 HEAD 本地预览，如 node .github/scripts/release-notes.mjs v0.1.7 HEAD
 * 需要完整的提交历史与 tag（CI 里 checkout 要 fetch-depth: 0）。
 */
import { execFileSync } from 'node:child_process'

// 指向本 fork：Release 里的「完整变更」链接拿的是本仓的 tag，指向上游会 404
const REPO_URL = 'https://github.com/luceln/deva'

const GROUPS = [
  { title: '新功能 / New Features', types: ['feat'] },
  { title: '问题修复 / Bug Fixes', types: ['fix'] },
  { title: '其他改进 / Other Improvements', types: ['perf', 'refactor', null] } // null = 没按约定写前缀的提交
]
const SKIP = new Set(['docs', 'style', 'build', 'chore', 'ci', 'test'])

const [, , tag, ref = tag] = process.argv
if (!tag) {
  console.error('用法：node .github/scripts/release-notes.mjs <tag> [ref]')
  process.exit(1)
}

// stderr 收进异常而不是直接打到终端：「找不到上一个 tag」属正常情况，不该在日志里冒 fatal
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/**
 * 找上一个版本 tag。
 *
 * 关键：**只能拿本仓自己发过的 tag 当基准**。这个仓库是 fork，本地存在大量上游的 tag（v0.1.5 … v0.1.16），
 * 它们指向上游提交，拿它们当基准会把上游几十条提交算进「本版新增」——首个二开发版 v0.1.16-plus.1
 * 就踩过这个坑：CI 里 tag 刚建、`v0.1.16-plus.1^` 上还没有任何 plus tag，`git describe` 一路退回上游的
 * v0.1.16，版本说明里混进 33 条上游提交。
 *
 * 判据：本仓的 tag 与上游 tag 的区别在于**它不在 upstream-mirror 的历史里**——上游 tag 都能从
 * upstream-mirror 到达，本仓自己的不能。这样不依赖 tag 名的形状（`-plus.N` 只是当前习惯，将来换写法
 * 也不用改这里）。拿不到 upstream-mirror（浅克隆、分支改名）时退回「名字带 -plus.」，宁可基准选得
 * 保守，也不能把上游提交算进来。
 */
function previousTag() {
  let isOwnTag
  try {
    const upstream = new Set(git('tag', '--merged', 'upstream-mirror').split('\n').filter(Boolean))
    isOwnTag = (t) => !upstream.has(t)
  } catch {
    isOwnTag = (t) => t.includes('-plus.') // 没有 upstream-mirror 分支时的兜底
  }

  try {
    // 取 ref 之前最近的、本仓自己的 tag。用 describe 而不是按版本号排序：
    // 上游升版后我们的 plus 号可能小于上游号，排序会选错基准。
    const all = git('tag', '--list', 'v*', '--merged', `${ref}^`)
      .split('\n')
      .filter(Boolean)
      // 排除当前正在生成的这个 tag 自身：tag 已打上后再重跑（如修正说明）时，
      // `${ref}^` 上能到达它，不排除会得到空范围
      .filter((t) => t !== tag)
    const own = all.filter(isOwnTag)
    if (own.length === 0) return null

    const excludes = all.filter((t) => !isOwnTag(t)).flatMap((t) => ['--exclude', t])
    const out = git('describe', '--tags', '--abbrev=0', '--match', 'v*', ...excludes, `${ref}^`)
    // describe 可能挑到一个上游 tag（--exclude 与 --merged 的组合边界），再核一次
    return isOwnTag(out) ? out : null
  } catch {
    return null // 第一个版本：之前没有本仓自己的 tag
  }
}

const prev = previousTag()

/**
 * 提交范围。
 *
 * 有上一个本仓 tag 时取 `prev..ref`；没有（首个二开发版）时**不能直接取 `ref`**——那会把 fork 之前
 * 的全部上游历史都算进来（实测 264 条，其中绝大多数是上游的）。首个版本应该只算「本仓自己做的」，
 * 即从上游最新镜像点 `upstream-mirror` 到 ref 之间的提交。
 *
 * 拿不到 upstream-mirror 时退回 `ref`，并在说明里标出这是首个版本，让人知道范围可能偏大。
 */
function commitRange() {
  if (prev) return `${prev}..${ref}`
  try {
    // upstream-mirror 是上游镜像分支，从它到 ref 就是本仓的全部改动
    git('rev-parse', '--verify', 'upstream-mirror')
    return `upstream-mirror..${ref}`
  } catch {
    return ref
  }
}

const subjects = git('log', '--no-merges', '--pretty=format:%s', commitRange())
  .split('\n')
  .filter(Boolean)

const buckets = new Map(GROUPS.map((g) => [g, []]))
for (const subject of subjects) {
  // type(scope)!: 说明 —— scope 是给开发者看的，版本说明里去掉
  const m = /^([a-z]+)(?:\([^)]*\))?!?:\s*(.+)$/i.exec(subject)
  const type = m ? m[1].toLowerCase() : null
  if (type && SKIP.has(type)) continue
  const group = GROUPS.find((g) => g.types.includes(type)) ?? GROUPS[2]
  buckets.get(group).push(m ? m[2] : subject)
}

const sections = []
for (const [group, items] of buckets) {
  if (items.length) sections.push(`## ${group.title}\n\n${items.map((s) => `- ${s}`).join('\n')}`)
}
if (!sections.length) sections.push('本版本没有面向用户的改动。 / No user-facing changes in this release.')
sections.push(
  prev
    ? `**完整变更 / Full Changelog**: ${REPO_URL}/compare/${prev}...${tag}`
    : `**完整变更 / Full Changelog**: ${REPO_URL}/commits/${tag}`
)
console.log(sections.join('\n\n'))
