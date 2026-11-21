import * as fs from 'fs'
import * as path from 'path'
import { createHash } from 'crypto'
import { importSessions } from '../../apps/desktop/src/main/importer-sessions'
import { ensureSession, getSession, save, adoptSessionFile } from '../../apps/desktop/src/main/services/chat-store'
import { busySessions, compacting, rewinding } from '../../apps/desktop/src/main/services/chat-state'

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
