import { useEffect, useRef, useState } from 'react'
import { FolderOpen, Loader2, RotateCcw } from 'lucide-react'
import { useDialog } from '../components/DialogProvider'
import { Modal } from '../components/Modal'
import { useI18n } from '../i18n/i18n'
import type { WorktreePrecheckOk } from '../../../shared/worktree-protocol'

/**
 * Renderer-facing draft. `sourceRoot` is intentionally separate from create.repoRoot:
 * the user may currently be in checkout A and select source directory B. The service
 * must validate and create from the exact B shown here; never infer it from focusRoot.
 */
export interface MemberWorktreeDraft {
  sessionId: string
  expectedRevision: number
  sourceRoot: string
  create: {
    /** Git repository root (checkout A); sourceRoot remains the exact user-selected folder B. */
    repoRoot: string
    baseRef?: string
    branch?: string
    path?: string
    confirmedDirty?: boolean
    /** This feature never starts dependency installation automatically. */
    skipDeps: true
  }
}

export interface MemberWorktreeRecoveryView {
  operationId: string
  sourceRoot: string
  checkoutRoot: string
  focusRoot: string
  branch: string
  message: string
}

export interface MemberWorktreeBindDraft extends MemberWorktreeDraft {
  requestId: string
}

export interface MemberWorktreeBoundView {
  sourceRoot: string
  checkoutRoot: string
  focusRoot: string
  branch: string
}

/** Kept local until shared/preload protocol is committed and imported. */
export type MemberWorktreePrecheckView =
  | { ok: false; message: string }
  | { ok: true; revision: number; sourceRoot: string; relativePath: string; precheck: WorktreePrecheckOk }

export type MemberWorktreeBindView =
  | { status: 'bound'; state: MemberWorktreeBoundView }
  | { status: 'rejected'; message: string }
  | { status: 'created-unbound'; recovery: MemberWorktreeRecoveryView }

interface Props {
  open: boolean
  name: string
  sessionId?: string
  expectedRevision?: number
  busy: boolean
  focusRoot: string | null
  bound?: MemberWorktreeBoundView
  recovery?: MemberWorktreeRecoveryView
  onClose: () => void
  /** Ordinary directory fallback: runs only after the user confirms. */
  onUseDirectory: (path: string) => void | Promise<void>
  /** Exact sourceRoot is a separate request field, never inferred from create.repoRoot/focusRoot. */
  onPrecheck?: (draft: MemberWorktreeDraft) => Promise<MemberWorktreePrecheckView>
  onCreateAndBind?: (draft: MemberWorktreeBindDraft) => Promise<MemberWorktreeBindView>
  /** Retry only binds the server-owned operation; it must not accept create data. */
  onRetryBind?: (sessionId: string, expectedRevision: number, operationId: string) => Promise<MemberWorktreeBindView>
  onBound: (state: MemberWorktreeBoundView) => void
  onReturnToOriginal?: (sessionId: string, expectedRevision: number) => Promise<void>
}

function childRelative(root: string, child: string): string | null {
  const fold = (s: string): string => s.replace(/\\/g, '/').replace(/\/$/, '').toLocaleLowerCase()
  const r = fold(root)
  const c = fold(child)
  if (c === r) return ''
  if (!c.startsWith(`${r}/`)) return null
  return child.replace(/\\/g, '/').replace(/\/$/, '').slice(root.replace(/\\/g, '/').replace(/\/$/, '').length + 1)
}

