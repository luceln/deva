import { existsSync, lstatSync, readlinkSync } from 'fs'
import * as fsp from 'fs/promises'
import { cp, lstat, mkdir, mkdtemp, readdir, rename, rm, symlink, utimes } from 'fs/promises'

import { dirname, join } from 'path'
import {
  LINK_PREFIX,
  MANIFEST_NAME,
  SECRETS_ENC_NAME,
  type BundleManifest,
  type ManifestLinkTree,
  type RestoreProgress,
  type RestoreResult,
  type SecretsRestore
} from '../../shared/bundle-format'
import { hashFile, isSafeEntryPath, validateManifest } from './bundle-manifest'
import { extractTo, listEntriesFast, readEntriesFor } from './bundle-zip'
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
 * 找出「目标里有、但包里没有」的**用户数据**，这些要在还原时删掉。
 *
 * ## 为什么必须删
 *
 * 不删就只是覆盖写入，不是替换。重装后应用会先生成一份种子数据（内置角色 `deva.md`/`lucy.md`、
 * 默认技能等），还原时再把包里的写上去 —— 用户看到的是「卸载前 + 一份新的」，不是卸载前那样。
 * 验收实测：包里 4 个文件，还原后目录 7 个。
 *
 * ## 为什么不能整个目录 rm -rf
 *
 * `home` 下有些东西**不属于备份范围，也不能删**：
 *  - `worktrees/`：用户的工作区代码。删了就是删用户源码，绝对不行。
 *  - `.magpie-agent*.json`：外部插件的状态，本应用只读，删了会让插件认不出自己写过的登记。
 *  - `*.tmp` / `*.bad-*`：正在写的中间态，删了可能打断别的进程。
 *
 * 所以走「遍历 → 逐个判断」而不是一删了之。判断依据是**顶层目录白名单**：只清理备份明确
 * 覆盖的那些顶层项，其余一律不碰。新增顶层数据目录时要记得同步这张表 —— 漏了的表现是
 * 「那类数据还原后会残留旧文件」，而不是报错。
 */
const RESTORE_SCOPE = new Set([
  'data',
  'personas',
  'projects',
  'skills',
  'uploads',
  'profile'
])

/** 备份覆盖的**单文件**（在 home 根上）。同样只清理这些，别的根文件不动。 */
const RESTORE_SCOPE_FILES = new Set([
  'config.json',
  'secrets.json',
  'memory.json',
  'mcp.json',
  'tasks.json',
  'read-state.json',
  'worktrees.json'
])

/**
 * 把 staging 里 `links/<链接路径>/…` 那份内容副本落到目标目录。
 *
 * 返回**逐条如实**的结果：搬成多少、哪些没搬成、为什么。绝不只返回一个计数 ——
 * 只返回 `copied` 时，调用方无法区分「25 个全搬成」和「搬成 5 个、20 个失败」，
 * 于是后者会被报成「已降级为副本」，剩下 20 个静默消失。这与 `J2c` 抓的
 * 「建出空目录却报告成功」是同一个病，只是门槛从 0 抬到了 1。
 *
 * 为什么不回滚已成功的部分（整条判失败、删掉重来）：`cp` 已经落地的文件是有效内容，
 * 删掉只会让用户从「缺 20 个」变成「缺 25 个」。如实报缺多少，比追求状态干净有用。
 *
 * 为什么按 `tree.files` 逐条搬而不是 `cp(recursive)`：
 *  - `cp` 会把 staging 里**不该存在**的东西也带过去（这部分目录是解压出来的，不是原样副本）；
 *  - 逐条走才能顺手把空目录按 `tree.dirs` 建出来，且能逐条记失败。
 */
