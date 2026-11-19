/**
 * store/models 的桩：Composer 依赖链里（经 ModelSetupCard / TaskPickers 等）会调到 `useModels`。
 * 本用例验的是附件，给空服务商表即可——界面会显示「接入模型」引导卡，不影响输入框与附件条。
 */
export function useModels(): {
  providers: unknown[]
  activeModel: null
  activeEffort: string
  setSessionModel: () => void
  setSessionEffort: () => void
} {
  return {
    providers: [],
    activeModel: null,
    activeEffort: 'default',
    setSessionModel: () => undefined,
    setSessionEffort: () => undefined
  }
}

export function findActive(): null {
  return null
}

export function hasUsableModel(): boolean {
  return false
}