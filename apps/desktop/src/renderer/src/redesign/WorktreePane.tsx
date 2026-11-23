import { useState } from 'react'
import {
  AlertTriangle,
  Archive,
  FolderSearch,
  HardDrive,
  Loader2,
  Lock,
  RefreshCw,
  RotateCcw,
  Scissors,
  Trash2
} from 'lucide-react'
import { useI18n } from '../i18n/i18n'
import { useToast } from '../components/ToastProvider'
import { useDialog } from '../components/DialogProvider'
import { MergePanel } from './MergePanel'
import { useWorktree } from '../store/worktree'
import type {
  MergeBlocker,
  WorktreeInstallResult,
  WorktreeListItem,
  WorktreeRebuildResult,
  WorktreeState
} from '../../../shared/worktree-protocol'
import './worktree-pane.css'

/**
 * 设置 › 工作区：worktree 列表（spec §7.4 / §7.5、原型面 3）。
 *
 * ## 这个面板最重要的一条：什么都不推断
 *
 * `state`、`deps`、`sessionCount`、`sizeBytes`、`lockHolder`、`dirtyCount`、`mergeGate` **全部原样显示
 * 主进程给的值**。界面里看不到任何一处「按 state 自己推算能不能做某件事」——那正是 A48 / R13 要防的事：
 * 两处各算一遍，迟早一处说能、一处拒绝，而用户只会看到「按钮能点，点了报错」。
 *
 * 合并按钮就是这条的实例：`disabled` 只读 `mergeGate.mayMerge`，`title` 只读 `mergeGate.blocker`。
 * 主进程已经算好四个 blocker 的优先级，界面连「哪个先」都不判。`mayMerge` 为真时打开合并面板走真实
 * `worktree:merge`；`mayMerge` 为假时按钮禁用并显示 blocker 原因——这两种状态必须能区分：
 * 一个是「你需要先做点什么」，另一个是「这个功能还没做」。
 *
 * ## 「无关联会话」与 `state` 正交（§2.5 / A54）
 *
 * `sessionCount === 0` 单独出一枚 badge，与 `state` badge **并列**。不能合成一个枚举：
 * 「正常但没有会话」和「目录缺失但还有一个会话」都是合法组合，合成一个就表达不出来。
 *
 * ## `sizeBytes === null` 不是错误
 *
 * 两种情况：目录不存在（显示「占用未知」），或后台还在异步统计（显示「统计中…」）。
 * 判据是 `state`：`dir-missing` / `prunable` → 目录都没了，无从统计 → 「占用未知」；
 * 其余 → 目录在，`null` 只能是还没算完 → 「统计中…」。
 * 后者算完主进程会发 `worktree:changed`，store 重拉后自然变成数字，**不需要轮询**。
 *
 * ## `dirtyCount` 的 `null` 与 `0` 不是同一件事
 *
 * 主进程只在**目录不存在**时给 `null`（无法统计），目录在且干净时给 `0`。
 * 把 `null` 渲染成 0（或反过来）会让用户看到「没有未提交改动」而实际是「根本看不了」，
 * 于是放心地在别处继续改同一批文件。故三态各自出文案：`null` →「无法统计改动」、`>0` →「N 个未提交改动」、
 * `0` →「没有未提交改动」。
 *
 * ## `mergeInProgress` 只报事实，不假装能处理（§13.10）
 *
 * 非 null 时显示冲突数。冲突处理窗口是 P2 的事，所以「处理冲突」按钮走与其它未落地操作
 * 相同的诚实提示，而不是弹一个空面板。
 *
 * ## `deps === 'failed'` 必须同时说「会话仍可使用」（§7.7 屏⑤ / A27）
 *
 * 只给 `depsDetail` 的 20 行报错，用户会以为这块废了，而实际能继续用：工作区本身是好的，
 * 只是 pnpm / npm 类命令会失败。这句话与明细**同屏出现**，不折叠、不做成 tooltip ——
 * 收起来就等于没说。
 *
 * ## A33：不自动 prune
 *
 * `prunable` 的卡片给一个「移除登记」按钮，**必须用户点**。任何自动清扫、进页面就 prune 的写法都是错的：
 * 它会在用户不知情时删掉 git 登记，而那条登记可能只是暂时把目录移走了（U 盘、网络盘、改名）。
 * 故本文件里没有任何 `useEffect` 去调 prune。
 */

