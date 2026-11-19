/** store/extensions 桩：ImportPane 只在导入成功后调 refresh()，本用例不验扩展列表。 */
export function useExtensions() {
  return { skills: [], mcp: [], refresh: () => undefined }
}
