import { copyFileSync, lstatSync, mkdirSync, rmSync, statSync, utimesSync } from 'fs'
import { basename, join } from 'path'
import { getDevaHome } from './services/config'
import { backupBroken, inspectDirTarget, inspectTarget } from './importer-target'
import { readSourceDir, SOURCE_DIR_UNREADABLE } from './importer-source-dir'
import type { AssocReport, Failure } from '../shared/import-protocol'

/**
 * 导入第 ⑦ 步：四类附件（media / checkpoints / subagents / tool-results，约 170 MB）。
 *
 * ⚠️ **必须在会话落盘之后调用，且同一轮内完成**。启动时有三个清扫（index.ts 的 sweepCheckpoints /
 * sweepSubagents / sweepMedia）：它们删「id 不在会话列表里的」目录与「没被任何会话引用的」blob。
 * 先搬附件、会话还没到位的话，下次启动这些附件就被当垃圾清掉——不报错，用户只看到图片变成「数据已丢失」、
 * 回滚面板说「备份已缺失」。
 *
 * ⚠️ **这三个清扫全按文件 mtime 判年龄**（checkpoints 保留 30 天、其余 1 小时宽限），而 `copyFileSync` 会
 * **保留源 mtime**。所以复制后必须把 mtime 刷成当前时间（见 copyFileFresh）——否则「源数据放了几个月再导入」
 * 会让整批回滚备份在导入后第一次启动就被删空。「刚复制进来的」本来就该是「现在的文件」。
 *
 * 目录名规则（都与 chat-store 的 safeId 同一白名单）：
 *  - `checkpoints/<safeId(sessionId)>/<hash>`（checkpoints.ts）
 *  - `subagents/<safeId(sessionId)>/*.json`（subagent-store.ts）
 *  - `tool-results/<safeName(sessionId)>/*.txt`（tool-results.ts，空 id 归 `_misc`）
 *  - `media/<sha256>`：内容寻址的 blob，按文件名复制即可，天然不会冲突
 *
 * **幂等的口径是「目标已存在就跳过」，但「跳过」必须细到文件级**：目录已存在时不能整个 continue ——
 * 上次跑到一半被强杀（170 MB、上百次复制，用户很可能顺手点关闭），目录里就缺文件，而整个目录跳过意味着
 * 那些文件**永远补不回来**：回滚面板和子智能体记录永久残缺，界面却写「导入完成」。所以目录已存在时要递归进去
 * 逐个文件补缺（已存在的文件仍然跳过，不重写）。
 *
 * **失败必须能上报**：磁盘满 / 无权限时若继续静默吞掉，用户会看到「导入完成」而媒体少了一截。所以每处 catch
 * 都记一条 Failure 交给调用方汇总——失败不中断整轮（能搬多少搬多少），但整轮 ok 会因此为 false。
 */

function safeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '')
}

/**
 * 崩溃残留的临时文件不值得搬过去。两种命名都要认：
 *  - checkpoints：`<hash>.tmp-<uuid>`（checkpoints.ts 写盘用，带横杠）；
 *  - media：`<hash>.tmp`（media-store.ts 的 ensureBlob 用，**没有横杠**）。
 *
 * ⚠️ 以前只判 `includes('.tmp-')`，于是 media 循环里那句 `continue` 实际从不生效：残留的 `<hash>.tmp`
 * 会被当 blob 复制过去、计进 `assoc.media`，然后被下次清扫删掉——数字虚高且目标多一个垃圾文件。
 */
function isTempLeftover(name: string): boolean {
  return name.includes('.tmp-') || name.endsWith('.tmp')
}

/**
 * 一条失败记录（step 固定为 assoc，kind 区分是哪一类附件）。
 *
 * 文件名类失败的 id 拼成 `${kind}:${name}`，便于在同一条失败清单里看出是哪一类附件的哪个文件。
 * 但**占位符 id（`<dir>` 这类）必须裸用**：界面 `ID_PLACEHOLDER_KEY` 是按完整 id 精确查文案表的，
 * 拼成 `media:<dir>` 就匹配不到，用户会直接看到 `<dir>` 这个内部占位符。占位符场景的 kind 移到 reason
 * 文本里（那里本来就是给人看的说明文字）。
 */
