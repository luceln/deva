import { cpSync, lstatSync, mkdirSync, readlinkSync, statSync, symlinkSync } from 'fs'
import { join, resolve } from 'path'
import { getDevaHome } from './services/config'
import { BUILTIN_SKILL_IDS } from './services/skills'
import { readSourceDir, SOURCE_DIR_UNREADABLE } from './importer-source-dir'
import type { Failure, StepStat } from '../shared/import-protocol'

/**
 * 导入第 ⑤ 步：技能。
 *
 * ⚠️ **复制链接本身，绝不解引用**。原版 `~/.deva/skills/<id>` 都是符号链接，实体在仓库外（E:\toolkit\skills\…、
 * E:\xfg-coding-map-skills）。解引用复制等于把整个技能目录拷一份 —— 那就成了会漂移的副本：用户在真源改 SKILL.md，
 * DevaPlus 永远看不到。链接则天然跟随（skills.ts 用 statSync 判断目录，会跟随链接；startSkillsWatcher 也照样生效）。
 *
 * ⚠️ **Windows 上 `symlinkSync(..., 'dir')` 会 EPERM**（需要开发者模式或管理员权限）。'junction' 不需要任何特权，
 * 且跨盘成立（实测 C:\…\.deva-plus\skills → E:\xfg-coding-map-skills 创建成功、statSync().isDirectory() 为真）。
 * 故顺序是「先试 symlink，EPERM 回落 junction」——在权限充足的机器上仍然得到真符号链接。
 *
 * 判存在只按**条目名**（id）：已有同名条目就跳过，幂等且不覆盖用户的本地技能。
 */

/** 本机/本平台能否建链接、以及最终用了什么方式——日志用，避免以后再被「静默没导进来」骗一次。 */
export type LinkKind = 'symlink' | 'junction' | 'copied'

function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id) && id !== '.' && id !== '..'
}

/** 建链接：先 symlink（目录 / POSIX 免 type），失败且是 Windows 时回落 junction。都失败返回 false。 */
function makeLink(target: string, dest: string): LinkKind | null {
  const isWin = process.platform === 'win32'
  // 目标是目录还是文件：断链时 statSync 会抛，按目录猜（技能基本都是目录）
  let isDir = true
  try {
    isDir = statSync(target).isDirectory()
  } catch {
    isDir = true
  }
  try {
    symlinkSync(target, dest, isWin ? (isDir ? 'dir' : 'file') : undefined)
    return 'symlink'
  } catch {
    if (!isWin || !isDir) return null
  }
  try {
    // junction 只支持目录，且不需要任何特权；跨盘也成立
    symlinkSync(target, dest, 'junction')
    return 'junction'
  } catch {
    return null
  }
}

/**
 * 把原版 skills/ 下的条目搬到 DevaPlus：链接按链接重建，实体目录才递归复制。
 * 返回 linked（重建的链接）/ copied（复制的实体）/ skipped（已存在或名字不可用）/ builtin（应用自带）
 * / failed（真失败，如无权限建链接、磁盘满）。
 *
 * 失败与跳过分开：`skipped` 里是「已有同名」或「名字不能当 id」这类**正常不该搬**的情形；
 * 复制/建链出错必须进 `failed`，否则界面显示「跳过 1」，用户会以为是本来就有。
 */
