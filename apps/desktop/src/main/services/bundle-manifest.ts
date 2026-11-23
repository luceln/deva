import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { readdir, lstat, readlink, stat } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'path'
import {
  BUNDLE_FORMAT,
  BUNDLE_SCHEMA_VERSION,
  HOME_PREFIX,
  type BundleManifest,
  type ManifestFile,
  type ManifestLinkTree,
  type SymlinkEntry
} from '../../shared/bundle-format'

/**
 * 备份包的清单与目录扫描。
 *
 * 这一层的职责只有两件：**决定哪些文件进包**、**算出每个文件的内容哈希**。
 * 它不认识「会话」「角色」这些概念，只认路径——因为包里存的就是 home 目录的原样副本，
 * 一旦这里开始按业务语义挑挑拣拣，就会出现「导出的东西和还原的东西不一致」这类最难查的问题。
 */

/**
 * 明确排除的路径（相对 home，正斜杠）。
 *
 * 判断标准只有一条：**重装后能不能自动重建**。
 *  - 能 → 不进包（带进去反而可能把陈旧的派生数据盖到新的真实数据上）；
 *  - 不能 → 必须进包。
 *
 * 逐条说明理由，免得以后有人「顺手」加一条进去：
 *  - `_index.json` / `_index.dirty`：会话索引及其重建标记。`ensureIndex()` 在索引缺失时扫目录重建，
 *    带一份陈旧的索引进去，等于用「导出那天的会话列表」覆盖「还原后的真实文件」，列表会缺项。
 *  - `import.lock`：导入锁。带着它还原，下次启动会以为「另一个窗口正在导入」而拒绝工作。
 *  - `*.tmp` / `*.bad-*`：原子写的中间态、以及解析失败被改名保存的坏文件。都是过程产物。
 *  - `.magpie-agent*.json`：外部插件 magpie 自己的状态（`plugin-managed.ts:67-75` 本应用只读）。
 *    它由插件维护，备份还原不该插手；带过去反而会让插件读到一份别的机器上的登记。
 *  - `secrets.json`：**密钥库，由密钥段（`secrets.enc`）单独负责，不能当普通文件搬。**
 *    盘上这份是本机 `safeStorage` 的密文，绑死当前 Windows 账户的 DPAPI 密钥。原样搬进包里，
 *    重装后解不开 —— 更要命的是它会在替换阶段被写回目标，若这次包里没有密钥段（比如导出时
 *    密钥库为空），用户新填的密钥就被这串解不开的旧密文顶掉，界面上却还显示"已配置"，
 *    实际所有服务商 401。这是验收实测出来的 P0。
 */
const EXCLUDED_EXACT = new Set([
  '_index.json',
  '_index.dirty',
  'import.lock',
  'secrets.json',
  '.magpie-agent.json',
  '.magpie-agent.state.json',
  '.magpie-agent.config-backup.json'
])

/** 排除的用户级前缀 / 后缀判据。 */
function isExcluded(relPath: string): boolean {
  const name = relPath.slice(relPath.lastIndexOf('/') + 1)
  if (EXCLUDED_EXACT.has(name)) return true
  if (name.endsWith('.tmp')) return true
  // 坏文件：`xxx.bad-1712345678901` 这种（parse 失败后被改名保留，供用户抢救）
  if (name.includes('.bad-')) return true
  return false
}

/** 只给用户看的「被排除」摘要。
 *
 * ⚠️ **不要上卷到顶层目录**：以前这里把 `data/chats/_index.json` 归成 `data`，于是导出报告
 * 里写着「data 未导出」，用户看到的第一反应是「我所有会话都没进包」。实际只排除了一个索引文件。
 * 现在按**文件**列（目录级排除也用完整相对路径），报告里就是 `data/chats/_index.json` 这种具体条目。
 *
 * 仍然去重并按字典序排 —— 排除项通常就几条，逐条列出不会撑爆报告；真正会撑爆的是
 * `.magpie-agent*` 之外的整目录排除，但那种情况本来也该让用户看见具体目录名。
 */
export function summarizeExcluded(relPaths: string[]): string[] {
  const out = new Set<string>()
  for (const p of relPaths) out.add(p)
  return [...out].sort()
}