function fail(kind: string, id: string, reason: string): Failure {
  if (id.startsWith('<')) return { step: 'assoc', id, reason: `${kind}: ${reason}` }
  return { step: 'assoc', id: `${kind}:${id}`, reason }
}

/**
 * 复制单个附件文件，并把目标文件的 **mtime 刷成当前时间**。
 *
 * ## 为什么必须刷 mtime（P0-2，回滚备份被启动清扫删空）
 *
 * `copyFileSync` 会**保留源 mtime**。而本仓四处启动清扫全按 mtime 判过期：
 *  - `checkpoints.ts`：`RETAIN_MS = 30 天`，超过即删（`:355-357`）；
 *  - `subagent-store.ts` / `media-store.ts`：1 小时宽限期（无引用才删，判据同样含 mtime）；
 *  - `checkpoints.ts` 的 `gcBlobs`：60 秒 GC 宽限。
 *
 * 实测：源数据放了 60 天再导入，2219 个 checkpoint 在**导入后第一次启动**就被全删，回滚面板显示「备份已缺失」。
 * 语义上这批文件是「刚复制进来的」，mtime 就该是现在——源文件的年龄不代表目标数据的年龄。
 *
 * ## 什么时候刷（这是「一次失败就该能自愈」的关键）
 *
 *  - 真的复制了文件 → 刷（这是常态）；
 *  - 文件已存在而跳过 → **只在目标 mtime 已经老到会被清扫删掉时补刷一次**。
 *
 * 第二条是为了修一个自我锁死：复制成功但 `utimesSync` 失败时这次记了失败，可**文件已在盘上**，下次导入
 * `existsSync(to)` 命中就走「已存在跳过」→ 不再刷 mtime → 保持源旧时间戳 → 下次启动照样被删，而用户按提示
 * 「重新导入一次」只会看到「跳过 N」。加这个校验后，重导一次就能把它修好，不需要用户手删文件。
 *
 * 判据用最保守的那条保留期（30 天，checkpoints 的 `RETAIN_MS`）：偏老就刷，宁可多刷几次也无害
 * （刷 mtime 只是把它标成「现在是新鲜的」）。用 1 小时宽限当阈值太激进——那会让每次导入都重写几百个文件的
 * mtime，白白破坏「重复导入目标零变化」的幂等性。
 */
const STALE_MTIME_MS = 30 * 24 * 3600 * 1000

/**
 * 目标文件是否已经旧到会被清扫删掉。
 *
 *  - `stat` 失败：按「不知道」处理 → 返回 false（不刷），让幂等性优先；真要被清理那也是下次启动的事。
 *  - 不是普通文件（目录顶了同名文件的位置）：返回 false。那种情况没被复制进来，刷 mtime 只会掩盖问题，
 *    而且它本来就不该由这里修（属于 P2-6 之外的「占位」问题）。
 */
function isStaleTarget(to: string): boolean {
  try {
    const st = statSync(to)
    if (!st.isFile()) return false
    return Date.now() - st.mtimeMs > STALE_MTIME_MS
  } catch {
    return false
  }
}

/**
 * 复制并按内容校验。
 *
 * `copyFileSync` **不是原子写**（先截断目标再写）。写到一半失败（磁盘满、被杀、断电）会留下半截文件，
 * 而外观与成功副本无从区分——下一轮 `inspectTarget` 会按尺寸判出来。这里写完立刻核一遍尺寸，
 * 让「这一轮」就把问题记成失败，而不是留到下一轮才由「半截副本」分支发现。
 *
 * ## 尺寸作为判据的前提（验收确认过，这里是它要求写下的假设）
 *
 * 这四类附件都是**内容寻址**或**一一对应**的：media / checkpoints 的文件名就是内容 sha256，
 * subagents / tool-results 的文件名与源一一对应、内容由本应用写。所以：
 *  - 「同名但尺寸不同」⇒ 必然是半截副本（不是另一个合法内容）；
 *  - 「同名且尺寸相同」⇒ 视为内容相同，**不读全量比对**。
 *
 * 后一条是**刻意的盲区**：同尺寸不同内容只可能来自磁盘损坏或人为篡改。为此付出的代价是每轮导入
 * 重新读完 391 个 blob（约 170MB）并算 hash——收益远低于成本。要查这类问题应该走独立的完整性校验，
 * 而不是把成本摊进每次导入。
 */
