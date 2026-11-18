/**
 * store/models 的桩：GitWidget 只用 providers / activeModel / hasKey 来拼生成提交信息的模型。
 * 本用例只关心分支 pill，给「没有可用模型」即可（提交信息按钮走禁用态，不影响 pill）。
 */
export function useModels(): {
  activeModel: null
  providers: unknown[]
  hasKey: (id: string) => boolean
} {
  return { activeModel: null, providers: [], hasKey: () => false }
}

export function findActive(): null {
  return null
}
