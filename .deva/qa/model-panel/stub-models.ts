/**
 * store/models 的桩：提供可控的 providers / activeModel / activeEffort。
 *
 * 真实 ModelsProvider 从 mock/models 起种子、还会读配置，无法从外部精确构造「缺密钥服务商」
 * 「不支持的思考等级」这些边界。本用例要的就是这些边界，故整模块替换，并暴露 window.__setModels。
 */
import { useEffect, useReducer } from 'react'

export interface ModelDefLite {
  id: string
  name: string
  enabled: boolean
  contextWindow?: number
  maxOutput?: number
}

export interface ProviderLite {
  id: string
  name: string
  accent: string
  enabled: boolean
  purpose?: 'llm' | 'decision'
  adapter: string
  apiHost: string
  models: ModelDefLite[]
}

const base: {
  providers: ProviderLite[]
  activeModel: { provider: ProviderLite; model: ModelDefLite } | null
  activeEffort: string
} = {
  providers: [],
  activeModel: null,
  activeEffort: 'default'
}

const state = { ...base }
const listeners = new Set<() => void>()

function set(patch: Partial<typeof base>): void {
  Object.assign(state, patch)
  for (const l of listeners) l()
}

;(window as unknown as { __setModels: typeof set; __resetModels: () => void }).__setModels = set
;(window as unknown as { __resetModels: () => void }).__resetModels = () => {
  Object.assign(state, base)
  for (const l of listeners) l()
}

/** 与真实 store 的 findActive 同规则：按首个冒号切分（模型 id 可带冒号）。 */
export function findActive(providers: ProviderLite[], activeId: string | null) {
  if (!activeId) return null
  const idx = activeId.indexOf(':')
  if (idx <= 0) return null
  const pid = activeId.slice(0, idx)
  const mid = activeId.slice(idx + 1)
  const provider = providers.find((p) => p.id === pid)
  const model = provider?.models.find((m) => m.id === mid)
  return provider && model ? { provider, model } : null
}

const noop = (): void => undefined

export function useModels(): typeof state & {
  setActiveModel: typeof noop
  setActiveEffort: typeof noop
} {
  const [, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    listeners.add(force)
    return () => {
      listeners.delete(force)
    }
  }, [])
  return { ...state, setActiveModel: noop, setActiveEffort: noop }
}

/** ModelSwapDialog 也用它判断服务商是否可用。 */
export function hasKey(): boolean {
  return true
}
