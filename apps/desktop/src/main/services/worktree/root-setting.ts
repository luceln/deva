import { join } from 'path'
import { setConfigDetailed, type ConfigWriteResult } from '../config'
import { listRecords } from './store'
import type { WorktreeRootSetResult, WorktreeRootView } from '../../../shared/worktree-protocol'
import {
  MAX_PATH_LEN,
  WORKTREE_ROOT_KEY,
  defaultWorktreeRoot,
  isInsideRepo,
  normalizeWorktreePath,
  repoKeyOf,
  worktreeRoot,
  worktreeRootView
} from './paths'

/**
 * 设置 worktree 根目录（需求 §9.3 / §9.4 / Q2 / Q4）。
 *
 * ## 为什么校验放在保存时，而不是等创建时才报
 *
 * 一个「能保存、但每次创建都失败」的设置，正是本需求要消灭的那类矛盾
 * （设置说行、实际操作不行）。所以三件事在保存时就拒：根在仓库内、根太深导致路径超限、
 * 路径本身不合法。创建时的 `path-too-long` / `path-inside-repo` 仍保留兜底。
 *
 * ## 为什么拒绝时必须带出具体路径
 *
 * 用户唯一会遇到的困惑是「被一个自己都忘了的旧仓库挡死」。解法不是放行（那会造出
 * 永远用不了的根），而是让他**一眼看到是哪个仓库** —— 文案里给出 `repoRoot` 完整路径，
 * 多个仓库命中时全部列出，不报第一个了事。这条对应验收 A27，是本项唯一能证伪
 * 「真的说清了」的方式。
 *
 * 同理，路径超限时必须给出**试算出的超限样例**，否则用户不知道该把根改浅多少。
 */

/**
 * 试算用的 slug 长度。
 *
 * 为什么定 40：`slugifyBranch()` 的截断上限就是 40（`paths.ts` 第 7 步），所以这是
 * **最坏情况**而非随手取的数字。用最长 slug 试算，通过则任何真实分支名都不会超限。
 */
const PROBE_SLUG = 'x'.repeat(40)

/** 试算 `<root>/<repoKey>/<slug>-<shortid>` 的长度（`-` + 4 位 shortid）。 */
function probePathFor(root: string, repoRoot: string): string {
  return join(root, repoKeyOf(repoRoot), `${PROBE_SLUG}-zzzz`)
}

/**
 * 所有已登记仓库（去重）。
 *
 * 为什么不是「当前打开的仓库」：根是**全局**的，切到别的项目就炸。只按当前仓库校验
 * 会放过「对仓库 B 超限」的根，用户切过去才发现建不了。
 */
function knownRepoRoots(): string[] {
  const set = new Set<string>()
  for (const rec of listRecords()) {
    if (rec.repoRoot) set.add(rec.repoRoot)
  }
  return [...set]
}

/**
 * 校验一个候选根，返回拒绝结果（`null` = 通过）。
 *
 * 三段，全部在写盘前跑，任一段不过就一个字节都不写。
 */
