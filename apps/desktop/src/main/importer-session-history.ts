import { readFileSync } from 'fs'
import { basename, dirname, join } from 'path'
import { decideExisting } from './importer-session-merge'
import { inspectTarget } from './importer-target'
import { SOURCE_FILE_UNREADABLE } from './importer-source-dir'
import { writeFileAtomic } from './services/atomic-write'
import type { Failure } from '../shared/import-protocol'

export interface ImportSession {
  id: string
  messages: unknown[]
  compacted?: { file: string; count: number }
  [key: string]: unknown
}

/** Read without chat-store: loading a broken dependency there may tidy away the pointer on disk. */
export function readImportSession(file: string): ImportSession {
  const doc = JSON.parse(readFileSync(file, 'utf8')) as ImportSession
  if (!doc || typeof doc.id !== 'string' || !Array.isArray(doc.messages)) throw new Error('Invalid session')
  if (doc.compacted) {
    const { file: name, count } = doc.compacted
    if (typeof name !== 'string' || !name || basename(name) !== name || /[\\/:]/.test(name) ||
        !Number.isSafeInteger(count) || count < 0) throw new Error('Invalid compacted pointer')
  }
  return doc
}

/**
 * 同一个解析，但**不抛**：`ok` 拿到会话对象，`corrupt` 表示源文件不是一份能用的会话。
 *
 * ## 为什么需要这个「不抛」的版本
 *
 * 源会话文件坏了（半截 JSON / `{ not json`）时，导入器原来的做法是**按文件名原样复制过去**——
 * 解析不了不等于这份数据该消失，用户可能在原版里还能看到它，也可能想自己去修。
 *
 * 但 `f787c72` 之后这里改成先 `readImportSession(from)` 解析再重写，于是坏源一抛就落进外层统一兜底，
 * 被记成 **`target-write-failed`（「写目标失败」）**，而且一个字节都没搬。两处都错：
 *  - 方向：坏的是**源**，用户拿着「写失败」去查磁盘权限，永远查不到；
 *  - 数据：原样复制过去本来能保住的东西，因为解析不了就没了。
 *
 * 所以解析与写入必须分开捕获：能解析 → 走正常的三态 / 合并流程；解析不了 → 由调用方原样复制并如实标注。
 */
export type SessionRead = { kind: 'ok'; session: ImportSession } | { kind: 'corrupt' }

export function tryReadImportSession(file: string): SessionRead {
  try {
    return { kind: 'ok', session: readImportSession(file) }
  } catch {
    return { kind: 'corrupt' }
  }
}

/**
 * 拆分历史（`compacted.file` 指向的 JSONL）的读取结果。**三态**，与 `readSourceDir` / `readMemoryFile`
 * 同一套语义：
 *  - `ok`      ：读到了；
 *  - `absent`  ：`ENOENT`——源指针指的拆分文件**不在了**（源侧数据不完整）；
 *  - `unreadable`：其余（`EACCES` / `EBUSY` / `EPERM` / `ELOOP`）——**不知道里面是什么**。
 *
 * 为什么必须分开：这份 JSONL 是 P1-2「完整历史比较」的输入。以前这里是裸 `readFileSync`，读不出来时
 * 抛到 `importSessions` 的 catch，被 `writeFailureReason` 记成 `target-write-failed`（「写目标失败」）——
 * 方向反了：用户拿着这个码去查磁盘写权限，而真相是**源侧**那份拆分历史打不开。
 *
 * 更要紧的是这条路上最容易走错的方向：把它当成「读不到 → 没有可比对内容 → 视为历史一致」放行，
 * 就等于把一份来路不明的历史悄悄写进目标（P1-2 整条判据都建立在「两份字节相等 / 不等」上）。
 * 所以 `absent` 与 `unreadable` **两条都不放行**，区别只在排查语义，不在放行与否。
 */
type HistoryBytes =
  | { kind: 'ok'; bytes: string }
  | { kind: 'absent' }
  | { kind: 'unreadable' }

function readHistoryBytes(sourceFile: string, fileName: string): HistoryBytes {
  try {
    return { kind: 'ok', bytes: readFileSync(join(dirname(sourceFile), fileName), 'utf8') }
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unreadable' }
  }
}

/**
 * 拆分历史读失败 → 失败记录。**调用点必须直接拿到这条记录并进 `failed`**：这个模块（P1-2 的依赖比较）
 * 是唯一能判断「两份历史是否一致」的地方，读不出来就没人能判断，绝不能返回「一致」。
 */
function historyFailure(sourceFile: string, fileName: string, got: HistoryBytes): Failure {
  const where = join(dirname(sourceFile), fileName)
  if (got.kind === 'unreadable') console.warn('[import] 拆分历史读不出来（被占用 / 无权限）：', where)
  else console.warn('[import] 拆分历史不在了（源侧数据不完整）：', where)
  return { step: 'sessions', id: basename(sourceFile).replace(/\.json$/, ''), reason: SOURCE_FILE_UNREADABLE }
}

