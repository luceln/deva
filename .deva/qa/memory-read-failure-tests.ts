import * as fs from 'fs'
import * as path from 'path'

type Eq = (name: string, actual: unknown, expected: unknown) => unknown

/**
 * 记忆读失败的错误分类（第三批·4，审查 P2-14）。
 *
 * 若干入口先用 `listMemories()`（读失败即折成空数组）再判「有没有条目」，于是**文件损坏**被报成
 * 「没有记忆」/「不存在这条」。用户看到「这里还没有记忆，不需要整理」，实际是他手改坏了 memory.json，
 * 排障方向完全被带偏。
 *
 * 判据：入口统一走三态 `readMemories`，`unreadable` 明确报读失败（`readFailed`）。
 *
 * 每步独立子进程（记忆路径与缓存都是模块级）。
 */
export async function memoryReadFailure(eq: Eq): Promise<void> {
  const step = process.env.MEM_READ_STEP ?? ''

  if (!step) {
    const { spawnSync } = await import('child_process')
    const run = (name: string): { code: number; out: string } => {
      const child = spawnSync(process.execPath, [path.join(__dirname, 'test.cjs'), 'memreadfail'], {
        env: { ...process.env, MEM_READ_STEP: name, DEVA_HOME: path.join(process.env.DEVA_HOME!, `sub-${name}`) },
        encoding: 'utf8'
      })
      return { code: child.status ?? -1, out: `${child.stdout ?? ''}${child.stderr ?? ''}` }
    }
    for (const name of ['condense', 'panel', 'deleteTool', 'consolidate', 'readTool']) {
      const r = run(name)
      eq(`memreadfail/${name}: sub-process exit 0`, r.code, 0)
      if (r.out.includes('FAIL '))
        eq(`memreadfail/${name}: no failed assertion`, r.out.split('\n').filter((l) => l.startsWith('FAIL ')), [])
    }
    return
  }

  const home = process.env.DEVA_HOME!
  fs.mkdirSync(home, { recursive: true })
  // 半截 JSON：能读到字节，解析不了 → readMemories 返回 unreadable
  fs.writeFileSync(path.join(home, 'memory.json'), '{"version":1,"entries":[{"id":"m_1","content":"x"')

  if (step === 'condense') {
    const { condenseMemories } = await import('../../apps/desktop/src/main/services/memory-consolidate')
    const { GLOBAL_SCOPE } = await import('../../apps/desktop/src/main/services/memory')
    const r = await condenseMemories(
      GLOBAL_SCOPE,
      { adapter: 'openai', providerId: 'x', baseURL: 'http://127.0.0.1:1/v1', model: 'm' } as never
    )
    if (r.ok) {
      eq('condense: 损坏时不该成功', 'ok', 'not-ok')
      return
    }
    eq('condense: 读失败单独成码（不是 empty）', r.code, 'readFailed')
    eq('condense: 原因说明是读不出来', /读不出/.test(r.reason), true)
  }

  if (step === 'panel') {
    const { registerMemoryIpc } = await import('../../apps/desktop/src/main/services/memory')
    const T = require('./stub-electron.cjs')
    registerMemoryIpc()
    const list = T.__test.ipcHandlers.get('memory:list') as (e: unknown, root?: string) => unknown
    // memory:list 现在直接抛/返回空快照都会误导；要求它明确表达读失败
    const r = (await Promise.resolve(list({}))) as { entries?: unknown[]; readError?: string }
    eq('panel: 带出读失败信息（界面据此区分「读不出」与「没有」）', typeof r.readError === 'string' && r.readError.length > 0, true)
    eq('panel: 读失败时条目为空但明确带 readError', r.entries?.length, 0)
    // 正常（无文件）时不得带 readError，否则界面会把「第一次用」显示成「文件坏了」
    fs.rmSync(path.join(home, 'memory.json'), { force: true })
    const ok = (await Promise.resolve(list({}))) as { readError?: string }
    eq('panel: 确实没有记忆时不带 readError', ok.readError, undefined)
  }

  if (step === 'deleteTool') {
    const { executeTool } = await import('../../apps/desktop/src/main/services/tools')
    const r = (await executeTool(
      'memory_delete',
      { id: 'm_1' },
      { memoryScopeRoot: undefined, workspaceRoot: home, globalMemoryReadonly: false } as never
    )) as { content: string; summary: string; isError?: boolean }
    eq('deleteTool: 明确是读失败而不是「不存在」', /读不出/.test(r.content), true)
    eq('deleteTool: 摘要标明失败', r.summary, '读取失败')
    eq('deleteTool: isError', r.isError, true)
    // 文件一个字节都不该动
    eq(
      'deleteTool: 文件保持原样',
      fs.readFileSync(path.join(home, 'memory.json'), 'utf8').startsWith('{"version":1,"entries":[{"id":"m_1"'),
      true
    )
  }

  if (step === 'readTool') {
    const { executeTool } = await import('../../apps/desktop/src/main/services/tools')
    const r = (await executeTool(
      'memory_read',
      {},
      { memoryScopeRoot: undefined, workspaceRoot: home } as never
    )) as { content: string; isError?: boolean }
    eq('readTool: 读失败要如实说，不能显示「尚无记忆」', /读不出/.test(r.content), true)
    eq('readTool: 不出现「当前尚无全局记忆」', r.content.includes('当前尚无全局记忆'), false)
  }

  if (step === 'consolidate') {
    /*
     * 撞上限自动归纳这条路：入口同样先 listMemories()。文件损坏时它会把「已满需要归纳」误判成
     * 「没有可归纳的条目」，于是写不进去的那条被报成普通失败，真正原因（文件坏了）看不到。
     */
    const { writeMemoryWithConsolidation } = await import('../../apps/desktop/src/main/services/memory-consolidate')
    const { GLOBAL_SCOPE } = await import('../../apps/desktop/src/main/services/memory')
    const w = await writeMemoryWithConsolidation(
      '一条新记忆',
      undefined,
      GLOBAL_SCOPE,
      { adapter: 'openai', providerId: 'x', baseURL: 'http://127.0.0.1:1/v1', model: 'm' } as never
    )
    eq('consolidate: 写不进去', w.result.ok, false)
    eq('consolidate: 失败原因指向读不出来', /读不出/.test(String(w.failure ?? w.result.ok ? '' : w.result.error)), true)
  }
}
