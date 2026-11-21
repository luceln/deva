import { mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { getDevaHome } from './services/config'
import { adoptSessionFile } from './services/chat-store'
import { historyLocked } from './services/chat-locks'
import { backupBroken, inspectTarget } from './importer-target'
import { decideExisting, sourceTail, type ExistingDecision } from './importer-session-merge'
import { writeFileAtomic } from './services/atomic-write'
import { readImportSession, readImportHistory, prepareImportHistory } from './importer-session-history'
import { readSourceDir, SOURCE_DIR_UNREADABLE, SOURCE_FILE_UNREADABLE, writeFailureReason } from './importer-source-dir'
import { SESSION_HISTORY_LOCKED, SESSION_MEDIA_MISSING, type Failure, type StepStat } from '../shared/import-protocol'
import { missingSourceMedia } from './services/media-store'
import type { Message } from './providers/types'

/**
 * 导入第 ⑥ 步：会话（`data/chats/`）。
 *
 * ## 这是一次「可重复同步」，不是一次性拷贝
 *
 * 目标已有同名会话时**不再一律跳过**：用户第一次导入之后继续在原版聊的内容，必须能再同步过来
 * （否则「跳过 28」里那些会话永远停在第一次导入时的样子）。判定见 `importer-session-merge.ts`：
 *
 *  - 目标不存在 → 复制，进 `copied`；
 *  - 源是目标内容的**严格超集**（目标的每条消息都能在源开头按序找到，且源更长）→ 覆盖，进 `updated`；
 *  - 其余（内容相同 / 本地聊过 / 两边分叉）→ 保留目标那份，进 `skipped`。
 *
 * **判据不看时间**（mtime 会被 `utimesSync` 改写；`updatedAt` 两边都会更新，分叉时拿它必丢一边），
 * 而是看「目标的内容是不是源的前缀」——只有那样覆盖才不丢任何东西。详见那个文件的文件头。
 *
 * ⚠️ **只增不减**：源里没有、目标里有的会话**绝不删除**。原版删了不传播——用户在本应用里留下的
 * 东西不因为他清理了原版就消失。
 *
 * ⚠️ **成对搬**：主对话的 `members[].sessionId` 与成员会话的 `parentId` 是双向引用。只搬一边，成员卡片点开空白。
 * 所以扫描时把「parentId 非空」的成员会话与其父一起纳入本批；反过来父文件里的 members 也已随父文件整体复制过去。
 * id 原样保留——引用天然有效，不需要任何映射。
 *
 * ⚠️ **compacted 依赖先行**：主 JSON 的 `compacted.file` 存拆分文件名。写主 JSON 前先验证完整 JSONL；若目标缺失，
 * 仅在源指针与历史内容能证明同一依赖时原子补齐；已有但不一致的 JSONL 绝不按尺寸覆盖。
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
export function importSessions(
  srcHome: string
): StepStat & { updated: string[]; compacted: string[]; failed: Failure[] } {
  const stat: StepStat & { updated: string[]; compacted: string[]; failed: Failure[] } = {
    copied: [],
    skipped: [],
    updated: [],
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
    stat.failed.push({ step: 'sessions', id: '<dir>', reason: writeFailureReason(e) })
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
    // Active turns hold the history array across awaits. Defer the entire session, not just cache adoption.
    if (historyLocked(safe)) {
      stat.failed.push({ step: 'sessions', id, reason: SESSION_HISTORY_LOCKED })
      continue
    }
    try {
      /*
       * 「目标已存在」要分清到底是什么占了位置。以前只判 `existsSync(to)`，于是**目标被同名目录占住**时也走
       * 「已存在 → 跳过」：界面显示「跳过 1」，用户以为是本来就有，而那个会话根本没在列表里（32/33）。
       * 跳过必须意味着「目标已是一份有效会话文件」；被目录/损坏文件占位是**真失败**。
       */
      const state = targetState(to)
      /*
       * 读不出来（EACCES / EBUSY / EPERM / EMFILE）**在判定行当场**记失败，不能只靠后面某个分支。
       *
       * 原分支在 50 行的 `else if` 里（语义正确），但代价是：任何人在中间插入「读到就继续」的逻辑，
       * unreadable 就会被当成 ok 一路走到覆盖 / 跳过；静态扫描也看不到——它只看调用点后 34 行，
       * 于是这条守卫在检查里**等于不存在**，报出来是「unreadable 被丢弃」。
       *
       * 判定紧贴调用点，方向才是无歧义的：读不出 → 不覆盖、不改任何一个字节、如实记失败。
       */
      if (state === 'unreadable') {
        stat.failed.push({ step: 'sessions', id, reason: 'target-unreadable' })
        continue
      }
      if (state === 'session') {
        /*
         * 目标已是一份有效会话。**不再无条件跳过**：原版那次导入之后继续聊的内容，就再也不会过来了
         * （用户看到的「跳过 28」里，有一部分正是这种）。
         *
         * 但也不能「源比目标新就覆盖」——那会在用户于本应用里聊过之后，把他这边的对话删掉。
         * 判据见 importer-session-merge.ts：只有「目标的每条消息都能在源开头按序找到、且源更长」时
         * 才覆盖，此时目标里的内容一条都不会丢。其余一律保留本应用这份。
         */
        const source = readImportSession(from), target = readImportSession(to)
        if (missingMedia(srcHome, from, source)) {
          stat.failed.push({ step: 'sessions', id, reason: SESSION_MEDIA_MISSING })
          continue
        }
        const repaired = prepareImportHistory(from, to, source, target)
        /*
         * 依赖读不出来 → 整条会话阻断。**不能**当成「没有需要补的」继续往下：接着会走
         * decideExistingByFile / appendSourceTail，而那两步同样读不出依赖，最终结论都是猜的。
         */
        if ('failed' in repaired) {
          stat.failed.push(repaired.failed)
          continue
        }
        if (repaired.repaired && target.compacted) stat.compacted.push(target.compacted.file)
        const decision = decideExistingByFile(from, to)
        if (decision === 'source-newer') {
          /*
           * ⚠️ **只追加源里多出来的尾部消息，其余字段一律保留目标值**（P1-②）。
           *
           * 以前这里是整档 `copyFileSync(from, to)`：`source-newer` 只证明「目标的消息是源的前缀」，
           * 并不证明源的 title / model / compacted 指针更该留下。于是用户在本应用里改过的标题、
           * 切过的模型、压缩边界，全被源那份顶掉；消息虽然没丢，元数据却悄悄回退。
           *
           * 合并后还要 `adoptSessionFile(safe)`（P1-①）：写入是绕过 `sessionCache` 的，已载入的缓存
           * 不同步就会在下一轮 save 时把旧消息集写回磁盘。
           *
           * 追加失败（源多出来的不是对象、写盘抛错）进 failed，不静默跳成 skipped。
           */
          const appended = appendSourceTail(from, to)
          if (!appended) {
            stat.failed.push({ step: 'sessions', id, reason: SOURCE_FILE_UNREADABLE })
            continue
          }
          adoptSessionFile(safe)
          stat.updated.push(id)
        } else if (decision === 'read-failed') {
          // 源或目标此刻读不出来：不知道内容关系，**绝不覆盖**（读失败不代表源更新）
          stat.failed.push({ step: 'sessions', id, reason: SOURCE_FILE_UNREADABLE })
          continue
        } else {
          // same / target-diverged / both-diverged：都保留目标那份
          if (repaired) adoptSessionFile(safe)
          stat.skipped.push(id)
        }
      } else if (state === 'blocked') {
        stat.failed.push({ step: 'sessions', id, reason: 'target-blocked' })
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
        const source = readImportSession(from)
        /*
         * ⚠️ 顺序：**先**判拆分历史，**再**判附件。
         *
         * `missingMedia` 内部也要读完整历史（`readImportHistory`），依赖读不出来时它同样返回 true
         * ——于是这条会话会被记成 `session-media-missing`（「附件还没备好，等附件步骤跑完再说」），
         * 而真相是源侧那份 JSONL 不在了 / 打不开，等多久都不会自己好。方向错了，用户会一直等。
         */
        const prepared = prepareImportHistory(from, to, source, source)
        // 依赖读不出来 → 不发布主档（与上面 session 分支同一判据：写不下去就别写一半）
        if ('failed' in prepared) {
          stat.failed.push(prepared.failed)
          continue
        }
        if (missingMedia(srcHome, from, source)) {
          stat.failed.push({ step: 'sessions', id, reason: SESSION_MEDIA_MISSING })
          continue
        }
        if (prepared.repaired && source.compacted)
          stat.compacted.push(source.compacted.file)
        if (state === 'broken') {
          const bak = backupBroken(to)
          console.warn(`[import] 会话 ${id} 的目标位置是个坏文件，已备份为 ${bak} 并重新写入`)
        }
        writeFileAtomic(to, JSON.stringify(source, null, 2))
        adoptSessionFile(safe)
        stat.copied.push(id)
      }
    } catch (e) {
      // 复制失败 ≠ 已存在：进 failed，界面才会把「这个会话没导进来」显示出来
      stat.failed.push({ step: 'sessions', id, reason: writeFailureReason(e) })
      continue
    }
  }
  return stat
}

