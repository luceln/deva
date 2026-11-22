/**
 * store/chat 的桩：ModelSwapDialog 只读 brokenModels，只用 scanModelSwapState / applyModelSwap。
 *
 * 真实 ChatProvider 挂载会打一串 IPC，而这里要的是「apply 返回一份受控的 ModelSwapResult」，
 * 所以整模块替换，并暴露 window.__setChat / window.__setSwapResult 供用例控制。
 */
import { useEffect, useReducer } from 'react'

interface ChatState {
  brokenModels: Record<string, unknown[]>
}

const base: ChatState = { brokenModels: {} }
const state: ChatState = { ...base }
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

;(window as unknown as { __setChat: (patch: ChatState) => void }).__setChat = (patch) => {
  Object.assign(state, patch)
  emit()
}

export function useChatState(): ChatState {
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
  setSessionModel: (): void => undefined,
  setSessionEffort: (): void => undefined,
  scanModelSwapState: async (): Promise<unknown[]> => [],
  applyModelSwap: async (): Promise<unknown> =>
    (window as unknown as { __swapResult?: unknown }).__swapResult ?? { error: 'no result set' }
}

export function useChatActions(): typeof actions {
  return actions
}

export function useChatStream(): unknown {
  return {}
}

export function usePendingCards(): unknown {
  return {}
}