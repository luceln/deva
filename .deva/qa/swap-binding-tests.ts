import * as fs from 'fs'
import * as path from 'path'

type Eq = (name: string, actual: unknown, expected: unknown) => unknown

/**
 * 绑定持久化失败仍计 changed（第三批·2，审查 P2-10）。
 *
 * `model-swap.ts` 在会话文件写成之后无条件 `changed.push()`，但两条关联写都没人看结果：
 *  - `chat-members.ts` 的 `markMemberSetting` 丢弃父会话 `saveProject` 的结果；
 *  - `tasks.ts` 的 `syncTaskModel` 捕获 `tasks.json` 落盘错误也不回传。
 *
 * 后果：主文件已经是新模型、界面报「已替换」，而绑定没存下去——重启后派任务按旧绑定把模型改回主对话的，
 * 用户看到「换成功了又变回去」。
 *
 * 每一步在独立子进程里跑（会话 / 任务缓存都是模块级）。
 */
export async function swapBinding(eq: Eq): Promise<void> {
  const step = process.env.SWAP_BIND_STEP ?? ''

  if (!step) {
    const { spawnSync } = await import('child_process')
    const run = (name: string): { code: number; out: string } => {
      const child = spawnSync(process.execPath, [path.join(__dirname, 'test.cjs'), 'swapbinding'], {
        env: { ...process.env, SWAP_BIND_STEP: name, DEVA_HOME: path.join(process.env.DEVA_HOME!, `sub-${name}`) },
        encoding: 'utf8'
      })
      return { code: child.status ?? -1, out: `${child.stdout ?? ''}${child.stderr ?? ''}` }
    }
    for (const name of ['member', 'task', 'rebind']) {
      const r = run(name)
      eq(`swapbinding/${name}: sub-process exit 0`, r.code, 0)
      if (r.out.includes('FAIL '))
        eq(`swapbinding/${name}: no failed assertion`, r.out.split('\n').filter((l) => l.startsWith('FAIL ')), [])
    }
    return
  }

  const cs = await import('../../apps/desktop/src/main/services/chat-store')
  const { applyModelSwap } = await import('../../apps/desktop/src/main/services/model-swap')
  const { setConfig } = await import('../../apps/desktop/src/main/services/config')
  const home = process.env.DEVA_HOME!
  const chats = path.join(home, 'data', 'chats')
  setConfig({
    models: {
      providers: [
        { id: 'p', name: 'P', apiHost: 'https://a.example/v1', enabled: true, models: [{ id: 'gone' }] },
        { id: 'q', name: 'Q', apiHost: 'http://localhost:11434/v1', enabled: true, models: [{ id: 'n' }] }
      ]
    }
  })

  if (step === 'member') {
    /*
     * 成员会话：主对话名单要记 modelSet。让父会话（主对话）的保存失败：
     * 把 `<main>.json.tmp` 建成目录，`writeFileAtomic` 的改名必失败。
     */
    const main = cs.ensureSession('Bmain', { model: 'q:n' })
    main.title = '绑定测试'
    const sub = cs.ensureSession('Bsub', { model: 'p:gone', focusRoot: null })
    sub.parentId = 'Bmain'
    main.members = [{ sessionId: 'Bsub', name: 'helper', root: null, duty: 'test', origin: 'created' } as never]
    eq('binding/member: 前置——主与成员落盘', cs.save('Bmain') && cs.save('Bsub'), true)

    fs.mkdirSync(path.join(chats, 'Bmain.json.tmp'), { recursive: true })
    const r = await applyModelSwap({ mainId: 'Bmain', fromRef: 'p:gone', toRef: 'q:n' })
    if ('error' in r) {
      eq('binding/member: 不该整批拒绝', 'no-error', 'error')
      return
    }
    eq('binding/member: 成员会话的主文件确实写成了新模型', cs.getSession('Bsub')?.model, 'q:n')
    eq('binding/member: 不计入 changed', r.changed.map((b) => b.sessionId).includes('Bsub'), false)
    eq('binding/member: 单列进 unbound', (r.unbound ?? []).map((b) => b.sessionId), ['Bsub'])
    eq('binding/member: 也不计入 failed（主文件没失败）', (r.failed ?? []).map((b) => b.sessionId).includes('Bsub'), false)
    // 父会话磁盘上仍是旧名单：这正是「绑定没落实」的证据
    fs.rmSync(path.join(chats, 'Bmain.json.tmp'), { recursive: true, force: true })
    const mainDisk = JSON.parse(fs.readFileSync(path.join(chats, 'Bmain.json'), 'utf8')) as {
      members?: Array<{ modelSet?: boolean }>
    }
    eq('binding/member: 父会话磁盘上没有 modelSet', mainDisk.members?.[0]?.modelSet, undefined)
  }

  if (step === 'rebind') {
    /*
     * 正向保证：绑定**存下去了**时，重启后派发不会把会话改回主模型。
     *
     * 派发路径（chat-turns.ts 的 runScheduledTurn）会用任务里记的模型 `ensureSession(sessionId, { model })`，
     * 所以「重启」等价于「丢掉内存、只按磁盘重建」——这里用磁盘上的 tasks.json 当作权威来模拟，
     * 不需要真的跑一次模型。
     */
    const { createTask, listTasks } = await import('../../apps/desktop/src/main/services/tasks')
    const created = createTask({
      title: '每日汇总',
      prompt: '总结一下',
      schedule: { kind: 'recurring', cron: '0 9 * * *', tz: 'UTC' },
      auth: { personaId: null, modelRef: 'p:gone' }
    })
    if (!created.ok) {
      eq('binding/rebind: 前置——任务创建成功', created.error, 'ok')
      return
    }
    const task = created.task
    const s = cs.ensureSession(task.sessionId, { model: 'p:gone' })
    s.title = '任务对话'
    eq('binding/rebind: 前置——会话落盘', cs.save(task.sessionId), true)
    const r = await applyModelSwap({ mainId: task.sessionId, fromRef: 'p:gone', toRef: 'q:n' })
    if ('error' in r) {
      eq('binding/rebind: 不该整批拒绝', 'no-error', 'error')
      return
    }
    eq('binding/rebind: 计入 changed', r.changed.map((b) => b.sessionId), [task.sessionId])
    eq('binding/rebind: 不在 unbound 里', r.unbound ?? [], [])
    const diskTasks = JSON.parse(fs.readFileSync(path.join(home, 'tasks.json'), 'utf8')) as {
      tasks?: Array<{ id: string; sessionId: string; auth?: { modelRef?: string | null }; title: string; prompt: string }>
    }
    const diskTask = diskTasks.tasks?.find((t) => t.id === task.id)
    eq('binding/rebind: 磁盘上的任务已是新模型', diskTask?.auth?.modelRef, 'q:n')
    // 模拟重启后的派发：只用磁盘上的任务 + 会话文件
    cs.invalidateIndex()
    const dispatched = cs.ensureSession(task.sessionId, { model: diskTask?.auth?.modelRef ?? '' })
    eq('binding/rebind: 派发后会话仍是新模型（没被改回主模型）', dispatched.model, 'q:n')
    const diskSession = JSON.parse(fs.readFileSync(path.join(chats, `${task.sessionId}.json`), 'utf8')) as {
      model?: string
    }
    eq('binding/rebind: 会话文件也是新模型', diskSession.model, 'q:n')
  }

  if (step === 'task') {
    /*
     * 任务对话：模型要同步进 `tasks.json`。会话 id 由 createTask 生成（`task-<uuid>`），
     * 所以先建任务、再按它的 sessionId 建会话、最后让 tasks.json 的写入失败（`tasks.json.tmp` 建成目录）。
     */
    const { createTask, listTasks } = await import('../../apps/desktop/src/main/services/tasks')
    const created = createTask({
      title: '每日汇总',
      prompt: '总结一下',
      schedule: { kind: 'recurring', cron: '0 9 * * *', tz: 'UTC' },
      auth: { personaId: null, modelRef: 'p:gone' }
    })
    if (!created.ok) {
      eq('binding/task: 前置——任务创建成功', created.error, 'ok')
      return
    }
    const task = created.task
    const s = cs.ensureSession(task.sessionId, { model: 'p:gone' })
    s.title = '任务对话'
    eq('binding/task: 前置——会话落盘', cs.save(task.sessionId), true)
    eq('binding/task: 任务模型初始为 p:gone', listTasks().find((t) => t.id === task.id)?.auth.modelRef, 'p:gone')

    fs.mkdirSync(path.join(home, 'tasks.json.tmp'), { recursive: true })
    const r = await applyModelSwap({ mainId: task.sessionId, fromRef: 'p:gone', toRef: 'q:n' })
    if ('error' in r) {
      eq('binding/task: 不该整批拒绝', 'no-error', 'error')
      return
    }
    eq('binding/task: 会话主文件确实写成新模型', cs.getSession(task.sessionId)?.model, 'q:n')
    eq('binding/task: 不计入 changed', r.changed.map((b) => b.sessionId).includes(task.sessionId), false)
    eq('binding/task: 单列进 unbound', (r.unbound ?? []).map((b) => b.sessionId), [task.sessionId])
    // 内存里的任务已被改成新值，但磁盘没写成——重启后会回到旧值，这正是要报出来的
    eq('binding/task: 内存里任务已是新模型', listTasks().find((t) => t.id === task.id)?.auth.modelRef, 'q:n')
    const diskTasks = fs.existsSync(path.join(home, 'tasks.json'))
      ? (JSON.parse(fs.readFileSync(path.join(home, 'tasks.json'), 'utf8')) as {
          tasks?: Array<{ id: string; auth?: { modelRef?: string | null } }>
        })
      : { tasks: [] as Array<{ id: string; auth?: { modelRef?: string | null } }> }
    eq(
      'binding/task: 磁盘上的任务仍是旧模型（绑定没落实的证据）',
      diskTasks.tasks?.find((t) => t.id === task.id)?.auth?.modelRef,
      'p:gone'
    )
    fs.rmSync(path.join(home, 'tasks.json.tmp'), { recursive: true, force: true })
  }
}
