import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, ArrowRight, KeyRound, RefreshCw } from 'lucide-react'
import { Modal } from '../components/Modal'
import { Select, type SelectEntry } from '../components/Select'
import { useToast } from '../components/ToastProvider'
import { useI18n } from '../i18n/i18n'
import { useModels } from '../store/models'
import { useChatActions, useChatState } from '../store/chat'
import type { BrokenRef, ModelSwapResult } from '../store/modelSwap'
import { openModelSettings } from './modelSettingsBus'

/**
 * 模型批量替换对话框（点输入框上方的红色模型胶囊打开）。
 *
 * 三段：① 受影响的会话清单（各自失效原因分类）→ ② 换成哪个模型（只列可用模型）→ ③ 确认。
 *
 * 几条刻意的取舍：
 * - **判定不在这里算**：清单与原因全部来自主进程的 scan（见 store 的 brokenModels）。渲染层再按
 *   store/models 的 providers 算一遍，两套规则迟早漂移（`resolveRefStrict` 曾只看 id 不看 enabled 就是现成的例子）。
 * - **目标只列可用模型**：已失效的引用一律不出现在候选里；某个服务商已知缺密钥（scan 里出过 nokey）时，
 *   它名下的模型也整组不列——否则用户会从一个坏模型换到另一个坏模型，正是「默认模型最可能不可用」那个坑。
 * - **nokey 不逼用户换模型**：缺的是密钥，换模型解决不了；这类会话单独给「去填密钥」的入口。
 * - **一次只替换一个引用**：主进程的 apply 按 `session.model === fromRef` 精确匹配。同一对话里若还有别的失效
 *   引用，替换完会重新扫描、红标继续亮着，用户再点一次即可——比在渲染层猜「谁该跟着变」可靠得多。
 */
