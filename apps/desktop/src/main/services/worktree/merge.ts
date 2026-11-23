import { existsSync } from 'fs'
import { resolve as resolvePath } from 'path'
import { classifyRemoteError, runGitRaw } from '../git'
import { listWorktrees, type WorktreeEntry } from './git-worktree'
import { getRecord, upsertRecord } from './store'
import { withGitLock } from './lock'
import { normalizeWorktreePath } from './paths'
import { trustRoot } from '../fs-guard'
import { publishWorktreeChanged, publishWorktreeProgress } from '../chat-bus'
import type {
  MergeCheck,
  MergeOptions,
  MergeResult,
  WorktreeSetTargetResult
} from '../../../shared/worktree-protocol'

/** 内部选项：协议里的 `MergeOptions` 只管用户意图，`dryRun` 是通道级的决定（不对外）。 */
interface InternalOptions extends MergeOptions {
  dryRun?: boolean
}

/**
 * 合并：把一个工作区的分支合回目标分支（spec §4）。
 *
 * ## 三条最容易被写错的硬约束（改动前必读）
 *
 * 1. **四项检查必须全部跑完再返回**，数量恒为 4、顺序恒为 `C1, C2, C4, C5`，**不得在第一个 bad 处 return**。
 *    界面按数组顺序画四个圆点、不按 status 过滤；短路会让用户「清完一处、再点、又冒一处」。
 * 2. **C1 恒通过**（脏时 `status: 'warn'`）。`git merge` 只合已提交内容，source 的未提交改动本来就进不去；
 *    真正的风险是「用户以为改了但没合过去」，所以要**显示** dirtyCount/dirtyPaths，而不是拦截。
 * 3. **C5 用路径交集，不用 `git merge-tree` 预测**。§4.9.3 实测：merge-tree 在 ff 场景只输出树 OID、
 *    不给路径名，而真实 merge 照样按路径拦——拿它当判据会漏判。交集算法的三步全是确定性命令。
 *
 * ## 明确禁止（违反即验收不过，spec §4.7）
 *
 * - 自动 `git merge --abort`
 * - 任何 `git reset --hard` / `git checkout -- .`
 * - 自动删 source 分支或 worktree（成功路径也不清理）
 * - 自动改 target 检出的任何文件
 * - 自动 stash（**唯一例外**是用户显式传 `stashFirst`，走 §4.9.5 的手工三步）
 * - git 的自动 stash（merge 的同名选项，本文件刻意不写出完整参数名）：§4.9.2 实测它 exit 0 但工作区 UU、MERGE_HEAD 空、改动躺在 stash 里
 *   ——只看退出码必然误判成功。本文件里**不出现**这个参数。
 */

/** merge 的等待上限。超时几乎一定是撞上了 git 的交互式提示，杀掉比等更好（§4.4）。 */
const MERGE_TIMEOUT_MS = 60_000

/** C-1：目标分支未知。不做任何检查、不执行 merge、**不自动挑一个**（spec §4.2）。 */
function notSet(rec: { branch: string }): MergeResult {
  return {
    ok: false,
    mergeAttempted: false,
    checks: [],
    reason: 'target-not-set',
    message: '',
    targetBranch: null,
    sourceBranch: rec.branch
  }
}

/**
 * 「进行中操作」检测（C3/C6 共用，spec §4.2 那五行）。
 *
 * 两个细节必须照做：
 *  - **`-q` 不能省**：不带它时 `rev-parse --verify` 失败会往 stderr 写
 *    `fatal: Needed a single revision`，污染面向用户的 `message`。
 *  - **`--git-path` 的结果是相对 cwd 的**，必须 `resolve(dir, …)` 再 existsSync。worktree 里 `.git`
 *    是**文件**不是目录，直接拼 `<dir>/.git/rebase-merge` 永远不存在。
 *
 * 不查 `refs/stash`：stash 不影响 merge。
 */
async function busyOpOf(dir: string): Promise<string | null> {
  const heads: Array<[string, string]> = [
    ['MERGE_HEAD', 'merge'],
    ['CHERRY_PICK_HEAD', 'cherry-pick'],
    ['REVERT_HEAD', 'revert']
  ]
  for (const [ref, label] of heads) {
    const r = await runGitRaw(dir, ['rev-parse', '-q', '--verify', ref])
    if (r.code === 0) return label
  }
  for (const [stateDir, label] of [
    ['rebase-merge', 'rebase'],
    ['rebase-apply', 'rebase']
  ] as Array<[string, string]>) {
    const r = await runGitRaw(dir, ['rev-parse', '--git-path', stateDir])
    if (r.code !== 0) continue
    const p = r.stdout.trim()
    if (p && existsSync(resolvePath(dir, p))) return label
  }
  return null
}

