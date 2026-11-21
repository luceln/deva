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
  eq('legacy partial retry: no failure after repair', repaired.failed, [])
  eq('legacy partial retry: complete history reloads', ensureSession(id).messages.length, 3)
  // Existing nonidentical bytes are not proven crash debris. Never overwrite them on a repeated import.
  fs.writeFileSync(targetDependency, JSON.stringify(msg('user-owned changed early'))+'\n')
  const retainedBytes = fs.readFileSync(targetDependency, 'utf8')
  importSessions(f.src)
  eq('retry: local JSONL conflict never overwritten', fs.readFileSync(targetDependency, 'utf8'), retainedBytes)
}
