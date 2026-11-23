import { lstatSync } from 'fs'
import { dirname, join } from 'path'
import { runGitRaw } from '../git'
import { trustRoot } from '../fs-guard'
import {
  MAX_PATH_LEN,
  compareKeyOfPath,
  isInsideRepo,
  isInsideRoot,
  normalizeWorktreePath,
  repoKeyOf,
  slugifyBranch,
  worktreeRoot
} from './paths'
import { findRecordByRepo } from './store'

/**
 * Step 0 · 探测（`worktree:precheck`）。**无副作用**——不建目录、不建分支、不写记录。
 *
 * 只在创建前把这些「先决条件」全部核一遍并给出结构化结论，让界面能逐条说清「为什么不能建」。
 * spec §3.1 那张表的 11 条，这里逐条对应。
 */

/** 探测结果（spec §7.2 的 PrecheckResult，只摘本步用到的字段）。 */
export interface PrecheckOk {
  ok: true
  repoRoot: string
  defaultBase: string
  defaultBaseLabel: string
  baseSha: string
  baseLabel: string
  targetBranch: string | null
  primaryDetached: boolean
  mergeTargetWarning?: string
  path: string
  branch: string
  slug: string
  dirtyCount: number
  needsConfirm: boolean
  softWarn?: 'many-worktrees'
  existingCount: number
}

export type PrecheckFailReason =
  | 'not-a-repo'
  | 'bad-base'
  | 'bad-branch'
  | 'branch-exists'
  | 'path-exists'
  | 'path-too-long'
  | 'path-inside-repo'
  | 'path-outside-root'
  | 'slug-collision'
  | 'no-git'
  | 'error'

export interface PrecheckFail {
  ok: false
  reason: PrecheckFailReason
  /** 给人看的原因（主进程按界面语言出，渲染层直接显示）。 */
  message: string
  /** 可执行的替代方案（如 branch-exists 时给自动后缀）。 */
  suggestion?: string
}

export interface PrecheckRequest {
  repoRoot: string
  baseRef?: string
  branch?: string
  path?: string
  confirmedDirty?: boolean
}

const SHA_RE = /^[0-9a-f]{40}$/

/**
 * 0.7 的「路径已存在」判断。
 *
 * **spec 写的是 `existsSync`，但裸 `existsSync` 在本项目是明确禁止的**（AGENTS.md）：它对无权限、
 * 被别的进程占用、写了一半的文件、断链一律返回 false，于是「不知道」被读成「不存在」，
 * 后面 `git worktree add` 会撞上去。这里把它拆成四种：
 *
 *  - `absent`：确实没有 → 可以创建；
 *  - `exists`：有东西（文件 / 目录 / **断链**）→ **拒绝**（A22：不得覆盖、不得删除；也不做「空目录就复用」）；
 *  - `unreadable`：`lstat` 抛非 ENOENT（无权限等）→ **拒绝**（不知道那里有什么，不能往上写）。
 *
 * 判据用 `lstatSync`（不是 `statSync`、更不是 `existsSync`）：
 *  - `existsSync` 返回布尔，区分不了「没有」与「读不出」——这正是本项目禁止它的原因；
 *  - `statSync` 跟随符号链接，**断链会得到 ENOENT**，于是「有个断链占着这个名字」被读成「没有」，
 *    而 `git worktree add` 到同名位置会失败。`lstatSync` 看的是目录项本身，能看见断链。
 */
function probePath(p: string): { kind: 'absent' | 'exists' | 'unreadable'; detail?: string } {
  try {
    if (lstatSync(p, { throwIfNoEntry: false })) return { kind: 'exists' }
    return { kind: 'absent' }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    // 父目录不存在也会抛 ENOENT（Node 对不存在的父目录给 ENOENT）→ 那确实「没有」
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' }
    return { kind: 'unreadable', detail: code }
  }
}

/** 推荐的自动后缀（0.6 的「可用替代」与 §6.3 的碰撞重试共用）。 */
function nextBranchName(branch: string): string {
  const m = /^(.*?)(\d+)$/.exec(branch)
  if (m && m[1]) return `${m[1]}${Number(m[2]) + 1}`
  return `${branch}-2`
}

/**
 * 按 §6.1 生成工作区路径：`<worktreeRoot>/<repoKey>/<slug>-<shortid>/`。
 *
 * `shortid` 用 `createdAt` 的 base36 后 4 位（§6.3）：它只是**降低碰撞概率**，不承担唯一性——
 * 唯一性由 `compareKey` 与 0.7 的「已存在就拒绝」保证。所以这里不需要随机数，
 * 确定性反而让测试能预测路径。
 *
 * **本函数是默认路径的唯一来源**（需求 §7.4）。根从 `worktreeRoot()` 取，缺键时它就是
 * `<DEVA_HOME>/worktrees`，所以 `DEVA_HOME` 迁移时默认根自动跟着走。
 * `suggestPath()`（`create.ts`）走 `nextFreeWorktreePath()` → 这里，因此也自动跟着变。
 */
