import { type Dirent, readdirSync, statSync } from 'fs'

/**
 * 读源目录列表，三态返回。
 *
 * ## 为什么需要它（同一个 bug 的第 N 个复制品）
 *
 * 导入器里有 7 处是同一个写法：
 *
 * ```ts
 * let names: string[]
 * try { names = readdirSync(srcDir) } catch { return stat }   // ← 返回空
 * ```
 *
 * 注释一律写着「原版没有 X 目录」。但 `readdirSync` 抛错的原因**不止 ENOENT**：
 * ENOTDIR（源位置被同名文件占住）、EACCES / EPERM（ACL 改坏）、EBUSY（被杀毒/索引服务锁住）。
 * 这些情况下源里**有**数据，只是读不出来，于是上层记「0 个」→ 报告 `ok: true`、失败清单为空。
 *
 * 这是本仓库最坏的一类失效：**一次性导入**，用户看到「导入完成」就以为做完了，缺的那块永远缺
 * —— 他不会再来第二次。
 *
 * 三态与 `readJson` / `readMemoryFile` 完全同构：
 *  - `absent`：ENOENT，原版这个目录本来就没有 → 空，正常；
 *  - `ok`：读到了；
 *  - `unreadable`：读不出来 → 调用方**必须**记 failure，整轮 ok=false。
 *
 * ## 失败码为什么统一成一个
 *
 * 7 处各自一个码（`source-sessions-unreadable` / `source-personas-unreadable` / …）会让界面文案表
 * 多 7 条同义文案，而且每加一条导入步骤就要再补一条。所以统一用 `source-dir-unreadable`，
 * **目录身份放在 `id` 里**（`<data/chats>` / `<personas>` / `<checkpoints/s-1>` / …）：
 *  - 人看：`<data/chats> · 源目录读不出来` —— 定位与被占的位置一一对应；
 *  - 界面：一条文案覆盖全部，reason 表不随导入步骤增长。
 */
export type DirRead =
  /** ENOENT：原版这个目录本来就没有，正常。 */
  | { kind: 'absent' }
  /** 读到了。`dirents` 仅在 `withTypes` 时给出。 */
  | { kind: 'ok'; names: string[]; dirents?: Dirent[] }
  /** 读不出来（ENOTDIR / EACCES / EPERM / EBUSY）：**不知道里面有什么**，调用方必须上报。 */
  | { kind: 'unreadable' }

/**
 * @param dir 要列举的源目录
 * @param withTypes 需要 Dirent（判目录 / 文件）时传 true
 */
export function readSourceDir(dir: string, withTypes: true): DirRead
export function readSourceDir(dir: string): DirRead
export function readSourceDir(dir: string, withTypes?: true): DirRead {
  try {
    if (withTypes) {
      const dirents = readdirSync(dir, { withFileTypes: true })
      return { kind: 'ok', names: dirents.map((d) => d.name), dirents }
    }
    return { kind: 'ok', names: readdirSync(dir) }
  } catch (e) {
    /*
     * 只有 ENOENT 才算「本来就没有」。
     *
     * ⚠️ 别把「读不出来」写成「空」——那正是这 7 处复制品的共同病灶，也是验收实测表里
     * 「那一类数据 0 个、其余正常、ok:true、failures:[]」的成因。
     */
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable' }
  }
}

/** 统一的源目录读失败码：目录身份放 id 里，界面只需一条文案。 */
export const SOURCE_DIR_UNREADABLE = 'source-dir-unreadable'

