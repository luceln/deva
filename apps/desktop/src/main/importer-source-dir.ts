import { type Dirent, readdirSync } from 'fs'

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
