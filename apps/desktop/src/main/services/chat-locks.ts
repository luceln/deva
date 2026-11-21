/**
 * 会话历史的改写锁：回合进行中 / 手动压缩中 / 回滚撤销中。
 *
 * 单独成模块只为不引依赖：`chat-store` 要在载入、接管磁盘内容时判断「这份历史此刻能不能动」，
 * 而 `chat-state` 本身依赖 `chat-store`（读会话、发事件），两边直接互引会成环。
 * 这里只有三个集合与一个判定，谁都能安全引用。
 */

/**
 * 正在跑回合的会话 → 其 turnId（主轮与定时任务都登记）。activeTurns 按 turnId 做键、查不到会话，
 * 回滚 / 撤销 / blob GC 据此判断「会话忙」而拒绝执行，免得与进行中的回合互相改写；
 * 渲染层打开会话时也据此接上进行中的回合（chat:attach-session）。
 */
export const busySessions = new Map<string, string>()

/** 正在手动压缩（/compact）的会话：期间不为后台任务通知起轮，免得与压缩同时改写 messages。 */
export const compacting = new Set<string>()

/** 正在执行回滚 / 撤销的会话：防同一会话的两次回滚交错，期间也不起轮。 */
export const rewinding = new Set<string>()

/**
 * 会话的历史正被改写：回合进行中、手动压缩中、回滚 / 撤销中。三者互斥，删轮也须等它们结束——
 * 回合一直往起轮时拿到的那个 messages 数组里追加，删轮 / 回滚会把 s.messages 换成新数组，交错的话
 * 落盘的是新数组，这一轮的输出就丢了。渲染层发起前也会检查，但挡不住主进程自己起的轮（定时任务、
 * 手机端消息、后台子智能体结束后的唤醒、成员交差），故以主进程这里为准。
 */
export function historyLocked(sessionId: string): boolean {
  return busySessions.has(sessionId) || compacting.has(sessionId) || rewinding.has(sessionId)
}