function copyFileFresh(from: string, to: string): void {
  copyFileSync(from, to)
  // silent-ok: 这里的 statSync 读失败会抛给调用方 catch 并记 failure（两个调用点都包在 try 里）。有通道，只是不在扫描窗口内
  const want = statSync(from).size
  const got = statSync(to).size
  if (got !== want) {
    // 用**固定码**而不是带字节数的原始消息：界面按完整码查文案表，带数字的串只能显示原文。
    // 具体字节数进日志（下面这行），报告里给用户看的是「复制不完整，请重导一次」这类可操作的话。
    console.error(`[import] 复制不完整 ${to}：${got}/${want} 字节`)
    rmSync(to, { force: true }) // 半截副本比没有更坏：留着它，下一轮会被当成「已有」
    throw new Error('copy-truncated')
  }
  refreshMtime(to)
}

/** 把 mtime 刷成现在；失败抛 `copied-but-mtime-unset`（内容已在盘上，但会被清扫按源年龄删掉）。 */
function refreshMtime(to: string): void {
  const now = new Date()
  try {
    utimesSync(to, now, now)
  } catch (e) {
    throw new Error(`copied-but-mtime-unset: ${(e as Error)?.message ?? String(e)}`)
  }
}

/**
 * 把 srcDir 的内容**合并**进 dstDir：不存在的目录建出来，缺失的文件复制过去，已存在的文件跳过（不重写）。
 *
 * 返回本次新建的**顶层条目**数（一个会话目录算 1），用于报告里的计数口径：
 * 目录本来就在、只是补进去几个文件时不再计 1（那是「补」不是「新增一类」），但补进去的文件本身不计数——
 * 与首轮「一个会话目录算 1」的口径保持一致，避免同一份数据在两次运行里被数成不同数量。
 */
