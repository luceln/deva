/**
 * store/chat 的桩：ModelPanel 只用 currentBinding / currentSessionId / sessions / brokenModels，
 * useChatActions 只用 setSessionModel / setSessionEffort / scanModelSwapState / applyModelSwap。
 *
 * 真实 ChatProvider 挂载时会打一串 chat.* IPC，且无法从外部改 brokenModels / sessions，
 * 而本用例恰恰要把「四种失效 kind」「成员会话归属」逐一构造出来 → 整模块替换。
 *
 * 外部通过 window.__setChat(patch) 改状态并触发重渲染（不走 React 内部 state，桩保持极简）。
 */
import { useEffect, useReducer } from 'react'

export interface ChatPatch {
  currentBinding?: { personaId?: string; focusRoot: string | null; model?: string; effort?: string }
  currentSessionId?: string
  sessions?: unknown[]
  brokenModels?: Record<string, unknown[]>
}

const base = {
  currentBinding: { focusRoot: null as string | null, model: 'p1:m1' },
  currentSessionId: 's1',
  sessions: [] as unknown[],
  brokenModels: {} as Record<string, unknown[]>
}

const state = { ...base }
const listeners = new Set<() => void>()

function set(patch: ChatPatch): void {
  Object.assign(state, patch)
  for (const l of listeners) l()
}

;(window as unknown as { __setChat: typeof set; __resetChat: () => void }).__setChat = set
;(window as unknown as { __resetChat: () => void }).__resetChat = () => {
  Object.assign(state, base)
  for (const l of listeners) l()
}

export function useChatState(): typeof state {
  const [, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    listeners.add(force)
    return () => {
      listeners.delete(force)
    }
  }, [])
  return state
}

const actions = {
  setSessionModel: (ref: string): void => {
    ;(window as unknown as { __picked: string[] }).__picked.push(`model:${ref}`)
  },
  setSessionEffort: (lv: string): void => {
    ;(window as unknown as { __picked: string[] }).__picked.push(`effort:${lv}`)
  },
  scanModelSwapState: async (): Promise<unknown[]> => [],
  applyModelSwap: async (): Promise<{ error: string }> => ({ error: 'stub' })
}

export function useChatActions(): typeof actions {
  return actions
}

export function useChatStream(): unknown {
  return {}
}

// ModelSwapDialog 也会从这里取，只要不崩即可。
export function usePendingCards(): unknown {
  return {}
}
