import * as fs from 'fs'
import * as path from 'path'

type Eq = (name: string, actual: unknown, expected: unknown) => unknown

/*
 * 标记的检查在本文件内实现，而不 import 被测模块：这样同一份用例也能跑在**修复前**的代码上，
 * 基线红的是行为（旧索引被照读、主数据先写），不是「新模块不存在」这种同义反复。
 */
function inspectDirty(dir: string): 'absent' | 'valid' | 'invalid' {
  const p = path.join(dir, '_index.dirty')
  let st
  try {
    st = fs.lstatSync(p)
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'absent' : 'invalid'
  }
  if (!st.isFile()) return 'invalid'
  try {
    return (JSON.parse(fs.readFileSync(p, 'utf8')) as { kind?: string })?.kind === 'chat-index-dirty' ? 'valid' : 'invalid'
  } catch {
    return 'invalid'
  }
}

const chats = () => path.join(process.env.DEVA_HOME!, 'data', 'chats')
const indexFile = () => path.join(chats(), '_index.json')
const dirtyFile = () => path.join(chats(), '_index.dirty')

/**
 * 索引恢复（第二批·三），write-ahead dirty。
 *
 * 实证：主 JSON 写成功后 `persistIndex` 失败，合法旧 `_index.json` 仍在。重启后 `listSessions` 读旧模型
 * （新主文件 + 旧列表），刷新也不修——因为索引文件一直「能读」。
 *
 * 契约顺序：主数据写入**之前**建 dirty → 主数据写成功 → 写索引 → 索引成功才清 dirty。
 * 读索引前先看 dirty：有效则跳过旧索引直接全量重建。
 *
 * 本段按步骤在**独立子进程**里跑（`IDX_STEP`），因为 `/data/chats`、索引与缓存都是模块级状态。
 */