export interface ScanResult {
  files: ManifestFile[]
  symlinks: SymlinkEntry[]
  /** 需要重建的空目录（相对 home，`/` 分隔）。见 `BundleManifest.dirs`。 */
  dirs: string[]
  /** 符号链接目标内容的副本。见 `ManifestLinkTree`。 */
  links: ManifestLinkTree[]
  /** 被排除的相对路径（未归类，直接进清单与报告）。 */
  excluded: string[]
  /** 总字节数。 */
  bytes: number
}

/**
 * 链接目标里不值得带进包的目录名。
 *
 * `skills/` 实际都是**外部 git 仓库**（本机实测 3 个中 2 个有 `.git`，其中一个 `.git` 就有 5.1MB，
 * 占该技能总量的三分之一）。带进包只有坏处：
 *  - 体积白涨，而这份副本的用途只是「目标机没有外部仓库时给模型读」；
 *  - `.git/config` 里可能有远端地址、甚至带凭据的 URL，跟着备份包扩散出去是安全问题。
 *
 * ## 代价（明确接受）
 *
 * 用户把一个**有未提交工作**的 git 仓库链接进 `skills/` 时，这份副本**不完整**：
 * 未提交改动之后的 `.git` 历史、暂存区、分支引用都不会进包，换机降级出来的副本
 * 只是一个「工作区文件的快照」，`git status` / `git log` 在那儿用不了。
 *
 * 判断这可以接受的理由：备份包这条路径的用途是**恢复应用的可用状态**（技能说明能被模型读到），
 * 不是给外部仓库做 git 备份 —— 外部仓库自己有远端，该用 git 自己的方式备份。
 * 真要保住仓库状态，正确做法是把仓库留在原处（同机重装时链接会被原样重建，根本没走到副本这条路）。
 *
 * 只影响链接内容的副本，**不影响 home 本身**（`walk` 不受这条约束）：
 * home 里若真有 `.git`，照常进包。
 */
const LINK_TREE_SKIP_DIRS = new Set(['.git', '.svn', '.hg', 'node_modules'])

/**
 * 单个符号链接最多收多少字节 / 多少个文件进包。
 *
 * ## 为什么要上限
 *
 * `skills/` 下指向外部仓库的链接可能是**一整个仓库**（用户完全可能把 `E:\repo` 整个链进来）。
 * 不设上限时，包体积会随「用户链了什么」不可预期地膨胀 —— 导出前那句「目标盘装不装得下」
 * 就失去了意义。而 skills 的实际用途是给模型读的说明文档，正常体量在 MB 级：
 * 本机三个真实 junction 合计 15.4MB / 331 文件。
 *
 * 超限**不失败**（那会让用户因为一个超大链接完全无法备份），只是不收内容 →
 * 该链接在换机还原时只能降级成空目录，报告里必须说清楚（见 `truncated`）。
 */
const LINK_TREE_MAX_BYTES = 64 * 1024 * 1024
const LINK_TREE_MAX_FILES = 2000

/**
 * 分两阶段扫描：**先只取元数据算容量，再算哈希**。
 *
 * 为什么拆开：hash 要把每个文件完整读一遍。本机 home 约 600MB，那意味着在「用户还没决定存哪」
 * 之前就先读了 600MB；而导出最该先知道的是「目标盘装不装得下」——装不下时前面那几分钟全白烧。
 * 所以 `scanHome` 只做 lstat（不读内容），容量检查通过后才调 `hashFiles` 补哈希。
 */
