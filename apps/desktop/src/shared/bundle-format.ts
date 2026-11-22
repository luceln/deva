/**
 * 备份包的格式常量与共享类型（主进程 / renderer / preload 三方共用）。
 *
 * 定位：这是**整机复原**用的包，不是「从原版同步补缺」。两者是不同的问题：
 *  - `import:*`（`shared/import-protocol.ts`）解决「第一次用 DevaPlus，把原版 ~/.deva 的东西搬过来」，
 *    设计目标是别从零开始，所以只补缺、不覆盖，且**刻意不导界面偏好**；
 *  - `backup:*`（本文件）解决「导出一份 → 彻底卸载 → 重装 → 一模一样」，
 *    所以是**整文件复原**：config.json 整份替换，界面偏好也带，一个字段都不留。
 *
 * 为什么类型放 shared：导出进度、还原报告都要逐条显示给用户；这些结构若在主进程 / preload / 渲染层
 * 各写一份，改一处就会漂。
 */

/**
 * 包格式标识。读取时**必须**校验它：扩展名对不上、zip 能解开但结构不是我们的，都不许硬读。
 * 一个用户把别的应用的 zip 当备份包拖进来时，这是唯一能挡住「读了一半才发现不对」的地方。
 */
export const BUNDLE_FORMAT = 'devaplus-backup'

/**
 * 包格式版本。**只做下限校验**（`>= 1` 才读），不做迁移链。
 *
 * 为什么不做迁移链：包里的内容就是 home 目录的原样副本，语义由**各业务模块自己的**版本兼容性决定
 * （`worktrees.json` 有 schemaVersion:1 且 fail-closed，`memory.json` 有 version:2 靠形状判，
 * 会话主档完全没有版本号）。备份层再叠一套迁移，等于把同一件事管两遍，而且两遍的判据会不一致。
 * 这里只负责「这是不是本应用的包」，业务字段的兼容交给写它们的人。
 */
export const BUNDLE_SCHEMA_VERSION = 1

/** 包内清单文件名，固定放在 zip 根目录。 */
export const MANIFEST_NAME = 'manifest.json'

/** 密钥段文件名（口令加密后的密文），固定放在 zip 根目录。 */
export const SECRETS_ENC_NAME = 'secrets.enc'

/**
 * 包内路径前缀：所有 home 内容都在 `home/` 下，清单与密钥段在根。
 *
 * 为什么分一层而不是平铺：解压到临时目录后，`<tmp>/home` 就能**直接当 srcHome 用**
 * （`importer-*` 那套模块全是 `join(srcHome, 'data/chats')` 这种写法），
 * 根目录留给清单和密钥段，不会与用户的 `config.json` / `memory.json` 混在一起。
 */
export const HOME_PREFIX = 'home/'

/**
 * 一条符号链接。**必须单独记**：`skills/` 下常有指向外部仓库的链接（本机实测 4 个技能 3 个是链接）。
 *
 * 只搬内容的话，重装后链接变成实体副本，与原仓库脱钩——用户在外部仓库改的东西不再生效；
 * 只搬链接的话，目标机没那个路径就是死链。所以记下来，还原时按目标是否存在分两条路走。
 */
export interface SymlinkEntry {
  /** 相对 `home/` 的路径，用 `/` 分隔（包内路径一律正斜杠，Windows 也如此）。 */
  path: string
  /** 链接指向的目标（原样记录，可能是绝对路径，也可能是相对路径）。 */
  target: string
}

/** 清单里的一条文件。 */
export interface ManifestFile {
  /** 相对 `home/` 的路径，`/` 分隔。 */
  path: string
  /** 字节数。 */
  size: number
  /** 内容的 sha256（小写 hex）。用于「包是否损坏」的逐文件校验。 */
  sha256: string
}

/**
 * 包内清单。
 *
 * 为什么带 `files[]` 的逐文件哈希：zip 自带 CRC32，但它只能查出「字节坏了」，
 * 查不出「有人在包里塞了 / 删了一个文件」。而备份还原最怕的静默失效是**少了一半东西却报成功**。
 */
