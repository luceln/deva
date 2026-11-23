import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderOpen, ExternalLink } from 'lucide-react'
import { useI18n } from '../i18n/i18n'
import { useWorktree } from '../store/worktree'
import type { WorktreeRootView } from '../../../shared/worktree-protocol'

/**
 * 设置 › 工作区 › 根目录。
 *
 * ## 为什么单独一个文件
 *
 * `WorktreePane.tsx` 已经 628 行，AGENTS.md 规定「源文件超过约 800 行时，新功能放进新模块」。
 * 这块又完全自洽（自己拉 root、自己管编辑态），所以抽出来，`WorktreePane` 只负责组合。
 *
 * ## 编辑态为什么是「原地替换」
 *
 * 用户点「更改」之后，**路径那一行整行变成输入框**，而不是在下面另起一行。
 * 两种做法都能改到值，但「另起一行」在视觉上会同时出现两处路径（旧路径 + 输入框），
 * 用户看不出哪个才是当前生效的。原型和用户都明确要求原地替换 —— 这条也在判据里守着：
 * 路径文本与输入框**不能同时渲染**。
 *
 * ## 工作区列表为什么要刷新
 *
 * 改了根，`snapshot.items` 里的 `insideRoot` 判定就全变了（原来「在根内」的会变成「根外」）。
 * 不刷新的话，列表还按旧根标注，用户看到的状态是错的。
 */

/** 保存失败时把主进程的 message 原样显示 —— 它里面含具体路径，自己拼文案会丢信息。 */
interface SaveError {
  message: string
}