async function copyLinkTreeFromStage(
  fromDir: string,
  dstDir: string,
  tree: ManifestLinkTree
): Promise<{ copied: number; failed: string[]; dirFailed: string[] }> {
  let copied = 0
  const failed: string[] = []
  const dirFailed: string[] = []
  try {
    await mkdir(dstDir, { recursive: true })
  } catch (e) {
    /*
     * 连目标目录都建不出来 → 这一条全废。返回 0 条 + 全部标失败，
     * 让调用方走「未恢复」而不是「已降级为副本」。
     */
    return { copied: 0, failed: tree.files.map((f) => f.path), dirFailed: [...(tree.dirs ?? [])] }
  }
  for (const rel of tree.dirs ?? []) {
    /*
     * 链接目标里的空目录建不出来 → 也算「这条副本不完整」。
     *
     * 不静默：空目录本身不影响技能可用（靠 SKILL.md 是否可读来判），但建失败通常意味着
     * 目标上有东西占位或没权限 —— 那下一条文件也很可能建不出来。记进 `dirFailed`
     * 让调用方如实报「不完整」，而不是当它不存在。
     *
     * 与 `failed`（文件）分开记：`missing` 的语义是「缺多少个文件」，
     * 目录混进去会让那个数字对不上用户实际看到缺的文件数。
     */
    try {
      await mkdir(join(dstDir, rel), { recursive: true })
    } catch {
      dirFailed.push(rel)
    }
  }
  for (const f of tree.files) {
    const src = join(fromDir, f.path)
    const dst = join(dstDir, f.path)
    /*
     * staging 里没有这个条目 → 记失败，**不 continue**。
     *
     * 什么时候会缺：包里没解出来（旧包没带 `links`、解压跳过了不认识的条目）。
     * 以前这里直接跳过，等于把「包里缺」伪装成「本来就少一条」——同一条 M1 纪律。
     */
    if (!existsSync(src)) {
      failed.push(f.path)
      continue
    }
    try {
      await mkdir(dirname(dst), { recursive: true })
      await cp(src, dst, { force: true })
      copied += 1
    } catch {
      // 单条搬不动（权限 / 占用 / 磁盘满）：跳过这一条，但**必须记下来**
      failed.push(f.path)
    }
  }
  return { copied, failed, dirFailed }
}

/**
 * 旧密钥库读不出来时，把它改名挪走，为即将写入的新密钥库腾位置。
 *
 * 返回挪走后的文件名（没挪 = undefined）。**只在确实"读不出来"时动手**：
 * 文件不存在（absent）、或内容能解析（ok）都不该被碰 —— 后者马上会被 `replaceAllSecrets` 整份替换。
 *
 * 判定复用 `secrets.ts` 的同一套口径（`readSecretKind`），不在这里另写一份 JSON.parse 判据：
 * 两处判据一旦漂移，就会出现"这里认为能读、那里认为坏了"的死局，正是这次要修的东西。
 */
async function quarantineCorruptSecrets(home: string): Promise<string | undefined> {
  const file = join(home, 'secrets.json')
  if (!existsSync(file)) return undefined
  const kind = await readSecretKind(file)
  if (kind !== 'corrupt') return undefined
  const moved = `${file}.bad-${Date.now()}`
  try {
    await rename(file, moved)
    return moved
  } catch (e) {
    /*
     * 挪不动（被占用 / 无权限）→ **中止还原**，把失败前移到替换之前。
     *
     * 这一步之后马上就写密钥；挪不走就意味着 `replaceAllSecrets` 会被 corrupt 判据挡住，
     * 那时用户数据已经替换完 —— 那是最糟的"报失败但已改一半"。宁可现在失败，什么都没动。
     */
    throw new RestoreError(
      'write-failed',
      `旧密钥库读不出来，且无法移开它（${(e as Error)?.message ?? e}）。为免替换到一半失败，已中止，用户数据未改动。`
    )
  }
}

/**
 * 读盘判断密钥库现状：不存在 / 能解析 / 读不出来。
 *
 * 与 `secrets.ts:ensureLoaded()` 的判据保持一致（ENOENT = absent，解析失败 = corrupt）。
 */
