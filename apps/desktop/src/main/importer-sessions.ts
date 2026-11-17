import { copyFileSync, mkdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { getDevaHome } from './services/config'
import { backupBroken, inspectTarget } from './importer-target'
import { readSourceDir, SOURCE_DIR_UNREADABLE } from './importer-source-dir'
import type { Failure, StepStat } from '../shared/import-protocol'

/**
 * 导入第 ⑥ 步：会话（`data/chats/`）。
 *
 * 按 `safeId(id)` 判目标是否已有同名文件，有就跳过。**不用 mtime 判增量**：mtime 会带来「原版删了哪些要不要跟着删」
 * 的传播问题，而本需求是一次性导入——按 id 判存在即天然幂等，原版之后删不删都与这里无关。
 *
 * ⚠️ **成对搬**：主对话的 `members[].sessionId` 与成员会话的 `parentId` 是双向引用。只搬一边，成员卡片点开空白。
 * 所以扫描时把「parentId 非空」的成员会话与其父一起纳入本批；反过来父文件里的 members 也已随父文件整体复制过去。
 * id 原样保留——引用天然有效，不需要任何映射。
 *
 * ⚠️ **compacted 同批**：主 JSON 的 `compacted.file` 存的是拆分文件名（`<id>.compacted-<ts>.jsonl`），
 * 缺了它早期历史读不出来（chat-store 的 readCompacted 返回 null → 那段历史当作不存在）。id 不变则文件名也不用改，
 * 照原文件名复制即可。
 *
 * **不搬 `_index.json`**：它是派生数据，由 ensureIndex() 自愈重建；搬过去反而可能带着指向不存在文件的条目。
 * `model` 与 `focusRoot` 也无需重写：前者是 providerId:modelId（provider id 原样保留，引用天然有效），
 * 后者是绝对路径（同机同盘，两边读到同一个目录）。这两条是旧方案「重写」逻辑在这里整块作废的原因。
 *
 * ⚠️ **失败必须上报**：目标 `data/chats` 若被一个同名**文件**占着，`mkdirSync` 会失败——以前这里直接 `return stat`，
 * 报告就是「0 新增 0 跳过 0 失败 + ok=true」，而用户一个会话都没导进来。这属于最坏的一类静默失效：
 * 界面显示「导入完成」，用户以为历史都在。所以建目录失败、单个文件复制失败都进 `failed`。
 */

/** 会话文件名 → id（去掉 .json；只认最外层主文件，compacted 由单独规则处理）。 */
function sessionIdOf(name: string): string | null {
  if (!name.endsWith('.json') || name === '_index.json') return null
  return name.slice(0, -5)
}

/** 与 chat-store 的 safeId 同一白名单：id 来自磁盘但仍要防路径穿越。 */
function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '')
}