export function WorktreeRootSetting(): React.JSX.Element {
  const { t } = useI18n()
  const { refresh } = useWorktree()

  const [view, setView] = useState<WorktreeRootView | null>(null)
  const [loading, setLoading] = useState(true)
  /** 编辑态：路径行整行换成输入框。 */
  const [editing, setEditing] = useState(false)
  /** 输入框里的草稿值。 */
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<SaveError | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const v = await window.deva.worktree.root()
      setView(v)
    } catch (e) {
      setError({ message: (e as Error)?.message ?? t('cf.wt.rootLoadFailed') })
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  /*
   * 进编辑态后聚焦并全选。放在 rAF 里是因为「路径行换成输入框」是同一帧内的一次重渲染，
   * 直接在 onClick 里 focus()，ref 可能还指着上一轮被卸载的节点，选不中内容。
   */
  useEffect(() => {
    if (!editing) return
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(raf)
  }, [editing])

  const isDefault = view?.isDefault ?? true
  /** 编辑态一律按「已改过」显示徽标：正在改就是还没回到默认。 */
  const modified = editing || !isDefault

  const startEdit = (): void => {
    setDraft(view?.root ?? '')
    setError(null)
    setEditing(true)
  }

  const cancelEdit = (): void => {
    setEditing(false)
    setDraft('')
    setError(null)
  }

  const applyResult = async (): Promise<void> => {
    /*
     * 先刷新列表再收编辑态：`insideRoot` 是按新根重算的，
     * 顺序反了会有一帧「列表说在根内、根却已经变了」。
     */
    await refresh()
    await load()
    setEditing(false)
    setDraft('')
  }

  const save = async (): Promise<void> => {
    const value = draft.trim()
    if (!value || saving) return
    setSaving(true)
    setError(null)
    try {
      const res = await window.deva.worktree.setRoot(value)
      if (!res.ok) {
        /*
         * 原样显示 message：里面写着是哪个目录、为什么不行。
         * 输入框**不收起** —— 用户要能直接改，重新点一遍「更改」是多余的。
         */
        setError({ message: res.message })
        return
      }
      setView({ root: res.root, isDefault: res.isDefault, defaultRoot: view?.defaultRoot ?? res.root })
      await applyResult()
    } catch (e) {
      setError({ message: (e as Error)?.message ?? t('cf.wt.rootSaveFailed') })
    } finally {
      setSaving(false)
    }
  }

  const reset = async (): Promise<void> => {
    if (saving || isDefault) return
    setSaving(true)
    setError(null)
    try {
      /*
       * 传 `undefined` = 删键、跟随 `DEVA_HOME`。
       * 不能传 `defaultRoot` 字符串：那会把「跟随环境变量」变成一个写死的旧值，
       * 以后 `DEVA_HOME` 变了界面就不跟着走（preload 注释里明确要求）。
       */
      const res = await window.deva.worktree.setRoot(undefined)
      if (!res.ok) {
        setError({ message: res.message })
        return
      }
      setView({ root: res.root, isDefault: res.isDefault, defaultRoot: view?.defaultRoot ?? res.root })
      await applyResult()
    } catch (e) {
      setError({ message: (e as Error)?.message ?? t('cf.wt.rootSaveFailed') })
    } finally {
      setSaving(false)
    }
  }

  const open = (): void => {
    if (!view) return
    /* 复用 preload 里现成的 revealFolder（与列表里「打开」同一个能力），不新造 IPC。 */
    void window.deva.fs.revealFolder(view.root)
  }

  const shownPath = view?.root ?? ''
  /* 路径颜色：默认态弱化，自定义态用正文色 —— 默认值不是用户的决定，不该抢眼。 */
  const pathColor = isDefault && !editing ? 'var(--fg-muted)' : 'var(--fg)'

  return (
    <section className="cf-set">
      {/* ── 标题行：标签 + 徽标 + 更改 / 恢复默认 ── */}
      <div className="cf-set__row">
        <span className="cf-set__label">
          {t('cf.wt.rootLabel')}
          <span className="cf-set__hint">{t('cf.wt.rootHint')}</span>
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <span className={modified ? 'cf-badge is-accent' : 'cf-badge'}>
            {modified ? t('cf.wt.rootModified') : t('cf.wt.rootDefault')}
          </span>
          <button
            type="button"
            className="btn btn--sm"
            onClick={startEdit}
            disabled={editing || loading || saving}
          >
            <FolderOpen size={13} />
            {t('cf.wt.rootChange')}
          </button>
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            onClick={() => void reset()}
            /* 默认态时没有「恢复」可言 —— 按原型要 disabled，不是隐藏。 */
            disabled={isDefault || editing || saving}
          >
            {t('cf.wt.rootReset')}
          </button>
        </span>
      </div>

      {editing ? (
        /*
         * 编辑态：**整行替换** 路径行。这一行里只有输入框和「取消 / 保存」，
         * 绝不再渲染 `shownPath` —— 否则屏幕上同时有两处路径（见文件头注释）。
         */
        <div className="cf-set__row" style={{ flexWrap: 'wrap', gap: 'var(--space-2)' }}>
          <input
            ref={inputRef}
            className="cf-input"
            style={{ flex: 1, minWidth: 200, fontFamily: 'var(--font-mono)', fontSize: 12 }}
            value={draft}
            spellCheck={false}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save()
              else if (e.key === 'Escape') cancelEdit()
            }}
          />
          <span style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <button type="button" className="btn btn--sm btn--ghost" onClick={cancelEdit} disabled={saving}>
              {t('cf.wt.rootCancel')}
            </button>
            <button type="button" className="btn btn--sm btn--primary" onClick={() => void save()} disabled={saving}>
              {t('cf.wt.rootSave')}
            </button>
          </span>
        </div>
      ) : (
        /* 默认/自定义态：路径行 + 打开 */
        <div className="cf-set__row">
          <code style={{ flex: 1, minWidth: 0, fontSize: 12, wordBreak: 'break-all', color: pathColor }} title={shownPath}>
            {shownPath}
          </code>
          <button type="button" className="btn btn--sm btn--ghost" onClick={open} disabled={!view}>
            <ExternalLink size={13} />
            {t('cf.wt.rootOpen')}
          </button>
        </div>
      )}

      {/*
       * 出错：原文显示、不收起输入框。`role="alert"` 让读屏用户也能听到 ——
       * 保存失败是用户点了按钮之后才发生的，不给提示等于静默失败。
       */}
      {error && (
        <div className="cf-set__row" role="alert">
          <span style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 12, color: 'var(--danger)' }}>
            {error.message}
          </span>
        </div>
      )}
    </section>
  )
}