import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { readdir, lstat, readlink, stat } from 'fs/promises'
import { join, relative, sep } from 'path'
import {
  BUNDLE_FORMAT,
  BUNDLE_SCHEMA_VERSION,
  HOME_PREFIX,
  type BundleManifest,
  type ManifestFile,
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
 */
const EXCLUDED_EXACT = new Set([
  '_index.json',
  '_index.dirty',
  'import.lock',
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

/** 只给用户看的「被排除」摘要：逐文件列会把报告撑爆，按顶层归类。 */
export function summarizeExcluded(relPaths: string[]): string[] {
  const out = new Set<string>()
  for (const p of relPaths) {
    const top = p.includes('/') ? p.slice(0, p.indexOf('/')) : p
    out.add(top)
  }
  return [...out].sort()
}

export interface ScanResult {
  files: ManifestFile[]
  symlinks: SymlinkEntry[]
  /** 被排除的相对路径（已按顶层归类，用于清单与报告）。 */
  excluded: string[]
  /** 总字节数。 */
  bytes: number
}

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
  const excludedRaw: string[] = []
  let bytes = 0

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
        symlinks.push({ path: rel, target: await readlink(abs) })
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
  return { files, symlinks, excluded: summarizeExcluded(excludedRaw), bytes }
}

/** 给扫描到的文件补上 sha256（原地修改并返回同一个对象）。 */
export async function hashFiles(homeDir: string, scan: ScanResult, onTick?: () => void): Promise<ScanResult> {
  for (const f of scan.files) {
    f.sha256 = await hashFile(join(homeDir, f.path))
    onTick?.()
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
    symlinks: scan.symlinks,
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
