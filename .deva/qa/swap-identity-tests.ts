import * as fs from 'fs'
import * as path from 'path'

type Eq = (name: string, actual: unknown, expected: unknown) => unknown

/**
 * 模型替换的对象身份（第三批·1，审查 P2-9）。
 *
 * `model-swap.ts` 提交前只复核「sessionId 存在 + model 字符串相同」。若替换等待期间用户删掉**这个会话对象**
 * 但保留任务，随后任务以同一个 `task-<id>` 把会话重建出来（新对象、同样的 model 字符串），旧替换会
 * 恢复并作用到新会话上——用户看到的是「我删了它，可它带着新模型又回来了」。
 *
 * 判据必须是**对象身份**（同一个缓存对象 / 同一代），不能只比 id 与 model 值。
 *
 * 每一步在独立子进程里跑（会话缓存是模块级），由 `SWAP_ID_STEP` 分派。
 */
export async function swapIdentity(eq: Eq): Promise<void> {
  const step = process.env.SWAP_ID_STEP ?? ''

  if (!step) {
    const { spawnSync } = await import('child_process')
    const run = (name: string): { code: number; out: string } => {
      const child = spawnSync(process.execPath, [path.join(__dirname, 'test.cjs'), 'swapidentity'], {
        env: { ...process.env, SWAP_ID_STEP: name, DEVA_HOME: path.join(process.env.DEVA_HOME!, `sub-${name}`) },
        encoding: 'utf8'
      })
      return { code: child.status ?? -1, out: `${child.stdout ?? ''}${child.stderr ?? ''}` }
    }
    for (const name of ['recreated', 'normal']) {
      const r = run(name)
      eq(`swapidentity/${name}: sub-process exit 0`, r.code, 0)
      if (r.out.includes('FAIL '))
        eq(`swapidentity/${name}: no failed assertion`, r.out.split('\n').filter((l) => l.startsWith('FAIL ')), [])
    }
    return
  }

  const cs = await import('../../apps/desktop/src/main/services/chat-store')
  const { applyModelSwap, setModelSwapCommitHookForTest } = await import(
    '../../apps/desktop/src/main/services/model-swap'
  )
  const { setConfig } = await import('../../apps/desktop/src/main/services/config')
  setConfig({
    models: {
      providers: [
        { id: 'p', name: 'P', apiHost: 'https://a.example/v1', enabled: true, models: [{ id: 'gone' }] },
        { id: 'q', name: 'Q', apiHost: 'http://localhost:11434/v1', enabled: true, models: [{ id: 'n' }] }
      ]
    }
  })

  if (step === 'recreated') {
    /*
     * 任务对话被删掉又以同一个 id 重建（正是 `task-<id>` 的命名：id 由任务决定，重建后一模一样）。
     * 旧替换的快照 `c` 指向**删除前那个对象**；新会话是另一个对象，model 字符串却完全相同。
     */
    const first = cs.ensureSession('task-42', { model: 'p:gone' })
    first.title = '定时任务对话'
    eq('identity: 前置——旧会话落盘', cs.save('task-42'), true)
    const oldObject = cs.getSession('task-42')

    let fired = false
    setModelSwapCommitHookForTest(async () => {
      if (fired) return
      fired = true
      // 用户删掉这个对话（任务保留），随后任务触发，以同一 id 新建会话，模型引用仍是 p:gone
      cs.deleteSession('task-42')
      eq('identity: 删除后缓存里没有它', cs.getSession('task-42'), undefined)
      const rebuilt = cs.ensureSession('task-42', { model: 'p:gone' })
      rebuilt.title = '定时任务对话（新建）'
      cs.save('task-42')
      eq('identity: 重建的是另一个对象', cs.getSession('task-42') !== oldObject, true)
      setModelSwapCommitHookForTest(null)
    })
    const r = await applyModelSwap({ mainId: 'task-42', fromRef: 'p:gone', toRef: 'q:n' })
    setModelSwapCommitHookForTest(null)
    if ('error' in r) {
      eq('identity: 不该整批拒绝', 'no-error', 'error')
      return
    }
    eq('identity: 旧替换放弃提交（不进 changed）', r.changed.map((b) => b.sessionId), [])
    eq('identity: 新会话的模型没被旧替换改掉', cs.getSession('task-42')?.model, 'p:gone')
    const disk = JSON.parse(fs.readFileSync(path.join(process.env.DEVA_HOME!, 'data', 'chats', 'task-42.json'), 'utf8')) as {
      model?: string
    }
    eq('identity: 磁盘上也没被改', disk.model, 'p:gone')
  }

  if (step === 'normal') {
    // 正常链路（同一对象、同一代）必须照常替换。
    const s = cs.ensureSession('normal-1', { model: 'p:gone' })
    s.title = '正常'
    eq('normal: 前置落盘', cs.save('normal-1'), true)
    const r = await applyModelSwap({ mainId: 'normal-1', fromRef: 'p:gone', toRef: 'q:n' })
    if ('error' in r) {
      eq('normal: 不该整批拒绝', 'no-error', 'error')
      return
    }
    eq('normal: 照常替换', r.changed.map((b) => b.sessionId), ['normal-1'])
    eq('normal: 内存已换', cs.getSession('normal-1')?.model, 'q:n')
    const disk = JSON.parse(fs.readFileSync(path.join(process.env.DEVA_HOME!, 'data', 'chats', 'normal-1.json'), 'utf8')) as {
      model?: string
    }
    eq('normal: 磁盘已换', disk.model, 'q:n')
  }
}
