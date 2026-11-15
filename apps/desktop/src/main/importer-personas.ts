import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { getDevaHome } from './services/config'
import { setPersonaEnabled } from './services/personas'
import { DEFAULT_PERSONAS } from './services/default-personas'
import type { StepStat } from '../shared/import-protocol'

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
  /** 实际写入文件的自带默认角色 id（正常为空；本地缺文件时会被补上，仍需补启用态）。 */
  builtinCopied: string[]
}

/**
 * 把原版角色搬进 DevaPlus。返回本次新导入的自建角色 id（第 ③ 步据此补 enabled）。
 * 头像随角色一起搬：先按扩展名找原版里存在的那份，同名同扩展名复制过去即可（avatar-image.ts 也是按这个顺序找）。
 */
export function importPersonas(srcHome: string): PersonaImportStat {
  const stat: PersonaImportStat = { copied: [], skipped: [], builtin: [], builtinCopied: [] }
  const srcDir = join(srcHome, 'personas')
  const dstDir = join(getDevaHome(), 'personas')
  let names: string[]
  try {
    names = readdirSync(srcDir)
  } catch {
    return stat // 原版没有 personas 目录
  }
  try {
    mkdirSync(dstDir, { recursive: true })
  } catch {
    return stat // 建不出目标目录：整步作废，调用方会从「没复制」看出失败
  }

  for (const name of names) {
    if (!name.endsWith('.md')) continue
    const id = name.slice(0, -3)
    if (!isSafeId(id)) continue
    const from = join(srcDir, name)
    const to = join(dstDir, name)
    // 应用自带的默认角色（general / xiaomajiang）：不属于「用户导入」，单独归入 builtin。
    // 文件仍按需补齐（缺失时补上是无害的），但既不进 copied 也不进 skipped —— 用户不该看到
    // 「跳过 2 个」而以为自己有默认角色被忽略。启用态也随种子逻辑走，不由导入负责。
    const builtin = DEFAULT_PERSONA_IDS.has(id)
    if (builtin) stat.builtin.push(id)
    try {
      if (!statSync(from).isFile()) continue
      if (existsSync(to)) {
        // 本地已有同名角色：整个跳过（含提示词、含头像），这既是幂等，也保住用户的改动
        if (!builtin) stat.skipped.push(id)
        continue
      }
      copyFileSync(from, to)
      if (builtin) stat.builtinCopied.push(id)
      else stat.copied.push(id)
      copyAvatar(srcDir, dstDir, id)
    } catch {
      // 单条失败不影响其余角色；计入 skipped 由调用方看差异（此处不抛，保持「一步失败不中断整轮」）
      if (!builtin && !stat.copied.includes(id) && !stat.skipped.includes(id)) stat.skipped.push(id)
    }
  }
  return stat
}

/** 头像：原版里有哪个扩展名就复制哪个（一一对应，不转码、不改名）。失败静默——头像缺失只是显示回落生成头像。 */
function copyAvatar(srcDir: string, dstDir: string, id: string): void {
  const srcAvatars = join(srcDir, 'avatars')
  const dstAvatars = join(dstDir, 'avatars')
  try {
    if (!existsSync(srcAvatars)) return
    const files = readdirSync(srcAvatars)
    for (const ext of AVATAR_EXTS) {
      const name = `${id}.${ext}`
      if (!files.includes(name)) continue
      const to = join(dstAvatars, name)
      if (existsSync(to)) return // 已有同名头像：不覆盖
      mkdirSync(dstAvatars, { recursive: true })
      copyFileSync(join(srcAvatars, name), to)
      return // 一个 id 只认首个命中的扩展名
    }
  } catch {
    /* 头像复制失败无害：角色本体已导入 */
  }
}

/**
 * 第 ③ 步：把本次新导入的角色置为启用。只动这些 id，本地其它开关原样保留。
 * 用 personas.ts 的 setPersonaEnabled（而非自己合并映射），保证与界面上手动启停走同一条写路径。
 */
export function enableImportedPersonas(ids: string[]): string[] {
  const done: string[] = []
  for (const id of ids) {
    if (!isSafeId(id)) continue
    try {
      setPersonaEnabled(id, true)
      done.push(id)
    } catch {
      /* 单个失败不影响其它角色 */
    }
  }
  return done
}