export async function scanHome(homeDir: string): Promise<ScanResult> {
  const files: ManifestFile[] = []
  const symlinks: SymlinkEntry[] = []
  const dirs: string[] = []
  const links: ManifestLinkTree[] = []
  const excludedRaw: string[] = []
  let bytes = 0

  /**
   * 递归收一个链接目标下的文件与空目录。
   *
   * 与 `walk` 的差别只有两点：不判排除项（链接目标不是本应用的 home，`_index.json` 这类判据不该套过去），
   * 以及遇到超限就整体放弃（不写半份清单 —— 半份会让还原出来的副本残缺却看不出残缺）。
   *
   * 嵌套链接（链接里的链接）**不跟**：那会变成追整棵目录树，且目标机路径更不可预测。只记一层。
   */
  async function collectLinkTree(
    linkRel: string,
    targetAbs: string
  ): Promise<ManifestLinkTree> {
    const tree: ManifestLinkTree = { path: linkRel, files: [], dirs: [] }
    let total = 0
    let count = 0
    let skipped = 0

    const walkTarget = async (absDir: string, relDir: string): Promise<boolean> => {
      let entries
      try {
        entries = await readdir(absDir, { withFileTypes: true })
      } catch {
        // 链接目标读不出来（权限 / 已被删）：不失败，记为不完整，还原时按「没内容」处理
        tree.truncated = 'unreadable'
        return false
      }
      /** 这个目录下有没有「值得保留的东西」（文件 / 子目录），没有就记成空目录。 */
      let kept = false
      for (const ent of entries) {
        const abs = join(absDir, ent.name)
        const rel = relDir ? `${relDir}/${ent.name}` : ent.name
        let st
        try {
          st = await lstat(abs)
        } catch {
          continue
        }
        if (st.isSymbolicLink()) {
          // 嵌套链接不跟、也不记：还原成实体副本时它没有意义，记成空目录更诚实
          continue
        }
        if (st.isDirectory()) {
          if (LINK_TREE_SKIP_DIRS.has(ent.name)) continue
          const sub = await walkTarget(abs, rel)
          if (sub) kept = true
          continue
        }
        if (!st.isFile()) continue
        if (total + st.size > LINK_TREE_MAX_BYTES || count + 1 > LINK_TREE_MAX_FILES) {
          tree.truncated = total + st.size > LINK_TREE_MAX_BYTES ? 'too-big' : 'too-many'
          skipped += 1
          continue
        }
        tree.files.push({ path: rel, size: st.size, sha256: '' })
        total += st.size
        count += 1
        kept = true
      }
      if (!kept && relDir) tree.dirs.push(relDir)
      return kept
    }

    try {
      const st = await lstat(targetAbs)
      if (st.isDirectory()) await walkTarget(targetAbs, '')
      else tree.truncated = 'unreadable'
    } catch {
      // 目标都不存在（导出时链接已经是死链）：只留链接条目，还原时按目标缺失处理
      tree.truncated = 'unreadable'
    }
    if (skipped) tree.skippedFiles = skipped
    return tree
  }

  /** 深度优先。不跟符号链接（lstat 的 isDirectory 对链接恒为 false，天然停在这里）。 */
  async function walk(absDir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(absDir, { withFileTypes: true })
    } catch (e) {
      // 读不出来就整体失败：静默跳过会让用户拿到一份「少了一整个目录」的包，而报告说成功。
      throw new Error(`读取目录失败：${absDir}：${(e as Error)?.message ?? e}`)
    }
    for (const ent of entries) {
      const abs = join(absDir, ent.name)
      const rel = relative(homeDir, abs).split(sep).join('/')
      if (isExcluded(rel)) {
        excludedRaw.push(rel)
        continue
      }
      const st = await lstat(abs)
      if (st.isSymbolicLink()) {
        const target = await readlink(abs)
        symlinks.push({ path: rel, target })
        /*
         * 顺手把目标内容收一份。解析相对链接时以**链接所在目录**为基准——
         * `readlink` 给的是原样字符串，直接 `existsSync` 会按进程 cwd 解析，对相对链接是错的。
         */
        const targetAbs = isAbsolute(target) ? target : resolvePath(dirname(abs), target)
        links.push(await collectLinkTree(rel, targetAbs))
        continue
      }
      if (st.isDirectory()) {
        await walk(abs)
        continue
      }
      if (!st.isFile()) {
        // 设备 / 管道 / socket：不该出现在 home 里，出现了也不该进包
        excludedRaw.push(rel)
        continue
      }
      // sha256 先留空，由 hashFiles 阶段补上
      files.push({ path: rel, size: st.size, sha256: '' })
      bytes += st.size
    }
  }

  await walk(homeDir)
  /*
   * 补收「home 根下 / 各层里完全空的目录」。
   *
   * `walk` 只在有文件时才往 `files` 里加东西，空目录不留痕；而还原时的残留清理会把目标里的
   * 空目录当残留删掉。所以这里从 home 根再走一遍，把**没有任何条目的目录**（递归意义上）记下来。
   *
   * 为什么不在 `walk` 里顺手记：`walk` 遍历到某个目录时还不知道它的子树里最终有没有东西
   * （下面可能全是空目录）。分开一趟做，判据只有「这个目录 readdir 结果为空」一条，简单且不会错。
   */
  const collectEmptyDirs = async (absDir: string): Promise<boolean> => {
    let entries
    try {
      entries = await readdir(absDir, { withFileTypes: true })
    } catch {
      return false
    }
    const real = entries.filter((e) => !isExcluded(relative(homeDir, join(absDir, e.name)).split(sep).join('/')))
    if (!real.length) {
      const rel = relative(homeDir, absDir).split(sep).join('/')
      if (rel) dirs.push(rel)
      return true
    }
    let anyContent = false
    for (const ent of real) {
      const abs = join(absDir, ent.name)
      if (ent.isSymbolicLink()) {
        anyContent = true // 链接本身就是内容（还原时会重建它）
        continue
      }
      if (!ent.isDirectory()) {
        anyContent = true
        continue
      }
      // 子目录整体是空的 → 它自己已被记入 dirs，对父目录来说仍算「没有内容」
      const childEmpty = await collectEmptyDirs(abs)
      if (!childEmpty) anyContent = true
    }
    return !anyContent
  }
  await collectEmptyDirs(homeDir)

  return { files, symlinks, dirs, links, excluded: summarizeExcluded(excludedRaw), bytes }
}