function defaultWorktreePath(repoRoot: string, slug: string, at = Date.now()): string {
  const repoKey = repoKeyOf(repoRoot)
  const shortid = at.toString(36).slice(-4)
  return join(worktreeRoot(), repoKey, `${slug}-${shortid}`)
}

/**
 * 带碰撞重试的路径生成（§6.3）：同名目录已存在时追加 `-2` / `-3`…，最多 20 次。
 *
 * 为什么需要：`<slug>-<shortid>` 理论上可能撞（同一秒内建两个同名 slug 的）。撞上时 0.7 会拒绝，
 * 用户看到的是「目标路径已存在」——但他什么也没做错，是我们生成的名字撞了。这里替他让开。
 */
export function nextFreeWorktreePath(repoRoot: string, slug: string): string {
  const base = defaultWorktreePath(repoRoot, slug)
  if (!isPathTaken(base)) return base
  for (let i = 2; i <= 20; i++) {
    const cand = `${base}-${i}`
    if (!isPathTaken(cand)) return cand
  }
  // 20 次都撞上：仍然返回带序号的最后一个（后续 0.7 会明确拒绝，不会静默覆盖）
  return `${base}-21`
}

/**
 * 探测。返回结构化结果，**绝不抛错**（抛错在 IPC 边界会变成一句看不出原因的失败）。
 */
