import { copyFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getDevaHome } from './services/config'
import { enablePersonas } from './services/personas'
import { DEFAULT_PERSONAS } from './services/default-personas'
import { inspectTarget } from './importer-target'
import {
  inspectSourceFile,
  readSourceDir,
  sourceFileFailureReason,
  SOURCE_DIR_UNREADABLE,
  writeFailureReason
} from './importer-source-dir'
import type { Failure, StepStat } from '../shared/import-protocol'

/**
 * 导入第 ②/③ 步：角色（`personas/<id>.md` + `personas/avatars/<id>.*`）与启用态。
 *
 * 为什么按文件名（= 角色 id）判存在、已存在整个跳过：角色 id 就是文件名，原样搬过来后会话与定时任务里的
 * personaId 仍然有效，不需要任何映射或重写。已存在就跳过 —— 绝不覆盖本地提示词（用户可能在新应用里改过 general）。
 *
 * ⚠️ **只搬 .md 是不够的**：listPersonas 用 config.json 的 `personas.enabled[id] === true` 决定启用态，键不存在
 * 即停用。文件搬了、角色出现在列表里、却处于停用态，用户在聊天里根本选不到——不报错，只是「角色好像不生效」。
 * 所以第 ③ 步对**本次新导入的** id 置 enabled=true；本地的既有开关一概不动（用户在新应用里禁用的，重导不会重新启用）。
 *
 * ⚠️ **绝不碰 `personas.seeded` / `seededPrompt`**：seeded 是「这套数据目录里已经种过哪些默认角色」的状态位，
 * 跨目录无效。照搬会造出「seeded 说都种过了、磁盘上却没有文件」的目录，默认角色永远补不出来（d95c717 修的就是这个）。
 * 本模块只写 md / 头像 / enabled 三项，seeded 的键集合导入前后必须完全一致。
 *
 * `personas.order`（手动排序）也不搬：它含原版才有的 id，搬来会打乱本地排序；新角色的排序由 personas.ts
 * 自然处理（排在已列出的之后）。
 */

/** 头像扩展名白名单，按优先级排列（与 avatar-image.ts 的查找顺序一致）。 */
const AVATAR_EXTS = ['webp', 'png', 'jpg', 'jpeg'] as const

/**
 * 应用自带默认角色的 id 集合。取自 `DEFAULT_PERSONAS`（种子定义的唯一来源），不在导入器里另写一份 —— 那样
 * 加一个默认角色就会漂移。这些角色在二开版首启就被种进 personas/，原版里同名文件必然存在，不该算「跳过」。
 */
const DEFAULT_PERSONA_IDS = new Set(DEFAULT_PERSONAS.map((p) => p.id))

/** 角色文件名是否合法（与 personas.ts 的 isSafeId 同一规则，防 `..` 与分隔符逃逸）。 */
function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id) && id !== '.' && id !== '..'
}

/** 导入结果：copied/skipped 只含用户自建角色；builtin 是应用自带的默认角色（不计入用户统计）。 */
export interface PersonaImportStat extends StepStat {
  /** 必填（覆盖 StepStat 的可选）：本模块总会填，调用方不必再判空。 */
  builtin: string[]
  /** 必填：真失败（复制出错），与 skipped 严格分开。 */
  failed: Failure[]
  /** 实际写入文件的自带默认角色 id（正常为空；本地缺文件时会被补上，仍需补启用态）。 */
  builtinCopied: string[]
}

/**
 * 把原版角色搬进 DevaPlus。返回本次新导入的自建角色 id（第 ③ 步据此补 enabled）。
 * 头像随角色一起搬：先按扩展名找原版里存在的那份，同名同扩展名复制过去即可（avatar-image.ts 也是按这个顺序找）。
 *
 * 失败与跳过严格分开：`skipped` 只放「已存在」，复制出错放 `failed`（带原因）——否则界面会显示「跳过 N」，
 * 把真失败说成「反正本来就有」，用户永远不知道有角色没进来。
 */