function rejectReason(candidate: string): WorktreeRootSetResult | null {
  // ── 校验 3（先做，因为后两项都要用到归一化后的路径）：路径合法 ──
  /*
   * `normalizeWorktreePath` 内部走 `resolve()` + `realResolve()`，对畸形输入可能抛。
   * 抛出来就说明这个串做不了根 —— 不能等到每次 `getRecord()` 归一化时才炸
   * （那里 `catch → null`，表现是「记录查不到」这种莫名其妙的失败）。
   */
  let rootPath: string
  try {
    rootPath = normalizeWorktreePath(candidate).path
  } catch (e) {
    return fail('bad-path', `这个路径无法作为 worktree 根（${(e as Error)?.message ?? e}），请换一个：${candidate}`)
  }
  if (!rootPath) return fail('bad-path', `这个路径无法作为 worktree 根，请换一个：${candidate}`)

  const repos = knownRepoRoots()

  // ── 校验 1：根不能落在任何已登记仓库内（Q2：拒绝，不做「警告但允许」）──
  /*
   * 在仓库内会怎样：`precheck` 的 `isInsideRepo`（`path-inside-repo`）在该仓库上**每次创建都拒绝**。
   * 放行保存的后果是用户得到一个「存得下、用不了」的根。这正是本需求要消灭的矛盾，不能自己再造一个。
   */
  const hitRepos = repos.filter((repo) => {
    try {
      return isInsideRepo(repo, rootPath)
    } catch {
      // 单个仓库归一化失败不能拖垮校验；它本来也不是本次要挡的对象
      return false
    }
  })
  if (hitRepos.length > 0) {
    /*
     * **必须列出全部命中的仓库完整路径**（A27 的多仓库形态）。
     * 只报第一个会让用户改完根、再撞第二个，来回试。
     */
    const where = hitRepos.map((r) => `  ${r}`).join('\n')
    return fail(
      'outside-repo-required',
      `这个根目录位于 ${hitRepos.length} 个 git 仓库内，` +
        `那样每次创建都会被「不能放在仓库内」拒绝：\n${where}\n请换一个仓库之外的目录。`
    )
  }

  // ── 校验 2：不能深到让 `<root>/<repoKey>/<slug>-<shortid>` 超过 MAX_PATH_LEN ──
  /*
   * 对**每个**已登记仓库各算一次（需求 §9.3：根是全局的，切到别的项目就炸）。
   * 用最坏情况 slug 试算，避免「今天能建、明天分支名长一点就建不了」。
   *
   * Q4 定案：不单独校验「slug 还剩几字符」这类人为阈值，只做这一次试算。
   */
  for (const repo of repos) {
    const probe = probePathFor(rootPath, repo)
    if (probe.length >= MAX_PATH_LEN) {
      return fail(
        'path-too-long',
        `这个根目录太深，会让工作区路径超过 ${MAX_PATH_LEN} 个字符。` +
          `请选一个浅一些的目录。\n试算样例（${probe.length} 字符）：\n  ${probe}`
      )
    }
  }

  return null
}

/**
 * 设置根。`undefined` 表示**恢复默认**（删键）—— 这与 `setConfig` 既有的
 * 「`undefined` 即删键」协议一致（`config.ts` 的 `setConfigDetailed`）。
 *
 * 返回值可直接展示；成功时也给出生效值与是否默认。
 */
export function setWorktreeRoot(value: string | undefined): WorktreeRootSetResult {
  // ── 恢复默认：删键，不做任何校验（默认根一定合法）──
  if (value === undefined) {
    const res = setConfigDetailed({ [WORKTREE_ROOT_KEY]: undefined })
    if (!res.ok) return fail('write-failed', writeFailureText(res))
    return { ok: true, root: defaultWorktreeRoot(), isDefault: true }
  }

  const trimmed = String(value).trim()
  /*
   * 空串等同于恢复默认。理由：用户清空输入框后点保存，意图就是「不要自定义了」；
   * 若此时写进一个空串，`worktreeRoot()` 会把它当缺键处理（已经这样设计了），
   * 但 `config.json` 里会留下一条没意义的空值，让「恢复默认 = 删键」变得不干净。
   */
  if (trimmed === '') return setWorktreeRoot(undefined)

  const rejected = rejectReason(trimmed)
  if (rejected) return rejected

  const res = setConfigDetailed({ [WORKTREE_ROOT_KEY]: trimmed })
  if (!res.ok) return fail('write-failed', writeFailureText(res))
  return { ok: true, root: worktreeRoot(), isDefault: false }
}

function fail(
  reason: 'outside-repo-required' | 'path-too-long' | 'bad-path' | 'write-failed',
  message: string
): WorktreeRootSetResult {
  return { ok: false, reason, message }
}

/** 写盘失败的三类原因翻成人话（`config.ts` 的 `ConfigWriteResult.code`）。 */
function writeFailureText(res: ConfigWriteResult): string {
  if (res.code === 'config-unreadable')
    return '配置文件此刻读不出来（可能是半截 JSON 或被占用），根目录没有改动。' + (res.detail ?? '')
  if (res.code === 'config-changed-externally')
    return '配置文件已被外部修改或删除，为免覆盖别人的改动，根目录没有改动。' + (res.detail ?? '')
  return '配置写入失败（磁盘满或被占用），根目录没有改动。'
}

/** 只读：当前生效的根 + 默认根 + 是否默认。界面用它渲染设置项（需求 §9.2「若是默认要明确写默认」）。 */
export function readWorktreeRoot(): WorktreeRootView {
  /*
   * 三个值来自 `paths.ts` 的同一次调用（`worktreeRootView()`），不再各自算一遍：
   * 分开算时若中途 `DEVA_HOME` 或配置变了，会出现「当前 X / 默认 Y」互相矛盾。
   */
  return worktreeRootView()
}