const STATE_KEY: Record<WorktreeState, string> = {
  ok: 'cf.wt.state.ok',
  'dir-missing': 'cf.wt.state.dirMissing',
  prunable: 'cf.wt.state.prunable',
  'branch-mismatch': 'cf.wt.state.branchMismatch'
}

const DEPS_KEY: Record<WorktreeListItem['deps'], string> = {
  pending: 'cf.wt.deps.pending',
  installing: 'cf.wt.deps.installing',
  ready: 'cf.wt.deps.ready',
  failed: 'cf.wt.deps.failed',
  skipped: 'cf.wt.deps.skipped'
}

/**
 * `mergeGate.blocker` → 文案。四个取值各对应「为什么不能合并」，**由主进程给**（含优先级），
 * 这里只负责翻译。`Record<MergeBlocker, string>` 让漏一个取值就编译不过——新增 blocker 时
 * 界面不会静默显示成空白。
 */
const BLOCKER_KEY: Record<MergeBlocker, string> = {
  'target-not-set': 'cf.wt.merge.blocker.targetNotSet',
  'source-missing': 'cf.wt.merge.blocker.sourceMissing',
  'source-branch-changed': 'cf.wt.merge.blocker.sourceBranchChanged',
  installing: 'cf.wt.merge.blocker.installing'
}

/**
 * 重建失败原因 → 文案。`reason` 缺席时按 `add-failed` 兜底（协议里 `ok:false` 必然带一个原因，
 * 这里只是让类型闭合，不是「猜一个」）。
 *
 * ## 为什么这张表以前是死代码
 *
 * 调用点原来写的是 `res.message ?? t(REBUILD_FAIL_KEY[...])`。`res.message` 是后端的技术原文，
 * 六条 reason 它**条条都填**，于是 `??` 一次都轮不到右边 —— 这张表整张没被用到。
 * 用户看到的是「目录还在（E:\xxx），不需要重建」这类后端口吻，而不是「怎么办」。
 *
 * ## 现在怎么分工（按 reason 分流，不是一刀切）
 *
 * 后端 `message` 与这六条词条的关系并不一样，所以不能统一处理：
 *
 * - **技术型**（`add-failed` 是 Git stderr、`verify-failed` 是逐项不符清单）：
 *   词条只说「该怎么办」，原始报错是排查的唯一线索 —— 两行都给（title 词条 + message 原文）。
 * - **描述型**（`dir-exists` / `branch-missing`）：后端 message 与词条说的是同一件事，
 *   两行会把同一句话显示两遍。词条承担全部信息，路径 / 分支名用占位符嵌进去。
 * - **`not-found` / `installing`**：后端 message 没有额外信息，只显示词条。
 */
const REBUILD_FAIL_KEY: Record<NonNullable<WorktreeRebuildResult['reason']>, string> = {
  'not-found': 'cf.wt.rebuildFail.notFound',
  'dir-exists': 'cf.wt.rebuildFail.dirExists',
  'branch-missing': 'cf.wt.rebuildFail.branchMissing',
  installing: 'cf.wt.rebuildFail.installing',
  'add-failed': 'cf.wt.rebuildFail.addFailed',
  'verify-failed': 'cf.wt.rebuildFail.verifyFailed'
}

/**
 * 这些 reason 的 `message` 是**纯技术细节**（Git 原始报错 / 逐项不符清单），
 * 与词条不重叠，必须作为第二行原样显示：里面往往有日志里才有、界面又没别处能看到的线索。
 *
 * 其余 reason 的 `message` 与词条同义，显示两行就是重复，所以只显示词条。
 */