/** 给扫描到的文件补上 sha256（原地修改并返回同一个对象）。 */
export async function hashFiles(homeDir: string, scan: ScanResult, onTick?: () => void): Promise<ScanResult> {
  for (const f of scan.files) {
    f.sha256 = await hashFile(join(homeDir, f.path))
    onTick?.()
  }
  /*
   * 链接目标内容也要算哈希：它在包里是普通文件条目，还原前照样逐条核对。
   *
   * 路径基准是**链接目标**（不是 home）：`scanHome` 收的时候按链接路径记的相对路径，
   * 所以这里要先还原出目标的绝对路径。目标在导出过程中不可读 → 直接抛。
   * 不能静默跳过：那会让包里留下一个没有哈希的文件条目，还原时被判「清单缺文件」。
   */
  for (const tree of scan.links) {
    if (!tree.files.length) continue
    let targetAbs: string
    try {
      targetAbs = await resolveLinkTarget(homeDir, tree.path)
    } catch {
      // 链接在扫描之后被删了：清单里有它的内容条目却读不到源，只能如实失败
      throw new Error(`符号链接在导出过程中消失了：${tree.path}`)
    }
    for (const f of tree.files) {
      f.sha256 = await hashFile(join(targetAbs, f.path))
      onTick?.()
    }
  }
  return scan
}

/** 流式算 sha256：媒体单文件可能几十 MB，一次性 readFileSync 会把内存顶起来。 */
export async function hashFile(absPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    const s = createReadStream(absPath)
    s.on('data', (b) => h.update(b))
    s.on('error', reject)
    s.on('end', () => resolve(h.digest('hex')))
  })
}

/** 组装清单。 */
export function buildManifest(
  scan: ScanResult,
  meta: { appVersion: string; platform: string; hasSecrets: boolean }
): BundleManifest {
  return {
    format: BUNDLE_FORMAT,
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: meta.appVersion,
    platform: meta.platform,
    files: scan.files,
    dirs: scan.dirs,
    symlinks: scan.symlinks,
    links: scan.links,
    excluded: scan.excluded,
    hasSecrets: meta.hasSecrets
  }
}

/**
 * 校验清单是不是本应用的包。
 *
 * 三种都要拒：不是对象 / `format` 不符 / `schemaVersion` 高于本版支持的。
 * 最后一条的方向要看清：**旧包能读（版本低是兼容的），新包不硬读**——比本应用新的包可能带本版不认识的
 * 关键字段，硬读的后果是「还原完成」但一部分内容静默丢失。
 */
