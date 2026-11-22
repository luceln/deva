import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { importSessions } from '../../apps/desktop/src/main/importer-sessions'
import { ensureSession, getSession, save, adoptSessionFile } from '../../apps/desktop/src/main/services/chat-store'
import { busySessions, compacting, rewinding } from '../../apps/desktop/src/main/services/chat-locks'
import { runImport } from '../../apps/desktop/src/main/importer'

type Eq = (name: string, actual: unknown, expected: unknown) => unknown
const home = () => process.env.DEVA_HOME!
const chats = (root: string) => path.join(root, 'data', 'chats')
const msg = (text: string) => ({ role: 'user' as const, content: text })
function fixture(id: string) {
  const src = path.join(home(), `source-${id}`)
  fs.mkdirSync(chats(src), { recursive: true })
  fs.mkdirSync(chats(home()), { recursive: true })
  return { src, from: path.join(chats(src), `${id}.json`), to: path.join(chats(home()), `${id}.json`) }
}
function write(file: string, value: unknown) { fs.writeFileSync(file, JSON.stringify(value)) }
const shell = (id: string, messages: unknown[]) => ({ id, title: id, createdAt: 1, updatedAt: 1, messages })

export async function importActive(eq: Eq): Promise<void> {
  const id = 'active-import', f = fixture(id)
  write(f.from, shell(id, [msg('question')]))
  importSessions(f.src)
  const session = ensureSession(id)
  const history = session.messages // chat-turns:476; provider continues to use this array after await
  let release!: () => void
  const waitingForModel = new Promise<void>((r) => { release = r })
  busySessions.set(id, 'turn-1')
  const reply = waitingForModel.then(() => { history.push({ role: 'assistant', content: 'late-reply' }); save(id) })
  try {
    write(f.from, shell(id, [msg('question'), msg('upstream-new')]))
    const before = fs.readFileSync(f.to, 'utf8')
    const result = importSessions(f.src)
    eq('active: import visibly deferred/failed', result.failed.some((x) => x.id === id), true)
    eq('active: disk not changed while model is waiting', fs.readFileSync(f.to, 'utf8'), before)
    eq('active: live history array not replaced', session.messages === history, true)
    eq('active: direct adopt also refuses', adoptSessionFile(id), false)
    release(); await reply
    const disk = JSON.parse(fs.readFileSync(f.to, 'utf8'))
    eq('active: reply after await persists', disk.messages.some((m: any) => m.content === 'late-reply'), true)
  } finally { release(); await reply; busySessions.delete(id) }
  for (const lock of [compacting, rewinding]) {
    lock.add(id)
    try { eq('history editing: import blocked', importSessions(f.src).failed.some((x) => x.id === id), true) }
    finally { lock.delete(id) }
  }
}

export async function importHistoryConflict(eq: Eq): Promise<void> {
  for (const sameSize of [false, true]) {
    const id = `history-${sameSize}`, f = fixture(id), file = `${id}.compacted-old.jsonl`
    const local = JSON.stringify(msg('LOCAL-old')) + '\n'
    const source = JSON.stringify(msg(sameSize ? 'OTHER-old' : 'different much longer upstream history')) + '\n'
    const compacted = { file, count: 1 }
    const target = { ...shell(id, [msg('tail')]), compacted }
    write(f.to, target)
    write(f.from, { ...target, messages: [msg('tail'), msg('upstream-new')] })
    fs.writeFileSync(path.join(chats(home()), file), local)
    fs.writeFileSync(path.join(chats(f.src), file), source)
    const before = fs.readFileSync(f.to, 'utf8')
    const r = importSessions(f.src)
    eq('history conflict: no appended update', r.updated.includes(id), false)
    eq('history conflict: main unchanged', fs.readFileSync(f.to, 'utf8'), before)
    eq('history conflict: local JSONL byte-identical', fs.readFileSync(path.join(chats(home()), file), 'utf8'), local)
  }
  // Same complete prefix but different compacted filenames/counts: preserve target boundary, append true tail only.
  const id = 'history-compatible', f = fixture(id), localFile = `${id}.compacted-local.jsonl`
  const srcFile = `${id}.compacted-source.jsonl`
  const early = msg('early'), summary = msg('⟦deva:compaction⟧ summary'), tail = msg('tail')
  write(f.to, { ...shell(id, [summary, tail]), compacted: { file: localFile, count: 1 } })
  fs.writeFileSync(path.join(chats(home()), localFile), JSON.stringify(early)+'\n')
  write(f.from, { ...shell(id, [tail, msg('new')]), compacted: { file: srcFile, count: 2 } })
  fs.writeFileSync(path.join(chats(f.src), srcFile), [early, summary].map((x) => JSON.stringify(x)).join('\n')+'\n')
  ensureSession(id)
  const r = importSessions(f.src), disk = JSON.parse(fs.readFileSync(f.to, 'utf8'))
  eq('complete prefix: append despite different boundaries', r.updated.includes(id), true)
  eq('complete prefix: preserve target pointer', disk.compacted, { file: localFile, count: 1 })
  eq('complete prefix: append exactly one live message', disk.messages, [summary, tail, msg('new')])
  eq('complete prefix: cache includes history and tail', getSession(id)!.messages.length, 4)
  eq('complete prefix: do not copy unreferenced source JSONL', fs.existsSync(path.join(chats(home()), srcFile)), false)
}