/** 把原版会话搬进 DevaPlus，返回复制的会话 id、拆分文件与失败清单。 */
export function importSessions(srcHome: string): StepStat & { compacted: string[]; failed: Failure[] } {
  const stat: StepStat & { compacted: string[]; failed: Failure[] } = {
    copied: [],
    skipped: [],
    failed: [],
    compacted: []
  }
  const srcDir = join(srcHome, 'data', 'chats')
  const dstDir = join(getDevaHome(), 'data', 'chats')
  /*
   * 源目录三态。⚠️ 这里是「源侧静默」7 处复制品里的第 1 处，注释原文是「// 原版没有会话」。
   *
   * `readdirSync` 抛错不止 ENOENT：ENOTDIR（`data/chats` 被同名文件占住）、EACCES / EPERM（ACL 改坏）、
   * EBUSY（被杀毒 / 索引服务锁住）——这些情况下源里**有**会话，只是读不出来。当成「没有」的后果是
   * 报告显示「会话 0 个、ok:true、failures:[]」，用户以为导入完成，而历史一条都没进来。一次性导入，
   * 他不会再来第二次。
   */
  const srcList = readSourceDir(srcDir)
  if (srcList.kind === 'unreadable') {
    stat.failed.push({ step: 'sessions', id: '<data/chats>', reason: SOURCE_DIR_UNREADABLE })
    return stat
  }
  if (srcList.kind === 'absent') return stat // 真的没有会话：ENOENT
  const names = srcList.names
  try {
    mkdirSync(dstDir, { recursive: true })
  } catch (e) {
    // 整步作废：必须让报告亮红，否则「会话 0 个 + ok」会被当成「本来就没有会话」
    stat.failed.push({ step: 'sessions', id: '<dir>', reason: (e as Error)?.message ?? String(e) })
    return stat
  }

  // ① 先算出「哪些会话要搬」：全部主文件 + 它们的 compacted。成对关系的保证来自「主对话与成员会话都是独立主文件」，
  //    两边都在同一批里；父文件里的 members 引用随文件内容整体过来，成员文件的 parentId 也原样保留。
  const wanted = new Map<string, string>() // id -> 原文件名
  for (const name of names) {
    const id = sessionIdOf(name)
    if (!id) continue
    wanted.set(id, name)
  }

  for (const [id, name] of wanted) {
    const safe = safeId(id)
    if (!safe) continue
    const from = join(srcDir, name)
    const to = join(dstDir, `${safe}.json`)
    try {
      /*
       * 「目标已存在」要分清到底是什么占了位置。以前只判 `existsSync(to)`，于是**目标被同名目录占住**时也走
       * 「已存在 → 跳过」：界面显示「跳过 1」，用户以为是本来就有，而那个会话根本没在列表里（32/33）。
       * 跳过必须意味着「目标已是一份有效会话文件」；被目录/损坏文件占位是**真失败**。
       */
      const state = targetState(to)
      if (state === 'session') {
        // 目标已是一份有效会话：跳过（幂等），但仍要检查 compacted（首次导入可能复制中断过）
        stat.skipped.push(id)
      } else if (state === 'blocked') {
        stat.failed.push({ step: 'sessions', id, reason: 'target-blocked' })
        continue
      } else if (state === 'unreadable') {
        // 读失败：文件可能是好的，只是此刻被占用 / 无权限。**不覆盖**，如实记失败。
        stat.failed.push({ step: 'sessions', id, reason: 'target-unreadable' })
        continue
      } else {
        /**
         * 目标不存在，或是个**解析不出会话的坏文件**（半截 JSON / 没有 id）。
         *
         * 坏文件也要覆盖（否则这个会话永远进不来），但按规则「覆盖前若旧内容解析失败，先备份到旁边」：
         * 挪成 `<name>.bad-<时间戳>` 再写。不删的理由是坏的也有价值——用户可能想看一眼自己丢的是哪半截；
         * 而 `copyFileSync` 非原子（先截断），备份是唯一能保住它的时机。
         *
         * 备份名不以 `.json` 结尾（见 backupBroken）：否则 `data/chats` 的索引重建会把它当成一个会话读进来。
         */
        if (state === 'broken') {
          const bak = backupBroken(to)
          console.warn(`[import] 会话 ${id} 的目标位置是个坏文件，已备份为 ${bak} 并重新写入`)
        }
        copyFileSync(from, to)
        stat.copied.push(id)
      }
    } catch (e) {
      // 复制失败 ≠ 已存在：进 failed，界面才会把「这个会话没导进来」显示出来
      stat.failed.push({ step: 'sessions', id, reason: (e as Error)?.message ?? String(e) })
      continue
    }
    copyCompacted(srcDir, dstDir, safe, stat, names)
  }
  return stat
}

/**
 * 目标位置的状态：
 *  - `absent`：什么都没有，可以写；
 *  - `session`：已有一份**可读且可解析的会话文件**（有 string 类型的 id）——这是唯一能算「已存在、跳过」的状态；
 *  - `blocked`：被目录（或其它非文件）占位，写不进去。硬要写只会抛异常，而「跳过」会把它伪装成「本来就有」；
 *  - `broken`：读到了、但内容不是一份会话（没有 id / 半截 JSON / 别的东西）。覆盖才是正确做法
 *    （旧内容本来也读不出来，留着只会让这个会话永远进不来）——但覆盖前要先备份，见调用方；
 *  - `unreadable`：**读失败**（EACCES / EBUSY / EPERM / EMFILE）。文件很可能完全正常，只是此刻打不开
 *    （Windows 上杀毒 / 索引服务扫盘是常见原因）。**绝不能覆盖**——覆盖会毁掉一份能用的会话，而且
 *    `copyFileSync` 非原子（先截断），写到一半失败连旧内容也没了。
 *
 * 「存在但异常」的前置判断统一走 `inspectTarget`（与 mergeDir / copyAssoc / copyCompacted 同一份逻辑）：
 * 那里已经判过「没有 / 被占位 / 打不开」，这里只补会话特有的一步——内容能不能解析成会话。
 *
 * ⚠️ 以前 `readFileSync` 与 `JSON.parse` 共用一个 catch，于是「读失败」和「内容坏」被合成 `broken`，
 * 短暂被占用的正常会话会被源文件顶掉，报告还记成 `copied`（用户看到「新增 1」，零异常信号）。
 */