/**
 * `prepareImportHistory` 的结果。
 *
 * 分成两支而不是只返回 `boolean`：`boolean` 的 `false` 只有一个含义（「没有需要补的」），
 * 而**依赖读不出来**必须阻断整条会话——把两者压进 `false`，调用方就会照常写主档，
 * 一份残缺历史就成了正式数据。所以阅读失败单独成支，由调用方直接进 `failed`。
 */
export type HistoryPrepare = { repaired: boolean } | { failed: Failure }

/**
 * No size-based inference: the complete, counted JSONL is the only valid comparison input.
 *
 * 依赖读不出来时**抛**，两条分支都不放行：`ENOENT`（源指针指的拆分文件不在了 → 源侧数据不完整）
 * 与其余（被占用 / 无权限 → 不知道内容是什么）。它的调用方（`importSessions` 各分支）都把这层
 * 异常转成 `failed`，所以这里不另造失败记录——但也绝不返回「空历史」：那会让上层把目标判成
 * 「源是它的超集」，一份来路不明的历史就被认领了。
 */
export function readImportHistory(file: string, doc: ImportSession): unknown[] {
  if (!doc.compacted) return doc.messages
  let raw: string
  try {
    raw = readFileSync(join(dirname(file), doc.compacted.file), 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`Compacted history missing: ${doc.compacted.file}`)
    throw new Error(`Compacted history unreadable: ${doc.compacted.file}`)
  }
  const older = raw.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as unknown)
  if (older.length !== doc.compacted.count || older.some((m) => !m || typeof m !== 'object'))
    throw new Error('Incomplete compacted history')
  return [...older, ...doc.messages]
}

/** Prepare only the referenced JSONL. Never replace existing bytes, even if their size differs. */
export function prepareImportHistory(sourceFile: string, targetFile: string,
  source: ImportSession, target: ImportSession): HistoryPrepare {
  if (!target.compacted) return { repaired: false }
  const dest = join(dirname(targetFile), target.compacted.file)
  const probe = inspectTarget(dest)
  if (probe.kind === 'usable') {
    if (inspectTarget(targetFile).kind === 'absent') {
      if (!source.compacted || source.compacted.file !== target.compacted.file ||
          source.compacted.count !== target.compacted.count)
        throw new Error('Cannot establish ownership of orphaned history')
      readImportHistory(sourceFile, source)
      /*
       * 两边字节都要真的读到，才谈得上「一致」。这条分支的作用是「目标已有一份无主 JSONL，
       * 源也指着同名同 count 的文件」——放行的前提**恰恰是两份内容相同**，所以任一侧读不出来
       * 都不能当成「一样」（那就等于凭读不到来认领一份来路不明的历史）。
       */
      const local = readHistoryBytes(targetFile, target.compacted.file)
      /*
       * 目标那份无主 JSONL 读不出来：**不要**猜它和源一致。这条分支的放行条件就是「两份字节相同」，
       * 读不到字节就没有放行依据，整条会话进 failed。
       */
      if (local.kind === 'unreadable') {
        return { failed: historyFailure(targetFile, target.compacted.file, local) }
      }
      if (local.kind === 'absent') {
        return { failed: historyFailure(targetFile, target.compacted.file, local) }
      }
      const src = readHistoryBytes(sourceFile, source.compacted.file)
      /* 源侧同理：读不出来就无从比较，坐着猜「大概一样」会把来路不明的历史认领进来。 */
      if (src.kind === 'unreadable') {
        return { failed: historyFailure(sourceFile, source.compacted.file, src) }
      }
      if (src.kind === 'absent') {
        return { failed: historyFailure(sourceFile, source.compacted.file, src) }
      }
      if (local.bytes !== src.bytes) throw new Error('Orphaned history conflicts with source')
      return { repaired: false }
    }
    readImportHistory(targetFile, target)
    return { repaired: false }
  }
  if (probe.kind !== 'absent') throw new Error('Target history blocked or unreadable')
  // Legacy partial import: source must name the exact dependency and contain the target live tail.
  if (!source.compacted || source.compacted.file !== target.compacted.file ||
      source.compacted.count !== target.compacted.count ||
      !['same', 'source-newer'].includes(decideExisting(target, source)))
    throw new Error('Cannot establish ownership of missing history')
  /* 补齐前必须先把源侧那份字节读到手：读不出来就不写，见 readHistoryBytes 的注释。 */
  const bytes = readHistoryBytes(sourceFile, source.compacted.file)
  if (bytes.kind === 'unreadable') {
    return { failed: historyFailure(sourceFile, source.compacted.file, bytes) }
  }
  if (bytes.kind === 'absent') {
    return { failed: historyFailure(sourceFile, source.compacted.file, bytes) }
  }
  /*
   * 字节到手后、落盘前，仍要按 count 校验这份 JSONL（`Incomplete compacted history`）。
   * 顺序：读 → 校验 → 写。校验没过就不写，否则目标里会留下一份自己都读不全的拆分历史。
   */
  const older = bytes.bytes.split(/\r?\n/).filter((line) => line.trim())
  if (older.length !== source.compacted.count)
    throw new Error('Incomplete compacted history')
  writeFileAtomic(dest, bytes.bytes)
  return { repaired: true }
}