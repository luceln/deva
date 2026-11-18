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
import { useWorktree } from '../store/worktree'
import type {
  MergeBlocker,
  WorktreeInstallResult,
  WorktreeListItem,
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
 * 主进程已经算好四个 blocker 的优先级，界面连「哪个先」都不判。真正的 `worktree:merge` IPC 还没落地（P2），
 * 所以 `mayMerge` 为真时点下去给的是「还没接通」——这两种状态必须能区分：一个是「你需要先做点什么」，
 * 另一个是「这个功能还没做」。
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
  /** 未接通的按钮点了之后的短暂反馈（删除/重建/prune/合并的 IPC 还没落地）。 */
  const [pending, setPending] = useState<string | null>(null)

  const rows = snapshot?.items ?? []
  const unmanaged = snapshot?.unmanaged ?? []

  /*
   * 删除 / 重建 / prune / 合并的 IPC（T3.1 / T3.3 / T2.x）还没落地，故这里**不假装成功**：
   * 点下去只提示「这个操作还没接通」，不弹「已删除」这种假 toast。
   * IPC 到位后把这些换成真实调用即可，卡片结构与样式都不用动。
   */
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
          <WorktreeCard key={w.compareKey || w.path} view={w} pending={pending} onNotWired={notWired} />
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

/** 一张卡片。`pending` 用于「操作未接通」时的短暂反馈（见外层注释）。 */
function WorktreeCard({
  view,
  pending,
  onNotWired
}: {
  view: WorktreeListItem
  pending: string | null
  onNotWired: (name: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const toast = useToast()

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
        冲突处理窗口属于 P2 还没做，所以按钮明确标成未接通——不假装点了能打开。
      */}
      {view.mergeInProgress !== null && (
        <div className="cf-wt__note is-warn">
          <span>{t('cf.wt.mergeInProgress').replace('{n}', String(view.mergeInProgress.unmergedCount))}</span>
          <button type="button" className="btn btn--ghost cf-wt__notebtn" onClick={() => onNotWired('conflicts')}>
            {t('cf.wt.merge.resolve')}
          </button>
        </div>
      )}

      <footer className="cf-wt__actions">
        {/*
          合并按钮的可用性**只读** `mergeGate`（A48）：主进程算、界面照着禁用。
          这里不出现任何 `state === ...` 的推断——两处各算一遍，迟早一处说能、一处拒绝，
          用户看到的就是「按钮能点，点了报错」。

          `mergeGate` 有 blocker 时禁用并说明原因；`mayMerge` 为真时按钮可用，但真正的
          `worktree:merge` IPC 还没落地（P2），点了给诚实的未接通提示。两种状态必须区分开：
          把「不能合并」和「还没做」混成同一种表现，用户没法判断是该改点什么还是该等版本。
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
