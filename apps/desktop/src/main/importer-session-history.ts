import { readFileSync } from 'fs'
import { basename, dirname, join } from 'path'

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

/** No size-based inference: the complete, counted JSONL is the only valid comparison input. */
export function readImportHistory(file: string, doc: ImportSession): unknown[] {
  if (!doc.compacted) return doc.messages
  const raw = readFileSync(join(dirname(file), doc.compacted.file), 'utf8')
  const older = raw.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line) as unknown)
  if (older.length !== doc.compacted.count || older.some((m) => !m || typeof m !== 'object'))
    throw new Error('Incomplete compacted history')
  return [...older, ...doc.messages]
}