/**
 * 读两个会话文件，判目标那份要不要被源覆盖。
 *
 * 读失败单独返回 `read-failed` 而不是塞进某个「不覆盖」的结论：读不出来**不说明源更新**，
 * 也不说明目标有本地内容——只是「不知道」。当作「跳过」会让报告看起来一切正常，
 * 而这个会话实际没同步；记进失败清单，用户才知道有一条没过。
 *
 * 两个文件各自 try：任一读不出就返回 `read-failed`，**不把「读不出」当成「内容不同」**。
 * 这一点很要紧：`JSON.parse` 对半截文件抛错时，若被 catch 成「内容不一样 → 不覆盖」，
 * 用户看到的是「跳过」，而真相是「这条根本没比对过」。
 */
/**
 * 源侧这条会话引用的附件里，有没有「源里有、目标没有」的。
 *
 * 有就说明附件步骤还没备好（或失败），此时**不能**先写主档、更不能 hydrate：否则图片会被降级成
 * 「数据已丢失」的说明文字，而它其实在源里好好躺着。源里本来就没有的 blob 不算——正常载入同样降级。
 */
function missingMedia(srcHome: string, file: string, session: ReturnType<typeof readImportSession>): boolean {
  try { return missingSourceMedia(readImportHistory(file, session) as Message[], srcHome) }
  catch { return true }
}

