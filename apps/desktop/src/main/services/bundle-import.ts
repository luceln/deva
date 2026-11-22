import { existsSync, lstatSync, readlinkSync } from 'fs'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'fs/promises'

import { dirname, join } from 'path'
import { unzipSync } from 'fflate'
import {
  MANIFEST_NAME,
  SECRETS_ENC_NAME,
  type BundleManifest,
  type RestoreProgress,
  type RestoreResult,
  type SecretsRestore
} from '../../shared/bundle-format'
import { hashFile, isSafeEntryPath, validateManifest } from './bundle-manifest'
import { getDevaHome, reloadConfigFromDisk } from './config'
import { invalidateIndexOnly } from './chat-store'


/**
 * 复制整个目录，**保留符号链接本身而不是跟随它**。
 *
 * 为什么不直接用 `cp({recursive:true})`：Windows 上遇到 junction 会抛
 * `EPERM: operation not permitted, symlink`（Node 在 recursive cp 里重建链接需要
 * SeCreateSymbolicLinkPrivilege，普通用户没有）。而本机 `skills/` 里 4 个技能有 3 个是指向
 * 外部仓库的 junction —— 也就是说这个失败不是边缘情况，是**默认路径**。
 *
 * 更糟的是它发生在"覆盖前备份"这一步：备份失败就中止还原，于是任何带 junction 的 home
 * 都无法还原。这条是被 `verify-bundle-real.cjs` 的 E11 抓出来的。
 *
 * 做法：逐条走，遇到链接就重建链接（读 target 写 link），遇到普通文件才 copyFile。
 * 这样既绕开 EPERM，也保证备份里记的是"链接"而不是"链接指向的那棵大树"。
 */
async function cpPreservingLinks(src: string, dst: string): Promise<void> {
  const st = lstatSync(src)
  if (st.isSymbolicLink()) {
    const target = readlinkSync(src)
    await mkdir(dirname(dst), { recursive: true })
    // 目标已存在就复用它：`symlink` 不像 `cp` 会覆盖，重复会在 EEXIST 上炸
    await rm(dst, { force: true }).catch(() => undefined)
    await symlink(target, dst, process.platform === 'win32' ? 'junction' : 'dir')
    return
  }
  if (st.isDirectory()) {
    await mkdir(dst, { recursive: true })
    for (const ent of await readdir(src)) {
      await cpPreservingLinks(join(src, ent), join(dst, ent))
    }
    return
  }
  await mkdir(dirname(dst), { recursive: true })
  await cp(src, dst, { force: true })
}

/**
 * 从备份包还原。
 *
 * ## 为什么整文件替换，而不复用 importer
 *
 * 现有 `importer-*` 那套的目标是「从原版同步补缺」：按 id 只增不改、刻意不导界面偏好
 * （`importer-config.ts:21-22` 的理由是「搬过去会让用户觉得窗口大小自己变了」）。
 * 那在「第一次用」的语境下是对的，在「卸载重装要一模一样」的语境下是错的 ——
 * 用户要的就是窗口大小也回来。两套需求混在一起会把两个都弄坏，所以这里另开一条路径。
 *
 * ## 安全与可恢复底线
 *
 * 1. **zip slip**：条目路径含 `..` / 绝对路径 / 盘符前缀 → 整体拒绝，不解压任何字节；
 * 2. **逐文件哈希**：清单里的 sha256 必须与实际内容一致，否则报「包已损坏」；
 * 3. **覆盖前自动备份**：目标非空时先拷一份现有 home 出去，用户还有退路；
 * 4. **临时目录必须清理**：成功与异常路径都要删（`finally`）。
 */

export interface RestoreOptions {
  bundlePath: string
  /** 目标非空时是否继续（界面已确认）。 */
  overwriteConfirmed?: boolean
  onProgress?: (p: RestoreProgress) => void
}

/** 还原失败时抛出的分类错误，供外层翻成 `RestoreFailCode`。 */
export class RestoreError extends Error {
  constructor(
    readonly code: 'not-a-bundle' | 'corrupt' | 'extract-failed' | 'unsafe-path' | 'cancelled' | 'write-failed',
    message: string
  ) {
    super(message)
    this.name = 'RestoreError'
  }
}

