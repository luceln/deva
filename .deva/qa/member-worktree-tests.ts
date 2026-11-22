import * as fs from 'fs'
import * as path from 'path'
import { spawnSync } from 'child_process'
import { ensureSession, getSession, save, invalidateIndex } from '../../apps/desktop/src/main/services/chat-store'
import { setMemberFolder } from '../../apps/desktop/src/main/services/chat-members'
import { registerMemberWorktreeIpc } from '../../apps/desktop/src/main/services/member-worktree'
import { assertMemberExecution, assertMemberTerminalDirectory } from '../../apps/desktop/src/main/services/member-worktree-guard'
import { pendingMemberBindings } from '../../apps/desktop/src/main/services/member-binding-state'
import { setCreatePrecheckHookForTest } from '../../apps/desktop/src/main/services/worktree/create'
import { historyLocked, compacting } from '../../apps/desktop/src/main/services/chat-state'
import { executeTool } from '../../apps/desktop/src/main/services/tools'
import { listRecords } from '../../apps/desktop/src/main/services/worktree/store'
import type { MemberWorktreeBindReq } from '../../apps/desktop/src/shared/member-worktree-protocol'

type Harness = {
  dst: string
  makeRepo: (root: string, files?: Record<string, string>) => string
  eq: (name: string, actual: unknown, expected: unknown) => void
  check: (name: string, ok: boolean, detail: string) => void
}
export async function testMemberWorktree(h: Harness): Promise<void> {
  const { eq, check, dst, makeRepo } = h
  const T = require('./stub-electron.cjs')
  registerMemberWorktreeIpc()
  const invoke = (method: string, req: unknown): Promise<any> =>
    Promise.resolve(T.__test.ipcHandlers.get(`chat:member-worktree-${method}`)({}, req))
  const git = (cwd: string, ...args: string[]): string => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
    if (r.status !== 0) throw new Error(String(r.stderr))
    return r.stdout.trim()
  }
  const repo = makeRepo(path.join(dst, 'member-repo'), { 'pkg/a.txt': 'hello\n' })
  const main = ensureSession('member-main', { focusRoot: repo })
  const sub = ensureSession('member-child', { focusRoot: path.join(repo, 'pkg') })
  sub.parentId = main.id
  main.members = [{ sessionId: sub.id, name: 'm', root: sub.focusRoot, duty: 'test', origin: 'created' } as any]
  save(main.id); save(sub.id)
  const original = sub.focusRoot!
  let sequence = 0
  const request = (revision: number, sourceRoot = original): MemberWorktreeBindReq => {
    const n = ++sequence
    return { sessionId: sub.id, expectedRevision: revision, requestId: `req-${n}`, sourceRoot,
      create: { repoRoot: repo, branch: `wt/member-${n}`, path: path.join(dst, 'member-wts', `w${n}`) } }
  }
  const state = () => invoke('state', { sessionId: sub.id })
  const s0 = await state()
  eq('member 初始 revision=0', s0.state.revision, 0)
  eq('member 默认无 worktree 元数据', s0.state.identity, undefined)
  eq('member 默认无创建记录', listRecords().length, 0)
  const preReq = request(0)
  const pre = await invoke('precheck', preReq)
  eq('member 子目录预检成功', pre.ok, true)
  eq('member 相对子目录由后端推导', pre.relativePath, 'pkg')
  eq('member 预检不提前改 focusRoot', sub.focusRoot, original)
  eq('member 预检不建目录', fs.existsSync(preReq.create.path!), false)
  compacting.add(sub.id)
  eq('member 忙碌状态先拒绝', (await invoke('bind', request(0))).reason, 'busy')
  compacting.delete(sub.id)
  eq('member 忙碌已解除', historyLocked(sub.id), false)

  const bad = request(0)
  bad.create.repoRoot = path.join(dst, 'not-repo')
  eq('member 身份错误拒绝', (await invoke('bind', bad)).ok, false)
  eq('member 失败保留旧目录', sub.focusRoot, original)
  const r = await invoke('bind', preReq)
  eq('member 创建后绑定成功', r.status, 'bound')
  eq('member revision递增', r.revision, 1)
  eq('member 保留子目录执行根', path.resolve(r.focusRoot), path.resolve(preReq.create.path!, 'pkg'))
  eq('member 名单镜像一致', main.members![0].root, sub.focusRoot)
  eq('member 默认跳过安装', listRecords()[0].deps, 'skipped')
  await assertMemberExecution(sub.id, sub.focusRoot)
  eq('member 已绑定无 recovery', (await state()).state.recovery, undefined)
  eq('member 老 revision不能覆盖', (await invoke('bind', request(0))).reason, 'stale')

  // 改到另一分支使身份失效；工具不能成功读取，更不能重新创建被移走的 checkout。
  const checkout = r.checkoutRoot
  git(checkout, 'checkout', '-q', '-b', 'wrong-branch')
  let rejected = false
  try { await assertMemberExecution(sub.id, sub.focusRoot) } catch { rejected = true }
  eq('member 分支变化起轮守卫拒绝', rejected, true)
  git(checkout, 'checkout', '-q', preReq.create.branch!)
  fs.renameSync(checkout, `${checkout}-moved`)
  const result = await executeTool('write_file', { path: 'should-not-exist.txt', content: 'x' }, {
    sessionId: sub.id, workspaceRoot: sub.focusRoot, memoryScopeRoot: repo
  })
  eq('member 运行中目录消失工具报错', result.isError, true)
  eq('member 失效后不重建空checkout', fs.existsSync(checkout), false)
  rejected = false
  try { await assertMemberTerminalDirectory(sub.focusRoot!, sub.id) } catch { rejected = true }
  eq('member 终端缺失目录拒绝回落', rejected, true)
  fs.renameSync(`${checkout}-moved`, checkout)

  // 普通用户改绑递增revision，旧ctx不能继续工作。
  const oldExecution = sub.focusRoot
  eq('member 普通改绑落盘成功', setMemberFolder(sub, original), true)
  eq('member 普通改绑revision递增', sub.memberBindingRevision, 2)
  rejected = false
  try { await assertMemberExecution(sub.id, oldExecution) } catch { rejected = true }
  eq('member 旧轮次ctx不接受迟到改绑', rejected, true)

  // 可控屏障：create锁外预检后暂停，用户取消；完成创建后只留下恢复状态。
  let reached!: () => void
  let release!: () => void
  let atBarrier = new Promise<void>((r) => { reached = r })
  let barrier = new Promise<void>((r) => { release = r })
  setCreatePrecheckHookForTest(async () => { reached(); await barrier })
  const cancelled = request(2)
  let running = invoke('bind', cancelled)
  await atBarrier
  eq('member pending守卫存在', pendingMemberBindings.has(sub.id), true)
  rejected = false
  try { await assertMemberExecution(sub.id) } catch { rejected = true }
  eq('member pending期间起轮拒绝', rejected, true)
  eq('member 重复创建被拒', (await invoke('bind', request(2))).reason, 'pending')
  eq('member 用户取消被接受', (await invoke('cancel', cancelled)).cancelled, true)
  release()
  const cancelledResult = await running
  setCreatePrecheckHookForTest()
  eq('member 取消结果created-unbound', cancelledResult.status, 'created-unbound')
  eq('member 取消后保留旧绑定', sub.focusRoot, original)
  eq('member 取消不删除已创建目录', fs.existsSync(cancelled.create.path!), true)
  const recovery = (await state()).state.recovery
  check('member recovery有持久化operationId', !!recovery.operationId, JSON.stringify(recovery))
  invalidateIndex()
  eq('member 重载会话可恢复created-unbound', (await state()).state.recovery.operationId, recovery.operationId)
  const countBeforeRetry = listRecords().length
  const retry = await invoke('retry-bind', { sessionId: sub.id, expectedRevision: 2, operationId: recovery.operationId })
  eq('member 重试仅绑定成功', retry.status, 'bound')
  eq('member 重试没有再次创建', listRecords().length, countBeforeRetry)

  // 重新读取缓存对象：上面invalidateIndex模拟了重启。
  const child = getSession(sub.id)!
  eq('member 首次未挂载也能显式选择sourceRoot', setMemberFolder(child, null), true)
  const reqUnbound = request(child.memberBindingRevision!, path.join(repo, 'pkg'))
  eq('member 未挂载预检允许显式sourceRoot', (await invoke('precheck', reqUnbound)).ok, true)
  eq('member 未挂载预检不会提前挂载', child.focusRoot, null)

  // 创建期间改绑：迟到结果不能覆盖更高revision。
  atBarrier = new Promise<void>((r) => { reached = r })
  barrier = new Promise<void>((r) => { release = r })
  setCreatePrecheckHookForTest(async () => { reached(); await barrier })
  running = invoke('bind', reqUnbound)
  await atBarrier
  eq('member 创建中普通改绑成功', setMemberFolder(child, original), true)
  release()
  const late = await running
  setCreatePrecheckHookForTest()
  eq('member 迟到返回created-unbound', late.status, 'created-unbound')
  eq('member 迟到原因stale', late.reason, 'stale')
  eq('member 迟到不覆盖新目录', child.focusRoot, original)
  eq('member 过期recovery不允许重试覆盖', (await invoke('retry-bind', {
    sessionId: child.id, expectedRevision: child.memberBindingRevision, operationId: late.operationId
  })).reason, 'stale')
  const parent = getSession(main.id)!
  parent.members![0].removed = true
  save(parent.id)
  eq('member 移除后不能创建', (await invoke('bind', request(child.memberBindingRevision!))).reason, 'member-removed')
  eq('member 移除不删worktree', fs.existsSync(reqUnbound.create.path!), true)
}