function targetState(to: string): 'absent' | 'session' | 'blocked' | 'broken' | 'unreadable' {
  const probe = inspectTarget(to)
  if (probe.kind !== 'usable') return probe.kind
  let raw: string
  try {
    raw = readFileSync(to, 'utf8')
  } catch {
    // 探测能打开、读却失败（探测与读之间被别的进程抢走）：同样是「不知道」，不覆盖
    return 'unreadable'
  }
  try {
    const parsed = JSON.parse(raw) as { id?: unknown }
    return typeof parsed?.id === 'string' && parsed.id ? 'session' : 'broken'
  } catch {
    return 'broken' // 真的读到了、但解析不了：半截文件之类，覆盖合理（但要先备份）
  }
}

/**
 * 复制某个会话的拆分文件（`<id>.compacted-<ts>.jsonl`），仅当目标没有同名文件时。
 * 文件名里含 id，所以用 `${safe}.compacted-` 前缀匹配即可，不必解析主 JSON 的 compacted 字段。
 */
function copyCompacted(
  srcDir: string,
  dstDir: string,
  safe: string,
  stat: { compacted: string[]; failed: Failure[] },
  srcNames: string[]
): void {
  const prefix = `${safe}.compacted-`
  /*
   * 源侧静默第 2 处。以前是 `try { names = readdirSync(srcDir) } catch { return }` —— 读不出源目录时
   * 直接返回：主会话文件照样复制过去，但它引用的那段早期历史（compacted.jsonl）一个都没搬。
   * `chat-store.readCompacted` 读不到文件就当那段历史不存在，界面上那段对话凭空消失，报告里零记录。
   *
   * 现在**复用主文件那次 readdir 的结果**（`srcNames`）：同一个目录读两次没有意义，而且
   * 每个会话都调一次本函数，重复报同一条失败只会把失败清单刷成噪声。目录读失败已经在
   * `importSessions` 开头统一报过一次（`<data/chats>`），这里不再重复。
   */
  const names = srcNames
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.jsonl')) continue
    const to = join(dstDir, name)
    const probe = inspectTarget(to)
    if (probe.kind === 'blocked') {
      stat.failed.push({ step: 'sessions', id: name, reason: 'target-blocked' })
      continue
    }
    if (probe.kind === 'unreadable') {
      stat.failed.push({ step: 'sessions', id: name, reason: 'target-unreadable' })
      continue
    }
    if (probe.kind === 'usable') {
      // .jsonl 不是内容寻址，尺寸一致就当成搬好了（同一源文件逐行写出，尺寸是不错的指纹）
      const srcSize = statSync(join(srcDir, name)).size
      if (probe.size === srcSize) continue
      // 尺寸不一致 = 上次写到一半（写这段早期历史时被中断）。挪开再重写：以前裸 existsSync 会
      // 把这半截文件当成「已存在」，那段历史此后永远读不全，而当初的失败只在第一次导入时出现过一次。
      const bak = backupBroken(to)
      console.warn(`[import] compacted/${name} 是半截文件（${probe.size}≠${srcSize}），已备份为 ${bak} 并重新复制`)
    }
    try {
      copyFileSync(join(srcDir, name), to)
      stat.compacted.push(name)
    } catch (e) {
      // 主文件已在，那段早期历史仍读不出来——属于真失败，别静默吞掉
      stat.failed.push({ step: 'sessions', id: name, reason: (e as Error)?.message ?? String(e) })
    }
  }
}
