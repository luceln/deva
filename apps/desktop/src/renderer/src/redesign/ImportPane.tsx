import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, ChevronDown, Download, Loader2, RefreshCw, ShieldAlert } from 'lucide-react'
import { useI18n } from '../i18n/i18n'
import { useExtensions } from '../store/extensions'
import {
  isImportAvailable,
  onImportProgress,
  probeImport,
  runImport,
  type GateResult,
  type ImportProgress,
  type ImportReport,
  type SourceSummary
} from './importBridge'

/**
 * 设置 › 导入：把原版 Deva 的数据搬过来（服务商 / 角色 / 记忆 / 技能 / 会话 / 附件）。
 *
 * 几条刻意的取舍：
 * - **手动触发，不自动跑**：需求要的是「新装的应用别从零开始」这一下，不是持续同步。进面板只做一次只读
 *   probe（拿闸门状态与概览数字），绝不在启动或进页时偷偷执行导入。
 * - **闸门在界面上是硬前置**：原版还在跑时按钮直接禁用并写明「请先退出 Deva」。让用户点了再报错，会让人
 *   以为是导入坏了。主进程在 import:run 开头还会再查一次（探测到这里点下之间，用户可能又把原版开了）。
 * - **进度用事件，不轮询**：附件上百 MB，轮询既拿不到阶段明细，又会在复制大目录时空转。
 * - **失败必须显形**：单条失败（记忆超配额最典型）不会中止整轮，只记进 failures。这些条目若只写日志，
 *   用户会以为全导成功了——所以失败清单常驻显示，不给「收起来就看不见」的机会。
 * - **判定全部来自主进程**：渲染层不自己判断原版在不在跑（那是 lockfile 独占打开的结论），也不按报告
 *   反推数据是否完整。
 */

/**
 * 结果里的一行对应一个可见步骤。`secrets` 不在进度事件的 step 取值里（密钥补缺发生在 ① 服务商 之内），
 * 它是主进程单独计数的一项，只在结果清单里占一行——密钥和 provider 混在一起数会让「服务商」那行虚高。
 */
type RowStep = 'providers' | 'secrets' | 'personas' | 'memories' | 'skills' | 'sessions' | 'assoc'

/** 记忆拒写的错误码 → 人能看懂的原因。主进程回的是 code，不是文案。 */
const FAILURE_REASON_KEY: Record<string, string> = {
  budget: 'settings.import.reason.budget',
  full: 'settings.import.reason.full',
  tooLong: 'settings.import.reason.tooLong'
}