function mergeDir(srcDir: string, dstDir: string, kind: string, failures: Failure[], depth = 0): number {
  /*
   * 源侧静默第 6 处，注释原文「// 源目录不存在」—— 同一个病灶：读不出来 ≠ 不存在。
   *
   * 这处比别处更需要小心，因为 `mergeDir` 是 checkpoints / subagents / tool-results 三条路径共用的，
   * 而且**递归**：内层目录读不出来时，那一整个会话的附件都不会被搬，而外层只看到 created=0。
   *
   * 为什么这里不改签名成三态：返回值 `created` 的语义是「本次新建的顶层条目数」，被三个调用方
   * 直接累加进报告计数；把它改成对象会让三处都要多一层解包，而失败通道本来就靠 `failures` 数组。
   * 所以**失败走 failures（已有通道），返回值语义不变**——unreadable 时记一条 failed 并返回 0。
   *
   * id 里的目录身份取相对 srcHome 的片段（`checkpoints/s-1`）：一眼能看出是哪个目录读不出来，
   * 而 reason 统一 `source-dir-unreadable`，界面只需一条文案。
   */
  const srcList = readSourceDir(srcDir)
  if (srcList.kind === 'unreadable') {
    /*
     * id 用目录身份：depth 0 是类别名（checkpoints / subagents / toolResults）；内层用末段目录名
     * （会话 id），用户能对上「哪个会话的附件没搬」。reason 统一 source-dir-unreadable，界面一条文案。
     */
    failures.push({ step: kind, id: depth === 0 ? `<${kind}>` : basename(srcDir), reason: SOURCE_DIR_UNREADABLE })
    return 0
  }
  if (srcList.kind === 'absent') return 0 // 真的没有这个目录：ENOENT
  const names = srcList.names
  let created = 0
  for (const name of names) {
    // 白名单名 + 空会话的 _misc 聚合目录（tool-results 会用它）。顶层与内层都套用，防路径穿越。
    if (!safeName(name) && name !== '_misc') continue
    if (isTempLeftover(name)) continue
    const from = join(srcDir, name)
    const to = join(dstDir, name)
    try {
      const st = lstatSync(from)
      if (st.isDirectory()) {
        // 目录分支要的是「能不能进去补缺」，与文件分支的判定不同（见 inspectDirTarget 的注释）。
        // 原来只判 `existsSync(to)` 假就 mkdir，于是**目标被同名文件占位**时 mkdirSync 抛错、掉进外层 catch，
        // 用户看到的是一条原始 ENOTDIR/EEXIST 消息而不是可解释的「位置被占」。
        const ds = inspectDirTarget(to)
        if (ds === 'blocked') {
          failures.push({ step: kind, id: name, reason: 'target-blocked' })
          continue
        }
        if (ds === 'unreadable') {
          failures.push({ step: kind, id: name, reason: 'target-unreadable' })
          continue
        }
        if (ds === 'absent') {
          mkdirSync(to, { recursive: true })
          if (depth === 0) created++
        }
        // 目录已存在也要进去补缺；内层新建不计顶层数
        mergeDir(from, to, kind, failures, depth + 1)
      } else if (st.isFile()) {
        const probe = inspectTarget(to)
        if (probe.kind === 'blocked') {
          // 同名目录占了文件的位置：写不进去，也不能算「跳过」（它压根不是这个文件）
          failures.push({ step: kind, id: name, reason: 'target-blocked' })
          continue
        }
        if (probe.kind === 'unreadable') {
          // 打不开 = 不知道里面是什么。不覆盖，如实上报（覆盖可能毁掉一份好文件）
          failures.push({ step: kind, id: name, reason: 'target-unreadable' })
          continue
        }
        if (probe.kind === 'usable' && probe.size === st.size) {
          // 已有且尺寸一致：当成搬好了，不重写内容（幂等的落点）。但若目标 mtime 已经老到会被清扫删掉，
          // 补刷一次——修「复制成功但 utimes 失败 → 永远修不回来」那条自锁，见 copyFileFresh 的注释。
          if (isStaleTarget(to)) refreshMtime(to)
          continue
        }
        if (probe.kind === 'usable') {
          // 尺寸不一致：上次 copyFileSync 写到一半留下的半截副本。**这就是本处最大的静默数据丢失**——
          // 以前裸 existsSync 会把它当成「已导入」永久跳过，而失败记录只在第一次出现过。
          // 内容已坏，先挪到旁边留档再重写（坏成什么样也可能有人想看）。
          const bak = backupBroken(to)
          console.warn(`[import] ${kind}/${name} 是半截副本（${probe.size}≠${st.size}），已备份为 ${bak} 并重新复制`)
        }
        // 到这里的两种情况都该真写：不存在，或已被挪走的半截副本
        mkdirSync(dstDir, { recursive: true })
        copyFileFresh(from, to)
        if (depth === 0) created++
      } else {
        /*
         * 既不是目录也不是普通文件（socket / FIFO / 设备节点…）。
         *
         * ⚠️ 以前没有这个 else：这类条目被**完全静默丢掉**——不进 created、不进 failures、也不进任何
         * skipped 桶，报告里连字数都看不见。这与「读不出当成没有」是同一个病（都属于 `isFile()` /
         * `isDirectory()` 两分支穷举时漏掉第三种形态），所以在这里如实上报而不是留个无声的洞。
         *
         * 记 failed 而不是 skipped：skipped 的含义是「目标已有 / 不该搬」，而这是源里有、我们搬不了。
         */
        failures.push({ step: kind, id: name, reason: 'source-not-a-file' })
      }
    } catch (e) {
      // 单条失败不影响其它，但必须上报：否则「导入完成」会盖住磁盘满/权限问题
      failures.push(fail(kind, name, (e as Error)?.message ?? String(e)))
    }
  }
  return created
}

/**
 * 复制四类附件。返回各层"顶级条目"的复制计数与失败清单。
 *
 * 返回 `{ assoc, failures }` 而不是把 failures 塞进 AssocReport：AssocReport 是纯计数（界面按它逐类显示数字），
 * 多一个数组字段会让「四类合计」之类的遍历口径变模糊，也会让调用方误以为那是第五类附件。
 *
 * 不做引用过滤：全量复制最简单也最安全（引用扫描是优化项）。
 */
