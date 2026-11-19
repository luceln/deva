/**
 * 工作区合并面板（spec §4.5~§4.9.4、§7.2、T2.2）。
 *
 * ## 为什么单独一个文件
 *
 * `WorktreePane.tsx` 是「列表 + 卡片 + 各操作」的组合层。合并面板有它自己的三块状态机
 * （检查 → 二选一 → 成功/失败），塞进卡片会把卡片撑成第二个壳，也不符合「新功能单独建文件」的约定。
 *
 * ## 几个必须照规格做的点（做错了会被验收打回）
 *
 * 1. **四个圆点按数组顺序渲染，不按 status 过滤**（§4.6 硬约束）。`checks.length === 0` 只有
 *    `target-not-set` 一种情况，那时不画圆点、改出目标分支选择器。**不得**在第一个 bad 处 return。
 * 2. **C1 是 `warn` 不是 `bad`**：它不阻断合并（长期带改动开发是常态），但必须可见——
 *    不提示的话用户会以为「我改了但它没合过去」是 bug。
 * 3. **`message` 在检查阶段是空串**，文案全部按 `checks[].reason` + `detail` 在渲染层拼（§7.4）。
 *    唯一例外是 `conflict` / `merge-failed` 的 `message`——那是 git 原文，
 *    用户要的是 `CONFLICT (content): Merge conflict in src/x.ts` 这一行，**原样显示，不翻译**。
 * 4. **失败出口四个平权**（§4.7）：全部 `--sm`，都不做 primary。把「中止合并」做成 primary
 *    会诱导用户放弃已经做的工作。
 * 5. **中止合并必须传 `targetPath`**，不能传当前会话的 `focusRoot`。合并发生在 target 检出目录；
 *    传错的表现是「点了没反应、冲突还在」，而且静默无报错。
 * 6. **自动 stash 是明确禁止项**（§4.7）。只有用户在 C5 提示上显式点「先存起来再合并」才传
 *    `stashFirst: true`。
 */

import { useEffect, useState } from 'react'
import { AlertTriangle, Check, ExternalLink, FolderSearch, Loader2, Terminal, XCircle } from 'lucide-react'
import { useI18n } from '../i18n/i18n'
import { useToast } from '../components/ToastProvider'
import type { MergeCheck, MergeResult, WorktreeListItem } from '../../../shared/worktree-protocol'

/** 圆点颜色：ok=绿 / warn=黄 / bad=红 / skipped=灰（§4.6 的 status 语义）。 */
const DOT_CLASS: Record<MergeCheck['status'], string> = {
  ok: 'is-ok',
  warn: 'is-warn',
  bad: 'is-bad',
  skipped: 'is-skipped'
}

/**
 * 每条检查的标题键。**按 id 取，不按 status 取**——四个圆点各代表一件固定的事，
 * 无论通过与否标题都一样，用户才能横向对比「上次这条是绿的，这次黄了」。
 */
const CHECK_LABEL: Record<MergeCheck['id'], string> = {
  C1: 'cf.wt.merge.check.C1',
  C2: 'cf.wt.merge.check.C2',
  C4: 'cf.wt.merge.check.C4',
  C5: 'cf.wt.merge.check.C5'
}

/**
 * `reason` → 说明文案键。`reason` 是规格 §7.2 定的稳定键，**不用主进程的 `message`**：
 * 检查阶段主进程返回空串（文案统一在渲染层，才不会中英各拼一套、漏翻一半）。
 *
 * `undefined` 表示「通过，不用解释」，条目右键退到标题本身。
 */
const REASON_KEY: Record<string, string> = {
  dirty: 'cf.wt.merge.reason.dirty',
  'branch-changed': 'cf.wt.merge.reason.branchChanged',
  busy: 'cf.wt.merge.reason.busy',
  'source-missing': 'cf.wt.merge.reason.sourceMissing',
  'not-checked-out': 'cf.wt.merge.reason.notCheckedOut',
  overlap: 'cf.wt.merge.reason.overlap',
  unknown: 'cf.wt.merge.reason.unknown'
}

