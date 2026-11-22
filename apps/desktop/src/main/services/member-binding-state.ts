import { getSession } from './chat-store'

/** 成员级绑定意图，不等价于 Git 路径锁；进程重启后 pending 消失，恢复事实留在会话里。 */
export const pendingMemberBindings = new Map<string, { requestId: string; cancelled: boolean }>()

export function invalidateMemberBindingRequest(sessionId: string): void {
  const pending = pendingMemberBindings.get(sessionId)
  if (pending) pending.cancelled = true
}

export function activeMember(sessionId: string) {
  const sub = getSession(sessionId)
  const main = sub?.parentId ? getSession(sub.parentId) : undefined
  const ref = main?.members?.find((m) => m.sessionId === sessionId)
  return sub && main && ref ? { sub, main, ref } : null
}
