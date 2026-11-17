import { closeSync, lstatSync, openSync, renameSync } from 'fs'

/**
 * 「目标位置已经有个同名条目」到底意味着什么——导入器里所有「已存在就跳过」的判断都该走这里。
 *
 * ## 为什么需要这个模块
 *
 * `existsSync(to)` 只回答一个问题：**这个名字占着没有**。但导入器真正要决定的是「能不能把这当成
 * 已经搬好了」。两者在四种情况下不同，而裸 `existsSync` 把这四种全归成「跳过」：
 *
 *  1. **目标被同名目录占位**（上次崩溃留下的，或用户手建）→ 跳过 → 文件永远进不来，报告一个字不提；
 *  2. **目标打不开**（EACCES / EPERM，Windows 上还有杀毒 / 索引服务扫盘造成的 EBUSY）→ 跳过。
 *     这时我们**根本不知道里面是什么**，却说「已存在」；
 *  3. **目标是上次中断留下的半截文件**（`copyFileSync` 先截断再写，中途失败就留半截）→ 跳过 →
 *     第一次导入的残骸被永久当成「已导入」，而失败记录只在第一次出现过；
 *  4. **目标是断链的符号链接**（`existsSync` 对断链返回 false，与真不存在同解）→ 会走「不存在」分支，
 *     然后写入时穿过链接写到别处，或干脆失败。
 *
 * 第 2、3 条是同一句错话（「读不到」被当成「没有/已有」），第 1、4 条只是它的近亲。上一轮只在会话主文件
 * 那一处（`importer-sessions.ts` 的 `targetState`）修了，`mergeDir` / `copyAssoc` / `copyCompacted`
 * 三处还是同一个写法——同一个 bug 的复制品，必须一起改。
 *
 * ## 为什么不比内容、只比大小
 *
 * 这几类目录都是**内容寻址**的：checkpoints / media 的文件名就是内容的 sha256，tool-results / subagents
 * 的文件名与源一一对应。所以「同名 → 内容本该一样」，大小不一致就证明目标是个坏副本（截断 / 写了一半），
 * 不需要读全量 hash 就能判。大小一致但内容不同不会发生（除非磁盘损坏，那属于另一类问题，这里不猜）。
 */

/** 目标位置实况。`usable` 才允许「跳过」；其余三种都必须能浮到报告里。 */
export type TargetProbe =
  /** 没有这个名字（ENOENT）：正常写入。 */
  | { kind: 'absent' }
  /** 是个普通文件，且能打开读：可以当成「已搬好」。size 用于判半截副本。 */
  | { kind: 'usable'; size: number }
  /** 被目录 / 符号链接 / 其它非普通文件占位：写不进去，也没法安全备份。 */
  | { kind: 'blocked' }
  /** 存在但打不开（EACCES / EBUSY / EMFILE）：**不知道**里面是什么，绝不能覆盖。 */
  | { kind: 'unreadable'; error: string }

/**
 * 探测目标位置。**不修改任何东西。**
 *
 * 用 `lstatSync` 而不是 `statSync`：源侧复制的是普通文件，目标若是符号链接就该报 `blocked`——
 * 跟随链接写入等于写到链接指向的地方（用户数据目录之外的任意路径），这类「写穿」在导入器里是要避免的。
 *
 * 打开一次是为了拿到真实的可读性：`lstatSync` 成功不代表能读（Windows 独占打开的文件 lstat 也会成功，
 * 读才失败）。用 `openSync('r')` 而不是 `readFileSync`：只探权限与共享冲突，不把整份内容读进内存
 * ——附件里有几百个文件，逐个读一遍是纯浪费。
 */
export function inspectTarget(to: string): TargetProbe {
  let st
  try {
    st = lstatSync(to)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    // ENOENT 是常态（第一次导入）；其它错误（EPERM 打不开父目录）是「读不到」，不能当成「没有」
    return code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable', error: (e as Error)?.message ?? String(e) }
  }
  if (!st.isFile()) return { kind: 'blocked' }
  try {
    const fd = openSync(to, 'r')
    closeSync(fd)
  } catch (e) {
    // 打不开就不知道里面是什么：宁可不写（写下去可能毁掉一份好文件，见 copyFileSync 非原子）
    return { kind: 'unreadable', error: (e as Error)?.message ?? String(e) }
  }
  return { kind: 'usable', size: st.size }
}

/**
 * 探测**目录**目标位置。与 `inspectTarget` 分开是必要的：同一个「非普通文件」在文件分支里是 `blocked`，
 * 在目录分支里却正是我们要的东西，硬塞进一个函数会让调用方反复倒着理解返回值。
 *
 *  - `absent`：没有这个名字 → 建目录；
 *  - `dir`：已经是个目录 → 进去补缺（幂等的落点）；
 *  - `blocked`：被普通文件 / 符号链接占位 → 进不去，也补不了；
 *  - `unreadable`：存在但打不开（EACCES / EPERM，父目录无权）→ **不知道**里面有什么，不乱动。
 */
export function inspectDirTarget(to: string): 'absent' | 'dir' | 'blocked' | 'unreadable' {
  let st
  try {
    st = lstatSync(to)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    return code === 'ENOENT' ? 'absent' : 'unreadable'
  }
  return st.isDirectory() ? 'dir' : 'blocked'
}

/**
 * 把「即将被覆盖的旧文件」挪到旁边留档，返回备份名。同名备份已存在时追加序号，绝不覆盖既有备份。
 *
 * 只给一种场景用：**旧内容已经证明是坏的**（半截副本 / 解析不出会话），但坏也可能坏得有价值
 * （用户想看一眼自己丢的是哪一半）。所以不删、只改名，改名是原子的。
 *
 * 备份名以 `.bad-<时间戳>` 结尾，**不以 `.json` 结尾**：`data/chats` 的索引重建按 `.json` 扫目录，
 * 备份若以 `.json` 结尾会被当成一个会话读进来（半截内容解析失败 → 又被这里判成坏 → 无限套娃）。
 */
export function backupBroken(to: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  let bak = `${to}.bad-${stamp}`
  for (let i = 1; ; i++) {
    try {
      lstatSync(bak)
    } catch {
      break // 这个备份名没人用
    }
    bak = `${to}.bad-${stamp}-${i}`
  }
  renameSync(to, bak)
  return bak
}
