import { useEffect, useState } from 'react'
import { AlertTriangle, Archive, Download, Loader2, Upload } from 'lucide-react'
import { useI18n } from '../i18n/i18n'

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

export function BackupPane(): React.JSX.Element {
  const { t } = useI18n()

  // 导出侧
  const [expPhase, setExpPhase] = useState<Phase>('idle')
  const [expMsg, setExpMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [expProgress, setExpProgress] = useState<{ done: number; total: number } | null>(null)

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
    const off1 = window.deva.backup.onExportProgress((p) => setExpProgress({ done: p.done, total: p.total }))
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
          text: fill(t('cf.backup.exportDone'), {
            path: r.path,
            files: r.files,
            size: fmtBytes(r.bytes),
            secrets: r.hasSecrets ? t('cf.backup.withSecrets') : t('cf.backup.withoutSecrets')
          })
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
      <p className="cf-backup__intro">{t('cf.backup.intro')}</p>

      {/* ───────── 导出 ───────── */}
      <section className="cf-backup__card">
        <h3 className="cf-backup__h3">
          <Archive size={16} /> {t('cf.backup.exportTitle')}
        </h3>
        <p className="cf-backup__desc">{t('cf.backup.exportDesc')}</p>

        {/*
         * 密钥是**明文**放进包里的，所以这句警告不能省、也不能折叠。
         *
         * 删掉口令输入是一个明确的取舍（用户要求：不想记口令）。省下来的代价必须明说，
         * 否则用户会把包丢进同步盘 / 发给别人 / 随手拷 U 盘 —— 那是明文密钥最常见的外泄路径，
         * 而不是"有人来翻他电脑"。
         */}
        <div className="cf-backup__danger">
          <AlertTriangle size={16} />
          <p>{t('cf.backup.plainWarning')}</p>
        </div>

        <button
          className="cf-btn is-primary"
          onClick={() => void doExport()}
          disabled={expPhase === 'running'}
        >
          {expPhase === 'running' ? <Loader2 size={14} className="cf-spin" /> : <Download size={14} />}
          {expPhase === 'running' && expProgress
            ? fill(t('cf.backup.exporting'), { done: expProgress.done, total: expProgress.total })
            : t('cf.backup.exportBtn')}
        </button>

        {expMsg && (
          <p className={expMsg.kind === 'ok' ? 'cf-backup__ok' : 'cf-backup__err'}>{expMsg.text}</p>
        )}
      </section>

      {/* ───────── 还原 ───────── */}
      <section className="cf-backup__card">
        <h3 className="cf-backup__h3">
          <Upload size={16} /> {t('cf.backup.restoreTitle')}
        </h3>
        <p className="cf-backup__desc">{t('cf.backup.restoreDesc')}</p>

        <button className="cf-btn" onClick={() => void doInspect()} disabled={resPhase === 'running'}>
          {resPhase === 'inspecting' ? <Loader2 size={14} className="cf-spin" /> : <Upload size={14} />}
          {t('cf.backup.chooseBtn')}
        </button>

        {info && (
          <div className="cf-backup__inspect">
            <div className="cf-backup__kv">
              <span>{t('cf.backup.kvExportedAt')}</span>
              <b>{new Date(info.exportedAt).toLocaleString()}</b>
            </div>
            <div className="cf-backup__kv">
              <span>{t('cf.backup.kvFiles')}</span>
              <b>
                {info.files} · {fmtBytes(info.bytes)}
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

        {info?.hasSecrets && <p className="cf-backup__hint">{t('cf.backup.containsSecrets')}</p>}

        {needConfirm && (
          <div className="cf-backup__danger">
            <AlertTriangle size={16} />
            <p>{t('cf.backup.overwriteWarn')}</p>
          </div>
        )}

        {info && (
          <button
            className={needConfirm ? 'cf-btn is-danger' : 'cf-btn is-primary'}
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
        )}

        {resMsg && (
          <p className={resMsg.kind === 'ok' ? 'cf-backup__ok' : 'cf-backup__err'}>{resMsg.text}</p>
        )}
        {resMsg?.notes?.map((n) => (
          <p className="cf-backup__hint" key={n}>
            {n}
          </p>
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
