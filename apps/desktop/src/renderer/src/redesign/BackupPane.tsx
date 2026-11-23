import { useEffect, useState } from 'react'
import { Download, Loader2, Upload } from 'lucide-react'
import { useI18n } from '../i18n/i18n'
import type { ExportProgress } from '../../../shared/bundle-format'

/**
 * 设置 › 备份：把当前数据导出成一个本地文件，或从这样一个文件还原。
 *
 * ## 与「设置 › 导入」的分工（这个区别是整个功能的关键）
 *
 * - **导入**：从原版 Deva 的数据目录搬东西过来，设计目标是「新装的应用别从零开始」——
 *   所以只补缺、按 id 只增不改，并且**刻意不导界面偏好**（见 `main/services/importer-config.ts:21-22`）。
 * - **备份**：整机复原。导出 → 彻底卸载 → 重装 → 还原，结果是「跟没卸载之前一样」。
 *   所以是整文件替换，`config.json` 里每一个字段（含界面偏好）都要回来。
 *
 * 两套语义不能混：混在一起要么让导入敢于覆盖用户现有配置，要么让备份永远缺一块。
 *
 * ## 界面上的几条硬取舍
 *
 * - **密钥是明文放进包里的**，没有口令这一步。这是明确的取舍：口令最真实的失败模式不是被破解，
 *   而是用户忘了口令 —— 那等于把一个能恢复的东西变成不能恢复的，与"卸载重装后一模一样"直接冲突。
 *   代价是包要当密钥文件对待，所以界面上那句警告必须常驻、不能折叠。
 * - **仍然要先 `inspect` 探包**：不是为了问口令，而是让用户看清里面有什么、多大、含不含密钥，
 *   再决定要不要覆盖。
 * - **覆盖前必须显式确认**：还原会整目录替换现有数据。这条不做成「点了就干再问」，
 *   而是先看目标是否非空，非空就要用户明确点过头。
 */

type Phase = 'idle' | 'inspecting' | 'ready' | 'running' | 'done' | 'error'

interface InspectInfo {
  path: string
  exportedAt: string
  appVersion: string
  platform: string
  files: number
  bytes: number
  hasSecrets: boolean
  excluded: string[]
  symlinks: number
}


/** t() 只接受一个 key，不支持插值。这里的占位符由调用方自己替换。 */
function fill(tpl: string, vars: Record<string, string | number>): string {
  let out = tpl
  for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v))
  return out
}

/**
 * 导出按钮上的文案，按进度阶段分三种。
 *
 * 分段的理由：导出在写 zip 之前要先扫文件、再逐个算 sha256，实测这两段占全流程一半以上
 * （388MB / 2002 文件：扫描 608~896ms + 哈希 3137~4006ms，打包约 2900~4100ms）。
 * 三段文案分开，用户才知道「它在动」而且知道动到哪一步 —— 之前只在打包时显示，
 * 前面几十秒看起来像卡死。
 *
 * `progress === null`（点下去但第一个事件还没到）显示「正在准备…」：
 * 首个事件通常在几毫秒内到，但按钮文字不变也会让人怀疑没点中。
 */
function exportLabel(t: (k: string) => string, progress: ExportProgress | null): string {
  if (!progress) return t('cf.backup.exportPreparing')
  if (progress.step === 'scan') {
    // 扫描阶段 total 恒为 0（总数未知），只报计数，不画百分比
    return fill(t('cf.backup.exportScanning'), { done: progress.done })
  }
  if (progress.step === 'hash') {
    return fill(t('cf.backup.exportHashing'), { done: progress.done, total: progress.total })
  }
  /*
   * `step === 'done'` 是主进程在**写完包之后**发的收尾事件（`backup-ipc.ts:103`，`1/1`）。
   * 不能落到下面那句「正在打包 1/1…」——那一刻已经打完了，会闪一下错误文案。
   * 这里回到按钮的常规文字：紧接着 `doExport` 就会把 `expPhase` 切到 `done` 并显示结果。
   */
  if (progress.step === 'done') return t('cf.backup.exportBtn')
  return fill(t('cf.backup.exporting'), { done: progress.done, total: progress.total })
}