export function MemberWorktreePanel(props: Props): React.JSX.Element | null {
  const { t } = useI18n()
  const dialog = useDialog()
  const sourceRequest = useRef(0)
  const [sourceRoot, setSourceRoot] = useState('')
  const [repoRoot, setRepoRoot] = useState('')
  const [branch, setBranch] = useState('')
  const [baseRef, setBaseRef] = useState('')
  const [dirtyCount, setDirtyCount] = useState(0)
  const [dirtyAck, setDirtyAck] = useState(false)
  const [independent, setIndependent] = useState(false)
  const [precheck, setPrecheck] = useState<MemberWorktreePrecheckView | null>(null)
  const [precheckedRevision, setPrecheckedRevision] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [recovery, setRecovery] = useState<MemberWorktreeRecoveryView | undefined>(props.recovery)
  const [bound, setBound] = useState<MemberWorktreeBoundView | undefined>(props.bound)

  const locked = busy || props.busy
  const relativePath = repoRoot && sourceRoot ? childRelative(repoRoot, sourceRoot) : null
  const validIdentity = !!props.sessionId && props.expectedRevision !== undefined
  const hasBridge = !!props.onPrecheck && !!props.onCreateAndBind && validIdentity

  useEffect(() => {
    setRecovery(props.recovery)
    setBound(props.bound)
  }, [props.recovery, props.bound])

  useEffect(() => {
    if (!props.open) return
    const initial = props.focusRoot ?? ''
    setSourceRoot(initial)
    setRepoRoot('')
    setBranch('')
    setBaseRef('')
    setDirtyCount(0)
    setDirtyAck(false)
    setIndependent(false)
    setPrecheck(null)
    setError('')
    if (!initial) return
    let alive = true
    void window.deva.git.status(initial).then((status) => {
      if (!alive) return
      if (status.isRepo) {
        setRepoRoot(status.root)
        setBranch(status.branch ?? '')
        setBaseRef(status.branch ?? '')
        setDirtyCount(status.staged.length + status.unstaged.length + status.conflicts.length)
      }
    }).catch((e: unknown) => { if (alive) setError((e as Error)?.message ?? String(e)) })
    return () => { alive = false }
  }, [props.open, props.sessionId, props.focusRoot])

  if (!props.open) return null

  const chooseSource = async (): Promise<void> => {
    const result = await window.deva.fs.openFolder()
    // System picker cancellation is not a choice; preserve all current input and confirmations.
    if (!result) return
    const request = ++sourceRequest.current
    setSourceRoot(result.path)
    setRepoRoot('')
    setDirtyCount(0)
    setDirtyAck(false)
    setPrecheck(null)
    setError('')
    try {
      const status = await window.deva.git.status(result.path)
      if (request !== sourceRequest.current) return
      if (status.isRepo) {
        setRepoRoot(status.root)
        setBranch(status.branch ?? '')
        setBaseRef(status.branch ?? '')
        setDirtyCount(status.staged.length + status.unstaged.length + status.conflicts.length)
      } else {
        setBranch('')
        setBaseRef('')
      }
    } catch (e) {
      if (request === sourceRequest.current)
        setError((e as Error)?.message ?? String(e))
    }
  }

  const makeDraft = (): MemberWorktreeDraft | null => {
    if (!props.sessionId || props.expectedRevision === undefined || !sourceRoot || !repoRoot || relativePath === null)
      return null
    return {
      sessionId: props.sessionId,
      expectedRevision: props.expectedRevision,
      sourceRoot,
      create: { repoRoot, baseRef: baseRef || undefined, branch: branch || undefined, confirmedDirty: dirtyAck, skipDeps: true }
    }
  }

  const check = async (): Promise<void> => {
    const draft = makeDraft()
    if (!draft || !props.onPrecheck) return
    setBusy(true)
    setError('')
    try {
      const result = await props.onPrecheck(draft)
      setPrecheck(result)
      setPrecheckedRevision(result.ok ? result.revision : null)
      if (!result.ok) setError(result.message)
    } catch (e) {
      setError((e as Error)?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const createAndBind = async (): Promise<void> => {
    const draft = makeDraft()
    if (!draft || !props.onCreateAndBind || !precheck?.ok) return
    setBusy(true)
    setError('')
    try {
      const result = await props.onCreateAndBind({
        ...draft,
        expectedRevision: precheckedRevision ?? draft.expectedRevision,
        requestId: crypto.randomUUID()
      })
      if (result.status === 'bound') {
        setBound(result.state)
        setRecovery(undefined)
        props.onBound(result.state)
        props.onClose()
      } else if (result.status === 'created-unbound') {
        // Server owns this recoverable operation; never store it in localStorage or create again.
        setRecovery(result.recovery)
        setError(result.recovery.message)
      } else {
        setError(result.message)
      }
    } catch (e) {
      setError((e as Error)?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const retryBind = async (): Promise<void> => {
    if (!recovery || !props.sessionId || props.expectedRevision === undefined || !props.onRetryBind) return
    setBusy(true)
    setError('')
    try {
      const result = await props.onRetryBind(props.sessionId, props.expectedRevision, recovery.operationId)
      if (result.status === 'bound') {
        setBound(result.state)
        setRecovery(undefined)
        props.onBound(result.state)
        props.onClose()
      } else if (result.status === 'created-unbound') {
        setRecovery(result.recovery)
        setError(result.recovery.message)
      } else setError(result.message)
    } catch (e) {
      setError((e as Error)?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const useDirectory = async (): Promise<void> => {
    if (!sourceRoot || locked || independent) return
    setBusy(true)
    setError('')
    try {
      await props.onUseDirectory(sourceRoot)
      props.onClose()
    } catch (e) {
      setError((e as Error)?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  const returnToOriginal = async (): Promise<void> => {
    if (!props.sessionId || props.expectedRevision === undefined || !props.onReturnToOriginal || locked) return
    if (!(await dialog.confirm({ title: t('cf.member.memberWorktree.returnOriginal'), message: t('cf.member.memberWorktree.returnConfirm') }))) return
    setBusy(true)
    try {
      await props.onReturnToOriginal(props.sessionId, props.expectedRevision)
      props.onClose()
    } catch (e) {
      setError((e as Error)?.message ?? String(e))
    } finally { setBusy(false) }
  }

  const target = precheck?.ok ? precheck.precheck : null
  const active = !!bound
  const sourceMismatch = precheck?.ok && precheck.sourceRoot !== sourceRoot
  const canCreate = !!precheck?.ok && !sourceMismatch && !locked && hasBridge && (!dirtyCount || dirtyAck)
  const canUseFolder = !!sourceRoot && !locked && !independent
  const confirmLabel = recovery
    ? t('cf.member.memberWorktree.retryBind')
    : independent
      ? t('cf.member.memberWorktree.createAndUse')
      : t('cf.member.memberWorktree.useFolder')

  return (
    <Modal open={props.open} onClose={() => { if (!locked) props.onClose() }} width={560} labelledBy="cf-member-wt-title">
      <div className="cf-mwt">
        <header className="cf-mwt__head">
          <div>
            <h2 id="cf-member-wt-title">{active ? t('cf.member.memberWorktree.titleActive') : t('cf.member.memberWorktree.title')}</h2>
            <p className="cf-mwt__hint">{t('cf.member.memberWorktree.headline').replace('{name}', props.name)}</p>
          </div>
          <button type="button" className="btn btn--ghost btn--sm" disabled={locked} onClick={props.onClose} aria-label={t('cf.member.memberWorktree.cancel')}>×</button>
        </header>

        {active ? (
          <section className="cf-mwt__state">
            <Field label={t('cf.member.memberWorktree.source')} value={bound?.sourceRoot ?? '—'} />
            <Field label={t('cf.member.memberWorktree.branch')} value={bound?.branch ?? '—'} />
            <Field label={t('cf.member.memberWorktree.currentFolder')} value={bound?.focusRoot ?? props.focusRoot ?? '—'} />
            <p>{t('cf.member.memberWorktree.retention')}</p>
            {props.onReturnToOriginal && props.sessionId && props.expectedRevision !== undefined && (
              <button type="button" className="btn btn--ghost btn--sm" disabled={locked} onClick={() => void returnToOriginal()}>
                {t('cf.member.memberWorktree.returnOriginal')}
              </button>
            )}
          </section>
        ) : (
          <>
            {recovery && (
              <section className="cf-mwt__recovery" role="status">
                <strong>{t('cf.member.memberWorktree.createdUnbound')}</strong>
                <p>{recovery.message}</p>
                <Field label={t('cf.member.memberWorktree.source')} value={recovery.sourceRoot} />
                <Field label={t('cf.member.memberWorktree.currentFolder')} value={recovery.focusRoot} />
                <p>{t('cf.member.memberWorktree.retryOnly')}</p>
              </section>
            )}
            <div className="cf-mwt__body">
              <div className="cf-mwt__field">
                <label>{t('cf.member.memberWorktree.source')}</label>
                <div className="cf-mwt__source">
                  <code title={sourceRoot}>{sourceRoot || t('cf.member.memberWorktree.noSource')}</code>
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => void chooseSource()} disabled={locked || !!recovery}>
                    <FolderOpen size={13} /> {t('cf.member.memberWorktree.chooseSource')}
                  </button>
                </div>
              </div>
              <label className="cf-mwt__toggle">
                <input type="checkbox" checked={independent} disabled={locked || !!recovery} onChange={(e) => { setIndependent(e.target.checked); setPrecheck(null); setDirtyAck(false) }} />
                <span><strong>{t('cf.member.memberWorktree.independent')}</strong><small>{t('cf.member.memberWorktree.independentHint')}</small></span>
              </label>
              {independent && (
                <section className="cf-mwt__config">
                  <Field label={t('cf.member.memberWorktree.repo')} value={repoRoot || t('cf.member.memberWorktree.notGit')} />
                  <div className="cf-mwt__grid">
                    <label className="cf-mwt__field"><span>{t('cf.member.memberWorktree.base')}</span><input value={baseRef} onChange={(e) => { setBaseRef(e.target.value); setPrecheck(null) }} disabled={locked || !repoRoot} /></label>
                    <label className="cf-mwt__field"><span>{t('cf.member.memberWorktree.branch')}</span><input value={branch} onChange={(e) => { setBranch(e.target.value); setPrecheck(null) }} disabled={locked || !repoRoot} /></label>
                  </div>
                  <p className="cf-mwt__hint">{t('cf.member.memberWorktree.relative').replace('{path}', relativePath ?? '—')}</p>
                  {target && (
                    <>
                      <Field label={t('cf.member.memberWorktree.targetRoot')} value={target.path} />
                      <Field label={t('cf.member.memberWorktree.memberTarget')} value={`${target.path}${relativePath ? `/${relativePath}` : ''}`} />
                      {target.dirtyCount > 0 && (
                        <label className="cf-mwt__dirty"><input type="checkbox" checked={dirtyAck} onChange={(e) => setDirtyAck(e.target.checked)} disabled={locked} /><span>{t('cf.member.memberWorktree.dirty').replace('{n}', String(target.dirtyCount))}</span></label>
                      )}
                    </>
                  )}
                  {!repoRoot && sourceRoot && <p className="cf-mwt__error">{t('cf.member.memberWorktree.notGitHint')}</p>}
                  {!hasBridge && <p className="cf-mwt__error">{t('cf.member.memberWorktree.bridgePending')}</p>}
                  <p className="cf-mwt__hint">{t('cf.member.memberWorktree.skipDeps')}</p>
                  {validIdentity && props.onPrecheck && (
                    <button type="button" className="btn btn--ghost btn--sm" disabled={locked || !repoRoot} onClick={() => void check()}>
                      {t('cf.member.memberWorktree.check')}
                    </button>
                  )}
                  {sourceMismatch && <p className="cf-mwt__error">{t('cf.member.memberWorktree.sourceMismatch')}</p>}
                  {precheck?.ok === false && <p className="cf-mwt__error">{precheck.message}</p>}
                </section>
              )}
            </div>
          </>
        )}

        <p className="cf-mwt__safety">{t('cf.member.memberWorktree.safety')}</p>
        {(error || (locked && independent)) && (
          <p className={error ? 'cf-mwt__error' : 'cf-mwt__operation'} role={error ? 'alert' : 'status'} aria-live="polite">
            {error || <><Loader2 size={13} className="cf-mwt__spin" />{t('cf.member.memberWorktree.running')}</>}
          </p>
        )}
        <footer className="cf-mwt__footer">
          <button type="button" className="btn btn--ghost btn--sm" disabled={locked} onClick={props.onClose}>{recovery ? t('cf.member.memberWorktree.defer') : t('cf.member.memberWorktree.cancel')}</button>
          {!active && (
            <button type="button" className="btn btn--primary btn--sm" disabled={locked || (recovery ? !props.onRetryBind : independent ? !canCreate : !canUseFolder)} onClick={() => recovery ? void retryBind() : independent ? void createAndBind() : void useDirectory()}>
              {recovery ? <RotateCcw size={13} /> : null}{confirmLabel}
            </button>
          )}
        </footer>
      </div>
    </Modal>
  )
}

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
  return <div className="cf-mwt__value"><span>{label}</span><code title={value}>{value}</code></div>
}