/**
 * 单个源**文件**的实况。四态，比目录版多一态 `not-file`。
 *
 * ## 为什么需要它（目录版的第 9 个复制品，形状从目录换到了单文件）
 *
 * 角色导入曾是：
 *
 * ```ts
 * if (!statSync(from).isFile()) { stat.skipped.push(name); continue }
 * ```
 *
 * `isFile()` 返回 false 有两种完全不同的情况：
 *  1. **它确实不是普通文件**（原版里 `ludi.md` 被换成了同名目录）——源数据坏了；
 *  2. **读不出来**（EPERM / EBUSY / EACCES）——不知道它是什么。
 * 代码把两者压进 `skipped`，验收实测：把 `ludi-afacec76.md` 换成同名目录 → `ok:true`、
 * `failures:[]`、`personaSkipped:["ludi-afacec76.md"]`，目标角色 8→7。
 * 用户看到「跳过 1 个」只会理解为「本来就有，不用导」——这正是本项目最坏的那类失效。
 *
 * ## 三种失败分开报的理由
 *
 *  - `absent`：ENOENT。条目名是刚 readdir 出来的，理论上不该出现（TOCTOU：列举后被删）；
 *    真出现时按「没有」跳过是合理的——它确实没了。
 *  - `not-file`：存在但不是普通文件。**源数据异常**（角色目录只该有 `.md` 文件），记 failed。
 *    为什么不记 skipped：skipped 的语义是「目标已有 / 不该搬」，而这里源本身坏了，用户需要知道
 *    那份数据不会进来；把它说成「跳过」等于承认「原版就是这样」。
 *  - `unreadable`：读不出来。**不知道**是什么，同样记 failed——一次瞬时占用过后重导即可补上。
 *
 * 用 `statSync`（跟随链接）而不是 `lstatSync`：角色文件若是指向真文件的链接，原行为是能导的，
 * 换 lstat 会把它判成 `not-file` 从而**破坏**一个原本可用的场景。
 */
export type SourceFileStat =
  | { kind: 'absent' }
  | { kind: 'ok'; size: number }
  /** 存在但不是普通文件（目录 / 设备 / socket…）：源数据异常。 */
  | { kind: 'not-file' }
  /** 读不出来（EPERM / EBUSY / EACCES / ELOOP）：不知道是什么。 */
  | { kind: 'unreadable' }

/** 源文件读不出来。目录用 `SOURCE_DIR_UNREADABLE`，两者分开：单文件失败不影响同目录其它文件。 */
export const SOURCE_FILE_UNREADABLE = 'source-file-unreadable'
/** 源里那个名字下不是普通文件（例如 `.md` 位置被同名目录占住）：源数据异常，不是「跳过」。 */
export const SOURCE_NOT_A_FILE = 'source-not-a-file'
/**
 * 写目标失败（mkdir / copyFile / symlink 之类）。
 *
 * **不把 Node 的原始 message 透给界面**：`EEXIST: file already exists, mkdir 'C:\Users\...\data\chats'`
 * 用户看不懂，而且把本机绝对路径写进了界面。原始 message 仍进 `console.warn` 供排查，
 * 界面只认这个码。与 `secrets-write-failed` / `config-write-failed` 同一模式。
 */
export const TARGET_WRITE_FAILED = 'target-write-failed'

/** 把任意异常翻成原因码：调用方一律用它，**不要**再把 `error.message` 直接写进 `reason`。 */
export function writeFailureReason(e: unknown): string {
  // 排查用的原文留在 terminal，不进界面。
  console.warn('[import] 写目标失败：', e)
  return TARGET_WRITE_FAILED
}

/** 探测一个源文件。**不修改任何东西**，也不读内容。 */
export function inspectSourceFile(file: string): SourceFileStat {
  let st
  try {
    st = statSync(file)
  } catch (e) {
    // 只有 ENOENT 才是「真的没有了」；其余（EPERM / EBUSY / EACCES / ELOOP）是「读不出来」
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable' }
  }
  if (!st.isFile()) return { kind: 'not-file' }
  return { kind: 'ok', size: st.size }
}

/**
 * 把 `inspectSourceFile` 的结果翻成失败原因码（`ok` / `absent` 返回 null，调用方自行跳过）。
 *
 * 集中在一处是为了让**所有**调用方对同一种形态给同一个码：上次 `copyAvatar` 与另外 7 处各写一遍，
 * 结果漏了一处没人发现。
 */
export function sourceFileFailureReason(s: SourceFileStat): string | null {
  if (s.kind === 'unreadable') return SOURCE_FILE_UNREADABLE
  if (s.kind === 'not-file') return SOURCE_NOT_A_FILE
  return null
}