export function ModelSwapDialog({
  mainId,
  fromRef,
  onClose
}: {
  /** 当前对话（看得是成员会话时为它所属的主对话）：批量替换的范围就是它 + 名下成员。 */
  mainId: string
  /** 要换掉的那个引用 `"pid:mid"`（红色胶囊当前指向的失效模型）。 */
  fromRef: string
  onClose: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const toast = useToast()
  const { brokenModels } = useChatState()
  const { providers } = useModels()
  const { applyModelSwap, scanModelSwapState } = useChatActions()
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  /** 替换结果（快照）：替换后 store 会重扫、清空这一批的缓存，清单要盖不住结果，故留一份本地快照。 */
  const [result, setResult] = useState<ModelSwapResult | null>(null)
  const [showSkipped, setShowSkipped] = useState(false)
  // 首帧就在扫：扫描是进入即发起的，初值 true 才不会先闪一下「没有受影响会话」再变成清单。
  const [scanning, setScanning] = useState(true)

  // 打开时重扫一次：缓存可能来自上次进入本对话的时刻（模型刚在设置页被删 / 被禁用）。
  // 扫描结果落在 store 的 brokenModels 里，本组件只读它——清单、原因、候选范围全从这一份来。
  useEffect(() => {
    let live = true
    setScanning(true)
    void scanModelSwapState(mainId).finally(() => {
      if (live) setScanning(false)
    })
    return () => {
      live = false
    }
  }, [mainId, scanModelSwapState])

  const affected: BrokenRef[] = brokenModels[mainId] ?? []
  // 会被这次替换改掉的 / 保持原样的：按引用相等划分（与主进程 apply 的匹配规则一致）。
  // 引用不同的那些通常是用户单独给某个成员指定过模型，属正常保留，不是失败。
  const changeable = useMemo(() => affected.filter((b) => b.ref === fromRef), [affected, fromRef])
  const kept = useMemo(() => affected.filter((b) => b.ref !== fromRef), [affected, fromRef])

  // 候选模型：已启用服务商 × 已启用对话模型，去掉已知失效的引用与「密钥用不了」的服务商。
  // 「密钥用不了」从 scan 结果反推（nokey / keyunreadable 的引用前缀即 providerId），不在渲染层另立一套判定。
  // 两种都排除：换成同样解不开密钥的模型，改完还是不可用，用户得再来一次。
  const candidates = useMemo(() => {
    const brokenRefs = new Set(affected.map((b) => b.ref))
    const brokenProviderOf = (kind: BrokenRef['kind']): Set<string> =>
      new Set(
        affected
          .filter((b) => b.kind === kind)
          .map((b) => b.ref.slice(0, Math.max(0, b.ref.indexOf(':'))))
          .filter(Boolean)
      )
    const nokey = new Set([...brokenProviderOf('nokey'), ...brokenProviderOf('keyunreadable')])
    return providers
      .filter((p) => p.enabled && (p.purpose ?? 'llm') === 'llm' && !nokey.has(p.id))
      .map((p) => ({
        p,
        models: p.models.filter((m) => m.enabled && !brokenRefs.has(`${p.id}:${m.id}`))
      }))
      .filter((g) => g.models.length > 0)
  }, [providers, affected])

  const items = useMemo<SelectEntry<string>[]>(
    () =>
      candidates.flatMap(({ p, models }): SelectEntry<string>[] => [
        { group: p.name, lead: <span className="select-dot" style={{ background: p.accent }} /> },
        ...models.map((m) => ({ value: `${p.id}:${m.id}`, label: m.name }))
      ]),
    [candidates]
  )

  const kindText = (kind: BrokenRef['kind']): string => t(`cf.modelSwap.kind.${kind}`)
  // 本对话的失效**全部**只是缺密钥：此时正确的解法是去填密钥，不该把用户推向换模型（换模型解决不了缺密钥）。
  const allNoKey =
    affected.length > 0 && affected.every((b) => b.kind === 'nokey' || b.kind === 'keyunreadable')

  const run = async (): Promise<void> => {
    if (!target || busy) return
    setBusy(true)
    let res: ModelSwapResult | { error: string }
    try {
      res = await applyModelSwap(mainId, fromRef, target)
    } catch (e) {
      // applyModelSwap 内部已兜错，这里再兜一层：走到这里说明真出了意外，也不能让按钮一直转。
      res = { error: (e as Error)?.message ?? String(e) }
    } finally {
      setBusy(false)
    }
    if ('error' in res) {
      toast.show({ variant: 'error', title: t('cf.modelSwap.failed'), message: res.error })
      return
    }
    setResult(res)
    setShowSkipped(false)
    toast.show({
      variant: 'success',
      title: t('cf.modelSwap.done'),
      message: [
        t('cf.modelSwap.appliedN').replace('{n}', String(res.changed.length)),
        res.skipped.length ? t('cf.modelSwap.skippedN').replace('{n}', String(res.skipped.length)) : ''
      ]
        .filter(Boolean)
        .join(' · '),
      // 有跳过项时留足时间点开看是哪些会话（它们是正常保留，但用户可能会疑惑为什么没全换）。
      duration: res.skipped.length ? 8000 : undefined
    })
  }

  const goFillKey = (): void => {
    onClose()
    openModelSettings()
  }

  const body = result ? (
    <Result
      result={result}
      showSkipped={showSkipped}
      onToggleSkipped={() => setShowSkipped((v) => !v)}
    />
  ) : (
    <>
      <p className="cf-swap__hint">{t('cf.modelSwap.hint')}</p>

      <div className="cf-swap__section">
        <div className="cf-swap__label">
          {t('cf.modelSwap.affected')}
          <span className="cf-swap__count">
            {changeable.length
              ? t('cf.modelSwap.willChange').replace('{n}', String(changeable.length))
              : ''}
            {changeable.length && kept.length ? ' · ' : ''}
            {kept.length ? t('cf.modelSwap.keep').replace('{n}', String(kept.length)) : ''}
          </span>
        </div>
        {affected.length === 0 ? (
          <p className="cf-swap__empty">{scanning ? t('cf.modelSwap.scanning') : t('cf.modelSwap.nothing')}</p>
        ) : (
          <ul className="cf-swap__list">
            {affected.map((b) => {
              const willChange = b.ref === fromRef
              return (
                <li key={b.sessionId} className={`cf-swap__row${willChange ? '' : ' is-kept'}`}>
                  <span className="cf-swap__name" title={b.name || b.sessionId}>
                    {b.name || b.sessionId}
                  </span>
                  <span className={`cf-swap__kind is-${b.kind}`}>
                    {(b.kind === 'nokey' || b.kind === 'keyunreadable') && <KeyRound size={12} />}
                    {kindText(b.kind)}
                  </span>
                  {(b.kind === 'nokey' || b.kind === 'keyunreadable') && (
                    <button type="button" className="cf-swap__link" onClick={goFillKey}>
                      {t('cf.modelSwap.fillKey')}
                    </button>
                  )}
                  {!willChange && <span className="cf-swap__keep">{t('cf.modelSwap.skipped')}</span>}
                </li>
              )
            })}
          </ul>
        )}
        {kept.length > 0 && <p className="cf-swap__note">{t('cf.modelSwap.keepHint')}</p>}
        {affected.some((b) => b.kind === 'nokey' || b.kind === 'keyunreadable') && (
          <p className="cf-swap__note">{t('cf.modelSwap.nokeyTip')}</p>
        )}
      </div>

      <div className="cf-swap__section">
        <div className="cf-swap__label">{t('cf.modelSwap.target')}</div>
        {items.length === 0 ? (
          <p className="cf-swap__empty">{t('cf.modelSwap.targetEmpty')}</p>
        ) : (
          <Select
            items={items}
            value={target}
            onChange={setTarget}
            placeholder={t('cf.modelSwap.targetPlaceholder')}
            aria-label={t('cf.modelSwap.target')}
          />
        )}
      </div>
    </>
  )

  return (
    <Modal open onClose={onClose} width={520} labelledBy="cf-swap-title">
      <h2 id="cf-swap-title" className="modal__title cf-swap__title">
        <AlertTriangle size={15} />
        {t('cf.modelSwap.title')}
      </h2>
      {body}
      <div className="modal__actions cf-swap__actions">
        {result ? (
          <button type="button" className="btn btn--primary" onClick={onClose} autoFocus>
            {t('cf.modelSwap.close')}
          </button>
        ) : (
          <>
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
              {t('cf.cancel')}
            </button>
            {/* 列表里一个能改的都没有、又全是缺密钥：此时正确的动作是去填密钥，换模型按钮不出—— */}
            {/* 摆一个点了什么也不会变的按钮，只会把人引向错误的解法。 */}
            {allNoKey && (
              <button type="button" className="btn btn--primary" onClick={goFillKey} autoFocus>
                <KeyRound size={14} />
                {t('cf.modelSwap.fillKey')}
              </button>
            )}
            {(changeable.length > 0 || !allNoKey) && (
              <button
                type="button"
                className={`btn${allNoKey ? ' btn--ghost' : ' btn--primary'}`}
                onClick={() => void run()}
                disabled={busy || !target || changeable.length === 0}
              >
                {busy ? t('cf.modelSwap.applying') : t('cf.modelSwap.apply')}
                {!busy && target && <ArrowRight size={14} />}
              </button>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

/** 替换结果：改了几个、跳过了几个（跳过的可展开看是哪些——它们是各自单独指定过模型的会话）。 */
function Result({
  result,
  showSkipped,
  onToggleSkipped
}: {
  result: ModelSwapResult
  showSkipped: boolean
  onToggleSkipped: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const summary = [
    t('cf.modelSwap.appliedN').replace('{n}', String(result.changed.length)),
    result.skipped.length ? t('cf.modelSwap.skippedN').replace('{n}', String(result.skipped.length)) : '',
    // 写盘失败必须出现在标题里，而不是只在展开列表里：用户在点「完成」前的那一眼就该看到「有几个没换成」
    result.failed.length ? t('cf.modelSwap.failedN').replace('{n}', String(result.failed.length)) : ''
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="cf-swap__section">
      <div className="cf-swap__result">{summary}</div>
      {/*
        写盘失败的会话单独一组、恒展开：这是「不报错但没生效」类，用户必须当场知道。
        不用 skipped 的折叠入口——那会被读成「正常保留」，而这些会话其实换不了。
      */}
      {result.failed.length > 0 && (
        <ul className="cf-swap__list">
          {result.failed.map((b) => (
            <li key={`failed:${b.sessionId}`} className="cf-swap__row">
              <span className="cf-swap__name" title={b.name || b.sessionId}>
                {b.name || b.sessionId}
              </span>
              <span className="cf-swap__kind">{t('cf.modelSwap.failed')}</span>
            </li>
          ))}
        </ul>
      )}
      {result.changed.length > 0 && (
        <ul className="cf-swap__list">
          {result.changed.map((b) => (
            <li key={b.sessionId} className="cf-swap__row">
              <span className="cf-swap__name" title={b.name || b.sessionId}>
                {b.name || b.sessionId}
              </span>
              <span className="cf-swap__kind is-ok">{t('cf.modelSwap.changed')}</span>
            </li>
          ))}
        </ul>
      )}
      {result.skipped.length > 0 && (
        <>
          <button type="button" className="cf-swap__link cf-swap__toggle" onClick={onToggleSkipped}>
            <RefreshCw size={12} />
            {showSkipped ? t('cf.modelSwap.hideSkipped') : t('cf.modelSwap.showSkipped')}
          </button>
          {showSkipped && (
            <>
              <p className="cf-swap__note">{t('cf.modelSwap.skippedHint')}</p>
              <ul className="cf-swap__list">
                {result.skipped.map((b) => (
                  <li key={b.sessionId} className="cf-swap__row is-kept">
                    <span className="cf-swap__name" title={b.name || b.sessionId}>
                      {b.name || b.sessionId}
                    </span>
                    <span className="cf-swap__kind">{b.ref}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  )
}
