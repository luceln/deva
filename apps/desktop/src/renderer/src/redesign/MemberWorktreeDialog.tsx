import { useEffect, useState } from 'react'
import { Modal } from '../components/Modal'
import { useI18n } from '../i18n/i18n'
import { MemberWorktreePanel } from './MemberWorktreePanel'
import type { MemberWorktreeBindView, MemberWorktreeRecoveryView } from './MemberWorktreePanel'
import type { MemberWorktreeState } from '../../../shared/member-worktree-protocol'

interface Props {
  /** A real member session ID, never the session owning a new-member waiting card. */
  sessionId: string
  name: string
  busy: boolean
  onClose: () => void
}

function recoveryView(state: MemberWorktreeState): MemberWorktreeRecoveryView | undefined {
  const record = state.recovery
  if (!record || record.phase !== 'created') return undefined
  return {
    operationId: record.operationId,
    sourceRoot: record.sourceRoot,
    checkoutRoot: record.checkoutRoot,
    focusRoot: `${record.checkoutRoot}${record.relativePath ? `/${record.relativePath}` : ''}`,
    branch: record.branch,
    message: record.reason
  }
}

/** Shared real-IPC adapter; each mounted dialog stays pinned to exactly one member. */
export function MemberWorktreeDialog({ sessionId, name, busy, onClose }: Props): React.JSX.Element {
  const { t } = useI18n()
  const [state, setState] = useState<MemberWorktreeState | null>(null)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let alive = true
    setState(null)
    setError('')
    void window.deva.chat.memberWorktreeState({ sessionId }).then((result) => {
      if (!alive) return
      if (result.ok) setState(result.state)
      else setError(result.message ?? result.reason)
    }).catch((e: unknown) => { if (alive) setError((e as Error)?.message ?? String(e)) })
    return () => { alive = false }
  }, [sessionId, reload])

  const refresh = async (): Promise<MemberWorktreeState> => {
    const result = await window.deva.chat.memberWorktreeState({ sessionId })
    if (!result.ok) throw new Error(result.message ?? result.reason)
    setState(result.state)
    return result.state
  }

  /*
   * fail-closed：绑定状态还没核实清楚时，一律不许渲染可操作的 Panel。
   *
   * 这里的条件必须和下面 `blocked` 的判据一致——原来只拦 `phase === 'creating'`，
   * 而 `phase === 'intent'`（记了意图、还没跑 Git）会漏进 Panel，被当成正常绑定渲染。
   * 那等于把「不知道有没有创建」当「可以用」，正是这条流程要防的事。
   */
  const blocked = state?.bindingInconsistent || (!!state?.recovery && state.recovery.phase !== 'created')
  if (!state || state.sessionId !== sessionId || blocked) {
    return (
      <Modal open onClose={onClose} width={560} labelledBy="cf-member-wt-loading">
        <h2 id="cf-member-wt-loading" className="modal__title">{t('cf.member.memberWorktree.title')}</h2>
        <p className="modal__body" role={error || blocked ? 'alert' : 'status'}>{error || t(blocked ? 'cf.member.memberWorktree.uncertain' : 'cf.member.memberWorktree.loading')}</p>
        {state?.recovery && <code>{state.recovery.operationId}: {state.recovery.checkoutRoot}</code>}
        <div className="modal__actions">
          <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>{t('cf.member.memberWorktree.cancel')}</button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setReload((n) => n + 1)}>{t('cf.member.memberWorktree.reload')}</button>
        </div>
      </Modal>
    )
  }

  return (
    <MemberWorktreePanel
      key={sessionId}
      open
      sessionId={sessionId}
      name={name}
      expectedRevision={state.revision}
      busy={busy || state.pending}
      focusRoot={state.focusRoot}
      bound={state.identity ? {
        sourceRoot: state.identity.sourceRoot,
        checkoutRoot: state.identity.checkoutRoot,
        focusRoot: state.focusRoot ?? '',
        branch: state.identity.branch
      } : undefined}
      recovery={recoveryView(state)}
      onClose={onClose}
      onUseDirectory={async (path) => {
        // Do not use a current-session callback: the user may switch conversations mid-request.
        await window.deva.chat.setFocus({ sessionId, focusRoot: path })
        await refresh()
      }}
      onPrecheck={async (draft) => {
        const result = await window.deva.chat.memberWorktreePrecheck(draft)
        return result.ok
          ? { ok: true, revision: result.revision, sourceRoot: result.sourceFocusRoot, sourceCheckoutRoot: result.sourceCheckoutRoot, relativePath: result.relativePath, precheck: result.precheck }
          : { ok: false, message: result.message ?? result.reason }
      }}
      onCreateAndBind={async (draft): Promise<MemberWorktreeBindView> => {
        const result = await window.deva.chat.memberWorktreeBind(draft)
        if (result.ok) return { status: 'bound', state: { sourceRoot: draft.sourceRoot, checkoutRoot: result.checkoutRoot, focusRoot: result.focusRoot, branch: draft.create.branch ?? '' } }
        if (result.status === 'created-unbound') {
          const recovery = result.binding ? recoveryView(result.binding) : undefined
          if (result.binding?.bindingInconsistent || !recovery) {
            setError(`${t('cf.member.memberWorktree.uncertain')}\n${result.operationId}\n${result.checkoutRoot}`)
            setState(null)
            return { status: 'rejected', message: t('cf.member.memberWorktree.uncertain') }
          }
          setState(result.binding)
          return { status: 'created-unbound', recovery }
        }
        return { status: 'rejected', message: result.message ?? result.reason }
      }}
      onRetryBind={async (sid, expectedRevision, operationId): Promise<MemberWorktreeBindView> => {
        const result = await window.deva.chat.memberWorktreeRetryBind({ sessionId: sid, expectedRevision, operationId })
        if (result.ok) return { status: 'bound', state: { sourceRoot: state.recovery?.sourceRoot ?? '', checkoutRoot: result.checkoutRoot, focusRoot: result.focusRoot, branch: state.recovery?.branch ?? '' } }
        if (result.status === 'created-unbound') {
          const recovery = result.binding ? recoveryView(result.binding) : undefined
          if (result.binding?.bindingInconsistent || !recovery) {
            setError(`${t('cf.member.memberWorktree.uncertain')}\n${result.operationId}\n${result.checkoutRoot}`)
            setState(null)
            return { status: 'rejected', message: t('cf.member.memberWorktree.uncertain') }
          }
          setState(result.binding)
          return { status: 'created-unbound', recovery }
        }
        return { status: 'rejected', message: result.message ?? result.reason }
      }}
      onReturnToOriginal={async (sid, expectedRevision) => {
        const result = await window.deva.chat.memberWorktreeReturnOriginal({ sessionId: sid, expectedRevision })
        // 失败必须抛：Panel 会 catch 住显示错误并保留弹窗，不会假装已返回。
        // memberWorktree 下没有 reason.* 词条，这里按既有做法回退到原始 reason 值，
        // 至少让用户看到「为什么没成」（original-unavailable / stale / busy 等）。
        if (!result.ok) throw new Error(result.message ?? result.reason)
        // 用返回值就地更新，不再多跑一次 IPC：Panel 紧接着会 onClose，
        // 多一次 round-trip 只会让关闭晚一帧。
        setState((prev) => (prev ? { ...prev, revision: result.revision, focusRoot: result.focusRoot } : prev))
      }}
      // Successful binding already updates focus and publishes sessions; never bind a second time.
      onBound={() => {}}
    />
  )
}