export function importPersonas(srcHome: string): PersonaImportStat {
  const stat: PersonaImportStat = { copied: [], skipped: [], builtin: [], builtinCopied: [], failed: [] }
  const srcDir = join(srcHome, 'personas')
  const dstDir = join(getDevaHome(), 'personas')
  /*
   * 源侧静默第 3 处，注释原文「// 原版没有 personas 目录」—— 那句话本身就在描述 bug：
   * `readdirSync` 抛错不止 ENOENT，`personas` 被同名文件占住（ENOTDIR）、ACL 改坏（EACCES）、
   * 被杀毒锁住（EBUSY）时，源里的角色还在，只是读不出来。当成「没有」→ 报告「角色 0 个、ok:true」，
   * 用户以为原版本来就没有自定义角色。
   */
  const srcList = readSourceDir(srcDir)
  if (srcList.kind === 'unreadable') {
    stat.failed.push({ step: 'personas', id: '<personas>', reason: SOURCE_DIR_UNREADABLE })
    return stat
  }
  if (srcList.kind === 'absent') return stat // 真的没有这个目录：ENOENT
  const names = srcList.names
  try {
    mkdirSync(dstDir, { recursive: true })
  } catch (e) {
    // 建不出目标目录：整步作废。必须记失败——否则报告是「0 新增 0 失败」，看着像「本来就没有角色」
    stat.failed.push({ step: 'personas', id: '<dir>', reason: writeFailureReason(e) })
    return stat
  }

  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const id = name.slice(0, -3)
    if (!isSafeId(id)) {
      // 非法文件名（空格、`..`、超长等）以前被完全静默丢弃，用户不知道有这个文件存在。
      // 记进 skipped 而不是 failed：不是复制出错，是名字不能当 id 用（搬过去也读不到）。
      stat.skipped.push(name)
      continue
    }
    const from = join(srcDir, name)
    const to = join(dstDir, name)
    // 应用自带的默认角色（general / xiaomajiang）：不属于「用户导入」，单独归入 builtin。
    // 文件仍按需补齐（缺失时补上是无害的），但既不进 copied 也不进 skipped —— 用户不该看到
    // 「跳过 2 个」而以为自己有默认角色被忽略。启用态也随种子逻辑走，不由导入负责。
    const builtin = DEFAULT_PERSONA_IDS.has(id)
    if (builtin) stat.builtin.push(id)
    try {
      /*
       * 源侧单文件四态（同 bug 在**文件级**的形状，见 `inspectSourceFile` 的注释）。
       *
       * 以前是 `if (!statSync(from).isFile()) { skipped.push(name); continue }`：`isFile()` 为 false
       * 既有「源数据坏了（目录冒充 .md）」也有「读不出来（EPERM/EBUSY）」，全被压成「跳过」。
       * 验收实测：`ludi-afacec76.md` 换成同名目录 → `ok:true`、`failures:[]`、`skipped:["ludi-afacec76.md"]`，
       * 目标角色 8→7，用户看不出是没导进来。
       *
       *  - `ok`       ：是普通文件，照常往下走（复制 / 四态判目标）；
       *  - `absent`   ：列举之后被删了（TOCTOU）→ 跳过合理，它确实没了；
       *  - `not-file` ：源里那个位置是个目录 → **源数据异常**，记 failed（不是 skipped：skipped 的意思是
       *                 「目标已有 / 不该搬」，而这里源本身坏了，用户必须知道这份数据不会进来）；
       *  - `unreadable`：读不出来 → **不知道**是什么，记 failed（瞬时占用过后重导即可补上）。
       */
      const src = inspectSourceFile(from)
      if (src.kind !== 'ok') {
        if (src.kind === 'absent') {
          if (!builtin) stat.skipped.push(name)
          continue
        }
        const reason = sourceFileFailureReason(src)
        if (reason) stat.failed.push({ step: 'personas', id: name, reason })
        continue
      }
      /*
       * 目标位置的四态判定必须**放在复制之前**，而且判据不能是 `existsSync`。
       *
       * ⚠️ 这里上一轮犯过一个「修了等于没修」的错：守卫写在 `if (existsSync(to)) { ... }` 的**真分支**里，
       * 而危险路径是**假分支**——`existsSync` 对「文件被 EBUSY/EPERM 占用」「断链」「上次写了一半」一律返回
       * false，于是这些情况全都绕过守卫、直接落到 `copyFileSync`（**先截断再写**）。真分支那条最坏只是把
       * 一个能用但读不出的文件记成 skipped，本来就不危险；守卫守在安全的那一侧，等于没守。
       *
       * 顺带纠正上一轮写在这里的错误结论「裸 existsSync 在这里的误区比附件小」：它假设「读失败最坏是没覆盖」，
       * 而实际假分支走 copyFileSync，是**会覆盖**的。角色文件是用户私有内容，覆盖的代价比附件更高，
       * 所以这里比附件更需要守卫，不是更不需要。
       *
       * 四态各自的处置：
       *  - `usable`   ：真有一份能用的本地角色 → 跳过，这才是刻意的「不覆盖用户的改动」；
       *  - `blocked`  ：同名目录 / 符号链接占了 `.md` 的位置，不是可用角色；
       *  - `unreadable`：不知道那份是什么，不覆盖，但必须让用户知道这次没导进来；
       *  - `absent`   ：没有，允许复制。
       */
      const probe = inspectTarget(to)
      if (probe.kind === 'blocked') {
        if (!builtin) stat.failed.push({ step: 'personas', id: `${id}#blocked`, reason: 'target-blocked' })
        continue
      }
      if (probe.kind === 'unreadable') {
        if (!builtin) stat.failed.push({ step: 'personas', id: `${id}#read`, reason: 'target-unreadable' })
        continue
      }
      if (probe.kind === 'usable') {
        // 本地已有同名角色：整个跳过（含提示词、含头像），这既是幂等，也保住用户的改动
        if (!builtin) stat.skipped.push(id)
        continue
      }
      // 只有 absent 会走到这里
      copyFileSync(from, to)
      if (builtin) stat.builtinCopied.push(id)
      else stat.copied.push(id)
      // 头像单独成条（`<id>#avatar`）：角色本体已经搬好了，两者不该互相顶替。
      // reason 用固定码而不是原始错误消息：界面按完整码查文案表，原始消息只会让用户看到一串英文 EPERM/EACCES。
      const avatarErr = copyAvatar(srcDir, dstDir, id)
      if (avatarErr) {
        console.warn(`[import] 角色 ${id} 的头像复制失败：`, avatarErr)
        // target-blocked / target-unreadable 界面已有文案，直接透传；其余（EPERM 等原始消息）归到通用码，
        // 原始内容进上面的日志——否则界面会显示一串英文系统错误。
        const known =
          avatarErr === 'target-blocked' ||
          avatarErr === 'target-unreadable' ||
          avatarErr === 'source-dir-unreadable'
        stat.failed.push({
          step: 'personas',
          id: `${id}#avatar`,
          reason: known ? avatarErr : 'avatar-copy-failed'
        })
      }
    } catch (e) {
      // 单条失败不影响其余角色，但要如实上报（磁盘满 / 无权限）
      stat.failed.push({ step: 'personas', id, reason: writeFailureReason(e) })
    }
  }
  return stat
}