export interface BundleManifest {
  format: typeof BUNDLE_FORMAT
  schemaVersion: number
  /** 导出时间（ISO 8601）。只用于展示，不参与任何判定。 */
  exportedAt: string
  /** 导出时的应用版本，用于把「这包是旧版导的」告诉用户。 */
  appVersion: string
  /** 导出时的平台（`process.platform`），换平台还原时提示可能有问题。 */
  platform: string
  /** home 下**实际写进包**的文件清单。 */
  files: ManifestFile[]
  /** home 下的符号链接。 */
  symlinks: SymlinkEntry[]
  /**
   * 本次**明确排除**的路径（相对 home），要写进包里让用户能看见。
   *
   * 不写的代价：用户看到「还原完成」却发现某个目录没回来，只能猜是漏了还是本来就没有。
   */
  excluded: string[]
  /** 密钥段是否存在（有口令才导）。缺省 false。 */
  hasSecrets: boolean
  /** 密钥段用的 KDF 参数。口令派生参数随包存，将来调强度不会让旧包解不开。 */
  secretsKdf?: SecretsKdf
}

/** 口令派生的参数（`scrypt`）。随包存，不在代码里写死。 */
export interface SecretsKdf {
  algo: 'scrypt'
  /** salt（base64）。每次导出都重新随机生成。 */
  salt: string
  /** scrypt 的 N / r / p。 */
  N: number
  r: number
  p: number
  /** 派生出的密钥长度（字节）。 */
  dkLen: number
}

/**
 * 还原进度。步骤名与现有 `ImportProgress` 分开定义：两套步骤名字不同（这里是「解包 / 验签 / 替换 / 重建链接」），
 * 复用一套会逼着两边都接受自己不用的值。
 */
export interface RestoreProgress {
  step:
    | 'extract'
    | 'verify'
    | 'backup-current'
    | 'secrets'
    | 'replace'
    | 'symlinks'
    | 'refresh'
    | 'done'
  done: number
  total: number
}

/** 导出一轮的结果。 */
export type ExportResult =
  | {
      ok: true
      /** 最终落盘的包路径（目标已存在时会改名，所以与调用方给的路径可能不同）。 */
      path: string
      /** 包内文件数（不含清单与密钥段）。 */
      files: number
      /** 包大小（字节）。 */
      bytes: number
      /** 是否含密钥段。 */
      hasSecrets: boolean
      /** 被排除的路径（供界面展示「这些没带」）。 */
      excluded: string[]
    }
  | { ok: false; code: ExportFailCode; message: string }

export type ExportFailCode =
  | 'busy'
  /** 目标路径已存在且无法改名 */
  | 'target-exists'
  /** 写到一半失败，已清理 .part */
  | 'write-failed'
  /** 读 home 时有无权限 / 被占用 */
  | 'read-failed'
  /** 设了口令但本机没有可用加密（无法解出明文再去加密） */
  | 'no-encryption'

/** 还原一轮的结果。 */
export type RestoreResult =
  | {
      ok: true
      /** 还原的文件数。 */
      files: number
      /** 重建为链接的符号链接数。 */
      relinked: number
      /** 目标不存在、降级为实体副本的符号链接（路径列表）。 */
      symlinkAsCopy: string[]
      /** 密钥还原结果。 */
      secrets: SecretsRestore
      /** 覆盖前的自动备份落在哪（目标非空时才有）。 */
      backupOfPrevious?: string
      /** 被排除的路径（包里本来就没有的）。 */
      excluded: string[]
      /** 是否建议重启（内存里还留着旧配置 / 会话缓存）。 */
      needsRestart: boolean
      /** 配置重读失败时的原因（此时必须重启才能真正生效）。 */
      configReloadError?: string
    }
  | { ok: false; code: RestoreFailCode; message: string }

export type RestoreFailCode =
  | 'busy'
  /** 不是本应用的备份包（format / schemaVersion 不符） */
  | 'not-a-bundle'
  /** 包内文件哈希对不上 */
  | 'corrupt'
  /** 解压失败（zip 坏 / 磁盘满） */
  | 'extract-failed'
  /** 条目路径含 `..` 或绝对路径（zip slip） */
  | 'unsafe-path'
  /** 口令错（AEAD 认证失败） */
  | 'bad-passphrase'
  /** 包里没有密钥段 */
  | 'no-secrets'
  /** 目标非空、用户取消 */
  | 'cancelled'
  /** 写目标失败 */
  | 'write-failed'

/** 密钥还原的明细：不能只报一个数字——哪一种失败决定用户要做什么。 */
export interface SecretsRestore {
  /** 成功写入本机密钥库的条数。 */
  restored: number
  /** 包内压根没有密钥段。 */
  absent: boolean
  /** 有密钥段但本机无可用加密存储（Linux 缺 libsecret）。 */
  noEncryption?: boolean
}