export async function precheck(req: PrecheckRequest): Promise<PrecheckOk | PrecheckFail> {
  const fail = (reason: PrecheckFailReason, message: string, suggestion?: string): PrecheckFail => ({
    ok: false,
    reason,
    message,
    ...(suggestion ? { suggestion } : {})
  })

  // ── 0.1 是仓库吗 ──
  const top = await runGitRaw(req.repoRoot, ['rev-parse', '--show-toplevel'])
  if (top.code === -1 && top.stderr.includes('git-not-found')) return fail('no-git', '找不到 git')
  if (top.code !== 0 || !top.stdout.trim())
    return fail('not-a-repo', `这个目录不是 git 仓库：${req.repoRoot}`)
  const repoRoot = normalizeWorktreePath(top.stdout.trim()).path

  // ── 0.2/0.3 主目录当前分支；detached（字面量 HEAD）时不失败，targetBranch 记 null ──
  const abbrev = await runGitRaw(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (abbrev.code !== 0)
    return fail('error', `读不出主目录当前分支：${abbrev.stderr.trim() || '未知错误'}`)
  const abbrevName = abbrev.stdout.trim()
  // detached 时 git 返回字面量 'HEAD'（实测确认）——不能把它当成分支名叫 HEAD
  const primaryDetached = abbrevName === 'HEAD'
  const targetBranch = primaryDetached ? null : abbrevName

  /*
   * ── 0.4 起点必须能解析成一个提交 ──
   *
   * `baseRef` 缺省时用 `rev-parse HEAD`，**不是** `rev-parse --abbrev-ref HEAD`：
   * 后者在 detached 下返回字面量 'HEAD'，拿它去 `rev-parse <ref>^{commit}` 虽然也能解出东西，
   * 但那是一条「碰巧成立的路径」。缺省就该是「主目录此刻的 HEAD 提交」，直接说 HEAD。
   *
   * 注意 **命令必须在 repoRoot 执行**（A7：永远从主检出取 HEAD，不能从当前会话的 focusRoot 取，
   * 否则会造出 n 层单分支树）。
   */
  const baseRef = (req.baseRef ?? '').trim() || 'HEAD'
  const baseResolved = await runGitRaw(repoRoot, ['rev-parse', `${baseRef}^{commit}`])
  const baseSha = baseResolved.stdout.trim()
  if (baseResolved.code !== 0 || !SHA_RE.test(baseSha))
    return fail('bad-base', `起点解析不出提交：${baseRef}`)

  // baseLabel：分支名 / 远端写法 / detached 时标注短 SHA（仅供显示）
  const defaultBase = req.baseRef?.trim() ? req.baseRef.trim() : primaryDetached ? baseSha : abbrevName
  const defaultBaseLabel = primaryDetached && !req.baseRef?.trim()
    ? `HEAD (detached @ ${baseSha.slice(0, 7)})`
    : defaultBase

  // ── 0.5 分支名合法性交给 git 自己判（规则太长，自己实现必然漏） ──
  const branch = (req.branch ?? '').trim()
  if (branch) {
    const refOk = await runGitRaw(repoRoot, ['check-ref-format', '--branch', branch])
    if (refOk.code !== 0) return fail('bad-branch', `分支名不合法：${branch}`)
    // ── 0.6 分支已存在 → 拒绝（A23：不得静默复用），并给可用替代 ──
    const exists = await runGitRaw(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    if (exists.code === 0)
      return fail('branch-exists', `分支 ${branch} 已存在`, nextBranchName(branch))
  }

  // ── 0.8 路径：省略时按 §6.1 自动生成；长度与「仓库外」都在这条判 ──
  /*
   * spec 空缺（本步补）：§7.2 的 `PrecheckResult.path` 允许省略（「自动生成或回显用户输入」），
   * 而 §3.1 的 0.8 要对 `normalizeWorktreePath(path).path` 判长度——两处矛盾：path 若允许省略，
   * 0.8 在「用户没给路径」这个**最常见**的场景下就永远不执行，而路径长度恰恰是自动生成时最可能超限的
   * （slug 从分支名派生，长分支名会撑爆路径）。
   *
   * 所以自动生成放在 precheck 内完成，而不是推给 create：这样界面能在**创建前**把生成出来的路径显示给用户、
   * 并当场提示「太长了」。放到 create 才生成，用户点完「创建」才知道超限，那时意图记录已经写下去了。
   */
  const slug = slugifyBranch(branch || 'worktree')
  const target = (req.path ?? '').trim() || defaultWorktreePath(repoRoot, slug)
  const norm = normalizeWorktreePath(target)
  if (norm.path.length >= MAX_PATH_LEN)
    return fail('path-too-long', `路径太长（${norm.path.length} ≥ ${MAX_PATH_LEN}）：${norm.path}`)
  if (isInsideRepo(repoRoot, norm.path))
    return fail('path-inside-repo', `工作区不能放在仓库内：${norm.path}`)
  /*
   * ── 0.8b 必须在根内（需求 §7.1 的位置：仓库外之后、已存在之前）──
   *
   * 为什么在 `path-inside-repo` 之后：先排除最严重的（仓库内），报错更准确。
   * 为什么在 `path-exists` 之前：「根外」是比「已存在」更根本的错误 —— 一个根外且刚好重名的路径
   * 应报 `path-outside-root`，不该让用户以为「换个名字就行」。
   *
   * 文案**必须带当前根的实际路径**（需求 §7.3）：`path-inside-repo` 那个错误用户知道仓库在哪，
   * 这个不告诉他根在哪就没法改。
   */
  const root = worktreeRoot()
  if (!isInsideRoot(root, norm.path))
    return fail('path-outside-root', `工作区必须建在当前 worktree 根目录内（${root}）：${norm.path}`)

  // ── 0.7 目标路径已被占用 → 拒绝（A22：不得覆盖、不得删除；不做「空目录就复用」）──
  const probe = probePath(norm.path)
  if (probe.kind === 'exists')
    return fail('path-exists', `目标路径已存在，请换一个：${norm.path}`)
  if (probe.kind === 'unreadable')
    return fail('error', `目标路径读不出状态（${probe.detail}），不敢往那儿创建：${norm.path}`)

  // ── 0.9 主目录脏改动数（只数，不动任何东西）──
  const status = await runGitRaw(repoRoot, ['status', '--porcelain'])
  if (status.code !== 0)
    return fail('error', `读不出主目录状态：${status.stderr.trim() || '未知错误'}`)
  const dirtyCount = status.stdout.split('\n').filter((l) => l.trim() !== '').length
  // 脏改动只警示不拦截：confirmedDirty 由用户在弹窗里点「继续」后置真
  const needsConfirm = dirtyCount > 0 && !req.confirmedDirty

  // ── 0.10 已有太多工作区 → 软提示，不阻断 ──
  const existingCount = findRecordByRepo(repoRoot).length
  const softWarn = existingCount >= 5 ? ('many-worktrees' as const) : undefined

  // ── 0.11 受信根（后续所有 git/fs IPC 的前提）──
  // repoRoot 让本仓的 git IPC 可用；path 的**父目录**让创建后写文件 / 读状态可用
  // （path 自己还没建，登记它没用；登记父目录也就覆盖了它）。
  trustRoot(repoRoot)
  trustRoot(dirname(norm.path))

  return {
    ok: true,
    repoRoot,
    defaultBase,
    defaultBaseLabel,
    baseSha,
    baseLabel: defaultBaseLabel,
    targetBranch,
    primaryDetached,
    ...(primaryDetached ? { mergeTargetWarning: 'merge-target-unset' } : {}),
    path: norm.path,
    branch,
    slug,
    dirtyCount,
    needsConfirm,
    ...(softWarn ? { softWarn } : {}),
    existingCount
  }
}

/** 供 create 复用：路径是否已被占用（同一套四态判据，不要在两处各写一遍）。 */
export function isPathTaken(p: string): boolean {
  const probe = probePath(normalizeWorktreePath(p).path)
  return probe.kind !== 'absent'
}

/** 供 create 复用：比较键（判重用）。 */
export function keyOf(p: string): string {
  return compareKeyOfPath(p)
}
