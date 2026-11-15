import { cpSync, lstatSync, mkdirSync, readdirSync, readlinkSync, statSync, symlinkSync } from 'fs'
import { join, resolve } from 'path'
import { getDevaHome } from './services/config'
import type { StepStat } from '../shared/import-protocol'

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
 * 返回 linked（重建的链接）/ copied（复制的实体）/ skipped（已存在或失败）。
 */
export function importSkills(srcHome: string): StepStat & { linked: string[]; kinds: Record<string, LinkKind> } {
  const stat: StepStat & { linked: string[]; kinds: Record<string, LinkKind> } = {
    copied: [],
    skipped: [],
    linked: [],
    kinds: {}
  }
  const srcDir = join(srcHome, 'skills')
  const dstDir = join(getDevaHome(), 'skills')
  let names: string[]
  try {
    names = readdirSync(srcDir)
  } catch {
    return stat // 原版没有 skills 目录
  }
  try {
    mkdirSync(dstDir, { recursive: true })
  } catch {
    return stat
  }

  for (const name of names) {
    if (!isSafeId(name)) continue
    const from = join(srcDir, name)
    const to = join(dstDir, name)
    try {
      // 目标已有同名条目：不覆盖（用户可能自己装了同名技能）
      if (lexists(to)) {
        stat.skipped.push(name)
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
          // 建不了链接就**不搬**：复制实体等于造一份会漂移的副本，比少一个技能（日志里写着）更难查
          stat.skipped.push(name)
        }
      } else if (st.isDirectory()) {
        // 不是链接的实体目录：原样复制（原版里若用户直接把技能放在这，那就是真源本身）
        cpSync(from, to, { recursive: true })
        stat.copied.push(name)
        stat.kinds[name] = 'copied'
      }
    } catch {
      if (!stat.copied.includes(name) && !stat.skipped.includes(name)) stat.skipped.push(name)
    }
  }
  return stat
}

/** 不跟随链接的存在性判断（existsSync 对断链返回 false，会误判成"不存在"从而覆盖既有链接）。 */
function lexists(p: string): boolean {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}
