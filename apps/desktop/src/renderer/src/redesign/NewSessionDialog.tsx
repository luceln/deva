import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, FolderOpen, GitBranch, Loader2 } from 'lucide-react'
import { useI18n } from '../i18n/i18n'
import type {
  WorktreeCreateFail,
  WorktreePrecheckFail,
  WorktreePrecheckOk
} from '../../../shared/worktree-protocol'
import './new-session.css'

/**
 * 新建会话（spec §7.7、原型面 1 五屏）。
 *
 * ## A47：分支名不能直接当目录名用，路径框必须可编辑
 *
 * 分支名可能是中文或带空格（`修复登录`、`my branch`）。主进程的 `slugifyBranch` 会把它们回落成
 * 确定的兜底值（`worktree`），于是 precheck 给的默认路径里就没有可读信息了。这条的用户出口是
 * **路径框可编辑**：用户看到 `...\worktrees\deva\worktree` 可以自己改成 `...\deva\fix-login`，
 * 改完 precheck 重新校验，合法就能创建。所以路径框既是输入框（不是只读展示），也不在用户
 * 改动后又被名称联动覆盖回去（见硬要求 ②）。
 *
 * ## 三条硬要求（§7.7），逐条对应到代码
 *
 * **① dirty 只警示不拦截。** 主目录有未提交改动时显示一条提示，但主按钮**照样可点**，
 * 点下去 `create` 直接带 `confirmedDirty: true`。`needsConfirm` 为真时**不弹二次确认框**——
 * 那会变成「主按钮 → 确认框 → 真的创建」，用户点了两次同一件事。原型的意图是「告诉你一声」，
 * 不是「问你要不要继续」。故这里没有第二道弹窗。
 *
 * **② 名称与路径双向联动。** 改名称 → 路径跟着改；用户**手改过路径**后 `locationTouched = true`，
 * 此后改名称不再覆盖路径。这个状态只在本组件里（`useState`），**不进主进程**：主进程不需要知道
 * 「用户有没有碰过路径框」，它只收最终的 `path`。
 *
 * **③ 路径框可编辑 + 「浏览…」。** 浏览走 `fs:open-folder`（`workspace.ts:43`），是**选目录**不是保存到：
 * 拿回来的路径直接填进输入框，仍需用户确认后才创建。
 *
 * ## 校验一律走 `worktree:precheck`
 *
 * 不在渲染层写「路径太长 / 分支已存在 / 目录已存在」这类判断——那会和主进程各算一套（R13）。
 * precheck 是**无副作用**的，故在名称/路径/起点变化后防抖调用，把结果当作唯一的错误来源。
 */

export type NewSessionMode = 'primary' | 'worktree'

export interface NewSessionResult {
  /** 落在哪个目录：主目录 = focusRoot；工作区 = 新目录。 */
  focusRoot: string | null
  /** 仅 worktree 模式有：创建成功后的记录（`unknown` 形状由主进程定，这里只透传）。 */
  created: unknown
}