export async function importDependencyRetry(eq: Eq): Promise<void> {
  const freshId = 'new-compacted', fresh = fixture(freshId), freshFile = `${freshId}.compacted-old.jsonl`
  const freshBody = JSON.stringify(msg('fresh early'))+'\n'
  write(fresh.from, { ...shell(freshId, [msg('fresh tail')]), compacted: { file: freshFile, count: 1 } })
  fs.writeFileSync(path.join(chats(fresh.src), freshFile), freshBody)
  const freshResult = importSessions(fresh.src)
  eq('new compacted session: dependency and main both publish', freshResult.copied.includes(freshId), true)
  eq('new compacted session: dependency exact', fs.readFileSync(path.join(chats(home()), freshFile), 'utf8'), freshBody)
  eq('new compacted session: full history reloads', ensureSession(freshId).messages.length, 2)

  const orphanId = 'orphan-compacted', orphan = fixture(orphanId), orphanFile = `${orphanId}.compacted-old.jsonl`
  const orphanBody = JSON.stringify(msg('orphan early'))+'\n'
  write(orphan.from, { ...shell(orphanId, [msg('orphan tail')]), compacted: { file: orphanFile, count: 1 } })
  fs.writeFileSync(path.join(chats(orphan.src), orphanFile), orphanBody)
  fs.writeFileSync(path.join(chats(home()), orphanFile), orphanBody)
  eq('orphan compacted: matching dependency permits retry', importSessions(orphan.src).copied.includes(orphanId), true)
  const conflictId = 'orphan-conflict', conflict = fixture(conflictId), conflictFile = `${conflictId}.compacted-old.jsonl`
  write(conflict.from, { ...shell(conflictId, [msg('tail')]), compacted: { file: conflictFile, count: 1 } })
  fs.writeFileSync(path.join(chats(conflict.src), conflictFile), JSON.stringify(msg('source early'))+'\n')
  fs.writeFileSync(path.join(chats(home()), conflictFile), JSON.stringify(msg('local early'))+'\n')
  const conflictBytes = fs.readFileSync(path.join(chats(home()), conflictFile), 'utf8')
  eq('orphan compacted: conflicting bytes are not overwritten', importSessions(conflict.src).copied.includes(conflictId), false)
  eq('orphan compacted: local bytes survive', fs.readFileSync(path.join(chats(home()), conflictFile), 'utf8'), conflictBytes)

  const id = 'dependency-retry', f = fixture(id), file = `${id}.compacted-old.jsonl`
  const body = JSON.stringify(msg('early'))+'\n'
  const main = { ...shell(id, [msg('⟦deva:compaction⟧ summary'), msg('tail')]), compacted: { file, count: 1 } }
  write(f.from, main); fs.writeFileSync(path.join(chats(f.src), file), body)
  const targetDependency = path.join(chats(home()), file)
  fs.mkdirSync(targetDependency)
  const first = importSessions(f.src)
  eq('dependency failure: reported', first.failed.length > 0, true)
  eq('dependency failure: do not publish broken main', fs.existsSync(f.to), false)
  // Real persisted legacy partial import: main exists but referenced JSONL failed. Repeated retries must stay red.
  write(f.to, main)
  for (let i=0; i<2; i++) eq('legacy partial retry: failure remains visible', importSessions(f.src).failed.length > 0, true)
  fs.rmdirSync(targetDependency)
  const repaired = importSessions(f.src)
  eq('legacy partial retry: reference actually restored', fs.existsSync(targetDependency), true)
  eq('legacy partial retry: correct bytes', fs.existsSync(targetDependency) ? fs.readFileSync(targetDependency, 'utf8') : '', body)

  /*
   * 拆分历史读不出来（源侧 ENOENT / 被占用）必须阻断，不能当成「历史一致」放行。
   *
   * 这条守的是同一类缺陷的第 N 个复制品：`readImportHistory` / `prepareImportHistory` 里原先有一处
   * 裸 `readFileSync`，读失败时抛到 importSessions 的 catch，被记成 `target-write-failed`
   * （「写目标失败」）——方向反了。更坏的方向（有人为了「不再抛」加个 catch 就 return）会让
   * 一份读不出来的历史被当成「和本地一样」，主档照写。
   *
   * 隔离构造：源里指针指着 `dep-illegal.jsonl`，但那个文件不放（ENOENT）。目标侧该会话不存在，
   * 走的是「缺失依赖 → 校验归属 → 读源字节 → 写」这条路径。
   */
  const depId = 'dep-unreadable', depFx = fixture(depId), depFile = `${depId}.compacted-old.jsonl`
  write(depFx.from, { ...shell(depId, [msg('dep tail')]), compacted: { file: depFile, count: 1 } })
  const depResult = importSessions(depFx.src)
  eq('dependency unreadable: session reported as failed', depResult.failed.some((x) => x.id === depId), true)
  eq('dependency unreadable: main not published', fs.existsSync(depFx.to), false)
  eq('dependency unreadable: no compacted listed', depResult.compacted.includes(depFile), false)
  // 失败码方向必须是「源侧文件读不出」，不是「写目标失败」
  eq(
    'dependency unreadable: reason is source-file-unreadable',
    depResult.failed.find((x) => x.id === depId)?.reason,
    'source-file-unreadable'
  )
  // 补上依赖后可正常导入（证明阻断是暂时的，不是永久拉黑）
  fs.writeFileSync(path.join(chats(depFx.src), depFile), JSON.stringify(msg('dep early')) + '\n')
  const depRetry = importSessions(depFx.src)
  eq('dependency unreadable: retry after restore succeeds', depRetry.copied.includes(depId), true)
  eq('dependency unreadable: retry publishes main', fs.existsSync(depFx.to), true)
  eq('legacy partial retry: no failure after repair', repaired.failed, [])
  eq('legacy partial retry: complete history reloads', ensureSession(id).messages.length, 3)
  // Existing nonidentical bytes are not proven crash debris. Never overwrite them on a repeated import.
  fs.writeFileSync(targetDependency, JSON.stringify(msg('user-owned changed early'))+'\n')
  const retainedBytes = fs.readFileSync(targetDependency, 'utf8')
  importSessions(f.src)
  eq('retry: local JSONL conflict never overwritten', fs.readFileSync(targetDependency, 'utf8'), retainedBytes)
}