export async function restoreBundle(opts: RestoreOptions): Promise<RestoreResult> {
  const home = getDevaHome()
  const report = (step: RestoreProgress['step'], done: number, total: number): void =>
    opts.onProgress?.({ step, done, total })

  /*
   * 临时目录建在 **home 的同级**，不是 os.tmpdir()。
   * 理由：最后要把文件搬进 home，跨盘搬运会慢得多（网络盘 / 移动硬盘作为 DEVA_HOME 时尤其明显）。
   * 同时也避免系统盘被临时占掉 600MB。
   */
  const stagingParent = dirname(home)
  let staging = ''

  try {
    // ---- 1. 读包并解压到内存 ----
    //
    // 这里用 unzipSync 而不是流式：包可能 600MB，全读进内存确实重。
    // 但解压后**立刻**逐文件落盘并释放，且 fflate 的 sync 版对 600MB 的量级在桌面端可接受（约 1-2 秒）。
    // 换取的是「解压前就能校验全部条目名」这个能力 —— 流式解压时条目是一个个来的，
    // 发现 zip slip 时前面的字节可能已经写进磁盘了。
    report('extract', 0, 1)
    let zipBuf: Buffer
    try {
      zipBuf = await readFile(opts.bundlePath)
    } catch (e) {
      throw new RestoreError('extract-failed', `读不出备份包：${(e as Error)?.message ?? e}`)
    }

    let entries: Record<string, Uint8Array>
    try {
      entries = unzipSync(new Uint8Array(zipBuf))
    } catch (e) {
      throw new RestoreError(
        'not-a-bundle',
        `这个文件不是有效的备份包（解压失败）：${(e as Error)?.message ?? e}`
      )
    }

    /*
     * 写任何文件之前先把所有条目名校验一遍。
     * 不做「安全的先解、不安全的跳过」—— 那种部分成功比直接失败更糟，用户会以为还原完成了。
     */
    for (const name of Object.keys(entries)) {
      if (!isSafeEntryPath(name)) {
        throw new RestoreError('unsafe-path', `备份包里含不安全的路径：${name}`)
      }
    }
    report('extract', 1, 1)

    // ---- 2. 校验清单 ----
    const manifestRaw = entries[MANIFEST_NAME]
    if (!manifestRaw) {
      throw new RestoreError('not-a-bundle', '备份包里没有 manifest.json，不是本应用导出的包')
    }
    let manifest: BundleManifest
    try {
      const parsed = validateManifest(JSON.parse(Buffer.from(manifestRaw).toString('utf8')))
      if (!parsed.ok) throw new RestoreError('not-a-bundle', parsed.reason)
      manifest = parsed.manifest
    } catch (e) {
      if (e instanceof RestoreError) throw e
      throw new RestoreError('not-a-bundle', `manifest.json 解析失败：${(e as Error)?.message ?? e}`)
    }

    // ---- 3. 目标非空 → 确认 + 备份现有数据 ----
    const nonEmpty = await hasAnyUserData(home)
    let previousBackup: string | undefined
    if (nonEmpty) {
      if (!opts.overwriteConfirmed) {
        throw new RestoreError('cancelled', '目标数据目录里已有内容，需要确认后才能覆盖。')
      }
      report('backup-current', 0, 1)
      previousBackup = `${home}-restore-backup-${stamp()}`
      try {
        await cpPreservingLinks(home, previousBackup)
      } catch (e) {
        // 备份失败就不能动目标 —— 没有退路的覆盖绝不该做
        throw new RestoreError('write-failed', `覆盖前备份现有数据失败，已中止：${(e as Error)?.message ?? e}`)
      }
      report('backup-current', 1, 1)
    }

    // ---- 4. 落盘 + 逐文件验哈希 ----
    await mkdir(stagingParent, { recursive: true })
    staging = await mkdtemp(join(stagingParent, '.deva-plus-restore-'))
    const stageHome = join(staging, 'home')
    await mkdir(stageHome, { recursive: true })

    report('verify', 0, manifest.files.length)
    for (let i = 0; i < manifest.files.length; i++) {
      const f = manifest.files[i]
      const data = entries[`home/${f.path}`]
      if (!data) {
        throw new RestoreError('corrupt', `备份包缺少清单里列出的文件：${f.path}`)
      }
      const abs = join(stageHome, f.path)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, data)
      const got = await hashFile(abs)
      if (got !== f.sha256) {
        throw new RestoreError(
          'corrupt',
          `备份包内容与清单不符（${f.path}）：期望 ${f.sha256.slice(0, 12)}…，实际 ${got.slice(
            0,
            12
          )}…。包可能已损坏。`
        )
      }
      if (i % 32 === 0) report('verify', i, manifest.files.length)
    }
    report('verify', manifest.files.length, manifest.files.length)

    /*
     * ---- 5. 先解析密钥段，再动目标 ----
     *
     * 顺序不能反。密钥段是唯一"可能坏但还没被发现"的一段：上面的验签只覆盖 `manifest.files`，
     * 而 `secrets.enc` 不在其中（它不是 home 里的文件）。如果先替换文件、后解析密钥，
     * 一旦密钥段坏了，用户的数据**已经被覆盖**，才发现还原失败 —— 那时退路只剩那份自动备份，
     * 而备份本身在磁盘紧张时也可能不完整。
     *
     * 这条是 `verify-bundle-real.cjs` 的 E14 抓出来的。
     */
    report('secrets', 0, 1)
    const secretsPlan = await prepareSecrets(entries, manifest)
    report('secrets', 1, 1)

    // ---- 6. 替换 home 内容 ----
    report('replace', 0, manifest.files.length)
    const now = new Date()
    for (let i = 0; i < manifest.files.length; i++) {
      const f = manifest.files[i]
      const dst = join(home, f.path)
      await mkdir(dirname(dst), { recursive: true })
      await cp(join(stageHome, f.path), dst, { force: true })
      /*
       * 统一刷 mtime —— 这一步不能省。
       *
       * 三个清扫器全部按 mtime 判过期：checkpoints 30 天（`checkpoints.ts:56-58`）、
       * media 1 小时（`media-store.ts:28`）、subagents 1 小时。而 `cp` 会**保留源 mtime**。
       * 代码里记录过真实事故（`importer-assoc.ts:15-17`）：源数据放了 60 天再导入，
       * 2219 个 checkpoint 在导入后**第一次启动就被全删**。
       */
      await utimes(dst, now, now).catch(() => undefined)
      if (i % 32 === 0) report('replace', i, manifest.files.length)
    }
    report('replace', manifest.files.length, manifest.files.length)

    // ---- 7. 重建符号链接 ----
    report('symlinks', 0, manifest.symlinks.length)
    const symlinkAsCopy: string[] = []
    let relinked = 0
    for (const link of manifest.symlinks) {
      const dst = join(home, link.path)
      await rm(dst, { recursive: true, force: true }).catch(() => undefined)
      if (existsSync(link.target)) {
        await mkdir(dirname(dst), { recursive: true })
        await symlink(link.target, dst, process.platform === 'win32' ? 'junction' : 'dir')
        relinked += 1
      } else {
        /*
         * 目标不在 → 降级为实体副本，并**明确报告**（`symlinkAsCopy`）。
         *
         * 不为此让整个还原失败：换台机器还原时，外部仓库路径本来就不存在。
         * 但也不能静默 —— 静默的话用户会以为技能还跟外部仓库联动，实际改外部仓库再也不生效。
         */
        const from = join(stageHome, link.path)
        if (existsSync(from)) await cp(from, dst, { recursive: true, force: true })
        symlinkAsCopy.push(link.path)
      }
    }
    report('symlinks', manifest.symlinks.length, manifest.symlinks.length)

    // ---- 8. 提交密钥（内容已在第 5 步校验过，这里只做重封装与落盘）----
    const secrets = await commitSecrets(secretsPlan)

    // ---- 9. 让索引失效（下次读时重建） ----
    report('refresh', 0, 1)
    /*
     * 只能用 `invalidateIndexOnly()`，**不能用 `invalidateIndex()`**。
     * 后者连 sessionCache 一起清，清掉之后正在跑的那一轮此后所有 `save()` 都会静默 return
     * （`chat-store.ts:607-609` 的 `if (!s) return 'not-saved'`）—— 消息留在内存，进程一退就没了，
     * 界面还显示得好好的。这条坑在导入器那边已踩过并写进了注释（`chat-store.ts:402`）。
     */
    invalidateIndexOnly()
    report('refresh', 1, 1)

    /*
     * 配置也要让内存重新读盘。
     *
     * 上面那一步只处理「会话索引」。而 `config.json` / 角色 / 技能这些是各模块自己的内存态：
     * `config.ts` 的 `ensureLoaded()` 本进程只读一次盘，不重载的话，还原完成后当前窗口里
     * 服务商、当前模型、角色启用态**全是旧的**，用户必须手动重启才看到效果 ——
     * 而界面上明明写着"还原完成"。
     */
    const cfg = reloadConfigFromDisk()
    report('done', 1, 1)

    return {
      ok: true,
      files: manifest.files.length,
      relinked,
      symlinkAsCopy,
      secrets,
      ...(previousBackup ? { backupOfPrevious: previousBackup } : {}),
      excluded: manifest.excluded,
      // 配置重读失败也算要重启：内存里可能还留着旧状态
      needsRestart: true,
      ...(cfg.ok ? {} : { configReloadError: cfg.reason })
    }
  } catch (e) {
    if (e instanceof RestoreError) return { ok: false, code: e.code, message: e.message }
    return { ok: false, code: 'write-failed', message: `还原失败：${(e as Error)?.message ?? e}` }
  } finally {
    /*
     * 清理必须在这里：成功路径留一份 600MB 临时副本会占盘，
     * 异常路径不清理则会随着每次失败不断累积。
     */
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * 第一步：把密钥段读出来并校验格式，**不写任何东西**。
 *
 * 返回明文 JSON 字符串（或 null 表示包里没有密钥）。真正落盘在 `commitSecrets`，
 * 这样"包坏了"能在覆盖用户数据之前就被发现。
 */
async function prepareSecrets(
  entries: Record<string, Uint8Array>,
  manifest: BundleManifest
): Promise<string | null> {
  const enc = entries[SECRETS_ENC_NAME]
  if (!enc || !manifest.hasSecrets) return null

  const plain = Buffer.from(enc).toString('utf8')
  if (!plain.trim()) return null

  try {
    const parsed = JSON.parse(plain) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('密钥段顶层不是对象')
    }
  } catch (e) {
    throw new RestoreError('corrupt', `备份包里的密钥段已损坏：${(e as Error)?.message ?? e}`)
  }
  return plain
}