export async function indexRecovery(eq: Eq): Promise<void> {
  const step = process.env.IDX_STEP ?? ''
  fs.mkdirSync(chats(), { recursive: true })

  if (!step) {
    const { spawnSync } = await import('child_process')
    const run = (name: string): { code: number; out: string } => {
      const child = spawnSync(process.execPath, [path.join(__dirname, 'test.cjs'), 'idxrecover'], {
        env: { ...process.env, IDX_STEP: name, DEVA_HOME: path.join(process.env.DEVA_HOME!, `sub-${name}`) },
        encoding: 'utf8'
      })
      return { code: child.status ?? -1, out: `${child.stdout ?? ''}${child.stderr ?? ''}` }
    }
    for (const name of ['writestale', 'markorder', 'invalidmark', 'rebuild', 'deletesession', 'invalidateonly']) {
      const r = run(name)
      eq(`idxrecover/${name}: sub-process exit 0`, r.code, 0)
      if (r.out.includes('FAIL '))
        eq(`idxrecover/${name}: no failed assertion`, r.out.split('\n').filter((l) => l.startsWith('FAIL ')), [])
    }
    return
  }

  const store = await import('../../apps/desktop/src/main/services/chat-store')

  if (step === 'writestale') {
    /*
     * 真实顺序故障：主文件写成功、索引写失败，磁盘上留着一份**合法但过时**的索引。
     *
     * 用「同名的 `_index.json.tmp` 是目录」阻断原子写，让 persistIndex 真的失败。
     */
    const s = store.ensureSession('stale-1')
    s.messages.push({ role: 'user', content: 'hello' })
    store.save('stale-1') // 先成功一次，建立一份合法索引
    fs.writeFileSync(indexFile(), JSON.stringify([{ id: 'old', title: 'OLD', createdAt: 1, updatedAt: 1 }]))
    fs.mkdirSync(`${indexFile()}.tmp`, { recursive: true })
    const wrote = store.saveOutcome('stale-1')
    eq('write stale: main saved but index stale', wrote, 'saved-index-stale')
    eq('write stale: dirty survives index failure', inspectDirty(chats()), 'valid')
    eq('write stale: main file written', fs.existsSync(path.join(chats(), 'stale-1.json')), true)
    eq('write stale: stale index still on disk', fs.readFileSync(indexFile(), 'utf8').includes('OLD'), true)
    fs.rmSync(`${indexFile()}.tmp`, { recursive: true, force: true })
    /*
     * 「重启」必须另起进程：同进程里 indexCache 还在（invalidateIndex 又会删掉那份陈旧索引，
     * 那样测到的只是「文件被删了当然重建」，与脏标记无关）。子进程只读，断言它读到的列表。
     */
    const { spawnSync } = await import('child_process')
    const child = spawnSync(process.execPath, [path.join(__dirname, 'test.cjs'), 'idxrecover'], {
      env: { ...process.env, IDX_STEP: 'stale-readonly' },
      encoding: 'utf8'
    })
    eq('write stale: restart exits 0', child.status ?? -1, 0)
    const out = `${child.stdout ?? ''}${child.stderr ?? ''}`
    eq('write stale: restart sees no stale entry', out.includes('PASS restart: stale index skipped'), true)
    eq('write stale: restart sees the real session', out.includes('PASS restart: real session listed'), true)
    eq('write stale: restart cleared the flag after rebuilding', out.includes('PASS restart: dirty cleared'), true)
  }

  if (step === 'stale-readonly') {
    // 新进程：只有磁盘。有效脏标记必须让它跳过旧索引直接重建。
    const listed = store.listSessions()
    eq('restart: stale index skipped', listed.some((m) => m.id === 'old'), false)
    eq('restart: real session listed', listed.some((m) => m.id === 'stale-1'), true)
    eq('restart: dirty cleared', fs.existsSync(dirtyFile()), false)
  }

  if (step === 'markorder') {
    // 主数据写入前就必须有标记：让主数据写入失败，标记仍在（表达索引可能没跟上）。
    store.ensureSession('order-1')
    fs.mkdirSync(path.join(chats(), 'order-1.json.tmp'), { recursive: true })
    const wrote = store.saveOutcome('order-1')
    eq('mark order: main write failed', wrote, 'not-saved')
    eq('mark order: dirty kept after failure', inspectDirty(chats()), 'valid')
  }

  if (step === 'invalidmark') {
    // 标记位置被目录占住：无效标记 → 不能假装「索引可信」，主数据不写。
    store.ensureSession('badmark-1')
    fs.mkdirSync(dirtyFile(), { recursive: true })
    const wrote = store.saveOutcome('badmark-1')
    eq('invalid mark: save refused', wrote, 'not-saved')
    eq('invalid mark: main file not written', fs.existsSync(path.join(chats(), 'badmark-1.json')), false)
    eq('invalid mark: placeholder untouched', fs.statSync(dirtyFile()).isDirectory(), true)
  }

  if (step === 'rebuild') {
    // 有效标记 + 合法旧索引：读时必须跳过旧索引直接重建，且重建成功后清标记。
    const s = store.ensureSession('rebuild-1')
    s.messages.push({ role: 'user', content: 'x' })
    store.save('rebuild-1')
    eq('rebuild: clean baseline has no dirty', fs.existsSync(dirtyFile()), false)
    fs.writeFileSync(indexFile(), JSON.stringify([{ id: 'ghost', title: 'GHOST', createdAt: 1, updatedAt: 1 }]))
    fs.writeFileSync(dirtyFile(), JSON.stringify({ v: 1, kind: 'chat-index-dirty' }))
    eq('rebuild: mark dirty', inspectDirty(chats()), 'valid')
    store.invalidateIndex()
    const listed = store.listSessions()
    eq('rebuild: stale index ignored', listed.some((m) => m.id === 'ghost'), false)
    eq('rebuild: real session present', listed.some((m) => m.id === 'rebuild-1'), true)
    eq('rebuild: dirty cleared after rebuild', fs.existsSync(dirtyFile()), false)
  }

  if (step === 'deletesession') {
    const s = store.ensureSession('del-1')
    s.messages.push({ role: 'user', content: 'x' })
    store.save('del-1')
    eq('delete: no dirty before delete', fs.existsSync(dirtyFile()), false)
    store.deleteSession('del-1')
    eq('delete: index no longer lists it', store.listSessions().some((m) => m.id === 'del-1'), false)
    eq('delete: no dangling dirty after a successful index write', fs.existsSync(dirtyFile()), false)
  }

  if (step === 'invalidateonly') {
    const s = store.ensureSession('inv-1')
    s.messages.push({ role: 'user', content: 'x' })
    store.save('inv-1')
    store.invalidateIndexOnly()
    eq('invalidateOnly: dirty set so the next read rebuilds', inspectDirty(chats()), 'valid')
    const listed = store.listSessions()
    eq('invalidateOnly: rebuild sees the session', listed.some((m) => m.id === 'inv-1'), true)
    eq('invalidateOnly: dirty cleared after rebuild', fs.existsSync(dirtyFile()), false)
  }
}