export async function importMedia(eq: Eq): Promise<void> {
  const id = 'media-import', src = path.join(process.env.TEST_HOME!, '.deva')
  const from = path.join(chats(src), `${id}.json`), to = path.join(chats(home()), `${id}.json`)
  fs.mkdirSync(chats(src), { recursive: true })
  fs.mkdirSync(chats(home()), { recursive: true })
  write(path.join(src, 'config.json'), { models: { providers: [] } })
  write(from, shell(id, [msg('prefix')]))
  const first = await runImport()
  eq('media: seed import completes through runImport', 'error' in first, false)
  const live = ensureSession(id)
  const data = Buffer.from('isolated-media').toString('base64')
  const hash = createHash('sha256').update(data).digest('hex')
  const image = { type: 'image', mediaType: 'image/png', blob: hash }
  const document = { type: 'document', mediaType: 'application/pdf', name: 'paper.pdf', blob: hash }
  const tool = { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok', images: [image] }
  write(from, shell(id, [msg('prefix'), { role: 'user', content: [image, document, tool] }]))
  const srcMedia = path.join(src, 'data', 'media'), dstMedia = path.join(home(), 'data', 'media')
  fs.mkdirSync(srcMedia, { recursive: true }); fs.writeFileSync(path.join(srcMedia, hash), Buffer.from(data, 'base64'))
  // Fault in copyAssoc: destination media path is a file, so dependencies cannot be prepared.
  fs.writeFileSync(dstMedia, 'blocked')
  const order: string[] = []
  const before = fs.readFileSync(to, 'utf8'), failed = await runImport((p) => {
    if (!order.includes(p.step)) order.push(p.step)
  })
  eq('media: copyAssoc precedes session publication', order.indexOf('assoc') < order.indexOf('sessions'), true)
  eq('media unavailable: dependency failure is visible', 'error' in failed ? true : failed.sessions.failed.some((x) => x.id === id), true)
  eq('media unavailable: no main publish', fs.readFileSync(to, 'utf8'), before)
  eq('media unavailable: cache not replaced/degraded', live.messages.length, 1)
  fs.unlinkSync(dstMedia)
  const retry = await runImport()
  eq('media retry: no error', 'error' in retry, false)
  if ('error' in retry) return
  eq('media retry: session updated', retry.sessions.updated.includes(id), true)
  const parts = getSession(id)!.messages[1]?.content as any
  eq('media retry: image hydrated before provider consumption', parts?.[0]?.data, data)
  eq('media retry: PDF hydrated', parts?.[1]?.data, data)
  eq('media retry: tool image hydrated', parts?.[2]?.images?.[0]?.data, data)
  eq('media retry: no unresolved blob in cache', JSON.stringify(parts).includes('"blob"'), false)
  // 源自己也没有这个 blob：不是依赖没准备好，正常降级为文字说明，不能把会话判成失败。
  const absentId = 'media-absent', absentFrom = path.join(chats(src), `${absentId}.json`)
  const absentHash = createHash('sha256').update('never-stored').digest('hex')
  write(absentFrom, shell(absentId, [{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', blob: absentHash }] }]))
  const absent = await runImport()
  eq('media absent in source: session still imports', 'error' in absent ? false : absent.sessions.copied.includes(absentId), true)
  const absentParts = getSession(absentId)!.messages[0]?.content as any
  eq('media absent in source: degrades to a loss notice, not a blob', absentParts?.[0]?.type, 'text')
  eq('media absent in source: notice says data lost', /数据已丢失/.test(absentParts?.[0]?.text ?? ''), true)
}
