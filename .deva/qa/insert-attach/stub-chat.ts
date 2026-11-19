/**
 * store/chat 的桩：只提供 Composer 及其胶囊用到的那几项。
 *
 * 真实 `ChatProvider` 挂载时会打一串 `chat.*` IPC，而且「回合进行中」的状态只能由真实回合驱动，
 * 无法从外部构造。本用例恰恰要把 `streaming: true` 下的附件入口验证清楚 → 整模块替换。
 *
 * 外部通过 `window.__setChat(patch)` 改状态；`window.__calls` 记录 `insert` 的实际入参，
 * 断言据此判断「附件真的随插话交出去了」——不是只看界面上有没有 chip。
 */
import { useEffect, useReducer } from 'react'

interface ChatState {
  pendingInserts: string[]
  memberProgress: unknown[]
  todos: { active: null }
  currentSessionId: string
  currentBinding: { focusRoot: string | null; model?: string; effort?: string }
  sessions: unknown[]
  brokenModels: Record<string, unknown[]>
  streaming: boolean
  messages: unknown[]
}

const base: ChatState = {
  pendingInserts: [],
  memberProgress: [],
  todos: { active: null },
  currentSessionId: 's1',
  // ModelPanel（Composer 里挂着）要读 currentBinding.model / currentSessionId / sessions / brokenModels
  currentBinding: { focusRoot: null },
  sessions: [],
  brokenModels: {},
  streaming: false,
  messages: []
}

const state: ChatState = { ...base }
const listeners = new Set<() => void>()

function set(patch: Partial<ChatState>): void {
  Object.assign(state, patch)
  for (const l of listeners) l()
}

/** `insert` / `send` / `withdrawInserts` 的实际入参记录。 */
const calls: { insert: unknown[]; send: unknown[]; withdraw: number } = {
  insert: [],
  send: [],
  withdraw: 0
}

/** 测试可改的返回值：真实 `insert` / `send` 返回 `Promise<boolean>`，不是 `{ok}` 对象——桩必须照抄。 */
const reply = { insert: true, send: true, withdraw: { text: '', attachments: [] as string[] } }

const w = window as unknown as Record<string, unknown>
w.__setChat = set
w.__resetChat = () => {
  Object.assign(state, base)
  calls.insert = []
  calls.send = []
  calls.withdraw = 0
  reply.insert = true
  reply.send = true
  reply.withdraw = { text: '', attachments: [] }
  for (const l of listeners) l()
}
w.__calls = calls
w.__reply = reply

export function useChatState(): ChatState {
  const [, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    listeners.add(force)
    return () => {
      listeners.delete(force)
    }
  }, [force])
  return state
}

export function useChatStream(): { messages: unknown[] } {
  return { messages: state.messages }
}

export function useChatActions(): Record<string, (...args: unknown[]) => unknown> {
  return {
    insert: (text: unknown, attachments: unknown) => {
      calls.insert.push({ text, attachments })
      return Promise.resolve(reply.insert)
    },
    send: (text: unknown, attachments: unknown) => {
      calls.send.push({ text, attachments })
      return Promise.resolve(reply.send)
    },
    withdrawInserts: () => {
      calls.withdraw++
      return Promise.resolve(reply.withdraw)
    },
    cancelTodoList: () => undefined,
    stopSubagent: () => undefined
  }
}

/** Composer 只用到 DraftPreview 相关的草稿通知；桩保持空实现。 */
export function useDraftPreview(): string | null {
  return null
}