const REBUILD_FAIL_KEEPS_DETAIL = new Set<NonNullable<WorktreeRebuildResult['reason']>>([
  'add-failed',
  'verify-failed'
])

/** 字节数 → 人读的形态。`null` 由调用方区分「统计中」与「占用未知」，不在这里兜。 */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

export function WorktreePane(): React.JSX.Element {
  const { t } = useI18n()
  const { snapshot, loading, error, refresh } = useWorktree()

  const rows = snapshot?.items ?? []
  const unmanaged = snapshot?.unmanaged ?? []

  return (
    <div className="cf-wt">
      <div className="cf-wt__head">
        <div className="cf-wt__headtext">
          <h3 className="cf-wt__title">{t('cf.wt.paneTitle')}</h3>
          <p className="cf-wt__hint">{t('cf.wt.paneHint')}</p>
        </div>
        <button
          type="button"
          className="btn btn--ghost cf-wt__refresh"
          onClick={() => void refresh()}
          disabled={loading}
          title={t('cf.wt.refresh')}
        >
          {loading ? <Loader2 size={14} className="cf-wt__spin" /> : <RefreshCw size={14} />}
          {t('cf.wt.refresh')}
        </button>
      </div>

      {error && (
        <div className="cf-wt__err" role="alert">
          <AlertTriangle size={14} />
          <span>{t('cf.wt.loadFailed').replace('{msg}', error)}</span>
        </div>
      )}

      {/* 记录文件读坏了：`items` 为空不代表没有工作区，必须说清楚，否则用户以为工作区都没了 */}
      {snapshot?.storeUnreadable && (
        <div className="cf-wt__err" role="alert">
          <AlertTriangle size={14} />
          <span>{t('cf.wt.storeUnreadable')}</span>
        </div>
      )}

      {rows.length === 0 && !loading && !error && !snapshot?.storeUnreadable && (
        <div className="cf-wt__empty">{t('cf.wt.empty')}</div>
      )}

      <div className="cf-wt__list">
        {rows.map((w) => (
          <WorktreeCard key={w.compareKey || w.path} view={w} />
        ))}
      </div>

      {unmanaged.length > 0 && (
        <section className="cf-wt__unmanaged">
          <h4 className="cf-wt__subtitle">{t('cf.wt.unmanagedTitle')}</h4>
          <p className="cf-wt__hint">{t('cf.wt.unmanagedHint')}</p>
          {unmanaged.map((u) => (
            <div key={u.path} className="cf-wt__urow">
              <span className="cf-wt__ubranch">{u.branch ?? t('cf.wt.detached')}</span>
              <span className="cf-wt__upath" title={u.path}>
                {u.path}
              </span>
              {u.prunable && <span className="cf-wt__badge is-warn">{t('cf.wt.state.prunable')}</span>}
            </div>
          ))}
        </section>
      )}
    </div>
  )
}