/**
 * 头像：原版里有哪个扩展名就复制哪个（一一对应，不转码、不改名）。
 *
 * ## 为什么改成上报（原来是 `catch { /* 头像复制失败无害 *\/ }`）
 *
 * 「头像缺失只是显示回落生成头像」是真的，所以这条**不该**让整轮 ok 变 false 的那种失败感……
 * 但它属于同一类静默损失：用户从原版导进来 20 个角色，头像全没搬过去，界面上看到一排默认图，
 * 而他没有任何线索知道「重导一次就会好」。整轮「失败必须上报」的改造本来就不该在最后一步破例。
 *
 * 返回失败原因（成功 / 源里本来就没头像 → undefined），由调用方决定记法：
 * **不能在内部吞掉再靠外层 catch 记**——那时角色本体已经 copied，外层 catch 会把同一个 id 再记一条 failed，
 * 界面上「已导入」和「失败」各出现一次同一角色，更让人看不懂。调用方用 `<id>#avatar` 单独成条。
 */
function copyAvatar(srcDir: string, dstDir: string, id: string): string | undefined {
  const srcAvatars = join(srcDir, 'avatars')
  const dstAvatars = join(dstDir, 'avatars')
  try {
    /*
     * 源 avatars 目录三态 —— 这是同一个 bug 的**第 8 处**（扫描补上源侧规则后立刻暴露出来的）。
     *
     * 以前 `if (!existsSync(srcAvatars)) return undefined` + 裸 `readdirSync`：目录被同名文件占住
     * （ENOTDIR）/ ACL 改坏（EACCES）/ 被杀毒锁住（EBUSY）时 `existsSync` 可能为 false 或 readdir 抛错，
     * 两条路都变成「源里没有头像」——角色本体照常导进来，头像一个都没有，而报告只说「角色已导入」。
     *
     * 返回码透传到 `<id>#avatar` 的 failed 条目（调用方已接）。
     */
    const avatars = readSourceDir(srcAvatars)
    if (avatars.kind === 'unreadable') return 'source-dir-unreadable'
    if (avatars.kind === 'absent') return undefined
    const files = avatars.names
    for (const ext of AVATAR_EXTS) {
      const name = `${id}.${ext}`
      if (!files.includes(name)) continue
      const to = join(dstAvatars, name)
      /*
       * 四态判定，判据不能用 `existsSync`。同形问题（见 importPersonas 里的长注释）：
       * `existsSync` 对「被占用 / 断链 / 上轮写了一半」都返回 false → 直接 `copyFileSync` 覆盖掉原头像
       * （先截断再写）。头像是用户自己挑的图，覆盖掉就找不回来了。
       *
       *  - `usable`    ：已有一份能读的同名头像 → 不覆盖（幂等），也不算失败；
       *  - `blocked`   ：被目录 / 链接占位 → 报失败（这张头像没导进来）；
       *  - `unreadable`：不知道那份是什么 → 不覆盖，报失败；
       *  - `absent`    ：没有 → 复制。
       */
      const probe = inspectTarget(to)
      if (probe.kind === 'usable') return undefined // 已有同名头像：不覆盖
      if (probe.kind === 'blocked') return 'target-blocked'
      if (probe.kind === 'unreadable') return 'target-unreadable'
      mkdirSync(dstAvatars, { recursive: true })
      copyFileSync(join(srcAvatars, name), to)
      return undefined // 一个 id 只认首个命中的扩展名
    }
    return undefined // 源里没有这个 id 的头像
  } catch (e) {
    return (e as Error)?.message ?? String(e)
  }
}