export function validateManifest(raw: unknown): { ok: true; manifest: BundleManifest } | { ok: false; reason: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'manifest.json 不是一个对象' }
  }
  const m = raw as Partial<BundleManifest>
  if (m.format !== BUNDLE_FORMAT) {
    return { ok: false, reason: `format 不是 ${BUNDLE_FORMAT}（读到 ${String(m.format)}）` }
  }
  if (typeof m.schemaVersion !== 'number' || !Number.isInteger(m.schemaVersion) || m.schemaVersion < 1) {
    return { ok: false, reason: `schemaVersion 非法（读到 ${String(m.schemaVersion)}）` }
  }
  if (m.schemaVersion > BUNDLE_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: `这个备份包来自更新版本的应用（包 schemaVersion=${m.schemaVersion}，本版最高支持 ${BUNDLE_SCHEMA_VERSION}），请升级应用后再还原`
    }
  }
  if (!Array.isArray(m.files) || !Array.isArray(m.symlinks)) {
    return { ok: false, reason: 'manifest.json 缺少 files / symlinks' }
  }
  return { ok: true, manifest: m as BundleManifest }
}

/**
 * 包内条目路径是否安全。
 *
 * 这一类攻击叫 zip slip：包里的条目写成 `../../Windows/System32/x.dll`，解压时就写到了目标目录之外。
 * 判据要挡住三种：
 *  - 绝对路径（`C:\...`、`/etc/...`、`\\server\share`）；
 *  - 含 `..` 段（`home/../../../x`）；
 *  - 盘符前缀（Windows 上 `C:x` 也算绝对）。
 *
 * 注意不能用 `resolve()` 后再比前缀来判——那对「路径存在不存在的差别」敏感，而这里只需要拒绝可疑写法。
 */
export function isSafeEntryPath(entryPath: string): boolean {
  if (!entryPath) return false
  const p = entryPath.replace(/\\/g, '/')
  if (p.startsWith('/')) return false
  if (/^[a-zA-Z]:/.test(p)) return false
  const segs = p.split('/')
  if (segs.some((s) => s === '..')) return false
  return true
}

/** 包内 home 相对路径 → 包内 zip 条目名。 */
export function toEntryName(relPath: string): string {
  return `${HOME_PREFIX}${relPath}`
}

/**
 * 解出一条符号链接的**目标绝对路径**。
 *
 * 相对链接必须按**链接所在目录**解析，不能按进程 cwd：`readlink` 返回的是原样字符串，
 * `existsSync('..\\x')` 会按 cwd 解析，对相对链接是错的。导出收内容、还原重建链接都要用它，
 * 所以放这里只写一份。
 */
export async function resolveLinkTarget(homeDir: string, linkRel: string): Promise<string> {
  const linkAbs = join(homeDir, linkRel)
  const raw = await readlink(linkAbs)
  return isAbsolute(raw) ? raw : resolvePath(dirname(linkAbs), raw)
}

/** 包内 zip 条目名 → home 相对路径；不是 home 下的条目返回 null。 */
export function fromEntryName(entryName: string): string | null {
  const p = entryName.replace(/\\/g, '/')
  if (!p.startsWith(HOME_PREFIX)) return null
  return p.slice(HOME_PREFIX.length)
}

/** 判断某个 home 目录是否「有用户内容」（决定还原时要不要备份现有数据）。 */
export async function hasUserData(homeDir: string): Promise<boolean> {
  try {
    const st = await stat(homeDir)
    if (!st.isDirectory()) return false
  } catch {
    return false
  }
  // 只看「有没有 data/ 或 personas/ 这类真内容」，不看 config.json：
  // 首次启动会写一份带预置服务商和内置角色的 config，那是种子数据，不代表用户有自己的东西。
  const markers = ['data/chats', 'data/media', 'personas', 'projects', 'skills', 'memory.json', 'tasks.json']
  for (const m of markers) {
    try {
      const s = await stat(join(homeDir, m))
      if (m === 'data/chats' || m === 'data/media' || m === 'personas' || m === 'projects' || m === 'skills') {
        if (!s.isDirectory()) continue
        const list = await readdir(join(homeDir, m))
        if (list.length > 0) return true
      } else if (s.isFile()) {
        return true
      }
    } catch {
      /* 不存在就跳过 */
    }
  }
  return false
}