/**
 * 解析 `git status --porcelain -z` 的路径清单。
 *
 * 格式：每个条目 `XY <path>\0`；rename/copy（`R`/`C`）**额外**跟一个 `\0` 分隔的原路径，即
 * `XY <new>\0<old>\0`。所以不能简单按 `\0` 切完就当路径——重命名那条的下一段是**旧路径**，不是新条目。
 *
 * 取**新路径**（用户看得到、合并要改的是新路径）。
 * `??`（untracked）也算脏：§4.9 F3 实测 untracked 撞路径同样会被 merge 拦。
 */
export function parseStatusPaths(stdout: string): string[] {
  const out: string[] = []
  const parts = stdout.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (!entry || entry.length < 4) continue
    const xy = entry.slice(0, 2)
    const path = entry.slice(3)
    if (!path) continue
    out.push(path)
    // `R`/`C` 后面那段是被改之前的路径，跳过它（不是独立条目）
    if (xy.includes('R') || xy.includes('C')) i++
  }
  return out
}

/** 取某个目录的脏路径集（D）。读不出来时返回 null —— 调用方据此记 bad，绝不当成「没有脏改动」。 */
async function dirtyPathsOf(dir: string): Promise<string[] | null> {
  const r = await runGitRaw(dir, ['status', '--porcelain', '-z'])
  if (r.code !== 0) return null
  return parseStatusPaths(r.stdout)
}

/**
 * C5 的路径交集（spec §4.9.3）。
 *
 * 三步全是确定性命令：
 *  ① `mergeBase = merge-base <targetBranch> <frozenSha>`
 *  ② `M = diff --name-only -z <mergeBase>..<frozenSha>` ← **三点语义**
 *  ③ `overlap = D ∩ M`
 *
 * ⚠️ **必须三点**（`merge-base..frozenSha`）而不是两点（`<targetBranch> <frozenSha>`）：
 * 两点会把「目标分支自己改过、source 没碰」的文件也算进「合并要改的路径」，于是拦下一个 git
 * 根本不会拦的合并——用户白被拦一次，去终端一跑就成功，还找不到原因（§4.9.3 有实测四格）。
 *
 * 返回 `null` 表示**算不出来**（merge-base 失败 / diff 失败）：不能当成「交集为空」放行，
 * 病根是「不知道」，放行等于跳过检查。
 */
export async function overlapPathsOf(
  targetPath: string,
  targetBranch: string,
  frozenSha: string
): Promise<string[] | null> {
  const dirty = await dirtyPathsOf(targetPath)
  if (dirty === null) return null
  const mb = await runGitRaw(targetPath, ['merge-base', targetBranch, frozenSha])
  if (mb.code !== 0) return null
  const mergeBase = mb.stdout.trim()
  if (!mergeBase) return null
  const diff = await runGitRaw(targetPath, [
    'diff',
    '--name-only',
    '-z',
    `${mergeBase}..${frozenSha}`
  ])
  if (diff.code !== 0) return null
  const willChange = new Set(diff.stdout.split('\0').filter(Boolean))
  return dirty.filter((p) => willChange.has(p))
}

/** 一台机器的 git 输出：stdout/stderr 原样（§4.6 要求 conflict/merge-failed 时给原文）。 */
interface MergeOutcome {
  code: number
  output: string
}

/**
 * 稳健提取「被拦下的文件路径」（spec §4.9.7）。
 *
 * 不能写死格式，原因（§4.9 F5/F6 实测）：
 *  - 缩进不统一：unstaged 用 `\t`、staged 用两个空格；
 *  - `advice.commitBeforeMerge=false` 时提示行会变成空行；
 *  - 路径行不在固定行号；
 *  - 退出码不唯一（ff 退 1、non-ff 退 2），**不能只看退出码判性质**。
 *
 * 做法是「锚点 + 宽松提取」：先确认文本里真有 `would be overwritten` 这类锚点，再从锚点**之后**
 * 逐行挑「以空白开头、trim 后非空、不是已知提示句」的行当路径。
 *
 * ⚠️ 提取为空时返回 `[]`，调用方必须**退回「原始 stderr + 三个出口」**，
 * 绝不能把空结果当成「没有路径」而放行（那等于把未知当成安全）。
 */
