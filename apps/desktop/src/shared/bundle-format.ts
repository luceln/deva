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

/** 密钥段文件名，固定放在 zip 根目录。内容是明文 JSON（还原时重新用 safeStorage 封装）。 */
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
 * 链接目标内容副本的包内前缀：`links/<链接在 home 下的路径>/…`。
 *
 * 与 `home/` 分开的理由见 `ManifestLinkTree`：`home/` 必须与 home 目录逐文件对应（E2b 判据），
 * 备用副本不能混进去。根目录也就不会有第三条前缀与用户文件混淆。
 */
export const LINK_PREFIX = 'links/'

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
 * 一条「符号链接目标内容」的副本。
 *
 * ## 为什么需要它
 *
 * `scanHome` 对链接只记 `.symlink` 条目、**不跟进去收文件**。同机还原时目标路径还在，
 * 重建链接即可，没问题；但**换机还原**（外部仓库不在原路径）会退化成「建一个空目录」——
 * 报告写 `symlinkAsCopy`「已降级为副本」，用户以为内容还在，实际技能整个消失。
 * 探针 `probe-bundle-junction.cjs` 的 J2c、`probe-bundle-edge.cjs` 的 A3 抓的就是这个：
 * 要求降级后 `SKILL.md` 真的能读到。
 *
 * 解法：导出时把链接指向的目录内容**再收一份**进包，存在 `links/<path>/…` 前缀下
 * （**不放进 `home/`**，否则 `verify-bundle-real.cjs` 的 E2b「包内文件数 = home 非链接文件数」
 * 会立刻对不上）。还原时目标存在就照旧重建链接，`links/` 里那份不用；目标不存在才解出来当副本。
 */
