/** store/models 桩：Conversation 只读 providers / ready，本用例不验模型。 */
export function useModels() {
  return { providers: [], ready: true, activeModel: null, activeEffort: 'default' }
}
export function hasUsableModel() {
  return true
}
export function findActive() {
  return null
}