/** 名称 → 建议路径的最后一段（只做「去掉明显非法字符」，合法性由 precheck 判）。 */
function slugify(name: string): string {
  return name
    .trim()
    .replace(/[\s\\/:*?"<>|]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase()
}

export function NewSessionDialog({
  repoRoot,
  primaryBranch,
  onClose,
  onDone
}: {
  /** 当前主目录（会话将挂在它下面）。 */
  repoRoot: string
  /** 主目录当前分支；detached 时 null。 */
  primaryBranch: string | null
  onClose: () => void
  onDone: (result: NewSessionResult) => void
}): React.JSX.Element {
  const { t } = useI18n()

  const [mode, setMode] = useState<NewSessionMode>('primary')
  const [name, setName] = useState('')
  const [path, setPath] = useState('')
  /**
   * 用户是否**亲手改过路径**。为真后改名称不再覆盖路径（硬要求 ②）。
   * 只活在渲染层——主进程不需要知道这个事实。
   */
  const [locationTouched, setLocationTouched] = useState(false)
  const [base, setBase] = useState<string>('')
  const [baseLabel, setBaseLabel] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [check, setCheck] = useState<WorktreePrecheckOk | null>(null)
  const [err, setErr] = useState<string>('')

  // 首次进入：用 precheck 的默认值（主目录默认分支 / detached 时的 SHA）填起点。
  // 只跑一次：之后用户改起点不该被覆盖。
  const primedRef = useRef(false)
  useEffect(() => {
    if (primedRef.current || mode !== 'worktree') return
    primedRef.current = true
    void (async () => {
      const res = await window.deva.worktree.precheck({ repoRoot, baseRef: '', branch: '', path: '' })
      if (res.ok) {
        setBase(res.defaultBase)
        setBaseLabel(res.defaultBaseLabel)
        // 默认路径由主进程算（它在 worktrees 根目录下拼 slug），这里只取默认名。
        setName(res.slug)
      }
    })()
  }, [mode, repoRoot])

  /**
   * 名称 → 路径联动（硬要求 ②）。用户手改过路径（`locationTouched`）之后一律不动。
   * 路径的「目录前缀」也由主进程在 precheck 里给（它知道 worktrees 根在哪），
   * 这里只在本地把最后一段换成新 slug，避免每次输入都往返一次 IPC。
   */
  useEffect(() => {
    if (mode !== 'worktree' || locationTouched) return
    const slug = slugify(name)
    if (!slug) return
    setPath((prev) => {
      if (!prev) return prev
      const cut = Math.max(prev.lastIndexOf('\\'), prev.lastIndexOf('/'))
      return cut >= 0 ? `${prev.slice(0, cut + 1)}${slug}` : prev
    })
  }, [name, mode, locationTouched])

  // 防抖 precheck：名称/路径/起点变化后 350ms 查一次。precheck 无副作用，可以随便调。
  const seqRef = useRef(0)
  useEffect(() => {
    if (mode !== 'worktree') {
      setCheck(null)
      setErr('')
      return
    }
    const seq = ++seqRef.current
    const timer = setTimeout(() => {
      setChecking(true)
      void (async () => {
        const res = await window.deva.worktree.precheck({
          repoRoot,
          baseRef: base,
          branch: name,
          path
        })
        if (seq !== seqRef.current) return
        setChecking(false)
        if (res.ok) {
          setCheck(res)
          setErr('')
          // 首次拿到 precheck 结果时用它给的路径（主进程知道 worktrees 根目录在哪）。
          if (!locationTouched) setPath((p) => (p ? p : res.path))
        } else {
          setCheck(null)
          setErr(precheckMessage(res, t))
        }
      })()
    }, 350)
    return () => clearTimeout(timer)
  }, [mode, repoRoot, base, name, path, locationTouched, t])

  const browse = useCallback(async (): Promise<void> => {
    const res = await window.deva.fs.openFolder()
    if (!res) return
    // 用户亲手选了目录 → 之后改名称不再覆盖（硬要求 ②）。
    setLocationTouched(true)
    setPath(res.path)
  }, [])

  const dirty = check?.dirtyCount ?? 0
  const tooMany = check?.softWarn === 'many-worktrees'

  const submit = useCallback(async (): Promise<void> => {
    if (busy) return
    if (mode === 'primary') {
      onDone({ focusRoot: repoRoot, created: null })
      return
    }
    setBusy(true)
    try {
      const res = await window.deva.worktree.create({
        repoRoot,
        baseRef: base,
        branch: name,
        path,
        // 硬要求 ①：dirty 只警示不拦截，故这里恒带 true —— 用户点主按钮就是「知道了，继续」。
        confirmedDirty: true
      })
      if (res.ok) {
        // 新建目录就是这次会话的 focusRoot：主进程的记录形状还没在 shared 里定稿，
        // 但「建在哪个目录」就是 precheck 回给我们的那个 path，不需要从 record 里猜。
        onDone({ focusRoot: path, created: res.record })
      } else {
        setErr(createMessage(res, t))
      }
    } catch (e) {
      setErr((e as Error)?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }, [busy, mode, repoRoot, base, name, path, onDone, t])

  const canSubmit = useMemo(() => {
    if (busy) return false
    if (mode === 'primary') return true
    // 工作区模式：名称与路径都不能空。**不看 dirty、不看 checking**——
    // 前者是硬要求 ①（只警示不拦截），后者只是「还没查完」，不该把用户的手按住。
    return name.trim().length > 0 && path.trim().length > 0
  }, [busy, mode, name, path])

  return (
    <div className="cf-modal__backdrop">
      <div className="cf-modal cf-new" role="dialog" aria-label={t('cf.new.title')}>
        <div className="cf-modal__head">
          <span className="cf-modal__title">{t('cf.new.title')}</span>
          <button className="cf-modal__close" title={t('common.close')} onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="cf-modal__body cf-new__body">
          <p className="cf-new__sub">{t('cf.new.sub')}</p>

          {/* 位置单选：默认主目录（§7.7 屏①）。大多数时候不需要并行，故主目录排在前面且默认选中。 */}
          <div className="cf-new__opts">
            <button
              type="button"
              className={`cf-new__opt${mode === 'primary' ? ' is-on' : ''}`}
              onClick={() => setMode('primary')}
            >
              <span className="cf-new__dot" />
              <span className="cf-new__optmain">
                <span className="cf-new__optlabel">{t('cf.new.primary')}</span>
                <span className="cf-new__optdesc">
                  {repoRoot}
                  {primaryBranch ? `，${t('cf.new.primaryBranch').replace('{branch}', primaryBranch)}` : ''}
                </span>
              </span>
            </button>
            <button
              type="button"
              className={`cf-new__opt${mode === 'worktree' ? ' is-on' : ''}`}
              onClick={() => setMode('worktree')}
            >
              <span className="cf-new__dot" />
              <span className="cf-new__optmain">
                <span className="cf-new__optlabel">{t('cf.new.worktree')}</span>
                <span className="cf-new__optdesc">{t('cf.new.worktreeDesc')}</span>
              </span>
            </button>
          </div>

          {mode === 'worktree' && (
            <div className="cf-new__loc">
              {/* 起点（§7.7 屏③）：detached 时显示 HEAD (detached @ sha7)，不能显示成空或「HEAD」 */}
              <div className="cf-new__field">
                <label className="cf-new__label" htmlFor="cf-new-base">
                  {t('cf.new.base')}
                </label>
                <div className="cf-new__inputrow">
                  <GitBranch size={13} className="cf-new__ico" />
                  <input
                    id="cf-new-base"
                    className="cf-new__input"
                    value={baseLabel || base}
                    onChange={(e) => {
                      setBase(e.target.value)
                      setBaseLabel(e.target.value)
                    }}
                    spellCheck={false}
                  />
                </div>
                <span className="cf-new__hint">{t('cf.new.baseHint')}</span>
              </div>

              {/* 名称 */}
              <div className="cf-new__field">
                <label className="cf-new__label" htmlFor="cf-new-name">
                  {t('cf.new.name')}
                </label>
                <div className="cf-new__inputrow">
                  <input
                    id="cf-new-name"
                    className="cf-new__input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    spellCheck={false}
                  />
                </div>
                <span className="cf-new__hint">{t('cf.new.nameHint')}</span>
              </div>

              {/* 路径（硬要求 ③）：可编辑 + 浏览… */}
              <div className="cf-new__field">
                <label className="cf-new__label" htmlFor="cf-new-path">
                  {t('cf.new.path')}
                </label>
                <div className="cf-new__inputrow cf-new__inputrow--mono">
                  <input
                    id="cf-new-path"
                    className="cf-new__input"
                    value={path}
                    onChange={(e) => {
                      // 用户手改路径 → 此后改名称不再覆盖（硬要求 ②）。
                      setLocationTouched(true)
                      setPath(e.target.value)
                    }}
                    spellCheck={false}
                  />
                  <button type="button" className="cf-new__browse" onClick={() => void browse()}>
                    <FolderOpen size={13} />
                    {t('cf.new.browse')}
                  </button>
                </div>
                <span className="cf-new__hint">{t('cf.new.pathHint')}</span>
              </div>

              {/* dirty 警示（硬要求 ①）：显示，但不拦截主按钮 */}
              {dirty > 0 && (
                <div className="cf-new__warn">
                  <AlertTriangle size={14} />
                  <div>
                    {t('cf.new.dirty').replace('{n}', String(dirty))}
                    <span className="cf-new__warnsub">{t('cf.new.dirtySub')}</span>
                  </div>
                </div>
              )}
              {tooMany && (
                <div className="cf-new__warn">
                  <AlertTriangle size={14} />
                  <div>{t('cf.new.many').replace('{n}', String(check?.existingCount ?? 0))}</div>
                </div>
              )}
              {check?.mergeTargetWarning && (
                <div className="cf-new__note">{check.mergeTargetWarning}</div>
              )}
            </div>
          )}

          {err && (
            <div className="cf-new__err" role="alert">
              <AlertTriangle size={14} />
              <span>{err}</span>
            </div>
          )}
          {checking && mode === 'worktree' && (
            <div className="cf-new__checking">
              <Loader2 size={13} className="cf-new__spin" />
              {t('cf.new.checking')}
            </div>
          )}
        </div>

        <div className="cf-modal__foot">
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          {/* B7：禁用态 + tooltip 说明为什么不能点 */}
          <button
            type="button"
            className="btn btn--primary"
            disabled={!canSubmit}
            title={canSubmit ? undefined : t('cf.new.disabledHint')}
            onClick={() => void submit()}
          >
            {busy && <Loader2 size={13} className="cf-new__spin" />}
            {mode === 'primary' ? t('cf.new.start') : t('cf.new.startWorktree')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** precheck 失败原因 → 文案。未知码原样显示，不吞掉（主进程新增原因时界面仍能显示）。 */
function precheckMessage(res: WorktreePrecheckFail, t: (k: string) => string): string {
  const key = `cf.new.reason.${res.reason}`
  const mapped = t(key)
  const base = mapped === key ? res.reason : mapped
  return res.suggestion ? `${base}（${res.suggestion}）` : base
}

/** create 失败原因 → 文案。主进程给了 `message`（含人话说明），优先用它；没有才回落原因码。 */
function createMessage(res: WorktreeCreateFail, t: (k: string) => string): string {
  if (res.message) return res.message
  const key = `cf.new.reason.${res.reason}`
  const mapped = t(key)
  return mapped === key ? res.reason : mapped
}