export function importSkills(
  srcHome: string
): StepStat & {
  builtin: string[]
  failed: Failure[]
  linked: string[]
  kinds: Record<string, LinkKind>
} {
  const stat: StepStat & {
    builtin: string[]
    failed: Failure[]
    linked: string[]
    kinds: Record<string, LinkKind>
  } = {
    copied: [],
    skipped: [],
    builtin: [],
    failed: [],
    linked: [],
    kinds: {}
  }
  const srcDir = join(srcHome, 'skills')
  const dstDir = join(getDevaHome(), 'skills')
  /*
   * 源侧静默第 4 处，注释原文「// 原版没有 skills 目录」。同一个病灶：`skills` 被同名文件占住
   * （ENOTDIR）/ ACL 改坏（EACCES）/ 被杀毒锁住（EBUSY）都会走到这里，而源里的技能还在。
   * 当成「没有」→ 报告「技能 0 个、ok:true」，用户以为原版没装过自定义技能。
   */
  const srcList = readSourceDir(srcDir)
  if (srcList.kind === 'unreadable') {
    stat.failed.push({ step: 'skills', id: '<skills>', reason: SOURCE_DIR_UNREADABLE })
    return stat
  }
  if (srcList.kind === 'absent') return stat // 真的没有这个目录：ENOENT
  const names = srcList.names
  try {
    mkdirSync(dstDir, { recursive: true })
  } catch (e) {
    // 建不出目标目录：记失败，别让报告看起来「本来就没有技能」
    stat.failed.push({ step: 'skills', id: '<dir>', reason: (e as Error)?.message ?? String(e) })
    return stat
  }

  for (const name of names) {
    if (!isSafeId(name)) {
      // 非法名条目（空格等）以前被静默丢弃；记进 skipped，用户至少能在明细里看到它没被搬
      stat.skipped.push(name)
      continue
    }
    // 内置元技能（create-skill / create-agent / create-mcp）是代码合成、永不落盘；原版 skills/ 里万一有同名残留目录
    // 也不算用户技能（listSkills 同样会忽略它），归入 builtin 而不是「跳过」。
    const builtin = BUILTIN_SKILL_IDS.includes(name)
    if (builtin) stat.builtin.push(name)
    const from = join(srcDir, name)
    const to = join(dstDir, name)
    try {
      // 目标已有同名条目：不覆盖（用户可能自己装了同名技能）。读不出来时也不能覆盖——
      // 那可能是用户装的同一个技能，只是此刻打不开（见 lexists 的说明）。
      const at = lexists(to)
      if (at === 'unreadable') {
        if (!builtin) stat.failed.push({ step: 'skills', id: name, reason: 'target-unreadable' })
        continue
      }
      if (at === 'present') {
        if (!builtin) stat.skipped.push(name)
        continue
      }
      const st = lstatSync(from)
      if (st.isSymbolicLink()) {
        // 链接目标按**源链接所在目录**解析成绝对路径：readlinkSync 可能给相对路径，照抄到新目录会指向别处（断链且不报错）
        const target = resolve(join(srcDir), readlinkSync(from))
        const kind = makeLink(target, to)
        if (kind) {
          stat.linked.push(name)
          stat.kinds[name] = kind
        } else {
          // 建不了链接就**不搬**：复制实体等于造一份会漂移的副本，比少一个技能（日志里写着）更难查。
          // 这是真失败（EPERM 等），不是「跳过」。
          stat.failed.push({ step: 'skills', id: name, reason: 'link-failed' })
        }
      } else if (st.isDirectory()) {
        // 不是链接的实体目录：原样复制（原版里若用户直接把技能放在这，那就是真源本身）
        cpSync(from, to, { recursive: true })
        if (!builtin) stat.copied.push(name)
        stat.kinds[name] = 'copied'
      } else {
        /*
         * 既不是链接也不是目录（散文件 / socket 等）。`listSkills` 不会认它，所以**搬过去也用不上**。
         *
         * 记 skipped 而不是 failed：这不是「读不出来」，而是「读了、确认它不是技能」——与我们搬不动
         * 的东西无关，纯属源里有一个非技能条目。用户看到「跳过 1」在这里是对的语义（本来就不该搬）。
         * 与 `mergeDir` 里那个 else（记 failed）不同：那边的条目本该是附件数据文件，搬不了就是真丢了。
         */
        if (!builtin) stat.skipped.push(name)
      }
    } catch (e) {
      stat.failed.push({ step: 'skills', id: name, reason: (e as Error)?.message ?? String(e) })
    }
  }
  return stat
}

/**
 * 不跟随链接的存在性判断（`existsSync` 对断链返回 false，会误判成「不存在」从而覆盖既有链接）。
 *
 * ⚠️ 这是「读不出 ≠ 没有」的**第 9 处**，也是本轮唯一漏掉的：它返回 `boolean`，把三种情况压成两种——
 *  1. 真的没有（ENOENT）→ false，可以写；
 *  2. 有，但读不出来（EPERM / EBUSY / EACCES）→ 也 false → **调用方会去建链接，覆盖掉用户已装的同名技能**。
 * 第 2 种在 Windows 上很常见（目录被索引服务占用 / ACL 改坏），而技能目录是用户手装的东西。
 *
 * 改成三态，由调用方分开处置。`absent` 才允许写。
 */
type Lexists = 'absent' | 'present' | 'unreadable'

function lexists(p: string): Lexists {
  try {
    lstatSync(p)
    return 'present'
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'unreadable'
  }
}