export function parseBlockedPaths(output: string): string[] {
  if (!/would be overwritten|Please move or remove them/i.test(output)) return []
  const lines = output.split('\n')
  const anchor = lines.findIndex((l) => /would be overwritten/i.test(l))
  if (anchor === -1) return []
  const out: string[] = []
  for (let i = anchor + 1; i < lines.length; i++) {
    const raw = lines[i]
    if (!raw) continue
    // 缩进是 \t 还是空格都不假设，只要「以空白开头」
    if (!/^[\s]/.test(raw)) break
    const p = raw.trim()
    if (!p) continue
    if (
      /^(Please commit|Please move|Please, commit|Please stash|Aborting|Merge with strategy|error:|fatal:|Automatic merge|When finished|You can either)/i.test(
        p
      )
    ) {
      continue
    }
    out.push(p)
  }
  return out
}

/** C4：target 分支的**唯一**检出目录（spec §4.1：不得硬编码主目录、不得用创建时的目录）。 */
function targetPathOf(entries: WorktreeEntry[], targetBranch: string): string | null {
  const matches = entries.filter((e) => e.branch === targetBranch && !e.bare)
  return matches.length === 1 ? matches[0].path : null
}

/**
 * C4 失败时要给主检出的当前分支（界面写「主目录已切到 my/hotfix」，spec §4.2）。
 * detached 时返回 `HEAD`（界面显示成 `HEAD (detached @ <sha>)`，与 §7.6 同一规则）。
 */
async function primaryBranchOf(repoRoot: string, entries: WorktreeEntry[]): Promise<string> {
  // 主检出 = porcelain 列表的第一条（git 保证顺序，第一个是主工作区）
  const primary = entries[0]?.path ?? repoRoot
  const r = await runGitRaw(primary, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return r.code === 0 ? r.stdout.trim() || 'HEAD' : 'HEAD'
}

/**
 * 显式 stash 流程的三步（spec §4.9.5，**唯一允许的 stash 用法**）。
 *
 * 为什么不用 git 那个自动 stash 选项（`merge` 的 `--auto`+`stash` 组合，此处不写全名，免得被
 * 「禁用参数」的静态检查误命中）：§4.9.2 实测它 `exit 0` 但工作区 `UU`、`MERGE_HEAD` 不存在、改动躺在 stash 里
 * ——只看退出码必然误判成成功。手工三步每一步都有独立退出码与可核验状态。
 *
 * 为什么 pop 不带 `--index`：上游 `stash apply --index` 在冲突时会 `error: conflicts in index` 且
 * **什么都不恢复**，比「丢 staged 状态」更糟。代价是原本 staged 的文件会变回 unstaged——所以要把
 * 这个差异**列出来告诉用户**（`unstagedLost`），让他自己决定是否重新 `git add`。
 */
interface StashOutcome {
  stashSha: string | null
  /** pop 后从「暂存」变成「未暂存」的文件。 */
  unstagedLost: string[]
  /** pop 是否冲突（冲突时 stash 条目**保留**，不自动 drop）。 */
  popConflict: boolean
  /** 流程中途失败的说明（非空时调用方要把它并进结果）。 */
  failure?: string
}

/** 读「已暂存」的路径集（`XY` 里 X 非空格/`?`），用于 pop 后比对。 */
async function stagedPathsOf(dir: string): Promise<string[]> {
  const r = await runGitRaw(dir, ['status', '--porcelain', '-z'])
  if (r.code !== 0) return []
  const out: string[] = []
  const parts = r.stdout.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (!entry || entry.length < 4) continue
    const x = entry[0]
    const path = entry.slice(3)
    if (x !== ' ' && x !== '?') out.push(path)
    if (entry.slice(0, 2).includes('R') || entry.slice(0, 2).includes('C')) i++
  }
  return out
}