/**
 * 第二步：用本环境的 safeStorage 重新封装并写入（文件已替换完成之后再调）。
 */
async function commitSecrets(plain: string | null): Promise<SecretsRestore> {
  if (!plain) return { restored: 0, absent: true }
  return reencryptSecrets(plain)
}

/**
 * 用本环境的 safeStorage 重新封装密钥库。
 *
 * ## 为什么必须重封装，而不是解出原文直接落盘
 *
 * 导出侧加密的是**明文密钥库**（`{ providerId: "sk-xxx", ... }`），不是 `safeStorage` 的密文。
 * 所以这里解出来的就是明文，必须逐条用本环境的 `safeStorage.encryptString` 重新加成密文再写盘。
 *
 * 直接写明文是绝对不行的：`secrets.ts:208` 全库只有一条写入路径就是 encryptString，
 * 写入明文会让 `readSecret` 一律走到 `decrypt-failed`，而且是把 API Key 以明文躺在磁盘上。
 */
async function reencryptSecrets(plainJson: string): Promise<SecretsRestore> {
  const { safeStorage } = await import('electron')
  if (!safeStorage.isEncryptionAvailable()) {
    /*
     * 本机没有加密存储（Linux 缺 libsecret / gnome-keyring）。
     *
     * 这时**不能**退化成写明文 —— 那是把用户的全部 API Key 裸露在磁盘上。
     * 报告里明确说「没还原密钥」，让用户自己去设置里重填，并且知道为什么。
     */
    return { restored: 0, absent: false, noEncryption: true }
  }

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(plainJson) as Record<string, unknown>
  } catch {
    // 包里那份明文本身是坏 JSON：不写任何东西，报 0 条。硬写会让密钥库变成不可解析，
    // 下次启动 `loadKind=corrupt`，用户在设置页看到"密钥全没了"。
    return { restored: 0, absent: false }
  }

  const secrets = await import('./secrets')
  let restored = 0
  const out: Record<string, string> = {}
  for (const [key, val] of Object.entries(parsed)) {
    if (typeof val !== 'string' || !val) continue
    out[key] = safeStorage.encryptString(val).toString('base64')
    restored += 1
  }
  await secrets.replaceAllSecrets(out)
  return { restored, absent: false }
}

/** 目标 home 里是否已有用户数据（决定要不要备份 + 确认）。 */
async function hasAnyUserData(home: string): Promise<boolean> {
  const dirs = ['data/chats', 'data/media', 'personas', 'projects', 'skills']
  for (const rel of dirs) {
    try {
      const list = await readdir(join(home, rel))
      // 只有派生索引不算用户数据
      if (list.some((n) => n !== '_index.json' && n !== '_index.dirty')) return true
    } catch {
      /* 不存在就跳过 */
    }
  }
  for (const rel of ['memory.json', 'tasks.json', 'read-state.json', 'worktrees.json']) {
    if (existsSync(join(home, rel))) return true
  }
  return false
}

/**
 * 备份目录后缀：精确到毫秒 + 随机段。
 *
 * 只到秒是不够的 —— 连续两次还原（用户点两下、或自动重试）会落在同一秒，
 * 第二次 `mkdir`/`symlink` 直接撞 `EEXIST`，于是"备份失败 → 中止还原"。
 * 这条是被 `verify-bundle-real.cjs` 连跑三次抓到的。
 */
function stamp(): string {
  const ms = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 17)
  return `${ms}-${Math.random().toString(36).slice(2, 6)}`
}
