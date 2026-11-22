import { closeSync, lstatSync, openSync, readFileSync, rmSync, writeSync } from 'fs'
import { join } from 'path'

/**
 * 会话索引的 write-ahead dirty 标记。
 *
 * ## 为什么需要它
 *
 * 主对话文件是真源，`_index.json` 只是派生数据（列表 O(1) 读取）。旧实现里「主文件写成功、索引写失败」
 * 只降级成一个返回值，磁盘上却留着一份**合法的旧索引**：下次启动 `ensureIndex()` 兴高采烈地读它，
 * 列表里就是旧模型（实测：新主文件 + 旧列表），刷新也不修——因为索引文件一直「能读」。
 *
 * 修法是在主数据写入**之前**先立一个标记：索引此刻不可信。读到标记就跳过旧索引、直接全量重建。
 * 标记只在「写出了一份完整索引」之后才清，因此不会出现「索引写成功就清标记、但之前缺的条目还在缺」。
 *
 * ## 顺序（严格）
 *
 *  1. 建 dirty（`flag:'wx'` 排他创建）。**建不起来 → 主数据不写**（返回 not-saved）；
 *  2. 主数据写成功；
 *  3. 写索引；成功 → 清 dirty；失败 → **保留** dirty；
 *  4. 清 dirty 失败无害（下次自然重建），仍可算 saved。
 *
 * ## 合法性判定
 *
 * 「文件存在」不等于「标记有效」：目录、符号链接、内容是垃圾的占位都**不算**有效标记——那种情况下我们
 * 既不能信任标记、也不能信任索引，按「无法建立 dirty」处理（主数据不写）。
 * 也不能用 mtime 判新旧：同粒度时间戳与「拷贝保留 mtime」都会误判，mtime 只进日志。
 *
 * ## 单写者边界
 *
 * `requestSingleInstanceLock` 锁的是 userData；dev 构建与安装版是两把不同的锁。**两个实例共指同一个
 * `DEVA_HOME` 不在本机制的保证范围内**——那种情况下两边会各自建自己的标记、各自写索引，最后一次写赢。
 * 本模块只保证「单写者进程重启后能发现索引陈旧并重建」，不承诺断电自愈（项目全程没有 fsync）。
 */

/** 文件名刻意不以 `.json` 结尾：`data/chats` 的扫描重建会把 `.json` 当会话文件读。 */
const DIRTY_FILE = '_index.dirty'
/** 标记内容。要能解析，但不需要承载信息——它的存在本身就是全部语义。 */
const DIRTY_BODY = JSON.stringify({ v: 1, kind: 'chat-index-dirty' })

export type DirtyState = 'absent' | 'valid' | 'invalid'

function dirtyPath(chatsDir: string): string {
  return join(chatsDir, DIRTY_FILE)
}

/**
 * 检查标记是否**有效**：在同一目录内、是普通文件（非目录 / 非符号链接）、内容可解析。
 *
 * 目录与符号链接都不算有效：符号链接可以指向别处（甚至指向索引自己），目录则会让「清标记」变成删目录。
 */
export function inspectDirty(chatsDir: string): DirtyState {
  const p = dirtyPath(chatsDir)
  let st
  try {
    st = lstatSync(p)
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return 'absent'
    return 'invalid'
  }
  if (!st.isFile()) return 'invalid'
  try {
    const body = JSON.parse(readFileSync(p, 'utf8')) as { kind?: unknown }
    return body?.kind === 'chat-index-dirty' ? 'valid' : 'invalid'
  } catch {
    return 'invalid'
  }
}

/**
 * 建立标记（write-ahead）。返回 false 表示**无法保证**「索引随后会被正确更新」，调用方须放弃写主数据。
 *
 * 已存在且有效的标记直接复用（不重复创建、不改内容）：它表达的是「索引尚未可信」，重复建立没有增量语义，
 * 而在 `wx` 下重复创建只会 EEXIST。
 */
export function markDirty(chatsDir: string): boolean {
  const state = inspectDirty(chatsDir)
  if (state === 'valid') return true
  if (state === 'invalid') {
    // 占位是目录 / 符号链接 / 垃圾内容：既不能信它，也不能就地覆盖（可能是用户的东西）。按失败处理。
    console.warn('[chat-store] 索引脏标记位置被占用且无效，本次不写主数据：', dirtyPath(chatsDir))
    return false
  }
  try {
    const fd = openSync(dirtyPath(chatsDir), 'wx')
    try {
      writeSync(fd, DIRTY_BODY)
    } finally {
      closeSync(fd)
    }
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === 'EEXIST') return inspectDirty(chatsDir) === 'valid'
    console.warn('[chat-store] 建立索引脏标记失败，本次不写主数据：', (e as Error)?.message ?? e)
    return false
  }
}

/**
 * 清除标记。返回 false 只用于日志：清不掉说明下次启动会多重建一次索引，数据没丢。
 *
 * 只在「索引已完整写出」之后调用——见模块注释的顺序第 3 步。
 */
export function clearDirty(chatsDir: string): boolean {
  try {
    rmSync(dirtyPath(chatsDir), { force: true })
    return true
  } catch (e) {
    console.warn('[chat-store] 清除索引脏标记失败（下次启动会重建一次，无数据影响）：', (e as Error)?.message ?? e)
    return false
  }
}

/** 索引是否可信：只有「没有有效标记」时才可信。 */
export function indexTrusted(chatsDir: string): boolean {
  return inspectDirty(chatsDir) !== 'valid'
}

/** 供其它模块拼路径用（如需要把标记位置写进日志）。 */
export function dirtyFilePath(chatsDir: string): string {
  return dirtyPath(chatsDir)
}