/**
 * 拼「复制命令」的字符串（§4.7，与原型的剪贴板内容逐字一致）。
 *
 * 三条硬要求：
 *  1. **必须带 `cd`**：合并发生在 target 检出目录，用户最容易误以为在自己会话的 worktree 里。
 *  2. **Windows 用 `cd /d`**（跨盘符必需），其它平台 `cd`。
 *  3. **用分支名而不是 SHA**：与执行路径相反，是刻意的——手工执行时分支名可读、可补全。
 *     副作用是手工执行可能合到更新的提交，那是用户自己动手时的合理预期。
 */
export function mergeCommand(targetPath: string, branch: string, platform: string): string {
  const cd = platform === 'win32' ? 'cd /d' : 'cd'
  return `${cd} "${targetPath}" && git merge --no-ff ${branch}`
}

/** 冲突时的备选命令（同一按钮的第二行，或冲突面板里换掉执行那条）。 */
export function abortCommand(targetPath: string, platform: string): string {
  const cd = platform === 'win32' ? 'cd /d' : 'cd'
  return `${cd} "${targetPath}" && git merge --abort`
}

/** 短 SHA（7 位）。git 自己也是这个长度，用户拿去 `git show` 能直接命中。 */
function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

function detailNum(c: MergeCheck, key: string): number {
  const v = c.detail?.[key]
  return typeof v === 'number' ? v : 0
}

function detailStr(c: MergeCheck, key: string): string {
  const v = c.detail?.[key]
  return typeof v === 'string' ? v : ''
}

function detailList(c: MergeCheck, key: string): string[] {
  const v = c.detail?.[key]
  return Array.isArray(v) ? v : []
}

/**
 * 单个检查项的说明句。`{n}` / `{branch}` / `{op}` / `{path}` 按 `detail` 填。
 * 填不出关键数字时返回空串（宁可不显示，也不显示「有 0 个改动」这种错话）。
 */
function checkText(c: MergeCheck, t: (k: string) => string): string {
  const key = c.reason ? REASON_KEY[c.reason] : undefined
  if (!key) return ''
  let s = t(key)
  if (s.includes('{n}')) {
    const n = detailNum(c, 'dirtyCount')
    if (!n) return ''
    s = s.replace('{n}', String(n))
  }
  if (s.includes('{branch}')) s = s.replace('{branch}', detailStr(c, 'primaryBranch'))
  if (s.includes('{actual}')) s = s.replace('{actual}', detailStr(c, 'actualBranch'))
  if (s.includes('{op}')) s = s.replace('{op}', detailStr(c, 'busyOp'))
  if (s.includes('{path}')) s = s.replace('{path}', detailStr(c, 'targetPath') || detailStr(c, 'primaryBranch'))
  return s
}

interface Props {
  view: WorktreeListItem
  onClose: () => void
  /** 「再次合并」用：合并成功后 source 又有了新提交（§4.8 的 `behindNote`）。 */
  onMerged: () => void
}