/**
 * 第 ③ 步：把本次新导入的角色置为启用。只动这些 id，本地其它开关原样保留。
 * 用 personas.ts 的 enablePersonas（而非自己合并映射），保证与界面上手动启停走同一条写路径。
 *
 * ⚠️ **必须把「没写进去」报出来**。以前这里 `setPersonaEnabled(id, true)` 的返回值被丢弃、异常还被 `catch {}` 吞，
 * 于是 config.json 不可写时报告写「已启用 role-a」，磁盘上却没有这条——用户看到角色在列表里、聊天时选不到
 * （停用态的角色不在可选范围）。而整轮的 ok 之所以常常是 false，纯粹是因为 providers 那一步碰巧也写了盘并报了
 * 一条 config-write-failed：**结局依赖巧合**。源里若没有服务商可导（或都已存在），这次失败就完全没有声音。
 *
 * 现在返回 `{ done, failures }`，由调用方汇总进 report.failures 并把 failure 的 step 记为 `personaEnabled`。
 * 不再有 catch：enablePersonas 内部不抛（写盘失败由 setConfig 返回布尔表达），若真抛了也是未预料异常，
 * 应当让整轮的兜底 catch 记成一条失败，而不是被就地吞掉当成成功。
 */
export function enableImportedPersonas(ids: string[]): { done: string[]; failures: Failure[] } {
  const r = enablePersonas(ids)
  return {
    done: r.done,
    failures: r.failed.map((f) => ({ step: 'personaEnabled', id: f.id, reason: f.reason }))
  }
}