export interface ManifestLinkTree {
  /** 链接自身在 `home/` 下的相对路径，`/` 分隔（与 `SymlinkEntry.path` 相同）。 */
  path: string
  /** 该链接目标下收进包的文件（相对**链接路径**，`/` 分隔）。 */
  files: ManifestFile[]
  /** 目标下（含链接自身）需要重建的空目录，相对链接路径。 */
  dirs: string[]
  /**
   * 目标下未能收全的原因（缺省 = 收全了）。
   *
   * ## 它最后会走到哪（还原侧的实际行为）
   *
   *  - **目标路径存在**（同机重装）→ 重建链接，`links/` 里那份副本根本不用。
   *    `truncated` 没有任何影响 —— 链接指向的真实目录还在，内容一条不少。
   *  - **目标路径不存在**（换机）→ 从副本解出实体目录。这时：
   *    - 一条都没解出来 → 进 `RestoreResult.symlinkUnrecovered`；
   *    - 解出来一部分、或 `truncated` 表明本就不全 → 进 `RestoreResult.symlinkIncomplete`，
   *      **绝不进 `symlinkAsCopy`**。
   *
   * 换句话说：`truncated` 的链接**永远不会被报成「完整副本」**。这条在
   * `bundle-import.ts` 的三态分流里守着（`res.failed.length > 0 || tree?.truncated`）。
   */
  truncated?: 'too-big' | 'too-many' | 'unreadable'
  /** 因 `truncated` 而没进包的文件数（仅展示用）。 */
  skippedFiles?: number
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
  /**
   * home 下需要重建的**空目录**（相对 `home/`，`/` 分隔，只记最底层的空目录）。
   *
   * ## 为什么必须记
   *
   * `files` 只列文件，还原时的残留清理（`findStaleEntries`）据此判断「目标里这个目录包里有没有」。
   * 空目录在 `files` 里找不到任何子项 → 被判成残留 `rm -rf` 删掉，而包里也没有目录条目 → 不重建。
   * 结果：源里有 `data/media`、`data/tool-results`、`uploads` 这些空目录，还原后它们不见了
   * （`probe-bundle-edge.cjs` 的 B1/B2/B3）。
   *
   * 缺省（旧包没有这个字段）= 没有要重建的空目录，与改动前行为一致。
   */
  dirs?: string[]
  /** home 下的符号链接。 */
  symlinks: SymlinkEntry[]
  /**
   * 符号链接目标内容的副本（见 `ManifestLinkTree`）。
   *
   * 缺省（旧包）= 只有链接条目、没有内容副本，换机还原时降级只能是空目录，与改动前一致。
   */
  links?: ManifestLinkTree[]
  /**
   * 本次**明确排除**的路径（相对 home），要写进包里让用户能看见。
   *
   * 不写的代价：用户看到「还原完成」却发现某个目录没回来，只能猜是漏了还是本来就没有。
   */
  excluded: string[]
  /**
   * 密钥段是否存在。缺省 false。
   *
   * 密钥段是**明文 JSON**（导出时用 `safeStorage` 解出、还原时再重新封装）。
   * 没有 KDF 参数，因为没有口令 —— 理由见 `bundle-export.ts` 的 `buildSecretsBlob`。
   */
  hasSecrets: boolean
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
  /** 本机没有可用的 safeStorage，读不出密钥明文 */
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
      /**
       * 目标不存在**且包里没有它的内容副本**、只能留个空目录的符号链接。
       *
       * 与 `symlinkAsCopy` 分开的原因：两者对用户的含义完全不同 ——
       * `symlinkAsCopy` 是「内容在，但不再跟外部仓库联动」，这一项是「内容没恢复」。
       * 合成一个字段就会出现 probe-bundle-junction J2c 抓的那种谎报：报告说已降级为副本，
       * 实际目录是空的。
       */
      symlinkUnrecovered?: string[]
      /**
       * 降级成副本、但**副本不完整**的符号链接：只落地了一部分文件。
       *
       * ## 为什么单独一个字段，而不是并入上面两个
       *
       * 这三种状态对用户的含义各不相同，混进同一个字段就会重演同一类谎报：
       *  - `symlinkAsCopy`：内容**全在**，只是不再联动外部仓库 → 不用管；
       *  - `symlinkUnrecovered`：内容**一条都没有** → 必须自己去恢复；
       *  - `symlinkIncomplete`（本项）：内容**缺了一部分** → 能用，但要知道缺什么。
       *
       * 曾经 `symlinkAsCopy` 是唯一出口，判据又只是 `copied > 0`，于是「25 个文件里搬成 5 个」
       * 也会被报成「已降级为副本」，剩下 20 个静默消失。门槛从 0 抬到 1 不改变问题的性质。
       *
       * ## 什么时候会出现
       *
       *  - 单条文件搬不动（权限 / 被占用 / 磁盘满）；
       *  - 包里这个条目本来就没解出来（staging 里缺）；
       *  - **导出时就不全**（`ManifestLinkTree.truncated`：超 64MB / 2000 文件，或目标读不出来）。
       *    这种情况即使逐条都搬成功，副本也是残缺的，同样进这个字段。
       */
      symlinkIncomplete?: Array<{
        /** 链接在 home 下的相对路径。 */
        path: string
        /** 应当有的文件数（`ManifestLinkTree.files` 的长度 + `truncated` 时已知漏掉的数）。 */
        total: number
        /** 实际落地并核对通过的文件数。 */
        copied: number
        /** 没能恢复的文件数（`total - copied`，另加 `truncated` 时**未知**的那部分不计入）。 */
        missing: number
        /** 连空目录都建不出来的个数（文件全搬成但目录缺了，也属于不完整）。 */
        missingDirs?: number
        /** 导出时就已截断时的原因（此时 missing 只是「已知」的那部分）。 */
        truncated?: 'too-big' | 'too-many' | 'unreadable'
      }>
      /** 被删掉的目标残留（包里有、目标多出来的用户数据）。不报出来用户不知道少了什么。 */
      removedStale: string[]
      /**
       * 包里声明、但**重建失败**的空目录（相对 home 的路径）。
       *
       * 与 `removedStale` 分开：那个是「清掉了多余的东西」（正常），这个是「该建没建成」（异常）。
       * 不报的话用户以为目录回来了 —— 常见原因是同名文件占了位置。
       */
      dirsFailed?: string[]
      /** 密钥还原结果。 */
      secrets: SecretsRestore
      /** 覆盖前的自动备份落在哪（目标非空时才有）。 */
      backupOfPrevious?: string
      /**
       * 旧密钥库读不出来、被改名挪到这里的路径。
       *
       * 出现它就说明「用户原来的密钥库是坏的」—— 那份坏文件被保留下来供抢救，
       * 而不是在替换过程中被整份覆盖掉。用户该知道它去了哪。
       */
      corruptSecretsBackup?: string
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