async function readSecretKind(file: string): Promise<'absent' | 'ok' | 'corrupt'> {
  let raw: string
  try {
    raw = await fsp.readFile(file, 'utf8')
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'absent' : 'corrupt'
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? 'ok' : 'corrupt'
  } catch {
    return 'corrupt'
  }
}

async function findStaleEntries(home: string, keep: Set<string>): Promise<string[]> {
  const stale: string[] = []
  let tops: string[]
  try {
    tops = await readdir(home)
  } catch {
    return stale
  }

  const walk = async (relDir: string): Promise<void> => {
    let ents
    try {
      ents = await readdir(join(home, relDir), { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of ents) {
      const rel = `${relDir}/${ent.name}`
      if (keep.has(rel)) {
        // 目录在包里也有子项：继续往下比，别整棵跳过
        if (ent.isDirectory() && !ent.isSymbolicLink()) await walk(rel)
        continue
      }
      if (ent.isDirectory() && !ent.isSymbolicLink()) {
        /*
         * 目录本身不在清单里（清单只列文件），要看它**子树**里有没有包内条目：
         * 有就继续下潜，没有才整棵算残留。
         *
         * 注意 `keep` 里既有文件条目也有目录条目（调用方把 `manifest.dirs` 也并了进去），
         * 所以「包里声明的空目录」在上面的 `keep.has(rel)` 分支就被保住了，走不到这里。
         */
        const hasInner = [...keep].some((k) => k.startsWith(`${rel}/`))
        if (hasInner) await walk(rel)
        else stale.push(rel)
        continue
      }
      if (ent.isSymbolicLink()) {
        stale.push(rel)
        continue
      }
      // 文件或链接：上面的 keep 已判过，走到这里就是包里没有
      stale.push(rel)
    }
  }

  for (const top of tops) {
    if (top === 'worktrees') continue // 用户代码，永不删
    if (!RESTORE_SCOPE.has(top) && !RESTORE_SCOPE_FILES.has(top)) continue
    /*
     * 在包里（同名文件，或 `manifest.dirs` 声明的目录）：不整个跳过，取决于它是文件还是目录。
     *
     * 目录必须进去继续清子树 —— 否则「包里有 data/media 这个空目录」会让整个 data/media
     * 底下包外的残留也跟着保住，退回到「只覆盖不替换」（已修的 P0-2）。
     */
    const st = await lstat(join(home, top)).catch(() => null)
    if (!st) continue
    if (st.isDirectory() && !st.isSymbolicLink()) await walk(top)
    else if (!keep.has(top)) stale.push(top)
  }
  return stale
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
  /** 密钥段的原始字节。第 2 步读取时顺带留下，避免第 5 步再解一遍包。 */
  let secretsBuf: Buffer | null = null

  try {
    /*
     * ---- 1. 流式读包：第一遍只收条目名，验 zip slip ----
     *
     * 以前是 `unzipSync` 一把解完整包：600MB 的包峰值 RSS 实测 1872MB（包体积的 3.12 倍）。
     * home 越大越危险，而"导出/还原"恰恰是数据最多时才要用的功能。
     *
     * 现在两遍都流式：
     *   1. `listEntries` 只收名字（数据一个字节都不留），把 zip slip 全部验过；
     *   2. 第 4 步 `extractTo` 边解边写 staging，一个条目写完就释放。
     * 内存峰值从「包体积×3」降到「最大单条目」。
     *
     * 为什么必须先验名再解：部分成功比直接失败更糟 —— 用户会以为还原完成了。
     */
    report('extract', 0, 1)
    /*
     * 用 `listEntriesFast` 只读中央目录 —— 不解压任何数据。
     * 流式的 `listEntries` 遇到不想要的条目仍然会走完 inflate 再丢弃，
     * 600MB 的包光这一遍就白解 600MB（实测在 80MB 包上贡献了约 100MB 峰值）。
     */
    const listed = await listEntriesFast(opts.bundlePath)
    if (!listed) {
      throw new RestoreError('not-a-bundle', '这个文件不是有效的 zip（找不到中央目录），不是本应用导出的备份包')
    }
    const names = listed.names

    for (const name of names) {
      if (!isSafeEntryPath(name)) {
        throw new RestoreError('unsafe-path', `备份包里含不安全的路径：${name}`)
      }
    }
    report('extract', 1, 1)

    // ---- 2. 校验清单 ----
    if (!names.includes(MANIFEST_NAME)) {
      throw new RestoreError('not-a-bundle', '备份包里没有 manifest.json，不是本应用导出的包')
    }
    let manifestRaw: Buffer
    try {
      const small = await readEntriesFor(opts.bundlePath, [MANIFEST_NAME, SECRETS_ENC_NAME])
      const got = small.get(MANIFEST_NAME)
      if (!got) throw new Error('manifest.json 读不出来')
      manifestRaw = got
      secretsBuf = small.get(SECRETS_ENC_NAME) ?? null
    } catch (e) {
      throw new RestoreError('not-a-bundle', `读不出备份包清单：${(e as Error)?.message ?? e}`)
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

    /*
     * 解压 + 逐文件验哈希，同一次流式遍历里做完。
     *
     * 先解到 staging 而不是直接写 home：哈希对不上时要能干净退出，不能留下半套已覆盖的数据。
     */
    const want = new Set(manifest.files.map((f) => `home/${f.path}`))
    /*
     * 符号链接的内容副本也要解出来（`links/<链接路径>/…`）。
     *
     * 只在这一步解、且解到 staging：目标路径存在时根本用不到它（会重建链接），
     * 只有换机降级那一条路才需要。解出来放在 staging 里，用完随 staging 一起清掉。
     */
    for (const tree of manifest.links ?? []) {
      for (const f of tree.files) want.add(`${LINK_PREFIX}${tree.path}/${f.path}`)
    }
    report('verify', 0, manifest.files.length + (manifest.links ?? []).reduce((a, t) => a + t.files.length, 0))
    try {
      await extractTo(opts.bundlePath, staging, want, (done, total) => {
        if (done % 32 === 0 || done === total) report('verify', done, total)
      })
    } catch (e) {
      throw new RestoreError('extract-failed', `解压备份包失败：${(e as Error)?.message ?? e}`)
    }

    // 逐个核对哈希：缺文件与内容不符分开报，用户能据此判断是包坏了还是传输丢了
    for (const f of manifest.files) {
      const abs = join(stageHome, f.path)
      if (!existsSync(abs)) {
        throw new RestoreError('corrupt', `备份包缺少清单里列出的文件：${f.path}`)
      }
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
    }
    /*
     * 链接内容副本同样逐条核对。
     *
     * 缺条目不算致命：旧包本就没有 `links`，或导出时因超限没收全（`truncated`）——
     * 那种情况下 `copyLinkTreeFromStage` 搬不到东西，会如实进 `symlinkUnrecovered`。
     * 但**内容对不上**必须致命：那是包真的坏了，照搬会把坏内容当副本落进用户目录。
     */
    for (const tree of manifest.links ?? []) {
      for (const f of tree.files) {
        const abs = join(staging, LINK_PREFIX, tree.path, f.path)
        if (!existsSync(abs)) continue
        const got = await hashFile(abs)
        if (got !== f.sha256) {
          throw new RestoreError(
            'corrupt',
            `备份包里符号链接内容与清单不符（${tree.path}/${f.path}）：期望 ${f.sha256.slice(
              0,
              12
            )}…，实际 ${got.slice(0, 12)}…。包可能已损坏。`
          )
        }
      }
    }
    report(
      'verify',
      manifest.files.length + (manifest.links ?? []).reduce((a, t) => a + t.files.length, 0),
      manifest.files.length + (manifest.links ?? []).reduce((a, t) => a + t.files.length, 0)
    )

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
    const secretsPlan = await prepareSecrets(secretsBuf, manifest)
    /*
     * 旧密钥库读不出来（用户正是因为旧库坏了才来还原）→ **在这里就把它挪走**。
     *
     * ## 为什么必须在动用户数据之前
     *
     * `replaceAllSecrets` 在 `loadKind === 'corrupt'` 时会拒绝写入（`secrets.ts:236` 的保护：
     * 此刻内存 store 是空的，覆盖会毁掉那份还能救的文件）。而还原流程里 `keepSet` 把
     * `secrets.json` 留在磁盘上 → `resetForRestore()` 清完内存态，下一次 `ensureLoaded()` 又读到
     * 同一个坏文件 → 又判定 corrupt → 又拒绝写入。
     *
     * 于是出现最糟的组合：文件已经替换完、密钥写不进去、还原报失败（`write-failed`），
     * 用户数据**已被改了一半**。`probe-bundle-corrupt.cjs` 的 C1a/C1b 抓的就是这个。
     *
     * 挪走是正确语义而不是绕过校验：还原本来就要整份替换密钥库，坏库没有任何保留价值，
     * 而"用户当前那份新密钥"根本不存在（文件是坏的）。改名成 `.bad-<时间戳>` 而不是删掉：
     * 万一里面其实还有能抢救的片段，用户找得回来；沿用的是项目里既有的坏文件命名约定。
     */
    const corruptBackup = await quarantineCorruptSecrets(home)
    report('secrets', 1, 1)

    // ---- 6. 替换 home 内容 ----
    report('replace', 0, manifest.files.length)

    /*
     * 先删掉目标里「包里没有」的用户文件。
     *
     * 只写不删不算替换，算覆盖。后果是重装后应用生成的种子数据（内置角色、默认技能等）
     * 会和新还原的数据混在一起 —— 用户看到的不是「卸载前的样子」，而是「卸载前 + 一份新的」。
     * 验收实测：包里 4 个文件，还原后目录里有 7 个。
     *
     * 只删用户数据类，保留 base 白名单里的东西（工作区、外部插件状态等），理由见 `shouldRemove`。
     */
    const removedStale: string[] = []
    const keepSet = new Set(manifest.files.map((f) => f.path))
    for (const link of manifest.symlinks) keepSet.add(link.path)
    /*
     * 包里声明要重建的目录也并进 `keepSet`。
     *
     * 清理逻辑只有一套判据（「这个路径在包里吗」），目录和文件在这里是同一种东西：
     * 在包里 = 不当残留。并进来之后，`findStaleEntries` 对它们的处理是「保留目录、继续清子树」，
     * 所以包外的残留文件照样被删，不会退回「只覆盖不替换」。
     *
     * 不并的后果（probe-bundle-edge B1/B2/B3）：源里 `data/media` 恰好是空目录 → 包里没有它的
     * 任何文件条目 → 被判成残留 `rm -rf`，而包里也没有目录条目可重建 → 该目录消失。
     */
    for (const rel of manifest.dirs ?? []) keepSet.add(rel)
    /*
     * `secrets.json` 不在文件清单里（它由密钥段单独负责），但**必须加进 keep**。
     *
     * 否则它会被当成"包里没有的残留"删掉，而密钥段是稍后才写的 —— 中间这段窗口里
     * 密钥库文件是不存在的。虽然最终会被 commitSecrets 写回来，但如果密钥段为空
     * （导出时一条密钥都没有），用户现有的密钥库就白丢了。
     * 加进 keep 后它是"保留原样"，随后被 commitSecrets 整体替换或原样留着，两种都对。
     */
    keepSet.add('secrets.json')
    const stale = await findStaleEntries(home, keepSet)
    for (const rel of stale) {
      await rm(join(home, rel), { recursive: true, force: true }).catch(() => undefined)
      removedStale.push(rel)
    }

    const now = new Date()
    for (let i = 0; i < manifest.files.length; i++) {
      const f = manifest.files[i]
      const dst = join(home, f.path)
      await mkdir(dirname(dst), { recursive: true })
      /*
       * 用 `rename` 而不是 `cp`。
       *
       * staging 就建在 home 的**同级目录**（见上面 `stagingParent` 的选择），所以两者在
       * 同一个卷上，rename 是原子的、不搬字节。换成 cp 等于把整包数据再复制一遍：
       * 80MB 的包实测让峰值 RSS 从「单条目量级」涨到 2.08×，纯属白花。
       *
       * 跨卷时 rename 会抛 EXDEV（例如用户把 DEVA_HOME 指到另一个盘后又改了主意），
       * 那时退回 cp —— 这种边缘情况才值得付复制的代价。
       */
      const src = join(stageHome, f.path)
      try {
        await rename(src, dst)
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === 'EXDEV') {
          await cp(src, dst, { force: true })
        } else {
          throw e
        }
      }
      /*
       * 统一刷 mtime —— 这一步不能省。
       *
       * 三个清扫器全部按 mtime 判过期：checkpoints 30 天（`checkpoints.ts:56-58`）、
       * media 1 小时（`media-store.ts:28`）、subagents 1 小时。
       * `rename` 会**保留源的 mtime**（staging 里那份是解压时写的，时间是对的，但它可能是
       * 旧系统时钟或用户改过系统时间），所以仍然显式刷一遍。
       * 代码里记录过真实事故（`importer-assoc.ts:15-17`）：源数据放了 60 天再导入，
       * 2219 个 checkpoint 在导入后**第一次启动就被全删**。
       */
      await utimes(dst, now, now).catch(() => undefined)
      if (i % 32 === 0) report('replace', i, manifest.files.length)
    }
    report('replace', manifest.files.length, manifest.files.length)

    /*
     * 重建包里声明的空目录。
     *
     * `mkdir({recursive:true})` 是幂等的：目录已被上面某个文件的父目录创建过也不报错。
     * 必须在「清理残留」之后 —— 清理会把它们删掉，这是这次修的 P2（probe-bundle-edge B1/B2/B3）。
     *
     * 失败**进报告**而不是只打日志：`console.warn` 用户在界面上看不见，而那正是这次要修的
     * 「静默失效」—— 用户以为空目录回来了，实际没有。常见原因是同名文件占了位置。
     */
    const dirsFailed: string[] = []
    for (const rel of manifest.dirs ?? []) {
      try {
        await mkdir(join(home, rel), { recursive: true })
      } catch (e) {
        dirsFailed.push(rel)
        console.warn(`[restore] 空目录重建失败：${rel}：${(e as Error)?.message ?? e}`)
      }
    }

    // ---- 7. 重建符号链接 ----
    report('symlinks', 0, manifest.symlinks.length)
    const symlinkAsCopy: string[] = []
    const symlinkUnrecovered: string[] = []
    const symlinkIncomplete: Array<{
      path: string
      total: number
      copied: number
      missing: number
      missingDirs?: number
      truncated?: 'too-big' | 'too-many' | 'unreadable'
    }> = []
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
         *
         * 以前这里从 `stageHome/<link.path>` 拷，而 `scanHome` 对链接**不跟进去收文件**，
         * 那里永远是空的 → 建出一个空目录，报告却说「已降级为副本」（probe-bundle-junction J2c）。
         * 现在内容副本在 `links/<link.path>/…`（见 `ManifestLinkTree`），从那里解。
         */
        const tree = (manifest.links ?? []).find((t) => t.path === link.path)
        const res = tree
          ? await copyLinkTreeFromStage(join(staging, LINK_PREFIX, link.path), dst, tree)
          : { copied: 0, failed: [] as string[], dirFailed: [] as string[] }
        /*
         * 三态上报，**不许把中间态塞进两头**。
         *
         *  - 一条都没落地 → `symlinkUnrecovered`（内容没恢复，用户必须自己去弄）；
         *  - 全落地且导出时没截断 → `symlinkAsCopy`（内容全在，只是不联动外部仓库）；
         *  - 落了但缺一些（搬失败 / staging 缺条目 / 导出时就 truncated）
         *    → `symlinkIncomplete`，如实报缺多少。
         *
         * 以前只有前两态，判据是 `copied > 0`，于是「25 个里搬成 5 个」也报成「已降级为副本」。
         */
        if (res.copied === 0) {
          /*
           * 连一份内容副本都没有（旧包没带 `links`、或导出时超限/目标不可读）：
           * 目录会是空的。这时**不能**只说「已降级为副本」—— 那正是 J2c 抓的谎报。
           * 如实进 `symlinkUnrecovered`，界面据此告警。
           */
          await mkdir(dst, { recursive: true }).catch(() => undefined)
          symlinkUnrecovered.push(link.path)
        } else if (res.failed.length > 0 || res.dirFailed.length > 0 || tree?.truncated) {
          /*
           * 部分成功，或导出时就已截断。
           *
           * `truncated` 必须算进这里：那种情况下 `tree.files` 只是「已知的那部分」，
           * 逐条全搬成功也不代表副本完整（`skippedFiles` 条从未进过包）。
           * 不把它算进来的话，超限的链接会被报成「完整副本」—— 又是一次谎报。
           */
          symlinkIncomplete.push({
            path: link.path,
            total: (tree?.files.length ?? 0) + (tree?.skippedFiles ?? 0),
            copied: res.copied,
            missing: res.failed.length + (tree?.skippedFiles ?? 0),
            ...(res.dirFailed.length ? { missingDirs: res.dirFailed.length } : {}),
            ...(tree?.truncated ? { truncated: tree.truncated } : {})
          })
        } else {
          symlinkAsCopy.push(link.path)
        }
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
      removedStale,
      ...(dirsFailed.length ? { dirsFailed } : {}),
      symlinkAsCopy,
      ...(symlinkUnrecovered.length ? { symlinkUnrecovered } : {}),
      ...(symlinkIncomplete.length ? { symlinkIncomplete } : {}),
      ...(corruptBackup ? { corruptSecretsBackup: corruptBackup } : {}),
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
  enc: Buffer | null,
  manifest: BundleManifest
): Promise<string | null> {
  if (!enc || !manifest.hasSecrets) return null

  const plain = enc.toString('utf8')
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
  /*
   * 先把密钥库的内存态清空重来。
   *
   * 还原已经整目录替换过，旧库不再需要保护；不清的话会撞上 `loadKind === 'corrupt'` 而
   * **拒绝写入**（用户正是因为旧库坏了才来还原，却被"保护旧库"挡住），或者继续读到旧机器的密钥。
   * 详见 `secrets.ts` 的 `resetForRestore`。
   */
  secrets.resetForRestore()
  let restored = 0
  const out: Record<string, string> = {}
  for (const [key, val] of Object.entries(parsed)) {
    if (typeof val !== 'string' || !val) continue
    out[key] = safeStorage.encryptString(val).toString('base64')
    restored += 1
  }
  /*
   * `replaceAllSecrets` 有返回值，**必须看**。
   *
   * 它会在这两种情况下拒绝写入并给出 `{ok:false}`：
   *  - `loadKind === 'corrupt'`（密钥库读不出来，为免覆盖掉还能救的内容）；
   *  - 写盘失败（磁盘满 / 权限）。
   *
   * 以前这里直接忽略返回值，于是写盘失败也会报「已还原 N 条密钥」，用户以为好了，
   * 实际一个都没落地。这跟导入器那边「写盘失败穿上已存在的衣服」是同一个病。
   */
  const written = await secrets.replaceAllSecrets(out)
  if (!written.ok) {
    throw new RestoreError('write-failed', `密钥库写入失败：${written.reason ?? '未知原因'}`)
  }
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
