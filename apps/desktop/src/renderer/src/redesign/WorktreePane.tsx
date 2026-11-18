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
import { useWorktree } from '../store/worktree'
import type { DepsState, MergeBlocker, WorktreeState, WorktreeView } from '../store/worktree-view'
import './worktree-pane.css'

/**
 * 设置 › 工作区：worktree 列表（spec §7.4 / §7.5、原型面 3）。
 *
 * ## 这个面板最重要的一条：什么都不推断
 *
 * `state`、`deps`、`sessionCount`、`dirtyCount`、`sizeBytes`、`mergeGate` **全部原样显示主进程给的值**。
 * 界面里看不到任何一处 `if (state === ...) 认为能合并` —— 那正是 A48 / R13 要防的事：
 * 两处各算一遍，迟早一处说能、一处拒绝，而用户只会看到「按钮能点，点了报错」。
 *
 * 具体到「合并」按钮：可用性只读 `mergeGate.mayMerge`。`state` 是 `branch-mismatch` 时按钮之所以禁用，
 * 是因为**主进程在 mergeGate 里已经这么说了**，不是因为界面看到了 `branch-mismatch`。
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

const DEPS_KEY: Record<DepsState, string> = {
  pending: 'cf.wt.deps.pending',
  installing: 'cf.wt.deps.installing',
  ready: 'cf.wt.deps.ready',
  failed: 'cf.wt.deps.failed',
  skipped: 'cf.wt.deps.skipped'
}

const BLOCKER_KEY: Record<MergeBlocker, string> = {
  'target-not-set': 'cf.wt.merge.targetNotSet',
  'source-missing': 'cf.wt.merge.notCheckedOut',
  'source-branch-changed': 'cf.wt.merge.sourceBranchChanged',
  installing: 'cf.wt.deps.installing'
}

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
  const [pending, setPending] = useState<string | null>(null)

  const rows = snapshot?.worktrees ?? []
  const unmanaged = snapshot?.unmanaged ?? []

  // 操作（删除 / 重建 / prune）目前没有 IPC：主进程侧 T3.1/T3.3 还没落地。
  // 这里**不假装成功**——点下去先禁用并说明「尚未接通」，而不是弹个 toast 说删好了。
  // 等 IPC 到位后，把 onRemove / onRebuild / onPrune 换成真实调用即可，卡片结构不用动。
  const notWired = (name: string): void => {
    setPending(name)
    setTimeout(() => setPending(null), 1200)
  }

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

      {rows.length === 0 && !loading && !error && <div className="cf-wt__empty">{t('cf.wt.empty')}</div>}

      <div className="cf-wt__list">
        {rows.map((w) => (
          <WorktreeCard
            key={w.compareKey || w.path}
            view={w}
            pending={pending}
            onNotWired={notWired}
          />
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

      {snapshot?.memoryRoot && (
        <p className="cf-wt__memnote">
          {t('cf.wt.memoryShared').replace('{repoRoot}', snapshot.memoryRoot)}
        </p>
      )}
    </div>
  )
}

/** 一张卡片。`pending` 用于「操作未接通」时的短暂反馈（见外层注释）。 */
function WorktreeCard({
  view,
  pending,
  onNotWired
}: {
  view: WorktreeView
  pending: string | null
  onNotWired: (name: string) => void
}): React.JSX.Element {
  const { t } = useI18n()

  const stateKey = STATE_KEY[view.state]
  // branch-mismatch 的文案要带「实际检出的是哪个分支」：只说「不匹配」用户不知道该切回哪。
  const stateText =
    view.state === 'branch-mismatch'
      ? t(stateKey)
          .replace('{actual}', view.detail?.headBranch ?? t('cf.wt.detached'))
          .replace('{branch}', view.branch)
      : t(stateKey)

  const badState = view.state !== 'ok'
  const noSession = view.sessionCount === 0
  const installing = view.deps === 'installing'
  const dirGone = view.state === 'dir-missing' || view.state === 'prunable'

  // sizeBytes 的三种展示（见文件头注释：null 的语义由 state 区分）。
  const sizeText =
    view.sizeBytes != null
      ? formatBytes(view.sizeBytes)
      : dirGone
        ? t('cf.wt.sizeUnknown')
        : t('cf.wt.sizePending')

  // 合并按钮：只读主进程给的 mergeGate，绝不按 state 自己推算（A48 / R13）。
  const mayMerge = view.mergeGate?.mayMerge === true
  const blockerText = view.mergeGate?.blocker ? t(BLOCKER_KEY[view.mergeGate.blocker]) : ''

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
        {view.dirtyCount != null && view.dirtyCount > 0 && (
          <span className="cf-wt__metaitem is-warn" title={t('cf.wt.dirtyMeta').replace('{n}', String(view.dirtyCount))}>
            {t('cf.wt.dirtyMeta').replace('{n}', String(view.dirtyCount))}
          </span>
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

      {view.mergeInProgress && (
        <div className="cf-wt__note is-warn">{t('cf.wt.mergeInProgress').replace('{n}', String(view.mergeInProgress.unmergedCount))}</div>
      )}
      {view.deps === 'failed' && view.depsDetail && <div className="cf-wt__note is-bad">{view.depsDetail}</div>}

      <footer className="cf-wt__actions">
        <button
          type="button"
          className="btn btn--ghost"
          disabled={!mayMerge}
          title={mayMerge ? t('cf.wt.merge.title').replace('{target}', view.targetBranch ?? '') : blockerText}
          onClick={() => onNotWired('merge')}
        >
          {t('cf.wt.merge.merge')}
        </button>
        {/* 重建只对「目录不在」有意义；prunable 走「移除登记」（A33：必须用户点） */}
        {view.state === 'dir-missing' && (
          <button type="button" className="btn btn--ghost" onClick={() => onNotWired('rebuild')}>
            <RotateCcw size={13} />
            {t('cf.wt.rebuild')}
          </button>
        )}
        {view.state === 'prunable' && (
          <button
            type="button"
            className="btn btn--ghost"
            title={t('cf.wt.remove.pruneHint')}
            onClick={() => onNotWired('prune')}
          >
            <Scissors size={13} />
            {t('cf.wt.remove.prune')}
          </button>
        )}
        {view.state === 'branch-mismatch' && (
          <button type="button" className="btn btn--ghost" onClick={() => onNotWired('reveal')}>
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
          onClick={() => onNotWired('remove')}
        >
          <Trash2 size={13} />
          {t('cf.wt.remove.title')}
        </button>
        {pending && <span className="cf-wt__pending">{t('cf.wt.notWired')}</span>}
      </footer>
    </article>
  )
}
