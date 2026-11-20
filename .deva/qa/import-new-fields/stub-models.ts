/**
 * store/models 的桩：给出固定的服务商与模型名，用来断言 superseded 行显示的是**人看得懂的模型名**。
 *
 * 真实 ModelsProvider 从配置读、挂载即打 IPC，无法在这里精确构造 → 整模块替换。
 */
import { useEffect, useReducer } from 'react'

const providers = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    accent: '#c96442',
    enabled: true,
    purpose: 'llm' as const,
    adapter: 'anthropic',
    apiHost: '',
    models: [
      { id: 'claude', name: 'Claude 4.5', enabled: true },
      { id: 'claude-lite', name: 'Claude Lite', enabled: true }
    ]
  },
  {
    id: 'openai',
    name: 'OpenAI',
    accent: '#10a37f',
    enabled: true,
    purpose: 'llm' as const,
    adapter: 'openai',
    apiHost: '',
    models: [{ id: 'gpt', name: 'GPT 5.1', enabled: true }]
  }
]

const state = { providers, activeModel: null, activeEffort: 'default' }
const listeners = new Set<() => void>()
const noop = (): void => undefined

export function useModels(): typeof state & { setActiveModel: typeof noop; setActiveEffort: typeof noop } {
  const [, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    listeners.add(force)
    return () => {
      listeners.delete(force)
    }
  }, [])
  return { ...state, setActiveModel: noop, setActiveEffort: noop }
}

export function findActive(): null {
  return null
}

export function hasKey(): boolean {
  return true
}