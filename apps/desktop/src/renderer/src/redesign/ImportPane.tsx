import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { AlertTriangle, Check, ChevronDown, Download, Loader2, RefreshCw, ShieldAlert } from 'lucide-react'
import { useI18n } from '../i18n/i18n'
import { useExtensions } from '../store/extensions'
import { openModelSettings } from './modelSettingsBus'
import { isImportAvailable, type ImportReport, type SecretsStat, type SourceSummary } from './importBridge'
import {
  attachImportProgress,
  getImportSession,
  probeImportGate,
  runImportSession,
  setImportFailAll,
  subscribeImportSession,
  toggleImportStep
} from './importSession'
import type { Failure } from '../../../shared/import-protocol'

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
type RowStep = 'providers' | 'secrets' | 'personas' | 'personaEnabled' | 'memories' | 'skills' | 'sessions' | 'assoc'

/** 失败原因码 → 人能看懂的原因。主进程回的是 code，不是文案；未知码原样显示，不吞掉。 */
const FAILURE_REASON_KEY: Record<string, string> = {
  budget: 'settings.import.reason.budget',
  full: 'settings.import.reason.full',
  tooLong: 'settings.import.reason.tooLong',
  // 项目记忆缺少登记的项目路径，无法确定作用域（主进程只能跳过这一整个项目）。
  'missing-root': 'settings.import.reason.missingRoot',
  // 读回断言失败：本次导入的服务商 id 不在磁盘上。主进程只报不补（补一次会制造「成功」的假象），
  // 用户需要重新导入一次才能补上。
  'imported-provider-missing': 'settings.import.reason.importedProviderMissing',
  // 会话 / 附件的目标位置被同名条目占住。以前被误分类成 skipped（「跳过」看着像正常），现在如实进失败。
  'target-blocked': 'settings.import.reason.targetBlocked',
  // 这台机器没有可用加密，密钥一个都没写进去。不是写盘失败，是根本没有存储能力。
  'no-encryption': 'settings.import.reason.noEncryption',
  // 目标位置有同名条目但读不出来（可能被别的程序占着）。这是**保护**：没敢覆盖它。
  'target-unreadable': 'settings.import.reason.targetUnreadable',
  // 复制写完发现字节数与源不一致（copyFileSync 非原子，写到一半被中断）。半截副本已删掉，重导即可补齐。
  'copy-truncated': 'settings.import.reason.copyTruncated',
  // secrets.json 写盘失败。与 config-write-failed 分开：那条是 config.json，这条是密钥文件，
  // 用户按文案去查的位置不一样。
  'secrets-write-failed': 'settings.import.reason.secretsWriteFailed',
  // 目标 secrets.json 本身读不出来（内容坏 / 被占用）。此刻写进去会覆盖整份库，所以一条都不写。
  // 与 secrets-write-failed 分开：那条是「想写但磁盘写不进去」，这条是「库已经坏了，先修文件」。
  'secrets-store-unreadable': 'settings.import.reason.secretsStoreUnreadable',
  // 源里的 secrets.json 内容坏了（半截 JSON）：一个密钥都没读到，逐条 key 无从谈起，用占位 id。
  'source-secrets-corrupt': 'settings.import.reason.sourceSecretsCorrupt',
  // 源密钥文件读不出来（EPERM/EBUSY）：与「内容坏」分开，用户处置不同（等等再试 vs 去改文件内容）。
  'source-secrets-unreadable': 'settings.import.reason.sourceSecretsUnreadable',
  // MCP 服务已导入，但源 config.json 读不出 → 启用态未知，服务会停在默认关。
  // 与服务商的 source-config-unreadable 分开：那条讲服务商没导，这条讲 MCP 开关没跟上。
  'source-mcp-unreadable': 'settings.import.reason.sourceMcpUnreadable',
  'source-mcp-corrupt': 'settings.import.reason.sourceMcpCorrupt',
  'source-mcp-enabled-unknown': 'settings.import.reason.sourceMcpEnabledUnknown',
  'mcp-write-failed': 'settings.import.reason.mcpWriteFailed',
  // 源里那个服务的 id 不能当映射键 / 密钥前缀（含冒号、分隔符、首字符非法）。
  // 以前归进 skipped（界面说「不用管」），而这些服务**根本没导入**，必须让用户看见。
  'mcp-unsafe-id': 'settings.import.reason.mcpUnsafeId',
  // 源侧 config.json / memory.json 读不出来或内容坏：整份资产一个都没导入，必须让用户看到。
  'source-config-unreadable': 'settings.import.reason.sourceConfigUnreadable',
  'source-config-corrupt': 'settings.import.reason.sourceConfigCorrupt',
  'source-memory-unreadable': 'settings.import.reason.sourceMemoryUnreadable',
  'source-memory-corrupt': 'settings.import.reason.sourceMemoryCorrupt',
  // 源侧目录读不出来（同名文件占位 / ACL 改坏 / 被杀毒锁住）：那一类数据一个都没导入。
  // 统一一个码、目录身份放 id 里，界面文案表不随导入步骤增长。
  'source-dir-unreadable': 'settings.import.reason.sourceDirUnreadable',
  // 源侧**单个文件**读不出来 / 那个位置不是普通文件（目录冒充 .md 等）。与上面目录级那条分开：
  // 目录读不出是「整类都没导」，单文件读不出只影响这一条。以前这两种都记成 skipped，
  // 用户看到「跳过 1」会以为本来就有（验收实测：角色目录冒充 .md → ok:true、目标少一个角色）。
  'source-file-unreadable': 'settings.import.reason.sourceFileUnreadable',
  'source-not-a-file': 'settings.import.reason.sourceNotAFile',
  // 角色导进来了，只有头像没复制成功。要让用户知道「角色能用，只是没头像」。
  'avatar-copy-failed': 'settings.import.reason.avatarCopyFailed',
  // 记忆文件读不出来 → 主进程拒绝写入（避免「读失败当成空」把全量覆盖掉）。复用 profile 的现成文案，
  // 不为导入面板再写一条同义句。
  readFailed: 'cf.profile.err.readFailed',
  writeFailed: 'cf.profile.err.writeFailed',
  // 下面两个不限于某一步：config.json 写盘失败出现在服务商 / 角色启用态，link-failed 出现在技能建链接。
  'config-write-failed': 'settings.import.reason.configWriteFailed',
  'link-failed': 'settings.import.reason.linkFailed',
  // 写目标失败（mkdir / 复制 / 建链接）。原始 Node 错误串含本机绝对路径，只进后台日志。
  'target-write-failed': 'settings.import.reason.targetWriteFailed'
}

