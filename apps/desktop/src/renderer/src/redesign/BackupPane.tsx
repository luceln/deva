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
 * - **口令不是可选项的「高级设置」**：只要包里有密钥，就必须输口令。所以先 `inspect` 探包，
 *   拿到 `hasSecrets` 之后才决定显不显示口令框 —— 让用户先输一个可能根本不需要的口令是纯粹的摩擦。
 * - **覆盖前必须显式确认**：还原会整目录替换现有数据。这条不做成「点了就干再问」，
 *   而是先看目标是否非空，非空就要用户明确点过头。
 * - **口令错误要在解压前报**：包可能 600MB，解压完才说「口令不对」等于让用户白等几分钟，
 *   而且那时文件已经写进临时目录了。所以有 `checkPassphrase` 这一步。
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
  const [expPass, setExpPass] = useState('')
  const [expPass2, setExpPass2] = useState('')
  const [expPhase, setExpPhase] = useState<Phase>('idle')
  const [expMsg, setExpMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [expProgress, setExpProgress] = useState<{ done: number; total: number } | null>(null)

  // 还原侧
  const [info, setInfo] = useState<InspectInfo | null>(null)
  const [resPass, setResPass] = useState('')
  const [resPhase, setResPhase] = useState<Phase>('idle')
  const [resMsg, setResMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
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

  const passMismatch = expPass.length > 0 && expPass2.length > 0 && expPass !== expPass2
  const passTooShort = expPass.length > 0 && expPass.length < 8

  async function doExport(): Promise<void> {
    if (passMismatch || passTooShort) return
    setExpPhase('running')
    setExpMsg(null)
    setExpProgress(null)
    try {
      const r = (await window.deva.backup.export({ passphrase: expPass || undefined })) as
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
        setExpPass('')
        setExpPass2('')
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
    // 包里有密钥就必须先校口令：解压完 600MB 才报「口令不对」是纯粹的浪费
    if (info.hasSecrets) {
      if (!resPass.trim()) {
        setResMsg({ kind: 'err', text: t('cf.backup.needPassphrase') })
        return
      }
      setResPhase('running')
      const chk = await window.deva.backup.checkPassphrase(info.path, resPass)
      if (!chk.ok && chk.code === 'bad-passphrase') {
        setResPhase('ready')
        setResMsg({ kind: 'err', text: t('cf.backup.badPassphrase') })
        return
      }
    }

    setResPhase('running')
    setResMsg(null)
    setResProgress(null)
    try {
      const r = (await window.deva.backup.restore({
        path: info.path,
        passphrase: resPass || undefined,
        overwriteConfirmed: needConfirm
      })) as
        | {
            ok: true
            files: number
            relinked: number
            symlinkAsCopy: string[]
            secrets: { restored: number; absent: boolean; noEncryption?: boolean }
            backupOfPrevious?: string
            excluded: string[]
            needsRestart: boolean
            configReloadError?: string
          }
        | { ok: false; code: string; message?: string }

      if (r.ok) {
        setResPhase('done')
        setResMsg({
          kind: 'ok',
          text: fill(t('cf.backup.restoreDone'), {
            files: r.files,
            secrets: r.secrets.absent
              ? t('cf.backup.secretsAbsent')
              : r.secrets.noEncryption
                ? t('cf.backup.secretsNoEncryption')
                : fill(t('cf.backup.secretsRestored'), { n: r.secrets.restored })
          })
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

        <label className="cf-backup__label">{t('cf.backup.passphraseLabel')}</label>
        <input
          type="password"
          className="cf-input"
          value={expPass}
          placeholder={t('cf.backup.passphrasePlaceholder')}
          onChange={(e) => setExpPass(e.target.value)}
          disabled={expPhase === 'running'}
        />
        <input
          type="password"
          className="cf-input"
          value={expPass2}
          placeholder={t('cf.backup.passphraseConfirm')}
          onChange={(e) => setExpPass2(e.target.value)}
          disabled={expPhase === 'running'}
        />
        {passTooShort && <p className="cf-backup__warn">{t('cf.backup.passTooShort')}</p>}
        {passMismatch && <p className="cf-backup__warn">{t('cf.backup.passMismatch')}</p>}
        <p className="cf-backup__hint">{t('cf.backup.passphraseHint')}</p>

        <button
          className="cf-btn is-primary"
          onClick={() => void doExport()}
          disabled={expPhase === 'running' || passMismatch || passTooShort}
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

        {info?.hasSecrets && (
          <>
            <label className="cf-backup__label">{t('cf.backup.restorePassLabel')}</label>
            <input
              type="password"
              className="cf-input"
              value={resPass}
              placeholder={t('cf.backup.restorePassPlaceholder')}
              onChange={(e) => setResPass(e.target.value)}
              disabled={resPhase === 'running'}
            />
          </>
        )}

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

        {resMsg && <p className={resMsg.kind === 'ok' ? 'cf-backup__ok' : 'cf-backup__err'}>{resMsg.text}</p>}
      </section>
    </div>
  )
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