async function stashAndMerge(
  targetPath: string,
  frozenSha: string,
  mergeId: string
): Promise<{ outcome: MergeOutcome; stash: StashOutcome }> {
  const stash: StashOutcome = { stashSha: null, unstagedLost: [], popConflict: false }
  const beforeStaged = await stagedPathsOf(targetPath)

  // ① stash push（`--include-untracked` 必须有：untracked 是常态，不带它 merge 时照样被拦，F3）
  const push = await runGitRaw(
    targetPath,
    ['stash', 'push', '--include-untracked', '-m', `deva-merge-wip:${mergeId}`],
    MERGE_TIMEOUT_MS
  )
  if (push.code !== 0) {
    stash.failure = `git stash 失败：${`${push.stdout}\n${push.stderr}`.trim()}`
    return { outcome: { code: push.code, output: '' }, stash }
  }
  const sha = await runGitRaw(targetPath, ['rev-parse', 'refs/stash'])
  stash.stashSha = sha.code === 0 ? sha.stdout.trim() : null

  // 校验工作区确实空了（不该发生，但要查 —— 非空说明有东西没进 stash，此时不能继续 merge）
  const after = await dirtyPathsOf(targetPath)
  if (after === null || after.length > 0) {
    stash.failure = 'git stash 之后工作区仍不干净，已中止合并（改动仍在 stash 里，可用 git stash pop 恢复）'
    // 这里**不 pop**：让改动留在 stash 里是最安全的，界面会告知 stashSha
    return { outcome: { code: 1, output: '' }, stash }
  }

  // ② merge
  const merge = await runGitRaw(targetPath, ['merge', '--no-ff', '--no-edit', frozenSha], MERGE_TIMEOUT_MS)
  const output = `${merge.stdout}\n${merge.stderr}`.trim()

  /*
   * ③ pop。**无论 merge 成败都要 pop**：merge 失败（含冲突）时用户最需要把自己的改动拿回来，
   * 而 stash 完好（与 autostash 的关键差别）。pop 冲突时 stash 条目保留（git 的既定行为），
   * 我们不自动 drop —— 万一用户想重来。
   */
  const pop = await runGitRaw(targetPath, ['stash', 'pop'], MERGE_TIMEOUT_MS)
  const popOut = `${pop.stdout}\n${pop.stderr}`
  if (pop.code !== 0 || /CONFLICT|conflicts in index/i.test(popOut)) stash.popConflict = true

  const afterStaged = await stagedPathsOf(targetPath)
  const stillStaged = new Set(afterStaged)
  stash.unstagedLost = beforeStaged.filter((p) => !stillStaged.has(p))

  return { outcome: { code: merge.code, output }, stash }
}

/**
 * 跑四项检查（spec §4.2），**不短路**。
 *
 * `checks` 恒为 4 项、顺序固定。逐项说明见文件头那三条硬约束。
 */