export function ImportPane(): React.JSX.Element {
  const { t } = useI18n()
  const { refresh: refreshExtensions } = useExtensions()
  const available = isImportAvailable()

  // 闸门结果：null = 还没探测完。探测是进页的一次只读动作。
  const [gate, setGate] = useState<GateResult | null>(null)
  const [probing, setProbing] = useState(available)
  const [phase, setPhase] = useState<'idle' | 'running' | 'done'>('idle')
  const [progress, setProgress] = useState<ImportProgress | null>(null)
  const [report, setReport] = useState<ImportReport | null>(null)
  const [runError, setRunError] = useState('')
  /** 展开看明细的步骤（结果里「跳过了哪些」）。 */
  const [expanded, setExpanded] = useState<Set<RowStep>>(() => new Set())
  // 卸载后不再 setState：导入要跑几十秒，用户完全可能在途中关掉设置面板。
  const aliveRef = useRef(true)
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  const probe = useCallback((): void => {
    if (!available) return
    setProbing(true)
    void probeImport().then((r) => {
      if (!aliveRef.current) return
      setGate(r)
      setProbing(false)
    })
  }, [available])

  // 进页探测一次（只读）。跑完导入再探一次，让概览反映「现在原版还有什么」。
  useEffect(() => probe(), [probe])

  // 订阅进度事件。常驻订阅（挂上很便宜）可避免「点下去」与「挂监听」之间的竞态。
  useEffect(() => {
    if (!available) return
    return onImportProgress((p) => {
      if (aliveRef.current) setProgress(p)
    })
  }, [available])

  const canRun = available && gate?.ok === true && phase !== 'running'

  const start = (): void => {
    if (!canRun) return
    setPhase('running')
    setProgress(null)
    setReport(null)
    setRunError('')
    setExpanded(new Set())
    void runImport().then((r) => {
      if (!aliveRef.current) return
      setProgress(null)
      if ('error' in r) {
        // 整轮没跑起来（闸门在 run 开头又拦了一次 / 已有导入在进行）：回到 idle，把原因摆出来，
        // 而不是给一份空报告让人以为「什么都没导」。
        setPhase('idle')
        setRunError(r.error)
        probe()
        return
      }
      setReport(r)
      setPhase('done')
      // 导进来的角色 / 技能要让列表立刻可见，不必重启应用。会话列表由主进程清索引后广播刷新，
      // 渲染层不插手（见给主进程的对齐项）。
      refreshExtensions()
      probe()
    })
  }

  const toggle = (step: RowStep): void =>
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(step)) n.delete(step)
      else n.add(step)
      return n
    })

  const rows = useMemo(() => (report ? stepRows(report, t) : []), [report, t])
  const failures = useMemo(() => (report ? allFailures(report) : []), [report])
  // 第二次跑：一条也没搬、却有跳过 → 「跳过 N 个，无新增」。这是幂等的可见证据，不是错误。
  const noopRun =
    !!report && report.ok && rows.every((r) => r.copied === 0) && rows.some((r) => r.skipped > 0)
  const skippedTotal = rows.reduce((n, r) => n + r.skipped, 0)

  if (!available) {
    return (
      <>
        <h2 className="cf-pane__title">{t('settings.import.title')}</h2>
        <p className="cf-pane__desc">{t('settings.import.unavailable')}</p>
      </>
    )
  }

  return (
    <>
      <h2 className="cf-pane__title">{t('settings.import.title')}</h2>
      <p className="cf-pane__desc">{t('settings.import.desc')}</p>

      {/* 闸门：只在有问题时占位（一切正常时不必多一行「可以导入」的废话）。 */}
      {gate && !gate.ok && (
        <div className="cf-imp__gate">
          <ShieldAlert size={14} />
          <span>{gate.code === 'source-running' ? t('settings.import.gateRunning') : t('settings.import.gateNoSource')}</span>
          <button className="cf-imp__link" onClick={probe} disabled={probing}>
            {t('settings.import.recheck')}
          </button>
        </div>
      )}

      <div className="cf-set">
        {/* 源目录只读展示：路径由主进程拼，渲染层不持有可写句柄，也就不给编辑入口。 */}
        <div className="cf-set__row">
          <div className="cf-set__label">
            {t('settings.import.source')}
            <span className="cf-set__hint">{t('settings.import.sourceHint')}</span>
          </div>
          <code className="cf-imp__path" title={gate?.ok ? gate.sourceHome : ''}>
            {gate?.ok ? gate.sourceHome : probing ? t('settings.import.probing') : '—'}
          </code>
        </div>
        {gate?.ok && (
          <div className="cf-set__row cf-imp__row--block">
            <div className="cf-set__label">
              {t('settings.import.overview')}
              <span className="cf-set__hint">{t('settings.import.overviewHint')}</span>
            </div>
            <div className="cf-imp__stats">
              {statCells(gate.summary, t).map((c) => (
                <span key={c.label} className="cf-imp__stat">
                  <b>{c.value}</b>
                  {c.label}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 进行中：进度条 + 当前阶段（八步里走到哪、该步几成）。 */}
      {phase === 'running' && (
        <div className="cf-imp__run">
          <div className="cf-imp__runtop">
            <Loader2 size={13} className="cf-imp__spin" />
            <span>{t(`settings.import.steps.${progress?.step ?? 'providers'}`)}</span>
            {progress && progress.total > 0 && (
              <span className="cf-imp__pct">
                {progress.done} / {progress.total}
              </span>
            )}
          </div>
          <div className="cf-imp__bar">
            <div
              className={`cf-imp__fill${progress && progress.total > 0 ? '' : ' is-moving'}`}
              style={
                progress && progress.total > 0
                  ? { width: `${Math.min(100, Math.round((progress.done / progress.total) * 100))}%` }
                  : undefined
              }
            />
          </div>
          <div className="cf-imp__detail">{t('settings.import.stepHint')}</div>
        </div>
      )}

      {runError && (
        <div className="cf-imp__gate">
          <AlertTriangle size={14} />
          <span>{t('settings.import.runFailed')}</span>
          <code className="cf-imp__fid">{runError}</code>
        </div>
      )}

      {/* 结果：新增 / 跳过 / 失败三类分开数。失败清单常驻，不折叠。 */}
      {phase === 'done' && report && (
        <div className="cf-imp__result">
          <div className="cf-imp__resulthead">
            {report.ok ? <Check size={14} /> : <AlertTriangle size={14} />}
            <span>
              {noopRun
                ? t('settings.import.noop').replace('{n}', String(skippedTotal))
                : report.ok
                  ? t('settings.import.done')
                  : t('settings.import.doneWithFailures').replace('{n}', String(failures.length))}
            </span>
          </div>

          <ul className="cf-imp__list">
            {rows.map((r) => (
              <li key={r.step} className="cf-imp__row">
                <span className="cf-imp__step">{t(`settings.import.steps.${r.step}`)}</span>
                <span className="cf-imp__num is-ok">
                  {t('settings.import.countCopied').replace('{n}', String(r.copied))}
                </span>
                <span className="cf-imp__num">
                  {t('settings.import.countSkipped').replace('{n}', String(r.skipped))}
                </span>
                {r.failed > 0 && (
                  <span className="cf-imp__num is-bad">
                    {t('settings.import.countFailed').replace('{n}', String(r.failed))}
                  </span>
                )}
                {r.detail.length > 0 && (
                  <button className="cf-imp__link" onClick={() => toggle(r.step)}>
                    {expanded.has(r.step) ? t('settings.import.hideDetail') : t('settings.import.showDetail')}
                    <ChevronDown size={12} className={expanded.has(r.step) ? 'is-open' : ''} />
                  </button>
                )}
                {expanded.has(r.step) && (
                  <ul className="cf-imp__sub">
                    {r.detail.slice(0, DETAIL_LIMIT).map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                    {r.detail.length > DETAIL_LIMIT && (
                      <li>{t('settings.import.moreDetail').replace('{n}', String(r.detail.length - DETAIL_LIMIT))}</li>
                    )}
                  </ul>
                )}
              </li>
            ))}
          </ul>

          {/* 失败常驻：步骤 + 对象 + 原因都写出来，用户才知道该去清哪几条记忆。 */}
          {failures.length > 0 && (
            <div className="cf-imp__fails">
              <div className="cf-imp__failhead">{t('settings.import.failures')}</div>
              <ul className="cf-imp__list">
                {failures.map((f, i) => (
                  <li key={`${f.step}:${f.id}:${i}`} className="cf-imp__row cf-imp__row--fail">
                    <span className="cf-imp__step">{f.step}</span>
                    <code className="cf-imp__fid" title={f.id}>
                      {f.id || '—'}
                    </code>
                    <span className="cf-imp__reason">{reasonText(f.reason, t)}</span>
                  </li>
                ))}
              </ul>
              <p className="cf-imp__note">{t('settings.import.failureHint')}</p>
            </div>
          )}
        </div>
      )}

      <div className="cf-imp__actions">
        <button className="btn btn--primary" onClick={start} disabled={!canRun}>
          {phase === 'running' ? (
            <>
              <Loader2 size={14} className="cf-imp__spin" />
              {t('settings.import.running')}
            </>
          ) : (
            <>
              <Download size={14} />
              {phase === 'done' ? t('settings.import.runAgain') : t('settings.import.run')}
            </>
          )}
        </button>
        <button className="btn btn--ghost" onClick={probe} disabled={probing || phase === 'running'}>
          <RefreshCw size={14} />
          {t('settings.import.reprobe')}
        </button>
      </div>
    </>
  )
}

/** 结果里的一行：某一步新建几个、跳过几个、失败几个，外加可展开的明细。 */
interface StepRow {
  step: RowStep
  copied: number
  skipped: number
  failed: number
  /** 明细逐条（跳过的 id / 附件四类计数）；超过 DETAIL_LIMIT 条的截断在渲染处做。 */
  detail: string[]
}

/** 明细最多列这么多条（跳过几十个会话时不必把列表摊满整屏），余下的用一句「还有 N 个」带过。 */
const DETAIL_LIMIT = 12

/** 把 ImportReport 摊成界面的行。附件那一步没有 id 列表，用「四类各多少」当明细。 */
function stepRows(report: ImportReport, t: (k: string) => string): StepRow[] {
  const memFail = report.memories.failed
  return [
    row('providers', report.providers),
    // 密钥补缺单列：导入后「密钥要不要重输」是用户最关心的一件事之一，混在服务商那行里就看不出来了。
    row('secrets', report.secrets),
    row('personas', report.personas),
    {
      step: 'memories',
      copied: report.memories.added.length,
      skipped: report.memories.skipped.length,
      failed: memFail.length,
      detail: report.memories.skipped
    },
    row('skills', report.skills),
    row('sessions', report.sessions),
    {
      // 四类附件的总数当「新增」：它们没有 id 清单，逐类数字放在明细里。
      step: 'assoc',
      copied:
        report.assoc.media + report.assoc.checkpoints + report.assoc.subagents + report.assoc.toolResults,
      skipped: 0,
      failed: 0,
      detail: (['media', 'checkpoints', 'subagents', 'toolResults'] as const).map(
        (k) => `${t(`settings.import.assoc.${k}`)} ${report.assoc[k]}`
      )
    }
  ]
}

function row(step: RowStep, stat: { copied: string[]; skipped: string[] }): StepRow {
  return {
    step,
    copied: stat.copied.length,
    skipped: stat.skipped.length,
    failed: 0,
    detail: stat.skipped
  }
}

/** 全部失败：记忆被拒写的那批（带原因）也在 failures 里，这里只去重，不改写。 */
function allFailures(report: ImportReport): Array<{ step: string; id: string; reason: string }> {
  const seen = new Set<string>()
  const out: Array<{ step: string; id: string; reason: string }> = []
  for (const f of [...report.memories.failed, ...report.failures]) {
    const k = `${f.step}:${f.id}:${f.reason}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(f)
  }
  return out
}

/** 失败原因：已知错误码翻成一句人话，未知的原样显示（宁可露出原始码，也不吞掉）。 */
function reasonText(reason: string, t: (k: string) => string): string {
  const key = FAILURE_REASON_KEY[reason]
  return key ? t(key) : reason
}

/** 概览的几格：对话 / 服务商 / 角色 / 记忆 / 技能 / 附件（四类合计）。 */
function statCells(s: SourceSummary, t: (k: string) => string): Array<{ label: string; value: string }> {
  const attachments = s.media + s.checkpoints + s.subagents + s.toolResults
  return [
    { label: t('settings.import.stat.sessions'), value: String(s.sessions) },
    { label: t('settings.import.stat.providers'), value: String(s.providers) },
    { label: t('settings.import.stat.personas'), value: String(s.personas) },
    { label: t('settings.import.stat.memories'), value: String(s.memories) },
    { label: t('settings.import.stat.skills'), value: String(s.skills) },
    { label: t('settings.import.stat.attachments'), value: String(attachments) }
  ]
}