export function BackupPane(): React.JSX.Element {
  const { t } = useI18n()

  // 导出侧
  const [expPhase, setExpPhase] = useState<Phase>('idle')
  const [expMsg, setExpMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [expProgress, setExpProgress] = useState<ExportProgress | null>(null)

  // 还原侧
  const [info, setInfo] = useState<InspectInfo | null>(null)
  const [resPhase, setResPhase] = useState<Phase>('idle')
  /**
   * `notes` 是还原完成后的附加说明（备份路径、降级清单、配置重读失败）。
   * 单列一个数组而不是拼进 `text`：这几条要能逐条读，拼成一段会糊掉。
   */
  const [resMsg, setResMsg] = useState<{
    kind: 'ok' | 'err'
    text: string
    notes?: string[]
  } | null>(null)
  const [resProgress, setResProgress] = useState<{ step: string; done: number; total: number } | null>(null)
  const [needConfirm, setNeedConfirm] = useState(false)

  useEffect(() => {
    const off1 = window.deva.backup.onExportProgress((p) => setExpProgress(p))
    const off2 = window.deva.backup.onRestoreProgress((p) =>
      setResProgress({ step: p.step, done: p.done, total: p.total })
    )
    return () => {
      off1()
      off2()
    }
  }, [])

  async function doExport(): Promise<void> {
    setExpPhase('running')
    setExpMsg(null)
    setExpProgress(null)
    try {
      const r = (await window.deva.backup.export()) as
        | { ok: true; path: string; files: number; bytes: number; hasSecrets: boolean }
        | { ok: false; code: string; message?: string }
      if (r.ok) {
        setExpPhase('done')
        setExpMsg({
          kind: 'ok',
          text: fill(t('cf.backup.exportDone'), { path: r.path })
        })
      } else if (r.code === 'cancel-discard') {
        setExpPhase('idle')
      } else {
        setExpPhase('error')
        setExpMsg({ kind: 'err', text: r.message ?? t('cf.backup.exportFailed') })
      }
    } catch (e) {
      setExpPhase('error')
      setExpMsg({ kind: 'err', text: (e as Error)?.message ?? String(e) })
    } finally {
      setExpProgress(null)
    }
  }

  async function doInspect(): Promise<void> {
    setResPhase('inspecting')
    setResMsg(null)
    setInfo(null)
    setNeedConfirm(false)
    try {
      const r = await window.deva.backup.inspect()
      if (!r.ok) {
        if (r.code === 'cancel-discard') {
          setResPhase('idle')
          return
        }
        setResPhase('error')
        setResMsg({ kind: 'err', text: r.message ?? t('cf.backup.notABundle') })
        return
      }
      setInfo(r)
      setResPhase('ready')
    } catch (e) {
      setResPhase('error')
      setResMsg({ kind: 'err', text: (e as Error)?.message ?? String(e) })
    }
  }

  async function doRestore(): Promise<void> {
    if (!info) return
    setResPhase('running')
    setResMsg(null)
    setResProgress(null)
    try {
      const r = (await window.deva.backup.restore({
        path: info.path,
        overwriteConfirmed: needConfirm
      })) as
        | {
            ok: true
            files: number
            relinked: number
            symlinkAsCopy: string[]
            /*
             * 这两个字段是「比降级更糟」的两类结果，与 symlinkAsCopy 同级重要，所以一并断言出来。
             * 曾经漏在类型里不写、界面也不渲染，等于把「内容没恢复」显示成「还原完成」。
             */
            symlinkUnrecovered?: string[]
            symlinkIncomplete?: Array<{
              path: string
              total: number
              copied: number
              missing: number
              missingDirs?: number
              truncated?: 'too-big' | 'too-many' | 'unreadable'
            }>
            dirsFailed?: string[]
            corruptSecretsBackup?: string
            secrets: { restored: number; absent: boolean; noEncryption?: boolean }
            backupOfPrevious?: string
            excluded: string[]
            needsRestart: boolean
            configReloadError?: string
          }
        | { ok: false; code: string; message?: string }

      if (r.ok) {
        setResPhase('done')
        /*
         * 还原完成后的「细节」必须真的显示出来。
         *
         * 这几个字段（前次备份路径 / 降级成副本的技能 / 链接重建数 / 配置重读失败）
         * 在 `RestoreResult` 里一直有、主进程也一直填，但界面曾经完全没渲染 ——
         * 后果是三条静默失效：想退回时找不到备份在哪；技能已经不再联动外部仓库却以为还连着；
         * 配置重读失败时界面照样说「还原完成」，而用户看到的是旧配置。
         *
         * 所以这里不是「锦上添花的详情」，而是把三类失败从静默变成可见。
         */
        const notes: string[] = []
        if (r.backupOfPrevious) {
          notes.push(fill(t('cf.backup.restoreBackupAt'), { path: r.backupOfPrevious }))
        }
        if (r.relinked > 0) notes.push(fill(t('cf.backup.restoreRelinked'), { n: r.relinked }))
        if (r.symlinkAsCopy.length > 0) {
          notes.push(
            fill(t('cf.backup.restoreDowngraded'), {
              n: r.symlinkAsCopy.length,
              list: r.symlinkAsCopy.join('、')
            })
          )
        }
        if (r.configReloadError) {
          notes.push(
            fill(t('cf.backup.restoreConfigStale'), { msg: r.configReloadError })
          )
        }
        /*
         * 这两条是「比降级成副本更糟」的结果，必须单独说，因为用户看到「还原完成」时
         * 不会自己去猜哪些东西其实没回来：
         *
         * - `symlinkUnrecovered`：目标路径不在、包里也没带内容副本 —— 那些技能/目录**内容没恢复**，
         *   只剩个空目录。与 `symlinkAsCopy`（内容在、只是不再联动外部仓库）不是一回事，
         *   混在一起说就会重演 probe-bundle-junction J2c 抓到的那种谎报。
         * - `corruptSecretsBackup`：旧密钥库读不出来，被改名挪到了别处。不说清它在哪，
         *   用户会以为是凭空丢了密钥，进而以为整个还原出了大问题。
         */
        if (r.symlinkUnrecovered && r.symlinkUnrecovered.length > 0) {
          notes.push(
            fill(t('cf.backup.restoreUnrecovered'), {
              n: r.symlinkUnrecovered.length,
              list: r.symlinkUnrecovered.join('、')
            })
          )
        }
        /*
         * 顺序按严重度：**全在**（不需要管，不单独报）→ **部分** → **全无** → 目录没建回来。
         * 这三态必须能分辨：主进程刻意没把「部分」并进 `symlinkUnrecovered`，
         * 因为那里写的是「N 项内容没恢复」，混进去就是同一句话对应两种状态 = 换个地方继续谎报。
         * 所以这里每项都带上 `missing`/`total`，让用户知道到底缺多少、缺哪个。
         */
        if (r.symlinkIncomplete && r.symlinkIncomplete.length > 0) {
          notes.push(
            fill(t('cf.backup.restoreIncomplete'), {
              n: r.symlinkIncomplete.length,
              list: r.symlinkIncomplete
                .map((it) => `${it.path}（${it.missing}/${it.total}${it.missingDirs ? `，${it.missingDirs} 个目录` : ''}）`)
                .join('、')
            })
          )
          /*
           * `truncated` 是**导出时**就缺了，不是包坏了 —— 这两种结论对用户完全不同
           * （前者要重新导出、后者要怀疑文件传输），所以单独一句说清原因，不塞进上面那条。
           */
          const cut = r.symlinkIncomplete.find((it) => it.truncated)
          if (cut?.truncated) {
            notes.push(fill(t('cf.backup.restoreIncompleteTruncated'), { why: truncatedReason(cut.truncated, t) }))
          }
        }
        if (r.dirsFailed && r.dirsFailed.length > 0) {
          notes.push(
            fill(t('cf.backup.restoreDirsFailed'), { n: r.dirsFailed.length, list: r.dirsFailed.join('、') })
          )
        }
        if (r.corruptSecretsBackup) {
          notes.push(fill(t('cf.backup.restoreCorruptSecrets'), { path: r.corruptSecretsBackup }))
        }
        /*
         * 重启提示按主进程给的 `needsRestart` 决定，而不是无条件写死在文案里。
         * 无条件的后果：将来某次还原不需要重启（比如只补了几个文件），界面还是让用户重启，
         * 属于"狼来了" —— 用户重启几次没用之后就不再看这类提示了。
         */
        if (r.needsRestart) notes.push(t('cf.backup.restoreRestart'))
        setResMsg({
          kind: 'ok',
          text: fill(t('cf.backup.restoreDone'), {
            files: r.files,
            secrets: r.secrets.absent
              ? t('cf.backup.secretsAbsent')
              : r.secrets.noEncryption
                ? t('cf.backup.secretsNoEncryption')
                : fill(t('cf.backup.secretsRestored'), { n: r.secrets.restored })
          }),
          notes
        })
      } else if (r.code === 'cancelled') {
        // 目标非空：不是错误，是需要用户确认
        setResPhase('ready')
        setNeedConfirm(true)
      } else {
        setResPhase('error')
        setResMsg({ kind: 'err', text: r.message ?? t('cf.backup.restoreFailed') })
      }
    } catch (e) {
      setResPhase('error')
      setResMsg({ kind: 'err', text: (e as Error)?.message ?? String(e) })
    } finally {
      setResProgress(null)
    }
  }

  return (
    <div className="cf-backup">
      <h2 className="cf-pane__title">{t('cf.backup.title')}</h2>
      <p className="cf-pane__desc">{t('cf.backup.intro')}</p>

      <section className="cf-set">
        {/* ───────── 导出 ───────── */}
        <div className="cf-set__row">
          <span className="cf-set__label">
            {t('cf.backup.exportTitle')}
            <span className="cf-set__hint">{t('cf.backup.exportDesc')}</span>
          </span>
          <span className="cf-backup__acts">
            {/*
             * 密钥明文：原来是整段警告框。用户确认改成一行提示 —— 常驻、不折叠，
             * 信息量却只有「密钥明文」四个字，正是这条取舍需要让人记住的全部。
             * 用 .cf-setrow__note--warn（11px 橙字）而不是 .cf-badge：后者 10.5px 带全圆边框，
             * 和 30px 按钮并排会显碎；--warn 是设置行里既有的风险提示写法。
             */}
            <span className="cf-setrow__note cf-setrow__note--warn">{t('cf.backup.plainWarning')}</span>
            <button
              className="btn btn--primary"
              onClick={() => void doExport()}
              disabled={expPhase === 'running'}
            >
              {expPhase === 'running' ? <Loader2 size={14} className="cf-spin" /> : <Download size={14} />}
              {expPhase === 'running' ? exportLabel(t, expProgress) : t('cf.backup.exportBtn')}
            </button>
          </span>
        </div>

        {expMsg && (
          <div className="cf-set__row">
            <span className={expMsg.kind === 'ok' ? 'cf-backup__ok' : 'cf-backup__err'}>{expMsg.text}</span>
          </div>
        )}

        {/* ───────── 还原 ───────── */}
        <div className="cf-set__row">
          <span className="cf-set__label">
            {t('cf.backup.restoreTitle')}
            <span className="cf-set__hint">{t('cf.backup.restoreDesc')}</span>
          </span>
          <span className="cf-backup__acts">
            <button className="btn" onClick={() => void doInspect()} disabled={resPhase === 'running'}>
              {resPhase === 'inspecting' ? <Loader2 size={14} className="cf-spin" /> : <Upload size={14} />}
              {t('cf.backup.chooseBtn')}
            </button>
          </span>
        </div>

        {info && (
          <div className="cf-set__row cf-backup__inspect">
            <div className="cf-backup__kv">
              <span>{t('cf.backup.kvExportedAt')}</span>
              <b>{new Date(info.exportedAt).toLocaleString()}</b>
            </div>
            <div className="cf-backup__kv">
              <span>{t('cf.backup.kvFiles')}</span>
              <b>
                {info.files}
                {'，'}
                {fmtBytes(info.bytes)}
              </b>
            </div>
            <div className="cf-backup__kv">
              <span>{t('cf.backup.kvAppVersion')}</span>
              <b>
                {info.appVersion} ({info.platform})
              </b>
            </div>
            <div className="cf-backup__kv">
              <span>{t('cf.backup.kvSecrets')}</span>
              <b>{info.hasSecrets ? t('cf.backup.yes') : t('cf.backup.no')}</b>
            </div>
            {info.excluded.length > 0 && (
              <p className="cf-backup__hint">
                {fill(t('cf.backup.excludedNote'), { list: info.excluded.join(', ') })}
              </p>
            )}
          </div>
        )}

        {info?.hasSecrets && (
          <div className="cf-set__row">
            <p className="cf-backup__hint">{t('cf.backup.containsSecrets')}</p>
          </div>
        )}

        {info && (
          <div className="cf-set__row">
            {needConfirm && (
              <span className="cf-setrow__note cf-setrow__note--warn">{t('cf.backup.overwriteWarn')}</span>
            )}
            <span className="cf-backup__acts">
              <button
                className={needConfirm ? 'btn btn--danger btn--sm' : 'btn btn--primary'}
                onClick={() => void doRestore()}
                disabled={resPhase === 'running'}
              >
                {resPhase === 'running' ? <Loader2 size={14} className="cf-spin" /> : <Upload size={14} />}
                {resPhase === 'running' && resProgress
                  ? fill(t('cf.backup.restoring'), {
                      step: resProgress.step,
                      done: resProgress.done,
                      total: resProgress.total
                    })
                  : needConfirm
                    ? t('cf.backup.overwriteConfirmBtn')
                    : t('cf.backup.restoreBtn')}
              </button>
            </span>
          </div>
        )}

        {resMsg && (
          <div className="cf-set__row">
            <span className={resMsg.kind === 'ok' ? 'cf-backup__ok' : 'cf-backup__err'}>{resMsg.text}</span>
          </div>
        )}
        {resMsg?.notes?.map((n) => (
          <div className="cf-set__row" key={n}>
            <p className="cf-backup__hint">{n}</p>
          </div>
        ))}
      </section>
    </div>
  )
}

/**
 * `ManifestLinkTree.truncated` 的书面原因。
 *
 * 为什么要区分：三种都属于「导出时就没收全」，但用户该做的事不同 ——
 * 体积/条数超限要重新导出并挑重点，读不出来要回去看那个目录的权限。
 * 只说「超出上限」会让后一种情况的人一直重试同一个目录。
 */
function truncatedReason(
  why: 'too-big' | 'too-many' | 'unreadable',
  t: (k: string) => string
): string {
  if (why === 'too-big') return t('cf.backup.truncatedTooBig')
  if (why === 'too-many') return t('cf.backup.truncatedTooMany')
  return t('cf.backup.truncatedUnreadable')
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