async function runChecks(opts: {
  sourcePath: string
  sourceBranch: string
  targetBranch: string
  targetPath: string | null
  entries: WorktreeEntry[]
  repoRoot: string
  stashFirst: boolean
}): Promise<{ checks: MergeCheck[]; frozenSha?: string; overlap: string[] }> {
  const { sourcePath, sourceBranch, targetBranch, targetPath, entries, repoRoot, stashFirst } = opts
  const checks: MergeCheck[] = []

  // ── C0：source 目录与登记是否有效。无效时 C1/C2 记 skipped，C4/C5 照常（spec §7.2 第 2 条） ──
  const sourceExists = existsSync(sourcePath)
  const registered = entries.some((e) => {
    try {
      return normalizeWorktreePath(e.path).compareKey === normalizeWorktreePath(sourcePath).compareKey
    } catch {
      return false
    }
  })
  const sourceOk = sourceExists && registered

  /*
   * ── C1：source 的未提交改动（**恒通过**，脏时 warn）──
   *
   * `busy` 优先于 `dirty`（spec §7.2 映射第 1 条）：source 处于 merge 中比有 3 个改动更根本，
   * 先说根因用户才知道从哪下手。
   */
  if (!sourceOk) {
    checks.push({ id: 'C1', status: 'skipped', reason: 'source-missing' })
  } else {
    const busy = await busyOpOf(sourcePath)
    if (busy) {
      checks.push({ id: 'C1', status: 'warn', reason: 'busy', detail: { busyOp: busy } })
    } else {
      const dirty = await dirtyPathsOf(sourcePath)
      if (dirty === null) {
        // 读不出来 ≠ 没有脏改动。C1 不阻断合并，所以这里仍是 warn（不是 bad），但必须让用户看见「不知道」
        checks.push({ id: 'C1', status: 'warn', reason: 'unknown' })
      } else if (dirty.length === 0) {
        checks.push({ id: 'C1', status: 'ok', detail: { dirtyCount: 0, dirtyPaths: [] } })
      } else {
        checks.push({
          id: 'C1',
          status: 'warn',
          reason: 'dirty',
          detail: { dirtyCount: dirty.length, dirtyPaths: dirty }
        })
      }
    }
  }

  // ── C2：source 仍在自己的分支上（A40 / G2）。source busy 时并入 busy ──
  if (!sourceOk) {
    checks.push({ id: 'C2', status: 'skipped', reason: 'source-missing' })
  } else {
    const busy = await busyOpOf(sourcePath)
    const head = await runGitRaw(sourcePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
    const actual = head.code === 0 ? head.stdout.trim() : ''
    /*
     * `busy` 优先：source 处于 merge 中时 `--abbrev-ref HEAD` 仍可能返回分支名（merge 尚未产生提交），
     * 只看分支名会显示「通过」，而真正该说的是「上次合并还没收尾」。
     * 另外 detached 时 `--abbrev-ref HEAD` 返回字面量 `HEAD`——它永远不等于 `record.branch`（分支名），
     * 但显式说出来更明确（spec 原文：「且不是字面量 HEAD」）。
     */
    if (busy) {
      checks.push({ id: 'C2', status: 'bad', reason: 'busy', detail: { busyOp: busy, actualBranch: actual } })
    } else if (actual && actual !== 'HEAD' && actual === sourceBranch) {
      checks.push({ id: 'C2', status: 'ok', detail: { actualBranch: actual } })
    } else {
      checks.push({
        id: 'C2',
        status: 'bad',
        reason: 'branch-changed',
        detail: { actualBranch: actual || 'HEAD' }
      })
    }
  }

  // ── C4：target 分支能找到唯一检出 ──
  if (!targetPath) {
    const primaryBranch = await primaryBranchOf(repoRoot, entries)
    checks.push({ id: 'C4', status: 'bad', reason: 'not-checked-out', detail: { primaryBranch } })
    /*
     * C5 依赖 C4（`cwd` 是 targetPath）。C4 没过就没有 cwd 可跑交集 —— 记 skipped 而不是 bad：
     * 病根在 C4，报两个 bad 会让用户以为要修两处。
     */
    checks.push({ id: 'C5', status: 'skipped', reason: 'unknown' })
    return { checks, overlap: [] }
  }

  // C4 通过。C6（target 侧进行中操作）不占独立圆点，并入 C5 的 reason: 'busy'
  const targetBusy = await busyOpOf(targetPath)
  checks.push({ id: 'C4', status: 'ok', detail: { targetPath } })

  /*
   * 冻结 SHA 必须在 C2 通过之后、C4 之后立刻取（spec §4.3）：
   * 执行 merge 用 SHA 不用分支名，消除「检查完 → 执行 merge」之间 agent 又提交的窗口。
   * source 不可用时没有 SHA 可冻结，C5 也就没法算交集。
   */
  let frozenSha: string | undefined
  if (sourceOk) {
    const head = await runGitRaw(sourcePath, ['rev-parse', 'HEAD'])
    const sha = head.code === 0 ? head.stdout.trim() : ''
    // 必须 40 位 hex：拿不到就说明 source 的 git 有问题，C5 无法算（不能猜）
    if (/^[0-9a-f]{40}$/.test(sha)) frozenSha = sha
  }

  // ── C5：target 脏改动与本次合并要改的路径无交集 ──
  if (targetBusy) {
    checks.push({ id: 'C5', status: 'bad', reason: 'busy', detail: { busyOp: targetBusy, targetPath } })
  } else if (!frozenSha) {
    checks.push({ id: 'C5', status: 'skipped', reason: 'unknown', detail: { targetPath } })
  } else {
    const overlap = await overlapPathsOf(targetPath, targetBranch, frozenSha)
    if (overlap === null) {
      // 算不出来 ≠ 没有交集。记 bad（拦截）而不是放行——放行等于跳过检查
      checks.push({ id: 'C5', status: 'bad', reason: 'unknown', detail: { targetPath } })
      return { checks, frozenSha, overlap: [] }
    }
    if (overlap.length === 0) {
      checks.push({ id: 'C5', status: 'ok', detail: { targetPath, overlapPaths: [] } })
      return { checks, frozenSha, overlap }
    }
    /*
     * 有交集：用户显式选了「先存起来再合并」时**通过**（spec §4.2 的 C5 行）。
     * 状态仍给 ok 而不是 warn：它不是「提醒」，是「已被用户的选择化解」。
     * `overlapPaths` 照给，界面可展示「本次合并会覆盖这 3 个文件（已暂存）…」
     */
    checks.push({
      id: 'C5',
      status: stashFirst ? 'ok' : 'bad',
      reason: stashFirst ? undefined : 'overlap',
      detail: { targetPath, overlapPaths: overlap }
    })
    return { checks, frozenSha, overlap }
  }
  return { checks, frozenSha, overlap: [] }
}

/** `checks` 里第一个 not-ok 的项 → 汇总 reason（spec §4.6）。 */
function reasonOf(checks: MergeCheck[]): MergeResult extends never ? never : string {
  for (const c of checks) {
    if (c.status === 'ok' || c.status === 'warn') continue
    // C3/C6 的 busy 已并进 C1(source)/C5(target)，这里按项区分归属
    if (c.reason === 'busy') return c.id === 'C2' || c.id === 'C1' ? 'source-busy' : 'target-busy'
    if (c.reason === 'branch-changed') return 'source-branch-changed'
    if (c.reason === 'not-checked-out') return 'target-not-checked-out'
    if (c.reason === 'overlap') return 'target-overlap'
    if (c.reason === 'source-missing') return 'source-missing'
    // 'unknown' / 其它：落 merge-failed 太重，用 target-overlap 也不对——交给调用方按项判断
    return 'merge-failed'
  }
  return 'merge-failed'
}

/**
 * 合并入口。
 *
 * `options.dryRun`：只跑检查、不执行 merge、**不加锁**（只读，spec §7.1）。
 * `options.stashFirst`：C5 有交集时用户选了「先存起来再合并」，走 §4.9.5 的显式 stash 三步。
 *
 * 检查阶段**重新跑一遍**、不复用 dryrun 的结果（spec §7.5）：dryrun 到点合并之间用户可能清了改动、
 * agent 也可能又提交了，复用旧结论等于跳过检查。
 */
export async function mergeWorktree(path: string, options: InternalOptions = {}): Promise<MergeResult> {
  const rec = getRecord(path)
  if (!rec) {
    return {
      ok: false,
      mergeAttempted: false,
      checks: [],
      reason: 'merge-failed',
      message: 'not-found',
      targetBranch: null,
      sourceBranch: ''
    }
  }
  // C-1：目标分支未知 → 什么都不做（不得自动挑 main）
  if (!rec.targetBranch) return notSet(rec)
  /*
   * 收窄成 string 交给下面的闭包：`body` 里到处用它，每次都写 `as string` 会让类型断言散落各处，
   * 而 `rec` 是闭包捕获的 —— TS 无法把「上面判过空」这个事实带进闭包。
   */
  const targetBranch: string = rec.targetBranch

  const body = async (): Promise<MergeResult> => {
    const entries = await listWorktrees(rec.repoRoot)
    const targetPath = targetPathOf(entries, targetBranch)
    /*
     * targetPath 是**目标分支的检出目录**，可能既不是 repoRoot 也不是本 worktree（C4 只保证唯一）。
     * 失败出口里的「在文件管理器打开」走 `fs:reveal-folder`，那条通道用 `isInsideRoot()` 判定，
     * 未受信就返回 `{ ok: false }` ——**不抛错、不提示**，用户看到的是「点了没反应，冲突还在」。
     * 所以这里必须把它登记进受信根（spec §4.7 明写）。
     */
    if (targetPath) trustRoot(targetPath)
    const { checks, frozenSha, overlap } = await runChecks({
      sourcePath: rec.path,
      sourceBranch: rec.branch,
      targetBranch,
      targetPath,
      entries,
      repoRoot: rec.repoRoot,
      stashFirst: options.stashFirst === true
    })

    const failed = checks.filter((c) => c.status === 'bad')
    if (failed.length > 0 || !targetPath || !frozenSha) {
      return {
        ok: false,
        mergeAttempted: false,
        checks,
        reason: reasonOf(checks) as MergeResult extends { reason: infer R } ? R : never,
        // 检查阶段失败**不拼中文**：主进程只给结构化事实，文案由渲染层按 checks + detail 从 i18n 取
        message: '',
        targetBranch,
        sourceBranch: rec.branch,
        ...(targetPath ? { targetPath } : {}),
        ...(frozenSha ? { sourceSha: frozenSha } : {})
      }
    }

    /*
     * dryrun 到这里只差最后一件事：**是否已是最新**（spec §4.4）。
     *
     * 要把这个也判出来，否则界面在 dryrun 后显示「可以合并」，用户点下去才被告知「无需合并」。
     * 判定是只读的（`merge-base --is-ancestor`），dryrun 里跑它不违反「不加锁、只跑检查」。
     */
    if (options.dryRun) {
      const anc = await runGitRaw(targetPath, ['merge-base', '--is-ancestor', frozenSha, 'HEAD'])
      return {
        ok: true,
        upToDate: anc.code === 0,
        targetPath,
        targetBranch,
        sourceBranch: rec.branch,
        sourceSha: frozenSha,
        // dryrun **不执行 merge**，所以永远没有合并提交与 git 原文
        mergeCommit: null,
        gitOutput: '',
        checks
      }
    }

    publishWorktreeProgress({ phase: 'merging', path: rec.path })

    /*
     * 「已经是最新」必须单独识别（spec §4.4）：此时不会产生合并提交，而执行 merge 只会打印
     * `Already up to date.`。直接返回 upToDate，让界面说「无需合并」且不显示 SHA
     * ——不能让 UI 显示「已合并」却查不到合并提交（A37 会误判）。
     */
    const anc = await runGitRaw(targetPath, ['merge-base', '--is-ancestor', frozenSha, 'HEAD'])
    if (anc.code === 0) {
      const after = await runGitRaw(rec.path, ['rev-parse', 'HEAD'])
      const afterSha = after.code === 0 ? after.stdout.trim() : frozenSha
      const behind =
        afterSha !== frozenSha
          ? { pendingSha: afterSha, pendingCount: await countCommits(rec.path, frozenSha, afterSha) }
          : undefined
      return {
        ok: true,
        upToDate: true,
        targetPath,
        targetBranch,
        sourceBranch: rec.branch,
        sourceSha: frozenSha,
        mergeCommit: null,
        gitOutput: '',
        ...(behind && behind.pendingCount > 0 ? { behindNote: behind } : {})
      }
    }

    // 执行 merge（用 frozenSha 而不是分支名，spec §4.3）
    let outcome: MergeOutcome
    let stash: StashOutcome | null = null
    if (options.stashFirst && overlap.length > 0) {
      const mergeId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const r = await stashAndMerge(targetPath, frozenSha, mergeId)
      outcome = r.outcome
      stash = r.stash
      if (stash.failure) {
        return {
          ok: false,
          mergeAttempted: false,
          checks,
          reason: 'merge-failed',
          message: stash.failure,
          gitOutput: stash.failure,
          targetPath,
          targetBranch,
          sourceBranch: rec.branch,
          sourceSha: frozenSha
        }
      }
    } else {
      const res = await runGitRaw(
        targetPath,
        ['merge', '--no-ff', '--no-edit', frozenSha],
        MERGE_TIMEOUT_MS
      )
      outcome = { code: res.code, output: `${res.stdout}\n${res.stderr}`.trim() }
    }

    if (outcome.code !== 0) {
      /*
       * 失败出口（spec §4.6 / §4.9.6）：
       *  - 在 stash 流程中 → 改动已安全保存，直接告知（stash 条目还在）
       *  - 否则按 §4.9.7 稳健解析取路径清单；**不写死缩进、不写死行号、不靠退出码判性质**
       *  - 任何情况下都不得报 success
       *
       * `message` 是 `${stdout}\n${stderr}` 原样 —— 这是本需求里**唯一不能本地化**的字符串：
       * 用户要的是 `CONFLICT (content): Merge conflict in src/xxx.ts` 这一行。
       */
      const blocked = parseBlockedPaths(outcome.output)
      return {
        ok: false,
        mergeAttempted: true,
        checks,
        reason: classifyMergeFailure(outcome.output),
        message: outcome.output,
        gitOutput: outcome.output,
        targetPath,
        targetBranch,
        sourceBranch: rec.branch,
        sourceSha: frozenSha,
        ...(stash
          ? {
              stash: {
                sha: stash.stashSha,
                popConflict: stash.popConflict,
                unstagedLost: stash.unstagedLost
              }
            }
          : {}),
        ...(blocked.length > 0 ? { blockedPaths: blocked } : {})
      }
    }

    // 成功：取合并提交与窗口另一半（§4.3 / §4.5）
    const headRes = await runGitRaw(targetPath, ['rev-parse', 'HEAD'])
    const mergeCommit = headRes.code === 0 ? headRes.stdout.trim() : null
    const after = await runGitRaw(rec.path, ['rev-parse', 'HEAD'])
    const afterSha = after.code === 0 ? after.stdout.trim() : frozenSha
    let behindNote: { pendingSha: string; pendingCount: number } | undefined
    if (afterSha !== frozenSha) {
      const n = await countCommits(rec.path, frozenSha, afterSha)
      // 不自动重试：用户可能正想先改点东西
      if (n > 0) behindNote = { pendingSha: afterSha, pendingCount: n }
    }
    return {
      ok: true,
      upToDate: false,
      targetPath,
      targetBranch,
      sourceBranch: rec.branch,
      sourceSha: frozenSha,
      mergeCommit,
      gitOutput: outcome.output,
      ...(behindNote ? { behindNote } : {}),
      checks,
      ...(stash
        ? {
            stash: {
              sha: stash.stashSha,
              popConflict: stash.popConflict,
              unstagedLost: stash.unstagedLost
            }
          }
        : {})
    }
  }

  // dryrun 是只读的，**不加锁**（spec §7.1）；真合并要同时持 repoRoot 与 targetPath 两把锁
  if (options.dryRun) return body()
  return withGitLock([rec.repoRoot, rec.path], `merge ${rec.branch}`, body).then(async (r) => {
    // 收尾的 `done` 必须发（与导入同一理由：不发的话界面进度条永远差一截）
    publishWorktreeProgress({ phase: 'done', path: rec.path })
    if (r.ok) publishWorktreeChanged()
    return r
  })
}

/** `git rev-list --count <from>..<to>`（spec §4.3 的 pendingCount）。 */
async function countCommits(dir: string, from: string, to: string): Promise<number> {
  const r = await runGitRaw(dir, ['rev-list', '--count', `${from}..${to}`])
  const n = r.code === 0 ? Number.parseInt(r.stdout.trim(), 10) : 0
  return Number.isFinite(n) ? n : 0
}

/**
 * 把 git 的失败输出分类成 `conflict` / `merge-failed`（spec §4.6）。
 *
 * **直接复用 `git.ts` 的 `classifyRemoteError`**，不另写正则——两套判定必然漂移
 * （它在这次改动里被导出，就是为这一处）。它返回 `'conflict'` 时给 `conflict`，
 * 其余（`dirty` / `error` / `network` / `auth` / `rejected`）一律 `merge-failed`：
 * 对合并来说，除了「冲突需要用户解」，其余都只能归成「这次合并没成」。
 */
function classifyMergeFailure(output: string): 'conflict' | 'merge-failed' {
  return classifyRemoteError(output) === 'conflict' ? 'conflict' : 'merge-failed'
}

/**
 * 指定合并目标分支（`worktree:set-target`，spec §4.2 的 C-1 出口）。
 *
 * 什么时候用：创建时主目录 detached → `record.targetBranch` 为 null → 合并面板只出选择器、
 * 不做任何检查。用户选一个本地分支后调本通道写回记录，再重新走合并。
 *
 * 为什么只接受**本地分支**：远端分支没被检出，无法作为 merge 的 `cwd`（§4.1 要用
 * `worktree list` 反查检出目录）。用户需要先在某个目录检出它。
 *
 * 为什么写完要校验「记录还在」：`upsertRecord` 在 store 读坏时可能写不进去（返回 false），
 * 那种情况必须如实报 `write-failed`，否则界面以为设好了、再点合并又是 `target-not-set`（死循环）。
 */
export function setMergeTarget(path: string, targetBranch: string): WorktreeSetTargetResult {
  const rec = getRecord(path)
  if (!rec) return { ok: false, reason: 'not-found', message: 'not-found' }
  const name = typeof targetBranch === 'string' ? targetBranch.trim() : ''
  /*
   * 只做最基础的名字合法性检查（非空、不含空白与 ..），不在这里跑 `git show-ref`：
   * 分支可能在检查与写回之间被删，那时合并会给出 `target-not-checked-out`（C4），
   * 那是更准确的位置。这里拦的只是明显不是分支名的输入。
   */
  if (!name || /[\s~^:?*\[\]|]/.test(name) || name.includes('..')) {
    return { ok: false, reason: 'bad-branch', message: 'bad-branch' }
  }
  if (!upsertRecord({ ...rec, targetBranch: name })) {
    return { ok: false, reason: 'write-failed', message: 'write-failed' }
  }
  publishWorktreeChanged()
  return { ok: true, targetBranch: name }
}