function decideExistingByFile(from: string, to: string): ExistingDecision | 'read-failed' {
  try {
    const t = readImportSession(to), s = readImportSession(from)
    return decideExisting({ messages: readImportHistory(to, t) }, { messages: readImportHistory(from, s) })
  } catch { return 'read-failed' }
}

/**
 * 把源里多出来的尾部消息追加进目标文件，**其余字段保持目标原值**（P1-②）。
 *
 * 规则（顺序不能换）：
 *  1. 读两份 JSON；任一读不出 / 解析不了 → false（调用方记失败，不静默）；
 *  2. 用 `sourceTail` 算共前缀之后的增量（判据与 `decideExisting` 同一套，不另写比对）；
 *     `null` = 没有可追加的尾部 → false（调用方不得报 updated）；
 *  3. 只改目标对象自己的 `messages`（追加），title / model / compacted / updatedAt 等**一个都不动**；
 *  4. `writeFileAtomic` 落盘（先写 `.tmp` 再 rename，崩溃不会把旧文件截成半截）。
 *
 * ⚠️ **不碰 compacted 指针**：目标若有压缩边界，它的 `messages` 已经是「compacted 之后的那段」，
 * 追加新尾部正好接在那段之后，指针 count 仍然有效（压缩边界之前的消息没变）。若把源的 compacted
 * 指针写进来，count 会指向目标那份被压缩过的历史，加载时就缺段——这正是 ac58de1 在 skipped 分支
 * 避免的事，这里同样不能回退。
 */
function appendSourceTail(from: string, to: string): boolean {
  const t = readImportSession(to), s = readImportSession(from)
  const tail = sourceTail({ messages: readImportHistory(to, t) }, { messages: readImportHistory(from, s) })
  if (!tail || !tail.length) return false
  // Keep the target's compacted bytes and pointer. Only append beyond its complete history.
  const merged = [...t.messages, ...tail]
  writeFileAtomic(to, JSON.stringify({ ...t, messages: merged }, null, 2))
  return true
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