export function MergePanel({ view, onClose, onMerged }: Props): React.JSX.Element {
  const { t } = useI18n()
  const toast = useToast()
  const platform = window.deva.platform

  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<MergeResult | null>(null)
  /** 目标分支选择器的候选（只在 `target-not-set` 时才拉）。 */
  const [branches, setBranches] = useState<string[] | null>(null)
  const [picked, setPicked] = useState('')
  const [showOutput, setShowOutput] = useState(false)

  /**
   * 拉候选分支。**只本地分支、不含远端**：远端分支没有被检出，不能作为 merge 的 cwd。
   * 也**不自动挑一个**当目标——用户没指定过目标就替他选，等于替他决定代码往哪合。
   *
   * 为什么在 target-not-set 时立刻拉、而不是等 select 的 focus：无头/键盘场景下 focus 不一定触发，
   * 用户点开下拉却看到空列表会以为「没有分支可选」。这个请求只读一次 git，代价可以接受。
   */
  const loadBranches = async (): Promise<void> => {
    // 用 ref 之外的简单幂等：重复请求无害（只读 git），所以不再靠 branches 短路，
    // 避免「effect 闭包里拿到旧的 null → 请求发出去了但 state 又被别处覆盖」这类难查的空列表。
    const list = await window.deva.git.branches(view.path)
    const local = list.filter((b) => b.remote === null).map((b) => b.name)
    setBranches(local)
  }

  /** 跑一次合并。`stashFirst` 只由用户在 C5 提示上显式点选时传（自动 stash 是禁止项）。 */
  const run = async (opts?: { stashFirst?: boolean }): Promise<void> => {
    setBusy(true)
    setShowOutput(false)
    try {
      const res = await window.deva.worktree.merge({ path: view.path, ...opts })
      setResult(res)
      if (res.ok) onMerged()
    } finally {
      setBusy(false)
    }
  }

  /** 选中目标分支并写回，然后重走合并（§4.9.4 的「不要自动挑一个」）。 */
  const saveTarget = async (): Promise<void> => {
    if (!picked) return
    setBusy(true)
    try {
      const res = await window.deva.worktree.setTarget({ path: view.path, targetBranch: picked })
      if (!res.ok) {
        toast.show({ variant: 'error', message: res.message })
        return
      }
      setResult(null)
      await run()
    } finally {
      setBusy(false)
    }
  }

  /** 复制命令（纯前端拼串）。复制失败要说出来——静默失败用户会以为剪贴板里有了。 */
  const copy = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text)
      toast.show({ variant: 'success', message: t('cf.wt.merge.copied') })
    } catch {
      toast.show({ variant: 'error', message: t('cf.wt.merge.copyFailed') })
    }
  }

  const targetPath = result ? (result.ok ? result.targetPath : result.targetPath) : undefined

  /* ── 目标未指定：出选择器，不画圆点（checks 为空） ── */
  const needTarget = result !== null && !result.ok && result.reason === 'target-not-set'

  // target-not-set 时立刻去拉候选分支（一次只读 IPC），不等用户点开下拉
  useEffect(() => {
    if (needTarget) void loadBranches()
    // loadBranches 只依赖 view.path 与当前 branches；needTarget 翻转时才需要重试。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needTarget])

  /* ── 成功 ── */
  const ok = result?.ok === true ? result : null
  /* ── 失败（含检查阶段、冲突、合并失败） ── */
  const bad = result && !result.ok ? result : null

  /**
   * C5 交集非空：**二选一，不是拦死**（§4.9.4）。
   * 判据是 `reason === 'target-overlap'`，不是 `checks` 里有 bad 的 C5——后者也可能是 `busy`。
   */
  const overlap = bad?.reason === 'target-overlap' ? bad.checks.find((c) => c.id === 'C5') : null
  /** 覆盖清单：优先取 `overlapPaths`（主进程给），拿不到时退回 `blockedPaths`（兜底解析）。 */
  const overlapPaths = overlap
    ? (detailList(overlap, 'overlapPaths').length > 0
        ? detailList(overlap, 'overlapPaths')
        : (bad?.blockedPaths ?? []))
    : []

  return (
    <div className="cf-wt-merge" role="dialog" aria-label={t('cf.wt.merge.merge')}>
      <header className="cf-wt-merge__head">
        <h3>
          {t('cf.wt.merge.title').replace('{target}', view.targetBranch ?? t('cf.wt.merge.noTarget'))}
        </h3>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
          {t('cf.wt.merge.close')}
        </button>
      </header>

      {/* 来源 → 目标，让用户一眼看清往哪合 */}
      <p className="cf-wt-merge__route">
        {view.branch} → {view.targetBranch ?? t('cf.wt.merge.noTarget')}
      </p>

      {/* ── 目标选择器（target-not-set 时） ── */}
      {needTarget && (
        <section className="cf-wt-merge__pick">
          <p>{t('cf.wt.merge.targetNotSet')}</p>
          <div className="cf-wt-merge__pickrow">
            <select
              className="cf-wt-merge__select"
              value={picked}
              /*
               * 列表为空时再拉一次：进页那一刻 git 正忙 / 刚切过分支，可能拿到空列表；
               * 用户点开下拉看到空的不该只能干瞪眼。
               */
              onFocus={() => {
                if (!branches || branches.length === 0) void loadBranches()
              }}
              onClick={() => {
                if (!branches || branches.length === 0) void loadBranches()
              }}
              onChange={(e) => setPicked(e.target.value)}
              aria-label={t('cf.wt.merge.pickTarget')}
            >
              <option value="">{t('cf.wt.merge.pickTarget')}</option>
              {(branches ?? []).map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={!picked || busy}
              onClick={() => void saveTarget()}
            >
              {t('cf.wt.merge.useTarget')}
            </button>
          </div>
        </section>
      )}

      {/* ── 四个圆点：按数组顺序，不过滤。length === 0 时不画（那就是 target-not-set） ── */}
      {bad && bad.checks.length > 0 && (
        <section className="cf-wt-merge__checks">
          {bad.checks.map((c) => {
            const text = checkText(c, t)
            return (
              <div key={c.id} className="cf-wt-merge__check">
                <span className={`cf-wt-merge__dot ${DOT_CLASS[c.status]}`} aria-hidden />
                <div>
                  <div className="cf-wt-merge__checklabel">{t(CHECK_LABEL[c.id])}</div>
                  {text && <div className="cf-wt-merge__checktext">{text}</div>}
                </div>
              </div>
            )
          })}
        </section>
      )}

      {/* ── 成功面板（§4.8） ── */}
      {ok && (
        <section className="cf-wt-merge__ok">
          <div className="cf-wt-merge__okhead">
            <Check size={14} />
            <span>
              {ok.upToDate
                ? t('cf.wt.merge.upToDate')
                : t('cf.wt.merge.success').replace('{target}', ok.targetBranch)}
            </span>
          </div>
          {/* upToDate 时不显示 SHA 与原文——没有合并提交，显示会是空承诺 */}
          {!ok.upToDate && ok.mergeCommit && (
            <div className="cf-wt-merge__sha">
              {t('cf.wt.merge.successSha').replace('{sha}', shortSha(ok.mergeCommit))}
            </div>
          )}
          {!ok.upToDate && ok.gitOutput && (
            <>
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                aria-expanded={showOutput}
                onClick={() => setShowOutput((v) => !v)}
              >
                {showOutput ? t('cf.wt.merge.hideOutput') : t('cf.wt.merge.showOutput')}
              </button>
              {showOutput && <pre className="cf-wt-merge__pre">{ok.gitOutput}</pre>}
            </>
          )}
          {/* stash 流程的两条后果必须说清：改动回来了但暂存态丢了 / pop 有冲突 */}
          {ok.stash && ok.stash.unstagedLost.length > 0 && (
            <p className="cf-wt-merge__note">
              {t('cf.wt.merge.stashUnstaged').replace('{n}', String(ok.stash.unstagedLost.length))}
            </p>
          )}
          {ok.stash?.popConflict && (
            <p className="cf-wt-merge__note is-warn">{t('cf.wt.merge.stashPopConflict')}</p>
          )}
          {/* behindNote：不自动重试，给按钮让用户决定（§4.8） */}
          {ok.behindNote && (
            <div className="cf-wt-merge__behind">
              <span>{t('cf.wt.merge.behind').replace('{n}', String(ok.behindNote.pendingCount))}</span>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => void run()}>
                {t('cf.wt.merge.again')}
              </button>
            </div>
          )}
        </section>
      )}

      {/* ── C5 交集非空：二选一（§4.9.4） ── */}
      {overlap && (
        <section className="cf-wt-merge__overlap">
          <p>
            {t('cf.wt.merge.overlapTitle').replace('{n}', String(overlapPaths.length || detailNum(overlap, 'dirtyCount')))}
          </p>
          {/* 覆盖清单：用户点「先存起来再合并」前必须看到是哪几个文件 */}
          {overlapPaths.length > 0 && (
            <ul className="cf-wt-merge__paths">
              {overlapPaths.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          <div className="cf-wt-merge__row">
            {/*
              「先存起来再合并」→ 带 stashFirst 重调 merge。
              这是**唯一**允许的 stash 用法（§4.9.5 的手工三步），自动 stash 是禁止项。
            */}
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              disabled={busy}
              onClick={() => void run({ stashFirst: true })}
            >
              {t('cf.wt.merge.stashThenMerge')}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowOutput(true)}>
              {t('cf.wt.merge.iWillHandle')}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setResult(null)}>
              {t('cf.wt.merge.cancel')}
            </button>
          </div>
          {/* 「我去终端自己处理」的落点就在下面（命令块），这里说明该做什么 */}
          {showOutput && <p className="cf-wt-merge__note">{t('cf.wt.merge.iWillHandleHint')}</p>}
        </section>
      )}

      {/* ── 冲突 / 合并失败：git 原文原样显示，不翻译 ── */}
      {bad && (bad.reason === 'conflict' || bad.reason === 'merge-failed') && (
        <section className="cf-wt-merge__fail">
          <div className="cf-wt-merge__failhead">
            <XCircle size={14} />
            <span>
              {bad.reason === 'conflict' ? t('cf.wt.merge.conflict') : t('cf.wt.merge.failed')}
            </span>
          </div>
          {/* 这是本需求里唯一不能本地化的字符串 */}
          {bad.message && <pre className="cf-wt-merge__pre">{bad.message}</pre>}
        </section>
      )}

      {/*
        ── 失败出口（§4.7）：四个平权，全 --sm，都不做 primary ──
        只在「合并真的动过 target」时给（C4 之后才有 targetPath）——
        检查阶段就失败的，用户没有需要收尾的冲突，给中止/终端只会误导。
      */}
      {bad && targetPath && bad.mergeAttempted && (
        <section className="cf-wt-merge__exits">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy}
            onClick={async () => {
              /*
               * **必须传 targetPath**，不能传当前会话的 focusRoot。
               * 合并发生在 target 检出目录；传错的表现是「点了没反应、冲突还在」，静默无报错。
               */
              const res = await window.deva.git.mergeAbort(targetPath)
              if (!res.ok) {
                toast.show({ variant: 'error', message: res.message || t('cf.wt.merge.abortFailed') })
                return
              }
              toast.show({ variant: 'success', message: t('cf.wt.merge.aborted') })
              setResult(null)
            }}
          >
            <AlertTriangle size={13} />
            {t('cf.wt.merge.abortMerge')}
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() =>
              /*
               * 终端尺寸没有先例可抄（这是第一处从非终端面板开终端的调用）。
               * 给 80×24（VT100 以来的常规值）：这只是新终端会话的初始 PTY 尺寸，
               * 真实终端面板挂载后会按自己的几何 resize，所以不需要精确。
               */
              void window.deva.terminal.create({ cwd: targetPath, cols: 80, rows: 24 })
            }
          >
            <Terminal size={13} />
            {t('cf.wt.merge.openTerminal')}
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void window.deva.fs.revealFolder(targetPath)}
          >
            <FolderSearch size={13} />
            {t('cf.wt.merge.reveal')}
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => void copy(mergeCommand(targetPath, bad.sourceBranch, platform))}
          >
            {t('cf.wt.merge.copyCommand')}
          </button>
        </section>
      )}

      {/* 冲突时再给一条中止命令，供用户手工收尾 */}
      {bad && (bad.reason === 'conflict' || bad.reason === 'merge-failed') && targetPath && (
        <div className="cf-wt-merge__cmds">
          <div className="cf-wt-merge__cmdrow">
            <code>{abortCommand(targetPath, platform)}</code>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void copy(abortCommand(targetPath, platform))}
            >
              <ExternalLink size={12} />
              {t('cf.wt.merge.copyAbort')}
            </button>
          </div>
        </div>
      )}

      {/* ── 主操作 ── */}
      {!ok && !needTarget && (
        <footer className="cf-wt-merge__foot">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            disabled={busy || !view.mergeGate.mayMerge}
            title={
              view.mergeGate.blocker
                ? t(BLOCKER_KEY[view.mergeGate.blocker])
                : t('cf.wt.merge.title').replace('{target}', view.targetBranch ?? '')
            }
            onClick={() => void run()}
          >
            {busy ? <Loader2 size={13} className="cf-wt__spin" /> : null}
            {result ? t('cf.wt.merge.retry') : t('cf.wt.merge.merge')}
          </button>
        </footer>
      )}
    </div>
  )
}

/** 与 `WorktreePane` 的 `BLOCKER_KEY` 同口径（主进程算 blocker，界面只翻译）。 */
const BLOCKER_KEY: Record<string, string> = {
  'target-not-set': 'cf.wt.merge.blocker.targetNotSet',
  'source-missing': 'cf.wt.merge.blocker.sourceMissing',
  'source-branch-changed': 'cf.wt.merge.blocker.sourceBranchChanged',
  installing: 'cf.wt.merge.blocker.installing'
}