export function copyAssoc(
  srcHome: string,
  onProgress?: (done: number, total: number) => void
): { assoc: AssocReport; failures: Failure[] } {
  const srcData = join(srcHome, 'data')
  const dstData = join(getDevaHome(), 'data')
  const assoc: AssocReport = { media: 0, checkpoints: 0, subagents: 0, toolResults: 0 }
  const failures: Failure[] = []

  // media：单个 blob 文件，量大（数百个），逐个报进度
  const srcMedia = join(srcData, 'media')
  /*
   * 源侧静默第 5 处。以前 `catch { mediaNames = [] }` —— `data/media` 被同名文件占住（ENOTDIR）、
   * ACL 改坏（EACCES）、杀毒锁住（EBUSY）都会落到这里，而源里有几百个 blob。当成空之后
   * 报告显示「媒体 0 个」，导入进来的会话里所有图片都是坏链接 —— 而 ok 仍是 true。
   */
  const mediaList = readSourceDir(srcMedia)
  if (mediaList.kind === 'unreadable') {
    failures.push({ step: 'assoc', id: '<data/media>', reason: SOURCE_DIR_UNREADABLE })
  }
  const mediaNames = mediaList.kind === 'ok' ? mediaList.names : []
  if (mediaNames.length) {
    const dstMedia = join(dstData, 'media')
    try {
      mkdirSync(dstMedia, { recursive: true })
    } catch (e) {
      // 目标目录都建不出来：后面每个文件都会失败，这里只记一条更清楚的原因
      failures.push(fail('media', '<dir>', (e as Error)?.message ?? String(e)))
    }
    let done = 0
    for (const name of mediaNames) {
      onProgress?.(done, mediaNames.length)
      done++
      if (isTempLeftover(name)) continue
      const to = join(dstMedia, name)
      try {
        const probe = inspectTarget(to)
        if (probe.kind === 'blocked') {
          failures.push({ step: 'assoc', id: `media:${name}`, reason: 'target-blocked' })
          continue
        }
        if (probe.kind === 'unreadable') {
          failures.push({ step: 'assoc', id: `media:${name}`, reason: 'target-unreadable' })
          continue
        }
        if (probe.kind === 'usable') {
          // media 是内容寻址的（文件名 = sha256），所以尺寸一致就是同一份内容，不必读出来比
          const srcSize = statSync(join(srcMedia, name)).size
          if (probe.size === srcSize) {
            // 已存在且完整：不重写内容，但过期就补刷 mtime（自锁修复，同 mergeDir）
            if (isStaleTarget(to)) refreshMtime(to)
            continue
          }
          // 尺寸不一致 = 上次写到一半的残骸（blob 名就是内容 hash，完整副本不可能尺寸不同）。
          // 挪开留档再重写：以前裸 existsSync 会把它永久当成「已有」，这个 blob 从此读出来是坏的。
          const bak = backupBroken(to)
          console.warn(`[import] media/${name} 是半截 blob（${probe.size}≠${srcSize}），已备份为 ${bak} 并重新复制`)
        }
        copyFileFresh(join(srcMedia, name), to)
        assoc.media++
      } catch (e) {
        // 单个 blob 失败：对应的图片就是缺失，但不该中断整轮；记下来让界面能显示
        failures.push(fail('media', name, (e as Error)?.message ?? String(e)))
      }
    }
    onProgress?.(mediaNames.length, mediaNames.length)
  }

  // checkpoints / subagents / tool-results：按会话目录合并（目录已存在时补缺，见 mergeDir 的说明）
  assoc.checkpoints = mergeDir(join(srcData, 'checkpoints'), join(dstData, 'checkpoints'), 'checkpoints', failures)
  assoc.subagents = mergeDir(join(srcData, 'subagents'), join(dstData, 'subagents'), 'subagents', failures)
  assoc.toolResults = mergeDir(join(srcData, 'tool-results'), join(dstData, 'tool-results'), 'toolResults', failures)
  return { assoc, failures }
}