/** 一张卡片。 */
function WorktreeCard({ view }: { view: WorktreeListItem }): React.JSX.Element {
  const { t } = useI18n()
  const toast = useToast()
  const dialog = useDialog()
  /** 合并面板是否打开（合并是两步：先看检查结果，再决定合不合 / 怎么处理覆盖）。 */
  const [mergeOpen, setMergeOpen] = useState(false)
  /** 重建 / 移除登记这类会改磁盘的操作进行中：期间禁掉同组按钮，避免重复点。 */
  const [busy, setBusy] = useState(false)
  // 合并成功后要让主进程重算 targetBranch / mergeGate：直接复用 store 的 refresh。
  const { refresh } = useWorktree()

  /**
   * 删除这个工作区。
   *
   * 两次确认，因为它的破坏性有两层：
   *  1. 第一次问「要不要删」——不可逆；
   *  2. 有未提交改动时，再问一次「确定连这些改动一起丢」——`remove` 不带 `force` 会拒绝，
   *     所以第二次的答案是「带 force 重试」。
   *
   * 删完**必须展示 warnings**：`ok:true` 不代表全删干净（分支可能还被别处检出而保留），
   * 只报「已删除」会让用户以为磁盘清空了。
   */
  const remove = async (): Promise<void> => {
    const ok = await dialog.confirm({
      title: t('cf.wt.remove.title'),
      message: t('cf.wt.remove.confirm').replace('{path}', view.path),
      confirmText: t('cf.wt.remove.title'),
      variant: 'danger'
    })
    if (!ok) return

    let res = await window.deva.worktree.remove({ path: view.path })

    if (!res.ok && res.reason === 'dirty') {
      const force = await dialog.confirm({
        title: t('cf.wt.remove.dirtyTitle'),
        message: t('cf.wt.remove.dirtyConfirm').replace('{n}', String(res.dirtyCount ?? 0)),
        confirmText: t('cf.wt.remove.force'),
        variant: 'danger'
      })
      if (!force) return
      res = await window.deva.worktree.remove({ path: view.path, force: true })
    }

    if (!res.ok) {
      toast.show({ variant: 'error', message: res.message ?? t('cf.wt.remove.failed') })
      return
    }

    // 删了一半的那些（分支保留 / 目录没删）逐条说清，不要吞进「已删除」里。
    // 用 warning 而不是 success：这些是没做到的部分。
    for (const w of res.warnings) toast.show({ variant: 'warning', message: w })
    toast.show({ variant: 'success', message: t('cf.wt.remove.done') })
  }

  /**
   * 中止一次没收尾的合并（§4.7 出口一）。
   *
   * **必须传 targetPath**：合并发生在 target 检出目录，不是用户此刻在看的工作区。
   * 传错的表现是「点了没反应、冲突还在」，且不报错。
   */
  const abortMerge = async (targetPath: string): Promise<void> => {
    setBusy(true)
    try {
      const res = await window.deva.git.mergeAbort(targetPath)
      if (!res.ok) {
        toast.show({ variant: 'error', message: res.message || t('cf.wt.merge.abortFailed') })
        return
      }
      toast.show({ variant: 'success', message: t('cf.wt.merge.aborted') })
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  /** 在终端打开 target 检出（§4.7 出口二）：用户在终端里 `git add` + `git merge --continue`。 */
  const openInTerminal = async (targetPath: string): Promise<void> => {
    try {
      // 80×24 只是新 PTY 的初始尺寸；终端面板挂载后会按自己的几何 resize，不需精确。
      await window.deva.terminal.create({ cwd: targetPath, cols: 80, rows: 24 })
    } catch (e) {
      toast.show({ variant: 'error', message: (e as Error)?.message ?? t('cf.wt.revealFailed') })
    }
  }

  /**
   * 在文件管理器打开 target 检出（§4.7 出口三）。
   *
   * 通道对它做受信根校验，不在根内会返回 `ok:false` **且不抛错**——不把这条报出来，
   * 用户看到的就是「点了没反应」。主进程在 merge / list 两处都会 trustRoot(targetPath)，
   * 走到这里仍失败说明确实越界，得让人知道。
   */
  const revealTarget = async (targetPath: string): Promise<void> => {
    const res = await window.deva.fs.revealFolder(targetPath)
    if (!res.ok) toast.show({ variant: 'error', message: t('cf.wt.revealFailed') })
  }

  /**
   * 重建（T3.3）：目录被手工删掉后，按原分支重新 `git worktree add` 出来。
   *
   * 只在 `state === 'dir-missing'` 时出现——`prunable` 走的是「移除登记」而不是重建：
   * 前者是目录真的没了要重新拉，后者是 git 还记着一条已经无效的登记。
   *
   * 失败原因**逐条如实报**：`dir-exists`（有人又建回去了）、`branch-missing`（分支被删了，
   * 重建等于新开分支，不能默认替用户做）、`verify-failed`（建完回读对不上，最该让人知道）。
   */
  const rebuild = async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await window.deva.worktree.rebuild({ path: view.path })
      if (!res.ok) {
        /*
         * 分因文案为主，技术细节按 reason 分流（见 REBUILD_FAIL_KEEPS_DETAIL）。
         *
         * 路径 / 分支名取 `view` 而不是从 `res.message` 里解析：`view` 的 `path`、`branch`
         * 在协议里都是**必填**（`WorktreeListItem`），后端那两处失败时并没有回填 `path`/`branch`，
         * 它只在 `message` 里拼了一句话。用 `view` 才能保证占位符一定有值、不出现「目录还在（）」。
         */
        const reason = res.reason ?? 'add-failed'
        const text = t(REBUILD_FAIL_KEY[reason])
          .replace('{path}', view.path)
          .replace('{branch}', view.branch)
        toast.show({
          variant: 'error',
          title: text,
          ...(REBUILD_FAIL_KEEPS_DETAIL.has(reason) && res.message ? { message: res.message } : {})
        })
        return
      }
      toast.show({ variant: 'success', message: t('cf.wt.rebuildDone') })
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  /**
   * 移除登记（A33 / `state === 'prunable'`）：目录已经不在，只清掉 git 里那条失效的 worktree 登记。
   *
   * 复用 `worktree:remove` 而不另开通道：主进程对「目录不在」的分支本来就是只清登记。
   * 但**必须显式传 `deleteBranch: false`**：`remove` 的默认语义是「用户要删掉整个工作区」，
   * 于是 `deleteBranch !== false` → 默认连分支一起删。分支上是用户还没合走的提交，
   * 清一条失效登记不该把它们带走（这是 A33 与「分支保留」的分界）。
   */
  const prune = async (): Promise<void> => {
    setBusy(true)
    try {
      const res = await window.deva.worktree.remove({ path: view.path, deleteBranch: false })
      if (!res.ok) {
        toast.show({ variant: 'error', message: res.message ?? t('cf.wt.remove.failed') })
        return
      }
      for (const w of res.warnings) toast.show({ variant: 'warning', message: w })
      toast.show({ variant: 'success', message: t('cf.wt.remove.pruneDone') })
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const stateKey = STATE_KEY[view.state]
  // branch-mismatch 的文案要带「实际检出的是哪个分支」：只说「不匹配」用户不知道该切回哪。
  const stateText =
    view.state === 'branch-mismatch'
      ? t(stateKey)
          .replace('{actual}', view.actualBranch ?? t('cf.wt.detached'))
          .replace('{branch}', view.branch)
      : t(stateKey)

  const badState = view.state !== 'ok'
  const noSession = view.sessionCount === 0
  const installing = view.deps === 'installing'
  const dirGone = view.state === 'dir-missing' || view.state === 'prunable'

  // sizeBytes 的三种展示（见文件头注释：null 的语义由 state 区分）。
  const sizeText =
    view.sizeBytes != null ? formatBytes(view.sizeBytes) : dirGone ? t('cf.wt.sizeUnknown') : t('cf.wt.sizePending')

  return (
    <article className={`cf-wt__card${badState ? ' is-bad' : ''}`}>
      <header className="cf-wt__rowhead">
        <span className="cf-wt__branch" title={view.branch}>
          {view.branch}
        </span>
        {/* state 与「无关联会话」两枚 badge 并列，互不覆盖（§2.5 / A54） */}
        {badState && <span className="cf-wt__badge is-bad">{stateText}</span>}
        {noSession && <span className="cf-wt__badge">{t('cf.wt.noSession')}</span>}
        {view.deps !== 'ready' && view.deps !== 'skipped' && (
          <span className={`cf-wt__badge${view.deps === 'failed' ? ' is-bad' : ''}`}>{t(DEPS_KEY[view.deps])}</span>
        )}
      </header>

      <div className="cf-wt__path" title={view.path}>
        {view.path}
      </div>

      <div className="cf-wt__meta">
        <span className="cf-wt__metaitem" title={t('cf.wt.sessionCount').replace('{n}', String(view.sessionCount))}>
          <Archive size={11} />
          {t('cf.wt.sessionCount').replace('{n}', String(view.sessionCount))}
        </span>
        <span className="cf-wt__metaitem">
          <HardDrive size={11} />
          {sizeText}
        </span>
        {/*
          dirtyCount（§7.7「N 个未提交改动」）：`null` 与 `0` 语义不同，**不能当成同一件事**——
          `null` 是「目录不在、无法统计」，`0` 是「目录在且干净」。把 null 渲染成 0 会让用户以为
          工作区是干净的，而实际是根本没法看。
        */}
        {view.dirtyCount === null ? (
          <span className="cf-wt__metaitem">{t('cf.wt.dirtyUnknown')}</span>
        ) : view.dirtyCount > 0 ? (
          <span
            className="cf-wt__metaitem is-warn"
            title={t('cf.wt.dirtyMeta').replace('{n}', String(view.dirtyCount))}
          >
            {t('cf.wt.dirtyMeta').replace('{n}', String(view.dirtyCount))}
          </span>
        ) : (
          <span className="cf-wt__metaitem">{t('cf.wt.dirtyClean')}</span>
        )}
        {view.baseLabel && (
          <span className="cf-wt__metaitem" title={view.baseLabel}>
            {t('cf.wt.baseLabel').replace('{label}', view.baseLabel)}
          </span>
        )}
        {/* 另一个会话正在操作 git：说明「现在动不了」而不是「坏了」 */}
        {view.lockHolder && (
          <span className="cf-wt__metaitem is-warn">
            <Lock size={11} />
            {t('cf.wt.lockedBy').replace('{label}', view.lockHolder.label)}
          </span>
        )}
      </div>

      {/*
        依赖装失败：明细与「会话仍可使用」**同屏**出现（§7.7 屏⑤）。
        只说失败不说还能用，用户会以为整个工作区废了——而实际只是 pnpm / npm 类命令会失败。
      */}
      {view.deps === 'failed' && (
        <div className="cf-wt__depsfail">
          <div className="cf-wt__depsstill">{t('cf.wt.deps.stillUsable')}</div>
          {view.depsDetail && <div className="cf-wt__depsdetail">{view.depsDetail}</div>}
          <button
            type="button"
            className="btn btn--ghost cf-wt__depsretry"
            onClick={() =>
              void retryDeps(view.path, t, (msg) => toast.show({ variant: 'error', message: msg }))
            }
          >
            {t('cf.wt.deps.retry')}
          </button>
        </div>
      )}

      {/*
        合并进行中（§13.10）：target 检出里还有没收尾的合并。这里给的是「有几处冲突」这一个事实，
        以及**能立刻收尾的三个出口**（§4.7 的平权原则：都不做 primary，用户已经做了工作，
        不诱导放弃）。
        不在这里做冲突解决面板——spec §0.1 的「不做」清单里明确排除；解冲突交给终端，
        应用只负责把用户送到能解的地方，并让「放弃这次合并」随时可做。
      */}
      {view.mergeInProgress !== null && (
        <div className="cf-wt__note is-warn">
          <span>{t('cf.wt.mergeInProgress').replace('{n}', String(view.mergeInProgress.unmergedCount))}</span>
          <span className="cf-wt__exits">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={busy}
              onClick={() => void abortMerge(view.mergeInProgress!.targetPath)}
            >
              {t('cf.wt.merge.abortMerge')}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void openInTerminal(view.mergeInProgress!.targetPath)}
            >
              {t('cf.wt.merge.openTerminal')}
            </button>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void revealTarget(view.mergeInProgress!.targetPath)}
            >
              {t('cf.wt.merge.reveal')}
            </button>
          </span>
        </div>
      )}

      <footer className="cf-wt__actions">
        {/*
          合并按钮的可用性**只读** `mergeGate`（A48）：主进程算、界面照着禁用。
          这里不出现任何 `state === ...` 的推断——两处各算一遍，迟早一处说能、一处拒绝，
          用户看到的就是「按钮能点，点了报错」。

          `mayMerge` 为假时禁用并说明原因；为真时打开合并面板（真实 `worktree:merge`）。
          按钮本身不直接合并：合并要先把四项检查的结果摆给用户看，尤其 C1（有未提交改动不会被合并）
          和 C5（会覆盖目标目录的哪些改动）——静默执行等于把「你改了但没合过去」变成用户的困惑。
        */}
        <button
          type="button"
          className="btn btn--ghost"
          disabled={!view.mergeGate.mayMerge}
          title={
            view.mergeGate.blocker
              ? t(BLOCKER_KEY[view.mergeGate.blocker])
              : t('cf.wt.merge.title').replace('{target}', view.targetBranch ?? '')
          }
          onClick={() => setMergeOpen(true)}
        >
          {t('cf.wt.merge.merge')}
        </button>
        {/* 重建只对「目录不在」有意义；prunable 走「移除登记」（A33：必须用户点） */}
        {view.state === 'dir-missing' && (
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy || installing}
            onClick={() => void rebuild()}
          >
            <RotateCcw size={13} />
            {t('cf.wt.rebuild')}
          </button>
        )}
        {view.state === 'prunable' && (
          <button
            type="button"
            className="btn btn--ghost"
            disabled={busy || installing}
            title={t('cf.wt.remove.pruneHint')}
            onClick={() => void prune()}
          >
            <Scissors size={13} />
            {t('cf.wt.remove.prune')}
          </button>
        )}
        {view.state === 'branch-mismatch' && (
          <button type="button" className="btn btn--ghost" onClick={() => void revealTarget(view.path)}>
            <FolderSearch size={13} />
            {t('cf.wt.reveal')}
          </button>
        )}
        {/* 安装中无条件不给删（R8 / A53）：不给勾选项，说明原因即可 */}
        <button
          type="button"
          className="btn btn--ghost btn--danger"
          disabled={installing}
          title={installing ? t('cf.wt.remove.installing') : t('cf.wt.remove.branchKept').replace('{branch}', view.branch)}
          onClick={() => void remove()}
        >
          <Trash2 size={13} />
          {t('cf.wt.remove.title')}
        </button>
      </footer>

      {/*
        合并面板（spec §4.5~§4.9.4 / T2.2）。放在卡片内而不是全局弹层：它的所有操作都以这张卡片
        的工作区为主语（往哪个目标合、targetPath 是哪个），脱离卡片容易让用户对「在合哪个」失焦。
        `onMerged` 交给上层重拉列表——合并后 targetBranch / mergeGate 都可能变，让主进程重算。
      */}
      {mergeOpen && (
        <MergePanel
          view={view}
          onClose={() => setMergeOpen(false)}
          onMerged={() => {
            void refresh()
          }}
        />
      )}
    </article>
  )
}

/**
 * 「重试安装」走**真实**的 IPC（`worktree:install-deps` 已在 `4b07711` 接通）。
 *
 * 它立刻返回、不等安装完成：进度走 `onProgress`，终态（ready / failed）由主进程发 `worktree:changed`，
 * store 收到后重拉列表，这张卡片上的 deps 自己就变了。故这里不需要任何本地状态。
 *
 * 只有「发起就没发起来」需要立刻说（已在装 / 没 lockfile / 项目语言不支持 / 写记录失败），
 * 否则用户点了看不到任何动静。失败原因用主进程回的 `reason` 取文案，取不到就原样显示原因码。
 */
async function retryDeps(path: string, t: (k: string) => string, showMsg: (msg: string) => void): Promise<void> {
  try {
    const res: WorktreeInstallResult = await window.deva.worktree.installDeps(path)
    if (res.ok) return
    const reason = res.reason ?? 'error'
    const key = `cf.wt.deps.retryReason.${reason}`
    const mapped = t(key)
    showMsg(mapped === key ? reason : mapped)
  } catch (e) {
    showMsg((e as Error)?.message ?? String(e))
  }
}