/**
 * 闸门失败原因的显示文案。
 *
 * 取值顺序：
 * 1. `source-running` / `no-source` 这两个「固定句子」走 i18n —— 最常出现的两种，文案与界面同源。
 * 2. 其余码一律优先用 `gate.message`：`same-home` 的文案里嵌着具体目录（`DEVA_HOME` 指到了哪），
 *    i18n 模板要额外做插值才能表达；而主进程的 message 本来就按 `config.locale` 生成
 *    （importer-gate.ts 的 `isEn()` 读的正是渲染层 `setLocale` 写进 config 的那份），中英切换同样正确。
 *    优先用它，同一句文案只需在主进程维护一处，将来新增错误码也不会在界面上退化成一句通用话。
 * 3. message 为空（探测本身抛错时的降级结果）才回落到通用文案。
 */
function gateText(gate: { code: string; message: string }, t: (k: string) => string): string {
  if (gate.code === 'source-running') return t('settings.import.gateRunning')
  if (gate.code === 'no-source') return t('settings.import.gateNoSource')
  return gate.message || t('settings.import.gateNoSource')
}

export function ImportPane(): React.JSX.Element {
  const { t } = useI18n()
  const { refresh: refreshExtensions } = useExtensions()
  const available = isImportAvailable()

  /*
   * 运行态全部从 importSession 读（模块级，跨挂载存活）。
   *
   * 为什么不住在这里：设置面板按 section 条件渲染，切到「模型」页时本组件被卸载、局部 state 全清空
   * ——用户点「去设置 › 模型重填」处理完再切回来，刚才那份报告就没了，而它正是用户的下一步行动清单。
   * 见 redesign/importSession.ts 顶部注释。
   */
  const s = useSyncExternalStore(subscribeImportSession, getImportSession, getImportSession)
  const { gate, probing, phase, progress, report, runError, expanded, failAll } = s

  // 进页探测一次（只读）。session 里已探过就不重复打 IPC——切页面回来不闪数字；用户要更新点「刷新状态」。
  useEffect(() => {
    probeImportGate()
  }, [])

  // 进度订阅挂在模块级：跑的过程中切走页面也继续收（卸载时**不**解绑，见 importSession）。
  useEffect(() => {
    attachImportProgress()
  }, [])

  // 导进来的角色 / 技能要让列表立刻可见，不必重启应用。只在「这一轮刚跑完」时刷一次：
  // 每次挂载都刷会在来回切页时反复拉扩展列表。
  useEffect(() => {
    if (phase === 'done') refreshExtensions()
    // refreshExtensions 引用稳定；只在 phase 变更时触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase])

  const canRun = available && gate?.ok === true && phase !== 'running'

  const start = (): void => runImportSession()

  const probe = (): void => probeImportGate(true)

  const toggle = (step: RowStep): void => toggleImportStep(step)

  const rows = useMemo(() => (report ? stepRows(report, t) : []), [report, t])
  const failures = useMemo(() => (report ? allFailures(report) : []), [report])
  /**
   * 收起态要显示的那几条。取值只看长度，不重排——失败顺序就是主进程产生的顺序（按步骤走的），
   * 重排会让「第一批失败是哪一步」这个信息丢掉。
   */
  const shownFailures = useMemo(
    () => (failAll ? failures : failures.slice(0, FAILURE_LIMIT)),
    [failures, failAll]
  )
  /**
   * 展开后按 step 分组。理由：396 条媒体文件失败若平铺成一长串，只能靠滚动找「哪一步出问题」；
   * 分组后一眼就能看到「媒体 396 条 / 角色 1 条」。组内顺序保持主进程给的顺序。
   * 只在展开态才算（收起态用不到，省一次分组）。
   */
  const failureGroups = useMemo(() => {
    if (!failAll) return []
    const out: Array<{ step: string; items: Failure[] }> = []
    const idx = new Map<string, number>()
    for (const f of failures) {
      const k = f.step
      const at = idx.get(k)
      if (at === undefined) {
        idx.set(k, out.length)
        out.push({ step: k, items: [f] })
      } else {
        out[at].items.push(f)
      }
    }
    return out
  }, [failures, failAll])
  /** 收起态还有多少条没显示（用它渲染「还有 N 条」）。 */
  const hiddenFailures = Math.max(0, failures.length - FAILURE_LIMIT)
  /** 失败总数取自报告本身（含被清单省略的 no-encryption 那批），标题用它；清单只是明细。 */
  const failureTotal = report
    ? report.failures.length + report.memories.failed.filter((f) => !report.failures.includes(f)).length
    : 0
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
          <span>{gateText(gate, t)}</span>
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
                  : t('settings.import.doneWithFailures').replace('{n}', String(failureTotal))}
            </span>
          </div>

          <ul className="cf-imp__list">
            {rows.map((r) => (
              <li key={r.step} className="cf-imp__row">
                <span className="cf-imp__step">{t(`settings.import.steps.${r.step}`)}</span>
                <span className="cf-imp__num is-ok">
                  {t('settings.import.countCopied').replace('{n}', String(r.copied))}
                </span>
                {/* 「跳过 N」不显示在密钥行：那边用带语义的 note 标签（「已存在，保留本地」），
                    一个裸数字说不清它是不是失败了。 */}
                {!r.notes && (
                  <span className="cf-imp__num">
                    {t('settings.import.countSkipped').replace('{n}', String(r.skipped))}
                  </span>
                )}
                {r.failed > 0 && !r.notes && (
                  <span className="cf-imp__num is-bad">
                    {t('settings.import.countFailed').replace('{n}', String(r.failed))}
                  </span>
                )}
                {/* 密钥行的附加说明：每种「没进来」的原因各一个标签，颜色区分该不该动手。 */}
                {r.notes?.map((n) => (
                  <span key={n.kind} className={`cf-imp__note-tag is-${n.tone}`}>
                    {secretNoteText(n, t)}
                  </span>
                ))}
                {(r.detail.length > 0 || (r.noteIds?.length ?? 0) > 0) && (
                  <button className="cf-imp__link" onClick={() => toggle(r.step)}>
                    {expanded.has(r.step) ? t('settings.import.hideDetail') : t('settings.import.showDetail')}
                    <ChevronDown size={12} className={expanded.has(r.step) ? 'is-open' : ''} />
                  </button>
                )}
                {expanded.has(r.step) && (
                  <ul className="cf-imp__sub">
                    {/* 密钥行按「没进来的原因」分组列，不是一串平铺 id：用户要知道哪几个该重填、哪几个不用管。 */}
                    {r.noteIds
                      ? r.noteIds.map((g) =>
                          g.ids.length ? (
                            <li key={g.kind}>
                              {t(`settings.import.secretGroup.${g.kind}`)}：
                              {g.ids.slice(0, DETAIL_LIMIT).join('、')}
                              {g.ids.length > DETAIL_LIMIT
                                ? t('settings.import.moreDetail').replace('{n}', String(g.ids.length - DETAIL_LIMIT))
                                : ''}
                            </li>
                          ) : null
                        )
                      : r.detail.slice(0, DETAIL_LIMIT).map((d) => <li key={d}>{d}</li>)}
                    {!r.noteIds && r.detail.length > DETAIL_LIMIT && (
                      <li>{t('settings.import.moreDetail').replace('{n}', String(r.detail.length - DETAIL_LIMIT))}</li>
                    )}
                  </ul>
                )}
              </li>
            ))}
          </ul>

          {/* 需要重填的密钥：面板级警告，**不是失败**（report.ok 由主进程保证，unrecoverable 不进 failed）。
              放在失败清单之前——它是用户眼下唯一要动手的事。 */}
          <UnrecoverableNotice keys={report.secrets.unrecoverable} />

          {/* 失败常驻：步骤 + 对象 + 原因都写出来，用户才知道该去清哪几条记忆。
              但条数可能几百条（媒体目录被占位时 396 个文件逐条失败），默认只显示 FAILURE_LIMIT 条，
              剩下用「还有 N 条」+ 展开入口带过；展开后按 step 分组，避免一长串要滚着找哪一步出问题。 */}
          {failures.length > 0 && (
            <div className="cf-imp__fails">
              <div className="cf-imp__failhead">
                <span>{t('settings.import.failures')}</span>
                <span className="cf-imp__failcount">
                  {failures.length > FAILURE_LIMIT
                    ? t('settings.import.failureCountCapped')
                        .replace('{total}', String(failures.length))
                        .replace('{shown}', String(shownFailures.length))
                    : t('settings.import.failureCount').replace('{n}', String(failures.length))}
                </span>
                {hiddenFailures > 0 && (
                  <button
                    type="button"
                    className="cf-imp__failmore"
                    aria-expanded={failAll}
                    onClick={() => setImportFailAll(!failAll)}
                  >
                    {failAll
                      ? t('settings.import.failureCollapse')
                      : t('settings.import.failureExpand').replace('{n}', String(hiddenFailures))}
                    <ChevronDown size={12} className="cf-imp__failchev" />
                  </button>
                )}
              </div>
              {/*
                收起态与展开态互斥，用**条件渲染**而不是 Fold：
                Fold 收起时 children 仍然挂载（只是 CSS 0fr + aria-hidden），397 条 li 照样在 DOM 里，
                而这次要解决的正是「397 个 li 全渲染」。条件渲染才是真的只渲染 8 条。
              */}
              {!failAll && (
                <ul className="cf-imp__list">
                  {shownFailures.map((f, i) => (
                    <li key={`${f.step}:${f.id}:${f.reason}:${i}`} className="cf-imp__row cf-imp__row--fail">
                      <span className="cf-imp__step">{stepText(f.step, t)}</span>
                      <code className="cf-imp__fid" title={f.id}>
                        {idText(f.id, t)}
                      </code>
                      <span className="cf-imp__reason">{reasonText(f.reason, t)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {failAll && (
                /* 展开态：按 step 分组。组头给「步骤 + N 条」，组内是完整清单（可滚动）。
                   396 条媒体失败若平铺成一长串，只能滚着找哪一步出问题；分组后一眼看到分布。 */
                <div className="cf-imp__failgroups">
                  {failureGroups.map((g) => (
                    <section key={g.step} className="cf-imp__failgroup">
                      <div className="cf-imp__failgrouphd">
                        <span className="cf-imp__step cf-imp__step--g">{stepText(g.step, t)}</span>
                        <span className="cf-imp__failcount">
                          {t('settings.import.failureCount').replace('{n}', String(g.items.length))}
                        </span>
                      </div>
                      <ul className="cf-imp__list">
                        {g.items.map((f, i) => (
                          <li key={`${f.step}:${f.id}:${f.reason}:${i}`} className="cf-imp__row cf-imp__row--fail">
                            <code className="cf-imp__fid" title={f.id}>
                              {idText(f.id, t)}
                            </code>
                            <span className="cf-imp__reason">{reasonText(f.reason, t)}</span>
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              )}
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
  /**
   * 行内附加说明（密钥这一行专用）：每一条是一个「没进来」的原因分类 + 数量 + 严重度。
   * 密钥的「没进来」有四种彼此不同的原因，压进 skipped 就是把「这台机器存不了密钥、请手动重填」
   * 说成「本来就有，不用管」——那正是「密钥不用重输」唯一会无声失效的通道。所以它们单列成小标签。
   */
  notes?: SecretNote[]
  /** notes 的原始 id，展开后逐条显示（按 note.kind 分组）。 */
  noteIds?: Array<{ kind: string; ids: string[] }>
}

/** 密钥行的一条附加说明。tone 决定颜色：bad = 用户必须动手，warn = 需要注意，plain = 正常情况，good = 修好了。 */
interface SecretNote {
  kind: 'noEncryption' | 'invalid' | 'skipped' | 'ignored' | 'failed' | 'rekeyed'
  count: number
  tone: 'bad' | 'warn' | 'plain' | 'good'
}

/** 明细最多列这么多条（跳过几十个会话时不必把列表摊满整屏），余下的用一句「还有 N 个」带过。 */
const DETAIL_LIMIT = 12

/**
 * 失败清单默认显示前几条。选 8 的理由：
 * - 容器 max-height 200px、每行约 24px → 恰好约 8 行可见；N 取 8 时「默认显示」和「可见范围」对齐，
 *   用户不用先滚动才发现下面还有——而滚动区里藏着的失败等于没告诉他。
 * - 实际故障分布是「1~3 条真失败」占绝大多数，8 条能把它们全放下；
 *   而 397 条那种批量失败（媒体目录被占位）本来就是同一步、同原因的重复，8 条足够看出「是哪一步、什么原因」。
 * - 不取 12 是因为 12×24=288px > 200px 容器，会有 4 条被裁在滚动区外。
 */
const FAILURE_LIMIT = 8

/**
 * 「需要重填的密钥」默认显示几条。选 5 的理由：这类清单正常就 1~3 条（用户手里实测是 2 条），
 * 5 行足够全放下、也不占地方；真到十几条时折叠成「还有 N 条」，点开再看全。
 */
const UNRECOVERABLE_LIMIT = 5

/**
 * 密钥行。`report.secrets` 是 `SecretsStat`（不再是 `StepStat` 兼容形状），必须专门摊：
 *
 * | 分桶 | 含义 | 界面 |
 * |---|---|---|
 * | `copied` | 写进目标 secrets.json | 正常「新增 N」，展开看是哪些 provider |
 * | `skipped` | 目标已有同名密钥，保留本地 | 中性色。**不是失败**，要说清「不用管」 |
 * | `noEncryption` | 这台机器没有可用加密，一个都没存进去 | 警示色 + 「请手动重填」 |
 * | `invalid` | 源里那条本身是空值/坏值 | 警示色：用户该知道有东西没导进来 |
 * | `ignored` | 不适用（`remote:` / `mcp:` 无主密文） | 最次要位置，正常情况 |
 * | `failed` | 真失败（写盘失败等） | 危险色，进失败清单 |
 * | `rekeyed` | 覆盖修好了目标里原有的坏密文 | 成功色：让「重新导一次」有可见结果 |
 *
 * **`unrecoverable` 不在本行显示**：它是「用户的动作」（去设置重填），不是「这一步的结果」，
 * 单列成面板级警告见 {@link UnrecoverableNotice}——混进这一行的标签里，用户会以为导入失败了。
 *
 * **`no-encryption` 会同时出现在 `noEncryption` 和 `failed` 里**（主进程有意为之：既单列、也压 ok=false，
 * 因为「密钥全没存进去却报导入完成」用户不会去重填）。所以 failed 的计数与明细都要**排除**这批，
 * 否则同一个 id 会在界面上报两遍。
 */
export function secretsRow(stat: SecretsStat): StepRow {
  // 主进程对 no-encryption 的条目既塞进 noEncryption 也塞进 failed（reason 为 'no-encryption'）。
  // 这里把它们从 failed 里摘出来，只由 noEncryption 那一条说明来代表，避免重复报。
  const noEncKeys = new Set(stat.noEncryption)
  const realFailed = (stat.failed ?? []).filter(
    (f) => f.reason !== 'no-encryption' && !noEncKeys.has(f.id)
  )
  const notes: SecretNote[] = []
  if (stat.noEncryption.length > 0) notes.push({ kind: 'noEncryption', count: stat.noEncryption.length, tone: 'bad' })
  if (realFailed.length > 0) notes.push({ kind: 'failed', count: realFailed.length, tone: 'bad' })
  // 修好的坏密文：成功色。它是 copied 的子集，故只在这里多说一句「其中 N 条是修好的」，不改 copied 的计数。
  if (stat.rekeyed.length > 0) notes.push({ kind: 'rekeyed', count: stat.rekeyed.length, tone: 'good' })
  if (stat.invalid.length > 0) notes.push({ kind: 'invalid', count: stat.invalid.length, tone: 'warn' })
  if (stat.skipped.length > 0) notes.push({ kind: 'skipped', count: stat.skipped.length, tone: 'plain' })
  if (stat.ignored.length > 0) notes.push({ kind: 'ignored', count: stat.ignored.length, tone: 'plain' })
  return {
    step: 'secrets',
    // 「导入了几条密钥」的唯一口径就是 copied：`rekeyed` 是它的子集，加进去会重复计数。
    copied: stat.copied.length,
    // 保留真实数字：`noopRun`（第二次跑「跳过 N 个，无新增」）与 skippedTotal 都按这个累加，
    // 置 0 会让只跳过了密钥的那一轮误报成「导入完成」。展示处对带 notes 的行不显示这一列——
    // 密钥行用带语义的 note 标签（「已存在，保留本地」），裸数字说不清它是不是失败。
    skipped: stat.skipped.length,
    // failed 含两类：真失败 + no-encryption。后者虽然也记进了 failed（主进程有意压 ok=false），
    // 但它在界面上由 noEncryption 那条说明代表，故这里只累加不重复显示明细。
    failed: stat.noEncryption.length + realFailed.length,
    detail: stat.copied,
    notes,
    noteIds: [
      { kind: 'noEncryption', ids: stat.noEncryption },
      { kind: 'failed', ids: realFailed.map((f) => f.id) },
      { kind: 'rekeyed', ids: stat.rekeyed },
      { kind: 'invalid', ids: stat.invalid },
      { kind: 'skipped', ids: stat.skipped },
      { kind: 'ignored', ids: stat.ignored }
    ].filter((g) => g.ids.length > 0)
  }
}

/** 密钥行一条说明的文案。 */
function secretNoteText(n: SecretNote, t: (k: string) => string): string {
  return t(`settings.import.secretNote.${n.kind}`).replace('{n}', String(n.count))
}

/**
 * 「N 条密钥需要重新填写」——面板级警告，**不是失败**。
 *
 * 为什么单独一块、而不是密钥行里的一个标签：
 *  - 这一栏讲的是**用户要做什么**（去设置重填），不是「这一步导了什么」；
 *  - `report.ok` 已由主进程保证为 true（`unrecoverable` 刻意不进 `failed`，见 importer-config.ts 的注释），
 *    所以绝不能跟着失败清单一起用危险色/「导入失败」的措辞——那会让用户以为整轮白干了；
 *  - 用户必须知道**是哪几条**：只报数字，他打开设置面对一堆服务商无从下手。
 *
 * 逐条列 key 名，超过 UNRECOVERABLE_LIMIT 条折叠（与失败清单同一套「先看几条、再展开」的做法，
 * 但这里是按钮切换而非条件渲染：重填清单通常就几条，折叠只为不让 10+ 条的极端情况把面板撑爆）。
 */
function UnrecoverableNotice({ keys }: { keys: string[] }): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  if (keys.length === 0) return <></>
  const shown = open ? keys : keys.slice(0, UNRECOVERABLE_LIMIT)
  const hidden = keys.length - shown.length
  return (
    <div className="cf-imp__warn">
      <div className="cf-imp__warnhead">
        <AlertTriangle size={14} />
        <span>{t('settings.import.unrecoverable.title').replace('{n}', String(keys.length))}</span>
      </div>
      <p className="cf-imp__warndesc">{t('settings.import.unrecoverable.hint')}</p>
      <ul className="cf-imp__keys">
        {shown.map((k) => (
          <li key={k}>
            <code>{k}</code>
          </li>
        ))}
        {hidden > 0 && (
          <li>
            <button type="button" className="cf-imp__link" onClick={() => setOpen(true)}>
              {t('settings.import.unrecoverable.more').replace('{n}', String(hidden))}
            </button>
          </li>
        )}
      </ul>
      <div className="cf-imp__warnact">
        <button type="button" className="btn btn--ghost" onClick={openModelSettings}>
          {t('settings.import.unrecoverable.goSettings')}
        </button>
      </div>
    </div>
  )
}

/**
 * 把 ImportReport 摊成界面的行。附件那一步没有 id 列表，用「四类各多少」当明细。
 */
function stepRows(report: ImportReport, t: (k: string) => string): StepRow[] {
  const memFail = report.memories.failed
  const rows: StepRow[] = [
    row('providers', report.providers),
    // 密钥补缺单列（不走通用 row()）：它有自己的五种状态，见 secretsRow。
    secretsRow(report.secrets),
    row('personas', report.personas),
    {
      // 角色启用态（补 config.personas.enabled）：这一步原先只有失败会经 failures 露出，成功数在界面上
      // 完全不显示，用户不知道「我导入的角色能不能直接选」。它没有独立清单，只有「共启用了几个」的数字。
      step: 'personaEnabled',
      copied: report.personaEnabled.length,
      skipped: 0,
      // 失败由 report.failures 里 step==='personaEnabled' 的条目给出（主进程 importer.ts:112 汇总）。
      failed: report.failures.filter((f) => f.step === 'personaEnabled').length,
      detail: report.personaEnabled
    },
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
      // 附件这一步原本只有数字没有失败位，会像「永远不出错」；主进程现在把它的失败也带上了。
      failed: report.assoc.failed?.length ?? 0,
      detail: (['media', 'checkpoints', 'subagents', 'toolResults'] as const).map(
        (k) => `${t(`settings.import.assoc.${k}`)} ${report.assoc[k]}`
      )
    }
  ]
  // 完全没动静的行不摆出来：源里没有角色可启用时，多一行「0 新增 0 跳过」只会稀释真正有数字的那几行。
  // 有失败的行一律保留（failed > 0），失败不能让用户去猜它在哪一步。
  // 有 notes 的行也保留：密钥行可能三个数字都为 0（比如只导入了 ignored），但它的说明本身就是信息。
  return rows.filter((r) => r.copied > 0 || r.skipped > 0 || r.failed > 0 || (r.notes?.length ?? 0) > 0)
}

/**
 * 一步的统计摊成界面的一行。failed 取 StepStat 自带的失败清单（可缺省，旧数据没有这一项）；
 * 五步都靠这里出数，不给某一步写特例。skipped 同时当明细用：跳过的 id 就是「已经存在」的清单。
 */
function row(step: RowStep, stat: { copied: string[]; skipped: string[]; failed?: Failure[] }): StepRow {
  return {
    step,
    copied: stat.copied.length,
    skipped: stat.skipped.length,
    failed: stat.failed?.length ?? 0,
    detail: stat.skipped
  }
}

/**
 * 全部失败：记忆被拒写的那批在 `report.failures` 里还有一份副本（importer.ts 用 `push(...memories.failed)`
 * 推的是**同一批对象**，不是复制），这里去重。
 *
 * 为什么按对象身份而不是 `step:id:reason` 去重：记忆的 id 取自源文件 `raw.id`，源里某条没写 id 时是空串
 * （importer-memory.ts:65/80）。两条空 id、同因 budget 被拒的记忆会算出同一个内容键，清单只剩一行，
 * 而上面那行「失败 2」写着 2——用户看到的数字和条数对不上。按身份去重则两个目标同时满足：
 * 推了两处的同一条被收敛成一条，两条不同的失败哪怕内容完全相同也都留下。
 *
 * 依据：ipcMain.handle 的返回值走 structured clone，同一对象的多次引用在跨进程后仍是同一个对象。
 * 万一将来这条性质变了（比如主进程改成深拷贝后再推），后果是**多显示一行**重复，而不是吞掉真实失败——
 * 这个方向是可接受的。
 *
 * `no-encryption` 的条目在这里被**排除**：它在密钥行已经由 noEncryption 那条说明（「这台机器存不了密钥，
 * 请手动重填 N 个」）整体代表过一次，再在失败清单里逐个 id 列一遍就是同一件事报两遍。它们仍计入
 * 顶部的「有 N 条失败」标题（失败数来自 rows，不受这里影响）——只是不再单独占一行。
 */
function allFailures(report: ImportReport): Failure[] {
  const seen = new Set<Failure>()
  const out: Failure[] = []
  for (const f of [...report.memories.failed, ...report.failures]) {
    // 密钥的「无加密可用」交给密钥行统一说明，清单里不重复列。
    if (f.reason === 'no-encryption') continue
    if (seen.has(f)) continue
    seen.add(f)
    out.push(f)
  }
  return out
}

/** 失败原因：已知错误码翻成一句人话，未知的原样显示（宁可露出原始码，也不吞掉）。 */
function reasonText(reason: string, t: (k: string) => string): string {
  const key = FAILURE_REASON_KEY[reason]
  return key ? t(key) : reason
}

/**
 * 失败条目所属步骤的显示名。
 *
 * `Failure.step` 是主进程的步骤码，其中 `personaEnabled`（补角色启用态）与 `unknown`（整轮兜底）
 * 并没有对应的进度条步骤，但会出现在失败清单里——直接渲染原值就是中文界面里冒出英文单词。
 * 走 i18n，取不到（主进程将来新增步骤码）时回落原文，至少不会显示成 key。
 */
function stepText(step: string, t: (k: string) => string): string {
  const key = `settings.import.steps.${step}`
  const s = t(key)
  return s === key ? step : s
}

/**
 * 失败条目指向的对象。主进程对「没有具体对象」的失败用尖括号占位（`<whole-run>` / `<dir>` /
 * `<config.json>`），这些是给日志检索用的，直接摆在界面上用户看不懂。
 *
 * `<unsafe-id:xxxx>` 是同一类占位：原始 id 可能很长或含控制字符，主进程截短后带前缀传过来。
 * 它没有固定文案（xxxx 是数据），所以按前缀识别后显示「不能用作配置键的那个 id」+ 截短值。
 */
const ID_PLACEHOLDER_KEY: Record<string, string> = {
  '<whole-run>': 'settings.import.idWholeRun',
  '<dir>': 'settings.import.idDir',
  '<config.json>': 'settings.import.idConfig'
}

function idText(id: string, t: (k: string) => string): string {
  if (!id) return '—'
  if (id.startsWith('<unsafe-id:')) {
    return `${t('settings.import.idUnsafeId')}${id.slice('<unsafe-id:'.length, -1)}`
  }
  const key = ID_PLACEHOLDER_KEY[id]
  return key ? t(key) : id
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
